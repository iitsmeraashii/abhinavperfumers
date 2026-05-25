// Mobile debug overlay for QR + OCR capture troubleshooting.
// Floating button + bottom-sheet. Visible in all environments.

import { useState, useCallback, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Bug, X, ChevronDown, ChevronRight, Clipboard, Check, AlertTriangle, RefreshCw, WifiOff, CheckCircle, ShieldCheck, ShieldOff } from 'lucide-react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from '../supabaseClient';
import { useAuth } from '../AuthContext';
import type { BackendSyncState, BusinessCardAsset, CaptureSession, OcrResult, OcrStatus, SyncStatus } from './types';
import type { OcrPipelineDiagnostics } from './useOcr';
import type { ParsedContact } from './parseQrPayload';

// ── Types ────────────────────────────────────────────────────────────────────

export interface DebugLogEntry {
  ts: number;
  step: string;
  detail?: unknown;
  level?: 'info' | 'warn' | 'error';
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function fmt(v: unknown): string {
  try { return JSON.stringify(v, null, 2); }
  catch { return String(v); }
}

function timeLabel(ts: number): string {
  const d = new Date(ts);
  return [
    d.getHours().toString().padStart(2, '0'),
    d.getMinutes().toString().padStart(2, '0'),
    d.getSeconds().toString().padStart(2, '0'),
  ].join(':') + '.' + d.getMilliseconds().toString().padStart(3, '0');
}

function elapsedMs(from: number, to: number): string {
  const diff = to - from;
  return diff < 1000 ? `${diff}ms` : `${(diff / 1000).toFixed(2)}s`;
}

// ── JSON block with copy ──────────────────────────────────────────────────────

function JsonBlock({ value }: { value: unknown }) {
  const [copied, setCopied] = useState(false);
  const text = fmt(value);

  function handleCopy() {
    navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  return (
    <div className="relative">
      <button
        onClick={handleCopy}
        className="absolute top-1 right-1 z-10 p-1 text-stone-500 hover:text-stone-300 transition-colors bg-stone-900/80 rounded"
        title="Copy"
      >
        {copied
          ? <Check className="w-3 h-3 text-green-400" />
          : <Clipboard className="w-3 h-3" />}
      </button>
      <pre
        style={{ fontFamily: 'monospace', fontSize: 11, lineHeight: 1.55 }}
        className="text-green-300 whitespace-pre-wrap break-all overflow-x-hidden pr-7 py-1"
      >
        {text}
      </pre>
    </div>
  );
}

// ── Collapsible section ───────────────────────────────────────────────────────

function Section({
  title, badge, badgeColor, children, defaultOpen = false,
}: {
  title: string;
  badge?: string;
  badgeColor?: 'amber' | 'green' | 'red' | 'sky';
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);

  const badgeClass =
    badgeColor === 'green' ? 'bg-green-600 text-white' :
    badgeColor === 'red'   ? 'bg-red-600 text-white' :
    badgeColor === 'sky'   ? 'bg-sky-600 text-white' :
                             'bg-amber-500 text-stone-900';

  return (
    <div className="rounded-xl overflow-hidden border border-stone-700">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between px-3 py-3 bg-stone-800 active:bg-stone-700 transition-colors"
      >
        <span className="flex items-center gap-2 text-left">
          {open
            ? <ChevronDown className="w-3.5 h-3.5 text-stone-400 flex-shrink-0" />
            : <ChevronRight className="w-3.5 h-3.5 text-stone-400 flex-shrink-0" />}
          <span
            style={{ fontFamily: 'monospace', fontSize: 11 }}
            className="font-bold text-stone-200 uppercase tracking-wider leading-none"
          >
            {title}
          </span>
        </span>
        {badge && (
          <span className={`ml-2 flex-shrink-0 text-[10px] font-bold rounded-full px-2 py-0.5 ${badgeClass}`}>
            {badge}
          </span>
        )}
      </button>

      <div
        className="bg-stone-950 px-3 pb-3 pt-2.5"
        style={{ display: open ? 'block' : 'none' }}
      >
        {children}
      </div>
    </div>
  );
}

// ── Field mapping row ─────────────────────────────────────────────────────────

function MappingRow({ from, to, value }: { from: string; to: string; value: unknown }) {
  const present = value !== undefined && value !== null && value !== '';
  return (
    <div className="py-1 border-b border-stone-800 last:border-0">
      <div className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
        <span style={{ fontFamily: 'monospace', fontSize: 10 }} className="text-sky-400 break-all">{from}</span>
        <span style={{ fontFamily: 'monospace', fontSize: 10 }} className="text-stone-500">→</span>
        <span style={{ fontFamily: 'monospace', fontSize: 10 }} className="text-amber-300 break-all">{to}</span>
      </div>
      <div style={{ fontFamily: 'monospace', fontSize: 11 }} className={`mt-0.5 break-all ${present ? 'text-green-300' : 'text-red-400'}`}>
        {present ? JSON.stringify(value) : '(empty)'}
      </div>
    </div>
  );
}

// ── OCR status pill ───────────────────────────────────────────────────────────

function OcrStatusPill({ status }: { status: OcrStatus | 'unknown' }) {
  const cfg: Record<string, { bg: string; text: string; label: string }> = {
    idle:       { bg: 'bg-stone-700',  text: 'text-stone-300', label: 'IDLE' },
    processing: { bg: 'bg-amber-700',  text: 'text-amber-200', label: 'PROCESSING' },
    done:       { bg: 'bg-green-800',  text: 'text-green-300', label: 'COMPLETED' },
    error:      { bg: 'bg-red-800',    text: 'text-red-300',   label: 'FAILED' },
    unknown:    { bg: 'bg-stone-700',  text: 'text-stone-400', label: 'UNKNOWN' },
  };
  const c = cfg[status] ?? cfg.unknown;
  return (
    <span
      style={{ fontFamily: 'monospace', fontSize: 10 }}
      className={`inline-flex items-center rounded-full px-2.5 py-1 font-bold uppercase tracking-wider ${c.bg} ${c.text}`}
    >
      {c.label}
    </span>
  );
}

// ── OCR sections ──────────────────────────────────────────────────────────────

interface OcrDebugSectionsProps {
  ocrStatus: OcrStatus;
  ocrProgress: number;
  ocrProgressLabel: string;
  lastOcrResult: OcrResult | null;
  ocrError: string | null;
  ocrLog: DebugLogEntry[];
  draftData: CaptureSession['draftData'];
  ocrDiagnostics: OcrPipelineDiagnostics | null;
}

function OcrDebugSections({
  ocrStatus, ocrProgress, ocrProgressLabel, lastOcrResult, ocrError, ocrLog, draftData, ocrDiagnostics,
}: OcrDebugSectionsProps) {
  const hasResult = !!lastOcrResult;
  const hasError  = ocrStatus === 'error' || !!ocrError;

  // Timeline: only OCR-tagged log entries
  const timeline = ocrLog.filter(e =>
    e.step.toLowerCase().includes('ocr') ||
    e.step.toLowerCase().includes('image') ||
    e.step.toLowerCase().includes('pars') ||
    e.step.toLowerCase().includes('draft') ||
    e.step.toLowerCase().includes('form')
  );

  // ── 1. OCR STATUS ──────────────────────────────────────────────────────────
  const statusBadgeColor: 'green' | 'red' | 'amber' | 'sky' | undefined =
    ocrStatus === 'done'       ? 'green' :
    ocrStatus === 'error'      ? 'red' :
    ocrStatus === 'processing' ? 'amber' :
    undefined;

  const d = ocrDiagnostics;

  return (
    <>
      {/* 0. OCR INPUT PREVIEW */}
      <Section
        title="OCR Input Preview"
        badge={d ? (d.canvasIsBlank ? 'BLANK!' : d.fallbackTriggered ? 'FALLBACK' : 'OK') : undefined}
        badgeColor={d ? (d.canvasIsBlank ? 'red' : d.fallbackTriggered ? 'amber' : 'green') : undefined}
        defaultOpen
      >
        {!d ? (
          <p style={{ fontSize: 11 }} className="text-stone-500 py-1">
            No OCR run yet. Capture a business card front to see image previews.
          </p>
        ) : (
          <div className="space-y-3">
            {/* Processed / OCR input image */}
            <div>
              <div style={{ fontSize: 10, fontFamily: 'monospace' }} className="text-amber-400 uppercase tracking-wider mb-1.5">
                OCR Input Image ({d.ocrInputSource === 'original_fallback' ? 'ORIGINAL FALLBACK' : 'PROCESSED'})
              </div>
              {d.processedObjectUrl ? (
                <img
                  src={d.processedObjectUrl}
                  alt="OCR input"
                  className="w-full rounded-lg border border-stone-700"
                  style={{ maxHeight: 200, objectFit: 'contain', background: '#000' }}
                />
              ) : d.ocrInputObjectUrl ? (
                <img
                  src={d.ocrInputObjectUrl}
                  alt="OCR input (original)"
                  className="w-full rounded-lg border border-amber-700"
                  style={{ maxHeight: 200, objectFit: 'contain', background: '#000' }}
                />
              ) : (
                <div
                  className="w-full rounded-lg border border-stone-700 flex items-center justify-center"
                  style={{ height: 100, background: '#111' }}
                >
                  <span style={{ fontSize: 11 }} className="text-stone-500">No image URL available</span>
                </div>
              )}
              <div style={{ fontSize: 10, fontFamily: 'monospace', lineHeight: 1.6 }} className="mt-1 text-stone-500">
                <span className="text-amber-300">{d.processedWidth}×{d.processedHeight}px</span>
                {' · '}
                <span className="text-amber-300">{Math.round(d.processedSizeBytes / 1024)}KB</span>
                {' · '}
                {d.processedMimeType}
              </div>
            </div>
          </div>
        )}
      </Section>

      {/* 0b. IMAGE PIPELINE DIAGNOSTICS */}
      <Section
        title="Image Pipeline Diagnostics"
        badge={d ? (d.canvasIsBlank ? 'CANVAS BLANK' : d.toBlobOk === false ? 'BLOB FAIL' : 'PASS') : undefined}
        badgeColor={d ? (d.canvasIsBlank || d.toBlobOk === false ? 'red' : 'green') : undefined}
        defaultOpen={!!d}
      >
        {!d ? (
          <p style={{ fontSize: 11 }} className="text-stone-500 py-1">Run OCR to see pipeline diagnostics.</p>
        ) : (
          <div className="space-y-2">
            {/* Original image info */}
            <div style={{ fontSize: 10, fontFamily: 'monospace' }} className="text-stone-500 uppercase tracking-wider">Original Image</div>
            <div style={{ fontFamily: 'monospace', fontSize: 10, lineHeight: 1.7 }} className="text-stone-400 space-y-0.5 pl-1">
              <div>dataUrl length: <span className="text-amber-300">{d.originalDataUrlLength.toLocaleString()} chars</span></div>
              <div>mime type: <span className="text-amber-300">{d.originalMimeType}</span></div>
              <div>natural dims: <span className={d.originalNaturalWidth > 0 ? 'text-green-300' : 'text-red-400'}>{d.originalNaturalWidth}×{d.originalNaturalHeight}</span></div>
              <div>loaded: <span className={d.originalImageLoaded ? 'text-green-400' : 'text-red-400'}>{String(d.originalImageLoaded)}</span></div>
            </div>

            {/* Canvas state */}
            <div style={{ fontSize: 10, fontFamily: 'monospace' }} className="text-stone-500 uppercase tracking-wider mt-2">Canvas Pipeline</div>
            <div style={{ fontFamily: 'monospace', fontSize: 10, lineHeight: 1.7 }} className="text-stone-400 space-y-0.5 pl-1">
              <div>canvas ctx: <span className={d.canvasContextOk ? 'text-green-400' : 'text-red-400'}>{d.canvasContextOk ? '✓ ok' : '✗ null (memory pressure?)'}</span></div>
              <div>drawImage: <span className={d.drawImageOk ? 'text-green-400' : 'text-red-400'}>{d.drawImageOk ? '✓ called' : '✗ failed'}</span></div>
              <div>toBlob: <span className={d.toBlobOk ? 'text-green-400' : 'text-red-400'}>{d.toBlobOk ? '✓ ok' : '✗ returned null'}</span></div>
              <div>processed dims: <span className="text-amber-300">{d.processedWidth}×{d.processedHeight}</span></div>
              <div>processed bytes: <span className="text-amber-300">{Math.round(d.processedSizeBytes / 1024)}KB</span></div>
              <div>stage: <span className="text-sky-300">{d.processingStage}</span></div>
            </div>

            {/* Pixel validation */}
            <div style={{ fontSize: 10, fontFamily: 'monospace' }} className="text-stone-500 uppercase tracking-wider mt-2">Pixel Validation</div>
            <div style={{ fontFamily: 'monospace', fontSize: 10, lineHeight: 1.7 }} className="text-stone-400 space-y-0.5 pl-1">
              <div>canvas blank: <span className={d.canvasIsBlank ? 'text-red-400 font-bold' : 'text-green-400'}>{d.canvasIsBlank ? '✗ YES — all pixels zero!' : '✓ no'}</span></div>
              <div>non-zero pixels: <span className={d.nonZeroPixelCount > 0 ? 'text-green-300' : 'text-red-400'}>{d.nonZeroPixelCount} / {d.totalPixelsChecked}</span></div>
              {d.pixelSampleRgba.length > 0 && (
                <div className="break-all">
                  first 20 RGBA: <span className="text-stone-300">[{d.pixelSampleRgba.join(', ')}]</span>
                </div>
              )}
            </div>

            {/* Fallback info */}
            {d.fallbackTriggered && (
              <div className="mt-2 p-2 rounded-lg bg-amber-900/30 border border-amber-700">
                <div style={{ fontSize: 10, fontFamily: 'monospace' }} className="text-amber-300 font-bold mb-1">FALLBACK TRIGGERED</div>
                <div style={{ fontSize: 11, fontFamily: 'monospace' }} className="text-amber-200">{d.fallbackReason}</div>
              </div>
            )}

            {/* OCR source */}
            <div style={{ fontSize: 10, fontFamily: 'monospace' }} className="text-stone-500 uppercase tracking-wider mt-2">OCR Source</div>
            <div style={{ fontFamily: 'monospace', fontSize: 10 }} className="pl-1">
              <span className={d.ocrInputSource === 'original_fallback' ? 'text-amber-300' : 'text-green-300'}>
                {d.ocrInputSource}
              </span>
            </div>

            {/* Checklist */}
            <div className="mt-3 pt-2 border-t border-stone-800 space-y-1">
              <DiagRow label="Image loaded (naturalWidth > 0)"  ok={d.originalImageLoaded && d.originalNaturalWidth > 0} />
              <DiagRow label="Canvas context not null"          ok={d.canvasContextOk} />
              <DiagRow label="drawImage called"                 ok={d.drawImageOk} />
              <DiagRow label="canvas.toBlob succeeded"          ok={!!d.toBlobOk} />
              <DiagRow label="Canvas has non-zero pixels"       ok={!d.canvasIsBlank} />
              <DiagRow label="Processed size > 0"               ok={d.processedSizeBytes > 0} />
            </div>
          </div>
        )}
      </Section>

      {/* 1. OCR STATUS */}
      <Section
        title="OCR Status"
        badge={ocrStatus.toUpperCase()}
        badgeColor={statusBadgeColor}
        defaultOpen
      >
        <div className="flex flex-wrap items-center gap-3 py-1">
          <OcrStatusPill status={ocrStatus} />
          {ocrStatus === 'processing' && (
            <div className="flex-1 min-w-0">
              <div className="h-1.5 bg-stone-700 rounded-full overflow-hidden">
                <div
                  className="h-full bg-amber-500 rounded-full transition-all duration-300"
                  style={{ width: `${Math.round(ocrProgress * 100)}%` }}
                />
              </div>
              <div style={{ fontFamily: 'monospace', fontSize: 10 }} className="mt-1 text-amber-300">
                {Math.round(ocrProgress * 100)}% — {ocrProgressLabel}
              </div>
            </div>
          )}
        </div>
        {hasResult && (
          <div style={{ fontFamily: 'monospace', fontSize: 10 }} className="mt-2 text-stone-400 space-y-0.5">
            <div>completedAt: <span className="text-sky-300">{lastOcrResult.completedAt}</span></div>
            <div>assetId: <span className="text-sky-300">{lastOcrResult.assetId}</span></div>
            <div>rawText length: <span className="text-amber-300">{lastOcrResult.rawText.length} chars</span></div>
            <div>inferredFields: <span className="text-green-300">[{lastOcrResult.inferredFields.join(', ') || 'none'}]</span></div>
            <div>ignoredLines: <span className="text-stone-400">{lastOcrResult.ignoredLines.length}</span></div>
          </div>
        )}
        {!hasResult && ocrStatus === 'idle' && (
          <p style={{ fontSize: 11 }} className="text-stone-500 py-1">
            No OCR run yet. Capture a business card front to trigger OCR.
          </p>
        )}
      </Section>

      {/* 2. OCR RAW TEXT */}
      <Section
        title="OCR Raw Text"
        badge={hasResult ? `${lastOcrResult!.rawText.length}ch` : undefined}
        defaultOpen={hasResult}
      >
        {hasResult && lastOcrResult!.rawText ? (
          <div>
            <div style={{ fontFamily: 'monospace', fontSize: 10 }} className="text-stone-500 mb-1.5 uppercase tracking-wider">
              Exact Tesseract output — whitespace and casing preserved
            </div>
            <div className="relative">
              <CopyableRawText text={lastOcrResult!.rawText} />
            </div>
          </div>
        ) : (
          <p style={{ fontSize: 11 }} className="text-stone-500 py-1">
            {ocrStatus === 'idle' ? 'Waiting for OCR run.' : ocrStatus === 'processing' ? 'OCR in progress…' : '(no raw text)'}
          </p>
        )}
      </Section>

      {/* 3. OCR PARSED FIELDS */}
      <Section
        title="OCR Parsed Fields"
        badge={hasResult ? String(lastOcrResult!.inferredFields.length) : undefined}
        badgeColor={hasResult && lastOcrResult!.inferredFields.length > 0 ? 'green' : undefined}
        defaultOpen={hasResult}
      >
        {hasResult ? (
          <>
            <div className="flex flex-wrap gap-1.5 mb-2.5">
              <span
                style={{ fontSize: 10, fontFamily: 'monospace' }}
                className={[
                  'rounded-full px-2 py-0.5 font-bold uppercase',
                  lastOcrResult!.confidence === 'high'   ? 'bg-green-900 text-green-300' :
                  lastOcrResult!.confidence === 'medium' ? 'bg-yellow-900 text-yellow-300' :
                                                            'bg-red-900 text-red-300',
                ].join(' ')}
              >
                {lastOcrResult!.confidence} confidence
              </span>
              <span style={{ fontSize: 10, fontFamily: 'monospace' }} className="rounded-full px-2 py-0.5 bg-stone-700 text-stone-300">
                {lastOcrResult!.inferredFields.length} / 5 fields
              </span>
            </div>

            {(['clientName', 'company', 'phone', 'email', 'designation'] as const).map(key => {
              const val = lastOcrResult!.fields[key];
              const present = val !== undefined && val !== null && val !== '';
              return (
                <div key={key} className="py-1 border-b border-stone-800 last:border-0 flex items-start justify-between gap-2">
                  <span style={{ fontFamily: 'monospace', fontSize: 10 }} className="text-sky-400 flex-shrink-0 pt-0.5">{key}</span>
                  <span
                    style={{ fontFamily: 'monospace', fontSize: 11 }}
                    className={`break-all text-right ${present ? 'text-green-300' : 'text-stone-600 italic'}`}
                  >
                    {present ? JSON.stringify(val) : '(not extracted)'}
                  </span>
                </div>
              );
            })}

            {lastOcrResult!.ignoredLines.length > 0 && (
              <div className="mt-2.5 pt-2 border-t border-stone-800">
                <div style={{ fontSize: 10, fontFamily: 'monospace' }} className="text-stone-500 mb-1 uppercase tracking-wider">
                  Ignored / noise lines ({lastOcrResult!.ignoredLines.length})
                </div>
                {lastOcrResult!.ignoredLines.map((line, i) => (
                  <div key={i} style={{ fontSize: 11, fontFamily: 'monospace' }} className="text-red-400 break-all py-0.5">
                    — {line}
                  </div>
                ))}
              </div>
            )}
          </>
        ) : (
          <p style={{ fontSize: 11 }} className="text-stone-500 py-1">No parsed fields yet.</p>
        )}
      </Section>

      {/* 4. OCR FIELD MAPPING */}
      <Section
        title="OCR Field Mapping"
        badge={hasResult ? 'ocr → draft' : undefined}
        badgeColor="sky"
        defaultOpen={hasResult}
      >
        {hasResult ? (
          <>
            <div style={{ fontSize: 10, fontFamily: 'monospace' }} className="text-stone-500 mb-2 uppercase tracking-wider">
              parsed OCR field → draftData key → current value in draft
            </div>
            {(['clientName', 'company', 'phone', 'email', 'designation'] as const).map(key => (
              <MappingRow
                key={key}
                from={`ocr.fields.${key}`}
                to={`draftData.${key}`}
                value={draftData[key]}
              />
            ))}
            <div className="mt-2.5 pt-2 border-t border-stone-800">
              <div style={{ fontSize: 10, fontFamily: 'monospace' }} className="text-stone-500 mb-1 uppercase tracking-wider">
                OCR raw text → draftData.ocrRawText
              </div>
              <div style={{ fontFamily: 'monospace', fontSize: 11 }} className={draftData.ocrRawText ? 'text-green-300' : 'text-red-400'}>
                {draftData.ocrRawText
                  ? `${String(draftData.ocrRawText).length} chars stored`
                  : '(not in draft)'}
              </div>
            </div>
          </>
        ) : (
          <p style={{ fontSize: 11 }} className="text-stone-500 py-1">
            Mapping visible after OCR completes and Continue is pressed.
          </p>
        )}
      </Section>

      {/* 5. OCR ERRORS */}
      <Section
        title="OCR Errors"
        badge={hasError ? 'FAIL' : 'OK'}
        badgeColor={hasError ? 'red' : 'green'}
        defaultOpen={hasError}
      >
        {hasError ? (
          <div className="flex items-start gap-2 py-1">
            <AlertTriangle className="w-4 h-4 text-red-400 flex-shrink-0 mt-0.5" />
            <div>
              <div style={{ fontSize: 12 }} className="font-semibold text-red-300">OCR Failed</div>
              <pre
                style={{ fontFamily: 'monospace', fontSize: 11, lineHeight: 1.5 }}
                className="mt-1 text-red-400 whitespace-pre-wrap break-all"
              >
                {ocrError ?? 'Unknown OCR error'}
              </pre>
            </div>
          </div>
        ) : (
          <p style={{ fontSize: 11 }} className="text-green-400 py-1">No errors.</p>
        )}

        {/* Diagnostic checks */}
        <div className="mt-2 pt-2 border-t border-stone-800 space-y-1">
          <DiagRow label="Tesseract loaded" ok={ocrStatus !== 'idle' || hasResult} pending={ocrStatus === 'idle' && !hasResult} />
          <DiagRow label="Raw text non-empty" ok={hasResult && lastOcrResult!.rawText.length > 0} pending={!hasResult} />
          <DiagRow label="At least 1 field parsed" ok={hasResult && lastOcrResult!.inferredFields.length > 0} pending={!hasResult} />
          <DiagRow label="draftData.clientName set" ok={!!draftData.clientName} pending={!hasResult} />
          <DiagRow label="draftData.ocrRawText set" ok={!!draftData.ocrRawText} pending={!hasResult} />
        </div>
      </Section>

      {/* 6. OCR PROCESSING TIMELINE */}
      <Section
        title="OCR Processing Timeline"
        badge={timeline.length > 0 ? String(timeline.length) : undefined}
        defaultOpen={timeline.length > 0}
      >
        {timeline.length === 0 ? (
          <p style={{ fontSize: 11 }} className="text-stone-500 py-1">
            No OCR events yet. Capture a business card to populate.
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {timeline.map((entry, i) => {
              const prev = timeline[i - 1];
              const sincePrev = prev ? elapsedMs(prev.ts, entry.ts) : null;
              const levelColor =
                entry.level === 'error' ? 'text-red-300' :
                entry.level === 'warn'  ? 'text-amber-300' :
                                          'text-sky-300';
              return (
                <div key={i} className="flex gap-2">
                  <div className="flex flex-col items-center gap-0.5 flex-shrink-0">
                    <span style={{ fontFamily: 'monospace', fontSize: 10 }} className="text-stone-500">
                      {timeLabel(entry.ts)}
                    </span>
                    {sincePrev && (
                      <span style={{ fontFamily: 'monospace', fontSize: 9 }} className="text-stone-600">
                        +{sincePrev}
                      </span>
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div style={{ fontSize: 12 }} className={`font-semibold break-words ${levelColor}`}>
                      {entry.step}
                    </div>
                    {entry.detail !== undefined && (
                      <pre
                        style={{ fontFamily: 'monospace', fontSize: 10, lineHeight: 1.5 }}
                        className="mt-0.5 text-stone-400 whitespace-pre-wrap break-all"
                      >
                        {fmt(entry.detail)}
                      </pre>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Section>
    </>
  );
}

// ── Copyable raw text block ───────────────────────────────────────────────────

function CopyableRawText({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  function handleCopy() {
    navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  return (
    <div className="relative">
      <button
        onClick={handleCopy}
        className="absolute top-1 right-1 z-10 p-1 text-stone-500 hover:text-stone-300 transition-colors bg-stone-900/80 rounded"
        title="Copy raw text"
      >
        {copied
          ? <Check className="w-3 h-3 text-green-400" />
          : <Clipboard className="w-3 h-3" />}
      </button>
      <pre
        style={{
          fontFamily: 'monospace',
          fontSize: 11,
          lineHeight: 1.65,
          maxHeight: 200,
          whiteSpace: 'pre',    // preserve ALL whitespace and line breaks
        }}
        className="text-stone-200 overflow-auto pr-7 py-1 border border-stone-700 rounded-lg px-2 bg-stone-900"
      >
        {text}
      </pre>
    </div>
  );
}

// ── Diagnostic row ─────────────────────────────────────────────────────────

function DiagRow({ label, ok, pending }: { label: string; ok: boolean; pending?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span style={{ fontFamily: 'monospace', fontSize: 10 }} className="text-stone-400">{label}</span>
      <span style={{ fontFamily: 'monospace', fontSize: 10 }} className={
        pending ? 'text-stone-600' : ok ? 'text-green-400' : 'text-red-400'
      }>
        {pending ? '—' : ok ? '✓' : '✗'}
      </span>
    </div>
  );
}

// ── Main overlay ──────────────────────────────────────────────────────────────

interface OverlayProps {
  session: CaptureSession;
  lastScan: ParsedContact | null;
  qrScanning: boolean;
  cardAssets: { front: BusinessCardAsset | null; back: BusinessCardAsset | null };
  cardSessionId: string;
  lastOcrResult: OcrResult | null;
  ocrStatus: OcrStatus;
  ocrProgress: number;
  ocrProgressLabel: string;
  ocrError: string | null;
  ocrDiagnostics: OcrPipelineDiagnostics | null;
  log: DebugLogEntry[];
  onClose: () => void;
  onClearLog: () => void;
}

// ── Auth debug section ────────────────────────────────────────────────────────

function AuthDebugSection() {
  const { salesRep } = useAuth();
  const [authSession, setAuthSession] = useState<Session | null>(null);
  const [loading, setLoading]         = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session: s } }) => {
      setAuthSession(s);
      setLoading(false);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_e, s) => {
      setAuthSession(s);
      setLoading(false);
    });

    return () => subscription.unsubscribe();
  }, []);

  const isAuthenticated = !!authSession;
  const expiresAt = authSession?.expires_at
    ? new Date(authSession.expires_at * 1000).toISOString()
    : null;
  const expiresInMs  = authSession?.expires_at
    ? authSession.expires_at * 1000 - Date.now()
    : null;
  const expiresInMin = expiresInMs != null
    ? Math.round(expiresInMs / 60_000)
    : null;

  return (
    <Section
      title="Auth Session"
      badge={loading ? 'LOADING' : isAuthenticated ? 'AUTHENTICATED' : 'NOT AUTH'}
      badgeColor={loading ? undefined : isAuthenticated ? 'green' : 'red'}
      defaultOpen
    >
      <div className="flex items-center gap-3 py-1">
        {isAuthenticated
          ? <ShieldCheck className="w-4 h-4 text-green-400 flex-shrink-0" />
          : <ShieldOff   className="w-4 h-4 text-red-400  flex-shrink-0" />}
        <span
          style={{ fontFamily: 'monospace', fontSize: 11 }}
          className={isAuthenticated ? 'text-green-300' : 'text-red-300'}
        >
          {loading ? 'Checking…' : isAuthenticated ? 'Authenticated' : 'Not authenticated'}
        </span>
      </div>

      <div style={{ fontFamily: 'monospace', fontSize: 10, lineHeight: 1.8 }} className="mt-2 text-stone-400 space-y-0.5">
        <div>
          auth_user_id:{' '}
          <span className={authSession?.user?.id ? 'text-sky-300 break-all' : 'text-stone-600'}>
            {authSession?.user?.id ?? '—'}
          </span>
        </div>
        <div>
          rep_code:{' '}
          <span className={salesRep?.rep_code ? 'text-amber-300' : 'text-stone-600'}>
            {salesRep?.rep_code ?? '—'}
          </span>
        </div>
        <div>
          email:{' '}
          <span className={authSession?.user?.email ? 'text-amber-300' : 'text-stone-600'}>
            {authSession?.user?.email ?? '—'}
          </span>
        </div>
        <div>
          session exists:{' '}
          <span className={isAuthenticated ? 'text-green-400' : 'text-red-400'}>
            {String(isAuthenticated)}
          </span>
        </div>
        <div>
          token expiry:{' '}
          <span className={expiresAt ? (expiresInMin != null && expiresInMin < 5 ? 'text-red-400' : 'text-green-300') : 'text-stone-600'}>
            {expiresAt ?? '—'}
          </span>
        </div>
        {expiresInMin != null && (
          <div>
            expires in:{' '}
            <span className={expiresInMin < 5 ? 'text-red-400' : 'text-stone-300'}>
              {expiresInMin} min
            </span>
          </div>
        )}
        <div>
          provider:{' '}
          <span className="text-stone-300">
            {authSession?.user?.app_metadata?.provider ?? '—'}
          </span>
        </div>
      </div>

      {/* Diagnostic checks */}
      <div className="mt-3 pt-2 border-t border-stone-800 space-y-1">
        <DiagRow label="Session object present"  ok={isAuthenticated}                              pending={loading} />
        <DiagRow label="access_token present"     ok={!!authSession?.access_token}                 pending={loading} />
        <DiagRow label="user.id present"          ok={!!authSession?.user?.id}                     pending={loading} />
        <DiagRow label="Token not expired"        ok={expiresInMin != null && expiresInMin > 0}    pending={loading} />
        <DiagRow label="Token valid > 5 min"      ok={expiresInMin != null && expiresInMin > 5}    pending={loading} />
      </div>
    </Section>
  );
}

// ── Backend sync section ──────────────────────────────────────────────────────

function SyncStatusPill({ status }: { status: SyncStatus | 'unknown' }) {
  const cfg: Record<string, { bg: string; text: string; label: string }> = {
    idle:    { bg: 'bg-stone-700',  text: 'text-stone-300', label: 'IDLE' },
    syncing: { bg: 'bg-amber-700',  text: 'text-amber-200', label: 'SYNCING' },
    synced:  { bg: 'bg-green-800',  text: 'text-green-300', label: 'SYNCED' },
    error:   { bg: 'bg-red-800',    text: 'text-red-300',   label: 'ERROR' },
    offline: { bg: 'bg-stone-600',  text: 'text-stone-300', label: 'OFFLINE' },
    unknown: { bg: 'bg-stone-700',  text: 'text-stone-500', label: 'UNKNOWN' },
  };
  const c = cfg[status] ?? cfg.unknown;
  return (
    <span
      style={{ fontFamily: 'monospace', fontSize: 10 }}
      className={`inline-flex items-center rounded-full px-2.5 py-1 font-bold uppercase tracking-wider ${c.bg} ${c.text}`}
    >
      {c.label}
    </span>
  );
}

function BackendSyncSection({ sync }: { sync: BackendSyncState }) {
  const isActive = sync.backendSessionId !== null;
  const assetEntries  = Object.entries(sync.backendAssetIds);
  const extractionEntries = Object.entries(sync.backendExtractionIds);

  const badgeColor: 'green' | 'red' | 'amber' | undefined =
    sync.status === 'synced'  ? 'green' :
    sync.status === 'error'   ? 'red' :
    sync.status === 'syncing' ? 'amber' :
    undefined;

  return (
    <Section
      title="Backend Sync"
      badge={sync.status.toUpperCase()}
      badgeColor={badgeColor}
      defaultOpen={isActive}
    >
      <div className="flex items-center gap-3 py-1">
        <SyncStatusPill status={sync.status} />
        {sync.status === 'syncing' && (
          <RefreshCw className="w-3 h-3 text-amber-400 animate-spin flex-shrink-0" />
        )}
        {sync.status === 'synced' && (
          <CheckCircle className="w-3 h-3 text-green-400 flex-shrink-0" />
        )}
        {sync.status === 'offline' && (
          <WifiOff className="w-3 h-3 text-stone-400 flex-shrink-0" />
        )}
        {sync.pendingOps > 0 && (
          <span style={{ fontFamily: 'monospace', fontSize: 10 }} className="text-amber-300">
            {sync.pendingOps} op{sync.pendingOps !== 1 ? 's' : ''} pending
          </span>
        )}
      </div>

      <div style={{ fontFamily: 'monospace', fontSize: 10, lineHeight: 1.7 }} className="mt-2 text-stone-400 space-y-0.5">
        <div>
          backendSessionId:{' '}
          <span className={sync.backendSessionId ? 'text-sky-300 break-all' : 'text-stone-600'}>
            {sync.backendSessionId ?? '— not created yet'}
          </span>
        </div>
        <div>
          lastSyncedAt:{' '}
          <span className={sync.lastSyncedAt ? 'text-green-300' : 'text-stone-600'}>
            {sync.lastSyncedAt ?? '—'}
          </span>
        </div>
        {sync.lastError && (
          <div className="text-red-400 break-all">lastError: {sync.lastError}</div>
        )}
      </div>

      {/* Asset linkage */}
      <div className="mt-3 pt-2 border-t border-stone-800">
        <div style={{ fontSize: 10, fontFamily: 'monospace' }} className="text-stone-500 mb-1.5 uppercase tracking-wider">
          Asset Linkage ({assetEntries.length})
        </div>
        {assetEntries.length === 0 ? (
          <p style={{ fontSize: 11 }} className="text-stone-600">No assets synced yet.</p>
        ) : (
          assetEntries.map(([localId, backendId]) => (
            <div key={localId} className="py-1 border-b border-stone-800 last:border-0">
              <div style={{ fontFamily: 'monospace', fontSize: 10 }} className="text-stone-500 break-all">
                local: <span className="text-sky-400">{localId}</span>
              </div>
              <div style={{ fontFamily: 'monospace', fontSize: 10 }} className="text-stone-500 break-all">
                backend: <span className="text-green-300">{backendId}</span>
              </div>
            </div>
          ))
        )}
      </div>

      {/* Extraction result IDs */}
      <div className="mt-3 pt-2 border-t border-stone-800">
        <div style={{ fontSize: 10, fontFamily: 'monospace' }} className="text-stone-500 mb-1.5 uppercase tracking-wider">
          Extraction Results ({extractionEntries.length})
        </div>
        {extractionEntries.length === 0 ? (
          <p style={{ fontSize: 11 }} className="text-stone-600">No extraction results synced yet.</p>
        ) : (
          extractionEntries.map(([key, id]) => (
            <div key={key} style={{ fontFamily: 'monospace', fontSize: 10 }} className="text-green-300 break-all py-0.5">
              {id}
            </div>
          ))
        )}
      </div>
    </Section>
  );
}

function DebugOverlay({
  session, lastScan, qrScanning, cardAssets, cardSessionId,
  lastOcrResult, ocrStatus, ocrProgress, ocrProgressLabel, ocrError, ocrDiagnostics,
  log, onClose, onClearLog,
}: OverlayProps) {
  const d = session.draftData;

  const sessionDisplay = {
    captureMethod:     session.captureMethod,
    sessionStatus:     session.sessionStatus,
    hasUnsavedChanges: session.hasUnsavedChanges,
    createdAt:         session.createdAt?.toISOString() ?? null,
    updatedAt:         session.updatedAt?.toISOString() ?? null,
  };

  const uiFlags = {
    qrScanning,
    isCapturing:     session.sessionStatus !== 'IDLE',
    showManualForm:  session.captureMethod === 'MANUAL' && session.sessionStatus !== 'IDLE',
    showQrScanner:   session.captureMethod === 'QR' && qrScanning,
    showBizCard:     session.captureMethod === 'BUSINESS_CARD' && session.sessionStatus !== 'IDLE',
    ocrStatus,
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[99999] flex flex-col"
      style={{ WebkitOverflowScrolling: 'touch' }}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/65" onClick={onClose} />

      {/* Sheet */}
      <div
        className="relative mt-auto bg-stone-900 rounded-t-2xl flex flex-col"
        style={{ maxHeight: '90dvh', minHeight: 0 }}
      >
        {/* Handle bar */}
        <div className="flex-shrink-0 pt-3 pb-0 flex justify-center">
          <div className="w-10 h-1 bg-stone-600 rounded-full" />
        </div>

        {/* Header */}
        <div className="flex-shrink-0 flex items-center justify-between px-4 py-3 border-b border-stone-700">
          <span className="flex items-center gap-2">
            <Bug className="w-4 h-4 text-amber-400 flex-shrink-0" />
            <span className="text-sm font-bold text-amber-400">Debug Console</span>
            <span
              style={{ fontFamily: 'monospace', fontSize: 10 }}
              className="bg-stone-800 border border-stone-700 text-stone-400 rounded-full px-2 py-0.5"
            >
              TEMP
            </span>
            {ocrStatus !== 'idle' && (
              <OcrStatusPill status={ocrStatus} />
            )}
          </span>
          <button
            type="button"
            onClick={onClose}
            className="w-8 h-8 flex items-center justify-center rounded-full bg-stone-800 text-stone-400 active:bg-stone-700 transition-colors flex-shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Scrollable content */}
        <div
          className="flex-1 overflow-y-auto overscroll-contain"
          style={{ minHeight: 0 }}
        >
          <div className="px-4 py-3 flex flex-col gap-3 pb-10">

            {/* ── OCR DEBUG SECTIONS (shown when business card method active) ── */}
            {(session.captureMethod === 'BUSINESS_CARD' || lastOcrResult) && (
              <>
                <div
                  style={{ fontFamily: 'monospace', fontSize: 10 }}
                  className="text-amber-400 uppercase tracking-widest font-bold pt-1 pb-0.5 border-b border-stone-700"
                >
                  ─── OCR Pipeline ───
                </div>
                <OcrDebugSections
                  ocrStatus={ocrStatus}
                  ocrProgress={ocrProgress}
                  ocrProgressLabel={ocrProgressLabel}
                  lastOcrResult={lastOcrResult}
                  ocrError={ocrError}
                  ocrLog={log}
                  draftData={d}
                  ocrDiagnostics={ocrDiagnostics}
                />
                <div
                  style={{ fontFamily: 'monospace', fontSize: 10 }}
                  className="text-stone-600 uppercase tracking-widest font-bold pt-1 pb-0.5 border-b border-stone-700"
                >
                  ─── Session & Form ───
                </div>
              </>
            )}

            {/* Auth Session */}
            <div
              style={{ fontFamily: 'monospace', fontSize: 10 }}
              className="text-green-400 uppercase tracking-widest font-bold pt-1 pb-0.5 border-b border-stone-700"
            >
              ─── Auth Session ───
            </div>
            <AuthDebugSection />

            {/* Backend Sync */}
            {session.sessionStatus !== 'IDLE' && (
              <>
                <div
                  style={{ fontFamily: 'monospace', fontSize: 10 }}
                  className="text-sky-400 uppercase tracking-widest font-bold pt-1 pb-0.5 border-b border-stone-700"
                >
                  ─── Backend Sync ───
                </div>
                <BackendSyncSection sync={session.sync} />
              </>
            )}

            {/* Event log */}
            <Section
              title="Event Log"
              badge={log.length > 0 ? String(log.length) : undefined}
              defaultOpen
            >
              {log.length === 0 ? (
                <p style={{ fontSize: 12 }} className="text-stone-500 py-1">
                  No events yet.
                </p>
              ) : (
                <div className="flex flex-col gap-2">
                  {[...log].reverse().map((entry, i) => (
                    <div key={i} className="flex gap-2">
                      <span
                        style={{ fontFamily: 'monospace', fontSize: 10 }}
                        className="text-stone-500 flex-shrink-0 pt-px"
                      >
                        {timeLabel(entry.ts)}
                      </span>
                      <div className="flex-1 min-w-0">
                        <div style={{ fontSize: 12 }} className={[
                          'font-semibold break-words',
                          entry.level === 'error' ? 'text-red-300' :
                          entry.level === 'warn'  ? 'text-amber-300' :
                                                    'text-amber-300',
                        ].join(' ')}>
                          {entry.step}
                        </div>
                        {entry.detail !== undefined && (
                          <pre
                            style={{ fontFamily: 'monospace', fontSize: 10, lineHeight: 1.5 }}
                            className="mt-0.5 text-stone-400 whitespace-pre-wrap break-all"
                          >
                            {fmt(entry.detail)}
                          </pre>
                        )}
                      </div>
                    </div>
                  ))}
                  <button
                    type="button"
                    onClick={onClearLog}
                    style={{ fontSize: 11 }}
                    className="mt-1 text-red-400 hover:text-red-300 text-left self-start"
                  >
                    Clear log
                  </button>
                </div>
              )}
            </Section>

            {/* draftData */}
            <Section title="draftData (ManualEntryForm reads this)" defaultOpen>
              <JsonBlock value={d} />
            </Section>

            {/* QR Extraction result */}
            {lastScan && (
              <Section title="QR Extraction result" defaultOpen>
                <div className="flex flex-wrap gap-2 mb-3">
                  <span style={{ fontSize: 10, fontFamily: 'monospace' }} className={[
                    'rounded-full px-2 py-0.5 font-bold uppercase',
                    lastScan.extractionStrategy === 'vcard' || lastScan.extractionStrategy === 'mecard'
                      ? 'bg-teal-900 text-teal-300'
                      : lastScan.extractionStrategy === 'heuristic'
                      ? 'bg-amber-900 text-amber-300'
                      : lastScan.extractionStrategy === 'url'
                      ? 'bg-sky-900 text-sky-300'
                      : 'bg-stone-700 text-stone-400',
                  ].join(' ')}>
                    {lastScan.extractionStrategy}
                  </span>
                  <span style={{ fontSize: 10, fontFamily: 'monospace' }} className={[
                    'rounded-full px-2 py-0.5 font-bold uppercase',
                    lastScan.confidence === 'high'   ? 'bg-green-900 text-green-300' :
                    lastScan.confidence === 'medium' ? 'bg-yellow-900 text-yellow-300' :
                                                       'bg-red-900 text-red-300',
                  ].join(' ')}>
                    {lastScan.confidence} confidence
                  </span>
                  <span style={{ fontSize: 10, fontFamily: 'monospace' }} className="rounded-full px-2 py-0.5 bg-stone-700 text-stone-300">
                    {lastScan.qrType}
                  </span>
                </div>
                <MappingRow from="parsed.fields.clientName"  to="draftData.clientName"  value={lastScan.fields.clientName} />
                <MappingRow from="parsed.fields.company"     to="draftData.company"     value={lastScan.fields.company} />
                <MappingRow from="parsed.fields.phone"       to="draftData.phone"       value={lastScan.fields.phone} />
                <MappingRow from="parsed.fields.email"       to="draftData.email"       value={lastScan.fields.email} />
                <MappingRow from="parsed.fields.designation" to="draftData.designation" value={lastScan.fields.designation} />
                {lastScan.ignoredLines.length > 0 && (
                  <div className="mt-3 pt-2 border-t border-stone-800">
                    <div style={{ fontSize: 10, fontFamily: 'monospace' }} className="text-stone-500 mb-1 uppercase tracking-wider">
                      Noise lines ({lastScan.ignoredLines.length})
                    </div>
                    {lastScan.ignoredLines.map((line, i) => (
                      <div key={i} style={{ fontSize: 11, fontFamily: 'monospace' }} className="text-red-400 break-all py-0.5">
                        — {line}
                      </div>
                    ))}
                  </div>
                )}
                <div className="mt-2 pt-2 border-t border-stone-800">
                  <div style={{ fontSize: 11 }} className="text-stone-500">
                    hasData: <span className={lastScan.hasData ? 'text-green-400' : 'text-red-400'}>{String(lastScan.hasData)}</span>
                  </div>
                  <div style={{ fontFamily: 'monospace', fontSize: 10 }} className="text-stone-500 break-all mt-0.5">
                    raw: {lastScan.raw}
                  </div>
                </div>
              </Section>
            )}

            {/* Business card assets */}
            {(cardAssets.front || cardAssets.back || session.captureMethod === 'BUSINESS_CARD') && (
              <Section title="Business Card Assets" defaultOpen>
                <div style={{ fontSize: 10, fontFamily: 'monospace' }} className="text-stone-500 mb-2 uppercase tracking-wider">
                  Session ID: <span className="text-amber-300 break-all">{cardSessionId || '—'}</span>
                </div>
                {(['front', 'back'] as const).map(side => {
                  const asset = side === 'front' ? cardAssets.front : cardAssets.back;
                  return (
                    <div key={side} className="py-1.5 border-b border-stone-800 last:border-0">
                      <div className="flex items-center gap-2 mb-1">
                        <span style={{ fontSize: 10, fontFamily: 'monospace' }} className={[
                          'rounded-full px-2 py-0.5 font-bold uppercase',
                          asset ? 'bg-green-900 text-green-300' : 'bg-stone-700 text-stone-500',
                        ].join(' ')}>
                          {side}
                        </span>
                        <span style={{ fontSize: 11 }} className={asset ? 'text-green-400' : 'text-stone-500'}>
                          {asset ? 'captured' : 'empty'}
                        </span>
                      </div>
                      {asset && (
                        <div style={{ fontSize: 10, fontFamily: 'monospace', lineHeight: 1.6 }} className="text-stone-400 ml-1 break-all">
                          <div>id: <span className="text-sky-300">{asset.id}</span></div>
                          <div>size: <span className="text-amber-300">{Math.round(asset.sizeBytes / 1024)}KB</span></div>
                          <div>dims: <span className="text-amber-300">{asset.storedWidth}×{asset.storedHeight}</span> (orig {asset.originalWidth}×{asset.originalHeight})</div>
                          <div>stored: <span className="text-green-300">IndexedDB ✓</span></div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </Section>
            )}

            {/* UI flags */}
            <Section title="UI Render Flags">
              <JsonBlock value={uiFlags} />
            </Section>

            {/* Session */}
            <Section title="Capture Session">
              <JsonBlock value={sessionDisplay} />
            </Section>

            {/* Full last scan object */}
            <Section title="Last QR Scan (full object)">
              <JsonBlock value={lastScan ?? '— no scan yet —'} />
            </Section>

          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ── Public component ──────────────────────────────────────────────────────────

interface Props {
  session: CaptureSession;
  lastScan: ParsedContact | null;
  qrScanning: boolean;
  cardAssets?: { front: BusinessCardAsset | null; back: BusinessCardAsset | null };
  cardSessionId?: string;
  lastOcrResult?: OcrResult | null;
  ocrStatus?: OcrStatus;
  ocrProgress?: number;
  ocrProgressLabel?: string;
  ocrError?: string | null;
  ocrDiagnostics?: OcrPipelineDiagnostics | null;
  log: DebugLogEntry[];
  onClearLog: () => void;
}

export function CaptureDebugPanel({
  session, lastScan, qrScanning, cardAssets, cardSessionId,
  lastOcrResult, ocrStatus, ocrProgress, ocrProgressLabel, ocrError, ocrDiagnostics,
  log, onClearLog,
}: Props) {
  const [open, setOpen] = useState(false);
  const hasActivity = log.length > 0 || lastScan !== null || !!lastOcrResult;
  const hasOcrError = ocrStatus === 'error' || !!ocrError;

  return (
    <>
      {createPortal(
        <button
          type="button"
          onClick={() => setOpen(true)}
          className={[
            'fixed right-4 z-[9998]',
            'flex items-center gap-1.5 px-3 py-2 rounded-full shadow-lg',
            'transition-colors duration-150',
            'border',
            hasOcrError
              ? 'bg-red-600 text-white border-red-500 active:bg-red-500'
              : hasActivity
              ? 'bg-amber-500 text-stone-900 border-amber-400 active:bg-amber-400'
              : 'bg-stone-800 text-stone-300 border-stone-600 active:bg-stone-700',
          ].join(' ')}
          style={{ bottom: 'calc(72px + env(safe-area-inset-bottom, 0px))' }}
          title="Debug console"
        >
          <Bug className="w-3.5 h-3.5 flex-shrink-0" />
          <span style={{ fontSize: 12, fontWeight: 700 }}>Debug</span>
          {hasActivity && (
            <span className={`w-2 h-2 rounded-full flex-shrink-0 ${hasOcrError ? 'bg-white' : 'bg-red-500'}`} />
          )}
        </button>,
        document.body,
      )}

      {open && (
        <DebugOverlay
          session={session}
          lastScan={lastScan}
          qrScanning={qrScanning}
          cardAssets={cardAssets ?? { front: null, back: null }}
          cardSessionId={cardSessionId ?? ''}
          lastOcrResult={lastOcrResult ?? null}
          ocrStatus={ocrStatus ?? 'idle'}
          ocrProgress={ocrProgress ?? 0}
          ocrProgressLabel={ocrProgressLabel ?? ''}
          ocrError={ocrError ?? null}
          ocrDiagnostics={ocrDiagnostics ?? null}
          log={log}
          onClose={() => setOpen(false)}
          onClearLog={onClearLog}
        />
      )}
    </>
  );
}

// ── Hook ─────────────────────────────────────────────────────────────────────

export function useDebugLog() {
  const [log, setLog] = useState<DebugLogEntry[]>([]);

  const addEntry = useCallback((step: string, detail?: unknown, level?: DebugLogEntry['level']) => {
    setLog(prev => [...prev, { ts: Date.now(), step, detail, level }]);
  }, []);

  const clearLog = useCallback(() => setLog([]), []);

  return { log, addEntry, clearLog };
}
