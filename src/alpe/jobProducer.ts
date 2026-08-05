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
import type { CaptureMethod, DraftData } from '../capture/types';
import { enqueueJob } from './processingQueueRepository';
import type { EnqueueResult } from './types';

export interface ProduceJobParams {
  backendSessionId: string;
  draftData:        DraftData;
  captureMethod:    CaptureMethod | null;
  eventId:          string | null;
  eventName:        string | null;
}

export interface ProduceJobResult {
  outcome: 'queued' | 'failed';
  jobId:   string | null;
  error:   string | null;
}

export async function produceProcessingJob(
  params: ProduceJobParams,
): Promise<ProduceJobResult> {
  const { backendSessionId, draftData, captureMethod, eventId, eventName } = params;

  const identity = await getAuthIdentity();
  if (!identity?.userId) {
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
  await syncUpsertSession(
    {
      sessionId:     backendSessionId,
      captureMethod: captureMethod ?? 'MANUAL',
      draftData,
      sessionStatus: 'CAPTURING',
      eventId,
    },
    silentCbs,
  );

  const jobId = crypto.randomUUID();

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
    },
  });

  if (!result.success) {
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

  return { outcome: 'queued', jobId: result.jobId, error: null };
}
