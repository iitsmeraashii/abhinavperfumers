import { useState, useCallback, useRef } from 'react';
import type { ManualEntryFields, ManualEntryErrors } from './types';
import type { CaptureSessionActions } from './useCaptureSession';

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
  if (!fields.company.trim()) errors.company = 'Company is required';
  if (!fields.phone.trim()) errors.phone = 'Phone is required';
  return errors;
}

export interface UseManualEntryFormReturn {
  fields: ManualEntryFields;
  errors: ManualEntryErrors;
  touched: Partial<Record<keyof ManualEntryFields, boolean>>;
  toastMessage: string | null;
  handleChange: (field: keyof ManualEntryFields, value: string) => void;
  handleBlur: (field: keyof ManualEntryFields) => void;
  handleSaveDraft: () => void;
  handleReset: () => void;
  isValid: boolean;
}

export function useManualEntryForm(actions: CaptureSessionActions): UseManualEntryFormReturn {
  const [fields, setFields] = useState<ManualEntryFields>(EMPTY);
  const [touched, setTouched] = useState<Partial<Record<keyof ManualEntryFields, boolean>>>({});
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const errors = validate(fields);
  const isValid = Object.keys(errors).length === 0;

  const showToast = useCallback((msg: string) => {
    setToastMessage(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastMessage(null), 2800);
  }, []);

  const handleChange = useCallback((field: keyof ManualEntryFields, value: string) => {
    setFields(prev => {
      const next = { ...prev, [field]: value };
      // Sync relevant fields into draftData as user types
      actions.patchDraft({
        clientName: next.clientName,
        company: next.company,
        phone: next.phone,
        email: next.email,
        designation: next.designation,
        notes: next.notes,
      });
      return next;
    });
  }, [actions]);

  const handleBlur = useCallback((field: keyof ManualEntryFields) => {
    setTouched(prev => ({ ...prev, [field]: true }));
  }, []);

  const handleSaveDraft = useCallback(() => {
    // Mark all required fields as touched so errors surface
    setTouched({ clientName: true, company: true, phone: true });
    if (!isValid) {
      showToast('Please fill in the required fields');
      return;
    }
    actions.setStatus('DRAFT');
    showToast('Draft saved locally');
  }, [isValid, actions, showToast]);

  const handleReset = useCallback(() => {
    setFields(EMPTY);
    setTouched({});
    setToastMessage(null);
    if (toastTimer.current) clearTimeout(toastTimer.current);
  }, []);

  return {
    fields,
    errors,
    touched,
    toastMessage,
    handleChange,
    handleBlur,
    handleSaveDraft,
    handleReset,
    isValid,
  };
}
