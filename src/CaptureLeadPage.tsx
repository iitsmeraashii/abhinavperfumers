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
import {
  syncUpsertSession,
  syncUpsertAsset,
  syncUpsertOcrExtraction,
  syncUpsertQrExtraction,
  syncUpdateSessionFields,
  syncAbandonSession,
} from './capture/captureBackendSync';
import type { BackendSyncState, CaptureMethod, BusinessCardAsset, OcrResult, OcrStatus } from './capture/types';
import type { OcrPipelineDiagnostics } from './capture/useOcr';
import type { ParsedContact } from './capture/parseQrPayload';

const QrScannerView = lazy(() =>
  import('./capture/QrScannerView').then(m => ({ default: m.QrScannerView })),
);

// ─── Stable ID generator (mirrors useCaptureSession) ─────────────────────────

function genStableId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

// ─── Page ─────────────────────────────────────────────────────────────────────

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

  const [ocrDebug, setOcrDebug] = useState<{
    status: 'idle' | 'processing' | 'done' | 'error';
    progress: number;
    progressLabel: string;
    error: string | null;
  }>({ status: 'idle', progress: 0, progressLabel: '', error: null });
  const [ocrDiagnostics, setOcrDiagnostics] = useState<OcrPipelineDiagnostics | null>(null);

  // Stable refs — avoids useCallback dep arrays growing
  const addEntryRef = useRef(addEntry);
  addEntryRef.current = addEntry;
  const sessionRef = useRef(session);
  sessionRef.current = session;

  // ── Backend sync callbacks ────────────────────────────────────────────────
  // These are passed to every syncXxx call and update React state after the
  // fire-and-forget network op settles. UI never waits on these.

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

      // Re-sync restored session to backend if online — keeps the DB row fresh
      if (normalised.sync.backendSessionId && navigator.onLine) {
        actions.incrementPendingOps();
        syncUpsertSession({
          sessionId:     normalised.sync.backendSessionId,
          captureMethod: (normalised.captureMethod ?? 'MANUAL') as CaptureMethod,
          draftData:     normalised.draftData,
          sessionStatus: normalised.sessionStatus,
          localDraftKey: 'active_capture_draft',
        }, makeSyncCbs()).catch(() => { /* already handled in callbacks */ });
      }

      setRecoveryToast('Recovered unfinished draft');
      recoveryTimer.current = setTimeout(() => setRecoveryToast(null), 3200);
    });

    return () => { if (recoveryTimer.current) clearTimeout(recoveryTimer.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Method selection ──────────────────────────────────────────────────────
  const handleMethodSelect = useCallback((method: CaptureMethod) => {
    form.handleReset();

    if (method === 'QR') {
      addEntryRef.current('QR scanner opened');
      const backendSessionId = actions.startCapture('QR');
      setQrScanning(true);

      // Fire-and-forget: create capture_session record in backend
      actions.incrementPendingOps();
      syncUpsertSession({
        sessionId:     backendSessionId,
        captureMethod: 'QR',
        draftData:     {},
        sessionStatus: 'CAPTURING',
        localDraftKey: 'active_capture_draft',
      }, makeSyncCbs()).catch(() => {});

      addEntryRef.current('Backend session created (QR)', { backendSessionId });

    } else if (method === 'BUSINESS_CARD') {
      const sid = `card_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      setCardSessionId(sid);
      setCardAssets({ front: null, back: null });
      setOcrDebug({ status: 'idle', progress: 0, progressLabel: '', error: null });
      setLastOcrResult(null);

      addEntryRef.current('Business card capture session started', { cardSessionId: sid });
      actions.startCaptureWithDraft('BUSINESS_CARD', { cardSessionId: sid });
      setQrScanning(false);

      // The backendSessionId was set inside startCaptureWithDraft — read it
      // from state via a tiny timeout (state update is sync in React 18 batching)
      setTimeout(() => {
        const bsid = sessionRef.current.sync.backendSessionId;
        if (!bsid) return;
        actions.incrementPendingOps();
        syncUpsertSession({
          sessionId:     bsid,
          captureMethod: 'BUSINESS_CARD',
          draftData:     { cardSessionId: sid },
          sessionStatus: 'CAPTURING',
          localDraftKey: 'active_capture_draft',
        }, makeSyncCbs()).catch(() => {});
        addEntryRef.current('Backend session created (BUSINESS_CARD)', { backendSessionId: bsid });
      }, 0);

    } else {
      const backendSessionId = actions.startCapture(method);
      setQrScanning(false);

      actions.incrementPendingOps();
      syncUpsertSession({
        sessionId:     backendSessionId,
        captureMethod: method,
        draftData:     {},
        sessionStatus: 'CAPTURING',
        localDraftKey: 'active_capture_draft',
      }, makeSyncCbs()).catch(() => {});
      addEntryRef.current('Backend session created (MANUAL)', { backendSessionId });
    }
  }, [actions, form, makeSyncCbs]);

  // ── Back / discard ────────────────────────────────────────────────────────
  const handleBackToOptions = useCallback(() => {
    // Mark the backend session as abandoned (fire-and-forget)
    const bsid = sessionRef.current.sync.backendSessionId;
    if (bsid) {
      syncAbandonSession(bsid, makeSyncCbs()).catch(() => {});
    }
    form.handleReset();
    actions.resetSession();
    setQrScanning(false);
  }, [actions, form, makeSyncCbs]);

  const handleDiscardDraft = useCallback(async () => {
    const bsid = sessionRef.current.sync.backendSessionId;
    if (bsid) {
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
  }, [actions, form, cardSessionId, makeSyncCbs]);

  // ── QR scan complete ──────────────────────────────────────────────────────
  const handleQrScanned = useCallback((parsed: ParsedContact) => {
    const scanStart = Date.now();
    addEntryRef.current('QR scanned — raw text received', parsed.raw);
    addEntryRef.current('Parsing completed', {
      hasData: parsed.hasData, qrType: parsed.qrType, fields: parsed.fields,
    });

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

    addEntryRef.current('draft object built (explicit mapping)', draft);

    setLastScan(parsed);
    actions.startCaptureWithDraft('MANUAL', draft);
    form.handleReset();
    setQrScanning(false);

    // Sync: upsert extraction_result for the QR parse, then update session fields
    setTimeout(() => {
      const bsid = sessionRef.current.sync.backendSessionId;
      if (!bsid) return;

      const extractionId = genStableId();
      actions.incrementPendingOps();
      syncUpsertQrExtraction({
        extractionId,
        backendSessionId: bsid,
        parsed,
        durationMs: Date.now() - scanStart,
      }, makeSyncCbs()).catch(() => {});

      actions.incrementPendingOps();
      syncUpdateSessionFields(bsid, draft, makeSyncCbs()).catch(() => {});

      addEntryRef.current('Backend: QR extraction result queued', {
        extractionId, backendSessionId: bsid,
      });
    }, 0);
  }, [actions, form, makeSyncCbs]);

  // ── Business card assets changed ─────────────────────────────────────────
  const handleCardAssetsChanged = useCallback((
    front: BusinessCardAsset | null,
    back: BusinessCardAsset | null,
  ) => {
    setCardAssets({ front, back });
    actions.patchDraft({
      cardFrontAssetId: front?.id ?? undefined,
      cardBackAssetId:  back?.id  ?? undefined,
    });
    addEntryRef.current('Business card assets updated', { frontId: front?.id, backId: back?.id });

    // Sync: upsert capture_asset record for newly saved images
    const bsid = sessionRef.current.sync.backendSessionId;
    const asset = front ?? back;
    if (!bsid || !asset) return;

    actions.incrementPendingOps();
    syncUpsertAsset({ backendSessionId: bsid, asset }, makeSyncCbs()).catch(() => {});
    addEntryRef.current('Backend: asset upsert queued', {
      localAssetId: asset.id, side: asset.side, backendSessionId: bsid,
    });
  }, [actions, makeSyncCbs]);

  // ── OCR result received ───────────────────────────────────────────────────
  const handleOcrResult = useCallback((result: OcrResult) => {
    setLastOcrResult(result);
    setOcrDebug({ status: 'done', progress: 1, progressLabel: 'Done', error: null });

    addEntryRef.current('OCR completed', {
      assetId:        result.assetId,
      confidence:     result.confidence,
      inferredFields: result.inferredFields,
      rawTextLength:  result.rawText.length,
      rawTextPreview: result.rawText.slice(0, 300),
    });

    if (result.inferredFields.length === 0) {
      addEntryRef.current('OCR warning — no fields inferred', {
        rawText: result.rawText, ignoredLines: result.ignoredLines,
      }, 'warn');
    }
    if (!result.rawText?.trim()) {
      addEntryRef.current('OCR error — empty raw text', undefined, 'error');
    }

    actions.patchDraft({ ocrRawText: result.rawText });

    // Sync: upsert extraction_result for this OCR run
    const bsid = sessionRef.current.sync.backendSessionId;
    if (!bsid) return;

    const backendAssetId = sessionRef.current.sync.backendAssetIds[result.assetId] ?? null;
    const extractionId   = genStableId();

    actions.incrementPendingOps();
    syncUpsertOcrExtraction({
      extractionId,
      backendSessionId: bsid,
      backendAssetId,
      ocrResult:        result,
    }, makeSyncCbs()).catch(() => {});

    addEntryRef.current('Backend: OCR extraction result queued', {
      extractionId, backendSessionId: bsid, backendAssetId,
    });
  }, [actions, makeSyncCbs]);

  // ── Card capture complete (Continue pressed) ──────────────────────────────
  const handleCardComplete = useCallback((
    frontAssetId: string,
    backAssetId: string | null,
    ocrResult: OcrResult | null,
  ) => {
    addEntryRef.current('Business card capture complete — Continue pressed', {
      frontAssetId, backAssetId, hasOcrResult: !!ocrResult,
    });

    const ocr = ocrResult ?? lastOcrResult;
    if (!ocr) {
      addEntryRef.current('OCR warning — no OCR result at Continue time', undefined, 'warn');
    }

    const ocrFields = ocr ? {
      clientName:  ocr.fields.clientName  || undefined,
      company:     ocr.fields.company     || undefined,
      phone:       ocr.fields.phone       || undefined,
      email:       ocr.fields.email       || undefined,
      designation: ocr.fields.designation || undefined,
      notes:       ocr.fields.notes       || undefined,
    } : {};
    const cleanOcr = Object.fromEntries(
      Object.entries(ocrFields).filter(([, v]) => v !== undefined),
    );

    const newDraft = {
      ...cleanOcr,
      ...session.draftData,
      cardSessionId:    cardSessionId,
      cardFrontAssetId: frontAssetId,
      cardBackAssetId:  backAssetId ?? undefined,
      ocrRawText:       ocr?.rawText,
    };

    addEntryRef.current('draftData updated — transitioning to manual form', {
      draftKeys:   Object.keys(newDraft),
      clientName:  newDraft.clientName  ?? '(empty)',
      company:     newDraft.company     ?? '(empty)',
      phone:       newDraft.phone       ?? '(empty)',
      email:       newDraft.email       ?? '(empty)',
      designation: newDraft.designation ?? '(empty)',
    });

    actions.startCaptureWithDraft('MANUAL', newDraft);

    // Sync: update session fields in backend with merged data
    const bsid = sessionRef.current.sync.backendSessionId;
    if (bsid) {
      actions.incrementPendingOps();
      syncUpdateSessionFields(bsid, newDraft, makeSyncCbs()).catch(() => {});
      addEntryRef.current('Backend: session fields updated after card complete', { bsid });
    }
  }, [actions, session.draftData, cardSessionId, lastOcrResult, makeSyncCbs]);

  // ── Manual form field changes (debounced by useAutosave) ──────────────────
  // useAutosave already saves to IndexedDB. Here we also push to backend
  // when the session is in MANUAL mode and has a backend ID.
  // We use a ref to debounce this separately without adding to useAutosave.
  const fieldSyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (session.captureMethod !== 'MANUAL') return;
    const bsid = session.sync.backendSessionId;
    if (!bsid) return;

    if (fieldSyncTimerRef.current) clearTimeout(fieldSyncTimerRef.current);
    fieldSyncTimerRef.current = setTimeout(() => {
      syncUpdateSessionFields(bsid, session.draftData, makeSyncCbs()).catch(() => {});
    }, 1500); // 1.5s debounce — coarser than local autosave (700ms)

    return () => { if (fieldSyncTimerRef.current) clearTimeout(fieldSyncTimerRef.current); };
  // Only re-run when draftData changes, not on every render
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.draftData]);

  // ─── Derived flags ─────────────────────────────────────────────────────────
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
