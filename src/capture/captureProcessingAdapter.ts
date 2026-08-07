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

import { produceProcessingJob } from '../alpe';
import type { ProduceJobResult } from '../alpe';
import { enqueueOp } from './captureOfflineQueue';
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
}

// ─── Entry point ──────────────────────────────────────────────────────────────

/**
 * Submit a captured session for processing via ALPE. Never throws — errors
 * are surfaced as outcome 'failed' with an error message.
 */
export async function submitCaptureSession(params: SubmitParams): Promise<AdapterResult> {
  const { session, backendSessionId, eventId, eventName, isOnline, correlationId } = params;

  if (!isOnline) {
    await enqueueOp('enqueue_processing_job', backendSessionId, {
      backendSessionId,
      draftData:     session.draftData,
      captureMethod: session.originalCaptureMethod ?? session.captureMethod,
      eventId,
      eventName,
      correlationId,
    });
    return { outcome: 'queued', leadId: null, error: null, jobId: null };
  }

  const result: ProduceJobResult = await produceProcessingJob({
    backendSessionId,
    draftData:     session.draftData,
    captureMethod:  session.originalCaptureMethod ?? session.captureMethod,
    eventId,
    eventName,
    correlationId,
  });

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
