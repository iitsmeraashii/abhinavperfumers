// QR scanner view — full-height focused UI, no scroll needed.
// The html5-qrcode library mounts its <video> element inside the #qr-region div.
// We suppress all library-injected chrome via CSS and overlay our own guides.

import { useEffect, useId, useRef } from 'react';
import { X, RefreshCw, AlertCircle, CheckCircle2, Loader2, QrCode } from 'lucide-react';
import { useQrScanner } from './useQrScanner';
import type { ParsedContact } from './parseQrPayload';

interface Props {
  onScanned: (result: ParsedContact) => void;
  onCancel: () => void;
}

export function QrScannerView({ onScanned, onCancel }: Props) {
  const uid = useId().replace(/:/g, '');
  const elementId = `qr-region-${uid}`;
  const { state, error, result, startScanner, stopScanner } = useQrScanner();
  const startedRef = useRef(false);

  // Start scanner once the DOM element is mounted
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    const t = setTimeout(() => startScanner(elementId), 80);
    return () => clearTimeout(t);
  }, [elementId, startScanner]);

  // Bubble result up with a brief success pause
  useEffect(() => {
    if (state === 'success' && result) {
      const t = setTimeout(() => onScanned(result), 700);
      return () => clearTimeout(t);
    }
  }, [state, result, onScanned]);

  // Stop camera on unmount
  useEffect(() => {
    return () => { stopScanner(); };
  }, [stopScanner]);

  function handleCancel() {
    stopScanner();
    onCancel();
  }

  const isScanning = state === 'scanning';
  const isLoading  = state === 'requesting' || state === 'idle';
  const isSuccess  = state === 'success';
  const isError    = state === 'error';

  return (
    /*
     * Full-height container — sits directly in the page column and fills
     * the remaining viewport height so no scrolling is ever needed.
     */
    <div className="mt-4 flex flex-col" style={{ minHeight: 'calc(100dvh - 240px)' }}>

      {/* ── Top bar ─────────────────────────────────────────────── */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-xl bg-teal-50 flex items-center justify-center">
            <QrCode className="w-4 h-4 text-teal-600" />
          </div>
          <div>
            <p className="text-sm font-semibold text-stone-900 leading-tight">Scan QR Code</p>
            <p className="text-xs text-stone-400">Point camera at a contact QR</p>
          </div>
        </div>
        <button
          onClick={handleCancel}
          aria-label="Close scanner"
          className="w-9 h-9 rounded-full bg-stone-100 hover:bg-stone-200 active:bg-stone-300 flex items-center justify-center transition-colors"
        >
          <X className="w-4 h-4 text-stone-600" />
        </button>
      </div>

      {/* ── Camera viewport ─────────────────────────────────────── */}
      <div className="relative flex-1 rounded-2xl overflow-hidden bg-stone-950 min-h-[280px]">

        {/*
         * html5-qrcode mounts <video> + its own region box here.
         * The global CSS in index.css strips the library's default UI
         * (border, text, buttons) so only raw video remains.
         */}
        <div
          id={elementId}
          className="absolute inset-0 w-full h-full qr-clean-mount"
        />

        {/* ── Loading overlay ── */}
        {isLoading && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-stone-950 z-10">
            <Loader2 className="w-8 h-8 text-teal-400 animate-spin" />
            <p className="text-sm font-medium text-stone-300">Starting camera…</p>
            <p className="text-xs text-stone-500 text-center px-10">
              Allow camera access when prompted
            </p>
          </div>
        )}

        {/* ── Scan guide overlay (teal corner brackets) ── */}
        {isScanning && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-10">
            <div className="relative w-56 h-56">
              {/* Dim vignette outside the frame */}
              <div className="absolute -inset-[9999px] bg-black/40" style={{ boxShadow: '0 0 0 9999px rgba(0,0,0,0.45)' }} />
              {/* Clear scan window */}
              <div className="absolute inset-0 rounded-2xl" />
              {/* Corner brackets */}
              <span className="absolute top-0 left-0 w-8 h-8 border-t-[3px] border-l-[3px] border-teal-400 rounded-tl-xl" />
              <span className="absolute top-0 right-0 w-8 h-8 border-t-[3px] border-r-[3px] border-teal-400 rounded-tr-xl" />
              <span className="absolute bottom-0 left-0 w-8 h-8 border-b-[3px] border-l-[3px] border-teal-400 rounded-bl-xl" />
              <span className="absolute bottom-0 right-0 w-8 h-8 border-b-[3px] border-r-[3px] border-teal-400 rounded-br-xl" />
            </div>
          </div>
        )}

        {/* ── Success overlay ── */}
        {isSuccess && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-stone-950/85 z-20 animate-in fade-in duration-150">
            <div className="w-16 h-16 rounded-full bg-teal-500/20 flex items-center justify-center animate-in zoom-in-75 duration-200">
              <CheckCircle2 className="w-8 h-8 text-teal-400" />
            </div>
            <p className="text-sm font-semibold text-white">
              {result?.hasData ? 'Contact details extracted' : 'QR code scanned'}
            </p>
            {result && !result.hasData && (
              <p className="text-xs text-stone-400 text-center px-10">
                No contact fields found in this QR code
              </p>
            )}
          </div>
        )}

        {/* ── Error overlay ── */}
        {isError && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-5 bg-stone-950 px-8 text-center z-20">
            <div className="w-14 h-14 rounded-full bg-red-500/15 flex items-center justify-center">
              <AlertCircle className="w-7 h-7 text-red-400" />
            </div>
            <div>
              <p className="text-sm font-semibold text-white mb-1.5">Camera unavailable</p>
              <p className="text-xs text-stone-400 leading-relaxed">{error}</p>
            </div>
            <button
              onClick={() => { startedRef.current = false; startScanner(elementId); }}
              className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-stone-800 hover:bg-stone-700 text-white text-sm font-medium transition-colors"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              Try again
            </button>
          </div>
        )}
      </div>

      {/* ── Hint + cancel ───────────────────────────────────────── */}
      <div className="mt-4 flex flex-col items-center gap-3">
        {isScanning && (
          <p className="text-xs text-stone-400 text-center">
            Align QR code within the frame
          </p>
        )}
        <button
          onClick={handleCancel}
          className="w-full py-3.5 rounded-xl border border-stone-200 bg-white text-sm font-medium text-stone-600 hover:bg-stone-50 active:bg-stone-100 transition-colors"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
