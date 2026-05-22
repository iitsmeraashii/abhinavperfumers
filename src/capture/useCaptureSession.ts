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

  const actions: CaptureSessionActions = { startCapture, setStatus, patchDraft, resetSession };
  return [session, actions];
}
