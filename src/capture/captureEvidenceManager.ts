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

  // ── Public API ─────────────────────────────────────────────────────────────

  register(evidence: CaptureEvidence): void {
    switch (evidence.type) {
      case 'business_card_front':
      case 'business_card_back':
        void this._uploadBusinessCard(evidence.asset, evidence.uploadTiming);
        break;

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
      uploadNotesImage(sessionId, dataUrl).catch(() => {});
    }

    if (this._pendingReconciliation.length > 0) {
      const toReconcile = this._pendingReconciliation.splice(0);
      for (const asset of toReconcile) {
        reconcileAssetStorageMetadata(asset).then(ok => {
          if (!ok) console.warn('[evidenceManager] reconciliation still failing for asset', asset.id);
        }).catch(() => {});
      }
    }
  }

  onSessionReset(): void {
    this._pendingNotes = null;
    this._pendingReconciliation = [];
    voiceEvidenceManager.onSessionReset();
  }

  // ── Private upload helpers ─────────────────────────────────────────────────

  private async _uploadBusinessCard(asset: BusinessCardAsset, timing: UploadTiming): Promise<void> {
    if (timing === 'NEVER') return;
    if (timing === 'ON_SAVE') return; // deferred to onSaveAndNext
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
