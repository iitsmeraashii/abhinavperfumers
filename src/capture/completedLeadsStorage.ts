// Completed leads store — persists captured leads to IndexedDB.
// Written when the user presses "Save & Next", completes a card capture,
// or submits a QR scan. Survives app restarts and offline sessions.
// Each record is keyed by its stable frontend sessionId (UUID).

import type { CaptureMethod, DraftData } from './types';

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

const DB_NAME    = 'capture_app';
const DB_VERSION = 5;  // v5 adds completed_leads store
const STORE      = 'completed_leads';

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (event) => {
      const db  = (event.target as IDBOpenDBRequest).result;
      const old = (event.target as IDBOpenDBRequest).transaction;

      // Preserve all existing stores
      const existing = ['drafts', 'assets', 'pending_ops', 'lead_queue'];
      existing.forEach(name => {
        if (!db.objectStoreNames.contains(name)) {
          if (name === 'drafts') {
            db.createObjectStore(name, { keyPath: 'id' });
          } else if (name === 'assets') {
            const s = db.createObjectStore(name, { keyPath: 'id' });
            s.createIndex('by_session', 'sessionId', { unique: false });
          } else if (name === 'pending_ops' || name === 'lead_queue') {
            const s = db.createObjectStore(name, { keyPath: 'id' });
            s.createIndex('by_session', 'sessionId', { unique: false });
            s.createIndex('by_created', 'createdAt', { unique: false });
          }
        }
      });

      // New store
      if (!db.objectStoreNames.contains(STORE)) {
        const s = db.createObjectStore(STORE, { keyPath: 'id' });
        s.createIndex('by_status',  'status',    { unique: false });
        s.createIndex('by_created', 'createdAt', { unique: false });
      }

      void old; // suppress unused variable warning
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

// ─── Low-level helpers ────────────────────────────────────────────────────────

async function put(record: CompletedLead): Promise<void> {
  try {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
      const tx  = db.transaction(STORE, 'readwrite');
      const req = tx.objectStore(STORE).put(record);
      req.onsuccess = () => resolve();
      req.onerror   = () => reject(req.error);
    });
  } catch { /* storage errors must not crash UI */ }
}

async function getAll(): Promise<CompletedLead[]> {
  try {
    const db = await openDB();
    return new Promise<CompletedLead[]>((resolve, reject) => {
      const tx  = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).getAll();
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

export async function loadCompletedLeads(): Promise<CompletedLead[]> {
  const records = await getAll();
  return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function getCompletedLead(id: string): Promise<CompletedLead | null> {
  return get(id);
}

export async function updateCompletedLeadStatus(
  id: string,
  status: CompletedLeadStatus,
  extra?: Partial<Pick<CompletedLead, 'syncedAt' | 'retries' | 'lastError' | 'backendSessionId' | 'failedStage' | 'lastAttemptAt' | 'failedAt' | 'isExhausted'>>,
): Promise<void> {
  const existing = await get(id);
  if (!existing) return;
  await put({ ...existing, status, updatedAt: new Date().toISOString(), ...extra });
  notify();
}

export async function deleteCompletedLead(id: string): Promise<void> {
  await remove(id);
  notify();
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
export async function deleteAllSyncedCompletedLeads(): Promise<number> {
  try {
    const all = await getAll();
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
): CompletedLead {
  const hasKey = !!(draftData.clientName?.trim() || draftData.company?.trim());
  const status: CompletedLeadStatus = hasKey ? 'local_only' : 'needs_review';
  const now = new Date().toISOString();
  return {
    id:               sessionId,
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
