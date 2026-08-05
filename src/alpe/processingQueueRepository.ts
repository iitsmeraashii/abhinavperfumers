// Processing Queue Repository — sole reader/writer of the `processing_queue`
// Supabase table. Provides enqueue, claim, recovery queries, and state
// transitions for the scheduler.

import { supabase } from '../supabaseClient';
import type { EnqueueJobInput, EnqueueResult, ProcessingState, QueueEntry } from './types';
import { alpeLog, updateAlpeRuntime } from './diagnostics';

const TABLE = 'processing_queue';

// ─── Enqueue ──────────────────────────────────────────────────────────────────

export async function enqueueJob(input: EnqueueJobInput): Promise<EnqueueResult> {
  const {
    jobId,
    captureSessionId,
    userId,
    eventId = null,
    priority = 0,
    processingVersion = 1,
    scheduledAt = null,
    metadata = {},
  } = input;

  const now = new Date().toISOString();

  const row = {
    id:                    jobId,
    capture_session_id:    captureSessionId,
    user_id:               userId,
    event_id:              eventId,
    state:                 'QUEUED' as const,
    priority,
    processing_version:    processingVersion,
    enqueued_at:           now,
    scheduled_at:          scheduledAt,
    processing_started_at: null,
    processing_completed_at: null,
    failure_reason:        null,
    retry_count:           0,
    recovery_count:        0,
    metadata,
    updated_at:            now,
  };

  const { data, error } = await supabase
    .from(TABLE)
    .insert(row)
    .select()
    .maybeSingle();

  if (error) {
    return { success: false, jobId: null, error: error.message, queued: false };
  }

  return {
    success:   true,
    jobId:     (data as QueueEntry | null)?.id ?? jobId,
    error:     null,
    queued:    true,
  };
}

// ─── Lookup ───────────────────────────────────────────────────────────────────

export async function findJobBySession(
  captureSessionId: string,
): Promise<QueueEntry | null> {
  const { data, error } = await supabase
    .from(TABLE)
    .select('*')
    .eq('capture_session_id', captureSessionId)
    .maybeSingle();

  if (error || !data) return null;
  return data as QueueEntry;
}

// ─── Claim next job (atomic) ───────────────────────────────────────────────────
// Claims the highest-priority QUEUED job for this user by transitioning it to
// PROCESSING. Uses an RPC for atomicity so two scheduler instances can't grab
// the same job.

export async function claimNextJob(userId: string): Promise<QueueEntry | null> {
  alpeLog('claimNextJob() invocation', { userId });
  // Fetch the highest-priority QUEUED job for this user
  const { data: queued, error: qErr } = await supabase
    .from(TABLE)
    .select('*')
    .eq('user_id', userId)
    .eq('state', 'QUEUED')
    .order('priority', { ascending: false })
    .order('enqueued_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  const jobsFound = qErr ? 0 : (queued ? 1 : 0);
  updateAlpeRuntime({ jobsFoundLastPoll: jobsFound });

  if (qErr || !queued) {
    alpeLog('claimNextJob() result', { claimed: false, reason: qErr ? qErr.message : 'no queued jobs' });
    return null;
  }

  // Attempt atomic transition QUEUED → PROCESSING
  const now = new Date().toISOString();
  const { data: claimed, error: cErr } = await supabase
    .from(TABLE)
    .update({
      state: 'PROCESSING' as ProcessingState,
      processing_started_at: now,
      updated_at: now,
    })
    .eq('id', (queued as QueueEntry).id)
    .eq('state', 'QUEUED') // optimistic lock — only if still QUEUED
    .select('*')
    .maybeSingle();

  if (cErr || !claimed) {
    alpeLog('claimNextJob() result', { claimed: false, reason: cErr ? cErr.message : 'optimistic lock failed' });
    return null;
  }
  alpeLog('claimNextJob() result', { claimed: true, jobId: (claimed as QueueEntry).id });
  return claimed as QueueEntry;
}

// ─── Recovery queries ──────────────────────────────────────────────────────────

/** Jobs stuck in PROCESSING — interrupted by a crash/refresh before completing. */
export async function findInterruptedJobs(userId: string): Promise<QueueEntry[]> {
  const { data, error } = await supabase
    .from(TABLE)
    .select('*')
    .eq('user_id', userId)
    .eq('state', 'PROCESSING')
    .order('processing_started_at', { ascending: true });

  if (error || !data) return [];
  return data as QueueEntry[];
}

/** Jobs in RETRYING state — recoverable, waiting to be re-attempted. */
export async function findRetryableJobs(userId: string): Promise<QueueEntry[]> {
  const { data, error } = await supabase
    .from(TABLE)
    .select('*')
    .eq('user_id', userId)
    .eq('state', 'RETRYING')
    .order('updated_at', { ascending: true });

  if (error || !data) return [];
  return data as QueueEntry[];
}

// ─── State transitions ────────────────────────────────────────────────────────

export async function updateJobState(
  jobId: string,
  newState: ProcessingState,
  extra?: Partial<QueueEntry>,
): Promise<void> {
  const update: Record<string, unknown> = {
    state: newState,
    updated_at: new Date().toISOString(),
  };

  if (newState === 'COMPLETED' || newState === 'FAILED' ||
      newState === 'INVALID' || newState === 'REQUIRES_REVIEW') {
    update.processing_completed_at = new Date().toISOString();
  }

  if (extra) {
    if (extra.failure_reason !== undefined) update.failure_reason = extra.failure_reason;
    if (extra.metadata !== undefined) update.metadata = extra.metadata;
  }

  await supabase
    .from(TABLE)
    .update(update)
    .eq('id', jobId);
}

export async function markRetrying(
  jobId: string,
  failureReason: string,
): Promise<void> {
  const { error } = await supabase.rpc('increment_retry_count', { p_job_id: jobId });
  if (error) {
    // Fallback: manual update if RPC is unavailable
    await updateJobState(jobId, 'RETRYING', { failure_reason: failureReason });
    return;
  }
  await updateJobState(jobId, 'RETRYING', { failure_reason: failureReason });
}

export async function markRecovering(
  jobId: string,
): Promise<void> {
  const now = new Date().toISOString();
  await supabase
    .from(TABLE)
    .update({
      state: 'RECOVERING' as ProcessingState,
      processing_started_at: now,
      updated_at: now,
    })
    .eq('id', jobId);
}

export async function requeueJob(jobId: string): Promise<void> {
  const now = new Date().toISOString();
  await supabase
    .from(TABLE)
    .update({
      state: 'QUEUED' as ProcessingState,
      processing_started_at: null,
      updated_at: now,
    })
    .eq('id', jobId);
}
