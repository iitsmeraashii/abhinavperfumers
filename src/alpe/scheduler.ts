// ALPE Queue Scheduler — singleton that manages the polling lifecycle.
//
// Guarantees:
//   • Only one scheduler instance is active (singleton + running flag).
//   • Startup is idempotent (calling start() twice is a no-op).
//   • Shutdown is graceful (in-flight tick finishes, then stops).
//   • Recovery executes before polling begins.
//
// The scheduler polls processing_queue for QUEUED jobs belonging to the
// authenticated user, claims them atomically, and (for now) marks them as
// COMPLETED. The actual pipeline stages will be wired in a subsequent phase;
// this module establishes the lifecycle and polling infrastructure only.

import {
  claimNextJob,
  updateJobState,
  markRetrying,
} from './processingQueueRepository';
import { runRecovery } from './recoveryService';
import type { RecoveryReport } from './recoveryService';
import { processJob } from './worker';
import { decide } from './decisionEngine';
import { alpeLog, alpeError, updateAlpeRuntime } from './diagnostics';

const POLL_INTERVAL_MS = 5000;

export type SchedulerStatus = 'stopped' | 'starting' | 'running' | 'stopping';

export interface SchedulerState {
  status:        SchedulerStatus;
  pollCount:     number;
  jobsProcessed:  number;
  lastPollAt:     string | null;
  lastError:      string | null;
  recoveryReport: RecoveryReport | null;
}

class AlpeScheduler {
  private status: SchedulerStatus = 'stopped';
  private pollCount = 0;
  private jobsProcessed = 0;
  private lastPollAt: string | null = null;
  private lastError: string | null = null;
  private recoveryReport: RecoveryReport | null = null;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private inFlightTick = false;
  private userId: string | null = null;
  private isOnline = typeof navigator !== 'undefined' ? navigator.onLine : true;

  // ── Singleton guard ────────────────────────────────────────────────────────

  private static instance: AlpeScheduler | null = null;

  static getInstance(): AlpeScheduler {
    if (!AlpeScheduler.instance) {
      AlpeScheduler.instance = new AlpeScheduler();
    }
    return AlpeScheduler.instance;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  /** Start the scheduler. Idempotent — no-op if already running. */
  async start(userId: string): Promise<void> {
    if (this.status === 'running' || this.status === 'starting') {
      return;
    }

    this.status = 'starting';
    this.userId = userId;
    this.lastError = null;
    updateAlpeRuntime({ schedulerStatus: 'starting', pollIntervalMs: POLL_INTERVAL_MS });
    alpeLog('Scheduler start', { userId });

    // Recovery must complete before polling begins
    try {
      this.recoveryReport = await runRecovery(userId);
      alpeLog('Recovery complete', this.recoveryReport);
    } catch (err) {
      this.lastError = `Recovery failed: ${(err as Error).message}`;
      this.recoveryReport = {
        interruptedRequeued: 0,
        retryableRequeued: 0,
        totalRecovered: 0,
        errors: [this.lastError],
      };
      alpeError('Recovery failed', err);
      updateAlpeRuntime({ lastSchedulerError: this.lastError });
    }

    this.status = 'running';
    updateAlpeRuntime({ schedulerStatus: 'running' });
    this.scheduleNextPoll();
  }

  /**
   * Notify the scheduler that connectivity has returned. Triggers an
   * immediate poll so queued jobs are processed without waiting for the next
   * scheduled tick. Called by the Capture page after the offline queue flush
   * completes — ALPE jobs replayed from the offline queue are picked up.
   */
  notifyReconnect(): void {
    this.isOnline = true;
    if (this.status === 'running' && !this.inFlightTick) {
      this.tick().catch(() => {});
    }
  }

  /** Mark the scheduler as offline. Called when the browser goes offline. */
  notifyOffline(): void {
    this.isOnline = false;
  }

  /** Gracefully stop the scheduler. Waits for in-flight tick to finish. */
  async stop(): Promise<void> {
    if (this.status === 'stopped') return;

    this.status = 'stopping';
    updateAlpeRuntime({ schedulerStatus: 'stopping' });
    alpeLog('Scheduler stop');

    // Cancel the next scheduled poll
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }

    // Wait for in-flight tick to complete (non-blocking, max ~poll duration)
    const maxWait = 10000;
    const start = Date.now();
    while (this.inFlightTick && Date.now() - start < maxWait) {
      await new Promise(r => setTimeout(r, 50));
    }

    this.status = 'stopped';
    this.userId = null;
    updateAlpeRuntime({ schedulerStatus: 'stopped', currentJobId: null, currentQueueState: null, workerState: null, currentPipelineStage: null });
  }

  // ── Polling ─────────────────────────────────────────────────────────────────

  private scheduleNextPoll(): void {
    if (this.status !== 'running') return;
    this.pollTimer = setTimeout(() => {
      this.tick().finally(() => {
        if (this.status === 'running') {
          this.scheduleNextPoll();
        }
      });
    }, POLL_INTERVAL_MS);
  }

  private async tick(): Promise<void> {
    if (this.inFlightTick || this.status !== 'running' || !this.userId) return;
    // Skip polling when offline — Supabase queries would fail and waste cycles.
    // The scheduler resumes via notifyReconnect() when connectivity returns.
    if (!this.isOnline) return;

    this.inFlightTick = true;
    this.pollCount++;
    this.lastPollAt = new Date().toISOString();
    updateAlpeRuntime({ pollCount: this.pollCount, lastPollAt: this.lastPollAt, jobsFoundLastPoll: 0, jobsClaimedLastPoll: 0 });
    alpeLog('Scheduler poll', { pollCount: this.pollCount });

    try {
      const job = await claimNextJob(this.userId);

      if (!job) {
        updateAlpeRuntime({ currentJobId: null, currentQueueState: null, processingStartedAt: null });
        return;
      }

      updateAlpeRuntime({
        currentJobId: job.id,
        currentQueueState: job.state,
        processingStartedAt: job.processing_started_at,
        jobsClaimedLastPoll: 1,
      });

      // Run the full pipeline: Queue → Worker → Pipeline → Decision → Promotion → Completion
      const workerResult = await processJob(job);
      alpeLog('Worker result', workerResult);

      const decision = decide(workerResult);
      alpeLog('Decision', decision);

      if (decision.newState === 'RETRYING' && decision.isRetryable) {
        await markRetrying(job.id, decision.failureReason ?? 'Retryable failure');
      } else {
        await updateJobState(job.id, decision.newState, {
          failure_reason: decision.failureReason,
        });
      }

      if (decision.newState === 'COMPLETED' || decision.newState === 'REQUIRES_REVIEW') {
        this.jobsProcessed++;
        alpeLog('Queue completion', { jobId: job.id, newState: decision.newState, jobsProcessed: this.jobsProcessed });
      }

      updateAlpeRuntime({ currentJobId: null, currentQueueState: null, processingStartedAt: null, workerState: null, currentPipelineStage: null });
    } catch (err) {
      this.lastError = `Poll error: ${(err as Error).message}`;
      alpeError('Scheduler poll error', err);
      updateAlpeRuntime({ lastSchedulerError: this.lastError, currentJobId: null, currentQueueState: null, processingStartedAt: null, workerState: null, currentPipelineStage: null });
    } finally {
      this.inFlightTick = false;
    }
  }

  // ── State inspection ───────────────────────────────────────────────────────

  getState(): SchedulerState {
    return {
      status: this.status,
      pollCount: this.pollCount,
      jobsProcessed: this.jobsProcessed,
      lastPollAt: this.lastPollAt,
      lastError: this.lastError,
      recoveryReport: this.recoveryReport,
    };
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

export const scheduler = AlpeScheduler.getInstance();

export async function startScheduler(userId: string): Promise<void> {
  await scheduler.start(userId);
}

export async function stopScheduler(): Promise<void> {
  await scheduler.stop();
}

export function getSchedulerState(): SchedulerState {
  return scheduler.getState();
}

export function notifyAlpeReconnect(): void {
  scheduler.notifyReconnect();
}

export function notifyAlpeOffline(): void {
  scheduler.notifyOffline();
}
