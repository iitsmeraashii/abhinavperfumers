import { useEffect, useRef, useState } from 'react';
import {
  Image as ImageIcon, Mic, X, ChevronLeft, ChevronRight,
  ZoomIn, ZoomOut, RotateCcw, Play, Pause, Volume2,
  Loader2, CheckCircle2, AlertCircle, FileImage, Clock,
} from 'lucide-react';
import {
  fetchEvidence,
  type LeadEvidenceCollection,
  type BusinessCardEvidence,
  type VoiceMemoEvidence,
  type ImageNoteEvidence,
  type LeadEvidence,
} from './leadEvidenceService';

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

  // Reset pan/zoom when image changes
  useEffect(() => { setScale(1); setOffset({ x: 0, y: 0 }); }, [idx]);

  // Close on Escape, navigate on arrow keys
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
      {/* Controls bar */}
      <div className="absolute top-0 inset-x-0 flex items-center justify-between px-4 py-3 bg-gradient-to-b from-black/60 to-transparent z-10">
        <span className="text-white/80 text-sm font-medium">{current.label}</span>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setScale(s => Math.min(5, s + 0.5))}
            className="p-2 rounded-lg bg-white/10 hover:bg-white/20 text-white transition"
            title="Zoom in"
          >
            <ZoomIn className="w-4 h-4" />
          </button>
          <button
            onClick={() => setScale(s => Math.max(0.5, s - 0.5))}
            className="p-2 rounded-lg bg-white/10 hover:bg-white/20 text-white transition"
            title="Zoom out"
          >
            <ZoomOut className="w-4 h-4" />
          </button>
          <button
            onClick={() => { setScale(1); setOffset({ x: 0, y: 0 }); }}
            className="p-2 rounded-lg bg-white/10 hover:bg-white/20 text-white transition"
            title="Reset"
          >
            <RotateCcw className="w-4 h-4" />
          </button>
          <button
            onClick={onClose}
            className="p-2 rounded-lg bg-white/10 hover:bg-white/20 text-white transition ml-2"
            title="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Prev / Next */}
      {canPrev && (
        <button
          onClick={() => setIdx(i => i - 1)}
          className="absolute left-3 z-10 p-2.5 rounded-full bg-white/10 hover:bg-white/20 text-white transition"
        >
          <ChevronLeft className="w-5 h-5" />
        </button>
      )}
      {canNext && (
        <button
          onClick={() => setIdx(i => i + 1)}
          className="absolute right-3 z-10 p-2.5 rounded-full bg-white/10 hover:bg-white/20 text-white transition"
        >
          <ChevronRight className="w-5 h-5" />
        </button>
      )}

      {/* Image */}
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

      {/* Dot nav */}
      {images.length > 1 && (
        <div className="absolute bottom-4 inset-x-0 flex justify-center gap-1.5">
          {images.map((_, i) => (
            <button
              key={i}
              onClick={() => setIdx(i)}
              className={`w-2 h-2 rounded-full transition-colors ${i === idx ? 'bg-white' : 'bg-white/30'}`}
            />
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

  if (unsupported) {
    return (
      <p className="text-xs text-stone-400 italic">Audio preview unavailable.</p>
    );
  }

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
        {/* Play/Pause */}
        <button
          onClick={toggle}
          className="flex items-center justify-center w-8 h-8 rounded-full bg-stone-900 text-white flex-shrink-0
            hover:bg-stone-700 active:scale-95 transition-all"
          aria-label={playing ? 'Pause' : 'Play'}
        >
          {playing ? <Pause className="w-3.5 h-3.5 fill-current" /> : <Play className="w-3.5 h-3.5 fill-current ml-0.5" />}
        </button>

        {/* Seek bar + timestamps */}
        <div className="flex-1 min-w-0 flex flex-col gap-1">
          <input
            type="range"
            min={0}
            max={duration || 1}
            step={0.1}
            value={current}
            onChange={handleSeek}
            className="w-full h-1.5 rounded-full accent-stone-900 cursor-pointer"
          />
          <div className="flex justify-between text-[10px] text-stone-400 font-mono">
            <span>{fmt(current)}</span>
            <span>{fmt(duration)}</span>
          </div>
        </div>

        {/* Volume (native) */}
        <Volume2 className="w-3.5 h-3.5 text-stone-400 flex-shrink-0" />
      </div>
    </div>
  );
}

// ─── Evidence Cards ───────────────────────────────────────────────────────────

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
            {(['Front', 'Back'] as const).map((side, i) => {
              const img = side === 'Front' ? evidence.frontImage : evidence.backImage;
              if (!img) return null;
              return (
                <button
                  key={side}
                  onClick={() => onOpenLightbox(images, images.findIndex(im => im.label.includes(side)))}
                  className="group relative flex-1 min-w-0 rounded-lg overflow-hidden border border-stone-200
                    hover:border-stone-400 transition-colors focus:outline-none focus:ring-2 focus:ring-stone-400"
                  aria-label={`View ${side} of business card`}
                >
                  <div className="aspect-[1.6/1] bg-stone-100">
                    <img
                      src={img}
                      alt={`Business card ${side.toLowerCase()}`}
                      className="w-full h-full object-cover group-hover:scale-[1.02] transition-transform duration-200"
                    />
                  </div>
                  <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity bg-black/20">
                    <ZoomIn className="w-5 h-5 text-white drop-shadow" />
                  </div>
                  <p className="text-[10px] font-medium text-stone-500 text-center py-1.5 bg-stone-50 border-t border-stone-100">
                    {side}
                  </p>
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
            className="group relative w-full rounded-lg overflow-hidden border border-stone-200
              hover:border-stone-400 transition-colors focus:outline-none focus:ring-2 focus:ring-stone-400"
            aria-label="View notes image"
          >
            <div className="max-h-64 bg-stone-100">
              <img
                src={evidence.imageUrl}
                alt="Notes"
                className="w-full max-h-64 object-cover group-hover:scale-[1.01] transition-transform duration-200"
              />
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

function VoiceMemoEvidenceCard({ evidence }: { evidence: VoiceMemoEvidence }) {
  function fmtDuration(ms: number | null) {
    if (!ms) return null;
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${m}:${sec.toString().padStart(2, '0')}`;
  }

  const duration = fmtDuration(evidence.durationMs);

  return (
    <div className="bg-white border border-stone-200 rounded-xl overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-stone-100 bg-stone-50">
        <div className="flex items-center gap-2">
          <Mic className="w-4 h-4 text-stone-500" />
          <h4 className="text-sm font-semibold text-stone-700">Voice Memo</h4>
        </div>
        <CardTimestamp iso={evidence.createdAt} />
      </div>

      <div className="p-4 space-y-3">
        {/* Meta row — duration only (timestamp is in the header) */}
        {duration && (
          <span className="inline-flex items-center gap-1 font-mono font-medium text-stone-600 bg-stone-100 px-2 py-0.5 rounded-md text-xs">
            {duration}
          </span>
        )}

        {/* Audio player */}
        {evidence.audioUrl ? (
          <AudioPlayer src={evidence.audioUrl} />
        ) : (
          <p className="text-xs text-stone-400 italic">Audio preview unavailable.</p>
        )}

        {/* Transcript */}
        <div className="border-t border-stone-100 pt-3">
          {evidence.transcript ? (
            <>
              <div className="flex items-center gap-1.5 mb-1.5">
                <CheckCircle2 className="w-3.5 h-3.5 text-green-600" />
                <span className="text-[11px] font-semibold text-green-600 uppercase tracking-wide">AI Transcript</span>
              </div>
              <p className="text-sm text-stone-700 leading-relaxed whitespace-pre-wrap">{evidence.transcript}</p>
            </>
          ) : evidence.transcriptionStatus === 'processing' ? (
            <div className="flex items-center gap-2 text-sm text-amber-700">
              <Loader2 className="w-3.5 h-3.5 animate-spin text-amber-500" />
              Generating transcript…
            </div>
          ) : evidence.transcriptionStatus === 'failed' ? (
            <div className="flex items-center gap-2 text-sm text-amber-700">
              <AlertCircle className="w-3.5 h-3.5 text-amber-500" />
              Transcript unavailable
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

export function LeadEvidenceSection({ leadId }: Props) {
  const [collection, setCollection] = useState<LeadEvidenceCollection | null>(null);
  const [loading, setLoading]       = useState(true);

  // Lightbox state
  const [lightboxImages, setLightboxImages] = useState<{ url: string; label: string }[]>([]);
  const [lightboxIndex, setLightboxIndex]   = useState(0);
  const lightboxOpen = lightboxImages.length > 0;

  // Preserve scroll position when lightbox closes
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

  // Only render the section when there is evidence
  const hasEvidence = (collection?.items.length ?? 0) > 0;

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="w-5 h-5 text-stone-400 animate-spin" />
      </div>
    );
  }

  if (!hasEvidence) return null;

  function renderCard(item: LeadEvidence, i: number) {
    switch (item.kind) {
      case 'business_card':
        return (
          <BusinessCardEvidenceCard
            key={`bc-${i}`}
            evidence={item}
            onOpenLightbox={openLightbox}
          />
        );
      case 'image_note':
        return (
          <ImageNoteEvidenceCard
            key={`in-${i}`}
            evidence={item}
            onOpenLightbox={openLightbox}
          />
        );
      case 'voice_memo':
        return <VoiceMemoEvidenceCard key={`vm-${i}`} evidence={item} />;
    }
  }

  return (
    <>
      {/* Evidence cards */}
      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-2 px-1">
          <h3 className="text-sm font-semibold text-stone-700">Captured Evidence</h3>
          <span className="text-xs text-stone-400">({collection!.items.length})</span>
        </div>
        {collection!.items.map((item, i) => renderCard(item, i))}
      </div>

      {/* Lightbox portal */}
      {lightboxOpen && (
        <Lightbox
          images={lightboxImages}
          initialIndex={lightboxIndex}
          onClose={closeLightbox}
        />
      )}
    </>
  );
}
