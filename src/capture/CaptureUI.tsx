// Shared viewport-level UI primitives for the capture flow.
// Rendered at the document body level via React portals so they are
// never clipped by scrollable ancestors or pushed off-screen by the
// mobile keyboard / safe-area insets.

import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { CheckCircle2, AlertCircle, Trash2 } from 'lucide-react';

// ─── Toast ────────────────────────────────────────────────────────────────────
// Anchored to the bottom of the viewport, clear of the mobile nav bar and
// iOS home indicator via safe-area-inset-bottom.

interface ToastProps {
  message: string | null;
  isError?: boolean;
  // 'top' for recovery-style notices, 'bottom' for action feedback (default)
  position?: 'top' | 'bottom';
}

export function Toast({ message, isError = false, position = 'bottom' }: ToastProps) {
  if (!message) return null;

  const positionCls =
    position === 'top'
      ? // Below the status bar / notch; extra breathing room on iOS
        'top-[max(16px,env(safe-area-inset-top))] mt-12'
      : // Above mobile nav; kept well inside the bottom safe area
        'bottom-[max(80px,calc(64px+env(safe-area-inset-bottom)))]';

  return createPortal(
    <div
      role="status"
      aria-live="polite"
      className={`
        fixed left-1/2 -translate-x-1/2 z-[9999]
        ${positionCls}
        flex items-center gap-2
        max-w-[calc(100vw-32px)] w-max
        px-4 py-3 rounded-2xl shadow-xl
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
// True viewport-centred modal via portal. Focus is trapped inside so
// keyboard / screen-reader users cannot interact with background content.

interface DiscardDialogProps {
  onConfirm: () => void;
  onCancel: () => void;
}

export function DiscardDialog({ onConfirm, onCancel }: DiscardDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  // Auto-focus the safe "Cancel" button when the dialog opens
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  // Trap focus between Cancel and Discard buttons
  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') { onCancel(); return; }
    if (e.key !== 'Tab') return;
    const els = [cancelRef.current, confirmRef.current].filter(Boolean) as HTMLElement[];
    if (els.length < 2) return;
    const first = els[0];
    const last  = els[els.length - 1];
    if (e.shiftKey) {
      if (document.activeElement === first) { e.preventDefault(); last.focus(); }
    } else {
      if (document.activeElement === last)  { e.preventDefault(); first.focus(); }
    }
  }

  return createPortal(
    // Backdrop — fills the entire viewport regardless of scroll position
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="discard-dialog-title"
      aria-describedby="discard-dialog-desc"
      className="fixed inset-0 z-[9999] flex items-center justify-center p-5"
      onKeyDown={handleKeyDown}
    >
      {/* Scrim */}
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-[2px] animate-in fade-in duration-150"
        onClick={onCancel}
        aria-hidden="true"
      />

      {/* Panel */}
      <div
        className="
          relative z-10 w-full max-w-sm
          bg-white rounded-2xl shadow-2xl
          p-6
          animate-in fade-in zoom-in-95 duration-200
        "
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-start gap-3 mb-5">
          <div className="w-10 h-10 rounded-full bg-red-50 flex items-center justify-center flex-shrink-0">
            <Trash2 className="w-5 h-5 text-red-600" />
          </div>
          <div>
            <h3 id="discard-dialog-title" className="text-base font-semibold text-stone-900">
              Discard Draft?
            </h3>
            <p id="discard-dialog-desc" className="mt-1 text-sm text-stone-500 leading-relaxed">
              This will permanently remove your unsaved lead draft.
            </p>
          </div>
        </div>

        <div className="flex gap-3">
          <button
            ref={cancelRef}
            onClick={onCancel}
            className="flex-1 py-3.5 rounded-xl border border-stone-200 text-sm font-medium text-stone-700 hover:bg-stone-50 active:bg-stone-100 transition-colors"
          >
            Cancel
          </button>
          <button
            ref={confirmRef}
            onClick={onConfirm}
            className="flex-1 py-3.5 rounded-xl bg-red-600 hover:bg-red-700 active:bg-red-800 text-white text-sm font-semibold transition-colors"
          >
            Discard Draft
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
