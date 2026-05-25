// Business card capture — OpenAI Vision primary, Tesseract fallback.
// Offline: images stored in IndexedDB. Extraction via secure edge function.

import { useState, useRef, useCallback, useEffect } from 'react';
import {
  ArrowLeft, Camera, FlipHorizontal, Trash2, CheckCircle2,
  RotateCcw, ChevronRight, ImageOff, AlertCircle, Loader2,
  CreditCard, Check, Sparkles, Globe, MapPin, Phone, Mail,
  Info, Plus, X as XIcon,
} from 'lucide-react';
import { createPortal } from 'react-dom';
import { saveAsset, deleteAsset, getSessionAssets } from './captureAssetStorage';
import { useVisionExtraction } from './useVisionExtraction';
import type { BusinessCardAsset, CardSide, CaptureSession, OcrResult, VisionResult } from './types';
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
  onComplete: (frontAssetId: string, backAssetId: string | null, ocrResult: OcrResult | null, visionResult: VisionResult | null) => void;
  onBack: () => void;
  onAssetsChanged?: (front: BusinessCardAsset | null, back: BusinessCardAsset | null) => void;
  onVisionResult?: (result: VisionResult) => void;
  // Legacy OCR callbacks — kept for debug panel compatibility
  onOcrResult?: (result: OcrResult) => void;
  onOcrStateChange?: (state: { status: string; progress: number; progressLabel: string; error: string | null }) => void;
  onOcrDiagnostics?: (diag: null) => void;
  onDebugLog?: (step: string, detail?: unknown, level?: 'info' | 'warn' | 'error') => void;
}

// ─── Camera sheet ──────────────────────────────────────────────────────────────

function CameraSheet({ side, onCapture, onCancel }: {
  side: CardSide;
  onCapture: (dataUrl: string) => void;
  onCancel: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const t = setTimeout(() => { inputRef.current?.click(); setLoading(false); }, 120);
    return () => clearTimeout(t);
  }, []);

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) { onCancel(); return; }
    if (!file.type.startsWith('image/')) { setError('Selected file is not an image.'); return; }
    const reader = new FileReader();
    reader.onload = ev => {
      const r = ev.target?.result;
      if (typeof r === 'string') onCapture(r);
      else setError('Could not read image.');
    };
    reader.onerror = () => setError('Failed to read image file.');
    reader.readAsDataURL(file);
  }

  return createPortal(
    <div className="fixed inset-0 z-[9990] flex flex-col items-center justify-center bg-black">
      <input ref={inputRef} type="file" accept="image/*" capture="environment"
        className="sr-only" onChange={handleFileChange}
        onClick={e => { (e.target as HTMLInputElement).value = ''; }} />
      <div className="flex flex-col items-center gap-6 px-8 text-center">
        {loading ? (
          <Loader2 className="w-10 h-10 text-white/60 animate-spin" />
        ) : error ? (
          <>
            <div className="w-14 h-14 rounded-full bg-red-900/60 flex items-center justify-center">
              <AlertCircle className="w-7 h-7 text-red-300" />
            </div>
            <p className="text-white/80 text-sm">{error}</p>
            <button onClick={() => { setError(null); inputRef.current?.click(); }}
              className="px-6 py-3 bg-white text-stone-900 rounded-xl font-semibold text-sm">Try Again</button>
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
                {side === 'front' ? 'Position the front of the business card in good lighting' : 'Position the back of the business card'}
              </p>
            </div>
            <button onClick={() => inputRef.current?.click()}
              className="w-full max-w-xs px-6 py-4 bg-amber-500 hover:bg-amber-400 text-stone-900 font-bold rounded-2xl text-base flex items-center justify-center gap-2">
              <Camera className="w-5 h-5" /> Open Camera
            </button>
            <button onClick={onCancel} className="text-white/50 text-sm mt-1">Cancel</button>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}

// ─── Extraction progress banner ───────────────────────────────────────────────

function ExtractionBanner({ visionState, onDismiss, onRetry }: {
  visionState: VisionState;
  onDismiss: () => void;
  onRetry?: () => void;
}) {
  const { status, progress, progressLabel, result, error } = visionState;

  const steps: { key: string; label: string; done: boolean; active: boolean }[] = [
    { key: 'pre',   label: 'Preparing',  done: progress > 0.15, active: status === 'preprocessing' },
    { key: 'ext',   label: 'Extracting', done: progress > 0.80, active: status === 'extracting' },
    { key: 'val',   label: 'Validating', done: progress >= 1,    active: status === 'validating' },
  ];

  if (status === 'preprocessing' || status === 'extracting' || status === 'validating') {
    return (
      <div className="rounded-2xl bg-amber-50 border border-amber-200 px-4 py-3.5">
        <div className="flex items-center gap-3 mb-2.5">
          <div className="flex-shrink-0 w-8 h-8 rounded-full bg-amber-100 flex items-center justify-center">
            <Sparkles className="w-4 h-4 text-amber-600 animate-pulse" />
          </div>
          <div className="flex-1">
            <p className="text-sm font-semibold text-amber-900">Reading business card…</p>
            <p className="text-[11px] text-amber-700 mt-0.5">{progressLabel}</p>
          </div>
        </div>
        {/* Progress bar */}
        <div className="h-1.5 bg-amber-200 rounded-full overflow-hidden mb-2.5">
          <div className="h-full bg-amber-500 rounded-full transition-all duration-500 ease-out"
            style={{ width: `${Math.round(progress * 100)}%` }} />
        </div>
        {/* Step indicators */}
        <div className="flex items-center gap-2">
          {steps.map((step, i) => (
            <div key={step.key} className="flex items-center gap-1.5">
              {i > 0 && <div className="w-4 h-px bg-amber-200" />}
              <div className="flex items-center gap-1">
                <div className={[
                  'w-2 h-2 rounded-full transition-all',
                  step.done   ? 'bg-green-500' :
                  step.active ? 'bg-amber-500 animate-pulse' : 'bg-amber-200',
                ].join(' ')} />
                <span className={[
                  'text-[10px] font-medium',
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
          <AlertCircle className="w-5 h-5 text-red-500 flex-shrink-0 mt-0.5" />
          <div className="flex-1">
            <p className="text-sm font-semibold text-red-800">
              {isMissingKey ? 'OpenAI API key not configured' : 'Extraction failed'}
            </p>
            <p className="text-xs text-red-600 mt-0.5 leading-relaxed">
              {isMissingKey
                ? 'Add OPENAI_API_KEY to edge function secrets. Falling back to OCR.'
                : (error ?? 'Could not extract card details. Fill in manually or retry.')}
            </p>
          </div>
          <button onClick={onDismiss} className="text-red-400 hover:text-red-600 text-xs font-medium">Dismiss</button>
        </div>
        {onRetry && (
          <div className="mt-3 flex gap-2">
            <button onClick={onRetry}
              className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-red-100 hover:bg-red-200 text-red-800 text-xs font-semibold">
              <RotateCcw className="w-3.5 h-3.5" /> Retry
            </button>
            <p className="text-[11px] text-red-500 self-center">or continue and fill in manually</p>
          </div>
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
            'flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center',
            isLow ? 'bg-stone-100' : 'bg-green-100',
          ].join(' ')}>
            <Sparkles className={`w-4 h-4 ${isLow ? 'text-stone-500' : 'text-green-600'}`} />
          </div>
          <div className="flex-1">
            <p className={`text-sm font-semibold ${isLow ? 'text-stone-700' : 'text-green-800'}`}>
              {fieldCount > 0 ? `${fieldCount} fields extracted` : 'Card scanned — verify details'}
              {isFallback && <span className="ml-2 text-[10px] font-normal text-stone-500">(OCR fallback)</span>}
            </p>
            <p className={`text-xs mt-0.5 ${isLow ? 'text-stone-500' : 'text-green-700'}`}>
              {Math.round(f.confidence * 100)}% confidence
              {' · '}{result.durationMs < 1000 ? `${result.durationMs}ms` : `${(result.durationMs / 1000).toFixed(1)}s`}
            </p>
            {isLow && (
              <p className="flex items-center gap-1 mt-1.5 text-[11px] text-stone-500">
                <Info className="w-3 h-3 flex-shrink-0" />
                Low confidence — please review extracted details.
              </p>
            )}
          </div>
        </div>
      </div>
    );
  }

  return null;
}

// ─── Preview card ─────────────────────────────────────────────────────────────

function PreviewCard({ side, asset, status, errorMsg, isRunning, onCapture, onRetake, onDelete, disabled }: {
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
          <img src={asset.dataUrl} alt={`Business card ${side}`}
            className="w-full rounded-xl object-cover" style={{ aspectRatio: '1.75 / 1', objectFit: 'cover' }} />
          {isRunning && (
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
        <div className="mx-4 mb-3 rounded-xl bg-stone-100 flex items-center justify-center" style={{ aspectRatio: '1.75 / 1' }}>
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
            <button onClick={onRetake} disabled={disabled || isRunning}
              className="flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl border border-stone-200 text-sm font-medium text-stone-600 hover:bg-stone-50 active:bg-stone-100 disabled:opacity-40">
              <RotateCcw className="w-3.5 h-3.5" /> Retake
            </button>
            <button onClick={onDelete} disabled={disabled || isRunning}
              className="flex items-center justify-center gap-1.5 px-3.5 py-2.5 rounded-xl border border-red-100 text-red-500 hover:bg-red-50 active:bg-red-100 disabled:opacity-40">
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </>
        ) : (
          <button onClick={onCapture} disabled={disabled || isSaving}
            className={[
              'flex-1 flex items-center justify-center gap-1.5 py-3 rounded-xl text-sm font-semibold transition-all disabled:opacity-40',
              side === 'front' ? 'bg-amber-500 hover:bg-amber-400 text-stone-900' : 'bg-stone-800 hover:bg-stone-700 text-white',
            ].join(' ')}>
            {isSaving
              ? <><Loader2 className="w-4 h-4 animate-spin" /> Saving…</>
              : <><Camera className="w-4 h-4" /> {side === 'front' ? 'Capture Front' : 'Capture Back'}</>}
          </button>
        )}
      </div>
    </div>
  );
}

// ─── Multi-value chip input (phones / emails) ─────────────────────────────────

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
      <label className="text-sm font-medium text-stone-700 flex items-center gap-1.5">
        <Icon className="w-4 h-4 text-stone-400" />
        {label}
        {confidence && confidence !== 'unknown' && (
          <span className={`text-[10px] font-semibold ml-auto rounded-full px-2 py-0.5 ${
            confidence === 'high' ? 'bg-green-100 text-green-700' :
            confidence === 'medium' ? 'bg-yellow-100 text-yellow-700' :
            'bg-red-100 text-red-700'
          }`}>{confidence}</span>
        )}
      </label>
      {/* Chips */}
      {values.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {values.map((v, i) => (
            <span key={i} className={`flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium border ${
              confidence === 'high' ? 'bg-green-50 text-green-800 border-green-200' :
              confidence === 'medium' ? 'bg-yellow-50 text-yellow-800 border-yellow-200' :
              confidence === 'low' ? 'bg-red-50 text-red-800 border-red-200' :
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
      {/* Input */}
      <div className={`flex rounded-xl border bg-white overflow-hidden ${borderCls}`}>
        <input
          type={inputType}
          inputMode={inputType === 'tel' ? 'tel' : inputType === 'email' ? 'email' : 'text'}
          value={inputVal}
          onChange={e => setInputVal(e.target.value)}
          onBlur={commit}
          onKeyDown={e => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); commit(); } }}
          placeholder={placeholder ?? `Add ${label.toLowerCase()}…`}
          className="flex-1 px-3.5 py-3 text-sm text-stone-900 placeholder:text-stone-400 focus:outline-none bg-transparent"
        />
        <button type="button" onClick={commit}
          className="px-3 text-stone-400 hover:text-stone-700 border-l border-stone-100">
          <Plus className="w-4 h-4" />
        </button>
      </div>
      {confidence === 'low' && values.length > 0 && (
        <p className="text-[11px] text-red-500 flex items-center gap-1">
          <AlertCircle className="w-3 h-3" /> Please verify {label.toLowerCase()}
        </p>
      )}
    </div>
  );
}

// ─── Confidence-aware text field ──────────────────────────────────────────────

function ConfidenceField({ label, icon: Icon, value, confidence, onChange, onBlur, inputType = 'text', placeholder, required }: {
  label: string;
  icon: React.ElementType;
  value: string;
  confidence?: 'high' | 'medium' | 'low' | 'unknown';
  onChange: (v: string) => void;
  onBlur?: () => void;
  inputType?: string;
  placeholder?: string;
  required?: boolean;
}) {
  const borderCls =
    confidence === 'high'   ? 'border-green-300 ring-1 ring-green-200 focus:ring-green-300' :
    confidence === 'medium' ? 'border-yellow-300 ring-1 ring-yellow-200 focus:ring-yellow-300' :
    confidence === 'low'    ? 'border-red-300 ring-1 ring-red-200 focus:ring-red-300' :
    'border-stone-200 focus:border-stone-400 focus:ring-1 focus:ring-stone-100';

  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-sm font-medium text-stone-700 flex items-center gap-1.5">
        <Icon className="w-4 h-4 text-stone-400" />
        {label}
        {required && <span className="text-red-500 text-xs">*</span>}
        {confidence && confidence !== 'unknown' && (
          <span className={`text-[10px] font-semibold ml-auto rounded-full px-2 py-0.5 ${
            confidence === 'high' ? 'bg-green-100 text-green-700' :
            confidence === 'medium' ? 'bg-yellow-100 text-yellow-700' :
            'bg-red-100 text-red-700'
          }`}>{confidence}</span>
        )}
      </label>
      <input
        type={inputType}
        value={value}
        onChange={e => onChange(e.target.value)}
        onBlur={onBlur}
        placeholder={placeholder}
        className={`w-full rounded-xl border px-4 py-3.5 text-base text-stone-900 placeholder:text-stone-400 bg-white focus:outline-none transition-all duration-150 ${borderCls}`}
      />
      {confidence === 'low' && value && (
        <p className="text-[11px] text-red-500 flex items-center gap-1">
          <AlertCircle className="w-3 h-3" /> Please verify {label.toLowerCase()}
        </p>
      )}
    </div>
  );
}

// ─── Step dot ────────────────────────────────────────────────────────────────

function StepDot({ done, active, label, isFinish }: {
  done: boolean; active: boolean; label: string; isFinish?: boolean;
}) {
  return (
    <div className="flex flex-col items-center gap-1 min-w-0">
      <div className={[
        'w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 transition-all',
        done   ? 'bg-green-100 text-green-600' :
        active ? (isFinish ? 'bg-amber-100 text-amber-600 ring-2 ring-amber-300' : 'bg-amber-100 text-amber-600') :
                 'bg-stone-100 text-stone-400',
      ].join(' ')}>
        {done ? <Check className="w-3.5 h-3.5" /> :
         isFinish ? <ChevronRight className="w-3.5 h-3.5" /> :
         <Camera className="w-3.5 h-3.5" />}
      </div>
      <span className={[
        'text-[10px] font-medium text-center leading-tight',
        done ? 'text-green-600' : active ? 'text-amber-600' : 'text-stone-400',
      ].join(' ')}>{label}</span>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export function BusinessCardCapture({
  session, sessionId, onComplete, onBack, onAssetsChanged,
  onVisionResult, onOcrResult, onOcrStateChange, onOcrDiagnostics: _ignored,
  onDebugLog,
}: Props) {
  const [front, setFront] = useState<CardState>({ asset: null, status: 'empty' });
  const [back,  setBack]  = useState<CardState>({ asset: null, status: 'empty' });
  const [activeCapture, setActiveCapture] = useState<CardSide | null>(null);
  const [toast, setToast] = useState<{ msg: string; isError?: boolean } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Editable extracted fields — pre-populated by vision, editable by user
  const [editedName,    setEditedName]    = useState('');
  const [editedCompany, setEditedCompany] = useState('');
  const [editedDesig,   setEditedDesig]   = useState('');
  const [editedPhones,  setEditedPhones]  = useState<string[]>([]);
  const [editedEmails,  setEditedEmails]  = useState<string[]>([]);
  const [editedWebsite, setEditedWebsite] = useState('');
  const [editedAddress, setEditedAddress] = useState('');
  const [editedNotes,   setEditedNotes]   = useState('');
  const [showExtraFields, setShowExtraFields] = useState(false);

  const [lastVisionResult, setLastVisionResult] = useState<VisionResult | null>(null);

  const { visionState, runExtraction, cancelExtraction, resetExtraction } = useVisionExtraction();

  // Forward vision state to parent as legacy OCR shape
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
      // Restore draft field values
      if (d.clientName)   setEditedName(String(d.clientName));
      if (d.company)      setEditedCompany(String(d.company));
      if (d.designation)  setEditedDesig(String(d.designation));
      if (d.phoneNumbers && Array.isArray(d.phoneNumbers)) setEditedPhones(d.phoneNumbers as string[]);
      else if (d.phone)   setEditedPhones([String(d.phone)]);
      if (d.emails && Array.isArray(d.emails)) setEditedEmails(d.emails as string[]);
      else if (d.email)   setEditedEmails([String(d.email)]);
      if (d.website) { setEditedWebsite(String(d.website)); setShowExtraFields(true); }
      if (d.address) { setEditedAddress(String(d.address)); setShowExtraFields(true); }
      if (d.notes)   setEditedNotes(String(d.notes));
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
    setEditedName(f.fullName || '');
    setEditedCompany(f.company || '');
    setEditedDesig(f.designation || '');
    setEditedPhones(f.phoneNumbers.length > 0 ? f.phoneNumbers : []);
    setEditedEmails(f.emails.length > 0 ? f.emails : []);
    setEditedWebsite(f.website || '');
    setEditedAddress(f.address || '');
    setEditedNotes(f.notes || '');
    if (f.website || f.address) setShowExtraFields(true);
    setLastVisionResult(result);
    onVisionResult?.(result);
    onDebugLog?.('Vision extraction completed', {
      source:      result.source,
      confidence:  f.confidence,
      durationMs:  result.durationMs,
      fieldCount:  [f.fullName, f.company, f.designation, ...f.emails, ...f.phoneNumbers].filter(v => String(v).trim()).length,
      rawTextLen:  f.rawText.length,
    });

    // Forward as legacy OCR result for backend sync compatibility
    const legacyOcr: OcrResult = {
      assetId:        result.assetId,
      rawText:        f.rawText,
      fields: {
        clientName:   f.fullName  || undefined,
        company:      f.company   || undefined,
        phone:        f.phoneNumbers[0] || undefined,
        email:        f.emails[0]  || undefined,
        designation:  f.designation || undefined,
      },
      confidence:     f.confidence >= 0.75 ? 'high' : f.confidence >= 0.45 ? 'medium' : 'low',
      inferredFields: [
        f.fullName  ? 'clientName'  : null,
        f.company   ? 'company'     : null,
        f.phoneNumbers[0] ? 'phone' : null,
        f.emails[0] ? 'email'       : null,
        f.designation ? 'designation': null,
      ].filter(Boolean) as string[],
      ignoredLines:   [],
      completedAt:    result.completedAt,
    };
    onOcrResult?.(legacyOcr);
  }

  const handleRetry = useCallback(async () => {
    const asset = front.asset;
    if (!asset) return;
    resetExtraction();
    onDebugLog?.('Vision extraction retry initiated by user', { assetId: asset.id });
    const result = await runExtraction(asset.id, asset.dataUrl);
    if (result) applyVisionResult(result);
    else onDebugLog?.('Vision retry failed or cancelled', undefined, 'error');
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
      showToast(`${side === 'front' ? 'Front' : 'Back'} side saved`);
      notifyChange(
        side === 'front' ? newState : front,
        side === 'back'  ? newState : otherState,
      );

      if (side === 'front') {
        onDebugLog?.('Front captured — starting vision extraction', {
          assetId: asset.id, sizeBytes: asset.sizeBytes,
          dims: `${asset.storedWidth}×${asset.storedHeight}`,
        });

        const result = await runExtraction(asset.id, asset.dataUrl);
        if (result) applyVisionResult(result);
        else onDebugLog?.('Vision extraction failed or cancelled', undefined, 'error');
      } else {
        onDebugLog?.('Back side saved', { assetId: asset.id, sizeBytes: asset.sizeBytes });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to save image';
      setState({ asset: null, status: 'error', errorMsg: msg });
      showToast(msg, true);
      onDebugLog?.(`Capture error — ${msg}`, { side }, 'error');
    }
  }

  async function handleDelete(side: CardSide) {
    const target = side === 'front' ? front : back;
    if (!target.asset) return;
    if (side === 'front') { cancelExtraction(); resetExtraction(); }
    await deleteAsset(target.asset.id);
    const newState: CardState = { asset: null, status: 'empty' };
    if (side === 'front') { setFront(newState); notifyChange(newState, back); }
    else                  { setBack(newState);  notifyChange(front, newState); }
    showToast(`${side === 'front' ? 'Front' : 'Back'} image deleted`);
  }

  const isBusy    = front.status === 'saving' || back.status === 'saving';
  const isRunning = visionState.status !== 'idle' && visionState.status !== 'done' && visionState.status !== 'error';
  const canContinue = !!front.asset;
  const hasExtractionResult = visionState.status === 'done' && !!visionState.result;

  function buildDraftFromEdited() {
    return {
      clientName:   editedName.trim()    || undefined,
      company:      editedCompany.trim() || undefined,
      designation:  editedDesig.trim()   || undefined,
      phone:        editedPhones[0]      || undefined,
      email:        editedEmails[0]      || undefined,
      phoneNumbers: editedPhones.length > 0 ? editedPhones : undefined,
      emails:       editedEmails.length > 0 ? editedEmails : undefined,
      website:      editedWebsite.trim() || undefined,
      address:      editedAddress.trim() || undefined,
      notes:        editedNotes.trim()   || undefined,
      visionRawText: lastVisionResult?.fields.rawText,
      extractionSource: lastVisionResult?.source,
    };
  }

  function handleContinue() {
    if (!front.asset) return;
    const legacyOcr = visionState.result
      ? ({
          assetId:        visionState.result.assetId,
          rawText:        visionState.result.fields.rawText,
          fields: {
            clientName:  editedName   || undefined,
            company:     editedCompany || undefined,
            phone:       editedPhones[0] || undefined,
            email:       editedEmails[0] || undefined,
            designation: editedDesig  || undefined,
          },
          confidence:     visionState.result.fields.confidence >= 0.75 ? 'high' :
                          visionState.result.fields.confidence >= 0.45 ? 'medium' : 'low',
          inferredFields: [
            editedName    ? 'clientName'  : null,
            editedCompany ? 'company'     : null,
            editedPhones[0] ? 'phone'     : null,
            editedEmails[0] ? 'email'     : null,
            editedDesig   ? 'designation' : null,
          ].filter(Boolean) as string[],
          ignoredLines:   [],
          completedAt:    visionState.result.completedAt,
        } as OcrResult)
      : null;

    onComplete(front.asset.id, back.asset?.id ?? null, legacyOcr, visionState.result);
  }

  const fc = lastVisionResult?.fieldConfidence;
  const showBanner = visionState.status !== 'idle';

  return (
    <div className="mt-6 animate-in fade-in slide-in-from-bottom-3 duration-300">
      <div className="flex items-center justify-between mb-6">
        <button onClick={onBack}
          className="flex items-center gap-1.5 text-sm font-medium text-stone-500 hover:text-stone-800 transition-colors">
          <ArrowLeft className="w-4 h-4" /> Back to options
        </button>
      </div>

      {/* Header */}
      <div className="bg-white rounded-2xl border border-stone-200 shadow-sm overflow-hidden mb-4">
        <div className="px-5 pt-5 pb-4 border-b border-stone-100">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-amber-50 flex items-center justify-center flex-shrink-0">
              <FlipHorizontal className="w-[18px] h-[18px] text-amber-600" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-stone-900 leading-tight">Scan Business Card</h2>
              <p className="text-xs text-stone-500 mt-0.5">AI-powered contact extraction</p>
            </div>
          </div>
        </div>
        <div className="px-5 py-3.5 flex items-center gap-3">
          <StepDot done={!!front.asset} active={!front.asset} label="Capture" />
          <div className="flex-1 h-px bg-stone-100" />
          <StepDot done={hasExtractionResult} active={isRunning} label="Extract" />
          <div className="flex-1 h-px bg-stone-100" />
          <StepDot done={false} active={canContinue && !isRunning} label="Continue" isFinish />
        </div>
      </div>

      {/* Extraction banner */}
      {showBanner && (
        <div className="mb-4 animate-in fade-in duration-200">
          <ExtractionBanner
            visionState={visionState}
            onDismiss={resetExtraction}
            onRetry={visionState.status === 'error' && front.asset ? handleRetry : undefined}
          />
        </div>
      )}

      {/* Capture cards */}
      <div className="flex flex-col gap-4 mb-4">
        <PreviewCard side="front" asset={front.asset} status={front.status} errorMsg={front.errorMsg}
          isRunning={isRunning} onCapture={() => setActiveCapture('front')}
          onRetake={() => setActiveCapture('front')} onDelete={() => handleDelete('front')} disabled={isBusy} />
        {(front.asset || back.asset) && (
          <PreviewCard side="back" asset={back.asset} status={back.status} errorMsg={back.errorMsg}
            onCapture={() => setActiveCapture('back')} onRetake={() => setActiveCapture('back')}
            onDelete={() => handleDelete('back')} disabled={isBusy} />
        )}
      </div>

      {/* Extracted fields review — shown after extraction */}
      {(hasExtractionResult || (front.asset && !isRunning)) && (
        <div className="bg-white rounded-2xl border border-stone-200 shadow-sm overflow-hidden mb-4 animate-in fade-in slide-in-from-bottom-2 duration-300">
          <div className="px-5 pt-4 pb-3 border-b border-stone-100 flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-amber-500 flex-shrink-0" />
            <span className="text-sm font-semibold text-stone-900">
              {hasExtractionResult ? 'Extracted Details' : 'Contact Details'}
            </span>
            <span className="ml-auto text-[11px] text-stone-400">All fields editable</span>
          </div>

          <div className="px-5 py-4 flex flex-col gap-4">
            <ConfidenceField label="Full Name" icon={({ className }: { className?: string }) => <span className={`${className} inline-flex`}>👤</span>}
              value={editedName} confidence={fc?.fullName} required
              onChange={setEditedName}
              placeholder="e.g. Rahul Sharma" />

            <ConfidenceField label="Company" icon={({ className }: { className?: string }) => <span className={`${className} inline-flex`}>🏢</span>}
              value={editedCompany} confidence={fc?.company} required
              onChange={setEditedCompany}
              placeholder="e.g. Acme Retail Pvt Ltd" />

            <ConfidenceField label="Designation" icon={({ className }: { className?: string }) => <span className={`${className} inline-flex`}>💼</span>}
              value={editedDesig} confidence={fc?.designation}
              onChange={setEditedDesig}
              placeholder="e.g. Purchase Manager" />

            <ChipInput label="Phone Numbers" icon={Phone}
              values={editedPhones} confidence={fc?.phoneNumbers}
              onAdd={v => setEditedPhones(p => [...p, v])}
              onRemove={i => setEditedPhones(p => p.filter((_, j) => j !== i))}
              inputType="tel" placeholder="+91 98765 43210" />

            <ChipInput label="Email Addresses" icon={Mail}
              values={editedEmails} confidence={fc?.emails}
              onAdd={v => setEditedEmails(p => [...p, v])}
              onRemove={i => setEditedEmails(p => p.filter((_, j) => j !== i))}
              inputType="email" placeholder="name@company.com" />

            {/* Extra fields */}
            {!showExtraFields && (
              <button onClick={() => setShowExtraFields(true)}
                className="text-xs text-stone-500 hover:text-stone-700 text-left flex items-center gap-1">
                <Plus className="w-3.5 h-3.5" /> Add website, address, notes
              </button>
            )}
            {showExtraFields && (
              <>
                <ConfidenceField label="Website" icon={Globe}
                  value={editedWebsite} confidence={fc?.website}
                  onChange={setEditedWebsite} placeholder="https://company.com" />
                <ConfidenceField label="Address" icon={MapPin}
                  value={editedAddress} confidence={fc?.address}
                  onChange={setEditedAddress} placeholder="City, State" />
                <div className="flex flex-col gap-1.5">
                  <label className="text-sm font-medium text-stone-700">Notes</label>
                  <textarea value={editedNotes} onChange={e => setEditedNotes(e.target.value)}
                    placeholder="e.g. Met at booth 12, interested in oud range…" rows={3}
                    className="w-full rounded-xl border border-stone-200 px-4 py-3 text-sm text-stone-900 placeholder:text-stone-400 bg-white focus:outline-none focus:border-stone-400 focus:ring-1 focus:ring-stone-100 resize-none" />
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Continue button */}
      {canContinue && (
        <div className="flex flex-col gap-3 animate-in fade-in duration-200">
          <button onClick={handleContinue} disabled={isBusy}
            className="w-full flex items-center justify-center gap-2 bg-stone-900 hover:bg-stone-800 active:bg-stone-950 active:scale-[0.98] text-white font-semibold rounded-xl py-4 text-base transition-all duration-150 shadow-sm disabled:opacity-40">
            <CheckCircle2 className="w-5 h-5" />
            {isRunning ? 'Extracting… Continue Anyway' :
             back.asset ? 'Continue with Both Sides' : 'Continue with Front Only'}
            <ChevronRight className="w-4 h-4 opacity-60" />
          </button>
          {!back.asset && !isRunning && (
            <p className="text-center text-xs text-stone-400">Back side is optional — you can skip it</p>
          )}
        </div>
      )}

      {activeCapture && (
        <CameraSheet side={activeCapture}
          onCapture={dataUrl => handleCapture(activeCapture, dataUrl)}
          onCancel={() => setActiveCapture(null)} />
      )}

      <Toast message={toast?.msg ?? null} isError={toast?.isError} />
    </div>
  );
}

// ─── Draft helper used by CaptureLeadPage ─────────────────────────────────────
// Exported so CaptureLeadPage can read the edited state on Continue.
export type { Props as BusinessCardCaptureProps };
