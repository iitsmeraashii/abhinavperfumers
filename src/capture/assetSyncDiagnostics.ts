// Asset Sync Diagnostics — instrumentation-only module for capturing the
// exact runtime behavior of the business card asset persistence path.
//
// This module does NOT change any application behavior. It only:
//   1. Generates a unique correlationId per capture journey
//   2. Logs structured entries to the browser console ([ALPE][ASSET_SYNC])
//   3. Persists entries to the alpe_runtime_dumps Supabase table
//
// Every log entry includes:
//   - correlationId, backendSessionId, localSessionId, captureMethod
//   - assetType, assetSide, localAssetId
//   - operation name, startedAt, endedAt, perfNow, durationMs
//   - For DB ops: payload, sessionExistsBefore, dbResponse, rowsAffected, createdRowId
//   - For failures: complete error object (code, message, details, hint,
//     constraint, status, stack) and failureSource classification

import { supabase } from '../supabaseClient';

const TAG = '[ALPE][ASSET_SYNC]';

// ─── Correlation ID ─────────────────────────────────────────────────────────

let _correlationId: string | null = null;

export function startCorrelation(): string {
  _correlationId = `corr_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  console.log(TAG, 'correlationId started:', _correlationId);
  return _correlationId;
}

export function getCorrelationId(): string | null {
  return _correlationId;
}

export function clearCorrelation(): void {
  console.log(TAG, 'correlationId cleared:', _correlationId);
  _correlationId = null;
}

// ─── Types ──────────────────────────────────────────────────────────────────

export interface AssetSyncLogContext {
  backendSessionId?: string | null;
  localSessionId?:   string | null;
  captureMethod?:    string | null;
  assetType?:        string | null;
  assetSide?:        string | null;
  localAssetId?:     string | null;
}

export interface AssetSyncLogEntry {
  correlationId:   string;
  operation:       string;
  startedAt:      string;  // ISO timestamp
  endedAt:        string | null;  // ISO timestamp
  perfNow:        number;   // performance.now() at start
  perfEnd:       number | null; // performance.now() at end
  durationMs:     number | null;
  // Context
  backendSessionId: string | null;
  localSessionId:   string | null;
  captureMethod:    string | null;
  assetType:        string | null;
  assetSide:        string | null;
  localAssetId:     string | null;
  // DB operation details
  payload?:          unknown;
  sessionExistsBefore?: boolean | null;
  dbResponse?:       unknown;
  rowsAffected?:     number | null;
  createdRowId?:     string | null;
  // Error details (complete, unmodified)
  error?: {
    code:       string | null;
    message:    string | null;
    details:    unknown;
    hint:       string | null;
    constraint: string | null;
    status:     number | null;
    stack:      string | null;
  } | null;
  failureSource?: FailureSource | null;
  // Extra metadata
  extra?: Record<string, unknown>;
}

export type FailureSource =
  | 'Storage Upload'
  | 'Signed URL'
  | 'Session Upsert'
  | 'Asset Upsert'
  | 'FK Constraint'
  | 'RLS'
  | 'Network'
  | 'Timeout'
  | 'Unknown';

// ─── Error extraction ───────────────────────────────────────────────────────

function extractError(err: unknown): NonNullable<AssetSyncLogEntry['error']> {
  if (err && typeof err === 'object') {
    const e = err as Record<string, unknown>;
    return {
      code:       typeof e.code === 'string' ? e.code : null,
      message:    typeof e.message === 'string' ? e.message : String(err),
      details:    e.details ?? null,
      hint:       typeof e.hint === 'string' ? e.hint : null,
      constraint: typeof e.constraint === 'string' ? e.constraint : null,
      status:     typeof e.status === 'number' ? e.status : null,
      stack:      typeof e.stack === 'string' ? e.stack : null,
    };
  }
  return {
    code: null, message: String(err), details: null, hint: null,
    constraint: null, status: null, stack: null,
  };
}

function classifyError(err: unknown, operation: string): FailureSource {
  if (!err) return 'Unknown';
  const e = err as Record<string, unknown>;
  const msg = typeof e.message === 'string' ? e.message.toLowerCase() : '';
  const code = typeof e.code === 'string' ? e.code.toLowerCase() : '';
  const constraint = typeof e.constraint === 'string' ? e.constraint.toLowerCase() : '';

  if (constraint.includes('fkey') || constraint.includes('foreign') || msg.includes('foreign key')) return 'FK Constraint';
  if (msg.includes('row-level security') || msg.includes('rls') || msg.includes('policy')) return 'RLS';
  if (operation.includes('Storage') || operation.includes('upload')) return 'Storage Upload';
  if (operation.includes('Session')) return 'Session Upsert';
  if (operation.includes('Asset')) return 'Asset Upsert';
  if (msg.includes('timeout') || msg.includes('aborted')) return 'Timeout';
  if (msg.includes('network') || msg.includes('fetch') || code.includes('network')) return 'Network';
  if (msg.includes('signed url') || msg.includes('signed')) return 'Signed URL';
  return 'Unknown';
}

// ─── Persistence to alpe_runtime_dumps ──────────────────────────────────────

async function persistToDumps(entry: AssetSyncLogEntry): Promise<void> {
  try {
    await supabase
      .from('alpe_runtime_dumps')
      .insert({
        id:          `dump_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        job_id:      entry.backendSessionId ?? entry.correlationId,
        dump_point:  `ASSET_SYNC:${entry.operation}`,
        dump_data:   entry as unknown as Record<string, unknown>,
      });
  } catch {
    // Swallow — diagnostics must never break the app
  }
}

// ─── Logging API ────────────────────────────────────────────────────────────

/**
 * Log a started operation. Returns a handle that should be passed to
 * `logOperationEnd` when the operation completes.
 */
export function logOperationStart(
  operation:    string,
  context:      AssetSyncLogContext,
  extra?:       Record<string, unknown>,
): AssetSyncLogEntry {
  const corrId = _correlationId ?? 'no_correlation';
  const now = new Date().toISOString();
  const perf = typeof performance !== 'undefined' ? performance.now() : Date.now();

  const entry: AssetSyncLogEntry = {
    correlationId:     corrId,
    operation,
    startedAt:         now,
    endedAt:           null,
    perfNow:           perf,
    perfEnd:            null,
    durationMs:         null,
    backendSessionId:  context.backendSessionId ?? null,
    localSessionId:    context.localSessionId ?? null,
    captureMethod:     context.captureMethod ?? null,
    assetType:         context.assetType ?? null,
    assetSide:         context.assetSide ?? null,
    localAssetId:      context.localAssetId ?? null,
    extra,
  };

  console.log(TAG, `[START] ${operation}`, {
    correlationId:     corrId,
    backendSessionId:  entry.backendSessionId,
    localSessionId:    entry.localSessionId,
    captureMethod:     entry.captureMethod,
    assetType:         entry.assetType,
    assetSide:         entry.assetSide,
    localAssetId:      entry.localAssetId,
    startedAt:         now,
    perfNow:           perf,
    ...extra,
  });

  persistToDumps(entry);
  return entry;
}

/**
 * Log the completion of an operation. Takes the entry returned by
 * `logOperationStart` and fills in end timestamps + result data.
 */
export function logOperationEnd(
  entry:    AssetSyncLogEntry,
  result:   {
    dbResponse?:      unknown;
    rowsAffected?:    number | null;
    createdRowId?:    string | null;
    sessionExistsBefore?: boolean | null;
    payload?:         unknown;
    error?:           unknown;
    extra?:           Record<string, unknown>;
  } = {},
): AssetSyncLogEntry {
  const now = new Date().toISOString();
  const perfEnd = typeof performance !== 'undefined' ? performance.now() : Date.now();

  entry.endedAt  = now;
  entry.perfEnd = perfEnd;
  entry.durationMs = Math.round((perfEnd - entry.perfNow) * 1000) / 1000;

  if (result.payload !== undefined)      entry.payload = result.payload;
  if (result.dbResponse !== undefined)  entry.dbResponse = result.dbResponse;
  if (result.rowsAffected !== undefined) entry.rowsAffected = result.rowsAffected;
  if (result.createdRowId !== undefined) entry.createdRowId = result.createdRowId;
  if (result.sessionExistsBefore !== undefined) entry.sessionExistsBefore = result.sessionExistsBefore;
  if (result.extra) entry.extra = { ...entry.extra, ...result.extra };

  if (result.error) {
    entry.error = extractError(result.error);
    entry.failureSource = classifyError(result.error, entry.operation);
    console.error(TAG, `[FAIL] ${entry.operation}`, {
      correlationId:   entry.correlationId,
      durationMs:       entry.durationMs,
      error:           entry.error,
      failureSource:  entry.failureSource,
      backendSessionId: entry.backendSessionId,
      localAssetId:    entry.localAssetId,
    });
  } else {
    console.log(TAG, `[END] ${entry.operation}`, {
      correlationId:      entry.correlationId,
      durationMs:          entry.durationMs,
      rowsAffected:        entry.rowsAffected,
      createdRowId:        entry.createdRowId,
      sessionExistsBefore: entry.sessionExistsBefore,
      backendSessionId:   entry.backendSessionId,
      localAssetId:       entry.localAssetId,
    });
  }

  persistToDumps(entry);
  return entry;
}

/**
 * Log a simple point-in-time event (no start/end pair).
 */
export function logEvent(
  operation:    string,
  context:      AssetSyncLogContext,
  extra?:       Record<string, unknown>,
): void {
  const corrId = _correlationId ?? 'no_correlation';
  const now = new Date().toISOString();
  const perf = typeof performance !== 'undefined' ? performance.now() : Date.now();

  const entry: AssetSyncLogEntry = {
    correlationId:     corrId,
    operation,
    startedAt:         now,
    endedAt:           now,
    perfNow:           perf,
    perfEnd:            perf,
    durationMs:         0,
    backendSessionId:  context.backendSessionId ?? null,
    localSessionId:    context.localSessionId ?? null,
    captureMethod:     context.captureMethod ?? null,
    assetType:         context.assetType ?? null,
    assetSide:         context.assetSide ?? null,
    localAssetId:      context.localAssetId ?? null,
    extra,
  };

  console.log(TAG, `[EVENT] ${operation}`, {
    correlationId:     corrId,
    backendSessionId:  entry.backendSessionId,
    localSessionId:    entry.localSessionId,
    captureMethod:     entry.captureMethod,
    assetType:         entry.assetType,
    assetSide:         entry.assetSide,
    localAssetId:      entry.localAssetId,
    timestamp:         now,
    perfNow:           perf,
    ...extra,
  });

  persistToDumps(entry);
}
