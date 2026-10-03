// Capture Processing Adapter — the single delegation point that routes
// Save & Next processing to the ALPE asynchronous pipeline.
//
// All processing responsibilities — extraction, validation, review, decision,
// and promotion — are delegated to ALPE via produceProcessingJob. The adapter
// handles the offline case by enqueuing a deferred job op to the offline queue,
// reusing the existing synchronization infrastructure.
//
// Capture retains: capture UX, local persistence, session creation, evidence
// collection, and sync routing. All processing is delegated through this
// adapter so the UI never branches on the processing mode.

import { produceProcessingJob } from '../alpe/jobProducer';
import type { ProduceJobResult } from '../alpe/jobProducer';
import { evidenceManager } from './captureEvidenceManager';
import { enqueueProcessingCapture } from './captureOfflineQueue';
import { isCloudSyncAllowed } from '../authModeState';
import type { CaptureSession } from './types';

// ─── Adapter result ──────────────────────────────────────────────────────────

export type AdapterOutcome = 'queued' | 'failed' | 'submitted';

export interface AdapterResult {
  outcome:    AdapterOutcome;
  leadId:     string | null;
  error:      string | null;
  jobId:      string | null;
}

// ─── Submit params ────────────────────────────────────────────────────────────

export interface SubmitParams {
  session:           CaptureSession;
  backendSessionId:  string;
  eventCode:         string | null;
  eventId:          string | null;
  eventName:        string | null;
  plan:              unknown | null;
  isOnline:          boolean;
  correlationId?:   string | null;
  ownerId?:         string | null;
}

// Only transport failures qualify; validation/authorization errors stay visible.
function isTransportFailure(message: string | null | undefined): boolean {
  return /^(?:TypeError:\s*)?(?:Failed to fetch|Load failed|Network request failed|NetworkError when attempting to fetch resource\.?)$/i.test(message ?? '');
}

// ─── Entry point ──────────────────────────────────────────────────────────────

/**
 * Submit a captured session for processing via ALPE. Persistence failures reject;
 * processing failures are surfaced as outcome 'failed' with an error message.
 */
export async function submitCaptureSession(params: SubmitParams): Promise<AdapterResult> {
  const { session, backendSessionId, eventId, eventName, isOnline, correlationId, ownerId } = params;

  const cardIds = [session.draftData.cardFrontAssetId, session.draftData.cardBackAssetId]
    .filter((id): id is string => Boolean(id));
  await evidenceManager.prepareForSubmission(backendSessionId, cardIds, ownerId);

  const queueProcessing = async (): Promise<AdapterResult> => {
    if (!ownerId) throw new Error('Cannot queue capture without its owner');
    await enqueueProcessingCapture(backendSessionId, {
      backendSessionId,
      draftData:     session.draftData,
      captureMethod: session.originalCaptureMethod ?? session.captureMethod,
      eventId,
      eventName,
      correlationId,
    }, ownerId ?? null);
    return { outcome: 'queued', leadId: null, error: null, jobId: null };
  };

  if (!isOnline || !isCloudSyncAllowed()) return queueProcessing();

  let result: ProduceJobResult;
  try {
  result = await produceProcessingJob({
    backendSessionId,
    draftData:     session.draftData,
    captureMethod:  session.originalCaptureMethod ?? session.captureMethod,
    eventId,
    eventName,
    correlationId,
    ownerId:       ownerId ?? null,
  });
  } catch (error) {
    if (error instanceof Error && isTransportFailure(error.message)) return queueProcessing();
    throw error;
  }

  if ((result.outcome === 'failed' && (result.error === 'Evidence upload did not complete; processing was not queued' || isTransportFailure(result.error))) ||
      (result.outcome === 'queued' && !result.jobId)) {
    return queueProcessing();
  }

  if (result.outcome === 'failed') {
    return {
      outcome: 'failed',
      leadId:  null,
      error:   result.error ?? 'Failed to enqueue processing job',
      jobId:   null,
    };
  }

  return { outcome: 'submitted', leadId: null, error: null, jobId: result.jobId };
}

// ─── Convenience: re-export capture-time event handlers ──────────────────────
// Evidence collection, extraction handlers, and session reset remain in Capture
// (they are not "processing"). Re-export them so the UI imports from one module.

export {
  registerCardEvidence,
  registerVoiceNoteEvidence,
  notifySessionReset,
  handleVisionExtraction,
  handleOcrExtraction,
  handleQrExtraction,
} from './captureEventHandlers';
