import { useState } from 'react';
import {
  ArrowLeft, User, Building2, Phone, Mail, Briefcase, FileText,
  CheckCircle2, Wifi, WifiOff, AlertCircle, Trash2, X,
} from 'lucide-react';
import type { CaptureSession } from './types';
import type { UseManualEntryFormReturn } from './useManualEntryForm';

const STATUS_LABELS: Record<string, string> = {
  IDLE:             'Idle',
  CAPTURING:        'Capturing',
  DRAFT:            'Draft saved',
  READY_FOR_REVIEW: 'Ready for Review',
};

// ─── Discard confirmation dialog ──────────────────────────────────────────────

interface DiscardDialogProps {
  onConfirm: () => void;
  onCancel: () => void;
}

function DiscardDialog({ onConfirm, onCancel }: DiscardDialogProps) {
  return (
    <>
      <div className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center p-4" onClick={onCancel}>
        <div
          className="w-full max-w-sm bg-white rounded-2xl shadow-2xl p-6 animate-in fade-in slide-in-from-bottom-4 duration-200"
          onClick={e => e.stopPropagation()}
        >
          <div className="flex items-start gap-3 mb-5">
            <div className="w-10 h-10 rounded-full bg-red-50 flex items-center justify-center flex-shrink-0">
              <Trash2 className="w-5 h-5 text-red-600" />
            </div>
            <div>
              <h3 className="text-base font-semibold text-stone-900">Discard Draft?</h3>
              <p className="mt-1 text-sm text-stone-500 leading-relaxed">
                This will permanently delete the saved draft and clear all entered data.
              </p>
            </div>
          </div>
          <div className="flex gap-3">
            <button
              onClick={onCancel}
              className="flex-1 py-3 rounded-xl border border-stone-200 text-sm font-medium text-stone-700 hover:bg-stone-50 transition-colors"
            >
              Keep Draft
            </button>
            <button
              onClick={onConfirm}
              className="flex-1 py-3 rounded-xl bg-red-600 hover:bg-red-700 active:bg-red-800 text-white text-sm font-semibold transition-colors"
            >
              Discard
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

// ─── Reusable field wrapper ───────────────────────────────────────────────────

interface FieldProps {
  label: string;
  required?: boolean;
  error?: string;
  touched?: boolean;
  children: React.ReactNode;
}

function Field({ label, required, error, touched, children }: FieldProps) {
  const showError = touched && error;
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-sm font-medium text-stone-700 flex items-center gap-1">
        {label}
        {required && <span className="text-red-500 text-xs">*</span>}
      </label>
      {children}
      {showError && (
        <p className="flex items-center gap-1 text-xs text-red-500">
          <AlertCircle className="w-3 h-3 flex-shrink-0" />
          {error}
        </p>
      )}
    </div>
  );
}

// ─── Input shared styles ──────────────────────────────────────────────────────

function inputCls(hasError: boolean) {
  return [
    'w-full rounded-xl border px-4 py-3.5 text-base text-stone-900',
    'placeholder:text-stone-400 bg-white',
    'focus:outline-none focus:ring-2 focus:ring-offset-0',
    'transition-all duration-150',
    hasError
      ? 'border-red-300 focus:border-red-400 focus:ring-red-100'
      : 'border-stone-200 focus:border-stone-400 focus:ring-stone-100 hover:border-stone-300',
  ].join(' ');
}

// ─── Session status bar ───────────────────────────────────────────────────────

interface StatusBarProps {
  session: CaptureSession;
  isOnline: boolean;
}

function SessionStatusBar({ session, isOnline }: StatusBarProps) {
  return (
    <div className="flex items-center gap-3 flex-wrap text-[11px] text-stone-400 pt-1">
      <span className="flex items-center gap-1">
        <span className="font-medium text-stone-500">Status:</span>
        <span className={
          session.sessionStatus === 'DRAFT'     ? 'text-green-600 font-medium' :
          session.sessionStatus === 'CAPTURING' ? 'text-blue-600'              : 'text-stone-400'
        }>
          {STATUS_LABELS[session.sessionStatus] ?? session.sessionStatus}
        </span>
      </span>
      <span className="text-stone-200">·</span>
      {session.hasUnsavedChanges && session.sessionStatus !== 'DRAFT' ? (
        <span className="text-amber-600 font-medium">Unsaved changes</span>
      ) : (
        <span className="text-stone-400">
          {session.sessionStatus === 'DRAFT' ? 'Saved locally' : 'No changes yet'}
        </span>
      )}
      <span className="text-stone-200">·</span>
      <span className={`flex items-center gap-1 ${isOnline ? 'text-green-600' : 'text-amber-600'}`}>
        {isOnline ? <Wifi className="w-3 h-3" /> : <WifiOff className="w-3 h-3" />}
        {isOnline ? 'Online' : 'Offline'}
      </span>
    </div>
  );
}

// ─── Toast ────────────────────────────────────────────────────────────────────

interface ToastProps {
  message: string | null;
  isError: boolean;
}

function Toast({ message, isError }: ToastProps) {
  if (!message) return null;
  return (
    <div
      className={`fixed bottom-24 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 px-4 py-3 rounded-2xl shadow-lg text-sm font-medium whitespace-nowrap animate-in
        ${isError ? 'bg-red-50 text-red-700 border border-red-200' : 'bg-stone-900 text-white'}`}
      style={{ marginBottom: 'env(safe-area-inset-bottom)' }}
    >
      {isError
        ? <AlertCircle className="w-4 h-4 flex-shrink-0" />
        : <CheckCircle2 className="w-4 h-4 text-green-400 flex-shrink-0" />
      }
      {message}
    </div>
  );
}

// ─── Main form ────────────────────────────────────────────────────────────────

interface Props {
  session: CaptureSession;
  isOnline: boolean;
  form: UseManualEntryFormReturn;
  onBack: () => void;
  onDiscard: () => Promise<void>;
}

export function ManualEntryForm({ session, isOnline, form, onBack, onDiscard }: Props) {
  const { fields, errors, touched, toastMessage, toastIsError, handleChange, handleBlur, handleSaveDraft } = form;
  const [showDiscardDialog, setShowDiscardDialog] = useState(false);

  async function handleDiscardConfirm() {
    setShowDiscardDialog(false);
    await onDiscard();
  }

  const hasDraftData = !!(fields.clientName || fields.company || fields.phone);

  return (
    <div className="mt-6 animate-in fade-in slide-in-from-bottom-3 duration-300">
      {/* Back row */}
      <div className="flex items-center justify-between mb-6">
        <button
          onClick={onBack}
          className="flex items-center gap-1.5 text-sm font-medium text-stone-500 hover:text-stone-800 transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to options
        </button>
        {hasDraftData && (
          <button
            onClick={() => setShowDiscardDialog(true)}
            className="flex items-center gap-1.5 text-sm text-red-500 hover:text-red-700 transition-colors"
          >
            <Trash2 className="w-3.5 h-3.5" />
            Discard
          </button>
        )}
      </div>

      {/* Card */}
      <div className="bg-white rounded-2xl border border-stone-200 shadow-sm overflow-hidden">

        {/* Card header */}
        <div className="px-5 pt-5 pb-4 border-b border-stone-100">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-blue-50 flex items-center justify-center flex-shrink-0">
              <FileText className="w-[18px] h-[18px] text-blue-600" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-stone-900 leading-tight">Quick Manual Entry</h2>
              <p className="text-xs text-stone-500 mt-0.5">Fill in the lead details below</p>
            </div>
            {session.sessionStatus === 'DRAFT' && (
              <span className="ml-auto flex items-center gap-1 text-xs font-medium text-green-700 bg-green-50 border border-green-200 rounded-full px-2.5 py-1">
                <CheckCircle2 className="w-3 h-3" />
                Saved
              </span>
            )}
          </div>
        </div>

        {/* Fields */}
        <div className="px-5 py-5 flex flex-col gap-5">

          <Field label="Full Name" required error={errors.clientName} touched={touched.clientName}>
            <div className="relative">
              <User className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-stone-400 pointer-events-none" />
              <input
                type="text"
                placeholder="e.g. Rahul Sharma"
                autoComplete="name"
                value={fields.clientName}
                onChange={e => handleChange('clientName', e.target.value)}
                onBlur={() => handleBlur('clientName')}
                className={`${inputCls(!!(touched.clientName && errors.clientName))} pl-10`}
              />
            </div>
          </Field>

          <Field label="Company" required error={errors.company} touched={touched.company}>
            <div className="relative">
              <Building2 className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-stone-400 pointer-events-none" />
              <input
                type="text"
                placeholder="e.g. Acme Retail Pvt Ltd"
                autoComplete="organization"
                value={fields.company}
                onChange={e => handleChange('company', e.target.value)}
                onBlur={() => handleBlur('company')}
                className={`${inputCls(!!(touched.company && errors.company))} pl-10`}
              />
            </div>
          </Field>

          <Field label="Phone Number" required error={errors.phone} touched={touched.phone}>
            <div className="relative">
              <Phone className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-stone-400 pointer-events-none" />
              <input
                type="tel"
                inputMode="tel"
                placeholder="+91 98765 43210"
                autoComplete="tel"
                value={fields.phone}
                onChange={e => handleChange('phone', e.target.value)}
                onBlur={() => handleBlur('phone')}
                className={`${inputCls(!!(touched.phone && errors.phone))} pl-10`}
              />
            </div>
          </Field>

          <div className="flex items-center gap-3">
            <div className="flex-1 h-px bg-stone-100" />
            <span className="text-[11px] text-stone-400 font-medium uppercase tracking-wide">Optional</span>
            <div className="flex-1 h-px bg-stone-100" />
          </div>

          <Field label="Email">
            <div className="relative">
              <Mail className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-stone-400 pointer-events-none" />
              <input
                type="email"
                inputMode="email"
                placeholder="e.g. rahul@acme.com"
                autoComplete="email"
                value={fields.email}
                onChange={e => handleChange('email', e.target.value)}
                className={`${inputCls(false)} pl-10`}
              />
            </div>
          </Field>

          <Field label="Designation">
            <div className="relative">
              <Briefcase className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-stone-400 pointer-events-none" />
              <input
                type="text"
                placeholder="e.g. Purchase Manager"
                autoComplete="organization-title"
                value={fields.designation}
                onChange={e => handleChange('designation', e.target.value)}
                className={`${inputCls(false)} pl-10`}
              />
            </div>
          </Field>

          <Field label="Notes">
            <textarea
              placeholder="e.g. Met at booth 12, interested in oud range..."
              rows={3}
              value={fields.notes}
              onChange={e => handleChange('notes', e.target.value)}
              className={`${inputCls(false)} resize-none leading-relaxed`}
            />
          </Field>
        </div>

        {/* Actions */}
        <div className="px-5 pb-5 pt-2 flex flex-col gap-3">
          <button
            onClick={() => handleSaveDraft(session)}
            className="w-full flex items-center justify-center gap-2 bg-stone-900 hover:bg-stone-800 active:bg-stone-950 active:scale-[0.98] text-white font-semibold rounded-xl py-4 text-base transition-all duration-150 shadow-sm"
          >
            <CheckCircle2 className="w-5 h-5" />
            Save Draft
          </button>
          <p className="text-center text-xs text-stone-400">
            {isOnline ? 'Stored locally — will sync when ready' : 'Stored locally while offline'}
          </p>
        </div>
      </div>

      {/* Session status */}
      <div className="mt-4 px-1">
        <SessionStatusBar session={session} isOnline={isOnline} />
      </div>

      {/* Toast */}
      <Toast message={toastMessage} isError={toastIsError} />

      {/* Discard confirmation */}
      {showDiscardDialog && (
        <DiscardDialog
          onConfirm={handleDiscardConfirm}
          onCancel={() => setShowDiscardDialog(false)}
        />
      )}
    </div>
  );
}
