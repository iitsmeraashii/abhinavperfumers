import { isTransportOnline } from '../connectivity/connectivityStore';
import { isCloudSyncAllowed } from '../authModeState';
import { supabase } from '../supabaseClient';
import { uploadVoiceNote } from './assetStorageUpload';
import { transcribeVoiceNote } from './voiceTranscriptionService';
import { findVoiceOps, replaceVoiceOp, changeVoiceOp, type VoiceOp, type VoicePayload } from './voiceOpStorage';
import { getCompletedLead } from './completedLeadsStorage';
import type { UploadTiming } from './CaptureExecutionEngine';
import type { DraftData } from './types';

const locks = new Map<string, Promise<void>>();
function serial(key: string, work: () => Promise<void>): Promise<void> {
  const next = (locks.get(key) ?? Promise.resolve()).catch(() => {}).then(work);
  locks.set(key, next);
  void next.finally(() => { if (locks.get(key) === next) locks.delete(key); }).catch(() => {});
  return next;
}
const authorized = () => isTransportOnline() && isCloudSyncAllowed();
async function isCurrent(op: VoiceOp): Promise<boolean> {
  return (await findVoiceOps(op.sessionId, op.ownerId)).some(row => row.id === op.id && row.payload.recordingId === op.payload.recordingId);
}

export async function executeVoiceNoteUploadOp(payload: VoicePayload, queuedOp?: VoiceOp): Promise<void> {
  const op = queuedOp ?? (await findVoiceOps(payload.sessionId, payload.ownerId)).find(row => row.payload.recordingId === payload.recordingId);
  if (!op) return;
  if (payload.sessionId !== op.sessionId || payload.ownerId !== op.ownerId) throw new Error('Voice operation owner/session mismatch');
  return serial(`${op.ownerId}/${op.sessionId}`, async () => {
    if (!await isCurrent(op)) return; // Removed/replaced work is obsolete locally.
    if (!authorized()) throw new Error('Voice upload requires authorized connectivity');
    const { data: auth, error } = await supabase.auth.getUser();
    if (error || auth.user?.id !== op.ownerId || !authorized()) throw new Error('Voice owner is not authenticated');
    // Offline recording may precede its initial session-upsert operation.
    // A saved capture can reconstruct that parent row without recorder memory.
    const { data: parent, error: parentError } = await supabase.from('capture_sessions')
      .select('id').eq('id', op.sessionId).eq('user_id', op.ownerId).maybeSingle();
    if (parentError) throw parentError;
    const lead = !parent ? await getCompletedLead(op.sessionId) : null;
    if (lead?.ownerId === op.ownerId && authorized() && await isCurrent(op)) {
      const { syncUpsertSession } = await import('./captureBackendSync');
      await syncUpsertSession({ sessionId: op.sessionId, captureMethod: lead.captureMethod ?? 'MANUAL',
        draftData: lead.draftData, sessionStatus: 'CAPTURING', eventId: lead.eventId },
      { onSyncing() {}, onSynced() {}, onSyncError(message) { throw new Error(message); }, onOffline() { throw new Error('Voice session sync deferred'); } }, op.ownerId);
    }
    const latest = (await findVoiceOps(op.sessionId, op.ownerId)).find(row => row.id === op.id && row.payload.recordingId === op.payload.recordingId);
    if (!latest) return;
    await uploadVoiceNote(op.sessionId, latest.payload.audioBlob, latest.payload.mimeType, op.ownerId, {
      recordingId: latest.payload.recordingId, storagePath: latest.payload.storagePath,
      isCurrent: () => isCurrent(op),
      onUploaded: async path => { if (!await changeVoiceOp(op, { storagePath: path })) throw new Error('Voice recording was replaced'); },
    });
    if (!authorized()) throw new Error('Voice completion deferred until authenticated reconnect');
    if (!await changeVoiceOp(op)) return;
    // C1 ends at audio + metadata. Transcription is best effort and never blocks processing.
    if (authorized()) void transcribeVoiceNote(op.sessionId).catch(() => {});
  });
}

class VoiceEvidenceManager {
  async register(sessionId: string, audioBlob: Blob, durationMs: number, mimeType: string,
    uploadTiming: UploadTiming = 'IMMEDIATE', ownerId: string | null = null): Promise<string> {
    if (!ownerId || !sessionId || !(audioBlob instanceof Blob) || !audioBlob.size) throw new Error('Cannot save an empty or unowned voice recording');
    const recordingId = crypto.randomUUID();
    const op: VoiceOp = { id: `voice_${ownerId}_${sessionId}`, ownerId, sessionId, type: 'upload_voice_note',
      createdAt: new Date().toISOString(), retries: 0, payload: { sessionId, ownerId, audioBlob, durationMs, mimeType, recordingId } };
    await replaceVoiceOp(sessionId, ownerId, op);
    if (uploadTiming === 'IMMEDIATE' && authorized()) void executeVoiceNoteUploadOp(op.payload, op).catch(() => {});
    return recordingId;
  }
  async remove(sessionId: string, ownerId: string): Promise<void> { await replaceVoiceOp(sessionId, ownerId); }
  onSaveAndNext(sessionId: string, ownerId: string | null = null): void {
    if (ownerId && authorized()) void this.flush(sessionId, ownerId).catch(() => {});
  }
  onSessionReset(_ownerId: string | null = null): void { /* Durable ops outlive UI reset. */ }
  async flush(sessionId: string, ownerId: string): Promise<void> {
    for (const op of await findVoiceOps(sessionId, ownerId)) await executeVoiceNoteUploadOp(op.payload, op);
  }
  async ensureRemote(sessionId: string, ownerId: string, draft: DraftData): Promise<void> {
    if (!draft.voiceNoteRecordingId && !(Number(draft.voiceNoteDurationMs) > 0)) return;
    await this.flush(sessionId, ownerId);
    if (!authorized()) throw new Error('Voice evidence awaits authenticated reconnect');
    const { data, error } = await supabase.from('capture_assets').select('storage_path, storage_upload_status')
      .eq('capture_session_id', sessionId).eq('user_id', ownerId).eq('asset_type', 'voice_note').maybeSingle();
    if (error || !data?.storage_path || data.storage_upload_status !== 'uploaded' ||
      (draft.voiceNoteRecordingId && !data.storage_path.includes(`/voice/${draft.voiceNoteRecordingId}.`))) {
      throw new Error('Voice evidence is missing or not uploaded; capture remains pending');
    }
  }
}
export const voiceEvidenceManager = new VoiceEvidenceManager();
