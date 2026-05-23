// Form interaction logic for ManualEntryForm.
// There is NO local fields state — session.draftData is the single source of truth.
// Writes go through actions.patchDraft; reads come from session.draftData passed
// into ManualEntryForm as a prop. This eliminates all hydration race conditions.

import { useState, useCallback, useRef } from 'react';
import type { ManualEntryErrors, DraftData, CaptureSession } from './types';
import type { CaptureSessionActions } from './useCaptureSession';
import { saveDraft, clearDraft } from './captureDraftStorage';

export type FormField = 'clientName' | 'company' | 'phone' | 'email' | 'designation' | 'notes';

function validate(data: DraftData): ManualEntryErrors {
  const errors: ManualEntryErrors = {};
  if (!String(data.clientName ?? '').trim()) errors.clientName = 'Name is required';
  if (!String(data.company    ?? '').trim()) errors.company    = 'Company is required';
  if (!String(data.phone      ?? '').trim()) errors.phone      = 'Phone is required';
  return errors;
}

export interface UseManualEntryFormReturn {
  touched: Partial<Record<FormField, boolean>>;
  toastMessage: string | null;
  toastIsError: boolean;
  handleChange: (field: FormField, value: string) => void;
  handleBlur: (field: FormField) => void;
  handleSaveDraft: (session: CaptureSession) => Promise<void>;
  handleReset: () => void;
  errorsFor: (data: DraftData) => ManualEntryErrors;
}

export function useManualEntryForm(actions: CaptureSessionActions): UseManualEntryFormReturn {
  const [touched, setTouched] = useState<Partial<Record<FormField, boolean>>>({});
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

  const handleBlur = useCallback((field: FormField) => {
    setTouched(prev => ({ ...prev, [field]: true }));
  }, []);

  const handleSaveDraft = useCallback(async (session: CaptureSession) => {
    setTouched({ clientName: true, company: true, phone: true });
    const errors = validate(session.draftData);
    if (Object.keys(errors).length > 0) {
      showToast('Please fill in the required fields', true);
      return;
    }
    actions.setStatus('DRAFT');
    const snapshot: CaptureSession = {
      ...session,
      sessionStatus: 'DRAFT',
      updatedAt: new Date(),
      hasUnsavedChanges: false,
    };
    await saveDraft(snapshot);
    showToast('Draft saved offline');
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
    handleSaveDraft,
    handleReset,
    errorsFor: validate,
  };
}

export { clearDraft };
