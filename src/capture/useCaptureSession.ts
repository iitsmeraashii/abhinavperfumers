import { useState, useCallback, useRef } from 'react';
import type {
  BackendSyncState,
  CaptureMethod,
  CaptureProfile,
  CaptureSession,
  DraftData,
  SessionStatus,
  SyncStatus,
} from './types';
import { INITIAL_SYNC_STATE } from './types';
import { DEFAULT_CAPTURE_PROFILE } from './captureProfile';

// ─── Idle session ─────────────────────────────────────────────────────────────

const IDLE_SESSION: CaptureSession = {
  captureMethod:         null,
  originalCaptureMethod: null,
  sessionStatus:         'IDLE',
  captureProfile:    DEFAULT_CAPTURE_PROFILE,
  createdAt:         null,
  updatedAt:         null,
  draftData:         {},
  hasUnsavedChanges: false,
  sync:              INITIAL_SYNC_STATE,
};

// ─── Actions interface ────────────────────────────────────────────────────────

export interface CaptureSessionActions {
  /** Starts a new session, generates a stable backend session ID, returns it. */
  startCapture:          (method: CaptureMethod) => string;
  /** Start a new session pre-seeded with draft data in a single atomic update. */
  startCaptureWithDraft: (method: CaptureMethod, draft: Partial<DraftData>) => void;
  restoreSession:        (saved: CaptureSession) => void;
  setStatus:             (status: SessionStatus) => void;
  patchDraft:            (patch: Partial<DraftData>) => void;
  resetSession:          () => void;
  /** Switch the active Capture Profile. Has no effect on the current session state. */
  setCaptureProfile:     (profile: CaptureProfile) => void;
  // Sync state management — called by CaptureLeadPage after backend ops complete
  patchSync:             (patch: Partial<BackendSyncState>) => void;
  setSyncStatus:         (status: SyncStatus, error?: string) => void;
  incrementPendingOps:   () => void;
  decrementPendingOps:   () => void;
}

// ─── Stable ID generator ──────────────────────────────────────────────────────

function genStableId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useCaptureSession(): [CaptureSession, CaptureSessionActions] {
  const [session, setSession] = useState<CaptureSession>(IDLE_SESSION);

  // Stable ref so async callbacks can read latest session without stale closure
  const sessionRef = useRef(session);
  sessionRef.current = session;

  const startCapture = useCallback((method: CaptureMethod): string => {
    const now = new Date();
    const backendSessionId = genStableId();
    setSession(prev => ({
      captureMethod:         method,
      originalCaptureMethod: method,
      sessionStatus:         'CAPTURING',
      captureProfile:        prev.captureProfile,
      createdAt:             now,
      updatedAt:              now,
      draftData:              {},
      hasUnsavedChanges:      false,
      sync: {
        ...INITIAL_SYNC_STATE,
        backendSessionId,
        status: 'syncing',
      },
    }));
    return backendSessionId;
  }, []);

  const startCaptureWithDraft = useCallback((method: CaptureMethod, draft: Partial<DraftData>) => {
    const now = new Date();
    setSession(prev => {
      const existingBackendId = prev.sync.backendSessionId;
      // Preserve the original capture method when transitioning (e.g.
      // BUSINESS_CARD → MANUAL after card extraction). The session's
      // originalCaptureMethod is set on the first startCapture call and
      // must not change on subsequent startCaptureWithDraft calls.
      const originalMethod = prev.originalCaptureMethod ?? method;
      return {
        captureMethod:         method,
        originalCaptureMethod: originalMethod,
        sessionStatus:         'CAPTURING',
        captureProfile:    prev.captureProfile,
        createdAt:         prev.createdAt ?? now,
        updatedAt:         now,
        draftData:         draft,
        hasUnsavedChanges: Object.keys(draft).length > 0,
        sync: {
          ...prev.sync,
          // Preserve existing backend session ID — transitioning method (e.g.
          // BUSINESS_CARD → MANUAL after OCR) is still the same capture session.
          backendSessionId: existingBackendId ?? genStableId(),
          status: existingBackendId ? prev.sync.status : 'syncing',
        },
      };
    });
  }, []);

  const restoreSession = useCallback((saved: CaptureSession) => {
    setSession(saved);
  }, []);

  const setStatus = useCallback((status: SessionStatus) => {
    setSession(prev => ({ ...prev, sessionStatus: status, updatedAt: new Date() }));
  }, []);

  const patchDraft = useCallback((patch: Partial<DraftData>) => {
    setSession(prev => ({
      ...prev,
      draftData:         { ...prev.draftData, ...patch },
      updatedAt:         new Date(),
      hasUnsavedChanges: true,
    }));
  }, []);

  const resetSession = useCallback(() => {
    setSession(IDLE_SESSION);
  }, []);

  const patchSync = useCallback((patch: Partial<BackendSyncState>) => {
    setSession(prev => ({
      ...prev,
      sync: {
        ...prev.sync,
        ...patch,
        // Deep-merge the ID maps rather than replacing them wholesale
        backendAssetIds: {
          ...prev.sync.backendAssetIds,
          ...(patch.backendAssetIds ?? {}),
        },
        backendExtractionIds: {
          ...prev.sync.backendExtractionIds,
          ...(patch.backendExtractionIds ?? {}),
        },
      },
    }));
  }, []);

  const setSyncStatus = useCallback((status: SyncStatus, error?: string) => {
    setSession(prev => ({
      ...prev,
      sync: { ...prev.sync, status, lastError: error ?? prev.sync.lastError },
    }));
  }, []);

  const incrementPendingOps = useCallback(() => {
    setSession(prev => ({
      ...prev,
      sync: { ...prev.sync, pendingOps: prev.sync.pendingOps + 1 },
    }));
  }, []);

  const decrementPendingOps = useCallback(() => {
    setSession(prev => ({
      ...prev,
      sync: { ...prev.sync, pendingOps: Math.max(0, prev.sync.pendingOps - 1) },
    }));
  }, []);

  const setCaptureProfile = useCallback((profile: CaptureProfile) => {
    setSession(prev => ({ ...prev, captureProfile: profile }));
  }, []);

  const actions: CaptureSessionActions = {
    startCapture,
    startCaptureWithDraft,
    restoreSession,
    setStatus,
    patchDraft,
    resetSession,
    setCaptureProfile,
    patchSync,
    setSyncStatus,
    incrementPendingOps,
    decrementPendingOps,
  };

  return [session, actions];
}
