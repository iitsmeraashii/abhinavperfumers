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

// Lazy-loaded so the html5-qrcode bundle is only fetched when the user
// actually initiates a QR scan.
const QrScannerView = lazy(() =>
  import('./capture/QrScannerView').then(m => ({ default: m.QrScannerView })),
);

export default function CaptureLeadPage() {
  const isOnline = useOnlineStatus();
  const [session, actions] = useCaptureSession();
  const form = useManualEntryForm(actions);
  const [recoveryToast, setRecoveryToast] = useState<string | null>(null);
  const recoveryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // QR flow: after a successful scan we switch captureMethod to MANUAL and
  // pre-fill the form, so the user reviews and edits before saving.
  const [qrScanning, setQrScanning] = useState(false);

  useAutosave(session);

  // On mount: attempt to restore a persisted draft
  useEffect(() => {
    loadDraft().then((saved) => {
      if (!saved || saved.sessionStatus === 'IDLE') return;
      actions.restoreSession(saved);

      const d = saved.draftData;
      const hydratedFields: Partial<ManualEntryFields> = {
        clientName:  typeof d.clientName  === 'string' ? d.clientName  : '',
        company:     typeof d.company     === 'string' ? d.company     : '',
        phone:       typeof d.phone       === 'string' ? d.phone       : '',
        email:       typeof d.email       === 'string' ? d.email       : '',
        designation: typeof d.designation === 'string' ? d.designation : '',
        notes:       typeof d.notes       === 'string' ? d.notes       : '',
      };
      form.hydrateFields(hydratedFields);

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
      // Start a QR session but show the scanner, not the manual form yet
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

  // Called by QrScannerView when a QR has been decoded
  function handleQrScanned(parsed: ParsedContact) {
    setQrScanning(false);

    // Switch to MANUAL method so ManualEntryForm renders
    actions.startCapture('MANUAL');

    // Hydrate form with whatever was extracted
    if (parsed.hasData) {
      form.hydrateFields(parsed.fields);
      // Also patch the session draftData so autosave picks it up
      actions.patchDraft({
        ...parsed.fields,
        rawQr: parsed.raw,
      });
    } else {
      // QR decoded but no contact fields — patch raw only
      actions.patchDraft({ rawQr: parsed.raw });
    }
  }

  const isCapturing = session.sessionStatus !== 'IDLE';
  const showQrScanner = isCapturing && session.captureMethod === 'QR' && qrScanning;
  const showManualForm = isCapturing && session.captureMethod === 'MANUAL';
  const showPlaceholder = isCapturing && !showQrScanner && !showManualForm;

  return (
    <div className="min-h-[calc(100vh-57px)] bg-stone-50 flex flex-col">
      <OfflineBanner visible={!isOnline} />

      <div className="flex-1 w-full max-w-lg mx-auto px-5 pt-10 pb-10 flex flex-col">

        {/* Header */}
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

      {/* Recovery toast — portal-rendered at top of viewport, safe-area aware */}
      <Toast message={recoveryToast} position="top" />
    </div>
  );
}
