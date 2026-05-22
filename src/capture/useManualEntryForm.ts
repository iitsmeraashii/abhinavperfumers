import { useState, useCallback, useRef } from 'react';
import type { ManualEntryFields, ManualEntryErrors } from './types';
import type { CaptureSessionActions } from './useCaptureSession';
import { saveDraft, clearDraft } from './captureDraftStorage';
import type { CaptureSession } from './types';

const EMPTY: ManualEntryFields = {
  clientName: '',
  company: '',
  phone: '',
  email: '',
  designation: '',
  notes: '',
};

function validate(fields: ManualEntryFields): ManualEntryErrors {
  const errors: ManualEntryErrors = {};
  if (!fields.clientName.trim()) errors.clientName = 'Name is required';
  if (!fields.company.trim())    errors.company    = 'Company is required';
  if (!fields.phone.trim())      errors.phone      = 'Phone is required';
  return errors;
}

export interface UseManualEntryFormReturn {
  fields: ManualEntryFields;
  errors: ManualEntryErrors;
  touched: Partial<Record<keyof ManualEntryFields, boolean>>;
  toastMessage: string | null;
  toastIsError: boolean;
  handleChange: (field: keyof ManualEntryFields, value: string) => void;
  handleBlur: (field: keyof ManualEntryFields) => void;
  handleSaveDraft: (session: CaptureSession) => Promise<void>;
  handleReset: () => void;
  hydrateFields: (values: Partial<ManualEntryFields>) => void;
  isValid: boolean;
}

export function useManualEntryForm(actions: CaptureSessionActions): UseManualEntryFormReturn {
  const [fields, setFields] = useState<ManualEntryFields>(EMPTY);
  const [touched, setTouched] = useState<Partial<Record<keyof ManualEntryFields, boolean>>>({});
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [toastIsError, setToastIsError] = useState(false);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const errors = validate(fields);
  const isValid = Object.keys(errors).length === 0;

  const showToast = useCallback((msg: string, isError = false) => {
    setToastMessage(msg);
    setToastIsError(isError);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastMessage(null), 2800);
  }, []);

  const handleChange = useCallback((field: keyof ManualEntryFields, value: string) => {
    setFields(prev => {
      const next = { ...prev, [field]: value };
      actions.patchDraft({
        clientName:  next.clientName,
        company:     next.company,
        phone:       next.phone,
        email:       next.email,
        designation: next.designation,
        notes:       next.notes,
      });
      return next;
    });
  }, [actions]);

  const handleBlur = useCallback((field: keyof ManualEntryFields) => {
    setTouched(prev => ({ ...prev, [field]: true }));
  }, []);

  // Save Draft: validate → set DRAFT status → persist to IDB
  const handleSaveDraft = useCallback(async (session: CaptureSession) => {
    setTouched({ clientName: true, company: true, phone: true });
    if (!isValid) {
      showToast('Please fill in the required fields', true);
      return;
    }
    actions.setStatus('DRAFT');
    // Build the snapshot with DRAFT status for immediate persistence
    const snapshot: CaptureSession = {
      ...session,
      sessionStatus: 'DRAFT',
      updatedAt: new Date(),
      hasUnsavedChanges: false,
    };
    await saveDraft(snapshot);
    showToast('Draft saved offline');
  }, [isValid, actions, showToast]);

  const handleReset = useCallback(() => {
    setFields(EMPTY);
    setTouched({});
    setToastMessage(null);
    if (toastTimer.current) clearTimeout(toastTimer.current);
  }, []);

  // Hydrate form fields from a restored draft (without triggering patchDraft)
  const hydrateFields = useCallback((values: Partial<ManualEntryFields>) => {
    setFields(prev => ({ ...prev, ...values }));
  }, []);

  return {
    fields,
    errors,
    touched,
    toastMessage,
    toastIsError,
    handleChange,
    handleBlur,
    handleSaveDraft,
    handleReset,
    hydrateFields,
    isValid,
  };
}

// Re-export clearDraft so callers don't need to import captureDraftStorage directly
export { clearDraft };
