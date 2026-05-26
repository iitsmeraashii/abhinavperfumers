import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useOnlineStatus } from './capture/useOnlineStatus';
import { useEvent } from './EventContext';
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
import {
  syncUpsertSession,
  syncUpsertAsset,
  syncUpsertOcrExtraction,
  syncUpsertQrExtraction,
  syncUpdateSessionFields,
  syncAbandonSession,
} from './capture/captureBackendSync';
import {
  enqueueOp,
  flushQueue,
  getPendingCount,
} from './capture/captureOfflineQueue';
import type { BackendSyncState, CaptureMethod, BusinessCardAsset, OcrResult, OcrStatus, VisionResult } from './capture/types';
import type { OcrPipelineDiagnostics } from './capture/useOcr';
import type { ParsedContact } from './capture/parseQrPayload';

const QrScannerView = lazy(() =>
  import('./capture/QrScannerView').then(m => ({ default: m.QrScannerView })),
);

// ─── Stable ID generator ──────────────────────────────────────────────────────

function genStableId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function CaptureLeadPage() {
  const { selectedEvent } = useEvent();
  const [pendingSyncCount, setPendingSyncCount] = useState(0);
  const [isFlushing, setIsFlushing] = useState(false);

  // Flush the offline queue and update pending count badge
  const handleReconnect = useCallback(async () => {
    setIsFlushing(true);
    try {
      await flushQueue();
    } finally {
      setIsFlushing(false);
      getPendingCount().then(setPendingSyncCount);
    }
  }, []);

  const isOnline = useOnlineStatus({ onReconnect: handleReconnect });
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

  const [ocrDebug, setOcrDebug] = useState<{
    status: 'idle' | 'processing' | 'done' | 'error';
    progress: number;
    progressLabel: string;
    error: string | null;
  }>({ status: 'idle', progress: 0, progressLabel: '', error: null });
  const [ocrDiagnostics, setOcrDiagnostics] = useState<OcrPipelineDiagnostics | null>(null);

  // Stable refs
  const addEntryRef = useRef(addEntry);
  addEntryRef.current = addEntry;
  const sessionRef = useRef(session);
  sessionRef.current = session;

  // Poll pending count on mount and after flush
  useEffect(() => {
    getPendingCount().then(setPendingSyncCount);
  }, [isFlushing]);

  // ── Backend sync helpers ──────────────────────────────────────────────────
  // When online: run immediately. When offline: enqueue for later.

  const makeSyncCbs = useCallback(() => ({
    onSyncing: () => actions.setSyncStatus('syncing'),
    onSynced:  (patch: Partial<BackendSyncState>) => {
      actions.patchSync({ ...patch, status: 'synced' });
      actions.decrementPendingOps();
    },
    onSyncError: (err: string) => {
      actions.setSyncStatus('error', err);
      actions.decrementPendingOps();
      addEntryRef.current('Backend sync error', err, 'warn');
    },
    onOffline: () => {
      actions.setSyncStatus('offline');
      actions.decrementPendingOps();
    },
  }), [actions]);

  // Upsert session — online: immediate; offline: queue
  const syncSessionOp = useCallback(async (
    payload: Parameters<typeof syncUpsertSession>[0],
    bsid: string,
  ) => {
    if (isOnline) {
      actions.incrementPendingOps();
      syncUpsertSession(payload, makeSyncCbs()).catch(() => {});
    } else {
      await enqueueOp('upsert_session', bsid, payload);
      actions.setSyncStatus('offline');
      setPendingSyncCount(n => n + 1);
      addEntryRef.current('Session queued for offline sync', { sessionId: bsid });
    }
  }, [isOnline, actions, makeSyncCbs]);

  // Upsert asset — online: immediate; offline: queue
  const syncAssetOp = useCallback(async (
    payload: Parameters<typeof syncUpsertAsset>[0],
  ) => {
    if (isOnline) {
      actions.incrementPendingOps();
      syncUpsertAsset(payload, makeSyncCbs()).catch(() => {});
    } else {
      await enqueueOp('upsert_asset', payload.backendSessionId, payload);
      actions.setSyncStatus('offline');
      setPendingSyncCount(n => n + 1);
      addEntryRef.current('Asset queued for offline sync', { assetId: payload.asset.id });
    }
  }, [isOnline, actions, makeSyncCbs]);

  // Upsert OCR extraction — online: immediate; offline: queue
  const syncOcrOp = useCallback(async (
    payload: Parameters<typeof syncUpsertOcrExtraction>[0],
  ) => {
    if (isOnline) {
      actions.incrementPendingOps();
      syncUpsertOcrExtraction(payload, makeSyncCbs()).catch(() => {});
    } else {
      await enqueueOp('upsert_ocr_extraction', payload.backendSessionId, payload);
      actions.setSyncStatus('offline');
      setPendingSyncCount(n => n + 1);
    }
  }, [isOnline, actions, makeSyncCbs]);

  // Upsert QR extraction — online: immediate; offline: queue
  const syncQrOp = useCallback(async (
    payload: Parameters<typeof syncUpsertQrExtraction>[0],
  ) => {
    if (isOnline) {
      actions.incrementPendingOps();
      syncUpsertQrExtraction(payload, makeSyncCbs()).catch(() => {});
    } else {
      await enqueueOp('upsert_qr_extraction', payload.backendSessionId, payload);
      actions.setSyncStatus('offline');
      setPendingSyncCount(n => n + 1);
    }
  }, [isOnline, actions, makeSyncCbs]);

  // Update session fields — online: immediate; offline: queue
  const syncFieldsOp = useCallback(async (
    bsid: string,
    draftData: typeof session.draftData,
  ) => {
    if (isOnline) {
      syncUpdateSessionFields(bsid, draftData, makeSyncCbs()).catch(() => {});
    } else {
      await enqueueOp('update_session_fields', bsid, { sessionId: bsid, draftData });
      actions.setSyncStatus('offline');
      setPendingSyncCount(n => n + 1);
    }
  }, [isOnline, actions, makeSyncCbs, session.draftData]);

  useAutosave(session);

  // ── Draft restore on mount ────────────────────────────────────────────────
  useEffect(() => {
    loadDraft().then((saved) => {
      if (!saved || saved.sessionStatus === 'IDLE') return;

      if (saved.captureMethod === 'BUSINESS_CARD' && saved.draftData.cardSessionId) {
        setCardSessionId(saved.draftData.cardSessionId as string);
      }

      const normalised = saved.captureMethod === 'QR'
        ? { ...saved, captureMethod: 'MANUAL' as CaptureMethod }
        : saved;

      actions.restoreSession(normalised);
      addEntryRef.current('Draft restored from IndexedDB', {
        method:          normalised.captureMethod,
        backendSessionId: normalised.sync.backendSessionId,
        lastSyncedAt:    normalised.sync.lastSyncedAt,
      });

      // Re-sync restored session if online
      if (normalised.sync.backendSessionId && navigator.onLine) {
        actions.incrementPendingOps();
        syncUpsertSession({
          sessionId:     normalised.sync.backendSessionId,
          captureMethod: (normalised.captureMethod ?? 'MANUAL') as CaptureMethod,
          draftData:     normalised.draftData,
          sessionStatus: normalised.sessionStatus,
          localDraftKey: 'active_capture_draft',
          eventId:       selectedEvent?.id ?? null,
        }, makeSyncCbs()).catch(() => {});
      }

      setRecoveryToast('Recovered unfinished draft');
      recoveryTimer.current = setTimeout(() => setRecoveryToast(null), 3200);
    });

    return () => { if (recoveryTimer.current) clearTimeout(recoveryTimer.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Method selection ──────────────────────────────────────────────────────
  const handleMethodSelect = useCallback(async (method: CaptureMethod) => {
    form.handleReset();

    if (method === 'QR') {
      addEntryRef.current('QR scanner opened');
      const backendSessionId = actions.startCapture('QR');
      setQrScanning(true);

      await syncSessionOp({
        sessionId:     backendSessionId,
        captureMethod: 'QR',
        draftData:     {},
        sessionStatus: 'CAPTURING',
        localDraftKey: 'active_capture_draft',
        eventId:       selectedEvent?.id ?? null,
      }, backendSessionId);
      addEntryRef.current('Session created/queued (QR)', { backendSessionId });

    } else if (method === 'BUSINESS_CARD') {
      const sid = `card_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      setCardSessionId(sid);
      setCardAssets({ front: null, back: null });
      setOcrDebug({ status: 'idle', progress: 0, progressLabel: '', error: null });
      setLastOcrResult(null);

      addEntryRef.current('Business card capture session started', { cardSessionId: sid });
      actions.startCaptureWithDraft('BUSINESS_CARD', { cardSessionId: sid });
      setQrScanning(false);

      setTimeout(async () => {
        const bsid = sessionRef.current.sync.backendSessionId;
        if (!bsid) return;
        await syncSessionOp({
          sessionId:     bsid,
          captureMethod: 'BUSINESS_CARD',
          draftData:     { cardSessionId: sid },
          sessionStatus: 'CAPTURING',
          localDraftKey: 'active_capture_draft',
          eventId:       selectedEvent?.id ?? null,
        }, bsid);
        addEntryRef.current('Session created/queued (BUSINESS_CARD)', { backendSessionId: bsid });
      }, 0);

    } else {
      const backendSessionId = actions.startCapture(method);
      setQrScanning(false);

      await syncSessionOp({
        sessionId:     backendSessionId,
        captureMethod: method,
        draftData:     {},
        sessionStatus: 'CAPTURING',
        localDraftKey: 'active_capture_draft',
        eventId:       selectedEvent?.id ?? null,
      }, backendSessionId);
      addEntryRef.current('Session created/queued (MANUAL)', { backendSessionId });
    }
  }, [actions, form, syncSessionOp, selectedEvent]);

  // ── Back / discard ────────────────────────────────────────────────────────
  const handleBackToOptions = useCallback(() => {
    const bsid = sessionRef.current.sync.backendSessionId;
    if (bsid && isOnline) {
      syncAbandonSession(bsid, makeSyncCbs()).catch(() => {});
    }
    form.handleReset();
    actions.resetSession();
    setQrScanning(false);
  }, [actions, form, isOnline, makeSyncCbs]);

  const handleDiscardDraft = useCallback(async () => {
    const bsid = sessionRef.current.sync.backendSessionId;
    if (bsid && isOnline) {
      syncAbandonSession(bsid, makeSyncCbs()).catch(() => {});
    }
    if (cardSessionId) {
      await deleteSessionAssets(cardSessionId);
      setCardSessionId('');
      setCardAssets({ front: null, back: null });
    }
    await clearDraft();
    form.handleReset();
    actions.resetSession();
    setQrScanning(false);
  }, [actions, form, cardSessionId, isOnline, makeSyncCbs]);

  // ── QR scan complete ──────────────────────────────────────────────────────
  const handleQrScanned = useCallback(async (parsed: ParsedContact) => {
    const scanStart = Date.now();
    addEntryRef.current('QR scanned', parsed.raw);

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
    const draft = Object.fromEntries(
      Object.entries(mappedDraft).filter(([, v]) => v !== undefined),
    );

    setLastScan(parsed);
    actions.startCaptureWithDraft('MANUAL', draft);
    form.handleReset();
    setQrScanning(false);

    setTimeout(async () => {
      const bsid = sessionRef.current.sync.backendSessionId;
      if (!bsid) return;

      const extractionId = genStableId();

      await syncQrOp({
        extractionId,
        backendSessionId: bsid,
        parsed,
        durationMs: Date.now() - scanStart,
      });

      await syncFieldsOp(bsid, draft);

      addEntryRef.current('QR extraction queued/synced', { extractionId, bsid });
    }, 0);
  }, [actions, form, syncQrOp, syncFieldsOp]);

  // ── Business card assets changed ─────────────────────────────────────────
  const handleCardAssetsChanged = useCallback(async (
    front: BusinessCardAsset | null,
    back: BusinessCardAsset | null,
  ) => {
    setCardAssets({ front, back });
    actions.patchDraft({
      cardFrontAssetId: front?.id ?? undefined,
      cardBackAssetId:  back?.id  ?? undefined,
    });
    addEntryRef.current('Business card assets updated', { frontId: front?.id, backId: back?.id });

    const bsid = sessionRef.current.sync.backendSessionId;
    const asset = front ?? back;
    if (!bsid || !asset) return;

    await syncAssetOp({ backendSessionId: bsid, asset });
    addEntryRef.current('Asset queued/synced', { localAssetId: asset.id });
  }, [actions, syncAssetOp]);

  // ── OCR result received ───────────────────────────────────────────────────
  const handleOcrResult = useCallback(async (result: OcrResult) => {
    setLastOcrResult(result);
    setOcrDebug({ status: 'done', progress: 1, progressLabel: 'Done', error: null });

    addEntryRef.current('OCR completed', {
      assetId:        result.assetId,
      confidence:     result.confidence,
      rawTextLength:  result.rawText.length,
    });

    actions.patchDraft({ ocrRawText: result.rawText });

    const bsid = sessionRef.current.sync.backendSessionId;
    if (!bsid) return;

    const backendAssetId   = sessionRef.current.sync.backendAssetIds[result.assetId] ?? null;
    const extractionId     = genStableId();

    await syncOcrOp({
      extractionId,
      backendSessionId: bsid,
      backendAssetId,
      ocrResult:        result,
    });
  }, [actions, syncOcrOp]);

  // ── Card capture complete (Continue pressed) ──────────────────────────────
  const handleCardComplete = useCallback(async (
    frontAssetId: string,
    backAssetId: string | null,
    ocrResult: OcrResult | null,
    visionResult: VisionResult | null,
  ) => {
    addEntryRef.current('Business card capture complete', {
      frontAssetId, backAssetId,
      hasVisionResult: !!visionResult,
      visionSource: visionResult?.source,
    });

    let extractedFields: Record<string, unknown> = {};

    if (visionResult) {
      const f = visionResult.fields;
      extractedFields = {
        clientName:       f.fullName    || undefined,
        company:          f.company     || undefined,
        designation:      f.designation || undefined,
        phone:            f.phoneNumbers?.[0] || undefined,
        email:            f.emails?.[0]       || undefined,
        notes:            f.notes       || undefined,
        phoneNumbers:     f.phoneNumbers.length > 0 ? f.phoneNumbers : undefined,
        emails:           f.emails.length > 0 ? f.emails : undefined,
        website:          f.website     || undefined,
        address:          f.address     || undefined,
        visionRawText:    f.rawText     || undefined,
        extractionSource: visionResult.source,
      };
    } else {
      const ocr = ocrResult ?? lastOcrResult;
      if (ocr) {
        extractedFields = {
          clientName:  ocr.fields.clientName  || undefined,
          company:     ocr.fields.company     || undefined,
          phone:       ocr.fields.phone       || undefined,
          email:       ocr.fields.email       || undefined,
          designation: ocr.fields.designation || undefined,
          notes:       ocr.fields.notes       || undefined,
          ocrRawText:  ocr.rawText            || undefined,
        };
      }
    }

    const cleanFields = Object.fromEntries(
      Object.entries(extractedFields).filter(([, v]) => v !== undefined),
    );

    const newDraft = {
      ...cleanFields,
      ...session.draftData,
      cardSessionId:    cardSessionId,
      cardFrontAssetId: frontAssetId,
      cardBackAssetId:  backAssetId ?? undefined,
    };

    actions.startCaptureWithDraft('MANUAL', newDraft);

    const bsid = sessionRef.current.sync.backendSessionId;
    if (bsid) {
      await syncFieldsOp(bsid, newDraft);
      addEntryRef.current('Session fields queued/synced after card complete', { bsid });
    }
  }, [actions, session.draftData, cardSessionId, lastOcrResult, syncFieldsOp]);

  // ── Manual form field sync (debounced 1.5s) ───────────────────────────────
  const fieldSyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (session.captureMethod !== 'MANUAL') return;
    const bsid = session.sync.backendSessionId;
    if (!bsid) return;

    if (fieldSyncTimerRef.current) clearTimeout(fieldSyncTimerRef.current);
    fieldSyncTimerRef.current = setTimeout(() => {
      syncFieldsOp(bsid, session.draftData).catch(() => {});
    }, 1500);

    return () => { if (fieldSyncTimerRef.current) clearTimeout(fieldSyncTimerRef.current); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.draftData]);

  // ─── Derived flags ─────────────────────────────────────────────────────────
  const isCapturing      = session.sessionStatus !== 'IDLE';
  const showQrScanner    = isCapturing && session.captureMethod === 'QR' && qrScanning;
  const showManualForm   = isCapturing && session.captureMethod === 'MANUAL';
  const showBusinessCard = isCapturing && session.captureMethod === 'BUSINESS_CARD';

  return (
    <div className="min-h-[calc(100vh-57px)] bg-stone-50 flex flex-col">
      <OfflineBanner visible={!isOnline} pendingCount={pendingSyncCount} isFlushing={isFlushing} />

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
            isOnline={isOnline}
            onComplete={handleCardComplete}
            onBack={handleBackToOptions}
            onAssetsChanged={handleCardAssetsChanged}
            onOcrResult={handleOcrResult}
            onOcrStateChange={(s) => setOcrDebug(s as typeof ocrDebug)}
            onOcrDiagnostics={setOcrDiagnostics}
            onDebugLog={(step, detail, level) => addEntry(step, detail, level)}
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
        ocrStatus={ocrDebug.status as OcrStatus}
        ocrProgress={ocrDebug.progress}
        ocrProgressLabel={ocrDebug.progressLabel}
        ocrError={ocrDebug.error}
        ocrDiagnostics={ocrDiagnostics}
        log={log}
        onClearLog={clearLog}
      />
    </div>
  );
}
