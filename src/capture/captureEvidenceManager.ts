// Capture Evidence Manager — single owner of the Evidence lifecycle.
//
// Responsibilities:
//   - evidence registration (CaptureEvidence model, not raw upload args)
//   - upload decision (online check per evidence type)
//   - upload execution (delegates to assetStorageUpload transport)
//   - upload result handling (fire-and-forget, errors swallowed)
//   - storage status updates (handled inside assetStorageUpload)
//   - evidence state scoped to the active capture session
//
// CaptureLeadPage responsibilities after this refactor:
//   - call manager.register(evidence) when evidence is created
//   - call manager.onSaveAndNext(sessionId) at promotion time
//   - call manager.onSessionReset() when the session is cleared
//   - nothing else related to uploads or evidence lifecycle
//
// Upload behaviour is identical to the previous implementation:
//   - Business cards upload immediately when online (fire-and-forget)
//   - Notes images upload at Save & Next when online (fire-and-forget, before promotion)
//   - Both are no-ops when offline — no retry or queue integration (planned separately)
//
// Designed for extension:
//   - New evidence types add an entry to EvidenceType and a case in _upload()
//     without touching CaptureLeadPage
//   - Future upload queue / retry wraps _upload() here without changing callers

import type { BusinessCardAsset } from './types';
import {
  uploadBusinessCardAsset,
  uploadNotesImage,
  uploadVoiceNote,
} from './assetStorageUpload';

// ─── Evidence model ───────────────────────────────────────────────────────────

export type EvidenceType =
  | 'business_card_front'
  | 'business_card_back'
  | 'notes_image'
  | 'voice_note';

interface BusinessCardEvidence {
  type:             'business_card_front' | 'business_card_back';
  sessionId:        string;
  asset:            BusinessCardAsset;
  uploadImmediately: true;       // business cards always upload immediately when online
}

interface NotesImageEvidence {
  type:             'notes_image';
  sessionId:        string;
  dataUrl:          string;
  uploadImmediately: false;      // notes images upload at Save & Next, not immediately
}

interface VoiceNoteEvidence {
  type:             'voice_note';
  sessionId:        string;
  audioBlob:        Blob;
  durationMs:       number;
  mimeType:         string;
  uploadImmediately: false;      // voice notes upload at Save & Next, not immediately
}

export type CaptureEvidence = BusinessCardEvidence | NotesImageEvidence | VoiceNoteEvidence;

// ─── Manager ──────────────────────────────────────────────────────────────────

class CaptureEvidenceManager {
  private _pendingNotes: { sessionId: string; dataUrl: string } | null = null;
  private _pendingVoice: { sessionId: string; audioBlob: Blob; mimeType: string } | null = null;

  // ── Public API ─────────────────────────────────────────────────────────────

  register(evidence: CaptureEvidence): void {
    switch (evidence.type) {
      case 'business_card_front':
      case 'business_card_back':
        this._uploadBusinessCard(evidence.asset);
        break;

      case 'notes_image':
        if (evidence.dataUrl?.startsWith('data:')) {
          this._pendingNotes = { sessionId: evidence.sessionId, dataUrl: evidence.dataUrl };
        }
        break;

      case 'voice_note':
        if (evidence.audioBlob?.size > 0) {
          this._pendingVoice = {
            sessionId: evidence.sessionId,
            audioBlob: evidence.audioBlob,
            mimeType:  evidence.mimeType,
          };
        }
        break;
    }
  }

  onSaveAndNext(sessionId: string): void {
    if (!navigator.onLine) return;

    if (this._pendingNotes?.sessionId === sessionId) {
      const { dataUrl } = this._pendingNotes;
      this._pendingNotes = null;
      uploadNotesImage(sessionId, dataUrl).catch(() => {});
    }

    if (this._pendingVoice?.sessionId === sessionId) {
      const { audioBlob, mimeType } = this._pendingVoice;
      this._pendingVoice = null;
      uploadVoiceNote(sessionId, audioBlob, mimeType).catch(() => {});
    }
  }

  onSessionReset(): void {
    this._pendingNotes = null;
    this._pendingVoice = null;
  }

  // ── Private upload helpers ─────────────────────────────────────────────────

  private _uploadBusinessCard(asset: BusinessCardAsset): void {
    if (!navigator.onLine) return;
    uploadBusinessCardAsset(asset).catch(() => {});
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────────
// One manager instance per app; evidence is scoped by sessionId internally.
// This is a module singleton (not a React context) because upload state must
// survive React re-renders and does not need to be observed by the UI.

export const evidenceManager = new CaptureEvidenceManager();
