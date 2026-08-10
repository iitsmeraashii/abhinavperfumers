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
import type { UploadTiming }   from './CaptureExecutionEngine';

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

let _voiceInstanceCounter = 0;

class VoiceEvidenceManager {
  private _pending: PendingVoice | null = null;
  private _instanceId: number;
  private _lastRegisteredSessionId: string | null = null;
  private _lastClearedBy: string | null = null;
  private _lastClearedAt: string | null = null;

  constructor() {
    this._instanceId = ++_voiceInstanceCounter;
    console.log('[VOICE_DIAG] VoiceEvidenceManager CONSTRUCTED', {
      instanceId: this._instanceId,
      totalInstancesCreatedSoFar: _voiceInstanceCounter,
      ts: new Date().toISOString(),
    });
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Register a completed voice recording for this session.
   * Call immediately when the recorder emits a blob (before Save & Next).
   * Replaces any previously registered blob for the same session.
   */
  register(
    sessionId:    string,
    audioBlob:    Blob,
    durationMs:   number,
    mimeType:     string,
    uploadTiming: UploadTiming = 'IMMEDIATE',
  ): void {
    const pendingBefore = this._pending ? 1 : 0;
    console.log('[VOICE_DIAG] VoiceEvidenceManager.register ENTRY', {
      ts: new Date().toISOString(),
      instanceId: this._instanceId,
      totalInstancesCreatedSoFar: _voiceInstanceCounter,
      backendSessionId: sessionId,
      uploadTiming,
      blobSize: audioBlob?.size ?? null,
      mimeType,
      durationMs,
      pendingVoiceNoteCountBefore: pendingBefore,
      pendingSessionIdBefore: this._pending?.sessionId ?? null,
      lastRegisteredSessionId: this._lastRegisteredSessionId,
      lastClearedBy: this._lastClearedBy,
      lastClearedAt: this._lastClearedAt,
      isOnline: typeof navigator !== 'undefined' ? navigator.onLine : 'unknown',
    });
    if (!audioBlob || audioBlob.size === 0) {
      console.log('[VOICE_DIAG] VoiceEvidenceManager.register EARLY_RETURN', {
        backendSessionId: sessionId,
        reason: 'empty or null blob',
        blobSize: audioBlob?.size ?? null,
      });
      return;
    }
    this._pending = { sessionId, audioBlob, mimeType, durationMs };
    this._lastRegisteredSessionId = sessionId;
    const pendingAfter = this._pending ? 1 : 0;

    let immediateUploadTriggered = false;
    // When IMMEDIATE and online, upload + transcribe right away so the user
    // can see the transcript while still filling the form.
    // ON_SAVE defers to onSaveAndNext(); NEVER suppresses upload entirely.
    if (uploadTiming === 'IMMEDIATE' && navigator.onLine) {
      const pending = this._pending;
      this._pending = null;
      this._lastClearedBy = 'register() IMMEDIATE upload';
      this._lastClearedAt = new Date().toISOString();
      immediateUploadTriggered = true;
      void this._uploadAndTranscribe(sessionId, pending.audioBlob, pending.mimeType, pending.durationMs);
    }
    const pendingAfterUpload = this._pending ? 1 : 0;

    console.log('[VOICE_DIAG] VoiceEvidenceManager.register EXIT', {
      backendSessionId: sessionId,
      instanceId: this._instanceId,
      uploadTiming,
      pendingVoiceNoteCountAfterRegister: pendingAfter,
      immediateUploadTriggered,
      pendingVoiceNoteCountAfterImmediateUpload: pendingAfterUpload,
      pendingClearedByRegisterItself: immediateUploadTriggered,
      lastClearedBy: this._lastClearedBy,
      lastClearedAt: this._lastClearedAt,
    });
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
    const hasPending = this._pending?.sessionId === sessionId;
    const pendingCount = this._pending ? 1 : 0;
    const pendingSessionId = this._pending?.sessionId ?? null;

    console.log('[VOICE_DIAG] VoiceEvidenceManager.onSaveAndNext ENTRY', {
      ts: new Date().toISOString(),
      instanceId: this._instanceId,
      totalInstancesCreatedSoFar: _voiceInstanceCounter,
      backendSessionId: sessionId,
      pendingVoiceNoteCount: pendingCount,
      pendingSessionId,
      hasPendingForThisSession: hasPending,
      willCallUploadVoiceNote: hasPending,
      isOnline: typeof navigator !== 'undefined' ? navigator.onLine : 'unknown',
      lastRegisteredSessionId: this._lastRegisteredSessionId,
      lastClearedBy: this._lastClearedBy,
      lastClearedAt: this._lastClearedAt,
      // Hypothesis 1: multiple instances
      hypothesis1_multipleInstances: _voiceInstanceCounter > 1 ? 'SUSPECT — more than one instance created' : 'no evidence',
      // Hypothesis 2: pending cleared before Save & Next
      hypothesis2_clearedBeforeSave: !hasPending && this._lastClearedBy !== null
        ? `SUSPECT — pending was cleared by: ${this._lastClearedBy} at ${this._lastClearedAt}`
        : 'no evidence',
      // Hypothesis 3: session key mismatch
      hypothesis3_sessionKeyMismatch: !hasPending && pendingSessionId !== null && pendingSessionId !== sessionId
        ? `SUSPECT — register used sessionId="${pendingSessionId}" but onSaveAndNext received sessionId="${sessionId}"`
        : !hasPending && this._lastRegisteredSessionId !== null && this._lastRegisteredSessionId !== sessionId
          ? `SUSPECT — last register used sessionId="${this._lastRegisteredSessionId}" but onSaveAndNext received sessionId="${sessionId}"`
          : 'no evidence',
    });

    if (!hasPending) {
      console.log('[VOICE_DIAG] VoiceEvidenceManager.onSaveAndNext EARLY_RETURN', {
        backendSessionId: sessionId,
        instanceId: this._instanceId,
        reason: 'no pending voice note for this session',
        pendingSessionId,
        lastRegisteredSessionId: this._lastRegisteredSessionId,
        lastClearedBy: this._lastClearedBy,
        lastClearedAt: this._lastClearedAt,
        uploadPromisesCreated: 0,
      });
      return;
    }

    const { audioBlob, mimeType, durationMs } = this._pending;
    this._pending = null;
    this._lastClearedBy = 'onSaveAndNext()';
    this._lastClearedAt = new Date().toISOString();

    let uploadPromisesCreated = 0;
    if (navigator.onLine) {
      void this._uploadAndTranscribe(sessionId, audioBlob, mimeType, durationMs);
      uploadPromisesCreated = 1;
    } else {
      // Store the blob in the queue — IndexedDB supports Blob serialisation.
      enqueueOp('upload_voice_note', sessionId, { sessionId, audioBlob, mimeType, durationMs })
        .catch(err => console.warn('[voiceEvidenceManager] enqueue failed:', err));
      uploadPromisesCreated = 1;
    }

    console.log('[VOICE_DIAG] VoiceEvidenceManager.onSaveAndNext EXIT', {
      backendSessionId: sessionId,
      instanceId: this._instanceId,
      pendingVoiceNoteCount: 0,
      uploadPromisesCreated,
      lastClearedBy: this._lastClearedBy,
      lastClearedAt: this._lastClearedAt,
    });
  }

  /**
   * Discard any pending recording for the current session.
   * Call whenever the capture session is reset or discarded.
   */
  onSessionReset(): void {
    const hadPending = this._pending ? 1 : 0;
    const pendingSessionId = this._pending?.sessionId ?? null;
    console.log('[VOICE_DIAG] VoiceEvidenceManager.onSessionReset ENTRY', {
      ts: new Date().toISOString(),
      instanceId: this._instanceId,
      pendingVoiceNoteCountBefore: hadPending,
      pendingSessionId,
      lastRegisteredSessionId: this._lastRegisteredSessionId,
    });
    // If a voice note is still pending (ON_SAVE timing and the ALPE pipeline
    // hasn't called onSaveAndNext yet), fire the upload now before clearing.
    // Without this, the blob is silently lost — the pipeline calls
    // onSaveAndNext asynchronously after reset, finds _pending null, and
    // uploadVoiceNote is never reached.
    if (this._pending) {
      const { sessionId, audioBlob, mimeType, durationMs } = this._pending;
      this._pending = null;
      this._lastClearedBy = 'onSessionReset() — upload dispatched';
      this._lastClearedAt = new Date().toISOString();
      if (navigator.onLine) {
        void this._uploadAndTranscribe(sessionId, audioBlob, mimeType, durationMs);
      } else {
        enqueueOp('upload_voice_note', sessionId, { sessionId, audioBlob, mimeType, durationMs })
          .catch(err => console.warn('[voiceEvidenceManager] enqueue failed:', err));
      }
    }
    console.log('[VOICE_DIAG] VoiceEvidenceManager.onSessionReset EXIT', {
      instanceId: this._instanceId,
      pendingVoiceNoteCountAfter: 0,
      lastClearedBy: this._lastClearedBy,
      lastClearedAt: this._lastClearedAt,
    });
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
