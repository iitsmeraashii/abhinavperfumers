import { reconnectTrace } from '../runtime/reconnectTimingTrace';
// ALPE Runtime Diagnostics — development-only live state store.
//
// Single in-memory snapshot that the scheduler, worker, pipeline, and
// repository update as they execute. The Queue Debug panel reads this
// snapshot to render the "ALPE Runtime" section.
//
// This module does NOT influence processing logic. It is purely observational.

export interface AlpeRuntimeState {
  // Scheduler
  schedulerStatus:      string;
  pollIntervalMs:       number;
  pollCount:            number;
  lastPollAt:           string | null;
  // Queue processing
  jobsFoundLastPoll:    number;
  jobsClaimedLastPoll:  number;
  currentJobId:         string | null;
  currentQueueState:    string | null;
  processingStartedAt:  string | null;
  // Worker
  workerState:           string | null;
  currentPipelineStage: string | null;
  currentCaptureProfile: string | null;
  queuePolicy:           string | null;
  // Errors
  lastSchedulerError:   string | null;
  lastWorkerError:      string | null;
}

const DEFAULT_STATE: AlpeRuntimeState = {
  schedulerStatus:      'stopped',
  pollIntervalMs:       5000,
  pollCount:            0,
  lastPollAt:           null,
  jobsFoundLastPoll:    0,
  jobsClaimedLastPoll:  0,
  currentJobId:         null,
  currentQueueState:    null,
  processingStartedAt:  null,
  workerState:           null,
  currentPipelineStage: null,
  currentCaptureProfile: null,
  queuePolicy:           null,
  lastSchedulerError:   null,
  lastWorkerError:      null,
};

let state: AlpeRuntimeState = { ...DEFAULT_STATE };
const listeners = new Set<() => void>();

export function getAlpeRuntimeState(): AlpeRuntimeState {
  return state;
}

export function updateAlpeRuntime(patch: Partial<AlpeRuntimeState>): void {
  state = { ...state, ...patch };
  listeners.forEach(fn => fn());
}

export function subscribeAlpeRuntime(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function resetAlpeRuntime(): void {
  state = { ...DEFAULT_STATE };
  listeners.forEach(fn => fn());
}

// ─── Console logger ──────────────────────────────────────────────────────────

import { isConsoleEnabled } from '../runtime/runtimeDiagnostics';

export function alpeLog(message: string, ...args: unknown[]): void {
  // Temporary timing bridge, independent of broad diagnostics flags. Never copy payloads.
  try {
    if (message === 'Worker start' || message === 'PROMOTION_SUCCESS') {
      const meta = args[0] as { captureSessionId?: string; jobId?: string } | undefined;
      reconnectTrace(message === 'Worker start' ? 'WORKER_START' : 'PROMOTION_SUCCESS', {
        sessionId: meta?.captureSessionId, jobId: meta?.jobId ?? meta?.captureSessionId,
      });
    }
  } catch { /* Timing instrumentation is non-blocking and non-throwing. */ }
  if (!isConsoleEnabled()) return;
  console.log('[ALPE]', message, ...args);
}

export function alpeError(message: string, ...args: unknown[]): void {
  if (!isConsoleEnabled()) return;
  console.error('[ALPE]', message, ...args);
}
