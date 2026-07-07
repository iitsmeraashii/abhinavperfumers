// Voice Evidence Manager — owns the complete voice note evidence lifecycle.
//
// Lifecycle stages:
//   PENDING_UPLOAD  — blob recorded, waiting for Save & Next
//   UPLOADING       — in-flight to Supabase Storage (online path, in-memory only)
//   UPLOADED        — file in Storage, capture_assets row created
//                     (transcription_status = 'uploaded' on the asset row)
//   TRANSCRIBING    — edge function running Whisper
//                     (transcription_status = 'transcribing' on the asset row)
//   READY           — transcript written to capture_sessions.voice_note_transcript
//                     (transcription_status = 'ready' on the asset row)
//   FAILED          — upload or transcription error; evidence is NOT lost
//                     (transcription_status = 'failed' on the asset row)
//
// Online path (onSaveAndNext, navigator.onLine):
//   upload → transcribe (both fire-and-forget; failures update DB status)
//
// Offline path (onSaveAndNext, !navigator.onLine):
//   enqueue 'upload_voice_note' op → on flush: upload then transcribe inline
//
// Design principles:
//   - One instance per app (module singleton)
//   - Evidence is never silently dropped — FAILED status enables future retry
//   - No React dependency — pure TypeScript, survives re-renders
//   - Transcription uses the shared voiceTranscriptionService (no duplication)
//   - Upload uses the existing uploadVoiceNote from assetStorageUpload

import { uploadVoiceNote }    from './assetStorageUpload';
import { transcribeVoiceNote } from './voiceTranscriptionService';
import { enqueueOp }           from './captureOfflineQueue';

// ─── Types ────────────────────────────────────────────────────────────────────

export type VoiceEvidenceStatus =
  | 'pending_upload'
  | 'uploading'
  | 'uploaded'
  | 'transcribing'
  | 'ready'
  | 'failed';

interface PendingVoice {
  sessionId:  string;
  audioBlob:  Blob;
  mimeType:   string;
  durationMs: number;
}

// ─── Manager ──────────────────────────────────────────────────────────────────

class VoiceEvidenceManager {
  private _pending: PendingVoice | null = null;

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Register a completed voice recording for this session.
   * Call immediately when the recorder emits a blob (before Save & Next).
   * Replaces any previously registered blob for the same session.
   */
  register(
    sessionId:  string,
    audioBlob:  Blob,
    durationMs: number,
    mimeType:   string,
  ): void {
    if (!audioBlob || audioBlob.size === 0) return;
    this._pending = { sessionId, audioBlob, mimeType, durationMs };
  }

  /**
   * Trigger upload + transcription for the pending recording.
   * Called at Save & Next time (after the user confirms).
   *
   * Online: fire-and-forget upload → transcribe chain.
   * Offline: enqueue 'upload_voice_note' op (chained transcription runs on flush).
   *
   * No-op when no pending voice for this session.
   */
  onSaveAndNext(sessionId: string): void {
    if (this._pending?.sessionId !== sessionId) return;

    const { audioBlob, mimeType, durationMs } = this._pending;
    this._pending = null;

    if (navigator.onLine) {
      void this._uploadAndTranscribe(sessionId, audioBlob, mimeType, durationMs);
    } else {
      // Store the blob in the queue — IndexedDB supports Blob serialisation.
      enqueueOp('upload_voice_note', sessionId, { sessionId, audioBlob, mimeType, durationMs })
        .catch(err => console.warn('[voiceEvidenceManager] enqueue failed:', err));
    }
  }

  /**
   * Discard any pending recording for the current session.
   * Call whenever the capture session is reset or discarded.
   */
  onSessionReset(): void {
    this._pending = null;
  }

  // ── Upload + transcribe chain (online path) ────────────────────────────────

  /**
   * Upload the audio blob then transcribe it.
   * Both operations are fire-and-forget from the caller's perspective.
   * Status is written to capture_assets.transcription_status by:
   *   - uploadVoiceNote: creates row with transcription_status = 'uploaded'
   *   - transcribe-voice-note edge fn: sets 'transcribing' → 'ready' | 'failed'
   */
  async uploadAndTranscribeOnline(
    sessionId:  string,
    audioBlob:  Blob,
    mimeType:   string,
    _durationMs: number,
  ): Promise<void> {
    return this._uploadAndTranscribe(sessionId, audioBlob, mimeType, _durationMs);
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private async _uploadAndTranscribe(
    sessionId:  string,
    audioBlob:  Blob,
    mimeType:   string,
    _durationMs: number,
  ): Promise<void> {
    try {
      // Upload creates the capture_assets row with transcription_status = 'uploaded'.
      await uploadVoiceNote(sessionId, audioBlob, mimeType);
    } catch (err) {
      // Upload itself swallows errors, but be defensive.
      console.warn('[voiceEvidenceManager] upload step error:', err);
      return;
    }

    try {
      const { error } = await transcribeVoiceNote(sessionId);
      if (error) {
        console.warn('[voiceEvidenceManager] transcription failed (status will be "failed" in DB):', error);
      }
    } catch (err) {
      console.warn('[voiceEvidenceManager] transcription step error:', err);
    }
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────────

export const voiceEvidenceManager = new VoiceEvidenceManager();

// ─── Re-export for offline queue executor ─────────────────────────────────────
// The offline queue calls this when replaying a queued upload_voice_note op.

export async function executeVoiceNoteUploadOp(payload: {
  sessionId:  string;
  audioBlob:  Blob;
  mimeType:   string;
  durationMs: number;
}): Promise<void> {
  await voiceEvidenceManager.uploadAndTranscribeOnline(
    payload.sessionId,
    payload.audioBlob,
    payload.mimeType,
    payload.durationMs,
  );
}
