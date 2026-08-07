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
import { voiceEvidenceManager } from './voiceEvidenceManager';

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
}

interface NotesImageEvidence {
  type:         'notes_image';
  sessionId:    string;
  dataUrl:      string;
  uploadTiming: UploadTiming;
}

interface VoiceNoteEvidence {
  type:         'voice_note';
  sessionId:    string;
  audioBlob:    Blob;
  durationMs:   number;
  mimeType:     string;
  uploadTiming: UploadTiming;
}

export type CaptureEvidence = BusinessCardEvidence | NotesImageEvidence | VoiceNoteEvidence;

// ─── Manager ──────────────────────────────────────────────────────────────────

class CaptureEvidenceManager {
  private _pendingNotes: { sessionId: string; dataUrl: string } | null = null;
  private _pendingReconciliation: BusinessCardAsset[] = [];
  private _pendingCardUploads: Map<string, BusinessCardAsset[]> = new Map();
  private _uploadTrackers: Map<string, Promise<void>[]> = new Map();

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
          const p = this._uploadBusinessCard(evidence.asset, evidence.uploadTiming);
          this._trackUpload(evidence.sessionId, p);
        }
        break;
      }

      case 'notes_image':
        if (evidence.dataUrl?.startsWith('data:')) {
          this._pendingNotes = { sessionId: evidence.sessionId, dataUrl: evidence.dataUrl };
        }
        break;

      case 'voice_note':
        // Delegated to VoiceEvidenceManager, which owns the full upload →
        // transcription lifecycle including offline queueing.
        // Pass uploadTiming so the manager can respect IMMEDIATE vs ON_SAVE.
        voiceEvidenceManager.register(
          evidence.sessionId,
          evidence.audioBlob,
          evidence.durationMs,
          evidence.mimeType,
          evidence.uploadTiming,
        );
        break;
    }
  }

  onSaveAndNext(sessionId: string): void {
    // Voice evidence is handled by VoiceEvidenceManager — it manages its own
    // online/offline routing, so it must be called before the navigator.onLine
    // gate that applies to notes and reconciliation.
    voiceEvidenceManager.onSaveAndNext(sessionId);

    if (!navigator.onLine) return;

    if (this._pendingNotes?.sessionId === sessionId) {
      const { dataUrl } = this._pendingNotes;
      this._pendingNotes = null;
      const p = uploadNotesImage(sessionId, dataUrl).catch(() => {});
      this._trackUpload(sessionId, p);
    }

    if (this._pendingReconciliation.length > 0) {
      const toReconcile = this._pendingReconciliation.splice(0);
      for (const asset of toReconcile) {
        const p = reconcileAssetStorageMetadata(asset).then(ok => {
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
  flushPendingUploads(sessionId: string): void {
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
      const p = this._uploadBusinessCard(asset, 'IMMEDIATE');
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

  onSessionReset(): void {
    _diag('SESSION_RESET', {
      pendingUploadsBefore: Array.from(this._pendingCardUploads.keys()).map(k => ({ key: k, count: this._pendingCardUploads.get(k)?.length ?? 0 })),
      trackedUploadsBefore: Array.from(this._uploadTrackers.keys()).map(k => ({ key: k, count: this._uploadTrackers.get(k)?.length ?? 0 })),
    });
    this._pendingNotes = null;
    this._pendingReconciliation = [];
    this._pendingCardUploads.clear();
    // Do NOT clear _uploadTrackers — produceProcessingJob may still need
    // to await them after the session has been reset.
    voiceEvidenceManager.onSessionReset();
  }

  // ── Private upload helpers ─────────────────────────────────────────────────

  private _trackUpload(sessionId: string, p: Promise<void>): void {
    const arr = this._uploadTrackers.get(sessionId) ?? [];
    arr.push(p);
    this._uploadTrackers.set(sessionId, arr);
    _diag('TRACK_UPLOAD', { sessionId, trackedCount: arr.length });
  }

  private async _uploadBusinessCard(asset: BusinessCardAsset, timing: UploadTiming): Promise<void> {
    _diag('UPLOAD_BUSINESS_CARD_ENTER', {
      assetId: asset.id,
      localAssetId: asset.id,
      timing,
      sessionId: asset.sessionId,
      isOnline: typeof navigator !== 'undefined' ? navigator.onLine : 'unknown',
    });
    if (timing === 'NEVER') { _diag('UPLOAD_BUSINESS_CARD_SKIP', { reason: 'NEVER' }); return; }
    if (timing === 'ON_SAVE') { _diag('UPLOAD_BUSINESS_CARD_SKIP', { reason: 'ON_SAVE (deferred)' }); return; }
    // IMMEDIATE
    if (!navigator.onLine) { _diag('UPLOAD_BUSINESS_CARD_SKIP', { reason: 'offline' }); return; }
    _diag('UPLOAD_BUSINESS_CARD_CALLING', { assetId: asset.id });
    const result = await uploadBusinessCardAsset(asset).catch(() => null);
    _diag('UPLOAD_BUSINESS_CARD_RESULT', {
      assetId: asset.id,
      uploaded: result?.uploaded ?? false,
      metadataWritten: result?.metadataWritten ?? false,
      storagePath: result?.storagePath ?? null,
    });
    if (result?.uploaded && !result.metadataWritten) {
      this._pendingReconciliation.push(asset);
    }
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────────

export const evidenceManager = new CaptureEvidenceManager();
