// ALPE Job Producer — the single integration point where the Capture Engine
// submits a captured session into the ALPE processing queue.
//
// Called from CaptureLeadPage.handleSaveAndNext when USE_ALPE_PROCESSING is
// enabled. Replaces the synchronous processCaptureSession call.
//
// Responsibilities:
//   1. Resolve auth identity (userId + repCode).
//   2. Generate a stable jobId (frontend UUID for idempotency).
//   3. Enqueue a processing_queue row via the repository.
//   4. Write a completed_leads record with status 'pending_sync' so the local
//      Queue screen shows the lead immediately.
//
// This function does NOT run extraction, validation, decision, or promotion.
// All processing occurs inside ALPE when the scheduler picks up the job.

import { getAuthIdentity } from '../capture/captureAuth';
import { buildCompletedLead, saveCompletedLead } from '../capture/completedLeadsStorage';
import { syncUpsertSession } from '../capture/captureBackendSync';
import { logOperationStart, logOperationEnd, logEvent } from '../capture/assetSyncDiagnostics';
import { evidenceManager } from '../capture/captureEvidenceManager';
import { waitForAssetStorageReady } from '../capture/assetStorageUpload';
import type { CaptureMethod, DraftData } from '../capture/types';
import { enqueueJob } from './processingQueueRepository';
import type { EnqueueResult } from './types';
import { isConsoleEnabled } from '../runtime/runtimeDiagnostics';
import { alpeLog, alpeError } from './diagnostics';
import { isCloudSyncAllowed } from '../authModeState';

export interface ProduceJobParams {
  backendSessionId: string;
  draftData:        DraftData;
  captureMethod:    CaptureMethod | null;
  eventId:          string | null;
  eventName:        string | null;
  correlationId?:  string | null;
  ownerId?:        string | null;
}

export interface ProduceJobResult {
  outcome: 'queued' | 'failed';
  jobId:   string | null;
  error:   string | null;
}

export async function produceProcessingJob(
  params: ProduceJobParams,
): Promise<ProduceJobResult> {
  const { backendSessionId, draftData, captureMethod, eventId, eventName, correlationId, ownerId } = params;

  // [DIAG:ADDRESS_FLOW] log address arriving at produceProcessingJob
  console.log('[DIAG:ADDRESS_FLOW] produceProcessingJob draftData.address =', draftData.address);

  const op = logOperationStart('produceProcessingJob()', {
    backendSessionId,
    captureMethod,
    correlationId: correlationId ?? null,
  });

  const stageCtx = { backendSessionId, ownerId: ownerId ?? null, correlationId: correlationId ?? null };
  const ts = () => new Date().toISOString();

  const identity = ownerId
    ? { userId: ownerId, repCode: null as string | null }
    : await getAuthIdentity();
  if (!identity?.userId) {
    alpeError('produceProcessingJob stage=auth failed', { ...stageCtx, ts: ts() });
    logOperationEnd(op, { error: new Error('Not authenticated') });
    return { outcome: 'failed', jobId: null, error: 'Not authenticated' };
  }
  alpeLog('produceProcessingJob stage=auth ok', { ...stageCtx, userId: identity.userId, ts: ts() });

  // Defensive gate: this function is called from captureProcessingAdapter
  // (gated) and from captureOfflineQueue flush (gated by flushQueue), but
  // guard the cloud-write boundary here as well. If cloud sync is not
  // allowed, skip all Supabase work — the caller is responsible for
  // enqueuing the job for later replay.
  if (!isCloudSyncAllowed()) {
    alpeLog('produceProcessingJob cloud sync not allowed — deferring', { ...stageCtx, ts: ts() });
    logOperationEnd(op, { extra: { deferred: 'cloud sync not allowed' } });
    return { outcome: 'queued', jobId: null, error: null };
  }

  // Guarantee the capture_sessions row exists before inserting into
  // processing_queue. routeSessionSync is fire-and-forget, so by the time
  // Save & Next fires the row may not yet be in the database. The FK
  // processing_queue_capture_session_id_fkey will reject the insert if the
  // parent row is missing, so we do an explicit awaited upsert here.
  let syncSessionError: string | null = null;
  const silentCbs = {
    onSyncing:   () => {},
    onSynced:    () => {},
    onSyncError: (err: string) => { syncSessionError = err; },
    onOffline:   () => {},
  };
  logEvent('produceProcessingJob() — pre-enqueue syncUpsertSession', {
    backendSessionId,
    captureMethod: captureMethod ?? 'MANUAL',
  });
  alpeLog('produceProcessingJob stage=syncUpsertSession start', { ...stageCtx, eventId, ts: ts() });
  await syncUpsertSession(
    {
      sessionId:     backendSessionId,
      captureMethod: captureMethod ?? 'MANUAL',
      draftData,
      sessionStatus: 'CAPTURING',
      eventId,
    },
    { ...silentCbs, correlationId: correlationId ?? null },
  );
  if (syncSessionError) {
    alpeError('produceProcessingJob stage=syncUpsertSession failed', { ...stageCtx, eventId, error: syncSessionError, ts: ts() });
  } else {
    alpeLog('produceProcessingJob stage=syncUpsertSession done', { ...stageCtx, eventId, ts: ts() });
  }

  // ── Evidence Readiness Gate ──────────────────────────────────────────────
  // For BUSINESS_CARD and QR captures, the processing job must not be
  // enqueued until the required evidence has reached a resolvable state —
  // meaning the asset has been uploaded to Supabase Storage and the
  // storage_path has been written to capture_assets. Without this gate the
  // scheduler claims the job immediately and the worker observes a missing
  // storage_path, causing evidence resolution to fail and validation to
  // reject the lead.
  //
  // flushPendingUploads starts any deferred (ON_SAVE) business card uploads.
  // waitForUploads then awaits all upload promises (both IMMEDIATE and the
  // just-started ON_SAVE ones) so the job is only enqueued after every
  // evidence asset has a storage_path written to capture_assets.
  logEvent('produceProcessingJob() — flushing pending evidence uploads', {
    backendSessionId,
    captureMethod,
  });
  if (isConsoleEnabled()) console.log('[EVIDENCE_DIAG] PRODUCER_PRECHECK', {
    ts: new Date().toISOString(),
    stage: 'before_flush',
    backendSessionId,
    captureMethod,
  });
  evidenceManager.flushPendingUploads(backendSessionId);
  logEvent('produceProcessingJob() — awaiting evidence uploads', {
    backendSessionId,
    captureMethod,
  });
  alpeLog('produceProcessingJob stage=waitForUploads start', { ...stageCtx, captureMethod, ts: ts() });
  await evidenceManager.waitForUploads(backendSessionId);
  alpeLog('produceProcessingJob stage=waitForUploads done', { ...stageCtx, captureMethod, ts: ts() });
  logEvent('produceProcessingJob() — evidence uploads complete', {
    backendSessionId,
    captureMethod,
  });

  const requiredAssetIds = captureMethod === 'BUSINESS_CARD'
    ? [draftData.cardFrontAssetId, draftData.cardBackAssetId].filter((id): id is string => Boolean(id))
    : [];
  if (requiredAssetIds.length > 0) {
    alpeLog('produceProcessingJob stage=waitForAssetStorageReady start', { ...stageCtx, requiredAssetIds, ts: ts() });
    const assetsReady = await waitForAssetStorageReady(backendSessionId, requiredAssetIds);
    alpeLog('produceProcessingJob stage=waitForAssetStorageReady done', { ...stageCtx, assetsReady, ts: ts() });
    if (!assetsReady) {
      const error = 'Evidence upload did not complete; processing was not queued';
      alpeError('produceProcessingJob stage=waitForAssetStorageReady failed', { ...stageCtx, ts: ts() });
      logOperationEnd(op, { error: new Error(error) });
      return { outcome: 'failed', jobId: null, error };
    }
  }

  const jobId = crypto.randomUUID();

  logEvent('produceProcessingJob() — enqueueJob', {
    backendSessionId,
    captureMethod,
  }, { jobId });
  if (isConsoleEnabled()) console.log('[EVIDENCE_DIAG] JOB_ENQUEUE', {
    ts: new Date().toISOString(),
    backendSessionId,
    jobId,
    captureMethod,
    requiredAssetIds,
  });
  alpeLog('produceProcessingJob stage=enqueueJob start', { ...stageCtx, jobId, ts: ts() });
  const result: EnqueueResult = await enqueueJob({
    jobId,
    captureSessionId: backendSessionId,
    userId:           identity.userId,
    eventId,
    priority:         0,
    processingVersion: 1,
    metadata: {
      captureMethod,
      repCode: identity.repCode,
      eventName,
      correlationId: correlationId ?? null,
    },
  });
  alpeLog('produceProcessingJob stage=enqueueJob done', { ...stageCtx, jobId, success: result.success, ts: ts() });

  if (!result.success) {
    alpeError('produceProcessingJob stage=enqueueJob failed', { ...stageCtx, jobId, error: result.error, ts: ts() });
    logOperationEnd(op, { error: new Error(result.error ?? 'enqueue failed') });
    return { outcome: 'failed', jobId: null, error: result.error };
  }

  // Write a local completed_leads record so the Queue screen shows the lead
  // immediately. ALPE will update the backend; the local record tracks the
  // processing status.
  const lead = buildCompletedLead(
    backendSessionId, captureMethod, draftData,
    backendSessionId, eventId, eventName,
    identity.userId,
  );
  lead.status = 'pending_sync';
  alpeLog('produceProcessingJob stage=saveCompletedLead start', { ...stageCtx, jobId, ts: ts() });
  await saveCompletedLead(lead);
  alpeLog('produceProcessingJob stage=saveCompletedLead done', { ...stageCtx, jobId, ts: ts() });

  logOperationEnd(op, { extra: { jobId: result.jobId, outcome: 'queued' } });
  return { outcome: 'queued', jobId: result.jobId, error: null };
}
