// Shared viewport-level UI primitives for the capture flow.
// Rendered at the document body level via React portals so they are
// never clipped by scrollable ancestors or pushed off-screen by the
// mobile keyboard / safe-area insets.

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  CheckCircle2, AlertCircle, Trash2,
  Loader2, WifiOff, Clock, RotateCcw,
} from 'lucide-react';
import type { SaveState } from './useAutosave';
import type { DraftData } from './types';

// ─── Toast ────────────────────────────────────────────────────────────────────

interface ToastProps {
  message: string | null;
  isError?: boolean;
  position?: 'top' | 'bottom';
}

export function Toast({ message, isError = false, position = 'bottom' }: ToastProps) {
  if (!message) return null;

  const positionCls =
    position === 'top'
      ? 'top-[max(16px,env(safe-area-inset-top))] mt-12'
      : 'bottom-[max(80px,calc(64px+env(safe-area-inset-bottom)))]';

  return createPortal(
    <div
      role="status"
      aria-live="polite"
      className={`
        fixed z-[9999] left-4 right-4 mx-auto max-w-sm ${positionCls}
        flex items-center gap-2 px-4 py-3 rounded-2xl shadow-xl
        text-sm font-medium
        animate-in fade-in slide-in-from-bottom-2 duration-200
        ${isError
          ? 'bg-red-50 text-red-700 border border-red-200'
          : 'bg-stone-900 text-white'}
      `}
    >
      {isError
        ? <AlertCircle className="w-4 h-4 flex-shrink-0" />
        : <CheckCircle2 className="w-4 h-4 text-green-400 flex-shrink-0" />}
      <span className="leading-snug">{message}</span>
    </div>,
    document.body,
  );
}

// ─── Discard confirmation dialog ──────────────────────────────────────────────

interface DiscardDialogProps {
  onConfirm: () => void;
  onCancel:  () => void;
}

export function DiscardDialog({ onConfirm, onCancel }: DiscardDialogProps) {
  const cancelRef  = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => { cancelRef.current?.focus(); }, []);

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') { onCancel(); return; }
    if (e.key !== 'Tab') return;
    const els = [cancelRef.current, confirmRef.current].filter(Boolean) as HTMLElement[];
    if (els.length < 2) return;
    const first = els[0]; const last = els[els.length - 1];
    if (e.shiftKey) {
      if (document.activeElement === first) { e.preventDefault(); last.focus(); }
    } else {
      if (document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  }

  return createPortal(
    <div
      role="dialog" aria-modal="true"
      aria-labelledby="discard-dialog-title"
      aria-describedby="discard-dialog-desc"
      className="fixed inset-0 z-[9999] flex items-center justify-center p-5"
      onKeyDown={handleKeyDown}
    >
      <div className="absolute inset-0 bg-black/50 backdrop-blur-[2px] animate-in fade-in duration-150" onClick={onCancel} aria-hidden="true" />
      <div
        className="relative z-10 w-full max-w-sm bg-white rounded-2xl shadow-2xl p-6 animate-in fade-in zoom-in-95 duration-200"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-start gap-3 mb-5">
          <div className="w-10 h-10 rounded-full bg-red-50 flex items-center justify-center flex-shrink-0">
            <Trash2 className="w-5 h-5 text-red-600" />
          </div>
          <div>
            <h3 id="discard-dialog-title" className="text-base font-semibold text-stone-900">Discard Draft?</h3>
            <p id="discard-dialog-desc" className="mt-1 text-sm text-stone-500 leading-relaxed">
              This will permanently remove your unsaved lead draft.
            </p>
          </div>
        </div>
        <div className="flex gap-3">
          <button ref={cancelRef} onClick={onCancel}
            className="flex-1 py-3.5 rounded-xl border border-stone-200 text-sm font-medium text-stone-700 hover:bg-stone-50 active:bg-stone-100 transition-colors">
            Cancel
          </button>
          <button ref={confirmRef} onClick={onConfirm}
            className="flex-1 py-3.5 rounded-xl bg-red-600 hover:bg-red-700 active:bg-red-800 text-white text-sm font-semibold transition-colors">
            Discard Draft
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ─── DraftSaveIndicator ───────────────────────────────────────────────────────
// Subtle inline status pill shown inside the form header area.
// States: idle (hidden) | unsaved | saving | saved | offline_saved

interface DraftSaveIndicatorProps {
  state: SaveState;
}

export function DraftSaveIndicator({ state }: DraftSaveIndicatorProps) {
  // Fade out "saved" after 2.5s
  const [visible, setVisible] = useState(true);
  const fadeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (fadeTimer.current) clearTimeout(fadeTimer.current);

    if (state === 'saved') {
      setVisible(true);
      fadeTimer.current = setTimeout(() => setVisible(false), 2500);
    } else {
      setVisible(state !== 'idle');
    }

    return () => { if (fadeTimer.current) clearTimeout(fadeTimer.current); };
  }, [state]);

  if (state === 'idle' || !visible) return null;

  const config = {
    saving:       { icon: <Loader2 className="w-3 h-3 animate-spin" />, label: 'Saving…',       cls: 'text-stone-400' },
    saved:        { icon: <CheckCircle2 className="w-3 h-3" />,          label: 'Draft saved',   cls: 'text-green-600' },
    offline_saved:{ icon: <WifiOff className="w-3 h-3" />,               label: 'Offline draft', cls: 'text-amber-600' },
    unsaved:      { icon: <Clock className="w-3 h-3" />,                  label: 'Unsaved',       cls: 'text-stone-400' },
    idle:         { icon: null, label: '', cls: '' },
  }[state];

  return (
    <span className={`inline-flex items-center gap-1 text-[11px] font-medium transition-opacity duration-300 ${config.cls}`}>
      {config.icon}
      {config.label}
    </span>
  );
}

// ─── DraftRecoveryBanner ──────────────────────────────────────────────────────
// Full-screen modal-style banner shown when a recoverable draft is found on mount.
// Designed to be the first thing the user sees — not dismissable by tapping outside.

interface DraftRecoveryBannerProps {
  draftData:   DraftData;
  capturedAt:  Date | null;
  onContinue:  () => void;
  onDiscard:   () => void;
}

export function DraftRecoveryBanner({
  draftData, capturedAt, onContinue, onDiscard,
}: DraftRecoveryBannerProps) {
  const continueRef = useRef<HTMLButtonElement>(null);

  // Auto-focus Continue — the safe default action.
  useEffect(() => { continueRef.current?.focus(); }, []);

  // Build a compact summary of what was captured
  const name       = String(draftData.clientName ?? '').trim();
  const company    = String(draftData.company    ?? '').trim();
  const phone      = String(draftData.phone      ?? '').trim();
  const notes      = String(draftData.notes      ?? '').trim();
  const hasImage   = !!(draftData.notesImageDataUrl || draftData.cardFrontAssetId);
  const method     = draftData.cardSessionId
    ? 'Business card scan'
    : draftData.rawQr
      ? 'QR scan'
      : 'Manual entry';

  const chips: string[] = [];
  if (name)     chips.push(name);
  if (company)  chips.push(company);
  if (phone)    chips.push(phone);
  if (notes)    chips.push('Has notes');
  if (hasImage) chips.push('Has image');

  function fmt(d: Date) {
    const now = Date.now();
    const diff = now - d.getTime();
    if (diff < 60_000)  return 'just now';
    if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
    if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  }

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="recovery-title"
      className="fixed inset-0 z-[9998] flex items-end justify-center md:items-center p-4"
    >
      {/* Scrim */}
      <div className="absolute inset-0 bg-black/40 backdrop-blur-[2px] animate-in fade-in duration-200" aria-hidden="true" />

      {/* Sheet */}
      <div
        className="relative z-10 w-full max-w-sm bg-white rounded-2xl shadow-2xl overflow-hidden
          animate-in slide-in-from-bottom-4 md:slide-in-from-bottom-0 md:zoom-in-95 duration-250"
        onClick={e => e.stopPropagation()}
      >
        {/* Header strip */}
        <div className="bg-amber-50 border-b border-amber-100 px-5 py-4 flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-amber-100 flex items-center justify-center shrink-0">
            <RotateCcw className="w-5 h-5 text-amber-700" />
          </div>
          <div>
            <h3 id="recovery-title" className="text-sm font-semibold text-stone-900 leading-tight">
              Unfinished lead recovered
            </h3>
            <p className="text-xs text-stone-500 mt-0.5">
              {method}{capturedAt ? ` · ${fmt(capturedAt)}` : ''}
            </p>
          </div>
        </div>

        {/* Preview chips */}
        {chips.length > 0 && (
          <div className="px-5 py-3 border-b border-stone-100 flex flex-wrap gap-1.5">
            {chips.map(chip => (
              <span key={chip} className="px-2.5 py-1 bg-stone-100 rounded-lg text-xs text-stone-700 font-medium">
                {chip}
              </span>
            ))}
          </div>
        )}

        {chips.length === 0 && (
          <div className="px-5 py-3 border-b border-stone-100">
            <p className="text-xs text-stone-400 italic">No data captured yet</p>
          </div>
        )}

        {/* Actions */}
        <div className="p-5 flex gap-3">
          <button
            onClick={onDiscard}
            className="flex-1 py-3.5 rounded-xl border border-stone-200 text-sm font-medium
              text-stone-600 hover:bg-stone-50 active:bg-stone-100 transition-colors"
          >
            Discard
          </button>
          <button
            ref={continueRef}
            onClick={onContinue}
            className="flex-[2] py-3.5 rounded-xl bg-stone-900 hover:bg-stone-800
              active:bg-stone-950 text-white text-sm font-semibold shadow-sm
              transition-all active:scale-[0.98]"
          >
            Continue Draft
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
