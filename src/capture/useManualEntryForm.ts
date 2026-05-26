// Form interaction logic for ManualEntryForm.
// There is NO local fields state — session.draftData is the single source of truth.
// Writes go through actions.patchDraft; reads come from session.draftData passed
// into ManualEntryForm as a prop. This eliminates all hydration race conditions.

import { useState, useCallback, useRef } from 'react';
import type { ManualEntryErrors, DraftData, CaptureSession } from './types';
import type { CaptureSessionActions } from './useCaptureSession';
import { saveDraft, clearDraft } from './captureDraftStorage';

export type FormField =
  | 'clientName' | 'company' | 'phone' | 'email' | 'designation'
  | 'notes' | 'leadTemperature' | 'leadType' | 'previousRepCode'
  | 'priceRange' | 'voiceNoteTranscript';

// Relaxed validation: saveable if ANY meaningful data exists.
function validate(data: DraftData): ManualEntryErrors {
  const hasName     = !!String(data.clientName ?? '').trim();
  const hasPhone    = !!String(data.phone ?? '').trim();
  const hasCompany  = !!String(data.company ?? '').trim();
  const hasNotes    = !!String(data.notes ?? '').trim();
  const hasImage    = !!data.notesImageDataUrl || !!data.cardFrontAssetId;
  const hasQr       = !!data.rawQr;

  if (hasName || hasPhone || hasCompany || hasNotes || hasImage || hasQr) {
    return {};
  }
  return { _form: 'Add at least a name, phone, company, or note to save' };
}

export interface UseManualEntryFormReturn {
  touched:       Partial<Record<FormField, boolean>>;
  toastMessage:  string | null;
  toastIsError:  boolean;
  handleChange:  (field: FormField, value: string) => void;
  handleBlur:    (field: FormField) => void;
  handlePatchDraft: (patch: Partial<DraftData>) => void;
  handleSaveDraft: (session: CaptureSession) => Promise<boolean>;
  handleReset:   () => void;
  errorsFor:     (data: DraftData) => ManualEntryErrors;
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

  // Returns true on success so caller can do save-and-next.
  const handleSaveDraft = useCallback(async (session: CaptureSession): Promise<boolean> => {
    const errors = validate(session.draftData);
    if (Object.keys(errors).length > 0) {
      showToast(errors._form ?? 'Add some data before saving', true);
      return false;
    }
    actions.setStatus('DRAFT');
    const snapshot: CaptureSession = {
      ...session,
      sessionStatus: 'DRAFT',
      updatedAt: new Date(),
      hasUnsavedChanges: false,
    };
    await saveDraft(snapshot);
    showToast('Lead saved');
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
    errorsFor: validate,
  };
}

export { clearDraft };
