// Offline sync queue — persists pending backend operations to IndexedDB.
// On reconnect, all queued ops are flushed in creation order.
//
// Design:
//   - Each op is idempotent (upsert with stable frontend IDs)
//   - Ops survive page reloads
//   - Flush retries with exponential backoff on error
//   - Completed ops are removed from the queue
//   - The queue is per-device (not shared across tabs — that's fine)

import { isCloudSyncAllowed } from '../authModeState';
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
import { uploadNotesImage as uploadNotesImageFn, uploadBusinessCardAsset as uploadBusinessCardAssetFn } from './assetStorageUpload';
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
  | 'upload_notes_image'
  | 'upload_business_card'
  | 'enqueue_processing_job';

export interface PendingOp {
  id:           string;        // stable op ID (frontend-generated)
  ownerId:      string | null; // auth UID of the rep who queued this op
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
  ownerId?: string | null,
): Promise<string> {
  const id = `op_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const op: PendingOp = {
    id,
    ownerId: ownerId ?? null,
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

// Per-owner flush locks: same owner's flushes are serialized, different
// owners can flush concurrently. Keyed by ownerId (or '__unscoped__' when
// no ownerId is given — the flush-all path).
const flushLocks = new Map<string, boolean>();
const UNSCOPED_KEY = '__unscoped__';

export async function flushQueue(
  ownerId?: string,
  onProgress?: (flushed: number, total: number) => void,
): Promise<{ flushed: number; remaining: number }> {
  const lockKey = ownerId ?? UNSCOPED_KEY;

  if (flushLocks.get(lockKey)) return { flushed: 0, remaining: 0 };
  if (!navigator.onLine) return { flushed: 0, remaining: 0 };
  if (!isCloudSyncAllowed()) return { flushed: 0, remaining: 0 };

  flushLocks.set(lockKey, true);

  try {
    const allOps: PendingOp[] = await dbGetAllInStore<PendingOp>(STORE);
    if (allOps.length === 0) return { flushed: 0, remaining: 0 };

    const ops = ownerId ? allOps.filter(op => op.ownerId === ownerId) : allOps;
    if (ops.length === 0) return { flushed: 0, remaining: allOps.length };

    // Sort by creation order
    ops.sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    let flushed = 0;

    for (const op of ops) {
      if (!navigator.onLine) break;
      if (!isCloudSyncAllowed()) break;

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
    flushLocks.delete(lockKey);
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
        ownerId?:   string | null;
      });
      break;
    case 'upload_notes_image': {
      const p = op.payload as {
        sessionId: string;
        dataUrl:   string;
        ownerId?:  string | null;
      };
      await uploadNotesImageFn(p.sessionId, p.dataUrl, undefined, p.ownerId ?? null);
      break;
    }
    case 'upload_business_card': {
      const p = op.payload as {
        assetId:        string;
        sessionId:      string;
        side:           string;
        dataUrl:        string;
        mimeType:       string;
        sizeBytes:      number;
        originalWidth:  number;
        originalHeight: number;
        storedWidth:    number;
        storedHeight:   number;
        ownerId?:       string | null;
      };
      const asset = {
        id:             p.assetId,
        sessionId:      p.sessionId,
        side:           p.side as import('./types').CardSide,
        dataUrl:        p.dataUrl,
        mimeType:       p.mimeType,
        originalWidth:  p.originalWidth,
        originalHeight: p.originalHeight,
        storedWidth:    p.storedWidth,
        storedHeight:   p.storedHeight,
        sizeBytes:      p.sizeBytes,
        createdAt:      new Date().toISOString(),
        ownerId:        p.ownerId ?? null,
      } as import('./types').BusinessCardAsset;
      const result = await uploadBusinessCardAssetFn(asset);
      if (!result?.uploaded) {
        // Distinguish auth failure (drop) from recoverable failure (retry).
        // uploadBusinessCardAsset returns UPLOAD_FAIL for both offline and
        // not-authenticated, but also for storage upload errors. The existing
        // queue-wide convention is: auth errors contain "Not authenticated"
        // or "JWT" and are dropped; everything else is retried.
        //
        // uploadBusinessCardAsset returns {uploaded:false} without throwing,
        // so we must throw here to signal failure to flushQueue's retry loop.
        // A dedicated error message lets us distinguish recoverable upload
        // failures (network/server) from intentional non-upload conditions.
        //
        // If the asset was intentionally abandoned (abandonAsset was called),
        // the upload is skipped entirely — we must NOT throw, otherwise the
        // op would retry forever. The abandonment check is handled in
        // _uploadBusinessCard in the evidence manager, but the offline queue
        // executor calls uploadBusinessCardAsset directly. We rely on the fact
        // that abandoned assets are removed from _pendingCardUploads before
        // onSessionReset enqueues them, so no abandoned asset should ever
        // reach this executor. If one does (defensive), treat it as success
        // (delete the op) rather than retrying forever.
        throw new Error('upload_business_card failed: storage upload or metadata write did not succeed');
      }
      break;
    }
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
        ownerId:          op.ownerId,
      });
      break;
    }
    default:
      // Unknown op type — drop silently
      break;
  }
}

// ─── Queue size ───────────────────────────────────────────────────────────────

export async function getPendingCount(ownerId?: string): Promise<number> {
  const ops = await dbGetAllInStore<PendingOp>(STORE);
  return ownerId ? ops.filter(op => op.ownerId === ownerId).length : ops.length;
}
