// addEvidenceService — attaches new evidence to an existing lead.
//
// Each add operation creates a fresh capture_session linked to the lead via
// promoted_lead_id, then runs through the same upload pipeline used by the
// capture journey. No upload logic is duplicated here — we delegate entirely
// to assetStorageUpload and voiceTranscriptionService.
//
// A separate session per evidence item means:
//   - leadEvidenceService.fetchEvidence resolves multiple sessions per lead
//     (it queries ALL capture_sessions where promoted_lead_id = leadId via
//     a multi-session fetch — see _fetchAllSessionsForLead)
//   - Transcripts live in the correct capture_sessions row
//   - The existing RLS + storage paths remain valid

import { supabase }         from '../supabaseClient';
import { uploadVoiceNote, uploadNotesImage } from './assetStorageUpload';
import { transcribeVoiceNote }               from './voiceTranscriptionService';

// ─── Session creation ─────────────────────────────────────────────────────────

async function createSessionForLead(leadId: string): Promise<string | null> {
  try {
    const { data: authData } = await supabase.auth.getUser();
    const userId = authData.user?.id;
    if (!userId) return null;

    const sessionId = crypto.randomUUID();

    const { error } = await supabase.from('capture_sessions').insert({
      id:               sessionId,
      user_id:          userId,
      promoted_lead_id: leadId,
      capture_method:   'manual',
      session_status:   'COMPLETED',
      created_at:       new Date().toISOString(),
      updated_at:       new Date().toISOString(),
    });

    if (error) {
      console.warn('[addEvidenceService] createSessionForLead error:', error.message);
      return null;
    }
    return sessionId;
  } catch (err) {
    console.warn('[addEvidenceService] createSessionForLead exception:', err);
    return null;
  }
}

// ─── Voice Memo ───────────────────────────────────────────────────────────────

export interface AddVoiceMemoResult {
  sessionId:   string;
  error:       string | null;
}

/**
 * Creates a new capture_session for the lead, uploads the audio blob through
 * the existing uploadVoiceNote pipeline, and fires transcription.
 * Returns the new session ID so the caller can track the evidence item.
 */
export async function addVoiceMemo(
  leadId:    string,
  audioBlob: Blob,
  mimeType:  string,
  durationMs: number,
): Promise<AddVoiceMemoResult> {
  const sessionId = await createSessionForLead(leadId);
  if (!sessionId) return { sessionId: '', error: 'Could not create evidence session.' };

  // Store duration in the session row so leadEvidenceService can read it
  try {
    await supabase
      .from('capture_sessions')
      .update({ voice_note_duration_ms: durationMs })
      .eq('id', sessionId);
  } catch { /* non-critical */ }

  // Upload through the existing pipeline (identical to capture journey)
  await uploadVoiceNote(sessionId, audioBlob, mimeType);

  // Fire transcription (fire-and-forget from UI perspective)
  transcribeVoiceNote(sessionId).catch(err =>
    console.warn('[addEvidenceService] transcription error:', err),
  );

  return { sessionId, error: null };
}

// ─── Image Note ───────────────────────────────────────────────────────────────

export interface AddImageNoteResult {
  sessionId: string;
  error:     string | null;
}

/**
 * Creates a new capture_session for the lead and uploads the image through
 * the existing uploadNotesImage pipeline.
 * Accepts either a data URL (from camera/canvas) or a File/Blob.
 */
export async function addImageNote(
  leadId:  string,
  dataUrl: string,
): Promise<AddImageNoteResult> {
  const sessionId = await createSessionForLead(leadId);
  if (!sessionId) return { sessionId: '', error: 'Could not create evidence session.' };

  await uploadNotesImage(sessionId, dataUrl);

  return { sessionId, error: null };
}
