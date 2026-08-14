// Lead queue — aggregates all locally captured leads from three sources:
//   1. drafts store        → the single active capture-in-progress recovery draft
//   2. drafts store        → explicitly saved drafts (multiple, 'saved_draft:*' keys)
//   3. completed_leads     → every lead saved via Save&Next / Card Complete / QR
//
// Nothing needs to write here explicitly.
// loadQueueItems() always reflects current local state accurately.

import { dbGet, dbDelete } from './db';
import { loadCompletedLeads, deleteCompletedLead, type CompletedLeadStatus } from './completedLeadsStorage';
import { loadAllSavedDrafts, deleteSavedDraft, type PersistedDraft } from './captureDraftStorage';
import type { CaptureMethod, DraftData, LeadTemperature } from './types';

// ─── Unified queue item type ───────────────────────────────────────────────────
// Superset of CompletedLeadStatus + draft-specific statuses

export type QueueItemStatus =
  | 'draft'            // active capture draft — not yet saved
  | 'local_only'       // saved locally, sync not yet attempted
  | 'pending_sync'     // sync ops queued / in-flight
  | 'syncing'          // explicitly marked syncing
  | 'synced'           // confirmed on backend
  | 'failed'           // sync failed
  | 'needs_review';    // missing key fields

export interface QueueItem {
  id:               string;
  status:           QueueItemStatus;
  captureMethod:    CaptureMethod | null;
  draftData:        DraftData;
  backendSessionId: string | null;
  eventId:          string | null;
  eventName:        string | null;
  createdAt:        string;
  updatedAt:        string;
  syncedAt:         string | null;
  retries:          number;
  lastError:        string | null;
  source:           'draft' | 'saved_draft' | 'completed';
  isSavedDraft?:    boolean;
}

// ─── Map CompletedLeadStatus → QueueItemStatus ────────────────────────────────

function mapStatus(s: CompletedLeadStatus): QueueItemStatus {
  if (s === 'local_only') return 'local_only';
  return s as QueueItemStatus;
}

// ─── Load — aggregates from both stores ──────────────────────────────────────

export async function loadQueueItems(): Promise<QueueItem[]> {
  const [draftRaw, completedLeads, savedDrafts] = await Promise.all([
    dbGet<PersistedDraft>('drafts', 'active_capture_draft'),
    loadCompletedLeads(),
    loadAllSavedDrafts(),
  ]);

  const items: QueueItem[] = [];

  // ── 1. Saved drafts (explicitly saved by the user) ───────────────────────
  for (const sd of savedDrafts) {
    const draftData = (sd.session.draftData ?? {}) as DraftData;
    items.push({
      id:               sd.id,
      status:           'draft',
      captureMethod:    sd.session.captureMethod,
      draftData,
      backendSessionId: sd.session.sync.backendSessionId ?? null,
      eventId:          null,
      eventName:        null,
      createdAt:        sd.createdAt ?? new Date().toISOString(),
      updatedAt:        sd.updatedAt ?? new Date().toISOString(),
      syncedAt:         sd.session.sync.lastSyncedAt ?? null,
      retries:          0,
      lastError:        null,
      source:           'saved_draft',
      isSavedDraft:     true,
    });
  }

  // ── 2. Active recovery draft (if exists and not IDLE) ──────────────────────
  if (
    draftRaw &&
    typeof draftRaw === 'object' &&
    'draftData' in draftRaw &&
    (draftRaw as PersistedDraft).sessionStatus !== 'IDLE'
  ) {
    const draft = draftRaw as PersistedDraft;
    const draftData = (draft.draftData ?? {}) as DraftData;
    const bsid = draft.backendSessionId;

    // Don't show the draft if it already has a completed_leads entry
    // (means it was saved via Save & Next and we're now showing it there)
    const alreadySaved = completedLeads.some(c => c.id === bsid || c.backendSessionId === bsid);

    if (!alreadySaved) {
      const hasKey = !!(draftData.clientName?.trim() || draftData.company?.trim());
      const status: QueueItemStatus = hasKey ? 'draft' : 'draft';

      items.push({
        id:               bsid ?? 'active_draft',
        status,
        captureMethod:    draft.captureMethod,
        draftData,
        backendSessionId: bsid,
        eventId:          null,
        eventName:        null,
        createdAt:        draft.createdAt ?? new Date().toISOString(),
        updatedAt:        draft.updatedAt ?? new Date().toISOString(),
        syncedAt:         draft.lastSyncedAt,
        retries:          0,
        lastError:        null,
        source:           'draft',
      });
    }
  }

  // ── 3. Completed leads ────────────────────────────────────────────────────
  for (const c of completedLeads) {
    items.push({
      id:               c.id,
      status:           mapStatus(c.status),
      captureMethod:    c.captureMethod,
      draftData:        c.draftData,
      backendSessionId: c.backendSessionId,
      eventId:          c.eventId,
      eventName:        c.eventName,
      createdAt:        c.createdAt,
      updatedAt:        c.updatedAt,
      syncedAt:         c.syncedAt,
      retries:          c.retries,
      lastError:        c.lastError,
      source:           'completed',
    });
  }

  // Deduplicate by id (draft + completed can share bsid)
  const seen = new Set<string>();
  const deduped = items.filter(item => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });

  // Sort newest first
  return deduped.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

// ─── Delete ───────────────────────────────────────────────────────────────────

export async function deleteQueueItem(id: string): Promise<void> {
  // Saved draft?
  if (id.startsWith('saved_draft:')) {
    await deleteSavedDraft(id);
    return;
  }

  // Remove from completed_leads
  await deleteCompletedLead(id);

  // Also clear the active recovery draft if this is it
  const draft = await dbGet<PersistedDraft>('drafts', 'active_capture_draft');
  if (draft) {
    const draftBsid = (draft as PersistedDraft).backendSessionId;
    if (id === 'active_draft' || id === draftBsid) {
      await dbDelete('drafts', 'active_capture_draft');
    }
  }
}

// ─── Display helpers ──────────────────────────────────────────────────────────

export function getDisplayName(item: QueueItem): string {
  return item.draftData.clientName?.trim()
    || item.draftData.company?.trim()
    || 'Unnamed Lead';
}

export function getDisplayCompany(item: QueueItem): string | null {
  if (item.draftData.clientName?.trim() && item.draftData.company?.trim()) {
    return item.draftData.company.trim();
  }
  return null;
}

export function getLeadTemperature(item: QueueItem): LeadTemperature | null {
  return (item.draftData.leadTemperature as LeadTemperature | undefined) ?? null;
}

// ─── API compat stubs ─────────────────────────────────────────────────────────

export async function saveQueueItem(_item: QueueItem): Promise<void> {
  // Queue is populated by saveCompletedLead, not this function.
}

export async function getQueueCounts(): Promise<Record<QueueItemStatus, number>> {
  const items = await loadQueueItems();
  const counts: Record<QueueItemStatus, number> = {
    draft: 0, local_only: 0, pending_sync: 0, syncing: 0,
    synced: 0, failed: 0, needs_review: 0,
  };
  for (const item of items) counts[item.status]++;
  return counts;
}
