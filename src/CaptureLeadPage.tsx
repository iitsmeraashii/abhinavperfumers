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
import { CaptureDebugPanel } from './capture/CaptureDebugPanel';
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
      // No form hydration needed — ManualEntryForm reads directly from session.draftData

      setRecoveryToast('Recovered unfinished draft');
      recoveryTimer.current = setTimeout(() => setRecoveryToast(null), 3200);
    });

    return () => {
      if (recoveryTimer.current) clearTimeout(recoveryTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleMethodSelect(method: CaptureMethod) {
    form.handleReset(); // reset touched + toast only
    if (method === 'QR') {
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

  // After a successful QR scan: seed the session with extracted data atomically,
  // then switch to the manual form view. ManualEntryForm reads from session.draftData,
  // so the fields are immediately populated — no separate hydration step needed.
  function handleQrScanned(parsed: ParsedContact) {
    const draft = parsed.hasData
      ? { ...parsed.fields, rawQr: parsed.raw }
      : { rawQr: parsed.raw };

    if (import.meta.env.DEV) {
      console.group('[QR Scan Result]');
      console.log('raw:', parsed.raw);
      console.log('hasData:', parsed.hasData);
      console.log('parsed.fields:', parsed.fields);
      console.log('draft to seed:', draft);
      console.groupEnd();
    }

    setLastScan(parsed);
    actions.startCaptureWithDraft('MANUAL', draft);
    form.handleReset(); // clear touched/toast state for the new form view
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

      {import.meta.env.DEV && (
        <div className="w-full max-w-lg mx-auto px-5 pb-10">
          <CaptureDebugPanel
            session={session}
            lastScan={lastScan}
            qrScanning={qrScanning}
          />
        </div>
      )}
    </div>
  );
}


export default CaptureLeadPage