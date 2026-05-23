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
import type { CaptureMethod, ManualEntryFields } from './capture/types';
import type { ParsedContact } from './capture/parseQrPayload';

// Lazy-loaded — the html5-qrcode chunk is only fetched when user taps "Scan QR Code"
const QrScannerView = lazy(() =>
  import('./capture/QrScannerView').then(m => ({ default: m.QrScannerView })),
);

export default function CaptureLeadPage() {
  const isOnline = useOnlineStatus();
  const [session, actions] = useCaptureSession();
  const form = useManualEntryForm(actions);
  const [recoveryToast, setRecoveryToast] = useState<string | null>(null);
  const recoveryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Tracks whether the QR scanner UI is active. When false with captureMethod===QR
  // it means the scan completed and we fall through to the manual form.
  const [qrScanning, setQrScanning] = useState(false);

  useAutosave(session);

  // Restore a persisted draft on mount. A previously-QR-scanned draft has
  // captureMethod===MANUAL (we switch it after scan). If somehow a QR draft
  // persisted with captureMethod===QR, treat it as a manual draft so the
  // user always lands on the editable form rather than a re-opened scanner.
  useEffect(() => {
    loadDraft().then((saved) => {
      if (!saved || saved.sessionStatus === 'IDLE') return;

      // Normalise: a persisted QR-method session means we already have the
      // extracted data; show the form, not the scanner.
      const normalised = saved.captureMethod === 'QR'
        ? { ...saved, captureMethod: 'MANUAL' as CaptureMethod }
        : saved;

      actions.restoreSession(normalised);

      const d = normalised.draftData;
      const hydrated: Partial<ManualEntryFields> = {
        clientName:  typeof d.clientName  === 'string' ? d.clientName  : '',
        company:     typeof d.company     === 'string' ? d.company     : '',
        phone:       typeof d.phone       === 'string' ? d.phone       : '',
        email:       typeof d.email       === 'string' ? d.email       : '',
        designation: typeof d.designation === 'string' ? d.designation : '',
        notes:       typeof d.notes       === 'string' ? d.notes       : '',
      };
      form.hydrateFields(hydrated);

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

  // Called by QrScannerView when a QR has been decoded.
  // We use startCaptureWithDraft to atomically set captureMethod=MANUAL and
  // seed draftData in a single setState — no race between startCapture + patchDraft.
  function handleQrScanned(parsed: ParsedContact) {
    const draft = parsed.hasData
      ? { ...parsed.fields, rawQr: parsed.raw }
      : { rawQr: parsed.raw };

    // Seed the session with extracted data in one atomic update
    actions.startCaptureWithDraft('MANUAL', draft);

    // Mirror into the form's local field state
    if (parsed.hasData) {
      form.hydrateFields(parsed.fields as Partial<ManualEntryFields>);
    }

    // Switch view: hide scanner, show manual form
    setQrScanning(false);
  }

  const isCapturing = session.sessionStatus !== 'IDLE';
  const showQrScanner  = isCapturing && session.captureMethod === 'QR' && qrScanning;
  const showManualForm = isCapturing && session.captureMethod === 'MANUAL';
  // Placeholder only for genuinely unimplemented methods (BUSINESS_CARD)
  const showPlaceholder = isCapturing && session.captureMethod === 'BUSINESS_CARD';

  return (
    <div className="min-h-[calc(100vh-57px)] bg-stone-50 flex flex-col">
      <OfflineBanner visible={!isOnline} />

      <div className="flex-1 w-full max-w-lg mx-auto px-5 pt-10 pb-10 flex flex-col">

        {/* Header — dimmed once a session is active */}
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
    </div>
  );
}
