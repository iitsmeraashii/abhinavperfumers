// QR scanner view — full-height focused UI, camera-first.
// html5-qrcode mounts its <video> element inside the #qr-region div.
// Global CSS in index.css strips all library-injected chrome.

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { X, RefreshCw, AlertCircle, CheckCircle2, Loader2, QrCode, Link, FileText, Zap, CreditCard as Edit3 } from 'lucide-react';
import { useQrScanner } from './useQrScanner';
import type { ParsedContact, QrContentType } from './parseQrPayload';

interface Props {
  onScanned: (result: ParsedContact) => void;
  onCancel:  () => void;
  onManualEntry?: () => void;
}

// ── Success helpers ────────────────────────────────────────────────────────────

function getSuccessLabel(result: ParsedContact): string {
  if (result.hasData) return 'Contact details found';
  switch (result.qrType as QrContentType) {
    case 'url':       return 'Website link captured';
    case 'plaintext': return 'Text captured';
    default:          return 'QR scanned';
  }
}

function getSuccessSubtext(result: ParsedContact): string | null {
  if (result.extractionStrategy === 'heuristic' && result.hasData) {
    return 'Some details were inferred — please review.';
  }
  if (result.hasData) return null;
  switch (result.qrType as QrContentType) {
    case 'url':       return 'Website link saved.';
    case 'plaintext': return 'Raw text saved.';
    default:          return 'You can add details manually.';
  }
}

function SuccessIcon({ qrType, hasData }: { qrType: QrContentType; hasData: boolean }) {
  if (hasData)          return <CheckCircle2 className="w-10 h-10 text-teal-400" />;
  if (qrType === 'url') return <Link className="w-10 h-10 text-sky-400" />;
  return <FileText className="w-10 h-10 text-stone-300" />;
}

// ── Scan guide — single clean frame, no nested boxes ──────────────────────────

function ScanGuide({ scanning }: { scanning: boolean }) {
  if (!scanning) return null;
  return (
    <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-10">
      {/* Dim the area outside the frame using a clip-path vignette */}
      <div className="absolute inset-0 bg-black/50"
        style={{ maskImage: 'radial-gradient(220px 220px at 50% 50%, transparent 99%, black 100%)' }} />

      {/* Clean 220×220 frame — just corner accents */}
      <div className="relative w-[220px] h-[220px]">
        {/* Animated scan line */}
        <div className="absolute inset-x-3 top-3 h-0.5 bg-teal-400/70 rounded-full animate-scan-line" />

        {/* Corner brackets */}
        <span className="absolute top-0 left-0 w-7 h-7 border-t-[3px] border-l-[3px] border-teal-400 rounded-tl-xl" />
        <span className="absolute top-0 right-0 w-7 h-7 border-t-[3px] border-r-[3px] border-teal-400 rounded-tr-xl" />
        <span className="absolute bottom-0 left-0 w-7 h-7 border-b-[3px] border-l-[3px] border-teal-400 rounded-bl-xl" />
        <span className="absolute bottom-0 right-0 w-7 h-7 border-b-[3px] border-r-[3px] border-teal-400 rounded-br-xl" />
      </div>
    </div>
  );
}

// ── Component ──────────────────────────────────────────────────────────────────

export function QrScannerView({ onScanned, onCancel, onManualEntry }: Props) {
  const uid        = useId().replace(/:/g, '');
  const elementId  = `qr-region-${uid}`;
  const { state, error, result, startScanner, stopScanner } = useQrScanner();
  const startedRef = useRef(false);
  // Flashlight UI state (placeholder — real API requires Capacitor plugin)
  const [flashOn, setFlashOn] = useState(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    const t = setTimeout(() => startScanner(elementId), 80);
    return () => clearTimeout(t);
  }, [elementId, startScanner]);

  // Bubble result after brief success pause
  useEffect(() => {
    if (state === 'success' && result) {
      const t = setTimeout(() => onScanned(result), 700);
      return () => clearTimeout(t);
    }
  }, [state, result, onScanned]);

  useEffect(() => { return () => { stopScanner(); }; }, [stopScanner]);

  const handleCancel = useCallback(() => { stopScanner(); onCancel(); }, [stopScanner, onCancel]);

  const handleRetry = useCallback(() => {
    startedRef.current = false;
    startScanner(elementId);
  }, [elementId, startScanner]);

  const isLoading  = state === 'requesting' || state === 'idle';
  const isScanning = state === 'scanning';
  const isSuccess  = state === 'success';
  const isError    = state === 'error';

  return (
    <div className="mt-4 flex flex-col animate-in fade-in duration-200" style={{ minHeight: 'calc(100dvh - 220px)' }}>

      {/* ── Top bar ── */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2.5">
          <div className="w-9 h-9 rounded-xl bg-teal-50 flex items-center justify-center">
            <QrCode className="w-[18px] h-[18px] text-teal-600" />
          </div>
          <div>
            <p className="text-sm font-semibold text-stone-900 leading-tight">Scan QR Code</p>
            <p className="text-xs text-stone-400">
              {isScanning ? 'Point camera at QR code' :
               isLoading  ? 'Starting camera…' :
               isError    ? 'Camera unavailable' : 'Ready'}
            </p>
          </div>
        </div>
        <button
          onClick={handleCancel}
          aria-label="Close scanner"
          className="w-10 h-10 rounded-full bg-stone-100 hover:bg-stone-200 active:bg-stone-300
            flex items-center justify-center transition-colors"
        >
          <X className="w-4 h-4 text-stone-600" />
        </button>
      </div>

      {/* ── Camera viewport ── */}
      <div className="relative flex-1 rounded-2xl overflow-hidden bg-stone-950 min-h-[300px]">

        {/* html5-qrcode mount point */}
        <div id={elementId} className="absolute inset-0 w-full h-full qr-clean-mount" />

        {/* Loading overlay */}
        {isLoading && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-stone-950 z-10">
            <Loader2 className="w-9 h-9 text-teal-400 animate-spin" />
            <div className="text-center">
              <p className="text-sm font-semibold text-stone-200">Starting camera…</p>
              <p className="text-xs text-stone-500 mt-1">Allow camera access when prompted</p>
            </div>
          </div>
        )}

        {/* Scan guide */}
        <ScanGuide scanning={isScanning} />

        {/* Hint text at bottom of viewport */}
        {isScanning && (
          <div className="absolute bottom-4 inset-x-0 flex justify-center z-10 pointer-events-none">
            <p className="text-xs text-white/60 bg-black/30 rounded-full px-4 py-1.5 backdrop-blur-sm">
              Align QR code inside the frame
            </p>
          </div>
        )}

        {/* Flashlight toggle — top right corner of viewport */}
        {isScanning && (
          <button
            onClick={() => setFlashOn(f => !f)}
            className={`absolute top-3 right-3 z-20 w-10 h-10 rounded-full flex items-center justify-center
              transition-colors ${flashOn
                ? 'bg-yellow-400 text-stone-900'
                : 'bg-white/15 text-white hover:bg-white/25'}`}
            aria-label="Toggle flashlight"
            title="Flashlight (requires Capacitor)"
          >
            <Zap className="w-4 h-4" />
          </button>
        )}

        {/* Success overlay */}
        {isSuccess && result && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-stone-950/90
            z-20 animate-in fade-in duration-150 px-8 text-center">
            <div className={`w-20 h-20 rounded-full flex items-center justify-center
              animate-in zoom-in-75 duration-200
              ${result.hasData ? 'bg-teal-500/20' : result.qrType === 'url' ? 'bg-sky-500/20' : 'bg-stone-500/20'}`}>
              <SuccessIcon qrType={result.qrType} hasData={result.hasData} />
            </div>
            <div>
              <p className="text-base font-semibold text-white mb-1">{getSuccessLabel(result)}</p>
              {getSuccessSubtext(result) && (
                <p className="text-xs text-stone-400 leading-relaxed">{getSuccessSubtext(result)}</p>
              )}
            </div>
            <div className="flex items-center gap-1.5 text-teal-400 animate-pulse">
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              <span className="text-xs font-medium">Continuing…</span>
            </div>
          </div>
        )}

        {/* Error overlay */}
        {isError && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-6
            bg-stone-950 px-8 text-center z-20">
            <div className="w-16 h-16 rounded-full bg-red-500/15 flex items-center justify-center">
              <AlertCircle className="w-8 h-8 text-red-400" />
            </div>
            <div>
              <p className="text-sm font-semibold text-white mb-2">Camera unavailable</p>
              <p className="text-xs text-stone-400 leading-relaxed">{error}</p>
            </div>
            <div className="flex flex-col gap-2 w-full max-w-xs">
              <button
                onClick={handleRetry}
                className="flex items-center justify-center gap-2 px-5 py-3.5 rounded-xl
                  bg-stone-800 hover:bg-stone-700 active:bg-stone-600
                  text-white text-sm font-semibold transition-colors"
              >
                <RefreshCw className="w-4 h-4" /> Try Again
              </button>
            </div>
          </div>
        )}
      </div>

      {/* ── Bottom actions ── */}
      <div className="mt-4 flex flex-col gap-2.5">

        {/* Manual entry fallback */}
        {(isScanning || isError) && onManualEntry && (
          <button
            onClick={() => { stopScanner(); onManualEntry(); }}
            className="w-full flex items-center justify-center gap-2 py-3.5 rounded-xl
              border border-stone-200 bg-white text-sm font-medium text-stone-600
              hover:bg-stone-50 active:bg-stone-100 active:scale-[0.98] transition-all"
          >
            <Edit3 className="w-4 h-4" /> Enter Details Manually
          </button>
        )}

        {/* Retry scan (only on scanning state, same button tap to retry) */}
        {isScanning && (
          <button
            onClick={handleRetry}
            className="w-full flex items-center justify-center gap-2 py-3 rounded-xl
              text-sm font-medium text-stone-400 hover:text-stone-600 transition-colors"
          >
            <RefreshCw className="w-3.5 h-3.5" /> Restart Scanner
          </button>
        )}

        <button
          onClick={handleCancel}
          className="w-full py-3.5 rounded-xl border border-stone-200 bg-white
            text-sm font-medium text-stone-600 hover:bg-stone-50 active:bg-stone-100
            active:scale-[0.98] transition-all"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
