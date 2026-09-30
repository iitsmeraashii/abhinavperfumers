// Domain-aware draft storage service.
// Sits between the raw db layer and the React hooks.
// Swap the db import to migrate to Capacitor SQLite or any other backend.

import { dbGet, dbPut, dbDelete, dbGetAllInStore } from './db';
import type { CaptureSession } from './types';
import { INITIAL_SYNC_STATE } from './types';
import { DEFAULT_CAPTURE_PROFILE } from './captureProfile';
import { isDraftEmpty } from './captureDraftEligibility';

const STORE = 'drafts';
const DRAFT_KEY = 'active_capture_draft';

// ─── Saved-draft pub/sub ─────────────────────────────────────────────────────
// Mirrors the completedLeadsStorage pattern so LeadQueuePage can react to
// saved-draft writes without polling.

type Listener = () => void;
const listeners = new Set<Listener>();
let version = 0;

export function subscribeSavedDrafts(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function getSavedDraftsVersion(): number {
  return version;
}

function notifySavedDrafts(): void {
  version++;
  listeners.forEach(l => l());
}

// Serialisable snapshot of CaptureSession — persisted to IndexedDB.
// Includes backend sync IDs so the session reconnects to its DB row on restore.
export interface PersistedDraft {
  id:                   string;
  ownerId:              string | null;
  captureMethod:        CaptureSession['captureMethod'];
  originalCaptureMethod: CaptureSession['originalCaptureMethod'];
  sessionStatus:        CaptureSession['sessionStatus'];
  captureProfile:       CaptureSession['captureProfile'];
  draftData:            CaptureSession['draftData'];
  hasUnsavedChanges:    boolean;
  createdAt:            string | null;
  updatedAt:            string | null;
  // Backend sync state persisted for session continuity across refreshes
  backendSessionId:     string | null;
  backendAssetIds:      Record<string, string>;
  backendExtractionIds: Record<string, string>;
  lastSyncedAt:         string | null;
}

function toRecord(session: CaptureSession, ownerId?: string | null): PersistedDraft {
  return {
    id:                   DRAFT_KEY,
    ownerId:              ownerId ?? null,
    captureMethod:        session.captureMethod,
    originalCaptureMethod: session.originalCaptureMethod,
    sessionStatus:        session.sessionStatus,
    captureProfile:       session.captureProfile,
    draftData:            session.draftData,
    hasUnsavedChanges:    session.hasUnsavedChanges,
    createdAt:            session.createdAt?.toISOString() ?? null,
    updatedAt:            session.updatedAt?.toISOString() ?? null,
    backendSessionId:     session.sync.backendSessionId,
    backendAssetIds:      session.sync.backendAssetIds,
    backendExtractionIds: session.sync.backendExtractionIds,
    lastSyncedAt:         session.sync.lastSyncedAt,
  };
}

function fromRecord(record: PersistedDraft): CaptureSession {
  return {
    captureMethod:         record.captureMethod,
    originalCaptureMethod: record.originalCaptureMethod ?? record.captureMethod,
    sessionStatus:         record.sessionStatus,
    // Fall back to default for drafts saved before captureProfile was introduced
    captureProfile:    record.captureProfile ?? DEFAULT_CAPTURE_PROFILE,
    draftData:         record.draftData ?? {},
    hasUnsavedChanges: record.hasUnsavedChanges ?? false,
    createdAt:         record.createdAt ? new Date(record.createdAt) : null,
    updatedAt:         record.updatedAt ? new Date(record.updatedAt) : null,
    sync: {
      ...INITIAL_SYNC_STATE,
      backendSessionId:     record.backendSessionId     ?? null,
      backendAssetIds:      record.backendAssetIds       ?? {},
      backendExtractionIds: record.backendExtractionIds  ?? {},
      lastSyncedAt:         record.lastSyncedAt          ?? null,
      // Restored sessions start as 'synced' (or 'idle' if never synced).
      // CaptureLeadPage will trigger a re-sync if online.
      status: record.backendSessionId ? 'synced' : 'idle',
    },
  };
}

function isValidDraft(record: unknown): record is PersistedDraft {
  if (!record || typeof record !== 'object') return false;
  const r = record as Partial<PersistedDraft>;
  return (
    r.id === DRAFT_KEY &&
    r.captureMethod != null &&
    r.sessionStatus != null &&
    typeof r.draftData === 'object'
  );
}

export async function saveDraft(session: CaptureSession, ownerId?: string | null): Promise<void> {
  if (session.sessionStatus === 'IDLE') return;
  if (isDraftEmpty(session.draftData)) return;
  await dbPut(STORE, toRecord(session, ownerId));
}

export async function loadDraft(ownerId?: string): Promise<CaptureSession | null> {
  const raw = await dbGet<PersistedDraft>(STORE, DRAFT_KEY);
  if (!isValidDraft(raw)) return null;
  if (ownerId && raw.ownerId !== ownerId) return null;
  try {
    return fromRecord(raw);
  } catch {
    return null;
  }
}

export async function clearDraft(ownerId?: string): Promise<boolean> {
  const raw = await dbGet<PersistedDraft>(STORE, DRAFT_KEY);
  if (!raw) return true;
  if (ownerId && raw.ownerId !== ownerId) return false;
  await dbDelete(STORE, DRAFT_KEY);
  return true;
}

// ─── Saved drafts (explicitly named, multiple) ──────────────────────────────
// Saved drafts live in the same 'drafts' IndexedDB store but use a unique
// 'saved_draft:<uuid>' key instead of DRAFT_KEY. This keeps them in the same
// store so the upgrade logic doesn't change, while remaining separate from
// the automatic recovery draft.

const SAVED_DRAFT_PREFIX = 'saved_draft:';

function toSavedRecord(session: CaptureSession, draftId: string, ownerId?: string | null): PersistedDraft {
  return {
    ...toRecord(session, ownerId),
    id: draftId,
  };
}

function isValidSavedDraft(record: unknown): record is PersistedDraft {
  if (!record || typeof record !== 'object') return false;
  const r = record as Partial<PersistedDraft>;
  return (
    typeof r.id === 'string' &&
    r.id.startsWith(SAVED_DRAFT_PREFIX) &&
    r.captureMethod != null &&
    r.sessionStatus != null &&
    typeof r.draftData === 'object'
  );
}

export async function saveSavedDraft(session: CaptureSession, ownerId?: string | null): Promise<string> {
  const draftId = `${SAVED_DRAFT_PREFIX}${crypto.randomUUID()}`;
  await dbPut(STORE, toSavedRecord(session, draftId, ownerId));
  notifySavedDrafts();
  return draftId;
}

export async function loadSavedDraft(draftId: string, ownerId?: string): Promise<CaptureSession | null> {
  const raw = await dbGet<PersistedDraft>(STORE, draftId);
  if (!isValidSavedDraft(raw)) return null;
  if (ownerId && raw.ownerId !== ownerId) return null;
  try {
    return fromRecord(raw);
  } catch {
    return null;
  }
}

export async function loadAllSavedDrafts(ownerId?: string): Promise<{ id: string; session: CaptureSession; createdAt: string | null; updatedAt: string | null }[]> {
  const all = await dbGetAllInStore<PersistedDraft>(STORE);
  return all
    .filter(r => isValidSavedDraft(r) && (!ownerId || r.ownerId === ownerId))
    .map(r => ({
      id: r.id,
      session: fromRecord(r),
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }))
    .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
}

export async function deleteSavedDraft(draftId: string, ownerId?: string): Promise<boolean> {
  const raw = await dbGet<PersistedDraft>(STORE, draftId);
  if (!raw) return true;
  if (ownerId && raw.ownerId !== ownerId) return false;
  await dbDelete(STORE, draftId);
  notifySavedDrafts();
  return true;
}
