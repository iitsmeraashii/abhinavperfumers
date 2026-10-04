// TEMPORARY: local-only reconnect timing. Remove this module and trace call sites after diagnosis.
const LIMIT = 2000;
const events = new Set(['TRANSPORT_ONLINE', 'AUTH_REVALIDATION_START', 'AUTH_REVALIDATION_END',
  'AUTH_REVALIDATION_FAILED', 'AUTH_ONLINE', 'FLUSH_INVOKED', 'FLUSH_SKIPPED', 'FLUSH_START',
  'FLUSH_SNAPSHOT', 'OP_START', 'OP_END', 'ENQUEUE_PHASE_REACHED', 'FLUSH_END',
  'ENQUEUE_JOB_START', 'JOB_ACK', 'RECOVERY_START', 'RECOVERY_END', 'POLL_SCHEDULED',
  'WAKE_REQUESTED', 'WAKE_ACCEPTED', 'WAKE_IGNORED', 'TICK_START', 'TICK_END',
  'CLAIM_START', 'CLAIM_END', 'WORKER_START', 'PROMOTION_SUCCESS']);
const codes = new Set(['offline', 'auth_restricted', 'locked', 'no_owner', 'empty', 'running',
  'starting', 'stopped', 'stopping', 'busy', 'completed', 'failed', 'inserted',
  'duplicate_recognized', 'claimed', 'not_claimed', 'stale', 'online', 'restricted', 'deferred']);
const types = new Set(['upsert_session', 'upsert_asset', 'upsert_ocr_extraction', 'upsert_qr_extraction',
  'upsert_vision_extraction', 'update_session_fields', 'promote_session', 'upload_voice_note',
  'upload_notes_image', 'upload_business_card', 'enqueue_processing_job']);
const countKeys = new Set(['total', 'sessions', 'prerequisites', 'enqueue', 'remaining', 'flushed',
  'delayMs', 'dueElapsedMs', 'pollCount']);
export type TraceContext = { runId: string } | null;
type Metadata = Partial<Record<'authAttemptId' | 'flushId' | 'tickId' | 'sessionId' | 'jobId' |
  'opId' | 'opType' | 'outcome' | 'reason', string | null>> & { counts?: Record<string, number> };
type Entry = Metadata & { runId: string; sequence: number; timestamp: string; elapsedMs: number; event: string };
let enabled = false, runId = '', start = 0, sequence = 0, idCounter = 0, runCounter = 0;
let buffer: Entry[] = [];
const now = () => performance.now();
function reset() {
  try { start = now(); runId = `run-${Date.now()}-${++runCounter}`; sequence = 0; buffer = []; }
  catch { enabled = false; buffer = []; }
}
export function traceContext(): TraceContext {
  try { return enabled ? { runId } : null; } catch { return null; }
}
export function traceId(prefix: 'auth' | 'flush' | 'tick'): string {
  return `${prefix}-${++idCounter}`;
}
export function traceElapsed(): number {
  try { return enabled ? now() - start : 0; } catch { return 0; }
}
export function reconnectTrace(event: string, metadata: Metadata = {}, context: TraceContext = traceContext()): void {
  try {
    if (!enabled || !context || context.runId !== runId || !events.has(event)) return;
    const entry: Entry = { runId, sequence: sequence + 1, timestamp: new Date().toISOString(),
      elapsedMs: Math.round((now() - start) * 1000) / 1000, event };
    // Never spread caller objects: accept only bounded identifiers and enumerated codes.
    for (const key of ['authAttemptId', 'flushId', 'tickId', 'sessionId', 'jobId', 'opId'] as const) {
      const value = metadata[key];
      if (typeof value === 'string' && /^[a-zA-Z0-9_-]{1,160}$/.test(value)) entry[key] = value;
    }
    for (const key of ['outcome', 'reason'] as const) {
      const value = metadata[key];
      if (value && codes.has(value)) entry[key] = value;
    }
    if (metadata.opType && types.has(metadata.opType)) entry.opType = metadata.opType;
    if (metadata.counts) {
      const counts: Record<string, number> = {};
      for (const key of countKeys) {
        const value = metadata.counts[key];
        if (typeof value === 'number' && Number.isFinite(value) && value >= 0) counts[key] = value;
      }
      entry.counts = counts;
    }
    sequence++;
    buffer.push(entry);
    if (buffer.length > LIMIT) buffer.shift();
  } catch { /* Diagnostics must not affect application control flow. */ }
}
const api = Object.freeze({
  enable() { enabled = true; reset(); return runId; },
  clear() { reset(); return runId; },
  disable() { enabled = false; },
  get(): Entry[] { try { return JSON.parse(JSON.stringify(buffer)); } catch { return []; } },
});
// Browser-only, no persisted opt-in and no remote diagnostic configuration changes.
try {
  if (typeof window !== 'undefined') Object.defineProperty(window, '__reconnectTimingTrace', { value: api, configurable: true });
} catch { /* A locked-down host may reject the optional console API. */ }
export const reconnectTimingTrace = api;
