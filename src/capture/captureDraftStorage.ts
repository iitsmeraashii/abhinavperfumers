// Domain-aware draft storage service.
// Sits between the raw db layer and the React hooks.
// Swap the db import to migrate to Capacitor SQLite or any other backend.

import { dbGet, dbPut, dbDelete } from './db';
import type { CaptureSession } from './types';
import { INITIAL_SYNC_STATE } from './types';
import { DEFAULT_CAPTURE_PROFILE } from './captureProfile';

const STORE = 'drafts';
const DRAFT_KEY = 'active_capture_draft';

// Serialisable snapshot of CaptureSession — persisted to IndexedDB.
// Includes backend sync IDs so the session reconnects to its DB row on restore.
export interface PersistedDraft {
  id:                   string;
  captureMethod:        CaptureSession['captureMethod'];
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

function toRecord(session: CaptureSession): PersistedDraft {
  return {
    id:                   DRAFT_KEY,
    captureMethod:        session.captureMethod,
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
    captureMethod:     record.captureMethod,
    sessionStatus:     record.sessionStatus,
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

export async function saveDraft(session: CaptureSession): Promise<void> {
  if (session.sessionStatus === 'IDLE') return;
  await dbPut(STORE, toRecord(session));
}

export async function loadDraft(): Promise<CaptureSession | null> {
  const raw = await dbGet<PersistedDraft>(STORE, DRAFT_KEY);
  if (!isValidDraft(raw)) return null;
  try {
    return fromRecord(raw);
  } catch {
    return null;
  }
}

export async function clearDraft(): Promise<void> {
  await dbDelete(STORE, DRAFT_KEY);
}
