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

export interface ProduceJobParams {
  backendSessionId: string;
  draftData:        DraftData;
  captureMethod:    CaptureMethod | null;
  eventId:          string | null;
  eventName:        string | null;
  correlationId?:  string | null;
}

export interface ProduceJobResult {
  outcome: 'queued' | 'failed';
  jobId:   string | null;
  error:   string | null;
}

export async function produceProcessingJob(
  params: ProduceJobParams,
): Promise<ProduceJobResult> {
  const { backendSessionId, draftData, captureMethod, eventId, eventName, correlationId } = params;

  const op = logOperationStart('produceProcessingJob()', {
    backendSessionId,
    captureMethod,
    correlationId: correlationId ?? null,
  });

  const identity = await getAuthIdentity();
  if (!identity?.userId) {
    logOperationEnd(op, { error: new Error('Not authenticated') });
    return { outcome: 'failed', jobId: null, error: 'Not authenticated' };
  }

  // Guarantee the capture_sessions row exists before inserting into
  // processing_queue. routeSessionSync is fire-and-forget, so by the time
  // Save & Next fires the row may not yet be in the database. The FK
  // processing_queue_capture_session_id_fkey will reject the insert if the
  // parent row is missing, so we do an explicit awaited upsert here.
  const silentCbs = {
    onSyncing:   () => {},
    onSynced:    () => {},
    onSyncError: () => {},
    onOffline:   () => {},
  };
  logEvent('produceProcessingJob() — pre-enqueue syncUpsertSession', {
    backendSessionId,
    captureMethod: captureMethod ?? 'MANUAL',
  });
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
  console.log('[EVIDENCE_DIAG] PRODUCER_PRECHECK', {
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
  await evidenceManager.waitForUploads(backendSessionId);
  logEvent('produceProcessingJob() — evidence uploads complete', {
    backendSessionId,
    captureMethod,
  });

  const requiredAssetIds = captureMethod === 'BUSINESS_CARD'
    ? [draftData.cardFrontAssetId, draftData.cardBackAssetId].filter((id): id is string => Boolean(id))
    : [];
  if (requiredAssetIds.length > 0) {
    const assetsReady = await waitForAssetStorageReady(backendSessionId, requiredAssetIds);
    if (!assetsReady) {
      const error = 'Evidence upload did not complete; processing was not queued';
      logOperationEnd(op, { error: new Error(error) });
      return { outcome: 'failed', jobId: null, error };
    }
  }

  const jobId = crypto.randomUUID();

  logEvent('produceProcessingJob() — enqueueJob', {
    backendSessionId,
    captureMethod,
  }, { jobId });
  console.log('[EVIDENCE_DIAG] JOB_ENQUEUE', {
    ts: new Date().toISOString(),
    backendSessionId,
    jobId,
    captureMethod,
    requiredAssetIds,
  });
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

  if (!result.success) {
    logOperationEnd(op, { error: new Error(result.error ?? 'enqueue failed') });
    return { outcome: 'failed', jobId: null, error: result.error };
  }

  // Write a local completed_leads record so the Queue screen shows the lead
  // immediately. ALPE will update the backend; the local record tracks the
  // processing status.
  const lead = buildCompletedLead(
    backendSessionId, captureMethod, draftData,
    backendSessionId, eventId, eventName,
  );
  lead.status = 'pending_sync';
  await saveCompletedLead(lead);

  logOperationEnd(op, { extra: { jobId: result.jobId, outcome: 'queued' } });
  return { outcome: 'queued', jobId: result.jobId, error: null };
}
