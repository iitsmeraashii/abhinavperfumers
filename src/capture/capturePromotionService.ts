// Promotion Service — single canonical execution path for lead promotion.
//
// Design:
//   - One function: executePromotion. Called by online flow and offline queue replay.
//   - Idempotent: checks capture_sessions.promoted_lead_id before inserting.
//   - Self-contained: handles lead_entries insert, capture_sessions update,
//     and completed_leads IndexedDB update in one atomic sequence.
//   - Never throws — returns { leadId, error, alreadyPromoted }.

import { supabase } from '../supabaseClient';
import { getAuthIdentity } from './captureAuth';
import { deriveState } from './deriveState';
import { resolveLeadCountry } from './resolveLeadCountry';
import { saveCompletedLead, buildCompletedLead } from './completedLeadsStorage';
import { phoneDedupKey, phoneForStorage } from './normalizePhone';
import { resolvePhoneCountry } from './phoneCountryResolver';
import type { CaptureMethod, DraftData } from './types';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PromoteSessionOptions {
  backendSessionId: string;
  draftData:        DraftData;
  eventCode:        string | null;
  completedLeadId:  string;          // IndexedDB key for completed_leads upsert
  captureMethod:    CaptureMethod | null;
  eventId:          string | null;
  eventName:        string | null;
  /** When true, the lead is inserted with status REQUIRES_REVIEW instead of NEW. */
  requiresReview?:  boolean;
}

export interface PromoteSessionResult {
  leadId:          string | null;
  error:           string | null;
  alreadyPromoted: boolean;
}

// ─── Core execution ───────────────────────────────────────────────────────────

export async function executePromotion(
  options: PromoteSessionOptions,
): Promise<PromoteSessionResult> {
  const {
    backendSessionId, draftData, eventCode,
    completedLeadId, captureMethod, eventId, eventName,
    requiresReview,
  } = options;

  try {
    const identity = await getAuthIdentity();
    if (!identity?.repCode) {
      return { leadId: null, error: 'Not authenticated or rep profile unavailable', alreadyPromoted: false };
    }
    const { userId, repCode } = identity;

    // ── Idempotency check ──────────────────────────────────────────────────
    const { data: session } = await supabase
      .from('capture_sessions')
      .select('promoted_lead_id')
      .eq('id', backendSessionId)
      .eq('user_id', userId)
      .maybeSingle();

    if (session?.promoted_lead_id) {
      // Already promoted — ensure local record reflects this
      await _updateCompletedLead(
        completedLeadId, captureMethod, draftData, backendSessionId,
        eventId, eventName, session.promoted_lead_id, identity.userId,
      );
      return { leadId: session.promoted_lead_id, error: null, alreadyPromoted: true };
    }

    // ── Build phones / emails ──────────────────────────────────────────────
    // 1. Gather raw phones in established order (draftData.phone first, then phoneNumbers[])
    const rawPhones: string[] = [];
    if (draftData.phone?.trim()) rawPhones.push(draftData.phone.trim());
    if (Array.isArray(draftData.phoneNumbers)) {
      for (const p of draftData.phoneNumbers as string[]) {
        const t = String(p ?? '').trim();
        if (t && !rawPhones.includes(t)) rawPhones.push(t);
      }
    }

    // 2. Resolve phone-country context for normalization
    const resolvedDialCode = resolvePhoneCountry({
      phone:           rawPhones[0] ?? null,
      selectedDialCode: draftData.phoneCountryCode ?? null,
      isManualCapture: captureMethod === 'MANUAL',
      address:         draftData.address ?? null,
    });

    // 3. Persist the primary with its country context, using Lead Detail's format.
    // Preserve existing secondary values, ordering and deduplication.
    const phones: string[] = [];
    const seenDedupKeys = new Set<string>();
    for (const raw of rawPhones) {
      const dedup = phoneDedupKey(raw, { dialCode: resolvedDialCode ?? undefined });
      if (dedup && seenDedupKeys.has(dedup)) continue;
      if (dedup) seenDedupKeys.add(dedup);
      phones.push(phones.length === 0
        ? phoneForStorage(raw, { dialCode: resolvedDialCode ?? undefined })
        : raw);
    }

    const emails: string[] = [];
    if (draftData.email?.trim()) emails.push(draftData.email.trim());
    if (Array.isArray(draftData.emails)) {
      for (const e of draftData.emails as string[]) {
        const t = String(e ?? '').trim();
        if (t && !emails.includes(t)) emails.push(t);
      }
    }

    // ── Insert lead_entries ────────────────────────────────────────────────
    const leadId = crypto.randomUUID();
    const now    = new Date().toISOString();

    // [DIAG:ADDRESS_FLOW] log address at the exact insert point
    const _diagAddress = draftData.address?.trim() || null;
    const _diagCountry = resolveLeadCountry({ selectedCountry: draftData.country, address: draftData.address });
    const _diagState   = deriveState(draftData.address?.trim() ?? '');
    console.log('[DIAG:ADDRESS_FLOW] executePromotion INSERT address =', _diagAddress, 'country =', _diagCountry, 'state =', _diagState);

    const { error: insertError } = await supabase.from('lead_entries').insert({
      id:                      leadId,
      capture_session_id:      backendSessionId,
      client_name:             draftData.clientName?.trim()      || null,
      company:                 draftData.company?.trim()         || null,
      designation:             draftData.designation?.trim()     || null,
      phones:                  phones.length   ? phones   : null,
      emails:                  emails.length   ? emails   : null,
      address:                 draftData.address?.trim()         || null,
      country:                 resolveLeadCountry({
                                 selectedCountry: draftData.country,
                                 address:         draftData.address,
                               }),
      website:                 draftData.website?.trim()         || null,
      state:                   deriveState(draftData.address?.trim() ?? ''),
      notes:                   draftData.notes?.trim()           || null,
      lead_temperature:        draftData.leadTemperature         || null,
      lead_type:               draftData.leadType                || 'NEW',
      previous_associated_rep: draftData.previousRepCode?.trim() || null,
      application:             Array.isArray(draftData.application) && (draftData.application as string[]).length
                                 ? (draftData.application as string[]).join(', ')
                                 : null,
      price_range:             draftData.priceRange?.trim()      || null,
      quick_keywords:          Array.isArray(draftData.quickKeywords)  && (draftData.quickKeywords  as string[]).length ? draftData.quickKeywords  as string[] : null,
      target_market:           Array.isArray(draftData.targetMarket)   && (draftData.targetMarket   as string[]).length ? draftData.targetMarket   as string[] : null,
      certification:           Array.isArray(draftData.certification)  && (draftData.certification  as string[]).length ? draftData.certification  as string[] : null,
      benchmark:               Array.isArray(draftData.benchmark)      && (draftData.benchmark      as string[]).length ? draftData.benchmark      as string[] : null,
      sales_rep_code:          repCode,
      event_code:              eventCode || null,
      lead_status:             requiresReview ? 'REQUIRES_REVIEW' : 'NEW',
      system_status:           'CREATED',
      created_at:              now,
      updated_at:              now,
    });

    if (insertError) {
      console.warn('[capturePromotionService] lead_entries insert failed:', insertError.message);
      return { leadId: null, error: insertError.message, alreadyPromoted: false };
    }

    // ── Update capture_sessions ────────────────────────────────────────────
    await supabase
      .from('capture_sessions')
      .update({ promoted_lead_id: leadId, session_status: 'promoted' })
      .eq('id', backendSessionId)
      .eq('user_id', userId);

    // ── Log CREATED activity (fire-and-forget, non-blocking) ────────────────
    await supabase.rpc('log_lead_created', { p_lead_id: leadId });

    // ── Link to WhatsApp conversation if one exists for this phone ──────────
    if (phones.length > 0) {
      supabase.rpc('link_lead_to_conversation_by_phone', { p_lead_id: leadId })
        .then(({ error }) => {
          if (error) console.warn('[capturePromotionService] conversation link failed:', error.message);
        });
    }

    // ── Update / create completed_leads ────────────────────────────────────
    await _updateCompletedLead(
      completedLeadId, captureMethod, draftData, backendSessionId,
      eventId, eventName, leadId, identity.userId,
    );

    return { leadId, error: null, alreadyPromoted: false };

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[capturePromotionService] executePromotion failed:', msg);
    return { leadId: null, error: msg, alreadyPromoted: false };
  }
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

async function _updateCompletedLead(
  completedLeadId: string,
  captureMethod:   CaptureMethod | null,
  draftData:       DraftData,
  backendSessionId: string,
  eventId:         string | null,
  eventName:       string | null,
  _leadId:         string,
  ownerId:         string | null,
): Promise<void> {
  try {
    const lead = buildCompletedLead(
      completedLeadId, captureMethod, draftData,
      backendSessionId, eventId, eventName,
      ownerId,
    );
    lead.status   = 'synced';
    lead.syncedAt = new Date().toISOString();
    await saveCompletedLead(lead);
  } catch {
    // IndexedDB errors must not propagate to the caller
  }
}
