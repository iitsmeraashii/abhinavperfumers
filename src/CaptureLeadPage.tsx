import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useOnlineStatus } from './capture/useOnlineStatus';
import { useCaptureSession } from './capture/useCaptureSession';
import { useManualEntryForm } from './capture/useManualEntryForm';
import { useAutosave } from './capture/useAutosave';
import { loadDraft, clearDraft } from './capture/captureDraftStorage';
import { deleteSessionAssets } from './capture/captureAssetStorage';
import { OfflineBanner } from './capture/OfflineBanner';
import { CaptureMethodPicker } from './capture/CaptureMethodPicker';
import { ManualEntryForm } from './capture/ManualEntryForm';
import { BusinessCardCapture } from './capture/BusinessCardCapture';
import { Toast } from './capture/CaptureUI';
import { CaptureDebugPanel, useDebugLog } from './capture/CaptureDebugPanel';
import type { CaptureMethod, BusinessCardAsset, OcrResult } from './capture/types';
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
  const [cardSessionId, setCardSessionId] = useState<string>('');
  const [cardAssets, setCardAssets] = useState<{ front: BusinessCardAsset | null; back: BusinessCardAsset | null }>({ front: null, back: null });
  const [lastOcrResult, setLastOcrResult] = useState<OcrResult | null>(null);

  // Keep a stable ref to addEntry so useCallback deps stay minimal
  const addEntryRef = useRef(addEntry);
  addEntryRef.current = addEntry;

  useAutosave(session);

  // Restore a persisted draft on mount.
  // A QR-method session means the scan already completed — treat as MANUAL
  // so the user lands on the editable form, not the scanner.
  useEffect(() => {
    loadDraft().then((saved) => {
      if (!saved || saved.sessionStatus === 'IDLE') return;

      // Restore business card session ID so BusinessCardCapture can reload assets
      if (saved.captureMethod === 'BUSINESS_CARD' && saved.draftData.cardSessionId) {
        setCardSessionId(saved.draftData.cardSessionId as string);
      }

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

  const handleMethodSelect = useCallback((method: CaptureMethod) => {
    form.handleReset();
    if (method === 'QR') {
      addEntryRef.current('QR scanner opened');
      actions.startCapture('QR');
      setQrScanning(true);
    } else if (method === 'BUSINESS_CARD') {
      const sid = `card_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      setCardSessionId(sid);
      setCardAssets({ front: null, back: null });
      actions.startCaptureWithDraft('BUSINESS_CARD', { cardSessionId: sid });
      setQrScanning(false);
    } else {
      actions.startCapture(method);
      setQrScanning(false);
    }
  }, [actions, form]);

  const handleBackToOptions = useCallback(() => {
    form.handleReset();
    actions.resetSession();
    setQrScanning(false);
  }, [actions, form]);

  const handleDiscardDraft = useCallback(async () => {
    // Delete any locally-stored card images before discarding
    if (cardSessionId) {
      await deleteSessionAssets(cardSessionId);
      setCardSessionId('');
      setCardAssets({ front: null, back: null });
    }
    await clearDraft();
    form.handleReset();
    actions.resetSession();
    setQrScanning(false);
  }, [actions, form, cardSessionId]);

  // After a successful QR scan: normalize parsed fields into the exact DraftData
  // key shape, then seed the session atomically. ManualEntryForm reads from
  // session.draftData directly so fields appear immediately without a hydration step.
  //
  // Wrapped in useCallback so QrScannerView's effect dep array stays stable —
  // prevents the success effect from re-firing on unrelated parent re-renders.
  const handleQrScanned = useCallback((parsed: ParsedContact) => {
    addEntryRef.current('QR scanned — raw text received', parsed.raw);
    addEntryRef.current('Parsing completed', { hasData: parsed.hasData, qrType: parsed.qrType, fields: parsed.fields });

    // Explicit field-by-field normalization — never assume parser key names
    // match DraftData keys automatically.
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

    // Strip undefined so draftData stays clean
    const draft = Object.fromEntries(
      Object.entries(mappedDraft).filter(([, v]) => v !== undefined),
    );

    addEntryRef.current('draft object built (explicit mapping)', draft);

    console.group('[QR Scan] handleQrScanned');
    console.log('raw QR text:', parsed.raw);
    console.log('qrType:', parsed.qrType);
    console.log('parsed.fields:', parsed.fields);
    console.log('mapped draft:', draft);
    console.groupEnd();

    setLastScan(parsed);
    addEntryRef.current('startCaptureWithDraft called', { method: 'MANUAL', draftKeys: Object.keys(draft) });
    actions.startCaptureWithDraft('MANUAL', draft);

    addEntryRef.current('Form view triggered — captureMethod MANUAL, qrScanning false');
    form.handleReset();
    setQrScanning(false);
  }, [actions, form]);

  const handleCardAssetsChanged = useCallback((front: BusinessCardAsset | null, back: BusinessCardAsset | null) => {
    setCardAssets({ front, back });
    // Keep draft in sync with current asset IDs
    actions.patchDraft({
      cardFrontAssetId: front?.id ?? undefined,
      cardBackAssetId:  back?.id  ?? undefined,
    });
    addEntryRef.current('Business card assets updated', { frontId: front?.id, backId: back?.id });
  }, [actions]);

  const handleOcrResult = useCallback((result: OcrResult) => {
    setLastOcrResult(result);
    addEntryRef.current('OCR completed', {
      assetId: result.assetId,
      confidence: result.confidence,
      inferredFields: result.inferredFields,
      rawText: result.rawText.slice(0, 200),
    });
    // Store raw text in draft for debugging/future enrichment
    actions.patchDraft({ ocrRawText: result.rawText });
  }, [actions]);

  const handleCardComplete = useCallback((frontAssetId: string, backAssetId: string | null, ocrResult: OcrResult | null) => {
    addEntryRef.current('Business card capture complete', { frontAssetId, backAssetId, hasOcr: !!ocrResult });

    // Build draft by merging OCR fields — only populate fields that are empty
    // so manually typed values are never overwritten by OCR.
    const ocr = ocrResult ?? lastOcrResult;
    const ocrFields = ocr ? {
      clientName:  ocr.fields.clientName  || undefined,
      company:     ocr.fields.company     || undefined,
      phone:       ocr.fields.phone       || undefined,
      email:       ocr.fields.email       || undefined,
      designation: ocr.fields.designation || undefined,
      notes:       ocr.fields.notes       || undefined,
    } : {};

    // Strip undefined
    const cleanOcr = Object.fromEntries(
      Object.entries(ocrFields).filter(([, v]) => v !== undefined),
    );

    const newDraft = {
      ...cleanOcr,                      // OCR fields as base
      ...session.draftData,             // existing draft overrides (preserves manual edits)
      cardSessionId:    cardSessionId,
      cardFrontAssetId: frontAssetId,
      cardBackAssetId:  backAssetId ?? undefined,
      ocrRawText:       ocr?.rawText,
    };

    addEntryRef.current('Transitioning to form with OCR-seeded draft', { draftKeys: Object.keys(newDraft) });

    // Transition to MANUAL form so user can review/edit
    actions.startCaptureWithDraft('MANUAL', newDraft);
  }, [actions, session.draftData, cardSessionId, lastOcrResult]);

  const isCapturing      = session.sessionStatus !== 'IDLE';
  const showQrScanner    = isCapturing && session.captureMethod === 'QR' && qrScanning;
  const showManualForm   = isCapturing && session.captureMethod === 'MANUAL';
  const showBusinessCard = isCapturing && session.captureMethod === 'BUSINESS_CARD';

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

        {showBusinessCard && (
          <BusinessCardCapture
            session={session}
            sessionId={cardSessionId}
            onComplete={handleCardComplete}
            onBack={handleBackToOptions}
            onAssetsChanged={handleCardAssetsChanged}
            onOcrResult={handleOcrResult}
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
        cardAssets={cardAssets}
        cardSessionId={cardSessionId}
        lastOcrResult={lastOcrResult}
        log={log}
        onClearLog={clearLog}
      />
    </div>
  );
}
