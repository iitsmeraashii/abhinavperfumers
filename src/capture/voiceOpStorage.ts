import { openDB, dbGetAllInStoreStrict } from './db';

export interface VoicePayload {
  sessionId: string;
  ownerId: string;
  audioBlob: Blob;
  mimeType: string;
  durationMs: number;
  recordingId?: string;
  storagePath?: string;
}
export interface VoiceOp {
  id: string; ownerId: string; sessionId: string; type: 'upload_voice_note';
  createdAt: string; retries: number; payload: VoicePayload;
}
export async function findVoiceOps(sessionId: string, ownerId: string): Promise<VoiceOp[]> {
  return (await dbGetAllInStoreStrict<VoiceOp>('pending_ops')).filter(op =>
    op.type === 'upload_voice_note' && op.sessionId === sessionId && op.ownerId === ownerId);
}
/** Commit replacement/removal atomically; unrelated operations are untouched. */
export async function replaceVoiceOp(sessionId: string, ownerId: string, op?: VoiceOp): Promise<void> {
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('pending_ops', 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('Voice persistence failed'));
    const store = tx.objectStore('pending_ops');
    const read = store.getAll();
    read.onsuccess = () => {
      for (const row of read.result as VoiceOp[]) if (row.type === 'upload_voice_note' && row.sessionId === sessionId && row.ownerId === ownerId) store.delete(row.id);
      if (op) store.put(op);
    };
  });
}
/** A late upload/retry must never delete or overwrite a replacement recording. */
export async function changeVoiceOp(op: VoiceOp, patch?: Partial<VoicePayload>, retry = false): Promise<boolean> {
  const db = await openDB();
  let matched = false;
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('pending_ops', 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('Voice persistence failed'));
    const store = tx.objectStore('pending_ops');
    const read = store.get(op.id);
    read.onsuccess = () => {
      const row = read.result as VoiceOp | undefined;
      if (!row || row.ownerId !== op.ownerId || row.payload.recordingId !== op.payload.recordingId) return;
      matched = true;
      if (patch || retry) store.put({ ...row, retries: row.retries + (retry ? 1 : 0), payload: { ...row.payload, ...patch } });
      else store.delete(op.id);
    };
  });
  return matched;
}
