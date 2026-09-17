// Recovery Service — runs before the scheduler begins polling. Restores
// interrupted jobs and resumes recoverable jobs so they re-enter the queue.
//
// Two categories:
//   1. Interrupted — jobs stuck in PROCESSING (app crashed/refreshed mid-job).
//      These are requeued back to QUEUED so the scheduler can re-claim them.
//   2. Retryable — jobs in RETRYING state (failed but within retry limits).
//      These are requeued back to QUEUED so the scheduler can re-attempt them.
//   3. Completed — terminal jobs reconcile local completed_leads after a
//      missed completion callback or page refresh.
//
// Fallback reconciliation: when a processing_queue row has been auto-deleted
// by the trg_delete_completed_queue trigger (migration 20260807212855), the
// queue-based reconciliation path finds nothing. The fallback queries
// capture_sessions.promoted_lead_id directly — if the session is promoted,
// the lead was successfully created regardless of whether a queue row exists.

import {
  findInterruptedJobs,
  findRetryableJobs,
  findCompletedJobs,
  requeueJob,
  markRecovering,
} from './processingQueueRepository';
import {
  loadCompletedLeads,
  getCompletedLead,
  updateCompletedLeadStatus,
} from '../capture/completedLeadsStorage';
import { supabase } from '../supabaseClient';
import { alpeLog, alpeError } from './diagnostics';


export interface RecoveryReport {
  interruptedRequeued: number;
  retryableRequeued:  number;
  reconciledSynced:   number;
  reconciliationFailures: number;
  totalRecovered:     number;
  errors:             string[];
}

export async function runRecovery(userId: string): Promise<RecoveryReport> {
  const report: RecoveryReport = {
    interruptedRequeued: 0,
    retryableRequeued:  0,
    reconciledSynced:  0,
    reconciliationFailures: 0,
    totalRecovered:    0,
    errors:            [],
  };

  // 1. Restore interrupted jobs (PROCESSING → QUEUED)
  try {
    const interrupted = await findInterruptedJobs(userId);
    for (const job of interrupted) {
      await markRecovering(job.id);
      await requeueJob(job.id);
      report.interruptedRequeued++;
      report.totalRecovered++;
    }
  } catch (err) {
    report.errors.push(`interrupted recovery failed: ${(err as Error).message}`);
  }

  // 2. Resume recoverable jobs (RETRYING → QUEUED)
  try {
    const retryable = await findRetryableJobs(userId);
    for (const job of retryable) {
      await requeueJob(job.id);
      report.retryableRequeued++;
      report.totalRecovered++;
    }
  } catch (err) {
    report.errors.push(`retryable recovery failed: ${(err as Error).message}`);
  }

  const reconciliation = await reconcileCompletedLeads(userId);
  report.reconciledSynced = reconciliation.synced;
  report.reconciliationFailures = reconciliation.failures;

  return report;
}

/**
 * Query capture_sessions for the given session IDs and return the set of
 * IDs that have a non-null promoted_lead_id. This is the authoritative
 * signal that a lead was successfully promoted, even when the
 * processing_queue row has been auto-deleted by the DB trigger.
 */
async function fetchPromotedSessionIds(
  userId: string,
  sessionIds: string[],
): Promise<Set<string>> {
  if (sessionIds.length === 0) return new Set();
  const promoted = new Set<string>();
  const { data, error } = await supabase
    .from('capture_sessions')
    .select('id, promoted_lead_id')
    .eq('user_id', userId)
    .in('id', sessionIds)
    .not('promoted_lead_id', 'is', null);

  if (error || !data) return promoted;
  for (const row of data) {
    if (row.promoted_lead_id) promoted.add(row.id as string);
  }
  return promoted;
}

export async function reconcileCompletedLeads(
  userId: string,
): Promise<{ synced: number; failures: number }> {
  const localLeads = await loadCompletedLeads();
  const pendingLeads = localLeads.filter(lead => lead.status !== 'synced');
  if (pendingLeads.length === 0) return { synced: 0, failures: 0 };

  // ── Path 1: processing_queue reconciliation (existing) ────────────────
  const completedJobs = await findCompletedJobs(userId);
  let synced = 0;
  let failures = 0;

  // Track which pending leads were matched by the queue path so the
  // fallback only processes the remaining unmatched ones.
  const matchedIds = new Set<string>();

  for (const job of completedJobs) {
    const localLead = pendingLeads.find(lead =>
      lead.backendSessionId === job.capture_session_id || lead.id === job.capture_session_id,
    );
    if (!localLead) {
      failures++;
      alpeError('RECONCILIATION_FAILURE', {
        jobId: job.id,
        captureSessionId: job.capture_session_id,
        serverState: job.state,
        reason: 'No matching local completed_leads record',
      });
      continue;
    }

    matchedIds.add(localLead.id);

    const identifiers = {
      jobId: job.id,
      captureSessionId: job.capture_session_id,
      localId: localLead.id,
      serverState: job.state,
    };
    const ok = await updateCompletedLeadStatus(localLead.id, 'synced', {
      syncedAt: job.processing_completed_at ?? new Date().toISOString(),
      lastError: null,
      failedStage: null,
      failedAt: null,
      isExhausted: false,
    });

    if (ok) {
      synced++;
      alpeLog('RECONCILIATION_SUCCESS', identifiers);
    } else {
      failures++;
      alpeError('RECONCILIATION_FAILURE', { ...identifiers, reason: 'IndexedDB write failed' });
    }
  }

  // ── Path 2: capture_sessions.promoted_lead_id fallback ────────────────
  // For leads not matched by the queue path (e.g. the processing_queue row
  // was auto-deleted by trg_delete_completed_queue), check whether the
  // capture session has been promoted. If promoted_lead_id is non-null, the
  // lead was successfully created and the local record should be synced.
  const unmatched = pendingLeads.filter(lead => !matchedIds.has(lead.id));
  if (unmatched.length > 0) {
    const sessionIds = unmatched
      .map(lead => lead.backendSessionId ?? lead.id)
      .filter((id): id is string => Boolean(id));

    const promotedIds = await fetchPromotedSessionIds(userId, sessionIds);

    for (const lead of unmatched) {
      const sessionId = lead.backendSessionId ?? lead.id;
      if (!sessionId || !promotedIds.has(sessionId)) continue;

      const ok = await updateCompletedLeadStatus(lead.id, 'synced', {
        syncedAt: new Date().toISOString(),
        lastError: null,
        failedStage: null,
        failedAt: null,
        isExhausted: false,
      });

      if (ok) {
        synced++;
        alpeLog('RECONCILIATION_SUCCESS_FALLBACK', {
          captureSessionId: sessionId,
          localId: lead.id,
          source: 'capture_sessions.promoted_lead_id',
        });
      } else {
        failures++;
        alpeError('RECONCILIATION_FAILURE', {
          captureSessionId: sessionId,
          localId: lead.id,
          source: 'capture_sessions.promoted_lead_id',
          reason: 'IndexedDB write failed',
        });
      }
    }
  }

  return { synced, failures };
}
