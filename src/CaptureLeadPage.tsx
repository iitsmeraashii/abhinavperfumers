import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { useOnlineStatus } from './capture/useOnlineStatus';
import { useCaptureSession } from './capture/useCaptureSession';
import { useManualEntryForm } from './capture/useManualEntryForm';
import { useAutosave } from './capture/useAutosave';
import { loadDraft, clearDraft } from './capture/captureDraftStorage';
import { OfflineBanner } from './capture/OfflineBanner';
import { CaptureMethodPicker } from './capture/CaptureMethodPicker';
import { CapturePlaceholder } from './capture/CapturePlaceholder';
import { ManualEntryForm } from './capture/ManualEntryForm';
import { Toast } from './capture/CaptureUI';
import { CaptureDebugPanel, useDebugLog } from './capture/CaptureDebugPanel';
import type { CaptureMethod } from './capture/types';
import type { ParsedContact } from './capture/parseQrPayload';

const QrScannerView = lazy(() =>
  import('./capture/QrScannerView').then(m => ({ default: m.QrScannerView })),
);

export default function CaptureLeadPage() {
  const isOnline = useOnlineStatus();
  const [session, actions] = useCaptureSession();
  const form = useManualEntryForm(actions);
  const [recoveryToast, setRecoveryToast] = useState<string | null>(null);
  const recoveryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [qrScanning, setQrScanning] = useState(false);
  const [lastScan, setLastScan] = useState<ParsedContact | null>(null);

  const { log, addEntry, clearLog } = useDebugLog();

  useAutosave(session);

  // Restore a persisted draft on mount.
  // A QR-method session means the scan already completed — treat as MANUAL
  // so the user lands on the editable form, not the scanner.
  useEffect(() => {
    loadDraft().then((saved) => {
      if (!saved || saved.sessionStatus === 'IDLE') return;

      const normalised = saved.captureMethod === 'QR'
        ? { ...saved, captureMethod: 'MANUAL' as CaptureMethod }
        : saved;

      actions.restoreSession(normalised);

      setRecoveryToast('Recovered unfinished draft');
      recoveryTimer.current = setTimeout(() => setRecoveryToast(null), 3200);
    });

    return () => {
      if (recoveryTimer.current) clearTimeout(recoveryTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleMethodSelect(method: CaptureMethod) {
    form.handleReset();
    if (method === 'QR') {
      addEntry('QR scanner opened');
      actions.startCapture('QR');
      setQrScanning(true);
    } else {
      actions.startCapture(method);
      setQrScanning(false);
    }
  }

  function handleBackToOptions() {
    form.handleReset();
    actions.resetSession();
    setQrScanning(false);
  }

  async function handleDiscardDraft() {
    await clearDraft();
    form.handleReset();
    actions.resetSession();
    setQrScanning(false);
  }

  // After a successful QR scan: normalize parsed fields into the exact DraftData
  // key shape, then seed the session atomically. ManualEntryForm reads from
  // session.draftData directly so fields appear immediately without a hydration step.
  function handleQrScanned(parsed: ParsedContact) {
    addEntry('QR scanned — raw text received', parsed.raw);
    addEntry('Parsing completed', { hasData: parsed.hasData, fields: parsed.fields });

    // Explicit normalization: never assume parser key names match DraftData keys.
    const f = parsed.fields;
    const mappedDraft = {
      clientName:  String(f.clientName  ?? '').trim() || undefined,
      company:     String(f.company     ?? '').trim() || undefined,
      phone:       String(f.phone       ?? '').trim() || undefined,
      email:       String(f.email       ?? '').trim() || undefined,
      designation: String(f.designation ?? '').trim() || undefined,
      notes:       String(f.notes       ?? '').trim() || undefined,
      rawQr:       parsed.raw,
    };

    // Strip undefined keys so draftData stays clean
    const draft = Object.fromEntries(
      Object.entries(mappedDraft).filter(([, v]) => v !== undefined),
    );

    addEntry('draft object built (explicit mapping)', draft);

    console.group('[QR Scan] handleQrScanned');
    console.log('raw QR text:', parsed.raw);
    console.log('parsed object:', parsed);
    console.log('parsed.fields:', parsed.fields);
    console.log('mapped draft:', draft);
    console.groupEnd();

    setLastScan(parsed);
    addEntry('startCaptureWithDraft called', { method: 'MANUAL', draftKeys: Object.keys(draft) });
    actions.startCaptureWithDraft('MANUAL', draft);

    console.log('[QR Scan] session.draftData should now be:', draft);
    addEntry('Form view triggered — captureMethod MANUAL, qrScanning false');

    form.handleReset();
    setQrScanning(false);
  }

  const isCapturing    = session.sessionStatus !== 'IDLE';
  const showQrScanner  = isCapturing && session.captureMethod === 'QR' && qrScanning;
  const showManualForm = isCapturing && session.captureMethod === 'MANUAL';
  const showPlaceholder = isCapturing && session.captureMethod === 'BUSINESS_CARD';

  return (
    <div className="min-h-[calc(100vh-57px)] bg-stone-50 flex flex-col">
      <OfflineBanner visible={!isOnline} />

      <div className="flex-1 w-full max-w-lg mx-auto px-5 pt-10 pb-10 flex flex-col">

        <div className={`mb-10 transition-opacity duration-200 ${isCapturing ? 'opacity-50' : ''}`}>
          <h1 className="text-2xl font-bold text-stone-900 tracking-tight">Capture New Lead</h1>
          <p className="mt-1.5 text-base text-stone-500 leading-relaxed">
            {isCapturing
              ? 'Session active — fill in details below'
              : 'Choose how you want to capture lead details'}
          </p>
        </div>

        <CaptureMethodPicker
          onSelect={handleMethodSelect}
          activeMethod={session.captureMethod}
        />

        {showQrScanner && (
          <Suspense fallback={
            <div className="mt-6 flex items-center justify-center py-16 text-stone-400 text-sm">
              Loading scanner…
            </div>
          }>
            <QrScannerView
              onScanned={handleQrScanned}
              onCancel={handleBackToOptions}
            />
          </Suspense>
        )}

        {showManualForm && (
          <ManualEntryForm
            session={session}
            isOnline={isOnline}
            form={form}
            onBack={handleBackToOptions}
            onDiscard={handleDiscardDraft}
          />
        )}

        {showPlaceholder && (
          <CapturePlaceholder
            session={session}
            isOnline={isOnline}
            onBack={handleBackToOptions}
          />
        )}

        {!isCapturing && (
          <p className="mt-8 text-center text-xs text-stone-400 md:hidden">
            Features coming soon — tap to preview
          </p>
        )}
      </div>

      <Toast message={recoveryToast} position="top" />

      <CaptureDebugPanel
        session={session}
        lastScan={lastScan}
        qrScanning={qrScanning}
        log={log}
        onClearLog={clearLog}
      />
    </div>
  );
}
