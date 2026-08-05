// Recovery Service — runs before the scheduler begins polling. Restores
// interrupted jobs and resumes recoverable jobs so they re-enter the queue.
//
// Two categories:
//   1. Interrupted — jobs stuck in PROCESSING (app crashed/refreshed mid-job).
//      These are requeued back to QUEUED so the scheduler can re-claim them.
//   2. Retryable — jobs in RETRYING state (failed but within retry limits).
//      These are requeued back to QUEUED so the scheduler can re-attempt them.

import {
  findInterruptedJobs,
  findRetryableJobs,
  requeueJob,
  markRecovering,
} from './processingQueueRepository';


export interface RecoveryReport {
  interruptedRequeued: number;
  retryableRequeued:  number;
  totalRecovered:     number;
  errors:             string[];
}

export async function runRecovery(userId: string): Promise<RecoveryReport> {
  const report: RecoveryReport = {
    interruptedRequeued: 0,
    retryableRequeued:  0,
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

  return report;
}
