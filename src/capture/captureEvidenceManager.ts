// Capture Evidence Manager — single owner of the Evidence lifecycle.
//
// Responsibilities:
//   - evidence registration (CaptureEvidence model, not raw upload args)
//   - upload decision per evidence type:
//       business_card — upload per UploadPolicy (IMMEDIATE or ON_SAVE)
//       notes_image   — upload per UploadPolicy (ON_SAVE or NEVER)
//       voice_note    — delegated entirely to VoiceEvidenceManager, which owns
//                       the full upload → transcription lifecycle and offline queue
//   - storage status updates (handled inside assetStorageUpload / voiceEvidenceManager)
//   - evidence state scoped to the active capture session
//
// The manager is profile-agnostic. It receives UploadTiming policies from
// the ExecutionPlan via the Processing Engine and never inspects strategies.

import type { BusinessCardAsset } from './types';
import type { UploadTiming }       from './CaptureExecutionEngine';
import {
  uploadBusinessCardAsset,
  uploadNotesImage,
  reconcileAssetStorageMetadata,
} from './assetStorageUpload';
import type { BusinessCardUploadResult } from './assetStorageUpload';
import { voiceEvidenceManager } from './voiceEvidenceManager';
import { dbPut, dbDelete }     from './db';
import { enqueueOp }           from './captureOfflineQueue';

let _uploadSeq = 0;
function _diag(stage: string, payload: Record<string, unknown>): void {
  const ts = new Date().toISOString();
  console.log(`[EVIDENCE_DIAG] ${stage}`, { ts, ...payload });
}

// ─── Evidence model ───────────────────────────────────────────────────────────

export type EvidenceType =
  | 'business_card_front'
  | 'business_card_back'
  | 'notes_image'
  | 'voice_note';

interface BusinessCardEvidence {
  type:         'business_card_front' | 'business_card_back';
  sessionId:    string;
  asset:        BusinessCardAsset;
  uploadTiming: UploadTiming;
  correlationId?: string | null;
}

interface NotesImageEvidence {
  type:         'notes_image';
  sessionId:    string;
  dataUrl:      string;
  uploadTiming: UploadTiming;
  correlationId?: string | null;
  ownerId?:      string | null;
}

interface VoiceNoteEvidence {
  type:         'voice_note';
  sessionId:    string;
  audioBlob:    Blob;
  durationMs:   number;
  mimeType:     string;
  uploadTiming: UploadTiming;
  correlationId?: string | null;
  ownerId?:      string | null;
}

export type CaptureEvidence = BusinessCardEvidence | NotesImageEvidence | VoiceNoteEvidence;

// ─── Manager ──────────────────────────────────────────────────────────────────

class CaptureEvidenceManager {
  private _pendingNotes: { sessionId: string; dataUrl: string; ownerId: string | null; localOpId: string } | null = null;
  private _pendingReconciliation: BusinessCardAsset[] = [];
  private _pendingCardUploads: Map<string, BusinessCardAsset[]> = new Map();
  private _uploadTrackers: Map<string, Promise<void>[]> = new Map();
  private _correlationId: string | null = null;
  /** Asset IDs that have been intentionally discarded by the user.
   *  Uploads for these assets are cancelled before metadata write. */
  private _abandonedAssetIds: Set<string> = new Set();

  setCorrelationId(corrId: string | null): void {
    this._correlationId = corrId;
  }

  /** Mark an asset as intentionally discarded. Any in-flight or deferred
   *  upload for this asset will be cancelled before the metadata write,
   *  preventing an unexpected backend capture_assets record. */
  abandonAsset(assetId: string): void {
    this._abandonedAssetIds.add(assetId);
    // Also remove from any deferred pending uploads so flush/reset won't dispatch
    for (const [sid, assets] of this._pendingCardUploads) {
      this._pendingCardUploads.set(sid, assets.filter(a => a.id !== assetId));
    }
  }

  /** Check whether an asset has been abandoned (used by _uploadBusinessCard). */
  isAssetAbandoned(assetId: string): boolean {
    return this._abandonedAssetIds.has(assetId);
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  register(evidence: CaptureEvidence): void {
    switch (evidence.type) {
      case 'business_card_front':
      case 'business_card_back': {
        const sizeBefore = this._pendingCardUploads.get(evidence.sessionId)?.length ?? 0;
        const trackedBefore = this._uploadTrackers.get(evidence.sessionId)?.length ?? 0;
        _diag('REGISTER_START', {
          assetType: evidence.type,
          assetSide: evidence.asset.side,
          assetId: evidence.asset.id,
          localAssetId: evidence.asset.id,
          sessionId: evidence.sessionId,
          uploadTiming: evidence.uploadTiming,
          pendingUploadCountBefore: sizeBefore,
          trackedUploadCountBefore: trackedBefore,
          pendingKeysBefore: Array.from(this._pendingCardUploads.keys()),
        });
        if (evidence.uploadTiming === 'ON_SAVE') {
          const arr = this._pendingCardUploads.get(evidence.sessionId) ?? [];
          arr.push(evidence.asset);
          this._pendingCardUploads.set(evidence.sessionId, arr);
          const sizeAfter = this._pendingCardUploads.get(evidence.sessionId)?.length ?? 0;
          _diag('REGISTER_RESULT', {
            inserted: true,
            pendingUploadCountAfter: sizeAfter,
            pendingKeysAfter: Array.from(this._pendingCardUploads.keys()),
          });
        } else {
          _diag('REGISTER_RESULT', { inserted: false, reason: 'IMMEDIATE timing — not deferred to ON_SAVE' });
          const p = this._uploadBusinessCard(evidence.asset, evidence.uploadTiming, evidence.correlationId);
          this._trackUpload(evidence.sessionId, p);
        }
        break;
      }

      case 'notes_image': {
        if (evidence.dataUrl?.startsWith('data:')) {
          // ── Durable persistence BEFORE any upload attempt ──
          // Persist the notes image to pending_ops so it survives refresh,
          // tab close, upload failure, and user switching. The op is removed
          // only after a successful upload.
          const ownerId = evidence.ownerId ?? null;
          const localOpId = `notes_${evidence.sessionId}_${Date.now()}`;
          const opRecord = {
            id:          localOpId,
            ownerId,
            type:        'upload_notes_image',
            sessionId:   evidence.sessionId,
            createdAt:   new Date().toISOString(),
            retries:     0,
            payload:     { sessionId: evidence.sessionId, dataUrl: evidence.dataUrl, ownerId },
          };
          void dbPut('pending_ops', opRecord).catch(err =>
            console.warn('[evidenceManager] notes image persist failed:', err),
          );
          this._pendingNotes = { sessionId: evidence.sessionId, dataUrl: evidence.dataUrl, ownerId, localOpId };
        }
        break;
      }

      case 'voice_note':
        // Delegated to VoiceEvidenceManager, which owns the full upload →
        // transcription lifecycle including offline queueing.
        // Pass uploadTiming and ownerId so the manager can respect IMMEDIATE
        // vs ON_SAVE and capture the original owner at registration time.
        voiceEvidenceManager.register(
          evidence.sessionId,
          evidence.audioBlob,
          evidence.durationMs,
          evidence.mimeType,
          evidence.uploadTiming,
          evidence.ownerId ?? null,
        );
        break;
    }
  }

  onSaveAndNext(sessionId: string, correlationId?: string | null, ownerId?: string | null): void {
    // Voice evidence is handled by VoiceEvidenceManager — it manages its own
    // online/offline routing, so it must be called before the navigator.onLine
    // gate that applies to notes and reconciliation.
    const _voiceMgrExists = !!voiceEvidenceManager;
    const _onSaveExists = typeof voiceEvidenceManager?.onSaveAndNext === 'function';
    _diag('VOICE_ONSAVEANDNEXT_PRE', {
      backendSessionId: sessionId,
      voiceEvidenceManagerExists: _voiceMgrExists,
      onSaveAndNextExists: _onSaveExists,
      branch: _voiceMgrExists && _onSaveExists ? 'WILL_CALL' : 'SKIP',
    });
    if (_voiceMgrExists && _onSaveExists) {
      voiceEvidenceManager.onSaveAndNext(sessionId, ownerId ?? null);
      _diag('VOICE_ONSAVEANDNEXT_POST', {
        backendSessionId: sessionId,
        branch: 'CALLED',
      });
    } else {
      _diag('VOICE_ONSAVEANDNEXT_SKIPPED', {
        backendSessionId: sessionId,
        voiceEvidenceManagerExists: _voiceMgrExists,
        onSaveAndNextExists: _onSaveExists,
        reason: 'voiceEvidenceManager or onSaveAndNext method not available',
      });
    }

    if (!navigator.onLine) return;

    if (this._pendingNotes?.sessionId === sessionId) {
      const { dataUrl, ownerId, localOpId } = this._pendingNotes;
      this._pendingNotes = null;
      const p = uploadNotesImage(sessionId, dataUrl, correlationId, ownerId).then(() => {
        // Remove the durable local copy only after successful upload.
        if (localOpId) {
          void dbDelete('pending_ops', localOpId).catch(() => {});
        }
      }).catch(() => {});
      this._trackUpload(sessionId, p);
    }

    if (this._pendingReconciliation.length > 0) {
      const toReconcile = this._pendingReconciliation.splice(0);
      for (const asset of toReconcile) {
        const p = reconcileAssetStorageMetadata(asset, correlationId).then(ok => {
          if (!ok) console.warn('[evidenceManager] reconciliation still failing for asset', asset.id);
        }).catch(() => {});
        this._trackUpload(sessionId, p);
      }
    }
  }

  /**
   * Start all deferred (ON_SAVE) business card uploads for a session and
   * track their promises. Must be called before waitForUploads() so the
   * upload promises exist.
   */
  flushPendingUploads(sessionId: string, correlationId?: string | null): void {
    if (correlationId) this._correlationId = correlationId;
    const pending = this._pendingCardUploads.get(sessionId);
    const trackedBefore = this._uploadTrackers.get(sessionId)?.length ?? 0;
    const pendingCount = pending?.length ?? 0;

    _diag('FLUSH_BEGIN', {
      backendSessionId: sessionId,
      pendingUploadCountBefore: pendingCount,
      trackedUploadCountBefore: trackedBefore,
      pendingLocalAssetIds: pending?.map(a => a.id) ?? [],
      pendingKeys: Array.from(this._pendingCardUploads.keys()),
      trackerKeys: Array.from(this._uploadTrackers.keys()),
    });

    _diag('VOICE_FLUSH_DIAG', {
      backendSessionId: sessionId,
      voiceEvidenceManagerExists: !!voiceEvidenceManager,
      onSaveAndNextExists: typeof voiceEvidenceManager?.onSaveAndNext === 'function',
      pendingVoiceNoteCount: 0,
      branch: 'flushPendingUploads does not call voiceEvidenceManager.onSaveAndNext — voice uploads are handled in onSaveAndNext() or via IMMEDIATE timing in register()',
      reason: 'flushPendingUploads only handles deferred business card assets; voice notes are never enqueued here',
    });

    if (!pending || pending.length === 0) {
      _diag('FLUSH_SKIPPED', {
        backendSessionId: sessionId,
        reason: 'ZERO_PENDING_UPLOADS — no deferred business card assets registered for this sessionId; upload phase will be skipped',
        pendingUploadCountBefore: 0,
        trackedUploadCountBefore: trackedBefore,
        pendingKeys: Array.from(this._pendingCardUploads.keys()),
        trackerKeys: Array.from(this._uploadTrackers.keys()),
      });
      return;
    }

    this._pendingCardUploads.delete(sessionId);

    let uploadInvocations = 0;
    for (const asset of pending) {
      _diag('FLUSH_ITERATION', {
        backendSessionId: sessionId,
        localAssetId: asset.id,
        side: asset.side,
        uploadInvoked: true,
      });
      const p = this._uploadBusinessCard(asset, 'IMMEDIATE', this._correlationId);
      uploadInvocations++;
      const seq = ++_uploadSeq;
      _diag('UPLOAD_PROMISE_CREATED', {
        backendSessionId: sessionId,
        localAssetId: asset.id,
        promiseSeq: seq,
        trackedUploadCountAfterThisAsset: (this._uploadTrackers.get(sessionId)?.length ?? 0) + 1,
      });
      this._trackUpload(sessionId, p);
    }

    const trackedAfter = this._uploadTrackers.get(sessionId)?.length ?? 0;
    _diag('FLUSH_COMPLETE', {
      backendSessionId: sessionId,
      pendingUploadCountBefore: pendingCount,
      uploadInvocations,
      trackedUploadCountAfter: trackedAfter,
      remainingPendingUploads: this._pendingCardUploads.get(sessionId)?.length ?? 0,
      trackerKeys: Array.from(this._uploadTrackers.keys()),
    });
  }

  async waitForUploads(sessionId: string): Promise<void> {
    const trackers = this._uploadTrackers.get(sessionId);
    const promiseCount = trackers?.length ?? 0;
    _diag('WAIT_UPLOADS', {
      backendSessionId: sessionId,
      promiseCountPassedIntoPromiseAllSettled: promiseCount,
      trackedUploads: promiseCount,
      hasTrackers: !!trackers,
      trackerKeys: Array.from(this._uploadTrackers.keys()),
    });
    if (!trackers || trackers.length === 0) {
      _diag('WAIT_UPLOADS_RESULT', { result: 'NO_TRACKERS — Promise.all([]) equivalent (immediate return)' });
      return;
    }
    _diag('WAIT_UPLOADS_RESULT', { result: 'AWAITING', count: trackers.length });
    await Promise.allSettled(trackers);
    _diag('WAIT_UPLOADS_SETTLED', { sessionId, count: trackers.length });
    this._uploadTrackers.delete(sessionId);
  }

  onSessionReset(ownerId: string | null = null): void {
    _diag('SESSION_RESET', {
      pendingUploadsBefore: Array.from(this._pendingCardUploads.keys()).map(k => ({ key: k, count: this._pendingCardUploads.get(k)?.length ?? 0 })),
      trackedUploadsBefore: Array.from(this._uploadTrackers.keys()).map(k => ({ key: k, count: this._uploadTrackers.get(k)?.length ?? 0 })),
    });

    // ── Durable enqueue of any remaining deferred card uploads ──
    // If flushPendingUploads() was called first, the map is empty and this
    // is a no-op. If it was NOT called (e.g. handleBackToOptions), we
    // preserve the evidence by enqueuing it to pending_ops — the existing
    // offline queue mechanism can process it later on reconnect.
    for (const [sessionId, assets] of this._pendingCardUploads) {
      for (const asset of assets) {
        if (this._abandonedAssetIds.has(asset.id)) continue;
        const payload = {
          assetId:      asset.id,
          sessionId:    asset.sessionId,
          side:         asset.side,
          dataUrl:      asset.dataUrl,
          mimeType:     asset.mimeType,
          sizeBytes:    asset.sizeBytes,
          originalWidth:  asset.originalWidth,
          originalHeight: asset.originalHeight,
          storedWidth:    asset.storedWidth,
          storedHeight:   asset.storedHeight,
          ownerId:       asset.ownerId ?? ownerId,
        };
        void enqueueOp('upload_business_card', sessionId, payload, payload.ownerId ?? null)
          .catch(err => console.warn('[evidenceManager] onSessionReset enqueue failed:', err));
      }
    }

    this._pendingNotes = null;
    this._pendingReconciliation = [];
    this._pendingCardUploads.clear();
    this._abandonedAssetIds.clear();
    // Do NOT clear _uploadTrackers — produceProcessingJob may still need
    // to await them after the session has been reset.
    voiceEvidenceManager.onSessionReset(ownerId);
  }

  // ── Private upload helpers ─────────────────────────────────────────────────

  private _trackUpload(sessionId: string, p: Promise<void>): void {
    const arr = this._uploadTrackers.get(sessionId) ?? [];
    arr.push(p);
    this._uploadTrackers.set(sessionId, arr);
    _diag('TRACK_UPLOAD', { sessionId, trackedCount: arr.length });
  }

  private async _uploadBusinessCard(asset: BusinessCardAsset, timing: UploadTiming, correlationId?: string | null): Promise<void> {
    const isOnline = typeof navigator !== 'undefined' ? navigator.onLine : 'unknown';
    const storageBucket = 'lead-evidence';
    const storagePath = `${asset.sessionId}/${asset.id}.jpg`;

    _diag('UPLOAD_BUSINESS_CARD_ENTER', {
      backendSessionId: asset.sessionId,
      localAssetId: asset.id,
      assetId: asset.id,
      imageSize: asset.sizeBytes,
      mimeType: asset.mimeType,
      uploadTimingPolicy: timing,
      isOnline,
      storageBucket,
      storagePath,
      side: asset.side,
      hasDataUrl: Boolean(asset.dataUrl),
      dataUrlLength: asset.dataUrl?.length ?? 0,
    });

    if (timing === 'NEVER') {
      _diag('UPLOAD_BUSINESS_CARD_RETURN', {
        backendSessionId: asset.sessionId,
        localAssetId: asset.id,
        returnPoint: 'NEVER',
        reason: 'upload timing policy is NEVER — upload not attempted',
      });
      return;
    }

    if (timing === 'ON_SAVE') {
      _diag('UPLOAD_BUSINESS_CARD_RETURN', {
        backendSessionId: asset.sessionId,
        localAssetId: asset.id,
        returnPoint: 'ON_SAVE',
        reason: 'upload timing policy is ON_SAVE — deferred to flushPendingUploads, not uploaded here',
      });
      return;
    }

    // IMMEDIATE
    if (this.isAssetAbandoned(asset.id)) {
      _diag('UPLOAD_BUSINESS_CARD_RETURN', {
        backendSessionId: asset.sessionId,
        localAssetId: asset.id,
        returnPoint: 'ABANDONED',
        reason: 'asset was discarded by the user before upload completed',
      });
      return;
    }

    if (!navigator.onLine) {
      _diag('UPLOAD_BUSINESS_CARD_RETURN', {
        backendSessionId: asset.sessionId,
        localAssetId: asset.id,
        returnPoint: 'OFFLINE',
        reason: 'navigator.onLine is false — upload skipped',
        isOnline: false,
      });
      return;
    }

    _diag('UPLOAD_BUSINESS_CARD_CALLING', {
      backendSessionId: asset.sessionId,
      localAssetId: asset.id,
      storageBucket,
      storagePath,
    });

    // Re-check abandoned status AFTER the await — the user may have
    // discarded the asset while the upload was in flight.
    if (this.isAssetAbandoned(asset.id)) {
      _diag('UPLOAD_BUSINESS_CARD_RETURN', {
        backendSessionId: asset.sessionId,
        localAssetId: asset.id,
        returnPoint: 'ABANDONED_AFTER_UPLOAD',
        reason: 'asset was discarded during upload — skipping metadata write',
      });
      return;
    }

    let result: BusinessCardUploadResult | null = null;
    try {
      result = await uploadBusinessCardAsset(asset, correlationId);
    } catch (err: unknown) {
      const errObj = err as Record<string, unknown>;
      _diag('UPLOAD_BUSINESS_CARD_ERROR', {
        backendSessionId: asset.sessionId,
        localAssetId: asset.id,
        errorMessage: err instanceof Error ? err.message : String(err),
        errorStack: err instanceof Error ? err.stack ?? null : null,
        errorName: err instanceof Error ? err.name : null,
        supabaseErrorObject: errObj ?? null,
        httpStatus: errObj?.statusCode ?? errObj?.status ?? null,
        storageBucket,
        storagePath,
      });
      // Current behaviour swallows the error (was .catch(() => null)).
      // Preserve that: do not re-throw. result stays null.
      result = null;
    }

    _diag('UPLOAD_BUSINESS_CARD_RESULT', {
      backendSessionId: asset.sessionId,
      localAssetId: asset.id,
      uploaded: result?.uploaded ?? false,
      metadataWritten: result?.metadataWritten ?? false,
      storagePath: result?.storagePath ?? null,
      resultIsNull: result === null,
    });

    if (result?.uploaded && !result.metadataWritten) {
      _diag('UPLOAD_BUSINESS_CARD_RECONCILE', {
        backendSessionId: asset.sessionId,
        localAssetId: asset.id,
        reason: 'file uploaded to Storage but metadata write failed — queued for reconciliation',
      });
      this._pendingReconciliation.push(asset);
    }

    _diag('UPLOAD_BUSINESS_CARD_RETURN', {
      backendSessionId: asset.sessionId,
      localAssetId: asset.id,
      returnPoint: 'NORMAL_COMPLETION',
      uploaded: result?.uploaded ?? false,
      metadataWritten: result?.metadataWritten ?? false,
    });
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────────

export const evidenceManager = new CaptureEvidenceManager();
