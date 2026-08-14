// Queue Item Detail Sheet — read-only detail view for any Queue item.
// Shows all captured fields + resolves evidence from both local (IndexedDB)
// and remote (Supabase Storage) sources.
//
// Evidence resolution strategy:
//   1. Local assets: read from IndexedDB 'assets' store via getSessionAssets()
//      using the cardSessionId from draftData. Also reads notesImageDataUrl
//      and voiceNote data directly from draftData.
//   2. Remote assets: if backendSessionId exists, fetch via leadEvidenceService
//      (same service used by Lead Detail, but called by sessionId not leadId).
//   3. Merge: local evidence takes priority for preview (dataURLs are always
//      available); remote evidence fills gaps (e.g. transcription text).
//
// This component does NOT modify leadEvidenceService or Lead Detail's evidence
// retrieval implementation. It only consumes the existing public API.

import { useEffect, useState, useRef } from 'react';
import {
  X, Download, FileImage, Mic, Image as ImageIcon, Camera, QrCode,
  ClipboardList, AlertCircle, Loader2, FileText, MapPin, Globe,
  Phone, Mail, Building2, User, Thermometer, Flame, Snowflake,
  Tag, DollarSign, Target, Award, Clock,
} from 'lucide-react';
import type { QueueItem } from './leadQueueStorage';
import { getDisplayName, getDisplayCompany, getLeadTemperature } from './leadQueueStorage';
import { getSessionAssets } from './captureAssetStorage';
import { fetchEvidence, type BusinessCardEvidence, type VoiceMemoEvidence, type ImageNoteEvidence } from './leadEvidenceService';
import { Lightbox, AudioPlayer } from './LeadEvidenceSection';
import { formatDateTime } from '../utils/dateFormat';
import type { DraftData, LeadTemperature } from './types';

// ─── Evidence resolution types ─────────────────────────────────────────────────

interface ResolvedEvidence {
  businessCard: {
    frontDataUrl: string | null;
    backDataUrl: string | null;
    frontRemoteUrl: string | null;
    backRemoteUrl: string | null;
    createdAt: string | null;
  } | null;
  notesImage: {
    dataUrl: string | null;
    remoteUrl: string | null;
    createdAt: string | null;
  } | null;
  voiceMemo: {
    localBlobUrl: string | null;
    remoteUrl: string | null;
    durationMs: number | null;
    transcript: string | null;
    transcriptionStatus: string;
    createdAt: string | null;
  } | null;
}

const EMPTY_EVIDENCE: ResolvedEvidence = {
  businessCard: null,
  notesImage: null,
  voiceMemo: null,
};

// ─── Field display helpers ─────────────────────────────────────────────────────

function FieldRow({ icon, label, value }: { icon: React.ReactNode; label: string; value: string | null | undefined }) {
  if (!value?.trim()) return null;
  return (
    <div className="flex items-start gap-3 py-2">
      <div className="w-4 h-4 mt-0.5 text-stone-400 shrink-0">{icon}</div>
      <div className="flex-1 min-w-0">
        <p className="text-[11px] font-medium text-stone-400 uppercase tracking-wide">{label}</p>
        <p className="text-sm text-stone-800 mt-0.5 break-words">{value}</p>
      </div>
    </div>
  );
}

function ArrayFieldRow({ icon, label, values }: { icon: React.ReactNode; label: string; values: string[] | undefined }) {
  if (!values || values.length === 0) return null;
  return (
    <div className="flex items-start gap-3 py-2">
      <div className="w-4 h-4 mt-0.5 text-stone-400 shrink-0">{icon}</div>
      <div className="flex-1 min-w-0">
        <p className="text-[11px] font-medium text-stone-400 uppercase tracking-wide">{label}</p>
        <div className="flex flex-wrap gap-1.5 mt-1">
          {values.map((v, i) => (
            <span key={i} className="text-xs font-medium text-stone-700 bg-stone-100 px-2 py-0.5 rounded-md">
              {v}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

function TempBadge({ temp }: { temp: LeadTemperature }) {
  const cfg = {
    Hot:  { icon: <Flame className="w-3 h-3" />,       cls: 'bg-red-50 text-red-700 border-red-200' },
    Warm: { icon: <Thermometer className="w-3 h-3" />, cls: 'bg-amber-50 text-amber-700 border-amber-200' },
    Cold: { icon: <Snowflake className="w-3 h-3" />,   cls: 'bg-blue-50 text-blue-700 border-blue-200' },
  }[temp];
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold border ${cfg.cls}`}>
      {cfg.icon} {temp}
    </span>
  );
}

function MethodBadge({ method }: { method: QueueItem['captureMethod'] }) {
  if (!method) return null;
  const cfg = {
    BUSINESS_CARD: { icon: <Camera className="w-3 h-3" />,        label: 'Business Card' },
    QR:            { icon: <QrCode className="w-3 h-3" />,         label: 'QR Scan' },
    MANUAL:        { icon: <ClipboardList className="w-3 h-3" />,  label: 'Manual Entry' },
  }[method];
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold border bg-stone-100 text-stone-700 border-stone-200">
      {cfg.icon} {cfg.label}
    </span>
  );
}

// ─── Evidence card sub-components ──────────────────────────────────────────────

function BusinessCardPreview({
  evidence,
  onOpenLightbox,
}: {
  evidence: NonNullable<ResolvedEvidence['businessCard']>;
  onOpenLightbox: (images: { url: string; label: string }[], index: number) => void;
}) {
  const images: { url: string; label: string }[] = [];
  const frontUrl = evidence.frontDataUrl ?? evidence.frontRemoteUrl;
  const backUrl = evidence.backDataUrl ?? evidence.backRemoteUrl;
  if (frontUrl) images.push({ url: frontUrl, label: 'Business Card — Front' });
  if (backUrl) images.push({ url: backUrl, label: 'Business Card — Back' });

  if (images.length === 0) {
    return (
      <div className="bg-white border border-stone-200 rounded-xl px-4 py-6 text-center">
        <FileImage className="w-6 h-6 text-stone-300 mx-auto mb-2" />
        <p className="text-sm text-stone-400">Business card images unavailable.</p>
      </div>
    );
  }

  return (
    <div className="bg-white border border-stone-200 rounded-xl overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-stone-100 bg-stone-50">
        <FileImage className="w-4 h-4 text-stone-500" />
        <h4 className="text-sm font-semibold text-stone-700">Business Card</h4>
      </div>
      <div className="p-4">
        <div className="flex gap-3">
          {(['Front', 'Back'] as const).map(side => {
            const url = side === 'Front' ? frontUrl : backUrl;
            if (!url) return null;
            const idx = images.findIndex(im => im.label.includes(side));
            return (
              <button
                key={side}
                onClick={() => onOpenLightbox(images, idx)}
                className="group relative flex-1 min-w-0 rounded-lg overflow-hidden border border-stone-200 hover:border-stone-400 transition-colors focus:outline-none focus:ring-2 focus:ring-stone-400"
                aria-label={`View ${side} of business card`}
              >
                <div className="aspect-[1.6/1] bg-stone-100">
                  <img src={url} alt={`Business card ${side.toLowerCase()}`} className="w-full h-full object-cover group-hover:scale-[1.02] transition-transform duration-200" />
                </div>
                <p className="text-[10px] font-medium text-stone-500 text-center py-1.5 bg-stone-50 border-t border-stone-100">{side}</p>
              </button>
            );
          })}
        </div>
        {frontUrl && <DownloadButton url={frontUrl} filename="business-card-front.jpg" />}
        {backUrl && <DownloadButton url={backUrl} filename="business-card-back.jpg" className="mt-2" />}
      </div>
    </div>
  );
}

function NotesImagePreview({
  evidence,
  onOpenLightbox,
}: {
  evidence: NonNullable<ResolvedEvidence['notesImage']>;
  onOpenLightbox: (images: { url: string; label: string }[], index: number) => void;
}) {
  const url = evidence.dataUrl ?? evidence.remoteUrl;

  if (!url) {
    return (
      <div className="bg-white border border-stone-200 rounded-xl px-4 py-6 text-center">
        <ImageIcon className="w-6 h-6 text-stone-300 mx-auto mb-2" />
        <p className="text-sm text-stone-400">Notes image unavailable.</p>
      </div>
    );
  }

  return (
    <div className="bg-white border border-stone-200 rounded-xl overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-stone-100 bg-stone-50">
        <ImageIcon className="w-4 h-4 text-stone-500" />
        <h4 className="text-sm font-semibold text-stone-700">Notes Image</h4>
      </div>
      <div className="p-4">
        <button
          onClick={() => onOpenLightbox([{ url, label: 'Notes Image' }], 0)}
          className="group relative w-full rounded-lg overflow-hidden border border-stone-200 hover:border-stone-400 transition-colors focus:outline-none focus:ring-2 focus:ring-stone-400"
          aria-label="View notes image"
        >
          <div className="max-h-64 bg-stone-100">
            <img src={url} alt="Notes" className="w-full max-h-64 object-cover group-hover:scale-[1.01] transition-transform duration-200" />
          </div>
        </button>
        <DownloadButton url={url} filename="notes-image.jpg" className="mt-2" />
      </div>
    </div>
  );
}

function VoiceMemoPreview({ evidence }: { evidence: NonNullable<ResolvedEvidence['voiceMemo']> }) {
  const audioUrl = evidence.localBlobUrl ?? evidence.remoteUrl;

  return (
    <div className="bg-white border border-stone-200 rounded-xl overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-stone-100 bg-stone-50">
        <Mic className="w-4 h-4 text-stone-500" />
        <h4 className="text-sm font-semibold text-stone-700">Voice Memo</h4>
      </div>
      <div className="p-4 space-y-3">
        {evidence.durationMs != null && (
          <span className="inline-flex items-center gap-1 font-mono font-medium text-stone-600 bg-stone-100 px-2 py-0.5 rounded-md text-xs">
            {Math.floor(evidence.durationMs / 60000)}:{Math.floor((evidence.durationMs % 60000) / 1000).toString().padStart(2, '0')}
          </span>
        )}

        {audioUrl ? (
          <AudioPlayer src={audioUrl} />
        ) : (
          <p className="text-xs text-stone-400 italic">Audio preview unavailable.</p>
        )}

        <div className="border-t border-stone-100 pt-3">
          {evidence.transcript ? (
            <>
              <p className="text-[11px] font-semibold text-stone-500 uppercase tracking-wide mb-1">Transcript</p>
              <p className="text-sm text-stone-700 leading-relaxed whitespace-pre-wrap">{evidence.transcript}</p>
            </>
          ) : (
            <p className="text-xs text-stone-400 italic">Transcript unavailable.</p>
          )}
        </div>

        {audioUrl && <DownloadButton url={audioUrl} filename="voice-note.webm" className="mt-1" />}
      </div>
    </div>
  );
}

// ─── Download helper ───────────────────────────────────────────────────────────

function DownloadButton({ url, filename, className = '' }: { url: string; filename: string; className?: string }) {
  const [downloading, setDownloading] = useState(false);

  async function handleDownload(e: React.MouseEvent) {
    e.stopPropagation();
    // data: URLs and blob: URLs work with direct <a download>
    if (url.startsWith('data:') || url.startsWith('blob:')) {
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      return;
    }
    // Cross-origin signed URLs (Supabase Storage) require fetching the blob
    // first — the download attribute is ignored for cross-origin hrefs.
    setDownloading(true);
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const objUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = objUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(objUrl);
    } catch {
      // Fallback: open in a new tab so the user can save manually
      window.open(url, '_blank');
    } finally {
      setDownloading(false);
    }
  }
  return (
    <button
      onClick={handleDownload}
      disabled={downloading}
      className={`flex items-center justify-center gap-1.5 w-full py-2 rounded-lg border border-stone-200 text-stone-600 text-xs font-medium hover:bg-stone-50 transition disabled:opacity-50 ${className}`}
    >
      {downloading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
      {downloading ? 'Downloading…' : 'Download'}
    </button>
  );
}

// ─── Evidence resolution logic ─────────────────────────────────────────────────

async function resolveEvidence(item: QueueItem): Promise<ResolvedEvidence> {
  const dd = item.draftData;
  const result: ResolvedEvidence = { ...EMPTY_EVIDENCE };

  // ── 1. Local business card assets from IndexedDB ─────────────────────────
  const cardSessionId = dd.cardSessionId as string | undefined;
  if (cardSessionId) {
    try {
      const localAssets = await getSessionAssets(cardSessionId);
      const front = localAssets.find(a => a.side === 'front');
      const back = localAssets.find(a => a.side === 'back');
      if (front || back) {
        result.businessCard = {
          frontDataUrl: front?.dataUrl ?? null,
          backDataUrl: back?.dataUrl ?? null,
          frontRemoteUrl: null,
          backRemoteUrl: null,
          createdAt: (front ?? back)?.createdAt ?? null,
        };
      }
    } catch { /* IndexedDB may be unavailable */ }
  }

  // ── 2. Local notes image from draftData ──────────────────────────────────
  if (dd.notesImageDataUrl) {
    result.notesImage = {
      dataUrl: dd.notesImageDataUrl,
      remoteUrl: null,
      createdAt: null,
    };
  }

  // ── 3. Local voice note from draftData ───────────────────────────────────
  // Voice notes are stored as blobs in the capture session, not in IndexedDB
  // assets store. The draftData carries transcript + duration. The actual
  // audio blob is not persisted in draftData, so we can only show transcript.
  if (dd.voiceNoteTranscript || dd.voiceNoteDurationMs) {
    result.voiceMemo = {
      localBlobUrl: null,  // audio blob not available outside active session
      remoteUrl: null,
      durationMs: dd.voiceNoteDurationMs ?? null,
      transcript: dd.voiceNoteTranscript ?? null,
      transcriptionStatus: dd.voiceNoteTranscript ? 'done' : 'none',
      createdAt: null,
    };
  }

  // ── 4. Remote evidence from Supabase (if backendSessionId exists) ────────
  if (item.backendSessionId) {
    try {
      const collection = await fetchEvidence({ sessionId: item.backendSessionId });
      for (const ev of collection.items) {
        if (ev.kind === 'business_card') {
          const bc = ev as BusinessCardEvidence;
          if (!result.businessCard) {
            result.businessCard = {
              frontDataUrl: null,
              backDataUrl: null,
              frontRemoteUrl: bc.frontImage,
              backRemoteUrl: bc.backImage,
              createdAt: bc.createdAt,
            };
          } else {
            // Fill in remote URLs where local is missing
            if (!result.businessCard.frontRemoteUrl && bc.frontImage) {
              result.businessCard.frontRemoteUrl = bc.frontImage;
            }
            if (!result.businessCard.backRemoteUrl && bc.backImage) {
              result.businessCard.backRemoteUrl = bc.backImage;
            }
          }
        } else if (ev.kind === 'image_note') {
          const im = ev as ImageNoteEvidence;
          if (!result.notesImage) {
            result.notesImage = {
              dataUrl: null,
              remoteUrl: im.imageUrl,
              createdAt: im.createdAt,
            };
          } else if (!result.notesImage.remoteUrl && im.imageUrl) {
            result.notesImage.remoteUrl = im.imageUrl;
          }
        } else if (ev.kind === 'voice_memo') {
          const vm = ev as VoiceMemoEvidence;
          if (!result.voiceMemo) {
            result.voiceMemo = {
              localBlobUrl: null,
              remoteUrl: vm.audioUrl,
              durationMs: vm.durationMs,
              transcript: vm.transcript,
              transcriptionStatus: vm.transcriptionStatus,
              createdAt: vm.createdAt,
            };
          } else {
            // Enrich local with remote data
            if (!result.voiceMemo.remoteUrl && vm.audioUrl) {
              result.voiceMemo.remoteUrl = vm.audioUrl;
            }
            if (result.voiceMemo.durationMs == null && vm.durationMs != null) {
              result.voiceMemo.durationMs = vm.durationMs;
            }
            if (!result.voiceMemo.transcript && vm.transcript) {
              result.voiceMemo.transcript = vm.transcript;
              result.voiceMemo.transcriptionStatus = vm.transcriptionStatus;
            }
          }
        }
      }
    } catch { /* network errors are fine — local evidence still shows */ }
  }

  return result;
}

// ─── Main detail sheet component ───────────────────────────────────────────────

interface Props {
  item: QueueItem;
  onClose: () => void;
}

export function QueueItemDetailSheet({ item, onClose }: Props) {
  const [evidence, setEvidence] = useState<ResolvedEvidence | null>(null);
  const [evidenceLoading, setEvidenceLoading] = useState(true);
  const [lightboxImages, setLightboxImages] = useState<{ url: string; label: string }[]>([]);
  const [lightboxIndex, setLightboxIndex] = useState(0);
  const scrollYRef = useRef(0);
  const dd: DraftData = item.draftData;

  useEffect(() => {
    let mounted = true;
    setEvidenceLoading(true);
    resolveEvidence(item).then(ev => {
      if (!mounted) return;
      setEvidence(ev);
      setEvidenceLoading(false);
    });
    return () => { mounted = false; };
  }, [item.id]);

  // Lock body scroll while open
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, []);

  // Close on Escape
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && lightboxImages.length === 0) onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, lightboxImages.length]);

  function openLightbox(images: { url: string; label: string }[], index: number) {
    scrollYRef.current = window.scrollY;
    setLightboxImages(images);
    setLightboxIndex(index);
  }

  function closeLightbox() {
    setLightboxImages([]);
    requestAnimationFrame(() => window.scrollTo(0, scrollYRef.current));
  }

  function handleBackdrop(e: React.MouseEvent) {
    if (e.target === e.currentTarget) onClose();
  }

  const name = getDisplayName(item);
  const company = getDisplayCompany(item);
  const temp = getLeadTemperature(item);
  const phones = dd.phoneNumbers?.length ? dd.phoneNumbers : (dd.phone ? [dd.phone] : []);
  const emails = dd.emails?.length ? dd.emails : (dd.email ? [dd.email] : []);

  const hasEvidence = !!(evidence?.businessCard || evidence?.notesImage || evidence?.voiceMemo);

  return (
    <div
      className="fixed inset-0 z-40 flex items-end sm:items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={handleBackdrop}
    >
      <div className="relative w-full sm:max-w-lg max-h-[92vh] bg-stone-50 rounded-t-2xl sm:rounded-2xl shadow-2xl overflow-hidden flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-stone-200 bg-white shrink-0">
          <div className="flex-1 min-w-0">
            <h2 className="text-base font-bold text-stone-900 truncate">{name}</h2>
            {company && <p className="text-xs text-stone-500 truncate mt-0.5">{company}</p>}
          </div>
          <button onClick={onClose} className="p-2 rounded-lg hover:bg-stone-100 text-stone-400 transition shrink-0">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Scrollable content */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {/* Meta badges */}
          <div className="flex items-center gap-2 flex-wrap">
            <MethodBadge method={item.captureMethod} />
            {temp && <TempBadge temp={temp} />}
            {dd.leadType && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold border bg-stone-100 text-stone-700 border-stone-200">
                <Tag className="w-3 h-3" /> {dd.leadType === 'NEW' ? 'New Lead' : 'Existing Lead'}
              </span>
            )}
          </div>

          {/* Timestamps */}
          <div className="flex items-center gap-3 text-[11px] text-stone-400">
            <span className="flex items-center gap-1">
              <Clock className="w-3 h-3" /> Created {formatDateTime(item.createdAt) ?? item.createdAt}
            </span>
          </div>

          {/* Sync status */}
          {item.lastError && (
            <div className="rounded-lg bg-red-50 border border-red-200 px-3 py-2">
              <p className="text-[11px] font-semibold text-red-700 uppercase tracking-wide flex items-center gap-1.5">
                <AlertCircle className="w-3.5 h-3.5" /> Sync Error
              </p>
              <p className="text-xs text-red-600 mt-1">{item.lastError}</p>
            </div>
          )}

          {/* Contact fields */}
          <div className="bg-white border border-stone-200 rounded-xl px-4 py-3">
            <h3 className="text-xs font-bold text-stone-500 uppercase tracking-wide mb-2">Contact Details</h3>
            <FieldRow icon={<User className="w-4 h-4" />} label="Name" value={dd.clientName} />
            <FieldRow icon={<Building2 className="w-4 h-4" />} label="Company" value={dd.company} />
            <FieldRow icon={<Mail className="w-4 h-4" />} label="Designation" value={dd.designation} />
            <ArrayFieldRow icon={<Phone className="w-4 h-4" />} label="Phone" values={phones} />
            <ArrayFieldRow icon={<Mail className="w-4 h-4" />} label="Email" values={emails} />
            <FieldRow icon={<Globe className="w-4 h-4" />} label="Website" value={dd.website} />
            <FieldRow icon={<MapPin className="w-4 h-4" />} label="Address" value={dd.address} />
          </div>

          {/* Business details */}
          <div className="bg-white border border-stone-200 rounded-xl px-4 py-3">
            <h3 className="text-xs font-bold text-stone-500 uppercase tracking-wide mb-2">Lead Details</h3>
            <FieldRow icon={<Tag className="w-4 h-4" />} label="Lead Type" value={dd.leadType === 'NEW' ? 'New Lead' : dd.leadType === 'EXISTING' ? 'Existing Lead' : null} />
            <FieldRow icon={<User className="w-4 h-4" />} label="Previous Rep Code" value={dd.previousRepCode} />
            <ArrayFieldRow icon={<Target className="w-4 h-4" />} label="Application" values={dd.application as string[] | undefined} />
            <FieldRow icon={<DollarSign className="w-4 h-4" />} label="Price Range" value={dd.priceRange} />
            <ArrayFieldRow icon={<Award className="w-4 h-4" />} label="Benchmark" values={dd.benchmark} />
            <ArrayFieldRow icon={<Globe className="w-4 h-4" />} label="Target Market" values={dd.targetMarket} />
            <ArrayFieldRow icon={<Award className="w-4 h-4" />} label="Certification" values={dd.certification} />
            <ArrayFieldRow icon={<Tag className="w-4 h-4" />} label="Quick Keywords" values={dd.quickKeywords} />
          </div>

          {/* Notes */}
          {(dd.notes?.trim() || dd.rawQr) && (
            <div className="bg-white border border-stone-200 rounded-xl px-4 py-3">
              <h3 className="text-xs font-bold text-stone-500 uppercase tracking-wide mb-2">Notes</h3>
              {dd.notes?.trim() && (
                <p className="text-sm text-stone-700 leading-relaxed whitespace-pre-wrap">{dd.notes}</p>
              )}
              {dd.rawQr && (
                <div className="mt-2 pt-2 border-t border-stone-100">
                  <p className="text-[11px] font-medium text-stone-400 uppercase tracking-wide">Raw QR Data</p>
                  <p className="text-xs text-stone-600 font-mono mt-1 break-all">{dd.rawQr}</p>
                </div>
              )}
            </div>
          )}

          {/* Extraction metadata */}
          {(dd.extractionSource || dd.extractionConfidence != null || dd.ocrRawText || dd.visionRawText) && (
            <div className="bg-white border border-stone-200 rounded-xl px-4 py-3">
              <h3 className="text-xs font-bold text-stone-500 uppercase tracking-wide mb-2">Extraction</h3>
              <FieldRow icon={<FileText className="w-4 h-4" />} label="Source" value={dd.extractionSource} />
              {dd.extractionConfidence != null && (
                <div className="flex items-start gap-3 py-2">
                  <div className="w-4 h-4 mt-0.5 text-stone-400 shrink-0"><FileText className="w-4 h-4" /></div>
                  <div className="flex-1">
                    <p className="text-[11px] font-medium text-stone-400 uppercase tracking-wide">Confidence</p>
                    <p className="text-sm text-stone-800 mt-0.5">{Math.round(dd.extractionConfidence * 100)}%</p>
                  </div>
                </div>
              )}
              {dd.ocrRawText && (
                <div className="mt-2 pt-2 border-t border-stone-100">
                  <p className="text-[11px] font-medium text-stone-400 uppercase tracking-wide">OCR Raw Text</p>
                  <p className="text-xs text-stone-600 font-mono mt-1 whitespace-pre-wrap break-words">{dd.ocrRawText}</p>
                </div>
              )}
              {dd.visionRawText && (
                <div className="mt-2 pt-2 border-t border-stone-100">
                  <p className="text-[11px] font-medium text-stone-400 uppercase tracking-wide">Vision Raw Text</p>
                  <p className="text-xs text-stone-600 font-mono mt-1 whitespace-pre-wrap break-words">{dd.visionRawText}</p>
                </div>
              )}
            </div>
          )}

          {/* Evidence section */}
          <div>
            <h3 className="text-xs font-bold text-stone-500 uppercase tracking-wide mb-3 flex items-center gap-1.5">
              <FileImage className="w-3.5 h-3.5" /> Captured Evidence
            </h3>
            {evidenceLoading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="w-5 h-5 text-stone-400 animate-spin" />
              </div>
            ) : hasEvidence && evidence ? (
              <div className="space-y-3">
                {evidence.businessCard && (
                  <BusinessCardPreview evidence={evidence.businessCard} onOpenLightbox={openLightbox} />
                )}
                {evidence.notesImage && (
                  <NotesImagePreview evidence={evidence.notesImage} onOpenLightbox={openLightbox} />
                )}
                {evidence.voiceMemo && (
                  <VoiceMemoPreview evidence={evidence.voiceMemo} />
                )}
              </div>
            ) : (
              <div className="bg-white border border-stone-200 rounded-xl px-4 py-8 text-center">
                <FileImage className="w-6 h-6 text-stone-300 mx-auto mb-2" />
                <p className="text-sm text-stone-400">No evidence attached.</p>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Lightbox */}
      {lightboxImages.length > 0 && (
        <Lightbox images={lightboxImages} initialIndex={lightboxIndex} onClose={closeLightbox} />
      )}
    </div>
  );
}
