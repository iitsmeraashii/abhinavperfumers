// Shared voice transcription service — the single implementation used by both the
// Capture Journey (via VoiceEvidenceManager) and the Lead Detail page (future).
//
// Responsibilities:
//   - Call the transcribe-voice-note edge function for a given capture session
//   - Return the transcript text and any error
//   - No upload logic — caller is responsible for ensuring the asset is uploaded first
//
// The edge function performs:
//   - Storage download (private bucket, service role)
//   - OpenAI Whisper transcription
//   - capture_sessions.voice_note_transcript update
//   - capture_assets.transcription_status update (transcribing → ready | failed)

import { supabase } from '../supabaseClient';

export interface TranscribeResult {
  transcript: string | null;
  error:      string | null;
}

/**
 * Requests transcription for the voice note attached to the given capture session.
 *
 * The edge function downloads the audio from Storage, calls Whisper, and writes
 * the transcript back to capture_sessions.voice_note_transcript. It also updates
 * capture_assets.transcription_status to 'ready' or 'failed'.
 *
 * Returns the transcript string on success, null + error on failure.
 * Safe to call multiple times — idempotent when the asset row already exists.
 */
export async function transcribeVoiceNote(sessionId: string): Promise<TranscribeResult> {
  try {
    const { data, error } = await supabase.functions.invoke('transcribe-voice-note', {
      body: { sessionId },
    });

    if (error) {
      console.warn('[voiceTranscriptionService] transcription failed:', error.message);
      return { transcript: null, error: error.message };
    }

    const transcript = (data as { transcript?: string } | null)?.transcript ?? null;
    return { transcript, error: null };

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[voiceTranscriptionService] unhandled error:', msg);
    return { transcript: null, error: msg };
  }
}
