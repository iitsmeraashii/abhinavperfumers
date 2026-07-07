import { useState, useRef, useEffect, useCallback } from 'react';
import {
  ArrowLeft, User, Building2, Phone, Mail, Briefcase,
  CheckCircle2, Wifi, WifiOff, Trash2, ChevronDown, ChevronRight,
  Mic, Square, Camera, X, Image as ImageIcon,
  Flame, Thermometer, Snowflake,
  Plus, Minus, ArrowRight, Loader2, AlertCircle,
  Globe, MapPin,
} from 'lucide-react';
import { supabase } from '../supabaseClient';
import type { CaptureSession, DraftData, LeadTemperature, LeadType, ApplicationOption } from './types';
import { APPLICATION_OPTIONS } from './types';
import type { UseManualEntryFormReturn } from './useManualEntryForm';
import { Toast, DiscardDialog, DraftSaveIndicator } from './CaptureUI';
import type { SaveState } from './useAutosave';

// ─── Shared primitives ────────────────────────────────────────────────────────

function inputCls(hasError = false) {
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

function SectionHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="mb-4">
      <h3 className="text-sm font-semibold text-stone-800">{title}</h3>
      {subtitle && <p className="text-xs text-stone-400 mt-0.5">{subtitle}</p>}
    </div>
  );
}

function FieldLabel({ label, optional }: { label: string; optional?: boolean }) {
  return (
    <label className="text-[13px] font-medium text-stone-600 flex items-center gap-1.5 mb-1.5">
      {label}
      {optional && <span className="text-stone-400 text-[11px] font-normal">(optional)</span>}
    </label>
  );
}

function SessionStatusBar({ session, isOnline }: { session: CaptureSession; isOnline: boolean }) {
  const labels: Record<string, string> = {
    IDLE: 'Idle', CAPTURING: 'Capturing', DRAFT: 'Saved', READY_FOR_REVIEW: 'Ready',
  };
  return (
    <div className="flex items-center gap-3 flex-wrap text-[11px] text-stone-400">
      <span className="flex items-center gap-1">
        <span className="font-medium text-stone-500">Status:</span>
        <span className={session.sessionStatus === 'DRAFT' ? 'text-green-600 font-medium' : 'text-stone-400'}>
          {labels[session.sessionStatus] ?? session.sessionStatus}
        </span>
      </span>
      <span className="text-stone-200">&middot;</span>
      <span className={`flex items-center gap-1 ${isOnline ? 'text-green-600' : 'text-amber-600'}`}>
        {isOnline ? <Wifi className="w-3 h-3" /> : <WifiOff className="w-3 h-3" />}
        {isOnline ? 'Online' : 'Offline'}
      </span>
      {session.sessionStatus === 'DRAFT' && (
        <>
          <span className="text-stone-200">&middot;</span>
          <span className="flex items-center gap-1 text-green-600 font-medium">
            <CheckCircle2 className="w-3 h-3" /> Saved locally
          </span>
        </>
      )}
    </div>
  );
}

// ─── Lead temperature pills ───────────────────────────────────────────────────

const TEMP_OPTIONS: { value: LeadTemperature; label: string; icon: React.ReactNode; color: string; activeColor: string }[] = [
  { value: 'Hot',  label: 'Hot',  icon: <Flame className="w-4 h-4" />,       color: 'text-stone-500', activeColor: 'bg-red-600 text-white ring-red-200' },
  { value: 'Warm', label: 'Warm', icon: <Thermometer className="w-4 h-4" />, color: 'text-stone-500', activeColor: 'bg-amber-500 text-white ring-amber-200' },
  { value: 'Cold', label: 'Cold', icon: <Snowflake className="w-4 h-4" />,   color: 'text-stone-500', activeColor: 'bg-sky-500 text-white ring-sky-200' },
];

function LeadTemperaturePicker({ value, onChange }: { value?: LeadTemperature; onChange: (v: LeadTemperature) => void }) {
  return (
    <div>
      <FieldLabel label="Lead Temperature" optional />
      <div className="grid grid-cols-3 gap-2">
        {TEMP_OPTIONS.map(opt => {
          const active = value === opt.value;
          return (
            <button
              key={opt.value}
              type="button"
              onClick={() => onChange(opt.value)}
              className={`flex items-center justify-center gap-2 py-3.5 rounded-xl font-medium text-sm
                transition-all duration-150 ring-2 active:scale-[0.97]
                ${active
                  ? `${opt.activeColor} shadow-sm`
                  : 'bg-white border border-stone-200 text-stone-600 ring-transparent hover:border-stone-300'}`}
            >
              {opt.icon}
              {opt.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ─── Voice note UI ────────────────────────────────────────────────────────────

export type VoiceTranscriptionStatus =
  | 'none'         // no recording yet
  | 'pending'      // recorded, waiting for upload/transcription to start
  | 'transcribing' // edge function is running Whisper
  | 'ready'        // transcript is available
  | 'failed';      // transcription failed — recording is NOT lost

function VoiceTranscriptBlock({
  status,
  transcript,
  onTranscriptChange,
  onRetry,
}: {
  status: VoiceTranscriptionStatus;
  transcript: string;
  onTranscriptChange: (value: string) => void;
  onRetry?: () => void;
}) {
  if (status === 'none') return null;

  if (status === 'pending') {
    return (
      <div className="mt-3">
        <div className="flex items-center gap-1.5 mb-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-stone-300" />
          <span className="text-[11px] font-semibold text-stone-400 uppercase tracking-wide">AI Transcript</span>
        </div>
        <div className="flex items-center gap-2.5 px-4 py-3 bg-stone-50 rounded-xl border border-stone-200">
          <Loader2 className="w-3.5 h-3.5 text-stone-400 animate-spin flex-shrink-0" />
          <span className="text-sm text-stone-400">Preparing transcription…</span>
        </div>
      </div>
    );
  }

  if (status === 'transcribing') {
    return (
      <div className="mt-3">
        <div className="flex items-center gap-1.5 mb-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
          <span className="text-[11px] font-semibold text-stone-400 uppercase tracking-wide">AI Transcript</span>
        </div>
        <div className="flex items-center gap-2.5 px-4 py-3 bg-amber-50 rounded-xl border border-amber-200">
          <Loader2 className="w-3.5 h-3.5 text-amber-500 animate-spin flex-shrink-0" />
          <span className="text-sm text-amber-700">Generating transcript…</span>
        </div>
      </div>
    );
  }

  if (status === 'failed') {
    return (
      <div className="mt-3">
        <div className="flex items-center gap-1.5 mb-1.5">
          <AlertCircle className="w-3.5 h-3.5 text-amber-500" />
          <span className="text-[11px] font-semibold text-amber-600 uppercase tracking-wide">AI Transcript</span>
        </div>
        <div className="flex items-center justify-between px-4 py-3 bg-amber-50 rounded-xl border border-amber-200">
          <span className="text-sm text-amber-700">Couldn't generate transcript.</span>
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              className="ml-3 text-xs font-semibold text-amber-700 hover:text-amber-900 underline underline-offset-2 transition-colors"
            >
              Retry
            </button>
          )}
        </div>
      </div>
    );
  }

  // status === 'ready'
  return (
    <div className="mt-3">
      <div className="flex items-center gap-1.5 mb-1.5">
        <CheckCircle2 className="w-3.5 h-3.5 text-green-600" />
        <span className="text-[11px] font-semibold text-green-600 uppercase tracking-wide">AI Transcript</span>
      </div>
      <textarea
        rows={3}
        value={transcript}
        onChange={e => onTranscriptChange(e.target.value)}
        placeholder="Transcript will appear here…"
        className={`${inputCls()} resize-none text-sm leading-relaxed`}
      />
    </div>
  );
}

function VoiceNoteRecorder({
  durationMs,
  transcript,
  transcriptionStatus,
  onUpdate,
  onBlobReady,
  onRetryTranscription,
}: {
  durationMs?: number;
  transcript?: string;
  transcriptionStatus?: VoiceTranscriptionStatus;
  onUpdate: (patch: Partial<DraftData>) => void;
  onBlobReady?: (blob: Blob, durationMs: number, mimeType: string) => void;
  onRetryTranscription?: () => void;
}) {
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed]     = useState(durationMs ?? 0);
  const timerRef    = useRef<ReturnType<typeof setInterval> | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef   = useRef<Blob[]>([]);
  const streamRef   = useRef<MediaStream | null>(null);
  const elapsedRef  = useRef(0);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      recorderRef.current?.stop();
      streamRef.current?.getTracks().forEach(t => t.stop());
    };
  }, []);

  async function handleStart() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      chunksRef.current = [];
      elapsedRef.current = 0;

      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/ogg;codecs=opus')
          ? 'audio/ogg;codecs=opus'
          : 'audio/mp4';

      const recorder = new MediaRecorder(stream, { mimeType });
      recorderRef.current = recorder;

      recorder.ondataavailable = e => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: mimeType });
        streamRef.current?.getTracks().forEach(t => t.stop());
        streamRef.current = null;
        const ms = elapsedRef.current;
        onUpdate({ voiceNoteDurationMs: ms, voiceNoteTranscript: '' });
        onBlobReady?.(blob, ms, mimeType);
      };

      recorder.start();
      setRecording(true);
      setElapsed(0);
      timerRef.current = setInterval(() => {
        elapsedRef.current += 1000;
        setElapsed(prev => prev + 1000);
      }, 1000);
    } catch {
      // microphone permission denied or unavailable — silently ignore
    }
  }

  function handleStop() {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    recorderRef.current?.stop();
    recorderRef.current = null;
    setRecording(false);
  }

  function handleClear() {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    recorderRef.current?.stop();
    recorderRef.current = null;
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
    setRecording(false);
    setElapsed(0);
    elapsedRef.current = 0;
    onUpdate({ voiceNoteDurationMs: undefined, voiceNoteTranscript: undefined });
  }

  function formatTime(ms: number) {
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${m}:${sec.toString().padStart(2, '0')}`;
  }

  const hasRecording = (durationMs ?? 0) > 0 && !recording;
  const effectiveStatus: VoiceTranscriptionStatus =
    !hasRecording             ? 'none'
    : transcriptionStatus     ? transcriptionStatus
    : transcript              ? 'ready'
    : 'pending';

  return (
    <div>
      <FieldLabel label="Voice Note" optional />
      <div className="flex items-center gap-3">
        {recording ? (
          <>
            <button
              type="button"
              onClick={handleStop}
              className="flex items-center justify-center w-14 h-14 rounded-full
                bg-red-600 text-white shadow-lg active:scale-95 transition-transform"
              aria-label="Stop recording"
            >
              <Square className="w-5 h-5 fill-current" />
            </button>
            <div className="flex-1">
              <p className="text-sm font-medium text-red-600 flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
                Recording…
              </p>
              <p className="text-xs text-stone-400 mt-0.5 font-mono">{formatTime(elapsed)}</p>
            </div>
          </>
        ) : hasRecording ? (
          <>
            <div className={`w-14 h-14 rounded-full flex items-center justify-center transition-colors ${
              effectiveStatus === 'ready'        ? 'bg-green-50'
              : effectiveStatus === 'failed'     ? 'bg-amber-50'
              : effectiveStatus === 'transcribing' ? 'bg-amber-50'
              : 'bg-stone-100'
            }`}>
              <Mic className={`w-5 h-5 ${
                effectiveStatus === 'ready'          ? 'text-green-600'
                : effectiveStatus === 'failed'       ? 'text-amber-500'
                : effectiveStatus === 'transcribing' ? 'text-amber-500'
                : 'text-stone-500'
              }`} />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-stone-700">Voice note recorded</p>
              <p className="text-xs text-stone-400 font-mono">{formatTime(durationMs!)}</p>
            </div>
            <button
              type="button"
              onClick={handleClear}
              className="p-2 text-stone-400 hover:text-red-500 transition-colors"
              aria-label="Remove voice note"
            >
              <X className="w-4 h-4" />
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              onClick={handleStart}
              className="flex items-center justify-center w-14 h-14 rounded-full
                bg-stone-900 text-white shadow-md hover:bg-stone-800
                active:scale-95 transition-all"
              aria-label="Start recording"
            >
              <Mic className="w-5 h-5" />
            </button>
            <p className="text-sm text-stone-400">Tap to record a voice note</p>
          </>
        )}
      </div>

      <VoiceTranscriptBlock
        status={effectiveStatus}
        transcript={transcript ?? ''}
        onTranscriptChange={value => onUpdate({ voiceNoteTranscript: value })}
        onRetry={onRetryTranscription}
      />
    </div>
  );
}

// ─── Notes image capture ──────────────────────────────────────────────────────

function NotesImageCapture({
  imageDataUrl,
  onCapture,
  onRemove,
}: {
  imageDataUrl?: string;
  onCapture: (dataUrl: string) => void;
  onRemove: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') onCapture(reader.result);
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  }

  if (imageDataUrl) {
    return (
      <div>
        <FieldLabel label="Notes Image" optional />
        <div className="relative rounded-xl overflow-hidden border border-stone-200">
          <img src={imageDataUrl} alt="Notes" className="w-full max-h-48 object-cover" />
          <div className="absolute top-2 right-2 flex gap-1.5">
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-white/90 text-xs font-medium
                text-stone-700 shadow-sm hover:bg-white transition-colors"
            >
              <Camera className="w-3 h-3" /> Retake
            </button>
            <button
              type="button"
              onClick={onRemove}
              className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-white/90 text-xs font-medium
                text-red-600 shadow-sm hover:bg-white transition-colors"
            >
              <X className="w-3 h-3" /> Remove
            </button>
          </div>
        </div>
        <input ref={inputRef} type="file" accept="image/*" capture="environment" onChange={handleFile} className="hidden" />
      </div>
    );
  }

  return (
    <div>
      <FieldLabel label="Notes Image" optional />
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        className="w-full flex items-center justify-center gap-2 py-4 rounded-xl
          border-2 border-dashed border-stone-200 text-stone-400
          hover:border-stone-300 hover:text-stone-500 active:bg-stone-50
          transition-colors"
      >
        <ImageIcon className="w-5 h-5" />
        <span className="text-sm font-medium">Attach photo of notes, catalog, or pricing</span>
      </button>
      <input ref={inputRef} type="file" accept="image/*" capture="environment" onChange={handleFile} className="hidden" />
    </div>
  );
}

// ─── Application multi-select chips ───────────────────────────────────────────

function ApplicationChips({
  selected,
  onChange,
}: {
  selected: ApplicationOption[];
  onChange: (v: ApplicationOption[]) => void;
}) {
  function toggle(opt: ApplicationOption) {
    if (selected.includes(opt)) {
      onChange(selected.filter(s => s !== opt));
    } else {
      onChange([...selected, opt]);
    }
  }

  return (
    <div>
      <FieldLabel label="Application" optional />
      <div className="flex flex-wrap gap-2">
        {APPLICATION_OPTIONS.map(opt => {
          const active = selected.includes(opt);
          return (
            <button
              key={opt}
              type="button"
              onClick={() => toggle(opt)}
              className={`px-3 py-2 rounded-lg text-sm font-medium transition-all duration-150 active:scale-95
                ${active
                  ? 'bg-stone-900 text-white shadow-sm'
                  : 'bg-stone-100 text-stone-600 hover:bg-stone-200'}`}
            >
              {opt}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ─── Price range with quick insert buttons ────────────────────────────────────

function PriceRangeInput({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  function insert(char: string) {
    const el = inputRef.current;
    if (!el) { onChange(value + char); return; }
    const start = el.selectionStart ?? value.length;
    const end   = el.selectionEnd   ?? value.length;
    const next  = value.slice(0, start) + char + value.slice(end);
    onChange(next);
    requestAnimationFrame(() => {
      el.selectionStart = el.selectionEnd = start + char.length;
      el.focus();
    });
  }

  return (
    <div>
      <FieldLabel label="Price Range" optional />
      <input
        ref={inputRef}
        type="text"
        inputMode="text"
        placeholder="e.g. 500 - 1200 per kg"
        value={value}
        onChange={e => onChange(e.target.value)}
        className={inputCls()}
      />
      <div className="flex gap-2 mt-2">
        {['<', '>', '=', '-', 'INR', 'USD'].map(ch => (
          <button
            key={ch}
            type="button"
            onClick={() => insert(ch === 'INR' || ch === 'USD' ? ch + ' ' : ch + ' ')}
            className="px-3 py-2 rounded-lg bg-stone-100 text-stone-600 text-sm font-mono
              hover:bg-stone-200 active:bg-stone-300 active:scale-95 transition-all"
          >
            {ch}
          </button>
        ))}
      </div>
    </div>
  );
}

// ─── Lead type selector ───────────────────────────────────────────────────────

function LeadTypePicker({ value, onChange }: { value?: LeadType; onChange: (v: LeadType) => void }) {
  return (
    <div>
      <FieldLabel label="Lead Type" optional />
      <div className="grid grid-cols-2 gap-2">
        {(['NEW', 'EXISTING'] as const).map(t => {
          const active = value === t;
          return (
            <button
              key={t}
              type="button"
              onClick={() => onChange(t)}
              className={`py-3 rounded-xl text-sm font-semibold transition-all duration-150 active:scale-[0.97]
                ${active
                  ? 'bg-stone-900 text-white shadow-sm'
                  : 'bg-white border border-stone-200 text-stone-600 hover:border-stone-300'}`}
            >
              {t}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ─── Previous rep search dropdown ─────────────────────────────────────────────

function PreviousRepSelect({
  value,
  onChange,
}: {
  value: string;
  onChange: (code: string) => void;
}) {
  const [open, setOpen]   = useState(false);
  const [search, setSearch] = useState('');
  const [reps, setReps]   = useState<{ rep_code: string; name: string }[]>([]);
  const [loaded, setLoaded] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  async function loadReps() {
    if (loaded) return;
    const { data } = await supabase
      .from('sales_representatives')
      .select('rep_code, name')
      .eq('is_active', true)
      .order('name');
    if (data) setReps(data);
    setLoaded(true);
  }

  function handleOpen() {
    loadReps();
    setOpen(true);
    setSearch('');
  }

  const filtered = search
    ? reps.filter(r =>
        r.name.toLowerCase().includes(search.toLowerCase()) ||
        r.rep_code.toLowerCase().includes(search.toLowerCase()))
    : reps;

  const selectedRep = reps.find(r => r.rep_code === value);

  return (
    <div ref={ref} className="relative">
      <FieldLabel label="Previous Associated Rep" optional />
      <button
        type="button"
        onClick={handleOpen}
        className={`w-full flex items-center justify-between gap-2 px-4 py-3.5 bg-white
          border border-stone-200 rounded-xl text-sm hover:border-stone-300 transition-colors`}
      >
        <span className={value ? 'text-stone-900 font-medium' : 'text-stone-400'}>
          {selectedRep ? `${selectedRep.name} (${selectedRep.rep_code})` : 'Select rep…'}
        </span>
        <ChevronDown className={`w-4 h-4 text-stone-400 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="absolute z-30 top-full mt-1.5 inset-x-0 bg-white border border-stone-200
          rounded-xl shadow-xl overflow-hidden max-h-56">
          <div className="px-3 pt-3 pb-2">
            <input
              type="text"
              placeholder="Search reps…"
              autoFocus
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border border-stone-200 text-sm
                focus:outline-none focus:ring-1 focus:ring-stone-300"
            />
          </div>
          <div className="max-h-40 overflow-y-auto">
            {filtered.length === 0 ? (
              <p className="px-4 py-3 text-sm text-stone-400">No reps found</p>
            ) : (
              filtered.map(r => (
                <button
                  key={r.rep_code}
                  type="button"
                  onClick={() => { onChange(r.rep_code); setOpen(false); }}
                  className={`w-full text-left px-4 py-2.5 text-sm hover:bg-stone-50 transition-colors
                    ${value === r.rep_code ? 'bg-stone-100 font-medium text-stone-900' : 'text-stone-700'}`}
                >
                  {r.name} <span className="text-stone-400 font-mono text-xs ml-1">{r.rep_code}</span>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Quick keywords input ─────────────────────────────────────────────────────

function KeywordsInput({ values, onChange }: { values: string[]; onChange: (v: string[]) => void }) {
  const [input, setInput] = useState('');

  function add() {
    const trimmed = input.trim();
    if (!trimmed || values.includes(trimmed)) return;
    onChange([...values, trimmed]);
    setInput('');
  }

  function remove(tag: string) {
    onChange(values.filter(v => v !== tag));
  }

  return (
    <div>
      <FieldLabel label="Quick Keywords" optional />
      <div className="flex gap-2">
        <input
          type="text"
          placeholder="Add keyword…"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
          className={`${inputCls()} flex-1 text-sm`}
        />
        <button
          type="button"
          onClick={add}
          className="flex items-center justify-center w-12 rounded-xl bg-stone-900 text-white
            hover:bg-stone-800 active:scale-95 transition-all shrink-0"
          aria-label="Add keyword"
        >
          <Plus className="w-4 h-4" />
        </button>
      </div>
      {values.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mt-2">
          {values.map(kw => (
            <span
              key={kw}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-stone-100 text-sm text-stone-700"
            >
              {kw}
              <button type="button" onClick={() => remove(kw)} className="text-stone-400 hover:text-stone-700">
                <X className="w-3 h-3" />
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Generic array-tag input (Target Market, Certification, Benchmark) ────────

function TagArrayInput({ label, values, onChange, placeholder }: {
  label: string;
  values: string[];
  onChange: (v: string[]) => void;
  placeholder: string;
}) {
  const [input, setInput] = useState('');
  function add() {
    const t = input.trim();
    if (!t || values.includes(t)) return;
    onChange([...values, t]);
    setInput('');
  }
  function remove(tag: string) { onChange(values.filter(v => v !== tag)); }

  return (
    <div>
      <FieldLabel label={label} optional />
      <div className="flex gap-2">
        <input
          type="text"
          placeholder={placeholder}
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
          className={`${inputCls()} flex-1 text-sm`}
        />
        <button
          type="button" onClick={add}
          className="flex items-center justify-center w-12 rounded-xl bg-stone-100 text-stone-600
            hover:bg-stone-200 active:scale-95 transition-all shrink-0"
          aria-label={`Add ${label.toLowerCase()}`}
        >
          <Plus className="w-4 h-4" />
        </button>
      </div>
      {values.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mt-2">
          {values.map(v => (
            <span key={v} className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-stone-100 text-sm text-stone-700">
              {v}
              <button type="button" onClick={() => remove(v)} className="text-stone-400 hover:text-stone-700">
                <Minus className="w-3 h-3" />
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Collapsible section wrapper ──────────────────────────────────────────────

function CollapsibleSection({
  title,
  defaultOpen,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen ?? false);
  return (
    <div className="border border-stone-200 rounded-2xl bg-white overflow-hidden shadow-sm">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between px-5 py-4 text-left
          hover:bg-stone-50 transition-colors"
      >
        <span className="text-sm font-semibold text-stone-700">{title}</span>
        {open
          ? <ChevronDown className="w-4 h-4 text-stone-400" />
          : <ChevronRight className="w-4 h-4 text-stone-400" />}
      </button>
      {open && <div className="px-5 pb-5 space-y-5 border-t border-stone-100 pt-4">{children}</div>}
    </div>
  );
}

// ─── Main form ────────────────────────────────────────────────────────────────

interface Props {
  session:       CaptureSession;
  isOnline:      boolean;
  saveState?:    SaveState;
  form:          UseManualEntryFormReturn;
  onBack:        () => void;
  onDiscard:     () => Promise<void>;
  onSaveAndNext?: () => Promise<{ error?: string } | void>;
  onVoiceNoteRecorded?: (blob: Blob, durationMs: number, mimeType: string) => void;
}

export function ManualEntryForm({ session, isOnline, saveState = 'idle', form, onBack, onDiscard, onSaveAndNext, onVoiceNoteRecorded }: Props) {
  const {
    toastMessage, toastIsError, handleChange, handleBlur,
    handlePatchDraft, handleSaveDraft,
  } = form;
  const [showDiscardDialog, setShowDiscardDialog] = useState(false);
  const [saving, setSaving] = useState(false);
  // Suppress the "Lead saved" draft toast while promotion is in flight so it
  // doesn't appear alongside a promotion error toast from the parent.
  const [promotionActive, setPromotionActive] = useState(false);

  const d = session.draftData;
  const clientName      = String(d.clientName ?? '');
  const company         = String(d.company ?? '');
  const phone           = String(d.phone ?? '');
  const email           = String(d.email ?? '');
  const designation     = String(d.designation ?? '');
  const notes           = String(d.notes ?? '');
  const leadTemperature = d.leadTemperature as LeadTemperature | undefined;
  const leadType        = d.leadType as LeadType | undefined;
  const previousRepCode = String(d.previousRepCode ?? '');
  const application     = (d.application ?? []) as ApplicationOption[];
  const priceRange      = String(d.priceRange ?? '');
  const quickKeywords   = (d.quickKeywords ?? []) as string[];
  const targetMarket    = (d.targetMarket ?? []) as string[];
  const certification   = (d.certification ?? []) as string[];
  const benchmark       = (d.benchmark ?? []) as string[];
  const notesImage      = d.notesImageDataUrl as string | undefined;
  const voiceDuration   = d.voiceNoteDurationMs as number | undefined;
  const voiceTranscript = d.voiceNoteTranscript as string | undefined;
  const website         = String(d.website ?? '');
  const address         = String(d.address  ?? '');

  const hasDraftData = !!(clientName || company || phone || notes || notesImage);
  const backendSessionId = session.sync.backendSessionId;

  // Track polled transcription status separately from draft data so we can
  // auto-populate the transcript the first time it arrives without overwriting
  // edits the user made afterward.
  const [polledTranscriptionStatus, setPolledTranscriptionStatus] = useState<
    null | 'transcribing' | 'ready' | 'failed'
  >(null);
  // Ref always holds the latest transcript so the async poll callback can
  // read it without being listed as an effect dependency.
  const voiceTranscriptRef = useRef(voiceTranscript);
  voiceTranscriptRef.current = voiceTranscript;

  // Reset polled status whenever the recording is cleared.
  useEffect(() => {
    if (!voiceDuration) setPolledTranscriptionStatus(null);
  }, [voiceDuration]);

  // Poll DB every 3 s while transcription is in-flight.
  useEffect(() => {
    if (!backendSessionId || (voiceDuration ?? 0) <= 0) return;
    if (polledTranscriptionStatus === 'ready' || polledTranscriptionStatus === 'failed') return;

    let cancelled = false;

    async function poll() {
      const { data: asset } = await supabase
        .from('capture_assets')
        .select('transcription_status')
        .eq('capture_session_id', backendSessionId)
        .eq('asset_type', 'voice_note')
        .maybeSingle();

      if (cancelled) return;
      const status = (asset as { transcription_status?: string | null } | null)
        ?.transcription_status ?? null;

      if (status === 'ready') {
        // Fetch transcript and auto-populate only if user hasn't typed anything.
        const { data: sessionRow } = await supabase
          .from('capture_sessions')
          .select('voice_note_transcript')
          .eq('id', backendSessionId)
          .maybeSingle();

        if (!cancelled) {
          const transcript = (sessionRow as { voice_note_transcript?: string | null } | null)
            ?.voice_note_transcript ?? null;
          if (transcript && !voiceTranscriptRef.current) {
            handlePatchDraft({ voiceNoteTranscript: transcript });
          }
          setPolledTranscriptionStatus('ready');
        }
      } else if (status === 'failed') {
        if (!cancelled) setPolledTranscriptionStatus('failed');
      } else if (status === 'transcribing') {
        if (!cancelled) setPolledTranscriptionStatus('transcribing');
      }
    }

    void poll();
    const id = setInterval(() => { void poll(); }, 3000);
    return () => { cancelled = true; clearInterval(id); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backendSessionId, voiceDuration, polledTranscriptionStatus]);

  const computedTranscriptionStatus: VoiceTranscriptionStatus = (() => {
    if ((voiceDuration ?? 0) <= 0) return 'none';
    if (polledTranscriptionStatus === 'transcribing') return 'transcribing';
    if (polledTranscriptionStatus === 'ready' || voiceTranscript) return 'ready';
    if (polledTranscriptionStatus === 'failed') return 'failed';
    return 'pending';
  })();

  const handleSaveAndNext = useCallback(async () => {
    setSaving(true);
    const ok = await handleSaveDraft(session);
    if (!ok) { setSaving(false); return; }
    setPromotionActive(true); // hide the "Lead saved" draft toast
    if (onSaveAndNext) {
      const result = await onSaveAndNext();
      setPromotionActive(false);
      setSaving(false);
      void result;
    } else {
      setPromotionActive(false);
      setSaving(false);
    }
  }, [handleSaveDraft, session, onSaveAndNext]);

  const handleContinueEnrich = useCallback(async () => {
    setSaving(true);
    await handleSaveDraft(session);
    setSaving(false);
  }, [handleSaveDraft, session]);

  async function handleDiscardConfirm() {
    setShowDiscardDialog(false);
    await onDiscard();
  }

  return (
    <div className="mt-4 animate-in fade-in slide-in-from-bottom-3 duration-300 pb-28">
      {/* Back / Discard row */}
      <div className="flex items-center justify-between mb-5">
        <button
          onClick={onBack}
          className="flex items-center gap-1.5 text-sm font-medium text-stone-500 hover:text-stone-800 transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          Back
        </button>
        {hasDraftData && (
          <button
            onClick={() => setShowDiscardDialog(true)}
            className="flex items-center gap-1 text-sm text-red-500 hover:text-red-700 transition-colors"
          >
            <Trash2 className="w-3.5 h-3.5" />
            Discard
          </button>
        )}
      </div>

      <div className="space-y-4">

        {/* ═══ Section 1 — Priority Details ═══ */}
        <div className="bg-white rounded-2xl border border-stone-200 shadow-sm overflow-hidden">
          <div className="px-5 pt-5 pb-4 border-b border-stone-100 flex items-center justify-between">
            <SectionHeader title="Contact Details" subtitle="Capture key info first" />
            <DraftSaveIndicator state={saveState} />
          </div>

          <div className="px-5 py-5 space-y-4">
            {/* Client Name */}
            <div>
              <FieldLabel label="Client Name" />
              <div className="relative">
                <User className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-stone-400 pointer-events-none" />
                <input
                  type="text"
                  placeholder="e.g. Rahul Sharma"
                  autoComplete="name"
                  value={clientName}
                  onChange={e => handleChange('clientName', e.target.value)}
                  onBlur={() => handleBlur('clientName')}
                  className={`${inputCls()} pl-10`}
                />
              </div>
            </div>

            {/* Phone */}
            <div>
              <FieldLabel label="Phone" />
              <div className="relative">
                <Phone className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-stone-400 pointer-events-none" />
                <input
                  type="tel"
                  inputMode="tel"
                  placeholder="+91 98765 43210"
                  autoComplete="tel"
                  value={phone}
                  onChange={e => handleChange('phone', e.target.value)}
                  onBlur={() => handleBlur('phone')}
                  className={`${inputCls()} pl-10`}
                />
              </div>
            </div>

            {/* Email */}
            <div>
              <FieldLabel label="Email" optional />
              <div className="relative">
                <Mail className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-stone-400 pointer-events-none" />
                <input
                  type="email"
                  inputMode="email"
                  placeholder="e.g. rahul@acme.com"
                  autoComplete="email"
                  value={email}
                  onChange={e => handleChange('email', e.target.value)}
                  className={`${inputCls()} pl-10`}
                />
              </div>
            </div>

            {/* Company */}
            <div>
              <FieldLabel label="Company" />
              <div className="relative">
                <Building2 className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-stone-400 pointer-events-none" />
                <input
                  type="text"
                  placeholder="e.g. Acme Retail Pvt Ltd"
                  autoComplete="organization"
                  value={company}
                  onChange={e => handleChange('company', e.target.value)}
                  onBlur={() => handleBlur('company')}
                  className={`${inputCls()} pl-10`}
                />
              </div>
            </div>

            {/* Designation */}
            <div>
              <FieldLabel label="Designation" optional />
              <div className="relative">
                <Briefcase className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-stone-400 pointer-events-none" />
                <input
                  type="text"
                  placeholder="e.g. Purchase Manager"
                  autoComplete="organization-title"
                  value={designation}
                  onChange={e => handleChange('designation', e.target.value)}
                  className={`${inputCls()} pl-10`}
                />
              </div>
            </div>

            {/* Website */}
            <div>
              <FieldLabel label="Website" optional />
              <div className="relative">
                <Globe className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-stone-400 pointer-events-none" />
                <input
                  type="url"
                  inputMode="url"
                  placeholder="https://company.com"
                  autoComplete="url"
                  value={website}
                  onChange={e => handleChange('website', e.target.value)}
                  className={`${inputCls()} pl-10`}
                />
              </div>
            </div>

            {/* Address */}
            <div>
              <FieldLabel label="Address" optional />
              <div className="relative">
                <MapPin className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-stone-400 pointer-events-none" />
                <input
                  type="text"
                  placeholder="e.g. Mumbai, Maharashtra"
                  autoComplete="street-address"
                  value={address}
                  onChange={e => handleChange('address', e.target.value)}
                  className={`${inputCls()} pl-10`}
                />
              </div>
            </div>

            {/* Lead Temperature */}
            <LeadTemperaturePicker
              value={leadTemperature}
              onChange={v => handlePatchDraft({ leadTemperature: v })}
            />
          </div>
        </div>

        {/* ═══ Section 2 — Quick Notes ═══ */}
        <div className="bg-white rounded-2xl border border-stone-200 shadow-sm overflow-hidden">
          <div className="px-5 pt-5 pb-4 border-b border-stone-100">
            <SectionHeader title="Quick Notes" subtitle="Discussion summary, requirements, follow-ups" />
          </div>
          <div className="px-5 py-5 space-y-5">
            {/* Text notes */}
            <div>
              <FieldLabel label="Notes" optional />
              <textarea
                placeholder="Discussion summary, requirements, follow-up points…"
                rows={4}
                value={notes}
                onChange={e => handleChange('notes', e.target.value)}
                className={`${inputCls()} resize-none leading-relaxed`}
              />
            </div>

            {/* Voice note */}
            <VoiceNoteRecorder
              durationMs={voiceDuration}
              transcript={voiceTranscript}
              transcriptionStatus={computedTranscriptionStatus}
              onUpdate={handlePatchDraft}
              onBlobReady={onVoiceNoteRecorded}
              onRetryTranscription={
                backendSessionId && polledTranscriptionStatus === 'failed'
                  ? () => setPolledTranscriptionStatus(null)
                  : undefined
              }
            />

            {/* Notes image */}
            <NotesImageCapture
              imageDataUrl={notesImage}
              onCapture={dataUrl => handlePatchDraft({ notesImageDataUrl: dataUrl })}
              onRemove={() => handlePatchDraft({ notesImageDataUrl: undefined })}
            />
          </div>
        </div>

        {/* ═══ Section 3 — Additional Details (Collapsible) ═══ */}
        <CollapsibleSection title="Additional Details (Optional)">
          <LeadTypePicker
            value={leadType}
            onChange={v => handlePatchDraft({ leadType: v })}
          />

          {leadType === 'EXISTING' && (
            <PreviousRepSelect
              value={previousRepCode}
              onChange={code => handleChange('previousRepCode', code)}
            />
          )}

          <ApplicationChips
            selected={application}
            onChange={v => handlePatchDraft({ application: v })}
          />

          <PriceRangeInput
            value={priceRange}
            onChange={v => handleChange('priceRange', v)}
          />

          <KeywordsInput
            values={quickKeywords}
            onChange={v => handlePatchDraft({ quickKeywords: v })}
          />

          <TagArrayInput
            label="Target Market"
            values={targetMarket}
            onChange={v => handlePatchDraft({ targetMarket: v })}
            placeholder="e.g. Luxury, Mass Market…"
          />

          <TagArrayInput
            label="Certification"
            values={certification}
            onChange={v => handlePatchDraft({ certification: v })}
            placeholder="e.g. IFRA, ISO 9001…"
          />

          <TagArrayInput
            label="Benchmark"
            values={benchmark}
            onChange={v => handlePatchDraft({ benchmark: v })}
            placeholder="e.g. Competitor product name…"
          />
        </CollapsibleSection>

      </div>

      {/* Session status */}
      <div className="mt-4 px-1">
        <SessionStatusBar session={session} isOnline={isOnline} />
      </div>

      {/* ═══ Sticky bottom action bar ═══ */}
      <div
        className="fixed bottom-0 inset-x-0 z-30 bg-white/95 backdrop-blur border-t border-stone-200
          px-4 pt-3 md:relative md:mt-6 md:border-t-0 md:bg-transparent md:backdrop-blur-none md:px-0 md:pt-0"
        style={{ paddingBottom: 'max(12px, env(safe-area-inset-bottom))' }}
      >
        <div className="max-w-lg mx-auto flex gap-3">
          <button
            type="button"
            onClick={handleContinueEnrich}
            disabled={saving}
            className="flex-1 flex items-center justify-center gap-2 py-3.5 rounded-xl
              border border-stone-200 bg-white text-stone-700 text-sm font-semibold
              hover:bg-stone-50 active:bg-stone-100 active:scale-[0.98]
              transition-all duration-150 disabled:opacity-50"
          >
            <CheckCircle2 className="w-4 h-4" />
            Save Draft
          </button>
          <button
            type="button"
            onClick={handleSaveAndNext}
            disabled={saving}
            className="flex-[2] flex items-center justify-center gap-2 py-3.5 rounded-xl
              bg-stone-900 text-white text-sm font-semibold shadow-sm
              hover:bg-stone-800 active:bg-stone-950 active:scale-[0.98]
              transition-all duration-150 disabled:opacity-50"
          >
            {saving ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Saving…
              </>
            ) : (
              <>
                Save &amp; Next Lead
                <ArrowRight className="w-4 h-4" />
              </>
            )}
          </button>
        </div>
      </div>

      <Toast message={promotionActive ? null : toastMessage} isError={toastIsError} position="bottom" />

      {showDiscardDialog && (
        <DiscardDialog
          onConfirm={handleDiscardConfirm}
          onCancel={() => setShowDiscardDialog(false)}
        />
      )}
    </div>
  );
}
