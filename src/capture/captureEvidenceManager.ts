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
        if (evidence.uploadTiming === 'ON_SAVE') {
          const arr = this._pendingCardUploads.get(evidence.sessionId) ?? [];
          arr.push(evidence.asset);
          this._pendingCardUploads.set(evidence.sessionId, arr);
        } else {
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
    if (!pending || pending.length === 0) return;
    this._pendingCardUploads.delete(sessionId);
    for (const asset of pending) {
      const p = this._uploadBusinessCard(asset, 'IMMEDIATE');
      this._trackUpload(sessionId, p);
    }
  }

  async waitForUploads(sessionId: string): Promise<void> {
    const trackers = this._uploadTrackers.get(sessionId);
    if (!trackers || trackers.length === 0) return;
    await Promise.allSettled(trackers);
    this._uploadTrackers.delete(sessionId);
  }

  onSessionReset(): void {
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
  }

  private async _uploadBusinessCard(asset: BusinessCardAsset, timing: UploadTiming): Promise<void> {
    if (timing === 'NEVER') return;
    if (timing === 'ON_SAVE') return; // deferred to flushPendingUploads
    // IMMEDIATE
    if (!navigator.onLine) return;
    const result = await uploadBusinessCardAsset(asset).catch(() => null);
    if (result?.uploaded && !result.metadataWritten) {
      this._pendingReconciliation.push(asset);
    }
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────────

export const evidenceManager = new CaptureEvidenceManager();
