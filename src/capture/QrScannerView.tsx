// QR scanner UI — self-contained view rendered inside CaptureLeadPage.
// Owns no state beyond what useQrScanner exposes; all field hydration
// is delegated upward via the onScanned callback.

import { useEffect, useId, useRef } from 'react';
import { QrCode, X, Camera, RefreshCw, AlertCircle, CheckCircle2, Loader2 } from 'lucide-react';
import { useQrScanner } from './useQrScanner';
import type { ParsedContact } from './parseQrPayload';

const SCANNER_DIV_ID_PREFIX = 'qr-scanner-viewport';

interface Props {
  onScanned: (result: ParsedContact) => void;
  onCancel: () => void;
}

export function QrScannerView({ onScanned, onCancel }: Props) {
  const uid = useId().replace(/:/g, '');
  const elementId = `${SCANNER_DIV_ID_PREFIX}-${uid}`;
  const { state, error, result, startScanner, stopScanner } = useQrScanner();
  const startedRef = useRef(false);

  // Start the scanner as soon as the DOM element is ready
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    // Small delay lets React flush the DOM before html5-qrcode reads the element
    const t = setTimeout(() => startScanner(elementId), 80);
    return () => clearTimeout(t);
  }, [elementId, startScanner]);

  // When a successful scan comes through, bubble it up
  useEffect(() => {
    if (state === 'success' && result) {
      // Tiny pause so the success state is visible before switching views
      const t = setTimeout(() => onScanned(result), 600);
      return () => clearTimeout(t);
    }
  }, [state, result, onScanned]);

  // Stop camera when component unmounts (back / cancel)
  useEffect(() => {
    return () => { stopScanner(); };
  }, [stopScanner]);

  function handleCancel() {
    stopScanner();
    onCancel();
  }

  return (
    <div className="mt-6 animate-in fade-in slide-in-from-bottom-3 duration-300">

      {/* Header row */}
      <div className="flex items-center justify-between mb-5">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-xl bg-teal-50 flex items-center justify-center">
            <QrCode className="w-4 h-4 text-teal-600" />
          </div>
          <div>
            <h2 className="text-base font-semibold text-stone-900 leading-tight">Scan QR Code</h2>
            <p className="text-xs text-stone-400 mt-0.5">Point camera at a contact QR code</p>
          </div>
        </div>
        <button
          onClick={handleCancel}
          aria-label="Close scanner"
          className="w-8 h-8 rounded-full bg-stone-100 hover:bg-stone-200 active:bg-stone-300 flex items-center justify-center transition-colors"
        >
          <X className="w-4 h-4 text-stone-600" />
        </button>
      </div>

      {/* Scanner card */}
      <div className="bg-stone-950 rounded-2xl overflow-hidden relative">

        {/* The html5-qrcode library mounts its <video> element inside this div.
            We keep it in the DOM at all times so the library always has a target.
            Overlay states are stacked on top via absolute positioning. */}
        <div
          id={elementId}
          className="w-full aspect-square"
          style={{ minHeight: 260 }}
        />

        {/* ── Requesting permission overlay ── */}
        {state === 'requesting' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-stone-950 text-white">
            <Loader2 className="w-8 h-8 text-teal-400 animate-spin" />
            <p className="text-sm font-medium text-stone-300">Starting camera…</p>
            <p className="text-xs text-stone-500 text-center px-8">
              Allow camera access when prompted
            </p>
          </div>
        )}

        {/* ── Success overlay ── */}
        {state === 'success' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-stone-950/90">
            <div className="w-16 h-16 rounded-full bg-teal-500/20 flex items-center justify-center animate-in zoom-in-50 duration-200">
              <CheckCircle2 className="w-8 h-8 text-teal-400" />
            </div>
            <p className="text-sm font-semibold text-white">Contact details extracted</p>
            {result && !result.hasData && (
              <p className="text-xs text-stone-400 text-center px-8">
                QR scanned — no contact fields found
              </p>
            )}
          </div>
        )}

        {/* ── Error overlay ── */}
        {state === 'error' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-stone-950 px-6 text-center">
            <div className="w-14 h-14 rounded-full bg-red-500/15 flex items-center justify-center">
              <AlertCircle className="w-7 h-7 text-red-400" />
            </div>
            <div>
              <p className="text-sm font-semibold text-white mb-1">Camera unavailable</p>
              <p className="text-xs text-stone-400 leading-relaxed">{error}</p>
            </div>
            <button
              onClick={() => startScanner(elementId)}
              className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-stone-800 hover:bg-stone-700 text-white text-sm font-medium transition-colors"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              Try again
            </button>
          </div>
        )}

        {/* ── Scanning corner guides (decorative, shown while active) ── */}
        {state === 'scanning' && (
          <div className="absolute inset-0 pointer-events-none flex items-center justify-center">
            <div className="relative w-52 h-52">
              {/* Top-left */}
              <span className="absolute top-0 left-0 w-7 h-7 border-t-2 border-l-2 border-teal-400 rounded-tl-md" />
              {/* Top-right */}
              <span className="absolute top-0 right-0 w-7 h-7 border-t-2 border-r-2 border-teal-400 rounded-tr-md" />
              {/* Bottom-left */}
              <span className="absolute bottom-0 left-0 w-7 h-7 border-b-2 border-l-2 border-teal-400 rounded-bl-md" />
              {/* Bottom-right */}
              <span className="absolute bottom-0 right-0 w-7 h-7 border-b-2 border-r-2 border-teal-400 rounded-br-md" />
            </div>
          </div>
        )}
      </div>

      {/* Hint text below camera */}
      {state === 'scanning' && (
        <div className="mt-3 flex items-center justify-center gap-2 text-xs text-stone-400">
          <Camera className="w-3.5 h-3.5" />
          <span>Align the QR code within the frame</span>
        </div>
      )}

      {/* Cancel button */}
      <button
        onClick={handleCancel}
        className="mt-4 w-full py-3.5 rounded-xl border border-stone-200 text-sm font-medium text-stone-600 hover:bg-stone-50 active:bg-stone-100 transition-colors"
      >
        Cancel
      </button>
    </div>
  );
}
