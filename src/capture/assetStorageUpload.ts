// Evidence storage upload — uploads captured assets to Supabase Storage.
//
// Design:
//   - uploadBusinessCardAsset returns BusinessCardUploadResult so the caller
//     can detect partial success (file in Storage, metadata write failed)
//   - reconcileAssetStorageMetadata retries the metadata write without re-uploading
//   - Offline-safe: immediate failure result when offline
//   - Idempotent: re-uploading the same asset path is harmless (upsert: true)
//   - Isolated: no React state, no capture session lifecycle knowledge
//
// Storage bucket: lead-evidence (private)
// Path convention:
//   Business card : {userId}/{assetId}.jpg
//   Notes image   : {userId}/{sessionId}/notes.jpg
//   Voice note    : {userId}/{sessionId}/voice.{ext}  (planned — path only defined)

import { supabase } from '../supabaseClient';
import type { BusinessCardAsset } from './types';

const BUCKET = 'lead-evidence';

// ─── Internal helpers ─────────────────────────────────────────────────────────

function dataUrlToBlob(dataUrl: string): Blob {
  const [header, b64] = dataUrl.split(',');
  const mime = header.match(/:(.*?);/)?.[1] ?? 'image/jpeg';
  const bytes = atob(b64);
  const buf = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) buf[i] = bytes.charCodeAt(i);
  return new Blob([buf], { type: mime });
}

async function getAuthUserId(): Promise<string | null> {
  try {
    const { data } = await supabase.auth.getUser();
    return data.user?.id ?? null;
  } catch {
    return null;
  }
}

// ─── Business Card upload ─────────────────────────────────────────────────────

export interface BusinessCardUploadResult {
  /** True when the file bytes were written to Supabase Storage. */
  uploaded:        boolean;
  /** True when the capture_assets row was updated with storage_* metadata. */
  metadataWritten: boolean;
  /** Storage path that was written, or null on upload failure. */
  storagePath:     string | null;
}

const UPLOAD_FAIL: BusinessCardUploadResult = {
  uploaded: false, metadataWritten: false, storagePath: null,
};

/**
 * Uploads a business card image to Supabase Storage and writes storage metadata
 * to the capture_assets row via a targeted UPDATE (storage_* columns only —
 * dimensions are never touched here; they belong to syncUpsertAsset).
 *
 * Returns a typed result so the caller can detect partial success and schedule
 * a reconciliation retry.
 *
 * Path: lead-evidence/{userId}/{assetId}.jpg
 * Returns UPLOAD_FAIL when offline or unauthenticated.
 */
export async function uploadBusinessCardAsset(
  asset: BusinessCardAsset,
): Promise<BusinessCardUploadResult> {
  const TAG = '[assetStorageUpload:diag]';
  console.log(TAG, 'START uploadBusinessCardAsset', { assetId: asset.id, sessionId: asset.sessionId, side: asset.side, online: navigator.onLine });

  if (!navigator.onLine) {
    console.log(TAG, 'ABORT — offline');
    return UPLOAD_FAIL;
  }

  try {
    const userId = await getAuthUserId();
    console.log(TAG, 'userId resolved:', userId);
    if (!userId) {
      console.warn(TAG, 'ABORT — no userId (not authenticated)');
      return UPLOAD_FAIL;
    }

    const storagePath = `${userId}/${asset.id}.jpg`;
    const blob = dataUrlToBlob(asset.dataUrl);
    console.log(TAG, '1. PRE-STORAGE-UPLOAD', { storagePath, blobSize: blob.size, bucket: BUCKET });

    const storageResult = await supabase.storage
      .from(BUCKET)
      .upload(storagePath, blob, { contentType: 'image/jpeg', upsert: true });

    console.log(TAG, '2. STORAGE-UPLOAD-RESPONSE', {
      data: storageResult.data,
      error: storageResult.error ? { message: storageResult.error.message, status: (storageResult.error as any).statusCode ?? (storageResult.error as any).status } : null,
    });

    if (storageResult.error) {
      console.warn(TAG, 'ABORT — storage upload failed:', storageResult.error.message);
      return UPLOAD_FAIL;
    }

    console.log(TAG, '3. STORAGE PATH written:', storagePath);
    const metadataWritten = await _writeAssetStorageMeta(asset, userId, storagePath);
    console.log(TAG, 'RESULT', { uploaded: true, metadataWritten, storagePath });
    return { uploaded: true, metadataWritten, storagePath };

  } catch (err) {
    console.warn(TAG, 'UNCAUGHT ERROR:', err);
    return UPLOAD_FAIL;
  }
}

/**
 * Writes storage_* columns to an existing capture_assets row via a targeted
 * UPDATE. Does NOT touch dimension columns — those are owned by syncUpsertAsset.
 *
 * UPDATE (not upsert) because by the time this runs, syncUpsertAsset will have
 * already created the row. Using UPDATE means zeroed dimensions can never
 * overwrite correct values, and a missing row is an explicit detectable failure.
 *
 * Returns true when the UPDATE succeeded (row found and updated).
 */
async function _writeAssetStorageMeta(
  asset: BusinessCardAsset,
  userId: string,
  storagePath: string,
): Promise<boolean> {
  const TAG = '[assetStorageUpload:diag]';

  const payload = {
    storage_provider:      'SUPABASE',
    storage_bucket:        BUCKET,
    storage_path:          storagePath,
    storage_upload_status: 'uploaded',
    storage_uploaded_at:   new Date().toISOString(),
  };
  const filter = { capture_session_id: asset.sessionId, local_asset_id: asset.id, user_id: userId };

  console.log(TAG, '4. PRE-METADATA-UPDATE — UPDATE path (not upsert)', { filter, payload });

  const updateResult = await supabase
    .from('capture_assets')
    .update(payload)
    .eq('capture_session_id', asset.sessionId)
    .eq('local_asset_id', asset.id)
    .eq('user_id', userId)
    .select('id, capture_session_id, local_asset_id, storage_path, storage_upload_status');

  console.log(TAG, '5. METADATA-UPDATE-RESPONSE', {
    data:        updateResult.data,
    error:       updateResult.error ? { message: updateResult.error.message, code: updateResult.error.code, details: updateResult.error.details, hint: updateResult.error.hint } : null,
    rowsAffected: Array.isArray(updateResult.data) ? updateResult.data.length : 'unknown (no .select)',
    status:      (updateResult as any).status,
    statusText:  (updateResult as any).statusText,
  });

  if (updateResult.error) {
    console.warn(TAG, '6. METADATA UPDATE FAILED — error:', updateResult.error.message);
    return false;
  }

  const rows = Array.isArray(updateResult.data) ? updateResult.data.length : -1;
  console.log(TAG, '7. ROWS AFFECTED by UPDATE:', rows, rows === 0 ? '← ZERO ROWS — row did not exist yet or filter mismatch' : '← row updated');

  if (rows === 0) {
    console.warn(TAG, '8. UPDATE matched zero rows. Likely causes: (a) syncUpsertAsset has not run yet (race), (b) asset.sessionId / asset.id mismatch, (c) RLS user_id mismatch');
    console.log(TAG, '   asset.sessionId:', asset.sessionId, '| asset.id:', asset.id, '| userId:', userId);
  }

  return rows > 0;
}

/**
 * Retries only the metadata write for an asset whose file was already uploaded.
 * Safe to call repeatedly — only writes storage_* fields, never uploads again.
 * Returns true when the metadata row is confirmed written.
 */
export async function reconcileAssetStorageMetadata(
  asset: BusinessCardAsset,
): Promise<boolean> {
  const TAG = '[assetStorageUpload:diag]';
  console.log(TAG, 'reconcileAssetStorageMetadata called', { assetId: asset.id, sessionId: asset.sessionId, online: navigator.onLine });
  if (!navigator.onLine) { console.log(TAG, 'reconcile — offline, skipping'); return false; }
  try {
    const userId = await getAuthUserId();
    if (!userId) { console.warn(TAG, 'reconcile — no userId'); return false; }
    const storagePath = `${userId}/${asset.id}.jpg`;
    console.log(TAG, 'reconcile — retrying _writeAssetStorageMeta', { storagePath });
    const ok = await _writeAssetStorageMeta(asset, userId, storagePath);
    console.log(TAG, 'reconcile — result:', ok);
    return ok;
  } catch (err) {
    console.warn('[assetStorageUpload] reconcileAssetStorageMetadata error:', err);
    return false;
  }
}

// ─── Notes Image upload ───────────────────────────────────────────────────────
// Uploads a notes image data URL to Supabase Storage, creates or updates the
// capture_assets row for the notes image, and updates capture_sessions.notes_image_url
// with the storage path (replacing the raw data URL).
//
// Path: lead-evidence/{userId}/{backendSessionId}/notes.jpg
// No-op when offline, unauthenticated, or when dataUrl is not a data: URI.

export async function uploadNotesImage(
  backendSessionId: string,
  dataUrl: string,
): Promise<void> {
  if (!navigator.onLine) return;
  if (!dataUrl?.startsWith('data:')) return;

  try {
    const userId = await getAuthUserId();
    if (!userId) return;

    const storagePath = `${userId}/${backendSessionId}/notes.jpg`;
    const blob = dataUrlToBlob(dataUrl);

    const { error: uploadError } = await supabase.storage
      .from(BUCKET)
      .upload(storagePath, blob, { contentType: 'image/jpeg', upsert: true });

    if (uploadError) {
      console.warn('[assetStorageUpload] notes image upload failed:', uploadError.message);
      return;
    }

    // Find existing notes_image asset row for this session, or prepare a new one
    const { data: existing } = await supabase
      .from('capture_assets')
      .select('id')
      .eq('capture_session_id', backendSessionId)
      .eq('asset_type', 'notes_image')
      .maybeSingle();

    const assetId = existing?.id ?? crypto.randomUUID();

    // Upsert the capture_assets row
    await supabase
      .from('capture_assets')
      .upsert({
        id:                    assetId,
        capture_session_id:    backendSessionId,
        user_id:               userId,
        asset_type:            'notes_image',
        side:                  null,
        asset_side:            null,
        local_asset_id:        `${backendSessionId}_notes`,
        mime_type:             'image/jpeg',
        size_bytes:            blob.size,
        file_size:             blob.size,
        original_width:        0,
        original_height:       0,
        stored_width:          0,
        stored_height:         0,
        width:                 0,
        height:                0,
        processing_status:     'done',
        storage_provider:      'SUPABASE',
        storage_bucket:        BUCKET,
        storage_path:          storagePath,
        storage_upload_status: 'uploaded',
        storage_uploaded_at:   new Date().toISOString(),
      }, { onConflict: 'id' });

    // Replace the raw data URL in capture_sessions with the storage path
    await supabase
      .from('capture_sessions')
      .update({ notes_image_url: storagePath })
      .eq('id', backendSessionId)
      .eq('user_id', userId);

  } catch (err) {
    console.warn('[assetStorageUpload] uploadNotesImage error:', err);
  }
}

// ─── Voice note upload ────────────────────────────────────────────────────────
// Uploads a recorded audio blob to Supabase Storage, creates or updates the
// capture_assets row for the voice note.
//
// Path: lead-evidence/{userId}/{backendSessionId}/voice.{ext}
// No-op when offline, unauthenticated, or when the blob is empty.

export async function uploadVoiceNote(
  backendSessionId: string,
  audioBlob: Blob,
  mimeType: string,
): Promise<void> {
  if (!navigator.onLine) return;
  if (!audioBlob || audioBlob.size === 0) return;

  try {
    const userId = await getAuthUserId();
    if (!userId) return;

    const ext = mimeType.includes('ogg') ? 'ogg'
      : mimeType.includes('mp4') ? 'mp4'
      : 'webm';
    const storagePath = `${userId}/${backendSessionId}/voice.${ext}`;

    const { error: uploadError } = await supabase.storage
      .from(BUCKET)
      .upload(storagePath, audioBlob, { contentType: mimeType, upsert: true });

    if (uploadError) {
      console.warn('[assetStorageUpload] voice note upload failed:', uploadError.message);
      return;
    }

    const { data: existing } = await supabase
      .from('capture_assets')
      .select('id')
      .eq('capture_session_id', backendSessionId)
      .eq('asset_type', 'voice_note')
      .maybeSingle();

    const assetId = existing?.id ?? crypto.randomUUID();

    await supabase
      .from('capture_assets')
      .upsert({
        id:                    assetId,
        capture_session_id:    backendSessionId,
        user_id:               userId,
        asset_type:            'voice_note',
        side:                  null,
        asset_side:            null,
        local_asset_id:        `${backendSessionId}_voice`,
        mime_type:             mimeType,
        size_bytes:            audioBlob.size,
        file_size:             audioBlob.size,
        original_width:        0,
        original_height:       0,
        stored_width:          0,
        stored_height:         0,
        width:                 0,
        height:                0,
        processing_status:     'done',
        storage_provider:      'SUPABASE',
        storage_bucket:        BUCKET,
        storage_path:          storagePath,
        storage_upload_status: 'uploaded',
        storage_uploaded_at:   new Date().toISOString(),
      }, { onConflict: 'id' });

  } catch (err) {
    console.warn('[assetStorageUpload] uploadVoiceNote error:', err);
  }
}
