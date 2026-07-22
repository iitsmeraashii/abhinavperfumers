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
import { Toast, DraftRecoveryBanner } from './capture/CaptureUI';
import type { SaveState } from './capture/useAutosave';
import { CaptureDebugPanel, useDebugLog } from './capture/CaptureDebugPanel';
import {
  syncUpsertSession,
  syncUpsertAsset,
  syncUpdateSessionFields,
  syncAbandonSession,
} from './capture/captureBackendSync';
import {
  enqueueOp,
  flushQueue,
  getPendingCount,
} from './capture/captureOfflineQueue';
import { saveCompletedLead, buildCompletedLead } from './capture/completedLeadsStorage';
import {
  registerCardEvidence,
  registerVoiceNoteEvidence,
  notifySessionReset,
  handleVisionExtraction,
  handleOcrExtraction,
  handleQrExtraction,
  processCaptureSession,
} from './capture/captureProcessingEngine';
import type { ExtractionSyncCallbacks, ProcessingContext } from './capture/captureProcessingEngine';
import type { BackendSyncState, CaptureMethod, BusinessCardAsset, OcrResult, OcrStatus, VisionResult } from './capture/types';
import type { OcrPipelineDiagnostics } from './capture/useOcr';
import type { ParsedContact } from './capture/parseQrPayload';

const QrScannerView = lazy(() =>
  import('./capture/QrScannerView').then(m => ({ default: m.QrScannerView })),
);

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function CaptureLeadPage() {
  const { selectedEvent } = useEvent();
  const [pendingSyncCount, setPendingSyncCount] = useState(0);
  const [isFlushing, setIsFlushing] = useState(false);
  const [promotionToast, setPromotionToast] = useState<{ message: string; isError: boolean } | null>(null);

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
  const [saveState, setSaveState] = useState<SaveState>('idle');
  // Pending draft held until user confirms Continue or Discard
  const [pendingDraft, setPendingDraft] = useState<{ session: typeof session; capturedAt: Date | null } | null>(null);
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

  // Stable reference so BusinessCardCapture's useEffect dep on this prop doesn't cycle.
  const handleOcrStateChange = useCallback(
    (s: { status: string; progress: number; progressLabel: string; error: string | null }) => {
      setOcrDebug(s as typeof ocrDebug);
    },
    [],
  );

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

  // Extraction sync callbacks — passed to engine extraction event handlers so the
  // engine can drive React state updates without importing React.
  const makeExtractionSyncCbs = useCallback((): ExtractionSyncCallbacks => ({
    onBeforeOnlineSync: () => actions.incrementPendingOps(),
    onSyncing:          () => actions.setSyncStatus('syncing'),
    onSynced:           (patch: Partial<BackendSyncState>) => {
      actions.patchSync({ ...patch, status: 'synced' });
      actions.decrementPendingOps();
    },
    onSyncError:        (err: string) => {
      actions.setSyncStatus('error', err);
      actions.decrementPendingOps();
      addEntryRef.current('Backend sync error', err, 'warn');
    },
    onOffline:          () => {
      actions.setSyncStatus('offline');
      actions.decrementPendingOps();
    },
    onOfflineQueued:    () => {
      actions.setSyncStatus('offline');
      setPendingSyncCount(n => n + 1);
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

  useAutosave(session, { isOnline, onSaveStateChange: setSaveState });

  // ── Draft restore on mount ────────────────────────────────────────────────
  // Draft restore on mount — hold draft in pendingDraft until user decides.
  useEffect(() => {
    loadDraft().then((saved) => {
      if (!saved || saved.sessionStatus === 'IDLE') return;

      const normalised = saved.captureMethod === 'QR'
        ? { ...saved, captureMethod: 'MANUAL' as CaptureMethod }
        : saved;

      addEntryRef.current('Draft found in IndexedDB — awaiting user decision', {
        method:           normalised.captureMethod,
        backendSessionId: normalised.sync.backendSessionId,
      });

      setPendingDraft({ session: normalised, capturedAt: normalised.updatedAt ?? normalised.createdAt });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // User chose to continue the recovered draft
  const handleRecoveryContinue = useCallback(() => {
    if (!pendingDraft) return;
    const normalised = pendingDraft.session;

    if (normalised.captureMethod === 'BUSINESS_CARD' && normalised.draftData.cardSessionId) {
      setCardSessionId(normalised.draftData.cardSessionId as string);
    }

    actions.restoreSession(normalised);
    setPendingDraft(null);
    addEntryRef.current('User continued recovered draft', { method: normalised.captureMethod });

    // Re-sync to backend if online
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
  }, [pendingDraft, actions, selectedEvent, makeSyncCbs]);

  // User chose to discard the recovered draft
  const handleRecoveryDiscard = useCallback(async () => {
    if (!pendingDraft) return;
    const bsid = pendingDraft.session.sync.backendSessionId;
    if (bsid && navigator.onLine) {
      syncAbandonSession(bsid, makeSyncCbs()).catch(() => {});
    }
    const cardSid = pendingDraft.session.draftData.cardSessionId as string | undefined;
    if (cardSid) {
      await deleteSessionAssets(cardSid);
    }
    await clearDraft();
    setPendingDraft(null);
    addEntryRef.current('User discarded recovered draft');
  }, [pendingDraft, makeSyncCbs]);

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
      setCardAssets({ front: null, back: null });
      setOcrDebug({ status: 'idle', progress: 0, progressLabel: '', error: null });
      setLastOcrResult(null);

      const backendSessionId = actions.startCapture('BUSINESS_CARD');
      setCardSessionId(backendSessionId);
      setQrScanning(false);

      // Store the backend UUID as cardSessionId in the draft so IndexedDB asset
      // lookups (restore, discard) always use the same identifier as the DB row.
      actions.patchDraft({ cardSessionId: backendSessionId });

      addEntryRef.current('Business card capture session started', { backendSessionId });

      await syncSessionOp({
        sessionId:     backendSessionId,
        captureMethod: 'BUSINESS_CARD',
        draftData:     { cardSessionId: backendSessionId },
        sessionStatus: 'CAPTURING',
        localDraftKey: 'active_capture_draft',
        eventId:       selectedEvent?.id ?? null,
      }, backendSessionId);
      addEntryRef.current('Session created/queued (BUSINESS_CARD)', { backendSessionId });

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

  // ── Save & start next lead (rapid capture) ───────────────────────────
  // Returns { error } on failure so ManualEntryForm can keep the form visible.
  const handleSaveAndNext = useCallback(async (): Promise<{ error?: string } | void> => {
    const s    = sessionRef.current;
    const bsid = s.sync.backendSessionId;

    if (s.sessionStatus === 'IDLE' || !bsid) {
      form.handleReset();
      actions.resetSession();
      return;
    }

    addEntryRef.current('Save & Next — promoting session to lead_entry', { bsid });

    const ctx: ProcessingContext = {
      session:          s,
      backendSessionId: bsid,
      eventCode:        selectedEvent?.event_code ?? null,
      completedLeadId:  bsid,
      eventId:          selectedEvent?.id ?? null,
      eventName:        selectedEvent?.name ?? null,
      isOnline,
    };

    const result = await processCaptureSession(ctx);

    if (result.outcome === 'failed') {
      const err = result.error ?? '';
      const isPermError = err.includes('row-level security')
        || err.includes('policy')
        || err.includes('permission');
      const msg = isPermError
        ? 'Permission error: INSERT policy missing on lead_entries. Ask your admin to apply the database policy.'
        : `Failed to save lead: ${err}`;
      setPromotionToast({ message: msg, isError: true });
      setTimeout(() => setPromotionToast(null), 8000);
      addEntryRef.current('Save & Next — promotion failed (non-retryable)', err);
      return { error: err };
    }

    if (result.outcome === 'queued') {
      if (!isOnline) actions.setSyncStatus('offline');
      setPendingSyncCount(n => n + 1);
      const msg = isOnline
        ? 'Lead saved — will sync when reconnected'
        : 'Lead saved — will sync when back online';
      addEntryRef.current('Save & Next — promotion queued', { bsid, online: isOnline });
      setPromotionToast({ message: msg, isError: false });
      setTimeout(() => setPromotionToast(null), 4000);
    } else {
      addEntryRef.current('Save & Next — lead promoted', { leadId: result.leadId });
      setPromotionToast({ message: 'Lead saved to your list!', isError: false });
      setTimeout(() => setPromotionToast(null), 3000);
    }

    form.handleReset();
    actions.resetSession();
    setQrScanning(false);
    setCardSessionId('');
    setCardAssets({ front: null, back: null });
    setLastOcrResult(null);
    notifySessionReset();
  }, [actions, form, selectedEvent, isOnline]);

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
      website:     String(f.website     ?? '').trim() || undefined,
      address:     String(f.address     ?? '').trim() || undefined,
      rawQr:       parsed.raw,
      qrExtractionEmpty: !f.clientName && !f.company && !f.phone
        && !f.email && !f.designation && !f.notes && !f.website && !f.address,
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

      await handleQrExtraction({
        parsed,
        backendSessionId: bsid,
        durationMs: Date.now() - scanStart,
        isOnline,
        syncCbs: makeExtractionSyncCbs(),
      });

      await syncFieldsOp(bsid, draft);

      // Persist to completed_leads so the Queue screen can show it
      const lead = buildCompletedLead(
        bsid, 'QR', draft as import('./capture/types').DraftData,
        bsid, selectedEvent?.id ?? null, selectedEvent?.name ?? null,
      );
      lead.status = isOnline ? 'pending_sync' : 'local_only';
      await saveCompletedLead(lead);

      addEntryRef.current('QR extraction queued/synced', { bsid });
    }, 0);
  }, [actions, form, handleQrExtraction, makeExtractionSyncCbs, syncFieldsOp, selectedEvent, isOnline]);

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
    if (!bsid) return;

    // Sync EVERY present asset so both front and back get their own capture_assets row.
    // The upsert is idempotent (conflict on capture_session_id + local_asset_id), so
    // re-syncing an asset that already has a row is harmless.
    for (const asset of [front, back]) {
      if (asset) await syncAssetOp({ backendSessionId: bsid, asset });
    }
    addEntryRef.current('Assets queued/synced', { frontId: front?.id, backId: back?.id });

    // Register image bytes with the Processing Engine's Evidence Stage.
    // The engine delegates to evidenceManager, which owns upload decisions.
    registerCardEvidence(bsid, { front, back });
  }, [actions, syncAssetOp]);

  // ── Voice note recorded ───────────────────────────────────────────────────
  const handleVoiceNoteRecorded = useCallback((blob: Blob, durationMs: number, mimeType: string) => {
    const bsid = sessionRef.current.sync.backendSessionId;
    if (!bsid) return;
    registerVoiceNoteEvidence(bsid, blob, durationMs, mimeType);
  }, []);

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

    const backendAssetId = sessionRef.current.sync.backendAssetIds[result.assetId] ?? null;

    await handleOcrExtraction({
      result,
      backendSessionId: bsid,
      backendAssetId,
      isOnline,
      syncCbs: makeExtractionSyncCbs(),
    });
  }, [actions, isOnline, makeExtractionSyncCbs]);

  // ── Vision extraction result received ─────────────────────────────────────
  // Called for both openai_vision and tesseract_fallback.
  // The engine guards: only openai_vision writes an extraction_results row.
  // The fallback case is covered by handleOcrResult via the legacyOcr shim in applyVisionResult.
  const handleVisionResult = useCallback(async (result: import('./capture/types').VisionResult) => {
    addEntryRef.current('Vision extraction completed', {
      source:      result.source,
      confidence:  result.fields.confidence,
      durationMs:  result.durationMs,
    });

    const bsid = sessionRef.current.sync.backendSessionId;
    if (!bsid) return;

    const backendAssetId = sessionRef.current.sync.backendAssetIds[result.assetId] ?? null;

    await handleVisionExtraction({
      result,
      backendSessionId: bsid,
      backendAssetId,
      isOnline,
      syncCbs: makeExtractionSyncCbs(),
    });
  }, [isOnline, makeExtractionSyncCbs]);

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
        visionRawText:        f.rawText     || undefined,
        extractionSource:     visionResult.source,
        extractionConfidence: f.confidence,
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

      // Persist to completed_leads so the Queue screen can show it
      const lead = buildCompletedLead(
        bsid, 'BUSINESS_CARD', newDraft as import('./capture/types').DraftData,
        bsid, selectedEvent?.id ?? null, selectedEvent?.name ?? null,
      );
      lead.status = isOnline ? 'pending_sync' : 'local_only';
      await saveCompletedLead(lead);
      addEntryRef.current('Card complete — lead saved to completed_leads', { id: bsid, status: lead.status });
    }
  }, [actions, session.draftData, cardSessionId, lastOcrResult, syncFieldsOp, selectedEvent, isOnline]);

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
              onManualEntry={() => {
                setQrScanning(false);
                actions.startCaptureWithDraft('MANUAL', sessionRef.current.draftData);
              }}
            />
          </Suspense>
        )}

        {showManualForm && (
          <ManualEntryForm
            session={session}
            isOnline={isOnline}
            saveState={saveState}
            form={form}
            onBack={handleBackToOptions}
            onDiscard={handleDiscardDraft}
            onSaveAndNext={handleSaveAndNext}
            onVoiceNoteRecorded={handleVoiceNoteRecorded}
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
            onDraftPatch={actions.patchDraft}
            onVisionResult={handleVisionResult}
            onOcrResult={handleOcrResult}
            onOcrStateChange={handleOcrStateChange}
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

      {pendingDraft && (
        <DraftRecoveryBanner
          draftData={pendingDraft.session.draftData}
          capturedAt={pendingDraft.capturedAt}
          onContinue={handleRecoveryContinue}
          onDiscard={handleRecoveryDiscard}
        />
      )}

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

      {/* Promotion result toast — shown above the bottom nav */}
      <Toast
        message={promotionToast?.message ?? null}
        isError={promotionToast?.isError ?? false}
        position="top"
      />
    </div>
  );
}
