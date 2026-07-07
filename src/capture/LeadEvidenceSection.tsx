import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Image as ImageIcon, Mic, X, ChevronLeft, ChevronRight,
  ZoomIn, ZoomOut, RotateCcw, Play, Pause, Volume2,
  Loader2, CheckCircle2, AlertCircle, FileImage, Clock,
  Plus, Square, Camera, Upload, RefreshCw,
} from 'lucide-react';
import {
  fetchEvidence,
  sortEvidenceDescending,
  type LeadEvidenceCollection,
  type BusinessCardEvidence,
  type VoiceMemoEvidence,
  type ImageNoteEvidence,
  type LeadEvidence,
} from './leadEvidenceService';
import { addVoiceMemo, addImageNote } from './addEvidenceService';
import { transcribeVoiceNote } from './voiceTranscriptionService';

// ─── Lightbox ─────────────────────────────────────────────────────────────────

interface LightboxProps {
  images: { url: string; label: string }[];
  initialIndex: number;
  onClose: () => void;
}

function Lightbox({ images, initialIndex, onClose }: LightboxProps) {
  const [idx, setIdx] = useState(initialIndex);
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const isDragging = useRef(false);
  const dragStart = useRef({ x: 0, y: 0, ox: 0, oy: 0 });

  const current = images[idx];
  const canPrev = idx > 0;
  const canNext = idx < images.length - 1;

  useEffect(() => { setScale(1); setOffset({ x: 0, y: 0 }); }, [idx]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowLeft' && canPrev) setIdx(i => i - 1);
      if (e.key === 'ArrowRight' && canNext) setIdx(i => i + 1);
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [canPrev, canNext, onClose]);

  function handleWheel(e: React.WheelEvent) {
    e.preventDefault();
    const delta = e.deltaY > 0 ? -0.15 : 0.15;
    setScale(s => Math.max(0.5, Math.min(5, s + delta)));
  }

  function handlePointerDown(e: React.PointerEvent) {
    if (scale <= 1) return;
    isDragging.current = true;
    dragStart.current = { x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }

  function handlePointerMove(e: React.PointerEvent) {
    if (!isDragging.current) return;
    setOffset({
      x: dragStart.current.ox + (e.clientX - dragStart.current.x),
      y: dragStart.current.oy + (e.clientY - dragStart.current.y),
    });
  }

  function handlePointerUp() { isDragging.current = false; }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 backdrop-blur-sm"
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="absolute top-0 inset-x-0 flex items-center justify-between px-4 py-3 bg-gradient-to-b from-black/60 to-transparent z-10">
        <span className="text-white/80 text-sm font-medium">{current.label}</span>
        <div className="flex items-center gap-2">
          <button onClick={() => setScale(s => Math.min(5, s + 0.5))} className="p-2 rounded-lg bg-white/10 hover:bg-white/20 text-white transition" title="Zoom in">
            <ZoomIn className="w-4 h-4" />
          </button>
          <button onClick={() => setScale(s => Math.max(0.5, s - 0.5))} className="p-2 rounded-lg bg-white/10 hover:bg-white/20 text-white transition" title="Zoom out">
            <ZoomOut className="w-4 h-4" />
          </button>
          <button onClick={() => { setScale(1); setOffset({ x: 0, y: 0 }); }} className="p-2 rounded-lg bg-white/10 hover:bg-white/20 text-white transition" title="Reset">
            <RotateCcw className="w-4 h-4" />
          </button>
          <button onClick={onClose} className="p-2 rounded-lg bg-white/10 hover:bg-white/20 text-white transition ml-2" title="Close">
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {canPrev && (
        <button onClick={() => setIdx(i => i - 1)} className="absolute left-3 z-10 p-2.5 rounded-full bg-white/10 hover:bg-white/20 text-white transition">
          <ChevronLeft className="w-5 h-5" />
        </button>
      )}
      {canNext && (
        <button onClick={() => setIdx(i => i + 1)} className="absolute right-3 z-10 p-2.5 rounded-full bg-white/10 hover:bg-white/20 text-white transition">
          <ChevronRight className="w-5 h-5" />
        </button>
      )}

      <div
        className="overflow-hidden max-w-[90vw] max-h-[85vh] cursor-grab active:cursor-grabbing select-none"
        onWheel={handleWheel}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
      >
        <img
          src={current.url}
          alt={current.label}
          draggable={false}
          style={{
            transform: `scale(${scale}) translate(${offset.x / scale}px, ${offset.y / scale}px)`,
            transition: isDragging.current ? 'none' : 'transform 0.15s ease',
            maxWidth: '90vw',
            maxHeight: '85vh',
            objectFit: 'contain',
            display: 'block',
          }}
        />
      </div>

      {images.length > 1 && (
        <div className="absolute bottom-4 inset-x-0 flex justify-center gap-1.5">
          {images.map((_, i) => (
            <button key={i} onClick={() => setIdx(i)} className={`w-2 h-2 rounded-full transition-colors ${i === idx ? 'bg-white' : 'bg-white/30'}`} />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Audio Player ─────────────────────────────────────────────────────────────

function AudioPlayer({ src }: { src: string }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const [unsupported, setUnsupported] = useState(false);

  function toggle() {
    const el = audioRef.current;
    if (!el) return;
    if (playing) { el.pause(); } else { void el.play(); }
  }

  function handleSeek(e: React.ChangeEvent<HTMLInputElement>) {
    const el = audioRef.current;
    if (!el) return;
    el.currentTime = Number(e.target.value);
    setCurrent(el.currentTime);
  }

  function fmt(s: number) {
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, '0')}`;
  }

  if (unsupported) return <p className="text-xs text-stone-400 italic">Audio preview unavailable.</p>;

  return (
    <div className="mt-3">
      <audio
        ref={audioRef}
        src={src}
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => { setPlaying(false); setCurrent(0); if (audioRef.current) audioRef.current.currentTime = 0; }}
        onTimeUpdate={() => setCurrent(audioRef.current?.currentTime ?? 0)}
        onLoadedMetadata={() => setDuration(audioRef.current?.duration ?? 0)}
        onError={() => setUnsupported(true)}
      />
      <div className="flex items-center gap-3 px-3 py-2.5 bg-stone-50 rounded-xl border border-stone-200">
        <button
          onClick={toggle}
          className="flex items-center justify-center w-8 h-8 rounded-full bg-stone-900 text-white flex-shrink-0 hover:bg-stone-700 active:scale-95 transition-all"
          aria-label={playing ? 'Pause' : 'Play'}
        >
          {playing ? <Pause className="w-3.5 h-3.5 fill-current" /> : <Play className="w-3.5 h-3.5 fill-current ml-0.5" />}
        </button>
        <div className="flex-1 min-w-0 flex flex-col gap-1">
          <input
            type="range" min={0} max={duration || 1} step={0.1} value={current} onChange={handleSeek}
            className="w-full h-1.5 rounded-full accent-stone-900 cursor-pointer"
          />
          <div className="flex justify-between text-[10px] text-stone-400 font-mono">
            <span>{fmt(current)}</span>
            <span>{fmt(duration)}</span>
          </div>
        </div>
        <Volume2 className="w-3.5 h-3.5 text-stone-400 flex-shrink-0" />
      </div>
    </div>
  );
}

// ─── Shared helpers ───────────────────────────────────────────────────────────

function fmtDateTime(iso: string) {
  return new Date(iso).toLocaleString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function CardTimestamp({ iso }: { iso: string }) {
  return (
    <span className="flex items-center gap-1 text-[11px] text-stone-400 font-normal">
      <Clock className="w-3 h-3 flex-shrink-0" />
      {fmtDateTime(iso)}
    </span>
  );
}

// ─── Voice Memo Recorder (reused from ManualEntryForm, adapted for modal) ─────

type VoiceState = 'idle' | 'recording' | 'recorded';

interface VoiceRecorderProps {
  onDone: (blob: Blob, durationMs: number, mimeType: string) => void;
  onCancel: () => void;
}

function VoiceRecorder({ onDone, onCancel }: VoiceRecorderProps) {
  const [state, setState]   = useState<VoiceState>('idle');
  const [elapsed, setElapsed] = useState(0);

  const timerRef    = useRef<ReturnType<typeof setInterval> | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef   = useRef<Blob[]>([]);
  const streamRef   = useRef<MediaStream | null>(null);
  const elapsedRef  = useRef(0);
  const mimeRef     = useRef('audio/webm');

  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      recorderRef.current?.stop();
      streamRef.current?.getTracks().forEach(t => t.stop());
    };
  }, []);

  async function start() {
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
      mimeRef.current = mimeType;

      const recorder = new MediaRecorder(stream, { mimeType });
      recorderRef.current = recorder;

      recorder.ondataavailable = e => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      recorder.onstop = () => {
        streamRef.current?.getTracks().forEach(t => t.stop());
        streamRef.current = null;
        setState('recorded');
      };

      recorder.start();
      setState('recording');
      setElapsed(0);

      timerRef.current = setInterval(() => {
        elapsedRef.current += 1000;
        setElapsed(prev => prev + 1000);
      }, 1000);
    } catch {
      // mic unavailable
    }
  }

  function stop() {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    recorderRef.current?.stop();
    recorderRef.current = null;
  }

  function handleSave() {
    const blob = new Blob(chunksRef.current, { type: mimeRef.current });
    onDone(blob, elapsedRef.current, mimeRef.current);
  }

  function handleDiscard() {
    chunksRef.current = [];
    elapsedRef.current = 0;
    setElapsed(0);
    setState('idle');
  }

  function fmt(ms: number) {
    const s = Math.floor(ms / 1000);
    return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`;
  }

  if (state === 'idle') {
    return (
      <div className="flex flex-col items-center gap-6 py-6">
        <button
          onClick={start}
          className="flex items-center justify-center w-20 h-20 rounded-full bg-stone-900 text-white shadow-lg hover:bg-stone-800 active:scale-95 transition-all"
          aria-label="Start recording"
        >
          <Mic className="w-7 h-7" />
        </button>
        <p className="text-sm text-stone-500">Tap to start recording</p>
        <button onClick={onCancel} className="text-xs text-stone-400 hover:text-stone-700 transition underline underline-offset-2">Cancel</button>
      </div>
    );
  }

  if (state === 'recording') {
    return (
      <div className="flex flex-col items-center gap-6 py-6">
        <div className="relative">
          <button
            onClick={stop}
            className="flex items-center justify-center w-20 h-20 rounded-full bg-red-600 text-white shadow-lg active:scale-95 transition-all"
            aria-label="Stop recording"
          >
            <Square className="w-7 h-7 fill-current" />
          </button>
          <span className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-red-500 animate-ping" />
          <span className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-red-500" />
        </div>
        <div className="text-center">
          <p className="text-sm font-medium text-red-600 flex items-center gap-2 justify-center">
            <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
            Recording
          </p>
          <p className="text-2xl font-mono font-semibold text-stone-900 mt-1">{fmt(elapsed)}</p>
        </div>
        <button onClick={onCancel} className="text-xs text-stone-400 hover:text-stone-700 transition underline underline-offset-2">Cancel</button>
      </div>
    );
  }

  // recorded
  return (
    <div className="flex flex-col items-center gap-5 py-6">
      <div className="w-20 h-20 rounded-full bg-green-50 flex items-center justify-center">
        <Mic className="w-7 h-7 text-green-600" />
      </div>
      <div className="text-center">
        <p className="text-sm font-semibold text-stone-800">Recording ready</p>
        <p className="text-xs text-stone-400 font-mono mt-0.5">{fmt(elapsedRef.current)}</p>
      </div>
      <div className="flex gap-3">
        <button
          onClick={handleDiscard}
          className="px-4 py-2 text-sm font-medium rounded-lg border border-stone-200 text-stone-600 hover:bg-stone-50 transition"
        >
          Record again
        </button>
        <button
          onClick={handleSave}
          className="px-5 py-2 text-sm font-medium rounded-lg bg-stone-900 text-white hover:bg-stone-800 transition"
        >
          Attach memo
        </button>
      </div>
      <button onClick={onCancel} className="text-xs text-stone-400 hover:text-stone-700 transition underline underline-offset-2">Cancel</button>
    </div>
  );
}

// ─── Add Voice Memo Modal ─────────────────────────────────────────────────────

interface AddVoiceMemoModalProps {
  leadId: string;
  onClose: () => void;
  onAdded: (optimistic: VoiceMemoEvidence, sessionId: string) => void;
}

function AddVoiceMemoModal({ leadId, onClose, onAdded }: AddVoiceMemoModalProps) {
  const [phase, setPhase] = useState<'record' | 'uploading' | 'error'>('record');
  const [errorMsg, setErrorMsg] = useState('');

  async function handleRecorded(blob: Blob, durationMs: number, mimeType: string) {
    setPhase('uploading');

    const objectUrl = URL.createObjectURL(blob);
    const optimistic: VoiceMemoEvidence = {
      kind:                'voice_memo',
      audioUrl:            objectUrl,
      audioPath:           null,
      durationMs,
      transcript:          null,
      transcriptionStatus: 'pending',
      createdAt:           new Date().toISOString(),
    };

    const { sessionId, error } = await addVoiceMemo(leadId, blob, mimeType, durationMs);

    if (error || !sessionId) {
      setErrorMsg(error ?? 'Upload failed.');
      setPhase('error');
      URL.revokeObjectURL(objectUrl);
      return;
    }

    onAdded(optimistic, sessionId);
    onClose();
  }

  // Close on backdrop click
  function handleBackdrop(e: React.MouseEvent) {
    if (e.target === e.currentTarget && phase !== 'uploading') onClose();
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && phase !== 'uploading') onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [phase, onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 backdrop-blur-sm" onClick={handleBackdrop}>
      <div className="relative w-full sm:max-w-md bg-white rounded-t-2xl sm:rounded-2xl shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-stone-100">
          <div className="flex items-center gap-2">
            <Mic className="w-4 h-4 text-stone-500" />
            <h2 className="text-sm font-semibold text-stone-800">Add Voice Memo</h2>
          </div>
          {phase !== 'uploading' && (
            <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-stone-100 text-stone-400 transition">
              <X className="w-4 h-4" />
            </button>
          )}
        </div>

        {/* Body */}
        <div className="px-5">
          {phase === 'record' && (
            <VoiceRecorder onDone={handleRecorded} onCancel={onClose} />
          )}

          {phase === 'uploading' && (
            <div className="flex flex-col items-center gap-4 py-10">
              <Loader2 className="w-8 h-8 text-stone-400 animate-spin" />
              <p className="text-sm text-stone-600">Uploading voice memo…</p>
            </div>
          )}

          {phase === 'error' && (
            <div className="flex flex-col items-center gap-4 py-8 text-center">
              <div className="w-12 h-12 rounded-full bg-red-50 flex items-center justify-center">
                <AlertCircle className="w-6 h-6 text-red-500" />
              </div>
              <div>
                <p className="text-sm font-medium text-stone-800">Couldn't upload voice memo.</p>
                <p className="text-xs text-stone-400 mt-1">{errorMsg}</p>
              </div>
              <div className="flex gap-3">
                <button onClick={onClose} className="px-4 py-2 text-sm font-medium rounded-lg border border-stone-200 text-stone-600 hover:bg-stone-50 transition">
                  Cancel
                </button>
                <button onClick={() => setPhase('record')} className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-lg bg-stone-900 text-white hover:bg-stone-800 transition">
                  <RefreshCw className="w-3.5 h-3.5" /> Retry
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Add Image Note Modal ─────────────────────────────────────────────────────

interface AddImageNoteModalProps {
  leadId: string;
  onClose: () => void;
  onAdded: (optimistic: ImageNoteEvidence) => void;
}

function AddImageNoteModal({ leadId, onClose, onAdded }: AddImageNoteModalProps) {
  const [phase, setPhase]   = useState<'pick' | 'uploading' | 'error'>('pick');
  const [preview, setPreview] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);

  function handleBackdrop(e: React.MouseEvent) {
    if (e.target === e.currentTarget && phase !== 'uploading') onClose();
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && phase !== 'uploading') onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [phase, onClose]);

  function fileToDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  async function handleFile(file: File) {
    const dataUrl = await fileToDataUrl(file);
    setPreview(dataUrl);
    await upload(dataUrl);
  }

  async function upload(dataUrl: string) {
    setPhase('uploading');
    const { sessionId, error } = await addImageNote(leadId, dataUrl);

    if (error || !sessionId) {
      setErrorMsg(error ?? 'Upload failed.');
      setPhase('error');
      return;
    }

    const optimistic: ImageNoteEvidence = {
      kind:      'image_note',
      imageUrl:  dataUrl,
      imagePath: null,
      createdAt: new Date().toISOString(),
    };

    onAdded(optimistic);
    onClose();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 backdrop-blur-sm" onClick={handleBackdrop}>
      <div className="relative w-full sm:max-w-md bg-white rounded-t-2xl sm:rounded-2xl shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-stone-100">
          <div className="flex items-center gap-2">
            <ImageIcon className="w-4 h-4 text-stone-500" />
            <h2 className="text-sm font-semibold text-stone-800">Add Image Note</h2>
          </div>
          {phase !== 'uploading' && (
            <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-stone-100 text-stone-400 transition">
              <X className="w-4 h-4" />
            </button>
          )}
        </div>

        <div className="px-5 py-5">
          {phase === 'pick' && (
            <div className="flex flex-col gap-3">
              {/* Camera */}
              <button
                onClick={() => cameraInputRef.current?.click()}
                className="flex items-center gap-3 w-full px-4 py-3.5 rounded-xl border border-stone-200 hover:border-stone-400 hover:bg-stone-50 transition text-left"
              >
                <div className="w-9 h-9 rounded-lg bg-stone-100 flex items-center justify-center flex-shrink-0">
                  <Camera className="w-4.5 h-4.5 text-stone-600" style={{ width: '1.125rem', height: '1.125rem' }} />
                </div>
                <div>
                  <p className="text-sm font-medium text-stone-800">Take a photo</p>
                  <p className="text-xs text-stone-400">Use your device camera</p>
                </div>
              </button>
              <input
                ref={cameraInputRef}
                type="file"
                accept="image/*"
                capture="environment"
                className="hidden"
                onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f); }}
              />

              {/* Upload */}
              <button
                onClick={() => fileInputRef.current?.click()}
                className="flex items-center gap-3 w-full px-4 py-3.5 rounded-xl border border-stone-200 hover:border-stone-400 hover:bg-stone-50 transition text-left"
              >
                <div className="w-9 h-9 rounded-lg bg-stone-100 flex items-center justify-center flex-shrink-0">
                  <Upload className="w-4 h-4 text-stone-600" />
                </div>
                <div>
                  <p className="text-sm font-medium text-stone-800">Upload from device</p>
                  <p className="text-xs text-stone-400">Choose an image file</p>
                </div>
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f); }}
              />

              <button onClick={onClose} className="text-xs text-stone-400 hover:text-stone-700 transition text-center mt-1 underline underline-offset-2">Cancel</button>
            </div>
          )}

          {phase === 'uploading' && (
            <div className="flex flex-col items-center gap-4 py-6">
              {preview && (
                <div className="w-full max-h-40 rounded-xl overflow-hidden border border-stone-200 mb-2">
                  <img src={preview} alt="Preview" className="w-full max-h-40 object-cover" />
                </div>
              )}
              <div className="flex items-center gap-2 text-sm text-stone-600">
                <Loader2 className="w-4 h-4 animate-spin text-stone-400" />
                Uploading image…
              </div>
            </div>
          )}

          {phase === 'error' && (
            <div className="flex flex-col items-center gap-4 py-6 text-center">
              <div className="w-12 h-12 rounded-full bg-red-50 flex items-center justify-center">
                <AlertCircle className="w-6 h-6 text-red-500" />
              </div>
              <div>
                <p className="text-sm font-medium text-stone-800">Couldn't upload image.</p>
                <p className="text-xs text-stone-400 mt-1">{errorMsg}</p>
              </div>
              <div className="flex gap-3">
                <button onClick={onClose} className="px-4 py-2 text-sm font-medium rounded-lg border border-stone-200 text-stone-600 hover:bg-stone-50 transition">
                  Cancel
                </button>
                {preview && (
                  <button onClick={() => upload(preview)} className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-lg bg-stone-900 text-white hover:bg-stone-800 transition">
                    <RefreshCw className="w-3.5 h-3.5" /> Retry
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Evidence Cards ───────────────────────────────────────────────────────────

function BusinessCardEvidenceCard({
  evidence,
  onOpenLightbox,
}: {
  evidence: BusinessCardEvidence;
  onOpenLightbox: (images: { url: string; label: string }[], index: number) => void;
}) {
  const images: { url: string; label: string }[] = [];
  if (evidence.frontImage) images.push({ url: evidence.frontImage, label: 'Business Card — Front' });
  if (evidence.backImage)  images.push({ url: evidence.backImage,  label: 'Business Card — Back'  });

  return (
    <div className="bg-white border border-stone-200 rounded-xl overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-stone-100 bg-stone-50">
        <div className="flex items-center gap-2">
          <FileImage className="w-4 h-4 text-stone-500" />
          <h4 className="text-sm font-semibold text-stone-700">Business Card</h4>
        </div>
        <CardTimestamp iso={evidence.createdAt} />
      </div>
      <div className="p-4">
        {images.length === 0 ? (
          <p className="text-sm text-stone-400 text-center py-4">No images available.</p>
        ) : (
          <div className="flex gap-3">
            {(['Front', 'Back'] as const).map(side => {
              const img = side === 'Front' ? evidence.frontImage : evidence.backImage;
              if (!img) return null;
              return (
                <button
                  key={side}
                  onClick={() => onOpenLightbox(images, images.findIndex(im => im.label.includes(side)))}
                  className="group relative flex-1 min-w-0 rounded-lg overflow-hidden border border-stone-200 hover:border-stone-400 transition-colors focus:outline-none focus:ring-2 focus:ring-stone-400"
                  aria-label={`View ${side} of business card`}
                >
                  <div className="aspect-[1.6/1] bg-stone-100">
                    <img src={img} alt={`Business card ${side.toLowerCase()}`} className="w-full h-full object-cover group-hover:scale-[1.02] transition-transform duration-200" />
                  </div>
                  <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity bg-black/20">
                    <ZoomIn className="w-5 h-5 text-white drop-shadow" />
                  </div>
                  <p className="text-[10px] font-medium text-stone-500 text-center py-1.5 bg-stone-50 border-t border-stone-100">{side}</p>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function ImageNoteEvidenceCard({
  evidence,
  onOpenLightbox,
}: {
  evidence: ImageNoteEvidence;
  onOpenLightbox: (images: { url: string; label: string }[], index: number) => void;
}) {
  const label = `Notes Image · ${new Date(evidence.createdAt).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}`;

  return (
    <div className="bg-white border border-stone-200 rounded-xl overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-stone-100 bg-stone-50">
        <div className="flex items-center gap-2">
          <ImageIcon className="w-4 h-4 text-stone-500" />
          <h4 className="text-sm font-semibold text-stone-700">Notes Image</h4>
        </div>
        <CardTimestamp iso={evidence.createdAt} />
      </div>
      <div className="p-4">
        {!evidence.imageUrl ? (
          <p className="text-sm text-stone-400 text-center py-4">Image unavailable.</p>
        ) : (
          <button
            onClick={() => onOpenLightbox([{ url: evidence.imageUrl!, label }], 0)}
            className="group relative w-full rounded-lg overflow-hidden border border-stone-200 hover:border-stone-400 transition-colors focus:outline-none focus:ring-2 focus:ring-stone-400"
            aria-label="View notes image"
          >
            <div className="max-h-64 bg-stone-100">
              <img src={evidence.imageUrl} alt="Notes" className="w-full max-h-64 object-cover group-hover:scale-[1.01] transition-transform duration-200" />
            </div>
            <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity bg-black/20">
              <ZoomIn className="w-6 h-6 text-white drop-shadow" />
            </div>
          </button>
        )}
      </div>
    </div>
  );
}

// Voice memo card — supports live-polling for transcription status
function VoiceMemoEvidenceCard({
  evidence,
  liveSessionId,
}: {
  evidence: VoiceMemoEvidence;
  liveSessionId?: string;  // only set for optimistic cards still awaiting transcription
}) {
  const [liveEvidence, setLiveEvidence] = useState(evidence);
  const polledRef = useRef<VoiceMemoEvidence['transcriptionStatus']>('none');
  polledRef.current = liveEvidence.transcriptionStatus;

  // Poll the DB for transcription status when a liveSessionId is provided.
  // Stops automatically when terminal state is reached.
  useEffect(() => {
    if (!liveSessionId) return;
    let mounted = true;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function poll() {
      if (!mounted) return;
      const current = polledRef.current;
      if (current === 'done' || current === 'failed') return;

      try {
        const { data: asset } = await import('../supabaseClient').then(m =>
          m.supabase
            .from('capture_assets')
            .select('transcription_status')
            .eq('capture_session_id', liveSessionId)
            .eq('asset_type', 'voice_note')
            .maybeSingle()
        );

        if (!mounted) return;

        const dbStatus = (asset as { transcription_status?: string | null } | null)
          ?.transcription_status ?? null;

        if (dbStatus === 'ready') {
          // Fetch the transcript
          const { data: sess } = await import('../supabaseClient').then(m =>
            m.supabase
              .from('capture_sessions')
              .select('voice_note_transcript')
              .eq('id', liveSessionId)
              .maybeSingle()
          );
          if (!mounted) return;
          const transcript = (sess as { voice_note_transcript?: string | null } | null)
            ?.voice_note_transcript ?? null;
          setLiveEvidence(prev => ({ ...prev, transcript, transcriptionStatus: 'done' }));
          return;
        }

        if (dbStatus === 'failed') {
          setLiveEvidence(prev => ({ ...prev, transcriptionStatus: 'failed' }));
          return;
        }

        if (dbStatus === 'transcribing') {
          setLiveEvidence(prev => ({ ...prev, transcriptionStatus: 'processing' }));
        } else {
          setLiveEvidence(prev => ({ ...prev, transcriptionStatus: 'pending' }));
        }

        timer = setTimeout(poll, 3000);
      } catch {
        timer = setTimeout(poll, 5000);
      }
    }

    timer = setTimeout(poll, 1500);
    return () => { mounted = false; if (timer) clearTimeout(timer); };
  }, [liveSessionId]);

  function handleRetryTranscription() {
    if (!liveSessionId) return;
    setLiveEvidence(prev => ({ ...prev, transcriptionStatus: 'processing' }));
    transcribeVoiceNote(liveSessionId).then(({ error }) => {
      if (error) setLiveEvidence(prev => ({ ...prev, transcriptionStatus: 'failed' }));
    });
  }

  function fmtDuration(ms: number | null) {
    if (!ms) return null;
    const s = Math.floor(ms / 1000);
    return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`;
  }

  const duration = fmtDuration(liveEvidence.durationMs);
  const ts = liveEvidence.transcriptionStatus;

  return (
    <div className="bg-white border border-stone-200 rounded-xl overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-stone-100 bg-stone-50">
        <div className="flex items-center gap-2">
          <Mic className="w-4 h-4 text-stone-500" />
          <h4 className="text-sm font-semibold text-stone-700">Voice Memo</h4>
        </div>
        <CardTimestamp iso={liveEvidence.createdAt} />
      </div>

      <div className="p-4 space-y-3">
        {duration && (
          <span className="inline-flex items-center gap-1 font-mono font-medium text-stone-600 bg-stone-100 px-2 py-0.5 rounded-md text-xs">
            {duration}
          </span>
        )}

        {liveEvidence.audioUrl ? (
          <AudioPlayer src={liveEvidence.audioUrl} />
        ) : (
          <p className="text-xs text-stone-400 italic">Audio preview unavailable.</p>
        )}

        <div className="border-t border-stone-100 pt-3">
          {liveEvidence.transcript ? (
            <>
              <div className="flex items-center gap-1.5 mb-1.5">
                <CheckCircle2 className="w-3.5 h-3.5 text-green-600" />
                <span className="text-[11px] font-semibold text-green-600 uppercase tracking-wide">AI Transcript</span>
              </div>
              <p className="text-sm text-stone-700 leading-relaxed whitespace-pre-wrap">{liveEvidence.transcript}</p>
            </>
          ) : ts === 'processing' || ts === 'pending' ? (
            <div className="flex items-center gap-2 text-sm text-amber-700">
              <Loader2 className="w-3.5 h-3.5 animate-spin text-amber-500" />
              {ts === 'processing' ? 'Generating transcript…' : 'Preparing transcription…'}
            </div>
          ) : ts === 'failed' ? (
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-sm text-amber-700">
                <AlertCircle className="w-3.5 h-3.5 text-amber-500" />
                Transcript unavailable
              </div>
              {liveSessionId && (
                <button
                  onClick={handleRetryTranscription}
                  className="text-xs font-semibold text-amber-700 hover:text-amber-900 underline underline-offset-2 transition ml-3"
                >
                  Retry transcription
                </button>
              )}
            </div>
          ) : (
            <p className="text-xs text-stone-400 italic">Transcript unavailable</p>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Public section component ─────────────────────────────────────────────────

interface Props {
  leadId: string;
}

// Track optimistic voice items so VoiceMemoEvidenceCard can poll for transcription
interface OptimisticVoice {
  item:      VoiceMemoEvidence;
  sessionId: string;
}

export function LeadEvidenceSection({ leadId }: Props) {
  const [collection, setCollection]   = useState<LeadEvidenceCollection | null>(null);
  const [loading, setLoading]         = useState(true);
  const [optimisticVoice, setOptimisticVoice] = useState<OptimisticVoice[]>([]);

  // Modals
  const [voiceModalOpen, setVoiceModalOpen]   = useState(false);
  const [imageModalOpen, setImageModalOpen]   = useState(false);

  // Lightbox
  const [lightboxImages, setLightboxImages] = useState<{ url: string; label: string }[]>([]);
  const [lightboxIndex, setLightboxIndex]   = useState(0);
  const lightboxOpen = lightboxImages.length > 0;
  const scrollYRef = useRef(0);

  useEffect(() => {
    setLoading(true);
    fetchEvidence({ leadId }).then(c => {
      setCollection(c);
      setLoading(false);
    });
  }, [leadId]);

  function openLightbox(images: { url: string; label: string }[], index: number) {
    scrollYRef.current = window.scrollY;
    setLightboxImages(images);
    setLightboxIndex(index);
  }

  function closeLightbox() {
    setLightboxImages([]);
    requestAnimationFrame(() => window.scrollTo(0, scrollYRef.current));
  }

  const handleVoiceAdded = useCallback((optimistic: VoiceMemoEvidence, sessionId: string) => {
    setOptimisticVoice(prev => [...prev, { item: optimistic, sessionId }]);
  }, []);

  const handleImageAdded = useCallback((optimistic: ImageNoteEvidence) => {
    setCollection(prev => prev
      ? { ...prev, items: sortEvidenceDescending([...prev.items, optimistic]) }
      : { items: [optimistic], sessionId: null, leadId, fetchedAt: new Date().toISOString() }
    );
  }, [leadId]);

  // Build the combined display list: DB collection + optimistic voice items (prepended)
  const allItems: LeadEvidence[] = [
    ...optimisticVoice.map(o => o.item),
    ...(collection?.items ?? []),
  ];
  const hasEvidence = allItems.length > 0;

  function renderCard(item: LeadEvidence, key: string) {
    switch (item.kind) {
      case 'business_card':
        return <BusinessCardEvidenceCard key={key} evidence={item} onOpenLightbox={openLightbox} />;
      case 'image_note':
        return <ImageNoteEvidenceCard key={key} evidence={item} onOpenLightbox={openLightbox} />;
      case 'voice_memo': {
        const ov = optimisticVoice.find(o => o.item === item);
        return <VoiceMemoEvidenceCard key={key} evidence={item} liveSessionId={ov?.sessionId} />;
      }
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="w-5 h-5 text-stone-400 animate-spin" />
      </div>
    );
  }

  return (
    <>
      <div className="flex flex-col gap-4">
        {/* Section header with add actions */}
        <div className="flex items-center justify-between px-1">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold text-stone-700">Captured Evidence</h3>
            {hasEvidence && <span className="text-xs text-stone-400">({allItems.length})</span>}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setVoiceModalOpen(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-stone-200 text-stone-600 hover:bg-white hover:border-stone-300 transition"
            >
              <Plus className="w-3.5 h-3.5" />
              <Mic className="w-3.5 h-3.5" />
              Voice Memo
            </button>
            <button
              onClick={() => setImageModalOpen(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-stone-200 text-stone-600 hover:bg-white hover:border-stone-300 transition"
            >
              <Plus className="w-3.5 h-3.5" />
              <ImageIcon className="w-3.5 h-3.5" />
              Image Note
            </button>
          </div>
        </div>

        {/* Evidence cards */}
        {hasEvidence ? (
          allItems.map((item, i) => renderCard(item, `${item.kind}-${item.createdAt}-${i}`))
        ) : (
          <div className="bg-white border border-stone-200 rounded-xl px-4 py-10 flex flex-col items-center gap-2 text-center">
            <p className="text-sm text-stone-400">No evidence attached yet.</p>
            <p className="text-xs text-stone-300">Add a voice memo or image note using the buttons above.</p>
          </div>
        )}
      </div>

      {/* Lightbox */}
      {lightboxOpen && (
        <Lightbox images={lightboxImages} initialIndex={lightboxIndex} onClose={closeLightbox} />
      )}

      {/* Add Voice Memo Modal */}
      {voiceModalOpen && (
        <AddVoiceMemoModal
          leadId={leadId}
          onClose={() => setVoiceModalOpen(false)}
          onAdded={handleVoiceAdded}
        />
      )}

      {/* Add Image Note Modal */}
      {imageModalOpen && (
        <AddImageNoteModal
          leadId={leadId}
          onClose={() => setImageModalOpen(false)}
          onAdded={handleImageAdded}
        />
      )}
    </>
  );
}
