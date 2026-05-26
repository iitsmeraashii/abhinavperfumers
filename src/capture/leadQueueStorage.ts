// Local lead queue — persists submitted/drafted leads to IndexedDB.
// Independent from the active capture draft. Each saved entry represents
// a capture session that the rep has finished or partially finished.
// The queue survives app restarts and works fully offline.

import { dbGetAllInStore, dbPut, dbDelete, dbGet } from './db';
import type { CaptureMethod, DraftData, LeadTemperature } from './types';

// ─── Types ────────────────────────────────────────────────────────────────────

export type QueueItemStatus =
  | 'draft'            // started but not yet submitted
  | 'pending_sync'     // submitted locally, waiting to sync
  | 'syncing'          // sync in-flight
  | 'synced'           // confirmed on backend
  | 'failed'           // sync failed, needs retry
  | 'needs_review';    // captured but missing key fields

export interface QueueItem {
  id:              string;   // stable frontend UUID
  status:          QueueItemStatus;
  captureMethod:   CaptureMethod | null;
  draftData:       DraftData;
  backendSessionId: string | null;
  eventId:         string | null;
  eventName:       string | null;
  createdAt:       string;   // ISO
  updatedAt:       string;   // ISO
  syncedAt:        string | null;
  retries:         number;
  lastError:       string | null;
}

const STORE = 'lead_queue';
const STORE_VERSION = 4;

// ─── DB upgrade helper ────────────────────────────────────────────────────────
// The base db.ts opens v3. We extend to v4 here by reopening with a higher
// version if the store doesn't exist yet. This is safe because all existing
// stores use IF-NOT-EXISTS guards in onupgradeneeded.

function openQueueDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('capture_app', STORE_VERSION);

    req.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      // Preserve existing stores
      if (!db.objectStoreNames.contains('drafts')) {
        db.createObjectStore('drafts', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('assets')) {
        const s = db.createObjectStore('assets', { keyPath: 'id' });
        s.createIndex('by_session', 'sessionId', { unique: false });
      }
      if (!db.objectStoreNames.contains('pending_ops')) {
        const s = db.createObjectStore('pending_ops', { keyPath: 'id' });
        s.createIndex('by_session', 'sessionId', { unique: false });
        s.createIndex('by_created', 'createdAt', { unique: false });
      }
      // New store for the lead queue
      if (!db.objectStoreNames.contains(STORE)) {
        const s = db.createObjectStore(STORE, { keyPath: 'id' });
        s.createIndex('by_status',  'status',    { unique: false });
        s.createIndex('by_created', 'createdAt', { unique: false });
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

async function queuePut(item: QueueItem): Promise<void> {
  try {
    const db = await openQueueDB();
    await new Promise<void>((resolve, reject) => {
      const tx  = db.transaction(STORE, 'readwrite');
      const req = tx.objectStore(STORE).put(item);
      req.onsuccess = () => resolve();
      req.onerror   = () => reject(req.error);
    });
  } catch { /* storage errors must not crash UI */ }
}

async function queueGet(id: string): Promise<QueueItem | null> {
  try {
    const db = await openQueueDB();
    return new Promise<QueueItem | null>((resolve, reject) => {
      const tx  = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(id);
      req.onsuccess = () => resolve((req.result as QueueItem | undefined) ?? null);
      req.onerror   = () => reject(req.error);
    });
  } catch { return null; }
}

async function queueGetAll(): Promise<QueueItem[]> {
  try {
    const db = await openQueueDB();
    return new Promise<QueueItem[]>((resolve, reject) => {
      const tx  = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = () => resolve((req.result as QueueItem[]) ?? []);
      req.onerror   = () => reject(req.error);
    });
  } catch { return []; }
}

async function queueDelete(id: string): Promise<void> {
  try {
    const db = await openQueueDB();
    await new Promise<void>((resolve, reject) => {
      const tx  = db.transaction(STORE, 'readwrite');
      const req = tx.objectStore(STORE).delete(id);
      req.onsuccess = () => resolve();
      req.onerror   = () => reject(req.error);
    });
  } catch { /* ignore */ }
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function saveQueueItem(item: QueueItem): Promise<void> {
  await queuePut({ ...item, updatedAt: new Date().toISOString() });
}

export async function loadQueueItems(): Promise<QueueItem[]> {
  const items = await queueGetAll();
  return items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function getQueueItem(id: string): Promise<QueueItem | null> {
  return queueGet(id);
}

export async function updateQueueItemStatus(
  id: string,
  status: QueueItemStatus,
  extra?: Partial<Pick<QueueItem, 'syncedAt' | 'retries' | 'lastError' | 'backendSessionId'>>,
): Promise<void> {
  const item = await queueGet(id);
  if (!item) return;
  await queuePut({ ...item, status, updatedAt: new Date().toISOString(), ...extra });
}

export async function deleteQueueItem(id: string): Promise<void> {
  await queueDelete(id);
}

export async function getQueueCounts(): Promise<Record<QueueItemStatus, number>> {
  const items = await queueGetAll();
  const counts: Record<QueueItemStatus, number> = {
    draft: 0, pending_sync: 0, syncing: 0,
    synced: 0, failed: 0, needs_review: 0,
  };
  for (const item of items) counts[item.status]++;
  return counts;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function buildQueueItemFromDraft(
  sessionId: string,
  captureMethod: CaptureMethod | null,
  draftData: DraftData,
  backendSessionId: string | null,
  eventId: string | null,
  eventName: string | null,
): QueueItem {
  const hasRequiredFields = !!(draftData.clientName?.trim() || draftData.company?.trim());
  const status: QueueItemStatus = hasRequiredFields ? 'pending_sync' : 'needs_review';
  return {
    id:               sessionId,
    status,
    captureMethod,
    draftData,
    backendSessionId,
    eventId,
    eventName,
    createdAt:        new Date().toISOString(),
    updatedAt:        new Date().toISOString(),
    syncedAt:         null,
    retries:          0,
    lastError:        null,
  };
}

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

// Utility re-exported from base db — avoids callers needing both imports
export { dbGetAllInStore as getRawPendingOps } from './db';
