// Business card capture flow — camera, preview, retake/delete, OCR.
// Fully offline: images stored in IndexedDB, OCR via Tesseract.js.
// No cloud APIs, no AI.

import { useState, useRef, useCallback, useEffect } from 'react';
import {
  ArrowLeft, Camera, FlipHorizontal, Trash2, CheckCircle2,
  RotateCcw, ChevronRight, ImageOff, AlertCircle, Loader2,
  CreditCard, Check, Sparkles, Info,
} from 'lucide-react';
import { createPortal } from 'react-dom';
import { saveAsset, deleteAsset, getSessionAssets } from './captureAssetStorage';
import { useOcr } from './useOcr';
import type { BusinessCardAsset, CardSide, CaptureSession, OcrResult } from './types';
import { Toast } from './CaptureUI';

// ─── Types ────────────────────────────────────────────────────────────────────

interface CardState {
  asset: BusinessCardAsset | null;
  status: 'empty' | 'capturing' | 'previewing' | 'saving' | 'error';
  errorMsg?: string;
}

interface Props {
  session: CaptureSession;
  sessionId: string;
  onComplete: (frontAssetId: string, backAssetId: string | null, ocrResult: OcrResult | null) => void;
  onBack: () => void;
  onAssetsChanged?: (front: BusinessCardAsset | null, back: BusinessCardAsset | null) => void;
  onOcrResult?: (result: OcrResult) => void;
}

// ─── Full-screen camera sheet ─────────────────────────────────────────────────

interface CameraSheetProps {
  side: CardSide;
  onCapture: (dataUrl: string) => void;
  onCancel: () => void;
}

function CameraSheet({ side, onCapture, onCancel }: CameraSheetProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const t = setTimeout(() => {
      if (inputRef.current) inputRef.current.click();
      setLoading(false);
    }, 120);
    return () => clearTimeout(t);
  }, []);

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) { onCancel(); return; }
    if (!file.type.startsWith('image/')) {
      setError('Selected file is not an image. Please try again.');
      return;
    }
    const reader = new FileReader();
    reader.onload = (ev) => {
      const result = ev.target?.result;
      if (typeof result === 'string') onCapture(result);
      else setError('Could not read image. Please try again.');
    };
    reader.onerror = () => setError('Failed to read image file.');
    reader.readAsDataURL(file);
  }

  return createPortal(
    <div className="fixed inset-0 z-[9990] flex flex-col items-center justify-center bg-black">
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="sr-only"
        onChange={handleFileChange}
        onClick={(e) => { (e.target as HTMLInputElement).value = ''; }}
      />
      <div className="flex flex-col items-center gap-6 px-8 text-center">
        {loading ? (
          <Loader2 className="w-10 h-10 text-white/60 animate-spin" />
        ) : error ? (
          <>
            <div className="w-14 h-14 rounded-full bg-red-900/60 flex items-center justify-center">
              <AlertCircle className="w-7 h-7 text-red-300" />
            </div>
            <p className="text-white/80 text-sm leading-relaxed">{error}</p>
            <button
              onClick={() => { setError(null); inputRef.current?.click(); }}
              className="px-6 py-3 bg-white text-stone-900 rounded-xl font-semibold text-sm"
            >
              Try Again
            </button>
            <button onClick={onCancel} className="text-white/50 text-sm">Cancel</button>
          </>
        ) : (
          <>
            <div className="w-14 h-14 rounded-full bg-amber-500/20 flex items-center justify-center">
              <Camera className="w-7 h-7 text-amber-400" />
            </div>
            <div>
              <p className="text-white font-semibold text-lg mb-1">
                Capture {side === 'front' ? 'Front' : 'Back'} Side
              </p>
              <p className="text-white/50 text-sm">
                {side === 'front'
                  ? 'Position the front of the business card in good lighting'
                  : 'Position the back of the business card'}
              </p>
            </div>
            <button
              onClick={() => inputRef.current?.click()}
              className="w-full max-w-xs px-6 py-4 bg-amber-500 hover:bg-amber-400 text-stone-900 font-bold rounded-2xl text-base flex items-center justify-center gap-2"
            >
              <Camera className="w-5 h-5" />
              Open Camera
            </button>
            <button onClick={onCancel} className="text-white/50 text-sm mt-1">Cancel</button>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}

// ─── OCR progress banner ──────────────────────────────────────────────────────

interface OcrBannerProps {
  status: 'processing' | 'done' | 'error';
  progress: number;
  progressLabel: string;
  result: OcrResult | null;
  error: string | null;
  onDismiss: () => void;
}

function OcrBanner({ status, progress, progressLabel, result, error, onDismiss }: OcrBannerProps) {
  if (status === 'processing') {
    return (
      <div className="rounded-2xl bg-amber-50 border border-amber-200 px-4 py-3.5 flex items-center gap-3">
        <div className="flex-shrink-0 w-8 h-8 rounded-full bg-amber-100 flex items-center justify-center">
          <Loader2 className="w-4 h-4 text-amber-600 animate-spin" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-amber-900">Extracting card details…</p>
          <div className="mt-1.5 h-1.5 bg-amber-200 rounded-full overflow-hidden">
            <div
              className="h-full bg-amber-500 rounded-full transition-all duration-300 ease-out"
              style={{ width: `${Math.round(progress * 100)}%` }}
            />
          </div>
          <p className="mt-1 text-[11px] text-amber-700">{progressLabel}</p>
        </div>
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div className="rounded-2xl bg-red-50 border border-red-200 px-4 py-3.5 flex items-start gap-3">
        <AlertCircle className="w-5 h-5 text-red-500 flex-shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-red-800">OCR extraction failed</p>
          <p className="text-xs text-red-600 mt-0.5 leading-relaxed">{error ?? 'Could not read card text. You can still fill in details manually.'}</p>
        </div>
        <button onClick={onDismiss} className="text-red-400 hover:text-red-600 flex-shrink-0 text-xs font-medium">Dismiss</button>
      </div>
    );
  }

  if (status === 'done' && result) {
    const fieldCount = result.inferredFields.length;
    const isLow = result.confidence === 'low';

    return (
      <div className={[
        'rounded-2xl border px-4 py-3.5',
        isLow ? 'bg-stone-50 border-stone-200' : 'bg-green-50 border-green-200',
      ].join(' ')}>
        <div className="flex items-start gap-3">
          <div className={[
            'flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center',
            isLow ? 'bg-stone-100' : 'bg-green-100',
          ].join(' ')}>
            <Sparkles className={`w-4 h-4 ${isLow ? 'text-stone-500' : 'text-green-600'}`} />
          </div>
          <div className="flex-1 min-w-0">
            <p className={`text-sm font-semibold ${isLow ? 'text-stone-700' : 'text-green-800'}`}>
              {fieldCount > 0
                ? `${fieldCount} field${fieldCount > 1 ? 's' : ''} extracted`
                : 'Text extracted — no fields inferred'}
            </p>
            {fieldCount > 0 && (
              <p className={`text-xs mt-0.5 ${isLow ? 'text-stone-500' : 'text-green-700'}`}>
                {result.inferredFields.map(f =>
                  f === 'clientName' ? 'Name' :
                  f === 'company'    ? 'Company' :
                  f === 'phone'      ? 'Phone' :
                  f === 'email'      ? 'Email' :
                  f === 'designation'? 'Designation' : f
                ).join(' · ')}
              </p>
            )}
            {isLow && (
              <p className="flex items-center gap-1 mt-1.5 text-[11px] text-stone-500">
                <Info className="w-3 h-3 flex-shrink-0" />
                Please review extracted details before saving.
              </p>
            )}
          </div>
        </div>
      </div>
    );
  }

  return null;
}

// ─── Image preview card ───────────────────────────────────────────────────────

interface PreviewCardProps {
  side: CardSide;
  asset: BusinessCardAsset | null;
  status: CardState['status'];
  errorMsg?: string;
  isOcrRunning?: boolean;
  onCapture: () => void;
  onRetake: () => void;
  onDelete: () => void;
  disabled?: boolean;
}

function PreviewCard({
  side, asset, status, errorMsg, isOcrRunning,
  onCapture, onRetake, onDelete, disabled,
}: PreviewCardProps) {
  const label = side === 'front' ? 'Front Side' : 'Back Side';
  const hasImage = !!asset;
  const isSaving = status === 'saving';
  const isError  = status === 'error';

  return (
    <div className={[
      'rounded-2xl border overflow-hidden transition-all duration-200',
      hasImage ? 'border-stone-200 shadow-sm' : 'border-dashed border-stone-300 bg-stone-50/50',
    ].join(' ')}>
      <div className="flex items-center gap-2 px-4 pt-3.5 pb-2">
        <div className={[
          'w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0',
          hasImage ? 'bg-green-100 text-green-700' : 'bg-stone-200 text-stone-500',
        ].join(' ')}>
          {hasImage ? <Check className="w-3.5 h-3.5" /> : (side === 'front' ? '1' : '2')}
        </div>
        <span className="text-sm font-semibold text-stone-700">{label}</span>
        {side === 'back' && !hasImage && (
          <span className="ml-auto text-[11px] text-stone-400 font-medium">Optional</span>
        )}
        {hasImage && (
          <span className="ml-auto text-[11px] text-green-600 font-medium flex items-center gap-1">
            <CheckCircle2 className="w-3 h-3" /> Captured
          </span>
        )}
      </div>

      {hasImage ? (
        <div className="relative mx-4 mb-3">
          <img
            src={asset.dataUrl}
            alt={`Business card ${side}`}
            className="w-full rounded-xl object-cover"
            style={{ aspectRatio: '1.75 / 1', objectFit: 'cover' }}
          />
          {isOcrRunning && (
            <div className="absolute inset-0 rounded-xl bg-amber-500/15 flex items-center justify-center">
              <div className="flex items-center gap-2 bg-white/90 rounded-full px-3 py-1.5 shadow-sm">
                <Loader2 className="w-3.5 h-3.5 text-amber-600 animate-spin" />
                <span className="text-xs font-semibold text-amber-700">Reading…</span>
              </div>
            </div>
          )}
          <span className="absolute bottom-2 right-2 text-[10px] bg-black/50 text-white px-1.5 py-0.5 rounded-md font-mono">
            {Math.round(asset.sizeBytes / 1024)}KB · {asset.storedWidth}×{asset.storedHeight}
          </span>
        </div>
      ) : (
        <div className="mx-4 mb-3 rounded-xl bg-stone-100 flex items-center justify-center"
          style={{ aspectRatio: '1.75 / 1' }}>
          {isError ? (
            <div className="flex flex-col items-center gap-2 px-4 text-center">
              <ImageOff className="w-7 h-7 text-red-400" />
              <p className="text-xs text-red-500">{errorMsg ?? 'Capture failed'}</p>
            </div>
          ) : isSaving ? (
            <Loader2 className="w-7 h-7 text-stone-400 animate-spin" />
          ) : (
            <div className="flex flex-col items-center gap-2 text-stone-400">
              <CreditCard className="w-8 h-8 opacity-40" />
              <span className="text-xs">No image</span>
            </div>
          )}
        </div>
      )}

      <div className="px-4 pb-4 flex gap-2">
        {hasImage ? (
          <>
            <button
              onClick={onRetake}
              disabled={disabled || isOcrRunning}
              className="flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl border border-stone-200 text-sm font-medium text-stone-600 hover:bg-stone-50 active:bg-stone-100 transition-colors disabled:opacity-40"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              Retake
            </button>
            <button
              onClick={onDelete}
              disabled={disabled || isOcrRunning}
              className="flex items-center justify-center gap-1.5 px-3.5 py-2.5 rounded-xl border border-red-100 text-red-500 hover:bg-red-50 active:bg-red-100 transition-colors disabled:opacity-40"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </>
        ) : (
          <button
            onClick={onCapture}
            disabled={disabled || isSaving}
            className={[
              'flex-1 flex items-center justify-center gap-1.5 py-3 rounded-xl text-sm font-semibold transition-all',
              side === 'front'
                ? 'bg-amber-500 hover:bg-amber-400 text-stone-900'
                : 'bg-stone-800 hover:bg-stone-700 text-white',
              'disabled:opacity-40',
            ].join(' ')}
          >
            {isSaving
              ? <><Loader2 className="w-4 h-4 animate-spin" /> Saving…</>
              : <><Camera className="w-4 h-4" /> {side === 'front' ? 'Capture Front' : 'Capture Back'}</>
            }
          </button>
        )}
      </div>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export function BusinessCardCapture({
  session, sessionId, onComplete, onBack, onAssetsChanged, onOcrResult,
}: Props) {
  const [front, setFront] = useState<CardState>({ asset: null, status: 'empty' });
  const [back,  setBack]  = useState<CardState>({ asset: null, status: 'empty' });
  const [activeCapture, setActiveCapture] = useState<CardSide | null>(null);
  const [toast, setToast] = useState<{ msg: string; isError?: boolean } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { ocrState, runOcr, cancelOcr, resetOcr } = useOcr();

  function showToast(msg: string, isError = false) {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ msg, isError });
    toastTimer.current = setTimeout(() => setToast(null), 3000);
  }

  // Restore assets on mount (draft recovery)
  useEffect(() => {
    async function restore() {
      const d = session.draftData;
      if (!d.cardSessionId) return;

      const assets = await getSessionAssets(d.cardSessionId as string);
      const frontAsset = assets.find(a => a.side === 'front') ?? null;
      const backAsset  = assets.find(a => a.side === 'back')  ?? null;

      if (frontAsset) setFront({ asset: frontAsset, status: 'previewing' });
      if (backAsset)  setBack({ asset: backAsset,   status: 'previewing' });

      if (frontAsset || backAsset) {
        showToast('Business card images restored');
        onAssetsChanged?.(frontAsset, backAsset);
      }
    }
    restore();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Cleanup on unmount — cancel any in-flight OCR
  useEffect(() => () => { cancelOcr(); }, [cancelOcr]);

  const notifyChange = useCallback((f: CardState, b: CardState) => {
    onAssetsChanged?.(f.asset, b.asset);
  }, [onAssetsChanged]);

  async function handleCapture(side: CardSide, rawDataUrl: string) {
    const setState = side === 'front' ? setFront : setBack;
    const otherState = side === 'front' ? back : front;

    // Cancel any running OCR before replacing the front image
    if (side === 'front') {
      cancelOcr();
      resetOcr();
    }

    const existing = side === 'front' ? front.asset : back.asset;
    if (existing) await deleteAsset(existing.id);

    setState({ asset: null, status: 'saving' });
    setActiveCapture(null);

    try {
      const asset = await saveAsset(sessionId, side, rawDataUrl);
      const newState: CardState = { asset, status: 'previewing' };
      setState(newState);
      showToast(`${side === 'front' ? 'Front' : 'Back'} side saved`);
      notifyChange(
        side === 'front' ? newState : front,
        side === 'back'  ? newState : otherState,
      );

      // Auto-run OCR on the front side image
      if (side === 'front') {
        const result = await runOcr(asset.id, asset.dataUrl);
        if (result) {
          onOcrResult?.(result);
        }
      }

    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to save image';
      setState({ asset: null, status: 'error', errorMsg: msg });
      showToast(msg, true);
    }
  }

  async function handleDelete(side: CardSide) {
    const target = side === 'front' ? front : back;
    if (!target.asset) return;
    if (side === 'front') { cancelOcr(); resetOcr(); }
    await deleteAsset(target.asset.id);
    const newState: CardState = { asset: null, status: 'empty' };
    if (side === 'front') {
      setFront(newState);
      notifyChange(newState, back);
    } else {
      setBack(newState);
      notifyChange(front, newState);
    }
    showToast(`${side === 'front' ? 'Front' : 'Back'} image deleted`);
  }

  const isBusy    = front.status === 'saving' || back.status === 'saving';
  const isOcrRun  = ocrState.status === 'processing';
  const canContinue = !!front.asset;

  function handleContinue() {
    if (!front.asset) return;
    onComplete(front.asset.id, back.asset?.id ?? null, ocrState.result);
  }

  const showOcrBanner = ocrState.status !== 'idle';

  return (
    <div className="mt-6 animate-in fade-in slide-in-from-bottom-3 duration-300">

      <div className="flex items-center justify-between mb-6">
        <button
          onClick={onBack}
          className="flex items-center gap-1.5 text-sm font-medium text-stone-500 hover:text-stone-800 transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to options
        </button>
      </div>

      {/* Header card */}
      <div className="bg-white rounded-2xl border border-stone-200 shadow-sm overflow-hidden mb-4">
        <div className="px-5 pt-5 pb-4 border-b border-stone-100">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-amber-50 flex items-center justify-center flex-shrink-0">
              <FlipHorizontal className="w-[18px] h-[18px] text-amber-600" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-stone-900 leading-tight">Scan Business Card</h2>
              <p className="text-xs text-stone-500 mt-0.5">Capture front — details auto-extracted via OCR</p>
            </div>
          </div>
        </div>
        <div className="px-5 py-3.5 flex items-center gap-3">
          <StepDot done={!!front.asset} active={!front.asset} label="Front" />
          <div className="flex-1 h-px bg-stone-100" />
          <StepDot done={ocrState.status === 'done'} active={isOcrRun} label="Extract" isOcr />
          <div className="flex-1 h-px bg-stone-100" />
          <StepDot done={!!back.asset} active={!!front.asset && !back.asset && !isOcrRun} label="Back (Opt.)" />
          <div className="flex-1 h-px bg-stone-100" />
          <StepDot done={false} active={canContinue && !isOcrRun} label="Continue" isFinish />
        </div>
      </div>

      {/* OCR status banner */}
      {showOcrBanner && (
        <div className="mb-4 animate-in fade-in duration-200">
          <OcrBanner
            status={ocrState.status as 'processing' | 'done' | 'error'}
            progress={ocrState.progress}
            progressLabel={ocrState.progressLabel}
            result={ocrState.result}
            error={ocrState.error}
            onDismiss={resetOcr}
          />
        </div>
      )}

      {/* Capture cards */}
      <div className="flex flex-col gap-4">
        <PreviewCard
          side="front"
          asset={front.asset}
          status={front.status}
          errorMsg={front.errorMsg}
          isOcrRunning={isOcrRun}
          onCapture={() => setActiveCapture('front')}
          onRetake={() => setActiveCapture('front')}
          onDelete={() => handleDelete('front')}
          disabled={isBusy}
        />

        {(front.asset || back.asset) && (
          <PreviewCard
            side="back"
            asset={back.asset}
            status={back.status}
            errorMsg={back.errorMsg}
            onCapture={() => setActiveCapture('back')}
            onRetake={() => setActiveCapture('back')}
            onDelete={() => handleDelete('back')}
            disabled={isBusy}
          />
        )}
      </div>

      {/* Continue */}
      {canContinue && (
        <div className="mt-6 flex flex-col gap-3 animate-in fade-in duration-200">
          <button
            onClick={handleContinue}
            disabled={isBusy}
            className="w-full flex items-center justify-center gap-2 bg-stone-900 hover:bg-stone-800 active:bg-stone-950 active:scale-[0.98] text-white font-semibold rounded-xl py-4 text-base transition-all duration-150 shadow-sm disabled:opacity-40"
          >
            <CheckCircle2 className="w-5 h-5" />
            {isOcrRun ? 'Extracting… Continue Anyway' : (back.asset ? 'Continue with Both Sides' : 'Continue with Front Only')}
            <ChevronRight className="w-4 h-4 opacity-60" />
          </button>
          {!back.asset && !isOcrRun && (
            <p className="text-center text-xs text-stone-400">
              Back side is optional — you can skip it
            </p>
          )}
        </div>
      )}

      {activeCapture && (
        <CameraSheet
          side={activeCapture}
          onCapture={(dataUrl) => handleCapture(activeCapture, dataUrl)}
          onCancel={() => setActiveCapture(null)}
        />
      )}

      <Toast message={toast?.msg ?? null} isError={toast?.isError} />
    </div>
  );
}

// ─── Step indicator dot ───────────────────────────────────────────────────────

function StepDot({
  done, active, label, isFinish, isOcr,
}: {
  done: boolean;
  active: boolean;
  label: string;
  isFinish?: boolean;
  isOcr?: boolean;
}) {
  return (
    <div className="flex flex-col items-center gap-1 min-w-0">
      <div className={[
        'w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 transition-all',
        done    ? 'bg-green-100 text-green-600' :
        active  ? (isFinish
                    ? 'bg-amber-100 text-amber-600 ring-2 ring-amber-300'
                    : isOcr
                    ? 'bg-amber-100 text-amber-600'
                    : 'bg-amber-100 text-amber-600')
                : 'bg-stone-100 text-stone-400',
      ].join(' ')}>
        {done
          ? <Check className="w-3.5 h-3.5" />
          : isFinish
          ? <ChevronRight className="w-3.5 h-3.5" />
          : isOcr
          ? <Sparkles className="w-3.5 h-3.5" />
          : <Camera className="w-3.5 h-3.5" />}
      </div>
      <span className={[
        'text-[10px] font-medium text-center leading-tight',
        done ? 'text-green-600' : active ? 'text-amber-600' : 'text-stone-400',
      ].join(' ')}>
        {label}
      </span>
    </div>
  );
}
