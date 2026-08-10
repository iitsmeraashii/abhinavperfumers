// Offline sync queue — persists pending backend operations to IndexedDB.
// On reconnect, all queued ops are flushed in creation order.
//
// Design:
//   - Each op is idempotent (upsert with stable frontend IDs)
//   - Ops survive page reloads
//   - Flush retries with exponential backoff on error
//   - Completed ops are removed from the queue
//   - The queue is per-device (not shared across tabs — that's fine)

import { dbPut, dbDelete, dbGetAllInStore } from './db';
import {
  syncUpsertSession,
  syncUpsertAsset,
  syncUpsertOcrExtraction,
  syncUpsertQrExtraction,
  syncUpdateSessionFields,
  syncUpsertVisionExtraction,
  syncPromoteSession,
} from './captureBackendSync';
import type {
  UpsertSessionPayload,
  UpsertAssetPayload,
  UpsertOcrExtractionPayload,
  UpsertQrExtractionPayload,
  UpsertVisionExtractionPayload,
  PromoteSessionPayload,
  SyncCallbacks,
} from './captureBackendSync';
import { executeVoiceNoteUploadOp } from './voiceEvidenceManager';
import type { DraftData } from './types';

// ─── Op types ─────────────────────────────────────────────────────────────────

export type PendingOpType =
  | 'upsert_session'
  | 'upsert_asset'
  | 'upsert_ocr_extraction'
  | 'upsert_qr_extraction'
  | 'upsert_vision_extraction'
  | 'update_session_fields'
  | 'promote_session'
  | 'upload_voice_note'
  | 'enqueue_processing_job';

export interface PendingOp {
  id:           string;        // stable op ID (frontend-generated)
  type:         PendingOpType;
  sessionId:    string;        // for grouping/filtering
  createdAt:    string;        // ISO — ops flush in creation order
  retries:      number;
  payload:      unknown;
}

const STORE = 'pending_ops';

// ─── Enqueue ──────────────────────────────────────────────────────────────────

export async function enqueueOp(
  type: PendingOpType,
  sessionId: string,
  payload: unknown,
): Promise<string> {
  const id = `op_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const op: PendingOp = {
    id,
    type,
    sessionId,
    createdAt: new Date().toISOString(),
    retries:   0,
    payload,
  };
  await dbPut(STORE, op);
  return id;
}

// ─── Flush ────────────────────────────────────────────────────────────────────
// Processes all queued ops in order. Stops on first unrecoverable failure
// for a given op (auth errors), but continues on network errors after
// incrementing the retry counter.

let flushInProgress = false;

export async function flushQueue(
  onProgress?: (flushed: number, total: number) => void,
): Promise<{ flushed: number; remaining: number }> {
  if (flushInProgress) return { flushed: 0, remaining: 0 };
  if (!navigator.onLine) return { flushed: 0, remaining: 0 };

  flushInProgress = true;

  try {
    const ops: PendingOp[] = await dbGetAllInStore<PendingOp>(STORE);
    if (ops.length === 0) return { flushed: 0, remaining: 0 };

    // Sort by creation order
    ops.sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    let flushed = 0;

    for (const op of ops) {
      if (!navigator.onLine) break;

      try {
        await executeOp(op);
        await dbDelete(STORE, op.id);
        flushed++;
        onProgress?.(flushed, ops.length);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Auth errors are not retryable — drop the op
        if (msg.includes('Not authenticated') || msg.includes('JWT')) {
          await dbDelete(STORE, op.id);
          flushed++;
        } else {
          // Network / server error — increment retry and keep
          const updated: PendingOp = { ...op, retries: op.retries + 1 };
          await dbPut(STORE, updated);
        }
      }
    }

    const remaining = (await dbGetAllInStore<PendingOp>(STORE)).length;
    return { flushed, remaining };

  } finally {
    flushInProgress = false;
  }
}

// ─── Execute a single op ──────────────────────────────────────────────────────

function noop() {}

function makeSilentCbs(): SyncCallbacks {
  return {
    onSyncing:   noop,
    onSynced:    noop,
    onSyncError: (err) => { throw new Error(err); },
    onOffline:   () => { throw new Error('Went offline during flush'); },
  };
}

async function executeOp(op: PendingOp): Promise<void> {
  const cbs = makeSilentCbs();

  switch (op.type) {
    case 'upsert_session':
      await syncUpsertSession(op.payload as UpsertSessionPayload, cbs);
      break;
    case 'upsert_asset':
      await syncUpsertAsset(op.payload as UpsertAssetPayload, cbs);
      break;
    case 'upsert_ocr_extraction':
      await syncUpsertOcrExtraction(op.payload as UpsertOcrExtractionPayload, cbs);
      break;
    case 'upsert_qr_extraction':
      await syncUpsertQrExtraction(op.payload as UpsertQrExtractionPayload, cbs);
      break;
    case 'upsert_vision_extraction':
      await syncUpsertVisionExtraction(op.payload as UpsertVisionExtractionPayload, cbs);
      break;
    case 'update_session_fields':
      await syncUpdateSessionFields(
        (op.payload as { sessionId: string; draftData: DraftData }).sessionId,
        (op.payload as { sessionId: string; draftData: DraftData }).draftData,
        cbs,
      );
      break;
    case 'promote_session':
      await syncPromoteSession(op.payload as PromoteSessionPayload, cbs);
      break;
    case 'upload_voice_note':
      // Upload audio blob then chain transcription inline.
      // Both steps are idempotent, so retrying the whole op on partial failure is safe.
      await executeVoiceNoteUploadOp(op.payload as {
        sessionId:  string;
        audioBlob:  Blob;
        mimeType:   string;
        durationMs: number;
      });
      break;
    case 'enqueue_processing_job': {
      // ALPE offline fallback: replay a deferred processing-job enqueue.
      const { produceProcessingJob } = await import('../alpe/jobProducer');
      const p = op.payload as {
        backendSessionId: string;
        draftData:        DraftData;
        captureMethod:    string | null;
        eventId:          string | null;
        eventName:        string | null;
        correlationId?:   string | null;
      };
      await produceProcessingJob({
        backendSessionId: p.backendSessionId,
        draftData:        p.draftData,
        captureMethod:    p.captureMethod as import('./types').CaptureMethod | null,
        eventId:          p.eventId,
        eventName:        p.eventName,
        correlationId:    p.correlationId ?? null,
      });
      break;
    }
    default:
      // Unknown op type — drop silently
      break;
  }
}

// ─── Queue size ───────────────────────────────────────────────────────────────

export async function getPendingCount(): Promise<number> {
  const ops = await dbGetAllInStore<PendingOp>(STORE);
  return ops.length;
}
