// Form interaction logic for ManualEntryForm.
// There is NO local fields state — session.draftData is the single source of truth.
// Writes go through actions.patchDraft; reads come from session.draftData passed
// into ManualEntryForm as a prop. This eliminates all hydration race conditions.
//
// Validation is NOT performed here. The Capture Processing Engine's Validation Stage
// (captureValidationEngine.ts) is the single source of truth for promotion eligibility.
// handleSaveDraft saves the draft unconditionally — validation happens at promotion time.

import { useState, useCallback, useRef } from 'react';
import type { DraftData, CaptureSession } from './types';
import type { CaptureSessionActions } from './useCaptureSession';
import { saveDraft, clearDraft } from './captureDraftStorage';

export type FormField =
  | 'clientName' | 'company' | 'phone' | 'email' | 'designation'
  | 'notes' | 'leadTemperature' | 'leadType' | 'previousRepCode'
  | 'priceRange' | 'voiceNoteTranscript' | 'website' | 'address';

export interface UseManualEntryFormReturn {
  touched:          Partial<Record<FormField, boolean>>;
  toastMessage:     string | null;
  toastIsError:     boolean;
  handleChange:     (field: FormField, value: string) => void;
  handleBlur:       (field: FormField) => void;
  handlePatchDraft: (patch: Partial<DraftData>) => void;
  handleSaveDraft:  (session: CaptureSession) => Promise<boolean>;
  handleReset:      () => void;
}

export function useManualEntryForm(actions: CaptureSessionActions): UseManualEntryFormReturn {
  const [touched, setTouched]           = useState<Partial<Record<FormField, boolean>>>({});
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [toastIsError, setToastIsError] = useState(false);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = useCallback((msg: string, isError = false) => {
    setToastMessage(msg);
    setToastIsError(isError);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastMessage(null), 2800);
  }, []);

  const handleChange = useCallback((field: FormField, value: string) => {
    actions.patchDraft({ [field]: value });
  }, [actions]);

  const handlePatchDraft = useCallback((patch: Partial<DraftData>) => {
    actions.patchDraft(patch);
  }, [actions]);

  const handleBlur = useCallback((field: FormField) => {
    setTouched(prev => ({ ...prev, [field]: true }));
  }, []);

  // Saves draft state unconditionally. Returns true always so callers can chain.
  // Validation is the engine's responsibility — not this form's.
  const handleSaveDraft = useCallback(async (session: CaptureSession): Promise<boolean> => {
    actions.setStatus('DRAFT');
    const snapshot: CaptureSession = {
      ...session,
      sessionStatus: 'DRAFT',
      updatedAt: new Date(),
      hasUnsavedChanges: false,
    };
    await saveDraft(snapshot);
    showToast('Draft saved');
    return true;
  }, [actions, showToast]);

  const handleReset = useCallback(() => {
    setTouched({});
    setToastMessage(null);
    if (toastTimer.current) clearTimeout(toastTimer.current);
  }, []);

  return {
    touched,
    toastMessage,
    toastIsError,
    handleChange,
    handleBlur,
    handlePatchDraft,
    handleSaveDraft,
    handleReset,
  };
}

export { clearDraft };
