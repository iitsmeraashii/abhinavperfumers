import { useState, useCallback } from 'react';
import type { CaptureMethod, CaptureSession, DraftData, SessionStatus } from './types';

const IDLE_SESSION: CaptureSession = {
  captureMethod: null,
  sessionStatus: 'IDLE',
  createdAt: null,
  updatedAt: null,
  draftData: {},
  hasUnsavedChanges: false,
};

export interface CaptureSessionActions {
  startCapture: (method: CaptureMethod) => void;
  /** Start a new session pre-seeded with draft data in a single atomic update. */
  startCaptureWithDraft: (method: CaptureMethod, draft: Partial<DraftData>) => void;
  restoreSession: (saved: CaptureSession) => void;
  setStatus: (status: SessionStatus) => void;
  patchDraft: (patch: Partial<DraftData>) => void;
  resetSession: () => void;
}

export function useCaptureSession(): [CaptureSession, CaptureSessionActions] {
  const [session, setSession] = useState<CaptureSession>(IDLE_SESSION);

  const startCapture = useCallback((method: CaptureMethod) => {
    const now = new Date();
    setSession({
      captureMethod: method,
      sessionStatus: 'CAPTURING',
      createdAt: now,
      updatedAt: now,
      draftData: {},
      hasUnsavedChanges: false,
    });
  }, []);

  const startCaptureWithDraft = useCallback((method: CaptureMethod, draft: Partial<DraftData>) => {
    const now = new Date();
    setSession({
      captureMethod: method,
      sessionStatus: 'CAPTURING',
      createdAt: now,
      updatedAt: now,
      draftData: draft,
      hasUnsavedChanges: Object.keys(draft).length > 0,
    });
  }, []);

  const restoreSession = useCallback((saved: CaptureSession) => {
    setSession(saved);
  }, []);

  const setStatus = useCallback((status: SessionStatus) => {
    setSession(prev => ({
      ...prev,
      sessionStatus: status,
      updatedAt: new Date(),
    }));
  }, []);

  const patchDraft = useCallback((patch: Partial<DraftData>) => {
    setSession(prev => ({
      ...prev,
      draftData: { ...prev.draftData, ...patch },
      updatedAt: new Date(),
      hasUnsavedChanges: true,
    }));
  }, []);

  const resetSession = useCallback(() => {
    setSession(IDLE_SESSION);
  }, []);

  const actions: CaptureSessionActions = {
    startCapture,
    startCaptureWithDraft,
    restoreSession,
    setStatus,
    patchDraft,
    resetSession,
  };

  return [session, actions];
}
