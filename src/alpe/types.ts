// ALPE — Asynchronous Lead Processing Engine
//
// Public types for the processing queue and job lifecycle. These mirror the
// `processing_queue` Supabase table columns and the `ProcessingContext` shape
// that the pipeline stages consume.

// ─── Processing State ─────────────────────────────────────────────────────────

export type ProcessingState =
  | 'QUEUED'
  | 'PROCESSING'
  | 'COMPLETED'
  | 'REQUIRES_REVIEW'
  | 'INVALID'
  | 'FAILED'
  | 'RETRYING'
  | 'RECOVERING';

export type TerminalProcessingState =
  | 'COMPLETED'
  | 'REQUIRES_REVIEW'
  | 'INVALID'
  | 'FAILED';

export const TERMINAL_PROCESSING_STATES: ReadonlySet<TerminalProcessingState> = new Set([
  'COMPLETED',
  'REQUIRES_REVIEW',
  'INVALID',
  'FAILED',
]);

export function isTerminalState(state: ProcessingState): state is TerminalProcessingState {
  return TERMINAL_PROCESSING_STATES.has(state as TerminalProcessingState);
}

// ─── Pipeline Stage ───────────────────────────────────────────────────────────

export type PipelineStage =
  | 'LOAD_CONTEXT'
  | 'VERIFY_ASSETS'
  | 'UPLOAD_ASSETS'
  | 'EVIDENCE_RESOLUTION'
  | 'AI_EXTRACTION'
  | 'VALIDATION'
  | 'DECISION'
  | 'PROMOTION'
  | 'PERSIST_RESULTS'
  | 'COMPLETE';

export const PIPELINE_STAGE_ORDER: readonly PipelineStage[] = [
  'LOAD_CONTEXT',
  'VERIFY_ASSETS',
  'UPLOAD_ASSETS',
  'EVIDENCE_RESOLUTION',
  'AI_EXTRACTION',
  'VALIDATION',
  'DECISION',
  'PROMOTION',
  'PERSIST_RESULTS',
  'COMPLETE',
];

// ─── Queue Entry (row in processing_queue) ────────────────────────────────────

export interface QueueEntry {
  id:                    string;
  capture_session_id:    string;
  user_id:               string;
  event_id:              string | null;
  state:                 ProcessingState;
  priority:              number;
  processing_version:    number;
  enqueued_at:           string;
  scheduled_at:          string | null;
  processing_started_at: string | null;
  processing_completed_at: string | null;
  failure_reason:        string | null;
  retry_count:           number;
  recovery_count:        number;
  metadata:              Record<string, unknown>;
  updated_at:            string;
}

// ─── Processing Job (derived from a QueueEntry, enriched with context) ─────────

export interface ProcessingJob {
  jobId:             string;
  queueEntryId:      string;
  captureSessionId:  string;
  userId:            string;
  eventId:           string | null;
  processingState:   ProcessingState;
  priority:          number;
  enqueuedAt:        string;
  scheduledAt:       string | null;
  processingVersion: number;
}

// ─── Enqueue Input ─────────────────────────────────────────────────────────────

export interface EnqueueJobInput {
  /** Stable frontend-generated UUID for the job. */
  jobId:           string;
  /** FK to capture_sessions.id — the session to process. */
  captureSessionId: string;
  /** Authenticated user ID (filled by repository from auth session). */
  userId:          string;
  /** Optional FK to events.id. */
  eventId?:        string | null;
  /** Higher = sooner. Default 0. */
  priority?:       number;
  /** Schema version for the processing pipeline. Default 1. */
  processingVersion?: number;
  /** When to run (ISO). Null = immediately. */
  scheduledAt?:    string | null;
  /** Arbitrary metadata persisted with the job. */
  metadata?:       Record<string, unknown>;
}

// ─── Enqueue Result ───────────────────────────────────────────────────────────

export interface EnqueueResult {
  success:   boolean;
  jobId:     string | null;
  error:     string | null;
  queued:    boolean;
}
