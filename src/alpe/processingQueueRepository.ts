// Processing Queue Repository — sole reader/writer of the `processing_queue`
// Supabase table. Provides enqueue, claim, recovery queries, and state
// transitions for the scheduler.

import { supabase } from '../supabaseClient';
import type { EnqueueJobInput, EnqueueResult, ProcessingState, QueueEntry } from './types';
import { MAX_RETRY_COUNT, isRetryEligible } from './types';
import { alpeLog, updateAlpeRuntime } from './diagnostics';
import { logOperationStart, logOperationEnd, logEvent, getCorrelationId } from '../capture/assetSyncDiagnostics';

const TABLE = 'processing_queue';

// ─── Enqueue ──────────────────────────────────────────────────────────────────

export async function enqueueJob(input: EnqueueJobInput): Promise<EnqueueResult> {
  const metaCorrId = (input.metadata as Record<string, unknown> | undefined)?.correlationId ?? null;
  const corrId = (typeof metaCorrId === 'string' ? metaCorrId : null) ?? getCorrelationId() ?? 'no_correlation';

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

  const ctx = {
    backendSessionId: captureSessionId,
    correlationId:   corrId,
  };

  const op = logOperationStart('capture_assets repository insert/upsert — enqueueJob()', ctx);

  logEvent('enqueueJob() — entry', ctx, { corrId, jobId, captureSessionId, userId, eventId });

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

  logEvent('enqueueJob() — row built', ctx, { corrId, rowId: row.id, rowState: row.state });

  // ── Step: processing_queue insert ─────────────────────────────────────────
  logEvent('enqueueJob() — awaiting processing_queue insert', ctx, { corrId });
  const { data, error, count } = await supabase
    .from(TABLE)
    .insert(row)
    .select()
    .maybeSingle();
  logEvent('enqueueJob() — processing_queue insert resolved', ctx, {
    corrId,
    data: data ?? null,
    dataIsNull: data === null,
    dataIsUndefined: data === undefined,
    error: error ? { code: error.code, message: error.message, details: error.details, hint: error.hint, constraint: error.constraint } : null,
    count: count ?? null,
  });

  if (error) {
    logEvent('enqueueJob() — insert returned error', ctx, {
      corrId,
      error: { code: error.code, message: error.message, details: error.details, hint: error.hint, constraint: error.constraint, status: (error as Record<string, unknown>).status ?? null },
      operation: 'enqueueJob',
    });
    logOperationEnd(op, { payload: row, error, rowsAffected: 0 });
    return { success: false, jobId: null, error: error.message, queued: false };
  }

  // Explicitly log if data resolved to null/undefined/empty
  if (data === null || data === undefined) {
    logEvent('enqueueJob() — insert resolved with null/undefined data', ctx, {
      corrId, dataIsNull: data === null, dataIsUndefined: data === undefined,
    });
  }
  if (count === 0) {
    logEvent('enqueueJob() — insert resolved with zero rows affected', ctx, { corrId, count });
  }

  logOperationEnd(op, {
    payload:          row,
    rowsAffected:     count ?? 1,
    createdRowId:     (data as QueueEntry | null)?.id ?? jobId,
    dbResponse:       data,
  });

  logEvent('enqueueJob() — returning success', ctx, { corrId, jobId: (data as QueueEntry | null)?.id ?? jobId });

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
  // Fetch QUEUED and RETRYING jobs for this user, ordered by priority then age.
  // RETRYING jobs are only eligible if retry_count < MAX_RETRY_COUNT.
  const { data: candidates, error: qErr } = await supabase
    .from(TABLE)
    .select('*')
    .eq('user_id', userId)
    .in('state', ['QUEUED', 'RETRYING'])
    .order('priority', { ascending: false })
    .order('enqueued_at', { ascending: true });

  const allJobs = qErr ? [] : ((candidates ?? []) as QueueEntry[]);
  // Filter out exhausted RETRYING jobs (retry_count >= MAX_RETRY_COUNT)
  const eligible = allJobs.filter(j =>
    j.state === 'QUEUED' || (j.state === 'RETRYING' && isRetryEligible(j.retry_count)),
  );

  const jobsFound = eligible.length;
  updateAlpeRuntime({ jobsFoundLastPoll: jobsFound });

  if (qErr || eligible.length === 0) {
    alpeLog('claimNextJob() result', { claimed: false, reason: qErr ? qErr.message : 'no eligible jobs' });
    return null;
  }

  const job = eligible[0];

  // Attempt atomic transition → PROCESSING
  const now = new Date().toISOString();
  const { data: claimed, error: cErr } = await supabase
    .from(TABLE)
    .update({
      state: 'PROCESSING' as ProcessingState,
      processing_started_at: now,
      last_attempt_at: now,
      updated_at: now,
    })
    .eq('id', job.id)
    .in('state', ['QUEUED', 'RETRYING']) // optimistic lock
    .select('*')
    .maybeSingle();

  if (cErr || !claimed) {
    alpeLog('claimNextJob() result', { claimed: false, reason: cErr ? cErr.message : 'optimistic lock failed' });
    return null;
  }
  alpeLog('claimNextJob() result', { claimed: true, jobId: (claimed as QueueEntry).id, retryCount: (claimed as QueueEntry).retry_count });
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

/** Jobs in RETRYING state — recoverable, waiting to be re-attempted.
 *  Only returns jobs within the retry limit (retry_count < MAX_RETRY_COUNT). */
export async function findRetryableJobs(userId: string): Promise<QueueEntry[]> {
  const { data, error } = await supabase
    .from(TABLE)
    .select('*')
    .eq('user_id', userId)
    .eq('state', 'RETRYING')
    .lt('retry_count', MAX_RETRY_COUNT)
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

  if (newState === 'FAILED') {
    update.failed_at = new Date().toISOString();
  }

  if (extra) {
    if (extra.failure_reason !== undefined) update.failure_reason = extra.failure_reason;
    if (extra.metadata !== undefined) update.metadata = extra.metadata;
    if (extra.failed_stage !== undefined) update.failed_stage = extra.failed_stage;
    if (extra.error_message !== undefined) update.error_message = extra.error_message;
    if (extra.error_code !== undefined) update.error_code = extra.error_code;
  }

  await supabase
    .from(TABLE)
    .update(update)
    .eq('id', jobId);
}

export async function markRetrying(
  jobId: string,
  failureReason: string,
  failedStage: string | null = null,
  errorMessage: string | null = null,
): Promise<void> {
  const { error } = await supabase.rpc('increment_retry_count', {
    p_job_id: jobId,
    p_failure_reason: failureReason,
    p_failed_stage: failedStage,
    p_error_message: errorMessage ?? failureReason,
  });
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
