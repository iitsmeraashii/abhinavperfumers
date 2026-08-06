// Fire-and-forget backend sync for the capture lead workflow.
//
// Design principles:
//   - NEVER awaited by UI code — all functions return void
//   - Failures are swallowed silently; UI always uses local state
//   - Each operation is idempotent via upsert (stable IDs from frontend)
//   - Offline detection: skip sync if navigator.onLine is false
//   - No retry queue in this layer — caller re-calls on reconnect
//
// The stable IDs (session ID, asset ID, extraction ID) are generated on the
// frontend before any network call, which makes every upsert safe to replay.

import { supabase } from '../supabaseClient';
import { getAuthIdentity } from './captureAuth';
import { executePromotion } from './capturePromotionService';
import { logOperationStart, logOperationEnd, logEvent, getCorrelationId } from './assetSyncDiagnostics';
import type {
  BackendSyncState,
  BusinessCardAsset,
  CaptureMethod,
  DraftData,
  OcrResult,
  VisionResult,
} from './types';
import type { ParsedContact } from './parseQrPayload';

// ─── Callbacks ────────────────────────────────────────────────────────────────
// The sync service notifies the caller via lightweight callbacks so the hook
// can update React state without this module knowing about React.

export interface SyncCallbacks {
  onSyncing:    () => void;
  onSynced:     (patch: Partial<BackendSyncState>) => void;
  onSyncError:  (err: string) => void;
  onOffline:    () => void;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function online(): boolean {
  return typeof navigator !== 'undefined' ? navigator.onLine : true;
}

// ─── Session upsert ───────────────────────────────────────────────────────────

export interface UpsertSessionPayload {
  sessionId:       string;   // stable frontend-generated UUID
  captureMethod:   CaptureMethod;
  draftData:       DraftData;
  sessionStatus:   string;
  localDraftKey?:  string;
  eventId?:        string | null;
}

export async function syncUpsertSession(
  payload: UpsertSessionPayload,
  cbs: SyncCallbacks,
): Promise<void> {
  if (!online()) { cbs.onOffline(); return; }

  const op = logOperationStart('syncUpsertSession()', {
    backendSessionId: payload.sessionId,
    captureMethod:    payload.captureMethod,
  });

  cbs.onSyncing();

  try {
    const identity = await getAuthIdentity();
    if (!identity) { cbs.onSyncError('Not authenticated'); logOperationEnd(op, { error: new Error('Not authenticated') }); return; }

    const { userId, repCode } = identity;
    const {
      sessionId, captureMethod, draftData, sessionStatus, localDraftKey, eventId,
    } = payload;

    // Check if session row already exists before upserting
    const { data: existingRow } = await supabase
      .from('capture_sessions')
      .select('id')
      .eq('id', sessionId)
      .maybeSingle();
    const sessionExistsBefore = !!existingRow;

    // Build the phones/emails arrays from the single-value draft fields
    const phones = draftData.phone ? [draftData.phone] : [];
    const emails = draftData.email ? [draftData.email] : [];

    // extracted_fields holds the current best-known contact fields
    const extractedFields: Record<string, unknown> = {};
    if (draftData.clientName)   extractedFields.clientName   = draftData.clientName;
    if (draftData.company)      extractedFields.company      = draftData.company;
    if (draftData.phone)        extractedFields.phone        = draftData.phone;
    if (draftData.email)        extractedFields.email        = draftData.email;
    if (draftData.designation)  extractedFields.designation  = draftData.designation;

    const upsertPayload = {
      id:               sessionId,
      user_id:          userId,
      sales_rep_code:   repCode,
      event_id:         eventId ?? null,
      capture_method:   captureMethod,
      session_status:   sessionStatus.toLowerCase(),
      extracted_fields: extractedFields,
      notes:            draftData.notes ?? '',
      phones,
      emails,
      local_draft_key:  localDraftKey ?? null,
      // New enrichment fields
      lead_temperature:       draftData.leadTemperature ?? null,
      lead_type:              draftData.leadType ?? null,
      previous_rep_code:      draftData.previousRepCode ?? null,
      application:            draftData.application?.length ? draftData.application : null,
      price_range:            draftData.priceRange ?? null,
      quick_keywords:         draftData.quickKeywords?.length ? draftData.quickKeywords : null,
      target_market:          draftData.targetMarket?.length ? draftData.targetMarket : null,
      certification:          draftData.certification?.length ? draftData.certification : null,
      benchmark:              draftData.benchmark?.length ? draftData.benchmark : null,
      notes_image_url:        draftData.notesImageDataUrl ?? null,
      voice_note_duration_ms: draftData.voiceNoteDurationMs ?? null,
      voice_note_transcript:  draftData.voiceNoteTranscript ?? null,
      // Legacy columns
      client_name:      draftData.clientName ?? null,
      company:          draftData.company    ?? null,
      designation:      draftData.designation ?? null,
      synced_at:        new Date().toISOString(),
    };

    const { error, count } = await supabase
      .from('capture_sessions')
      .upsert(upsertPayload, { onConflict: 'id' })
      .select('id')
      .maybeSingle();

    if (error) throw error;

    logOperationEnd(op, {
      payload: upsertPayload,
      sessionExistsBefore,
      rowsAffected: count ?? 1,
      dbResponse: { id: sessionId },
    });

    cbs.onSynced({
      backendSessionId: sessionId,
      lastSyncedAt:     new Date().toISOString(),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[captureBackendSync] syncUpsertSession failed:', msg);
    logOperationEnd(op, { error: err });
    cbs.onSyncError(msg);
  }
}

// ─── Asset upsert ─────────────────────────────────────────────────────────────

export interface UpsertAssetPayload {
  backendSessionId: string;
  asset:            BusinessCardAsset;
}

export async function syncUpsertAsset(
  payload: UpsertAssetPayload,
  cbs: SyncCallbacks,
): Promise<void> {
  const corrId = getCorrelationId() ?? 'no_correlation';
  const ctx = {
    backendSessionId: payload.backendSessionId,
    assetType:        'business_card' as const,
    assetSide:         payload.asset.side,
    localAssetId:      payload.asset.id,
  };

  logEvent('syncUpsertAsset() — entry', ctx, { corrId });

  // ── Branch: online check ──────────────────────────────────────────────────
  const isOnline = online();
  logEvent('syncUpsertAsset() — online() evaluated', ctx, { corrId, isOnline });

  if (!isOnline) {
    logEvent('syncUpsertAsset() — returning: offline', ctx, { corrId, returnReason: 'navigator.onLine is false' });
    cbs.onOffline();
    return;
  }

  const op = logOperationStart('syncUpsertAsset()', ctx);
  logEvent('syncUpsertAsset() — logOperationStart created', ctx, { corrId });

  // ── Step: onSyncing callback ───────────────────────────────────────────────
  logEvent('syncUpsertAsset() — calling cbs.onSyncing()', ctx, { corrId });
  cbs.onSyncing();
  logEvent('syncUpsertAsset() — cbs.onSyncing() returned', ctx, { corrId });

  try {
    // ── Step: getAuthIdentity ──────────────────────────────────────────────
    logEvent('syncUpsertAsset() — awaiting getAuthIdentity()', ctx, { corrId });
    const identity = await getAuthIdentity();
    logEvent('syncUpsertAsset() — getAuthIdentity() resolved', ctx, {
      corrId,
      hasIdentity: !!identity,
      identityUserId: identity?.userId ?? null,
      identityRepCode: identity?.repCode ?? null,
      identityIsNull: identity === null,
      identityIsUndefined: identity === undefined,
    });

    if (!identity) {
      logEvent('syncUpsertAsset() — returning: not authenticated', ctx, { corrId, returnReason: 'identity is null/undefined' });
      cbs.onSyncError('Not authenticated');
      logOperationEnd(op, { error: new Error('Not authenticated') });
      return;
    }
    const { userId } = identity;

    const { backendSessionId, asset } = payload;
    logEvent('syncUpsertAsset() — payload destructured', ctx, { corrId, userId, backendSessionId, assetId: asset.id });

    // ── Step: session existence check ──────────────────────────────────────
    logEvent('syncUpsertAsset() — awaiting session existence check', ctx, { corrId });
    const { data: sessionRow, error: sessionCheckError } = await supabase
      .from('capture_sessions')
      .select('id')
      .eq('id', backendSessionId)
      .maybeSingle();
    logEvent('syncUpsertAsset() — session existence check resolved', ctx, {
      corrId,
      sessionRow: sessionRow ?? null,
      sessionRowIsNull: sessionRow === null,
      sessionRowIsUndefined: sessionRow === undefined,
      sessionCheckError: sessionCheckError ? { message: sessionCheckError.message, code: sessionCheckError.code } : null,
    });

    if (sessionCheckError) {
      logEvent('syncUpsertAsset() — session existence check returned error', ctx, {
        corrId,
        error: { code: sessionCheckError.code, message: sessionCheckError.message, details: sessionCheckError.details, hint: sessionCheckError.hint },
      });
    }

    const sessionExistsBefore = !!sessionRow;
    logEvent('syncUpsertAsset() — sessionExistsBefore computed', ctx, { corrId, sessionExistsBefore });

    // ── Step: build upsert payload ─────────────────────────────────────────
    const upsertPayload = {
      capture_session_id: backendSessionId,
      user_id:            userId,
      asset_type:         'business_card',
      side:               asset.side,
      asset_side:         asset.side,
      local_asset_id:     asset.id,
      mime_type:          asset.mimeType,
      size_bytes:         asset.sizeBytes,
      file_size:          asset.sizeBytes,
      original_width:     asset.originalWidth,
      original_height:    asset.originalHeight,
      stored_width:       asset.storedWidth,
      stored_height:      asset.storedHeight,
      width:              asset.storedWidth,
      height:             asset.storedHeight,
      processing_status:  'done',
    };
    logEvent('syncUpsertAsset() — upsert payload built', ctx, { corrId, payloadKeys: Object.keys(upsertPayload) });

    // ── Step: capture_assets upsert ─────────────────────────────────────────
    logEvent('syncUpsertAsset() — awaiting capture_assets upsert', ctx, { corrId });
    const { data, error, count } = await supabase
      .from('capture_assets')
      .upsert(upsertPayload, { onConflict: 'capture_session_id,local_asset_id' })
      .select('id')
      .maybeSingle();
    logEvent('syncUpsertAsset() — capture_assets upsert resolved', ctx, {
      corrId,
      data: data ?? null,
      dataIsNull: data === null,
      dataIsUndefined: data === undefined,
      error: error ? { code: error.code, message: error.message, details: error.details, hint: error.hint, constraint: error.constraint } : null,
      count: count ?? null,
    });

    if (error) {
      logEvent('syncUpsertAsset() — capture_assets upsert returned error, throwing', ctx, {
        corrId,
        error: { code: error.code, message: error.message, details: error.details, hint: error.hint, constraint: error.constraint, status: (error as Record<string, unknown>).status ?? null },
      });
      throw error;
    }

    const confirmedId = data?.id ?? asset.id;
    logEvent('syncUpsertAsset() — confirmedId computed', ctx, { corrId, confirmedId, dbReturnedId: data?.id ?? null, fellBackToAssetId: !data?.id });

    logOperationEnd(op, {
      payload: upsertPayload,
      sessionExistsBefore,
      rowsAffected: count ?? 1,
      createdRowId: data?.id ?? null,
      dbResponse: data,
    });
    logEvent('syncUpsertAsset() — logOperationEnd called', ctx, { corrId });

    // ── Step: onSynced callback ─────────────────────────────────────────────
    logEvent('syncUpsertAsset() — calling cbs.onSynced()', ctx, { corrId, confirmedId });
    cbs.onSynced({
      backendAssetIds:  { [asset.id]: confirmedId },
      lastSyncedAt:     new Date().toISOString(),
    });
    logEvent('syncUpsertAsset() — cbs.onSynced() returned', ctx, { corrId });

    logEvent('syncUpsertAsset() — returning normally', ctx, { corrId, returnReason: 'success' });
  } catch (err) {
    // Log the COMPLETE error object before it is handled
    const errInfo: Record<string, unknown> = {};
    if (err && typeof err === 'object') {
      const e = err as Record<string, unknown>;
      errInfo.code = e.code ?? null;
      errInfo.message = e.message ?? null;
      errInfo.details = e.details ?? null;
      errInfo.hint = e.hint ?? null;
      errInfo.constraint = e.constraint ?? null;
      errInfo.status = e.status ?? null;
      errInfo.stack = e.stack ?? null;
    } else {
      errInfo.message = String(err);
    }
    logEvent('syncUpsertAsset() — CAUGHT exception', ctx, {
      corrId,
      error: errInfo,
      operation: 'syncUpsertAsset',
    });
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[captureBackendSync] syncUpsertAsset failed:', msg);
    logOperationEnd(op, { error: err });
    cbs.onSyncError(msg);
    logEvent('syncUpsertAsset() — returning after catch', ctx, { corrId, returnReason: 'caught exception' });
  }
}

// ─── Extraction result upsert — OCR ──────────────────────────────────────────

export interface UpsertOcrExtractionPayload {
  extractionId:     string;   // stable frontend-generated ID
  backendSessionId: string;
  backendAssetId:   string | null;
  ocrResult:        OcrResult;
  durationMs?:      number;
}

export async function syncUpsertOcrExtraction(
  payload: UpsertOcrExtractionPayload,
  cbs: SyncCallbacks,
): Promise<void> {
  if (!online()) { cbs.onOffline(); return; }

  cbs.onSyncing();

  try {
    const identity = await getAuthIdentity();
    if (!identity) { cbs.onSyncError('Not authenticated'); return; }
    const { userId } = identity;

    const { extractionId, backendSessionId, backendAssetId, ocrResult, durationMs } = payload;

    const { error } = await supabase
      .from('extraction_results')
      .upsert({
        id:                 extractionId,
        capture_session_id: backendSessionId,
        asset_id:           backendAssetId,
        user_id:            userId,
        engine:             'tesseract_ocr',
        extraction_engine:  'tesseract_ocr',   // legacy column
        extraction_type:    'ocr',             // legacy column
        raw_text:           ocrResult.rawText,
        extracted_json:     ocrResult.fields,
        extracted_data:     ocrResult.fields,  // legacy column
        confidence:         ocrResult.confidence,
        overall_confidence: ocrResult.confidence === 'high' ? 0.9 :
                            ocrResult.confidence === 'medium' ? 0.6 : 0.3,
        duration_ms:        durationMs ?? null,
        processing_time_ms: durationMs ?? null, // legacy column
        status:             'done',
        success:            true,  // legacy column
        metadata: {
          inferredFields: ocrResult.inferredFields,
          ignoredLines:   ocrResult.ignoredLines,
          completedAt:    ocrResult.completedAt,
          assetId:        ocrResult.assetId,
        },
      }, { onConflict: 'id' });

    if (error) throw error;

    cbs.onSynced({
      backendExtractionIds: { [extractionId]: extractionId },
      lastSyncedAt:         new Date().toISOString(),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[captureBackendSync] syncUpsertOcrExtraction failed:', msg);
    cbs.onSyncError(msg);
  }
}

// ─── Extraction result upsert — QR ───────────────────────────────────────────

export interface UpsertQrExtractionPayload {
  extractionId:     string;
  backendSessionId: string;
  parsed:           ParsedContact;
  durationMs?:      number;
}

export async function syncUpsertQrExtraction(
  payload: UpsertQrExtractionPayload,
  cbs: SyncCallbacks,
): Promise<void> {
  if (!online()) { cbs.onOffline(); return; }

  cbs.onSyncing();

  try {
    const identity = await getAuthIdentity();
    if (!identity) { cbs.onSyncError('Not authenticated'); return; }
    const { userId } = identity;

    const { extractionId, backendSessionId, parsed, durationMs } = payload;

    const confidenceMap: Record<string, number> = { high: 0.9, medium: 0.6, low: 0.3 };

    const { error } = await supabase
      .from('extraction_results')
      .upsert({
        id:                 extractionId,
        capture_session_id: backendSessionId,
        asset_id:           null,
        user_id:            userId,
        engine:             'qr_parser',
        extraction_engine:  'qr_parser',
        extraction_type:    'qr',
        raw_text:           parsed.raw,
        extracted_json:     parsed.fields,
        extracted_data:     parsed.fields,
        confidence:         parsed.confidence,
        overall_confidence: confidenceMap[parsed.confidence] ?? 0.5,
        duration_ms:        durationMs ?? null,
        processing_time_ms: durationMs ?? null,
        status:             'done',
        success:            true,
        metadata: {
          qrType:             parsed.qrType,
          extractionStrategy: parsed.extractionStrategy,
          hasData:            parsed.hasData,
          ignoredLines:       parsed.ignoredLines,
        },
      }, { onConflict: 'id' });

    if (error) throw error;

    cbs.onSynced({
      backendExtractionIds: { [extractionId]: extractionId },
      lastSyncedAt:         new Date().toISOString(),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[captureBackendSync] syncUpsertQrExtraction failed:', msg);
    cbs.onSyncError(msg);
  }
}

// ─── Session field update ─────────────────────────────────────────────────────
// Called when user edits fields in the manual form — debounced by caller.

export async function syncUpdateSessionFields(
  backendSessionId: string,
  draftData: DraftData,
  cbs: SyncCallbacks,
): Promise<void> {
  if (!online()) { cbs.onOffline(); return; }

  cbs.onSyncing();

  try {
    const identity = await getAuthIdentity();
    if (!identity) { cbs.onSyncError('Not authenticated'); return; }
    const { userId } = identity;

    const extractedFields: Record<string, unknown> = {};
    if (draftData.clientName)   extractedFields.clientName   = draftData.clientName;
    if (draftData.company)      extractedFields.company      = draftData.company;
    if (draftData.phone)        extractedFields.phone        = draftData.phone;
    if (draftData.email)        extractedFields.email        = draftData.email;
    if (draftData.designation)  extractedFields.designation  = draftData.designation;

    const { error } = await supabase
      .from('capture_sessions')
      .update({
        extracted_fields: extractedFields,
        notes:            draftData.notes ?? '',
        phones:           draftData.phone ? [draftData.phone] : [],
        emails:           draftData.email ? [draftData.email] : [],
        client_name:      draftData.clientName ?? null,
        company:          draftData.company    ?? null,
        designation:      draftData.designation ?? null,
        lead_temperature:       draftData.leadTemperature ?? null,
        lead_type:              draftData.leadType ?? null,
        previous_rep_code:      draftData.previousRepCode ?? null,
        application:            draftData.application?.length ? draftData.application : null,
        price_range:            draftData.priceRange ?? null,
        quick_keywords:         draftData.quickKeywords?.length ? draftData.quickKeywords : null,
        target_market:          draftData.targetMarket?.length ? draftData.targetMarket : null,
        certification:          draftData.certification?.length ? draftData.certification : null,
        benchmark:              draftData.benchmark?.length ? draftData.benchmark : null,
        notes_image_url:        draftData.notesImageDataUrl ?? null,
        voice_note_duration_ms: draftData.voiceNoteDurationMs ?? null,
        voice_note_transcript:  draftData.voiceNoteTranscript ?? null,
        synced_at:        new Date().toISOString(),
      })
      .eq('id', backendSessionId)
      .eq('user_id', userId);

    if (error) throw error;

    cbs.onSynced({ lastSyncedAt: new Date().toISOString() });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[captureBackendSync] syncUpdateSessionFields failed:', msg);
    cbs.onSyncError(msg);
  }
}

// ─── Extraction result upsert — OpenAI Vision ────────────────────────────────

export interface UpsertVisionExtractionPayload {
  extractionId:     string;   // stable frontend-generated ID
  backendSessionId: string;
  backendAssetId:   string | null;
  visionResult:     VisionResult;
}

export async function syncUpsertVisionExtraction(
  payload: UpsertVisionExtractionPayload,
  cbs: SyncCallbacks,
): Promise<void> {
  if (!online()) { cbs.onOffline(); return; }

  cbs.onSyncing();

  try {
    const identity = await getAuthIdentity();
    if (!identity) { cbs.onSyncError('Not authenticated'); return; }
    const { userId } = identity;

    const { extractionId, backendSessionId, backendAssetId, visionResult } = payload;
    const f = visionResult.fields;

    const confidenceText: 'high' | 'medium' | 'low' =
      f.confidence >= 0.75 ? 'high' :
      f.confidence >= 0.45 ? 'medium' : 'low';

    const { error } = await supabase
      .from('extraction_results')
      .upsert({
        id:                 extractionId,
        capture_session_id: backendSessionId,
        asset_id:           backendAssetId,
        user_id:            userId,
        engine:             'openai_vision',
        extraction_engine:  'openai_vision',  // legacy column
        extraction_type:    'vision',          // legacy column
        raw_text:           f.rawText,
        // Full structured output including multi-value arrays
        extracted_json: {
          fullName:     f.fullName,
          firstName:    f.firstName,
          lastName:     f.lastName,
          company:      f.company,
          designation:  f.designation,
          emails:       f.emails,
          phoneNumbers: f.phoneNumbers,
          website:      f.website,
          address:      f.address,
          notes:        f.notes,
        },
        extracted_data: {  // legacy column — flat shape matching lead_entries
          clientName:  f.fullName       || null,
          company:     f.company        || null,
          designation: f.designation    || null,
          phone:       f.phoneNumbers[0] ?? null,
          email:       f.emails[0]       ?? null,
        },
        confidence:         confidenceText,
        overall_confidence: f.confidence,
        duration_ms:        visionResult.durationMs,
        processing_time_ms: visionResult.durationMs,  // legacy column
        status:             'done',
        success:            true,  // legacy column
        metadata: {
          source:          visionResult.source,
          attempt:         visionResult.attempt,
          fieldConfidence: visionResult.fieldConfidence,
          completedAt:     visionResult.completedAt,
        },
      }, { onConflict: 'id' });

    if (error) throw error;

    cbs.onSynced({
      backendExtractionIds: { [extractionId]: extractionId },
      lastSyncedAt:         new Date().toISOString(),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[captureBackendSync] syncUpsertVisionExtraction failed:', msg);
    cbs.onSyncError(msg);
  }
}

// ─── Session extraction metadata update ──────────────────────────────────────
// Called after a successful Vision (openai_vision) extraction to persist the
// engine, confidence score, and status onto the capture_sessions row.

export interface UpdateSessionExtractionMetaPayload {
  backendSessionId: string;
  source:           string;   // e.g. 'openai_vision'
  confidence:       number;   // 0–1 float
  durationMs:       number;
}

export async function syncUpdateSessionExtractionMeta(
  payload: UpdateSessionExtractionMetaPayload,
  cbs: SyncCallbacks,
): Promise<void> {
  if (!online()) { cbs.onOffline(); return; }

  cbs.onSyncing();

  try {
    const identity = await getAuthIdentity();
    if (!identity) { cbs.onSyncError('Not authenticated'); return; }
    const { userId } = identity;

    const { backendSessionId, source, confidence, durationMs } = payload;

    const { error } = await supabase
      .from('capture_sessions')
      .update({
        extraction_source:      source,
        extraction_status:      'done',
        extraction_confidence:  confidence,
        extraction_duration_ms: durationMs,
      })
      .eq('id', backendSessionId)
      .eq('user_id', userId);

    if (error) throw error;

    cbs.onSynced({ lastSyncedAt: new Date().toISOString() });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[captureBackendSync] syncUpdateSessionExtractionMeta failed:', msg);
    cbs.onSyncError(msg);
  }
}

// ─── Promote capture session → lead_entries ──────────────────────────────────
// Re-exports the canonical options type from capturePromotionService so callers
// only need one import. Both the online path and the queue replay use
// executePromotion from that module — this wrapper adapts it to SyncCallbacks.

export type { PromoteSessionOptions as PromoteSessionPayload } from './capturePromotionService';

export async function syncPromoteSession(
  payload: import('./capturePromotionService').PromoteSessionOptions,
  cbs: SyncCallbacks,
): Promise<void> {
  if (!online()) { cbs.onOffline(); return; }

  cbs.onSyncing();

  const result = await executePromotion(payload);

  if (result.error) {
    cbs.onSyncError(result.error);
  } else {
    cbs.onSynced({ lastSyncedAt: new Date().toISOString() });
  }
}

// Deprecated shim — kept for backward compatibility; prefer executePromotion directly.
export interface PromoteResult {
  leadId: string | null;
  error:  string | null;
}

export async function promoteSessionToLead(
  backendSessionId: string,
  draftData:        DraftData,
  eventCode:        string | null,
): Promise<PromoteResult> {
  const result = await executePromotion({
    backendSessionId,
    draftData,
    eventCode,
    completedLeadId: backendSessionId,
    captureMethod:   null,
    eventId:         null,
    eventName:       null,
  });
  return { leadId: result.leadId, error: result.error };
}

// ─── Session abandon ──────────────────────────────────────────────────────────

export async function syncAbandonSession(
  backendSessionId: string,
  cbs: SyncCallbacks,
): Promise<void> {
  if (!online()) { cbs.onOffline(); return; }

  try {
    const identity = await getAuthIdentity();
    if (!identity) return;
    const { userId } = identity;

    await supabase
      .from('capture_sessions')
      .update({ session_status: 'abandoned' })
      .eq('id', backendSessionId)
      .eq('user_id', userId);

    cbs.onSynced({ lastSyncedAt: new Date().toISOString() });
  } catch (err) {
    console.warn('[captureBackendSync] syncAbandonSession failed:', err);
  }
}
