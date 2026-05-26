// Local lead queue — synthesizes a live view from the existing IndexedDB stores.
//
// Nothing in the capture flow needs to explicitly "enqueue" a lead.
// The queue is always a derived view of:
//   drafts      → the single active capture draft
//   pending_ops → grouped by sessionId, surfaced as pending/failed items
//
// This means the queue is always accurate without any extra write step.

import { dbGet, dbGetAllInStore, dbDelete } from './db';
import type { CaptureMethod, DraftData, LeadTemperature } from './types';
import type { PersistedDraft } from './captureDraftStorage';
import type { PendingOp } from './captureOfflineQueue';

// ─── Types ────────────────────────────────────────────────────────────────────

export type QueueItemStatus =
  | 'draft'            // active capture draft (not yet submitted)
  | 'pending_sync'     // has pending ops waiting to flush
  | 'syncing'          // flush in-flight (set externally)
  | 'synced'           // all ops confirmed — no longer in queue naturally
  | 'failed'           // ops retried > threshold
  | 'needs_review';    // captured but key fields missing

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
}

// ─── Derive status from pending ops ──────────────────────────────────────────

const FAIL_THRESHOLD = 3;

function statusFromOps(ops: PendingOp[]): QueueItemStatus {
  if (ops.length === 0) return 'synced';
  const maxRetries = Math.max(...ops.map(o => o.retries));
  if (maxRetries >= FAIL_THRESHOLD) return 'failed';
  return 'pending_sync';
}

function lastErrorFromOps(_ops: PendingOp[]): string | null {
  // PendingOp doesn't store an error message — we show a generic one for failed
  return null;
}

// ─── Load queue — derives from drafts + pending_ops ──────────────────────────

export async function loadQueueItems(): Promise<QueueItem[]> {
  const [draftRaw, allOps] = await Promise.all([
    dbGet<PersistedDraft>('drafts', 'active_capture_draft'),
    dbGetAllInStore<PendingOp>('pending_ops'),
  ]);

  const items: QueueItem[] = [];

  // ── 1. Active draft ──────────────────────────────────────────────────────
  if (
    draftRaw &&
    typeof draftRaw === 'object' &&
    'draftData' in draftRaw &&
    draftRaw.sessionStatus !== 'IDLE'
  ) {
    const draft = draftRaw as PersistedDraft;
    const draftData = (draft.draftData ?? {}) as DraftData;

    // Find ops for this session (if any) to determine sync status
    const sessionId  = draft.backendSessionId ?? draft.id;
    const sessionOps = allOps.filter(o => o.sessionId === sessionId || o.sessionId === draft.backendSessionId);

    let status: QueueItemStatus;
    if (sessionOps.length > 0) {
      status = statusFromOps(sessionOps);
    } else if (draft.backendSessionId && draft.lastSyncedAt) {
      status = 'synced';
    } else {
      // Has data but not yet synced — is it reviewable?
      const hasRequiredFields = !!(draftData.clientName?.trim() || draftData.company?.trim());
      status = hasRequiredFields ? 'pending_sync' : 'draft';
    }

    const maxRetries = sessionOps.length > 0 ? Math.max(...sessionOps.map(o => o.retries)) : 0;

    items.push({
      id:               sessionId || 'active_draft',
      status,
      captureMethod:    draft.captureMethod,
      draftData,
      backendSessionId: draft.backendSessionId,
      eventId:          null,
      eventName:        null,
      createdAt:        draft.createdAt ?? new Date().toISOString(),
      updatedAt:        draft.updatedAt ?? new Date().toISOString(),
      syncedAt:         draft.lastSyncedAt,
      retries:          maxRetries,
      lastError:        maxRetries >= FAIL_THRESHOLD ? 'Sync failed after multiple retries. Will retry when online.' : null,
    });
  }

  // ── 2. Pending ops grouped by sessionId (orphaned — no matching draft) ──
  // Group all pending ops by sessionId. Any sessionId that is NOT the active
  // draft's session shows up as its own queue item (e.g. a submitted lead).
  const activeDraftSessionId = (draftRaw as PersistedDraft | null)?.backendSessionId ?? null;

  const grouped = new Map<string, PendingOp[]>();
  for (const op of allOps) {
    if (op.sessionId === activeDraftSessionId) continue; // already handled above
    if (!grouped.has(op.sessionId)) grouped.set(op.sessionId, []);
    grouped.get(op.sessionId)!.push(op);
  }

  for (const [sessionId, ops] of grouped.entries()) {
    // Extract best available draftData from the op payloads
    const draftData = extractDraftFromOps(ops);
    const status    = statusFromOps(ops);
    const maxRetries = Math.max(...ops.map(o => o.retries));
    const earliest  = ops.reduce((a, b) => a.createdAt < b.createdAt ? a : b);
    const latest    = ops.reduce((a, b) => a.createdAt > b.createdAt ? a : b);
    const method    = extractMethodFromOps(ops);

    items.push({
      id:               sessionId,
      status,
      captureMethod:    method,
      draftData,
      backendSessionId: sessionId,
      eventId:          null,
      eventName:        null,
      createdAt:        earliest.createdAt,
      updatedAt:        latest.createdAt,
      syncedAt:         null,
      retries:          maxRetries,
      lastError:        maxRetries >= FAIL_THRESHOLD
        ? 'Sync failed after multiple retries. Will retry when online.'
        : null,
    });
  }

  // Sort newest first
  return items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

// ─── Extract draftData from pending op payloads ───────────────────────────────

function extractDraftFromOps(ops: PendingOp[]): DraftData {
  // update_session_fields carries the richest draftData
  const fieldsOp = ops.find(o => o.type === 'update_session_fields');
  if (fieldsOp) {
    const p = fieldsOp.payload as { draftData?: DraftData };
    if (p?.draftData && typeof p.draftData === 'object') return p.draftData;
  }
  // upsert_session also carries draftData
  const sessionOp = ops.find(o => o.type === 'upsert_session');
  if (sessionOp) {
    const p = sessionOp.payload as { draftData?: DraftData };
    if (p?.draftData && typeof p.draftData === 'object') return p.draftData;
  }
  return {};
}

function extractMethodFromOps(ops: PendingOp[]): CaptureMethod | null {
  const sessionOp = ops.find(o => o.type === 'upsert_session');
  if (sessionOp) {
    const p = sessionOp.payload as { captureMethod?: CaptureMethod };
    return p?.captureMethod ?? null;
  }
  if (ops.some(o => o.type === 'upsert_ocr_extraction')) return 'BUSINESS_CARD';
  if (ops.some(o => o.type === 'upsert_qr_extraction'))  return 'QR';
  return 'MANUAL';
}

// ─── Delete ───────────────────────────────────────────────────────────────────
// For the active draft: clear the draft store.
// For pending op groups: remove all ops for that sessionId.

export async function deleteQueueItem(id: string): Promise<void> {
  // Check if this is the active draft
  const draft = await dbGet<PersistedDraft>('drafts', 'active_capture_draft');
  const draftSessionId = (draft as PersistedDraft | null)?.backendSessionId ?? null;

  if (id === 'active_draft' || id === draftSessionId || id === 'active_capture_draft') {
    await dbDelete('drafts', 'active_capture_draft');
  }

  // Remove all pending ops for this sessionId
  const allOps = await dbGetAllInStore<PendingOp>('pending_ops');
  const toDelete = allOps.filter(o => o.sessionId === id || o.sessionId === draftSessionId);
  await Promise.all(toDelete.map(o => dbDelete('pending_ops', o.id)));
}

// ─── Display helpers ──────────────────────────────────────────────────────────

export function getDisplayName(item: QueueItem): string {
  return item.draftData.clientName?.trim() || item.draftData.company?.trim() || 'Unnamed Lead';
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

// ─── Unused but exported for API compat ──────────────────────────────────────

export async function saveQueueItem(_item: QueueItem): Promise<void> {
  // No-op: queue is derived from existing stores, not written directly.
}

export async function getQueueCounts(): Promise<Record<QueueItemStatus, number>> {
  const items = await loadQueueItems();
  const counts: Record<QueueItemStatus, number> = {
    draft: 0, pending_sync: 0, syncing: 0,
    synced: 0, failed: 0, needs_review: 0,
  };
  for (const item of items) counts[item.status]++;
  return counts;
}

export function buildQueueItemFromDraft(): QueueItem {
  throw new Error('Not needed — queue is derived from existing stores.');
}
