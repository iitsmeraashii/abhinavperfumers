// Completed leads store — persists captured leads to IndexedDB.
// Written when the user presses "Save & Next", completes a card capture,
// or submits a QR scan. Survives app restarts and offline sessions.
// Each record is keyed by its stable frontend sessionId (UUID).

import type { CaptureMethod, DraftData } from './types';
import { openDB } from './db';

// ─── Change notification ─────────────────────────────────────────────────────
// Lightweight pub/sub so subscribers (e.g. LeadQueuePage) can react to
// status transitions without polling. Every write (put/remove) emits a
// change event. useSyncExternalStore-compatible interface.

type Listener = () => void;
const listeners = new Set<Listener>();
let version = 0;

export function subscribeCompletedLeads(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function getCompletedLeadsVersion(): number {
  return version;
}

function notify(): void {
  version++;
  listeners.forEach(l => l());
}

export type CompletedLeadStatus =
  | 'local_only'      // captured, not yet attempted to sync
  | 'pending_sync'    // sync ops queued, waiting to flush
  | 'syncing'         // flush in-flight
  | 'synced'          // confirmed on backend
  | 'failed'          // sync failed after retries
  | 'needs_review';   // missing key fields

export interface CompletedLead {
  id:               string;   // stable UUID (= backendSessionId or frontend-generated)
  ownerId:          string | null;  // auth UID of the rep who created this record
  status:           CompletedLeadStatus;
  captureMethod:    CaptureMethod | null;
  draftData:        DraftData;
  backendSessionId: string | null;
  eventId:          string | null;
  eventName:        string | null;
  createdAt:        string;   // ISO
  updatedAt:        string;   // ISO
  syncedAt:         string | null;
  retries:          number;
  lastError:        string | null;
  // Processing failure diagnostics (from processing_queue)
  failedStage:      string | null;
  lastAttemptAt:   string | null;
  failedAt:        string | null;
  isExhausted:     boolean;  // true when retry_count >= MAX_RETRY_COUNT
}

const STORE = 'completed_leads';

// ─── Low-level helpers ────────────────────────────────────────────────────────

async function put(record: CompletedLead): Promise<boolean> {
  try {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
      const tx  = db.transaction(STORE, 'readwrite');
      const req = tx.objectStore(STORE).put(record);
      req.onsuccess = () => resolve();
      req.onerror   = () => reject(req.error);
    });
    return true;
  } catch { /* storage errors must not crash UI */ }
  return false;
}

async function getAll(ownerId?: string): Promise<CompletedLead[]> {
  try {
    const db = await openDB();
    return new Promise<CompletedLead[]>((resolve, reject) => {
      const tx  = db.transaction(STORE, 'readonly');
      const store = tx.objectStore(STORE);
      const req = ownerId
        ? store.index('by_owner').getAll(ownerId)
        : store.getAll();
      req.onsuccess = () => resolve((req.result as CompletedLead[]) ?? []);
      req.onerror   = () => reject(req.error);
    });
  } catch { return []; }
}

async function get(id: string): Promise<CompletedLead | null> {
  try {
    const db = await openDB();
    return new Promise<CompletedLead | null>((resolve, reject) => {
      const tx  = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(id);
      req.onsuccess = () => resolve((req.result as CompletedLead | undefined) ?? null);
      req.onerror   = () => reject(req.error);
    });
  } catch { return null; }
}

async function remove(id: string): Promise<void> {
  try {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
      const tx  = db.transaction(STORE, 'readwrite');
      const req = tx.objectStore(STORE).delete(id);
      req.onsuccess = () => resolve();
      req.onerror   = () => reject(req.error);
    });
  } catch { /* ignore */ }
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function saveCompletedLead(lead: CompletedLead): Promise<void> {
  await put({ ...lead, updatedAt: new Date().toISOString() });
  notify();
}

export async function loadCompletedLeads(ownerId?: string): Promise<CompletedLead[]> {
  const records = await getAll(ownerId);
  return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function getCompletedLead(id: string): Promise<CompletedLead | null> {
  return get(id);
}

export async function updateCompletedLeadStatus(
  id: string,
  status: CompletedLeadStatus,
  extra?: Partial<Pick<CompletedLead, 'syncedAt' | 'retries' | 'lastError' | 'backendSessionId' | 'failedStage' | 'lastAttemptAt' | 'failedAt' | 'isExhausted'>>,
  ownerId?: string,
): Promise<boolean> {
  const existing = await get(id);
  if (!existing) return false;
  if (ownerId && existing.ownerId !== ownerId) return false;
  const ok = await put({ ...existing, status, updatedAt: new Date().toISOString(), ...extra });
  if (ok) notify();
  return ok;
}

export async function deleteCompletedLead(id: string, ownerId?: string): Promise<boolean> {
  const existing = await get(id);
  if (!existing) return true;
  if (ownerId && existing.ownerId !== ownerId) return false;
  await remove(id);
  notify();
  return true;
}

/**
 * Delete synced completed_leads records older than `maxAgeMs`.
 *
 * Only records matching ALL of these conditions are deleted:
 *   - status === 'synced'
 *   - syncedAt is a non-null, parseable timestamp
 *   - Date.parse(syncedAt) <= Date.now() - maxAgeMs
 *
 * Records with missing/invalid syncedAt are NEVER deleted (no fallback to
 * updatedAt).  Only the local IndexedDB record is removed — this never
 * touches lead_entries, processing_queue, pending_ops, drafts, or any
 * backend data.
 *
 * Returns the number of records deleted.
 */
export async function cleanupOldSyncedCompletedLeads(
  ownerId: string,
  maxAgeMs: number,
): Promise<number> {
  try {
    const all = await getAll(ownerId);
    const cutoff = Date.now() - maxAgeMs;
    const toDelete = all.filter(r => {
      if (r.status !== 'synced') return false;
      if (!r.syncedAt) return false;
      const ts = Date.parse(r.syncedAt);
      if (Number.isNaN(ts)) return false;
      return ts <= cutoff;
    });
    if (toDelete.length === 0) return 0;
    await Promise.all(toDelete.map(r => remove(r.id)));
    notify();
    return toDelete.length;
  } catch {
    return 0;
  }
}

/**
 * Delete ALL completed_leads records whose status is 'synced'.
 *
 * This is a local-only cleanup: it removes the IndexedDB cache entries that
 * power the "Synced" section of the Queue page. It does NOT touch:
 *   - Supabase lead_entries
 *   - capture_sessions
 *   - processing_queue
 *   - pending_ops / drafts / assets
 *   - records in any status other than 'synced'
 *
 * Returns the count of deleted records.
 */
export async function deleteAllSyncedCompletedLeads(ownerId?: string): Promise<number> {
  try {
    const all = await getAll(ownerId);
    const synced = all.filter(r => r.status === 'synced');
    if (synced.length === 0) return 0;
    await Promise.all(synced.map(r => remove(r.id)));
    notify();
    return synced.length;
  } catch { return 0; }
}

// ─── Build a lead record from capture session data ────────────────────────────

export function buildCompletedLead(
  sessionId: string,
  captureMethod: CaptureMethod | null,
  draftData: DraftData,
  backendSessionId: string | null,
  eventId: string | null = null,
  eventName: string | null = null,
  ownerId: string | null = null,
): CompletedLead {
  const hasKey = !!(draftData.clientName?.trim() || draftData.company?.trim());
  const status: CompletedLeadStatus = hasKey ? 'local_only' : 'needs_review';
  const now = new Date().toISOString();
  return {
    id:               sessionId,
    ownerId,
    status,
    captureMethod,
    draftData,
    backendSessionId,
    eventId,
    eventName,
    createdAt:        now,
    updatedAt:        now,
    syncedAt:         null,
    retries:          0,
    lastError:        null,
    failedStage:      null,
    lastAttemptAt:    null,
    failedAt:         null,
    isExhausted:      false,
  };
}
