// Business card capture — OpenAI Vision primary, Tesseract fallback.
// Offline: images stored in IndexedDB. Extraction via secure edge function.

import { useState, useRef, useCallback, useEffect } from 'react';
import {
  ArrowLeft, Camera, Trash2, CheckCircle2,
  RotateCcw, AlertCircle, Loader2,
  CreditCard, Check, Sparkles, Globe, MapPin, Phone, Mail,
  Plus, X as XIcon, WifiOff, ChevronRight, Zap,
  FlipHorizontal,
} from 'lucide-react';
import { createPortal } from 'react-dom';
import { saveAsset, deleteAsset, getSessionAssets } from './captureAssetStorage';
import { useVisionExtraction } from './useVisionExtraction';
import type { BusinessCardAsset, CardSide, CaptureSession, DraftData, OcrResult, VisionResult } from './types';
import type { VisionState } from './useVisionExtraction';
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
  isOnline?: boolean;
  onComplete: (frontAssetId: string, backAssetId: string | null, ocrResult: OcrResult | null, visionResult: VisionResult | null) => void;
  onBack: () => void;
  onAssetsChanged?: (front: BusinessCardAsset | null, back: BusinessCardAsset | null) => void;
  onDraftPatch?: (patch: Partial<DraftData>) => void;
  onVisionResult?: (result: VisionResult) => void;
  onOcrResult?: (result: OcrResult) => void;
  onOcrStateChange?: (state: { status: string; progress: number; progressLabel: string; error: string | null }) => void;
  onOcrDiagnostics?: (diag: null) => void;
  onDebugLog?: (step: string, detail?: unknown, level?: 'info' | 'warn' | 'error') => void;
}

// ─── Full-screen camera overlay ───────────────────────────────────────────────
// Opens immediately, fires the file input, shows guidance while waiting.
// Clean single-button UI — no nested sheets or dialogs.

function CameraOverlay({ side, onCapture, onCancel }: {
  side: CardSide;
  onCapture: (dataUrl: string) => void;
  onCancel: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [phase, setPhase]   = useState<'waiting' | 'error'>('waiting');
  const [errMsg, setErrMsg] = useState('');

  // Open file picker on mount
  useEffect(() => {
    const t = setTimeout(() => inputRef.current?.click(), 80);
    return () => clearTimeout(t);
  }, []);

  function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) { onCancel(); return; }
    if (!file.type.startsWith('image/')) {
      setErrMsg('That file is not an image — please try again.');
      setPhase('error');
      return;
    }
    const reader = new FileReader();
    reader.onload = ev => {
      const r = ev.target?.result;
      if (typeof r === 'string') onCapture(r);
      else { setErrMsg('Could not read image.'); setPhase('error'); }
    };
    reader.onerror = () => { setErrMsg('Failed to read image.'); setPhase('error'); };
    reader.readAsDataURL(file);
    e.target.value = '';
  }

  const isFront = side === 'front';

  return createPortal(
    <div className="fixed inset-0 z-[9990] bg-black flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-5 pt-[max(20px,env(safe-area-inset-top))] pb-4">
        <button
          onClick={onCancel}
          className="w-10 h-10 rounded-full bg-white/15 flex items-center justify-center active:bg-white/25 transition-colors"
          aria-label="Cancel capture"
        >
          <XIcon className="w-5 h-5 text-white" />
        </button>
        <span className="text-white font-semibold text-sm">
          {isFront ? 'Front Side' : 'Back Side (Optional)'}
        </span>
        <div className="w-10" />
      </div>

      {/* Hidden file input */}
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="sr-only"
        onChange={handleFile}
        onClick={e => { (e.target as HTMLInputElement).value = ''; }}
      />

      {/* Main content */}
      <div className="flex-1 flex flex-col items-center justify-center px-8 pb-8 gap-8">
        {phase === 'error' ? (
          <>
            <div className="w-20 h-20 rounded-full bg-red-900/40 flex items-center justify-center">
              <AlertCircle className="w-10 h-10 text-red-300" />
            </div>
            <div className="text-center">
              <p className="text-white font-semibold text-lg mb-1">Capture Failed</p>
              <p className="text-white/60 text-sm leading-relaxed">{errMsg}</p>
            </div>
            <div className="flex flex-col gap-3 w-full max-w-xs">
              <button
                onClick={() => { setPhase('waiting'); inputRef.current?.click(); }}
                className="w-full py-4 bg-amber-500 hover:bg-amber-400 active:scale-[0.97] text-stone-900 font-bold rounded-2xl text-base flex items-center justify-center gap-2 transition-all"
              >
                <Camera className="w-5 h-5" /> Try Again
              </button>
              <button onClick={onCancel} className="text-white/50 text-sm py-2">Cancel</button>
            </div>
          </>
        ) : (
          <>
            {/* Card frame guide */}
            <div className="relative w-full max-w-xs" style={{ aspectRatio: '1.75 / 1' }}>
              <div className="absolute inset-0 rounded-2xl border-2 border-dashed border-white/30" />
              {/* Corner accents */}
              <span className="absolute top-0 left-0 w-6 h-6 border-t-[3px] border-l-[3px] border-amber-400 rounded-tl-xl" />
              <span className="absolute top-0 right-0 w-6 h-6 border-t-[3px] border-r-[3px] border-amber-400 rounded-tr-xl" />
              <span className="absolute bottom-0 left-0 w-6 h-6 border-b-[3px] border-l-[3px] border-amber-400 rounded-bl-xl" />
              <span className="absolute bottom-0 right-0 w-6 h-6 border-b-[3px] border-r-[3px] border-amber-400 rounded-br-xl" />
              <div className="absolute inset-0 flex items-center justify-center">
                <CreditCard className="w-12 h-12 text-white/20" />
              </div>
            </div>

            <div className="text-center">
              <p className="text-white font-semibold text-lg mb-2">
                {isFront ? 'Photograph the Front' : 'Photograph the Back'}
              </p>
              <p className="text-white/50 text-sm leading-relaxed">
                {isFront
                  ? 'Place card flat, use good lighting'
                  : 'Capture any additional details on the back'}
              </p>
            </div>

            {/* Large primary camera button */}
            <button
              onClick={() => inputRef.current?.click()}
              className="w-full max-w-xs py-5 bg-amber-500 hover:bg-amber-400 active:scale-[0.97]
                text-stone-900 font-bold rounded-2xl text-lg flex items-center justify-center gap-3
                shadow-lg shadow-amber-900/30 transition-all"
            >
              <Camera className="w-6 h-6" />
              Open Camera
            </button>
            <button onClick={onCancel} className="text-white/40 text-sm -mt-4">Cancel</button>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}

// ─── Compact image card (post-capture preview) ────────────────────────────────

function CardPreview({ side, asset, status, errorMsg, isRunning, onCapture, onRetake, onDelete, disabled }: {
  side: CardSide;
  asset: BusinessCardAsset | null;
  status: CardState['status'];
  errorMsg?: string;
  isRunning?: boolean;
  onCapture: () => void;
  onRetake: () => void;
  onDelete: () => void;
  disabled?: boolean;
}) {
  const isFront  = side === 'front';
  const hasImage = !!asset;
  const isSaving = status === 'saving';
  const isError  = status === 'error';

  return (
    <div className={[
      'rounded-2xl border overflow-hidden transition-all duration-200',
      hasImage ? 'border-stone-200 bg-white shadow-sm' : 'border-dashed border-stone-300 bg-stone-50/60',
    ].join(' ')}>

      {/* Label row */}
      <div className="flex items-center gap-2.5 px-4 pt-4 pb-2.5">
        <div className={[
          'w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold shrink-0',
          hasImage ? 'bg-green-100 text-green-700' : 'bg-stone-200 text-stone-500',
        ].join(' ')}>
          {hasImage ? <Check className="w-3.5 h-3.5" /> : (isFront ? '1' : '2')}
        </div>
        <span className="text-sm font-semibold text-stone-800">
          {isFront ? 'Front Side' : 'Back Side'}
        </span>
        {!isFront && !hasImage && (
          <span className="ml-auto text-[11px] font-medium text-stone-400 bg-stone-100 rounded-full px-2 py-0.5">Optional</span>
        )}
        {hasImage && (
          <span className="ml-auto text-[11px] font-medium text-green-700 flex items-center gap-1">
            <CheckCircle2 className="w-3 h-3" /> Captured
          </span>
        )}
      </div>

      {/* Image / placeholder */}
      <div className="px-4 pb-3">
        {hasImage ? (
          <div className="relative rounded-xl overflow-hidden">
            <img
              src={asset.dataUrl}
              alt={`Business card ${side}`}
              className="w-full object-cover"
              style={{ aspectRatio: '1.75 / 1', objectFit: 'cover' }}
            />
            {/* Processing overlay */}
            {isRunning && (
              <div className="absolute inset-0 bg-amber-500/20 flex items-center justify-center">
                <div className="flex items-center gap-2 bg-white/90 rounded-full px-4 py-2 shadow-sm">
                  <Loader2 className="w-4 h-4 text-amber-600 animate-spin" />
                  <span className="text-xs font-semibold text-amber-700">Reading card…</span>
                </div>
              </div>
            )}
            {/* Size badge */}
            <span className="absolute bottom-2 right-2 text-[10px] bg-black/50 text-white/90 px-1.5 py-0.5 rounded-md font-mono">
              {Math.round(asset.sizeBytes / 1024)}KB
            </span>
          </div>
        ) : (
          <div
            className="rounded-xl bg-stone-100 flex items-center justify-center"
            style={{ aspectRatio: '1.75 / 1' }}
          >
            {isError ? (
              <div className="flex flex-col items-center gap-2 px-6 text-center">
                <AlertCircle className="w-7 h-7 text-red-400" />
                <p className="text-xs text-red-500 leading-snug">{errorMsg ?? 'Capture failed'}</p>
              </div>
            ) : isSaving ? (
              <div className="flex items-center gap-2">
                <Loader2 className="w-6 h-6 text-stone-400 animate-spin" />
                <span className="text-xs text-stone-400 font-medium">Saving…</span>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-2 text-stone-400">
                <CreditCard className="w-8 h-8 opacity-30" />
                <span className="text-xs">No photo yet</span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Action buttons */}
      <div className="px-4 pb-4 flex gap-2">
        {hasImage ? (
          <>
            <button
              onClick={onRetake}
              disabled={disabled || isRunning}
              className="flex-1 flex items-center justify-center gap-1.5 py-3 rounded-xl
                border border-stone-200 text-sm font-semibold text-stone-600
                hover:bg-stone-50 active:bg-stone-100 active:scale-[0.98]
                disabled:opacity-40 transition-all"
            >
              <RotateCcw className="w-3.5 h-3.5" /> Retake
            </button>
            <button
              onClick={onDelete}
              disabled={disabled || isRunning}
              className="flex items-center justify-center px-4 py-3 rounded-xl
                border border-red-100 text-red-500
                hover:bg-red-50 active:bg-red-100 active:scale-[0.98]
                disabled:opacity-40 transition-all"
              aria-label={`Delete ${side} image`}
            >
              <Trash2 className="w-4 h-4" />
            </button>
          </>
        ) : (
          <button
            onClick={onCapture}
            disabled={disabled || isSaving}
            className={[
              'flex-1 flex items-center justify-center gap-2 py-4 rounded-xl',
              'text-base font-bold transition-all active:scale-[0.97] disabled:opacity-40 shadow-sm',
              isFront
                ? 'bg-amber-500 hover:bg-amber-400 text-stone-900 shadow-amber-200'
                : 'bg-stone-800 hover:bg-stone-700 text-white',
            ].join(' ')}
          >
            {isSaving
              ? <><Loader2 className="w-5 h-5 animate-spin" /> Saving…</>
              : <><Camera className="w-5 h-5" /> {isFront ? 'Capture Front' : 'Capture Back'}</>
            }
          </button>
        )}
      </div>
    </div>
  );
}

// ─── Extraction progress banner ───────────────────────────────────────────────

function ExtractionBanner({ visionState, onDismiss, onRetry }: {
  visionState: VisionState;
  onDismiss: () => void;
  onRetry?: () => void;
}) {
  const { status, progress, progressLabel, result, error } = visionState;

  if (status === 'preprocessing' || status === 'extracting' || status === 'validating') {
    const steps = [
      { label: 'Preparing',  done: progress > 0.15, active: status === 'preprocessing' },
      { label: 'Extracting', done: progress > 0.80, active: status === 'extracting' },
      { label: 'Validating', done: progress >= 1,   active: status === 'validating' },
    ];
    return (
      <div className="rounded-2xl bg-amber-50 border border-amber-200 px-4 py-3.5">
        <div className="flex items-center gap-3 mb-2.5">
          <div className="w-8 h-8 rounded-full bg-amber-100 flex items-center justify-center shrink-0">
            <Sparkles className="w-4 h-4 text-amber-600 animate-pulse" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-amber-900">Reading business card…</p>
            <p className="text-[11px] text-amber-700 mt-0.5 truncate">{progressLabel}</p>
          </div>
        </div>
        <div className="h-1.5 bg-amber-200 rounded-full overflow-hidden mb-2.5">
          <div className="h-full bg-amber-500 rounded-full transition-all duration-500 ease-out"
            style={{ width: `${Math.round(progress * 100)}%` }} />
        </div>
        <div className="flex items-center gap-2">
          {steps.map((step, i) => (
            <div key={step.label} className="flex items-center gap-1.5">
              {i > 0 && <div className="w-4 h-px bg-amber-200" />}
              <div className="flex items-center gap-1">
                <div className={['w-2 h-2 rounded-full transition-all',
                  step.done   ? 'bg-green-500' :
                  step.active ? 'bg-amber-500 animate-pulse' : 'bg-amber-200',
                ].join(' ')} />
                <span className={['text-[10px] font-medium',
                  step.done   ? 'text-green-600' :
                  step.active ? 'text-amber-700' : 'text-amber-400',
                ].join(' ')}>{step.label}</span>
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (status === 'error') {
    const isMissingKey = error?.includes('OPENAI_API_KEY') || error?.includes('503');
    return (
      <div className="rounded-2xl bg-red-50 border border-red-200 px-4 py-3.5">
        <div className="flex items-start gap-3">
          <AlertCircle className="w-5 h-5 text-red-500 shrink-0 mt-0.5" />
          <div className="flex-1">
            <p className="text-sm font-semibold text-red-800">
              {isMissingKey ? 'AI extraction unavailable' : 'Extraction failed'}
            </p>
            <p className="text-xs text-red-600 mt-0.5 leading-relaxed">
              {isMissingKey
                ? 'Falling back to OCR. You can also fill in details manually.'
                : (error ?? 'Could not read card. Fill in manually or retry.')}
            </p>
          </div>
          <button onClick={onDismiss} className="text-red-400 hover:text-red-600 text-xs font-medium shrink-0">
            Dismiss
          </button>
        </div>
        {onRetry && (
          <button
            onClick={onRetry}
            className="mt-3 flex items-center gap-1.5 px-4 py-2.5 rounded-xl bg-red-100
              hover:bg-red-200 text-red-800 text-sm font-semibold active:scale-[0.98] transition-all"
          >
            <RotateCcw className="w-3.5 h-3.5" /> Retry Extraction
          </button>
        )}
      </div>
    );
  }

  if (status === 'done' && result) {
    const f = result.fields;
    const fieldCount = [f.fullName, f.company, f.designation, ...f.emails, ...f.phoneNumbers]
      .filter(v => v && String(v).trim()).length;
    const isFallback = result.source === 'tesseract_fallback';
    const isLow = f.confidence < 0.45;

    return (
      <div className={[
        'rounded-2xl border px-4 py-3.5',
        isLow ? 'bg-stone-50 border-stone-200' : 'bg-green-50 border-green-200',
      ].join(' ')}>
        <div className="flex items-start gap-3">
          <div className={[
            'shrink-0 w-8 h-8 rounded-full flex items-center justify-center',
            isLow ? 'bg-stone-100' : 'bg-green-100',
          ].join(' ')}>
            <Sparkles className={`w-4 h-4 ${isLow ? 'text-stone-500' : 'text-green-600'}`} />
          </div>
          <div className="flex-1">
            <p className={`text-sm font-semibold ${isLow ? 'text-stone-700' : 'text-green-800'}`}>
              {fieldCount > 0 ? `${fieldCount} fields extracted` : 'Scanned — please verify'}
              {isFallback && <span className="ml-2 text-[10px] font-normal text-stone-500">(OCR fallback)</span>}
            </p>
            <p className={`text-xs mt-0.5 ${isLow ? 'text-stone-500' : 'text-green-700'}`}>
              {Math.round(f.confidence * 100)}% confidence
              {' · '}{result.durationMs < 1000 ? `${result.durationMs}ms` : `${(result.durationMs / 1000).toFixed(1)}s`}
            </p>
            {isLow && (
              <p className="flex items-center gap-1 mt-1.5 text-[11px] text-stone-500">
                <AlertCircle className="w-3 h-3 shrink-0" />
                Low confidence — please review extracted details
              </p>
            )}
          </div>
        </div>
      </div>
    );
  }

  return null;
}

// ─── Confidence-aware text field ──────────────────────────────────────────────

function ConfidenceField({ label, icon: Icon, value, confidence, onChange, onBlur, inputType = 'text', placeholder }: {
  label: string;
  icon: React.ElementType;
  value: string;
  confidence?: 'high' | 'medium' | 'low' | 'unknown';
  onChange: (v: string) => void;
  onBlur?: () => void;
  inputType?: string;
  placeholder?: string;
}) {
  const borderCls =
    confidence === 'high'   ? 'border-green-300 ring-1 ring-green-200' :
    confidence === 'medium' ? 'border-yellow-300 ring-1 ring-yellow-200' :
    confidence === 'low'    ? 'border-red-300 ring-1 ring-red-200' :
    'border-stone-200 focus:border-stone-400 focus:ring-1 focus:ring-stone-100';

  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-[13px] font-medium text-stone-600 flex items-center gap-1.5">
        <Icon className="w-3.5 h-3.5 text-stone-400" />
        {label}
        {confidence && confidence !== 'unknown' && (
          <span className={`text-[10px] font-semibold ml-auto rounded-full px-2 py-0.5 ${
            confidence === 'high'   ? 'bg-green-100 text-green-700' :
            confidence === 'medium' ? 'bg-yellow-100 text-yellow-700' :
                                      'bg-red-100 text-red-700'
          }`}>{confidence}</span>
        )}
      </label>
      <input
        type={inputType}
        inputMode={inputType === 'tel' ? 'tel' : inputType === 'email' ? 'email' : 'text'}
        value={value}
        onChange={e => onChange(e.target.value)}
        onBlur={onBlur}
        placeholder={placeholder}
        className={`w-full rounded-xl border px-4 py-3.5 text-base text-stone-900
          placeholder:text-stone-400 bg-white focus:outline-none transition-all duration-150 ${borderCls}`}
      />
    </div>
  );
}

// ─── Multi-value chip input ───────────────────────────────────────────────────

function ChipInput({ label, icon: Icon, values, confidence, onAdd, onRemove, inputType = 'text', placeholder }: {
  label: string;
  icon: React.ElementType;
  values: string[];
  confidence?: 'high' | 'medium' | 'low' | 'unknown';
  onAdd: (v: string) => void;
  onRemove: (i: number) => void;
  inputType?: string;
  placeholder?: string;
}) {
  const [inputVal, setInputVal] = useState('');

  function commit() {
    const v = inputVal.trim();
    if (v && !values.includes(v)) { onAdd(v); setInputVal(''); }
    else setInputVal('');
  }

  const borderCls =
    confidence === 'high'   ? 'border-green-300 ring-1 ring-green-200' :
    confidence === 'medium' ? 'border-yellow-300 ring-1 ring-yellow-200' :
    confidence === 'low'    ? 'border-red-300 ring-1 ring-red-200' : 'border-stone-200';

  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-[13px] font-medium text-stone-600 flex items-center gap-1.5">
        <Icon className="w-3.5 h-3.5 text-stone-400" />
        {label}
        {confidence && confidence !== 'unknown' && (
          <span className={`text-[10px] font-semibold ml-auto rounded-full px-2 py-0.5 ${
            confidence === 'high'   ? 'bg-green-100 text-green-700' :
            confidence === 'medium' ? 'bg-yellow-100 text-yellow-700' :
                                      'bg-red-100 text-red-700'
          }`}>{confidence}</span>
        )}
      </label>
      {values.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {values.map((v, i) => (
            <span key={i} className={`flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium border ${
              confidence === 'high'   ? 'bg-green-50 text-green-800 border-green-200' :
              confidence === 'medium' ? 'bg-yellow-50 text-yellow-800 border-yellow-200' :
              confidence === 'low'    ? 'bg-red-50 text-red-800 border-red-200' :
                                        'bg-stone-100 text-stone-700 border-stone-200'
            }`}>
              {v}
              <button onClick={() => onRemove(i)} className="ml-0.5 text-stone-400 hover:text-stone-600">
                <XIcon className="w-3 h-3" />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className={`flex rounded-xl border bg-white overflow-hidden ${borderCls}`}>
        <input
          type={inputType}
          inputMode={inputType === 'tel' ? 'tel' : inputType === 'email' ? 'email' : 'text'}
          value={inputVal}
          onChange={e => setInputVal(e.target.value)}
          onBlur={commit}
          onKeyDown={e => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); commit(); } }}
          placeholder={placeholder ?? `Add ${label.toLowerCase()}…`}
          className="flex-1 px-3.5 py-3.5 text-base text-stone-900 placeholder:text-stone-400 focus:outline-none bg-transparent"
        />
        <button type="button" onClick={commit}
          className="px-3 text-stone-400 hover:text-stone-700 border-l border-stone-100 active:bg-stone-50">
          <Plus className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export function BusinessCardCapture({
  session, sessionId, isOnline = true, onComplete, onBack, onAssetsChanged,
  onDraftPatch, onVisionResult, onOcrResult, onOcrStateChange, onOcrDiagnostics: _ignored,
  onDebugLog,
}: Props) {
  const [front, setFront] = useState<CardState>({ asset: null, status: 'empty' });
  const [back,  setBack]  = useState<CardState>({ asset: null, status: 'empty' });
  const [activeCapture, setActiveCapture] = useState<CardSide | null>(null);
  const [showBackCapture, setShowBackCapture] = useState(false);
  const [toast, setToast] = useState<{ msg: string; isError?: boolean } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // showExtraFields is UI-only — initialise from draft so restored sessions expand correctly
  const [showExtraFields, setShowExtraFields] = useState(
    () => !!(session.draftData.website || session.draftData.address),
  );
  // lastVisionResult is display-only (confidence badge colours); not part of shared state
  const [lastVisionResult, setLastVisionResult] = useState<VisionResult | null>(null);

  // ── All extracted / edited field values are derived from session.draftData ──
  // Writes go through onDraftPatch → actions.patchDraft (same pattern as ManualEntryForm).
  const d = session.draftData;
  const editedName    = String(d.clientName  ?? '');
  const editedCompany = String(d.company     ?? '');
  const editedDesig   = String(d.designation ?? '');
  const editedPhones: string[] = Array.isArray(d.phoneNumbers) && (d.phoneNumbers as string[]).length
    ? d.phoneNumbers as string[]
    : d.phone ? [String(d.phone)] : [];
  const editedEmails: string[] = Array.isArray(d.emails) && (d.emails as string[]).length
    ? d.emails as string[]
    : d.email ? [String(d.email)] : [];
  const editedWebsite = String(d.website ?? '');
  const editedAddress = String(d.address  ?? '');
  const editedNotes   = String(d.notes    ?? '');

  const { visionState, runExtraction, cancelExtraction, resetExtraction } = useVisionExtraction();

  useEffect(() => {
    const statusMap: Record<string, string> = {
      idle: 'idle', preprocessing: 'processing', extracting: 'processing',
      validating: 'processing', done: 'done', error: 'error',
    };
    onOcrStateChange?.({
      status:        statusMap[visionState.status] ?? visionState.status,
      progress:      visionState.progress,
      progressLabel: visionState.progressLabel,
      error:         visionState.error,
    });
  }, [visionState.status, visionState.progress, visionState.progressLabel, visionState.error, onOcrStateChange]);

  function showToast(msg: string, isError = false) {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ msg, isError });
    toastTimer.current = setTimeout(() => setToast(null), 3000);
  }

  // Restore assets on mount (draft recovery) — field values are already in session.draftData
  useEffect(() => {
    async function restore() {
      const d = session.draftData;
      if (!d.cardSessionId) return;
      const assets = await getSessionAssets(d.cardSessionId as string);
      const frontAsset = assets.find(a => a.side === 'front') ?? null;
      const backAsset  = assets.find(a => a.side === 'back')  ?? null;
      if (frontAsset) setFront({ asset: frontAsset, status: 'previewing' });
      if (backAsset)  { setBack({ asset: backAsset, status: 'previewing' }); setShowBackCapture(true); }
      if (frontAsset || backAsset) {
        showToast('Business card images restored');
        onAssetsChanged?.(frontAsset, backAsset);
      }
    }
    restore();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => () => { cancelExtraction(); }, [cancelExtraction]);

  const notifyChange = useCallback((f: CardState, b: CardState) => {
    onAssetsChanged?.(f.asset, b.asset);
  }, [onAssetsChanged]);

  function applyVisionResult(result: VisionResult) {
    const f = result.fields;

    // Write extracted fields directly to the shared draft so they're immediately
    // visible in ManualEntryForm without waiting for the user to click Continue.
    const patch: Partial<DraftData> = {};
    if (f.fullName)            patch.clientName  = f.fullName;
    if (f.company)             patch.company     = f.company;
    if (f.designation)         patch.designation = f.designation;
    if (f.phoneNumbers.length) { patch.phoneNumbers = f.phoneNumbers; patch.phone = f.phoneNumbers[0]; }
    if (f.emails.length)       { patch.emails = f.emails; patch.email = f.emails[0]; }
    if (f.website)             patch.website = f.website;
    if (f.address)             patch.address = f.address;
    if (f.notes)               patch.notes   = f.notes;
    if (Object.keys(patch).length) onDraftPatch?.(patch);

    if (f.website || f.address) setShowExtraFields(true);
    setLastVisionResult(result);
    onVisionResult?.(result);
    onDebugLog?.('Vision extraction completed', {
      source: result.source, confidence: f.confidence, durationMs: result.durationMs,
    });

    const legacyOcr: OcrResult = {
      assetId:     result.assetId,
      rawText:     f.rawText,
      fields: {
        clientName:  f.fullName       || undefined,
        company:     f.company        || undefined,
        phone:       f.phoneNumbers[0]|| undefined,
        email:       f.emails[0]      || undefined,
        designation: f.designation    || undefined,
      },
      confidence:     f.confidence >= 0.75 ? 'high' : f.confidence >= 0.45 ? 'medium' : 'low',
      inferredFields: [
        f.fullName         ? 'clientName'  : null,
        f.company          ? 'company'     : null,
        f.phoneNumbers[0]  ? 'phone'       : null,
        f.emails[0]        ? 'email'       : null,
        f.designation      ? 'designation' : null,
      ].filter(Boolean) as string[],
      ignoredLines: [],
      completedAt:  result.completedAt,
    };
    onOcrResult?.(legacyOcr);
  }

  const handleRetry = useCallback(async () => {
    const asset = front.asset;
    if (!asset) return;
    resetExtraction();
    const result = await runExtraction(asset.id, asset.dataUrl);
    if (result) applyVisionResult(result);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [front.asset, resetExtraction, runExtraction]);

  async function handleCapture(side: CardSide, rawDataUrl: string) {
    const setState = side === 'front' ? setFront : setBack;
    const otherState = side === 'front' ? back : front;

    if (side === 'front') { cancelExtraction(); resetExtraction(); }

    const existing = side === 'front' ? front.asset : back.asset;
    if (existing) await deleteAsset(existing.id);

    setState({ asset: null, status: 'saving' });
    setActiveCapture(null);

    try {
      const asset = await saveAsset(sessionId, side, rawDataUrl);
      const newState: CardState = { asset, status: 'previewing' };
      setState(newState);
      showToast(side === 'front' ? 'Front captured' : 'Back captured');
      notifyChange(
        side === 'front' ? newState : front,
        side === 'back'  ? newState : otherState,
      );

      if (side === 'front') {
        if (!isOnline) {
          showToast('Saved offline — fill details manually');
          onDebugLog?.('Front captured — offline, extraction deferred', { assetId: asset.id });
        } else {
          onDebugLog?.('Front captured — starting vision extraction', { assetId: asset.id });
          const result = await runExtraction(asset.id, asset.dataUrl);
          if (result) applyVisionResult(result);
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
    if (side === 'front') { cancelExtraction(); resetExtraction(); }
    await deleteAsset(target.asset.id);
    const newState: CardState = { asset: null, status: 'empty' };
    if (side === 'front') {
      setFront(newState);
      notifyChange(newState, back);
    } else {
      setBack(newState);
      notifyChange(front, newState);
    }
  }

  const isBusy      = front.status === 'saving' || back.status === 'saving';
  const isRunning   = visionState.status !== 'idle' && visionState.status !== 'done' && visionState.status !== 'error';
  const canContinue = !!front.asset;
  const hasExtracted = visionState.status === 'done' && !!visionState.result;
  const showFields   = hasExtracted || (!!front.asset && !isRunning) || (!isOnline && !!front.asset);

  function handleContinue() {
    if (!front.asset) return;
    const legacyOcr = visionState.result
      ? ({
          assetId:     visionState.result.assetId,
          rawText:     visionState.result.fields.rawText,
          fields: {
            clientName:  editedName      || undefined,
            company:     editedCompany   || undefined,
            phone:       editedPhones[0] || undefined,
            email:       editedEmails[0] || undefined,
            designation: editedDesig     || undefined,
          },
          confidence:     visionState.result.fields.confidence >= 0.75 ? 'high' :
                          visionState.result.fields.confidence >= 0.45 ? 'medium' : 'low',
          inferredFields: [
            editedName      ? 'clientName'  : null,
            editedCompany   ? 'company'     : null,
            editedPhones[0] ? 'phone'       : null,
            editedEmails[0] ? 'email'       : null,
            editedDesig     ? 'designation' : null,
          ].filter(Boolean) as string[],
          ignoredLines: [],
          completedAt:  visionState.result.completedAt,
        } as OcrResult)
      : null;

    onComplete(front.asset.id, back.asset?.id ?? null, legacyOcr, visionState.result);
  }

  const fc = lastVisionResult?.fieldConfidence;

  return (
    <div className="mt-4 animate-in fade-in slide-in-from-bottom-3 duration-300 pb-6">

      {/* ── Top bar ── */}
      <div className="flex items-center justify-between mb-5">
        <button
          onClick={onBack}
          className="flex items-center gap-1.5 text-sm font-medium text-stone-500 hover:text-stone-800 transition-colors"
        >
          <ArrowLeft className="w-4 h-4" /> Back
        </button>
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-xl bg-amber-50 flex items-center justify-center">
            <FlipHorizontal className="w-[17px] h-[17px] text-amber-600" />
          </div>
          <span className="text-sm font-semibold text-stone-800">Business Card</span>
        </div>
        <div className="w-16" />
      </div>

      {/* ── Offline notice ── */}
      {!isOnline && (
        <div className="mb-4 rounded-2xl bg-amber-50 border border-amber-200 px-4 py-3.5 flex items-start gap-3">
          <WifiOff className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-semibold text-amber-900 leading-tight">Offline — AI extraction unavailable</p>
            <p className="text-xs text-amber-700 mt-0.5 leading-snug">
              Photos save locally. Fill details manually below.
            </p>
          </div>
        </div>
      )}

      {/* ── Extraction banner ── */}
      {visionState.status !== 'idle' && isOnline && (
        <div className="mb-4 animate-in fade-in duration-200">
          <ExtractionBanner
            visionState={visionState}
            onDismiss={resetExtraction}
            onRetry={visionState.status === 'error' && front.asset ? handleRetry : undefined}
          />
        </div>
      )}

      {/* ── Capture cards ── */}
      <div className="space-y-3 mb-4">
        <CardPreview
          side="front"
          asset={front.asset} status={front.status} errorMsg={front.errorMsg}
          isRunning={isRunning}
          onCapture={() => setActiveCapture('front')}
          onRetake={() => setActiveCapture('front')}
          onDelete={() => handleDelete('front')}
          disabled={isBusy}
        />

        {/* Back side — shown after front captured, or if already have back */}
        {(front.asset || back.asset) && (
          showBackCapture || back.asset ? (
            <CardPreview
              side="back"
              asset={back.asset} status={back.status} errorMsg={back.errorMsg}
              onCapture={() => setActiveCapture('back')}
              onRetake={() => setActiveCapture('back')}
              onDelete={() => handleDelete('back')}
              disabled={isBusy}
            />
          ) : (
            <button
              onClick={() => setShowBackCapture(true)}
              className="w-full flex items-center justify-center gap-2 py-3.5 rounded-2xl
                border border-dashed border-stone-200 text-sm font-medium text-stone-400
                hover:border-stone-300 hover:text-stone-500 active:bg-stone-50 transition-colors"
            >
              <Plus className="w-4 h-4" /> Add Back Side
            </button>
          )
        )}
      </div>

      {/* ── Extracted / editable fields ── */}
      {showFields && (
        <div className="bg-white rounded-2xl border border-stone-200 shadow-sm overflow-hidden mb-4 animate-in fade-in slide-in-from-bottom-2 duration-300">
          <div className="px-5 pt-4 pb-3 border-b border-stone-100 flex items-center gap-2">
            <Zap className="w-4 h-4 text-amber-500 shrink-0" />
            <span className="text-sm font-semibold text-stone-900">
              {hasExtracted ? 'Extracted Details' : 'Contact Details'}
            </span>
            <span className="ml-auto text-[11px] text-stone-400">All editable</span>
          </div>

          <div className="px-5 py-4 space-y-4">
            <ConfidenceField label="Full Name" icon={({ className }: { className?: string }) => <span className={className}>👤</span>}
              value={editedName} confidence={fc?.fullName}
              onChange={v => onDraftPatch?.({ clientName: v })} placeholder="e.g. Rahul Sharma" />

            <ConfidenceField label="Company" icon={({ className }: { className?: string }) => <span className={className}>🏢</span>}
              value={editedCompany} confidence={fc?.company}
              onChange={v => onDraftPatch?.({ company: v })} placeholder="e.g. Acme Retail Pvt Ltd" />

            <ConfidenceField label="Designation" icon={({ className }: { className?: string }) => <span className={className}>💼</span>}
              value={editedDesig} confidence={fc?.designation}
              onChange={v => onDraftPatch?.({ designation: v })} placeholder="e.g. Purchase Manager" />

            <ChipInput label="Phone Numbers" icon={Phone}
              values={editedPhones} confidence={fc?.phoneNumbers}
              onAdd={v => {
                const next = [...editedPhones, v];
                onDraftPatch?.({ phoneNumbers: next, phone: next[0] });
              }}
              onRemove={i => {
                const next = editedPhones.filter((_, j) => j !== i);
                onDraftPatch?.({ phoneNumbers: next, phone: next[0] ?? undefined });
              }}
              inputType="tel" placeholder="+91 98765 43210" />

            <ChipInput label="Email Addresses" icon={Mail}
              values={editedEmails} confidence={fc?.emails}
              onAdd={v => {
                const next = [...editedEmails, v];
                onDraftPatch?.({ emails: next, email: next[0] });
              }}
              onRemove={i => {
                const next = editedEmails.filter((_, j) => j !== i);
                onDraftPatch?.({ emails: next, email: next[0] ?? undefined });
              }}
              inputType="email" placeholder="name@company.com" />

            {!showExtraFields ? (
              <button
                onClick={() => setShowExtraFields(true)}
                className="text-xs text-stone-500 hover:text-stone-700 flex items-center gap-1 py-1"
              >
                <Plus className="w-3.5 h-3.5" /> Website, address, notes
              </button>
            ) : (
              <>
                <ConfidenceField label="Website" icon={Globe}
                  value={editedWebsite} confidence={fc?.website}
                  onChange={v => onDraftPatch?.({ website: v })} placeholder="https://company.com" />
                <ConfidenceField label="Address" icon={MapPin}
                  value={editedAddress} confidence={fc?.address}
                  onChange={v => onDraftPatch?.({ address: v })} placeholder="City, State" />
                <div className="flex flex-col gap-1.5">
                  <label className="text-[13px] font-medium text-stone-600">Notes</label>
                  <textarea
                    value={editedNotes}
                    onChange={e => onDraftPatch?.({ notes: e.target.value })}
                    placeholder="e.g. Interested in oud range, follow up next week…"
                    rows={3}
                    className="w-full rounded-xl border border-stone-200 px-4 py-3.5 text-base
                      text-stone-900 placeholder:text-stone-400 bg-white focus:outline-none
                      focus:border-stone-400 focus:ring-1 focus:ring-stone-100 resize-none"
                  />
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* ── Continue button ── */}
      {canContinue && (
        <div className="space-y-2 animate-in fade-in duration-200">
          <button
            onClick={handleContinue}
            disabled={isBusy}
            className="w-full flex items-center justify-center gap-2
              bg-stone-900 hover:bg-stone-800 active:bg-stone-950 active:scale-[0.98]
              text-white font-bold rounded-2xl py-4 text-base
              transition-all duration-150 shadow-sm disabled:opacity-40"
          >
            <CheckCircle2 className="w-5 h-5" />
            {isRunning ? 'Continue Anyway' :
             back.asset ? 'Continue with Both Sides' : 'Continue'}
            <ChevronRight className="w-4 h-4 opacity-60" />
          </button>
          {!back.asset && !isRunning && (
            <p className="text-center text-xs text-stone-400">Back side is optional</p>
          )}
        </div>
      )}

      {/* ── Camera overlay ── */}
      {activeCapture && (
        <CameraOverlay
          side={activeCapture}
          onCapture={dataUrl => handleCapture(activeCapture, dataUrl)}
          onCancel={() => setActiveCapture(null)}
        />
      )}

      <Toast message={toast?.msg ?? null} isError={toast?.isError} />
    </div>
  );
}

export type { Props as BusinessCardCaptureProps };
