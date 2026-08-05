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

export function alpeLog(message: string, ...args: unknown[]): void {
  console.log('[ALPE]', message, ...args);
}

export function alpeError(message: string, ...args: unknown[]): void {
  console.error('[ALPE]', message, ...args);
}
