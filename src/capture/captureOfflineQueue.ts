import { reconnectTrace, traceContext, traceId } from '../runtime/reconnectTimingTrace';
import { changeVoiceOp, type VoiceOp } from './voiceOpStorage';
import { isTransportOnline } from '../connectivity/connectivityStore';
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
import { dbPutStrict as dbPut, dbDeleteStrict as dbDelete, dbGetAllInStoreStrict as dbGetAllInStore } from './db';
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
import { uploadNotesImage as uploadNotesImageFn, uploadBusinessCardAsset as uploadBusinessCardAssetFn, reconcileAssetStorageMetadata } from './assetStorageUpload';
import { buildCompletedLead, saveQueuedCapture } from './completedLeadsStorage';
import type { CaptureMethod, DraftData } from './types';

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
  const id = type === 'upload_business_card'
    ? `card_${ownerId}_${(payload as { assetId: string }).assetId}`
    : type === 'enqueue_processing_job' ? `processing_${ownerId}_${sessionId}`
    : `op_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
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

/** Existing stores, one transaction: queued work must also be visible locally. */
export async function enqueueProcessingCapture(
  sessionId: string,
  payload: { backendSessionId: string; draftData: DraftData; captureMethod: CaptureMethod | null;
    eventId: string | null; eventName: string | null; correlationId?: string | null },
  ownerId: string,
): Promise<void> {
  const lead = buildCompletedLead(sessionId, payload.captureMethod, payload.draftData,
    sessionId, payload.eventId, payload.eventName, ownerId);
  lead.status = 'pending_sync';
  await saveQueuedCapture(lead, {
    id: `processing_${ownerId}_${sessionId}`, ownerId, type: 'enqueue_processing_job',
    sessionId, createdAt: new Date().toISOString(), retries: 0, payload,
  });
}

/** Cancel only this owner's pending card intent when the user discards it. */
export async function cancelCardUpload(assetId: string, ownerId: string): Promise<void> {
  await dbDelete(STORE, `card_${ownerId}_${assetId}`);
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
  const traceRun = traceContext();
  const flushId = traceId('flush');
  reconnectTrace('FLUSH_INVOKED', { flushId }, traceRun);
  const lockKey = ownerId ?? UNSCOPED_KEY;

  if (flushLocks.get(lockKey)) { reconnectTrace('FLUSH_SKIPPED', { flushId, reason: 'locked' }, traceRun); return { flushed: 0, remaining: 0 }; }
  if (!isTransportOnline()) { reconnectTrace('FLUSH_SKIPPED', { flushId, reason: 'offline' }, traceRun); return { flushed: 0, remaining: 0 }; }
  if (!isCloudSyncAllowed()) {
    reconnectTrace('FLUSH_SKIPPED', { flushId, reason: 'auth_restricted' }, traceRun);
    const remaining = await getPendingCount(ownerId);
    return { flushed: 0, remaining };
  }

  flushLocks.set(lockKey, true);
  reconnectTrace('FLUSH_START', { flushId, reason: ownerId ? undefined : 'no_owner' }, traceRun);

  try {
    const allOps: PendingOp[] = await dbGetAllInStore<PendingOp>(STORE);
    if (allOps.length === 0) { reconnectTrace('FLUSH_SNAPSHOT', { flushId, counts: { total: 0 } }, traceRun); return { flushed: 0, remaining: 0 }; }

    const ops = ownerId ? allOps.filter(op => op.ownerId === ownerId) : allOps;
    if (ops.length === 0) { reconnectTrace('FLUSH_SNAPSHOT', { flushId, counts: { total: 0 } }, traceRun); return { flushed: 0, remaining: allOps.length }; }

    // Preserve creation order within stages, but never let processing precede
    // session/evidence work (including operations created in the same millisecond).
    const stage = (op: PendingOp) => op.type === 'enqueue_processing_job' ? 2 : op.type === 'upsert_session' ? 0 : 1;
    ops.sort((a, b) => stage(a) - stage(b) || a.createdAt.localeCompare(b.createdAt));

    reconnectTrace('FLUSH_SNAPSHOT', { flushId, counts: { total: ops.length, sessions: ops.filter(op => op.type === 'upsert_session').length, prerequisites: ops.filter(op => op.type !== 'enqueue_processing_job').length, enqueue: ops.filter(op => op.type === 'enqueue_processing_job').length } }, traceRun);
    let enqueuePhaseLogged = false;
    let flushed = 0;

    for (const op of ops) {
      if (!isTransportOnline()) break;
      if (!isCloudSyncAllowed()) break;

      const traceOp = { flushId, sessionId: op.sessionId, opId: op.id, opType: op.type };
      reconnectTrace('OP_START', traceOp, traceRun);
      if (op.type === 'enqueue_processing_job') {
        const pending = await dbGetAllInStore<PendingOp>(STORE);
        if (!enqueuePhaseLogged) { reconnectTrace('ENQUEUE_PHASE_REACHED', { flushId, counts: { remaining: pending.filter(other => other.ownerId === op.ownerId && other.type !== 'enqueue_processing_job').length } }, traceRun); enqueuePhaseLogged = true; }
        if (pending.some(other => other.ownerId === op.ownerId && other.sessionId === op.sessionId &&
            other.type !== 'enqueue_processing_job')) { reconnectTrace('OP_END', { flushId, sessionId: op.sessionId, opId: op.id, opType: op.type, outcome: 'deferred' }, traceRun); continue; }
      }
      let traceOutcome = 'completed';
      try {
        await executeOp(op);
        if (op.type !== 'upload_voice_note') await dbDelete(STORE, op.id);
        flushed++;
        onProgress?.(flushed, ops.length);
      } catch (err) {
        traceOutcome = 'failed';
        const msg = err instanceof Error ? err.message : String(err);
        // Preserve capture intents even when auth is temporarily unavailable.
        // Legacy operation behavior is unchanged.
        if (op.type !== 'upload_voice_note' && op.type !== 'upload_business_card' && op.type !== 'enqueue_processing_job' &&
            (msg.includes('Not authenticated') || msg.includes('JWT'))) {
          await dbDelete(STORE, op.id);
          flushed++;
        } else {
          // Network / server error — increment retry and keep
          const updated: PendingOp = { ...op, retries: op.retries + 1 };
          if (op.type === 'upload_voice_note') await changeVoiceOp(op as VoiceOp, undefined, true);
          else await dbPut(STORE, updated);
        }
      } finally { reconnectTrace('OP_END', { ...traceOp, outcome: traceOutcome }, traceRun); }
    }

    const remaining = (await dbGetAllInStore<PendingOp>(STORE)).length;
    return { flushed, remaining };

  } finally {
    reconnectTrace('FLUSH_END', { flushId }, traceRun);
    flushLocks.delete(lockKey);
  }
}

/** Foreground replay also retries backend-only outages with no browser online event. */
export function startQueueReplay(ownerId: string, onError: (error: unknown) => void): () => void {
  const tick = () => flushQueue(ownerId).catch(onError);
  void tick();
  const timer = setInterval(() => { void tick(); }, 15_000);
  return () => clearInterval(timer);
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
      // Voice executor owns conditional deletion after audio + metadata durability.
      // Transcription is best effort and does not hold queue completion.
      await executeVoiceNoteUploadOp((op as VoiceOp).payload, op as VoiceOp);
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
        storagePath?:   string | null;
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
      if (p.storagePath) {
        if (!await reconcileAssetStorageMetadata(asset)) throw new Error('Card metadata still pending');
        break;
      }
      const result = await uploadBusinessCardAssetFn(asset);
      if (result?.uploaded && result.storagePath) op.payload = { ...p, storagePath: result.storagePath };
      if (!result?.uploaded || !result.metadataWritten) {
        // Keep the retry until both Storage and metadata are complete.
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
      const result = await produceProcessingJob({
        backendSessionId: p.backendSessionId,
        draftData:        p.draftData,
        captureMethod:    p.captureMethod as import('./types').CaptureMethod | null,
        eventId:          p.eventId,
        eventName:        p.eventName,
        correlationId:    p.correlationId ?? null,
        ownerId:          op.ownerId,
      });
      if (result.outcome !== 'queued' || !result.jobId) {
        throw new Error(result.error ?? 'Processing deferred until cloud work is allowed');
      }
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
