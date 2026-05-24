// Mobile debug overlay for QR capture troubleshooting.
// Floating button + bottom-sheet. Visible in all environments.

import { useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Bug, X, ChevronDown, ChevronRight, Clipboard, Check } from 'lucide-react';
import type { BusinessCardAsset, CaptureSession, OcrResult } from './types';
import type { ParsedContact } from './parseQrPayload';

// ── Types ────────────────────────────────────────────────────────────────────

export interface DebugLogEntry {
  ts: number;
  step: string;
  detail?: unknown;
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
  title, badge, children, defaultOpen = false,
}: {
  title: string;
  badge?: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);

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
          <span className="ml-2 flex-shrink-0 text-[10px] font-bold bg-amber-500 text-stone-900 rounded-full px-2 py-0.5">
            {badge}
          </span>
        )}
      </button>

      {/* Using display:block/none to avoid height-clipping accordion issues */}
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

// ── Main overlay ──────────────────────────────────────────────────────────────

interface OverlayProps {
  session: CaptureSession;
  lastScan: ParsedContact | null;
  qrScanning: boolean;
  cardAssets: { front: BusinessCardAsset | null; back: BusinessCardAsset | null };
  cardSessionId: string;
  lastOcrResult: OcrResult | null;
  log: DebugLogEntry[];
  onClose: () => void;
  onClearLog: () => void;
}

function DebugOverlay({ session, lastScan, qrScanning, cardAssets, cardSessionId, lastOcrResult, log, onClose, onClearLog }: OverlayProps) {
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
    showPlaceholder: session.captureMethod === 'BUSINESS_CARD' && session.sessionStatus !== 'IDLE',
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[99999] flex flex-col"
      style={{ WebkitOverflowScrolling: 'touch' }}
    >
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/65"
        onClick={onClose}
      />

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
            <span className="text-sm font-bold text-amber-400">QR Debug Console</span>
            <span
              style={{ fontFamily: 'monospace', fontSize: 10 }}
              className="bg-stone-800 border border-stone-700 text-stone-400 rounded-full px-2 py-0.5"
            >
              TEMP
            </span>
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

            {/* Event log */}
            <Section
              title="Event Log"
              badge={log.length > 0 ? String(log.length) : undefined}
              defaultOpen
            >
              {log.length === 0 ? (
                <p style={{ fontSize: 12 }} className="text-stone-500 py-1">
                  No events yet. Scan a QR code to populate.
                </p>
              ) : (
                <div className="flex flex-col gap-2">
                  {log.map((entry, i) => (
                    <div key={i} className="flex gap-2">
                      <span
                        style={{ fontFamily: 'monospace', fontSize: 10 }}
                        className="text-stone-500 flex-shrink-0 pt-px"
                      >
                        {timeLabel(entry.ts)}
                      </span>
                      <div className="flex-1 min-w-0">
                        <div style={{ fontSize: 12 }} className="font-semibold text-amber-300 break-words">
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

            {/* Extraction strategy + parsed field mapping */}
            {lastScan && (
              <Section title="Extraction result" defaultOpen>

                {/* Strategy / confidence banner */}
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

                {/* Field mapping rows */}
                <MappingRow from="parsed.fields.clientName"  to="draftData.clientName"  value={lastScan.fields.clientName} />
                <MappingRow from="parsed.fields.company"     to="draftData.company"     value={lastScan.fields.company} />
                <MappingRow from="parsed.fields.phone"       to="draftData.phone"       value={lastScan.fields.phone} />
                <MappingRow from="parsed.fields.email"       to="draftData.email"       value={lastScan.fields.email} />
                <MappingRow from="parsed.fields.designation" to="draftData.designation" value={lastScan.fields.designation} />

                {/* Ignored / noise lines */}
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

            {/* OCR Result */}
            {lastOcrResult && (
              <Section title="OCR Extraction" defaultOpen>
                {/* Confidence badge */}
                <div className="flex flex-wrap gap-2 mb-3">
                  <span style={{ fontSize: 10, fontFamily: 'monospace' }} className={[
                    'rounded-full px-2 py-0.5 font-bold uppercase',
                    lastOcrResult.confidence === 'high'   ? 'bg-green-900 text-green-300' :
                    lastOcrResult.confidence === 'medium' ? 'bg-yellow-900 text-yellow-300' :
                                                            'bg-red-900 text-red-300',
                  ].join(' ')}>
                    {lastOcrResult.confidence} confidence
                  </span>
                  <span style={{ fontSize: 10, fontFamily: 'monospace' }} className="rounded-full px-2 py-0.5 bg-stone-700 text-stone-300">
                    {lastOcrResult.inferredFields.length} fields
                  </span>
                  <span style={{ fontSize: 10, fontFamily: 'monospace' }} className="rounded-full px-2 py-0.5 bg-stone-700 text-stone-300">
                    asset: {lastOcrResult.assetId.slice(-8)}
                  </span>
                </div>

                {/* Extracted fields */}
                {(Object.keys(lastOcrResult.fields) as Array<keyof typeof lastOcrResult.fields>).map(key => (
                  <MappingRow
                    key={key}
                    from={`ocr.fields.${key}`}
                    to={`draftData.${key}`}
                    value={lastOcrResult.fields[key]}
                  />
                ))}

                {/* Ignored lines */}
                {lastOcrResult.ignoredLines.length > 0 && (
                  <div className="mt-3 pt-2 border-t border-stone-800">
                    <div style={{ fontSize: 10, fontFamily: 'monospace' }} className="text-stone-500 mb-1 uppercase tracking-wider">
                      Ignored lines ({lastOcrResult.ignoredLines.length})
                    </div>
                    {lastOcrResult.ignoredLines.map((line, i) => (
                      <div key={i} style={{ fontSize: 11, fontFamily: 'monospace' }} className="text-red-400 break-all py-0.5">
                        — {line}
                      </div>
                    ))}
                  </div>
                )}

                {/* Raw OCR text */}
                <div className="mt-3 pt-2 border-t border-stone-800">
                  <div style={{ fontSize: 10, fontFamily: 'monospace' }} className="text-stone-500 mb-1 uppercase tracking-wider">
                    Raw OCR text ({lastOcrResult.rawText.length} chars)
                  </div>
                  <pre
                    style={{ fontFamily: 'monospace', fontSize: 10, lineHeight: 1.6, maxHeight: 160 }}
                    className="text-stone-300 whitespace-pre-wrap break-all overflow-y-auto"
                  >
                    {lastOcrResult.rawText || '(empty)'}
                  </pre>
                </div>
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
  log: DebugLogEntry[];
  onClearLog: () => void;
}

export function CaptureDebugPanel({ session, lastScan, qrScanning, cardAssets, cardSessionId, lastOcrResult, log, onClearLog }: Props) {
  const [open, setOpen] = useState(false);
  const hasActivity = log.length > 0 || lastScan !== null;

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
            hasActivity
              ? 'bg-amber-500 text-stone-900 border-amber-400 active:bg-amber-400'
              : 'bg-stone-800 text-stone-300 border-stone-600 active:bg-stone-700',
          ].join(' ')}
          style={{ bottom: 'calc(72px + env(safe-area-inset-bottom, 0px))' }}
          title="QR debug console"
        >
          <Bug className="w-3.5 h-3.5 flex-shrink-0" />
          <span style={{ fontSize: 12, fontWeight: 700 }}>Debug</span>
          {hasActivity && (
            <span className="w-2 h-2 rounded-full bg-red-500 flex-shrink-0" />
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

  const addEntry = useCallback((step: string, detail?: unknown) => {
    setLog(prev => [...prev, { ts: Date.now(), step, detail }]);
  }, []);

  const clearLog = useCallback(() => setLog([]), []);

  return { log, addEntry, clearLog };
}
