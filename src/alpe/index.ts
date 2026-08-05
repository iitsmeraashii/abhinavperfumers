// ALPE — Asynchronous Lead Processing Engine
//
// Public API surface. Only the modules needed for the feature-flag
// integration and scheduler lifecycle are exported here. The full pipeline
// will be wired in subsequent phases.

export { useAlpeProcessing } from './featureFlag';
export { produceProcessingJob } from './jobProducer';
export type { ProduceJobParams, ProduceJobResult } from './jobProducer';
export { enqueueJob, findJobBySession } from './processingQueueRepository';
export type {
  ProcessingState,
  TerminalProcessingState,
  PipelineStage,
  QueueEntry,
  ProcessingJob,
  EnqueueJobInput,
  EnqueueResult,
} from './types';
export { PIPELINE_STAGE_ORDER, isTerminalState } from './types';
export { runRecovery } from './recoveryService';
export type { RecoveryReport } from './recoveryService';
export { processJob } from './worker';
export type { WorkerResult } from './worker';
export { decide } from './decisionEngine';
export type { Decision } from './decisionEngine';
export { processCaptureSession } from './pipeline';
export type { ProcessingContext, ProcessingResult, ProcessingOutcome } from './pipeline';
export { scheduler, startScheduler, stopScheduler, getSchedulerState, notifyAlpeReconnect, notifyAlpeOffline } from './scheduler';
export type { SchedulerStatus, SchedulerState } from './scheduler';
export { useAlpeScheduler } from './useAlpeScheduler';
