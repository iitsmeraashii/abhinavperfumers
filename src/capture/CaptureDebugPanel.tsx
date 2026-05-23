// DEV-ONLY debug panel — never rendered in production builds.
// Shows the full capture session state, draftData, last QR scan result,
// and confirms that ManualEntryForm is reading from session.draftData.

import { useState } from 'react';
import { ChevronDown, ChevronUp, Bug } from 'lucide-react';
import type { CaptureSession } from './types';
import type { ParsedContact } from './parseQrPayload';

interface Props {
  session: CaptureSession;
  lastScan: ParsedContact | null;
  qrScanning: boolean;
}

function JsonBlock({ label, value }: { label: string; value: unknown }) {
  const json = JSON.stringify(value, null, 2);
  return (
    <div>
      <p className="text-[10px] font-semibold text-amber-700 uppercase tracking-wider mb-1">{label}</p>
      <pre className="text-[11px] leading-relaxed text-stone-700 bg-stone-50 rounded-lg border border-stone-200 p-2.5 overflow-x-auto whitespace-pre-wrap break-words font-mono">
        {json}
      </pre>
    </div>
  );
}

export function CaptureDebugPanel({ session, lastScan, qrScanning }: Props) {
  const [open, setOpen] = useState(false);

  // Strip Date objects to ISO strings for readable display
  const sessionDisplay = {
    captureMethod:    session.captureMethod,
    sessionStatus:    session.sessionStatus,
    hasUnsavedChanges: session.hasUnsavedChanges,
    createdAt:        session.createdAt?.toISOString() ?? null,
    updatedAt:        session.updatedAt?.toISOString() ?? null,
  };

  const draftDisplay = session.draftData;

  // Derive which fields ManualEntryForm would render (mirrors ManualEntryForm logic)
  const d = session.draftData;
  const formValuesFromDraft = {
    clientName:  String(d.clientName  ?? ''),
    company:     String(d.company     ?? ''),
    phone:       String(d.phone       ?? ''),
    email:       String(d.email       ?? ''),
    designation: String(d.designation ?? ''),
    notes:       String(d.notes       ?? ''),
    source: 'session.draftData (single source of truth)',
  };

  const scanDisplay = lastScan
    ? {
        hasData:    lastScan.hasData,
        raw:        lastScan.raw,
        fields:     lastScan.fields,
      }
    : null;

  const uiState = {
    qrScanning,
    showManualForm: session.captureMethod === 'MANUAL' && session.sessionStatus !== 'IDLE',
    showQrScanner:  session.captureMethod === 'QR' && qrScanning,
    showPlaceholder: session.captureMethod === 'BUSINESS_CARD' && session.sessionStatus !== 'IDLE',
  };

  return (
    <div className="mt-8 rounded-2xl border-2 border-dashed border-amber-300 bg-amber-50 overflow-hidden">
      {/* Header toggle */}
      <button
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center justify-between px-4 py-3 text-left"
      >
        <span className="flex items-center gap-2 text-sm font-semibold text-amber-800">
          <Bug className="w-4 h-4" />
          Debug Panel
          <span className="text-[10px] font-normal text-amber-600 bg-amber-100 border border-amber-200 rounded-full px-2 py-0.5">
            DEV ONLY
          </span>
        </span>
        {open
          ? <ChevronUp className="w-4 h-4 text-amber-600" />
          : <ChevronDown className="w-4 h-4 text-amber-600" />
        }
      </button>

      {open && (
        <div className="px-4 pb-4 flex flex-col gap-4 border-t border-amber-200">
          <div className="pt-3">
            <JsonBlock label="1 · UI Render State" value={uiState} />
          </div>
          <JsonBlock label="2 · Capture Session" value={sessionDisplay} />
          <JsonBlock label="3 · draftData (what ManualEntryForm reads)" value={draftDisplay} />
          <JsonBlock label="4 · Form values derived from draftData" value={formValuesFromDraft} />
          <JsonBlock
            label="5 · Last QR Scan Result"
            value={scanDisplay ?? '— no scan yet this session —'}
          />
        </div>
      )}
    </div>
  );
}
