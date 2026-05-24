// DEV-ONLY mobile debug overlay for QR capture troubleshooting.
// Rendered as a floating button + bottom-sheet. Zero production footprint —
// the parent gates rendering behind import.meta.env.DEV.

import { useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Bug, X, ChevronDown, ChevronRight, Clipboard, Check } from 'lucide-react';
import type { CaptureSession } from './types';
import type { ParsedContact } from './parseQrPayload';

// ── Types ────────────────────────────────────────────────────────────────────

export interface DebugLogEntry {
  ts: number;          // Date.now()
  step: string;        // e.g. "QR scanned"
  detail?: unknown;    // any payload to display
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function fmt(v: unknown): string {
  try { return JSON.stringify(v, null, 2); }
  catch { return String(v); }
}

function timeLabel(ts: number): string {
  const d = new Date(ts);
  return `${d.getHours().toString().padStart(2,'0')}:${d.getMinutes().toString().padStart(2,'0')}:${d.getSeconds().toString().padStart(2,'0')}.${d.getMilliseconds().toString().padStart(3,'0')}`;
}

// ── Collapsible section ───────────────────────────────────────────────────────

function Section({ title, badge, children, defaultOpen = false }: {
  title: string;
  badge?: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border border-stone-700 rounded-lg overflow-hidden">
      <button
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center justify-between px-3 py-2.5 bg-stone-800 text-left"
      >
        <span className="flex items-center gap-2 text-xs font-semibold text-stone-200 uppercase tracking-wider">
          {open ? <ChevronDown className="w-3.5 h-3.5 text-stone-400" /> : <ChevronRight className="w-3.5 h-3.5 text-stone-400" />}
          {title}
        </span>
        {badge && (
          <span className="text-[10px] font-medium bg-amber-500 text-stone-900 rounded-full px-2 py-0.5">
            {badge}
          </span>
        )}
      </button>
      {open && (
        <div className="bg-stone-950 px-3 py-2.5">
          {children}
        </div>
      )}
    </div>
  );
}

// ── JSON block with copy ─────────────────────────────────────────────────────

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
    <div className="relative group">
      <pre className="text-[11px] leading-relaxed text-green-300 font-mono whitespace-pre-wrap break-all overflow-x-auto">
        {text}
      </pre>
      <button
        onClick={handleCopy}
        className="absolute top-0 right-0 p-1 text-stone-500 hover:text-stone-300 transition-colors"
        title="Copy"
      >
        {copied ? <Check className="w-3.5 h-3.5 text-green-400" /> : <Clipboard className="w-3.5 h-3.5" />}
      </button>
    </div>
  );
}

// ── Field mapping row ────────────────────────────────────────────────────────

function MappingRow({ from, to, value }: { from: string; to: string; value: unknown }) {
  const present = value !== undefined && value !== null && value !== '';
  return (
    <div className="flex items-start gap-1.5 text-[11px] font-mono py-0.5">
      <span className="text-sky-400 min-w-[110px] flex-shrink-0">{from}</span>
      <span className="text-stone-500">→</span>
      <span className="text-amber-300 min-w-[140px] flex-shrink-0">{to}</span>
      <span className="text-stone-500">=</span>
      <span className={present ? 'text-green-300' : 'text-red-400'}>
        {present ? JSON.stringify(value) : '(empty)'}
      </span>
    </div>
  );
}

// ── Overlay sheet ────────────────────────────────────────────────────────────

interface OverlayProps {
  session: CaptureSession;
  lastScan: ParsedContact | null;
  qrScanning: boolean;
  log: DebugLogEntry[];
  onClose: () => void;
  onClearLog: () => void;
}

function DebugOverlay({ session, lastScan, qrScanning, log, onClose, onClearLog }: OverlayProps) {
  const d = session.draftData;

  const formValues = {
    clientName:  String(d.clientName  ?? ''),
    company:     String(d.company     ?? ''),
    phone:       String(d.phone       ?? ''),
    email:       String(d.email       ?? ''),
    designation: String(d.designation ?? ''),
    notes:       String(d.notes       ?? ''),
  };

  const sessionDisplay = {
    captureMethod:     session.captureMethod,
    sessionStatus:     session.sessionStatus,
    hasUnsavedChanges: session.hasUnsavedChanges,
    createdAt:         session.createdAt?.toISOString() ?? null,
    updatedAt:         session.updatedAt?.toISOString() ?? null,
  };

  const uiFlags = {
    qrScanning,
    showManualForm:   session.captureMethod === 'MANUAL' && session.sessionStatus !== 'IDLE',
    showQrScanner:    session.captureMethod === 'QR' && qrScanning,
    showPlaceholder:  session.captureMethod === 'BUSINESS_CARD' && session.sessionStatus !== 'IDLE',
    isCapturing:      session.sessionStatus !== 'IDLE',
  };

  return createPortal(
    <div className="fixed inset-0 z-[99999] flex flex-col pointer-events-none">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/60 pointer-events-auto"
        onClick={onClose}
      />

      {/* Sheet — slides up from bottom */}
      <div className="
        relative mt-auto pointer-events-auto
        bg-stone-900 rounded-t-2xl
        flex flex-col
        max-h-[88vh]
        shadow-2xl
      ">
        {/* Handle + header */}
        <div className="flex-shrink-0 px-4 pt-3 pb-3 border-b border-stone-700">
          <div className="w-10 h-1 bg-stone-600 rounded-full mx-auto mb-3" />
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-2 text-sm font-bold text-amber-400">
              <Bug className="w-4 h-4" />
              QR Debug Console
              <span className="text-[10px] font-medium text-stone-400 bg-stone-800 border border-stone-700 rounded-full px-2 py-0.5">
                DEV ONLY
              </span>
            </span>
            <button
              onClick={onClose}
              className="w-8 h-8 flex items-center justify-center rounded-full bg-stone-800 text-stone-400 hover:text-stone-200 transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto overscroll-contain px-4 py-3 flex flex-col gap-3 pb-safe">

          {/* Step-by-step event log */}
          <Section title="Event Log" badge={log.length > 0 ? String(log.length) : undefined} defaultOpen>
            {log.length === 0 ? (
              <p className="text-xs text-stone-500 py-1">No events yet — scan a QR code to populate.</p>
            ) : (
              <div className="flex flex-col gap-1.5">
                {log.map((entry, i) => (
                  <div key={i} className="flex items-start gap-2">
                    <span className="text-[10px] text-stone-500 font-mono flex-shrink-0 pt-px">{timeLabel(entry.ts)}</span>
                    <div className="flex-1 min-w-0">
                      <span className="text-[11px] font-semibold text-amber-300">{entry.step}</span>
                      {entry.detail !== undefined && (
                        <pre className="mt-0.5 text-[10px] text-stone-400 font-mono whitespace-pre-wrap break-all">
                          {fmt(entry.detail)}
                        </pre>
                      )}
                    </div>
                  </div>
                ))}
                <button
                  onClick={onClearLog}
                  className="mt-1 text-[10px] text-red-400 hover:text-red-300 text-left"
                >
                  Clear log
                </button>
              </div>
            )}
          </Section>

          {/* UI flags */}
          <Section title="UI Render Flags">
            <JsonBlock value={uiFlags} />
          </Section>

          {/* Session */}
          <Section title="Capture Session">
            <JsonBlock value={sessionDisplay} />
          </Section>

          {/* draftData */}
          <Section title="draftData (what ManualEntryForm reads)" defaultOpen>
            <JsonBlock value={d} />
          </Section>

          {/* Form values */}
          <Section title="Form values derived from draftData">
            <div className="mb-1.5 text-[10px] text-stone-500 font-mono">
              source: session.draftData (single source of truth)
            </div>
            <JsonBlock value={formValues} />
          </Section>

          {/* Parsed field mapping */}
          {lastScan && (
            <Section title="Parsed field mapping" defaultOpen>
              <div className="flex flex-col">
                <MappingRow from="parsed.fields.clientName"  to="draftData.clientName"  value={lastScan.fields.clientName} />
                <MappingRow from="parsed.fields.company"     to="draftData.company"     value={lastScan.fields.company} />
                <MappingRow from="parsed.fields.phone"       to="draftData.phone"       value={lastScan.fields.phone} />
                <MappingRow from="parsed.fields.email"       to="draftData.email"       value={lastScan.fields.email} />
                <MappingRow from="parsed.fields.designation" to="draftData.designation" value={lastScan.fields.designation} />
                <MappingRow from="parsed.raw (→ rawQr)"      to="draftData.rawQr"       value={lastScan.raw} />
              </div>
              <div className="mt-2 pt-2 border-t border-stone-800">
                <p className="text-[10px] text-stone-500 mb-1">
                  hasData: <span className={lastScan.hasData ? 'text-green-400' : 'text-red-400'}>{String(lastScan.hasData)}</span>
                </p>
                <p className="text-[10px] text-stone-500 font-mono break-all">raw: {lastScan.raw}</p>
              </div>
            </Section>
          )}

          {/* Last scan raw */}
          <Section title="Last QR Scan (full object)">
            <JsonBlock value={lastScan ?? '— no scan yet this session —'} />
          </Section>

          <div className="h-4" /> {/* bottom breathing room */}
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ── Public component ─────────────────────────────────────────────────────────

interface Props {
  session: CaptureSession;
  lastScan: ParsedContact | null;
  qrScanning: boolean;
  log: DebugLogEntry[];
  onClearLog: () => void;
}

export function CaptureDebugPanel({ session, lastScan, qrScanning, log, onClearLog }: Props) {
  const [open, setOpen] = useState(false);

  const hasActivity = log.length > 0 || lastScan !== null;

  return (
    <>
      {/* Floating trigger button */}
      {createPortal(
        <button
          onClick={() => setOpen(true)}
          className={`
            fixed bottom-[max(80px,calc(64px+env(safe-area-inset-bottom)))] right-4
            z-[9998]
            flex items-center gap-1.5
            px-3 py-2 rounded-full shadow-lg
            text-xs font-bold
            transition-all duration-150
            ${hasActivity
              ? 'bg-amber-500 text-stone-900 hover:bg-amber-400'
              : 'bg-stone-800 text-stone-300 hover:bg-stone-700'}
            border ${hasActivity ? 'border-amber-400' : 'border-stone-600'}
          `}
          title="Open QR debug console"
        >
          <Bug className="w-3.5 h-3.5" />
          Debug
          {hasActivity && (
            <span className="w-2 h-2 rounded-full bg-red-500 flex-shrink-0" />
          )}
        </button>,
        document.body,
      )}

      {/* Overlay */}
      {open && (
        <DebugOverlay
          session={session}
          lastScan={lastScan}
          qrScanning={qrScanning}
          log={log}
          onClose={() => setOpen(false)}
          onClearLog={onClearLog}
        />
      )}
    </>
  );
}

// ── Hook: accumulate log entries ─────────────────────────────────────────────

export function useDebugLog() {
  const [log, setLog] = useState<DebugLogEntry[]>([]);

  const addEntry = useCallback((step: string, detail?: unknown) => {
    setLog(prev => [...prev, { ts: Date.now(), step, detail }]);
  }, []);

  const clearLog = useCallback(() => setLog([]), []);

  return { log, addEntry, clearLog };
}
