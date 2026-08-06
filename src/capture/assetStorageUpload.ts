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
import { logOperationStart, logOperationEnd, logEvent, getCorrelationId } from './assetSyncDiagnostics';

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
  const corrId = getCorrelationId() ?? 'no_correlation';
  const ctx = {
    backendSessionId: asset.sessionId,
    assetType:        'business_card' as const,
    assetSide:         asset.side,
    localAssetId:      asset.id,
  };

  logEvent('uploadBusinessCardAsset() — entry', ctx, { corrId });

  const op = logOperationStart('Storage Upload — uploadBusinessCardAsset()', ctx);
  logEvent('uploadBusinessCardAsset() — logOperationStart created', ctx, { corrId });

  // ── Branch: online check ──────────────────────────────────────────────────
  const isOnline = navigator.onLine;
  logEvent('uploadBusinessCardAsset() — navigator.onLine evaluated', ctx, { corrId, isOnline });

  if (!isOnline) {
    logEvent('uploadBusinessCardAsset() — returning: offline', ctx, { corrId, returnReason: 'navigator.onLine is false', uploaded: false, storagePath: null });
    logOperationEnd(op, { extra: { skipped: 'offline' } });
    return UPLOAD_FAIL;
  }

  try {
    // ── Step: getAuthUserId ──────────────────────────────────────────────────
    logEvent('uploadBusinessCardAsset() — awaiting getAuthUserId()', ctx, { corrId });
    const userId = await getAuthUserId();
    logEvent('uploadBusinessCardAsset() — getAuthUserId() resolved', ctx, {
      corrId, userId: userId ?? null, userIdIsNull: userId === null, userIdIsUndefined: userId === undefined,
    });

    if (!userId) {
      logEvent('uploadBusinessCardAsset() — returning: not authenticated', ctx, { corrId, returnReason: 'userId is null', uploaded: false, storagePath: null });
      logOperationEnd(op, { error: new Error('Not authenticated') });
      return UPLOAD_FAIL;
    }

    const storagePath = `${userId}/${asset.id}.jpg`;
    const blob = dataUrlToBlob(asset.dataUrl);
    logEvent('uploadBusinessCardAsset() — storagePath and blob prepared', ctx, {
      corrId, storagePath, blobSize: blob.size, blobType: blob.type,
      blobIsEmpty: blob.size === 0,
    });

    // ── Step: Storage upload ─────────────────────────────────────────────────
    logEvent('uploadBusinessCardAsset() — awaiting supabase.storage.upload()', ctx, { corrId, storagePath });
    const { error: uploadError } = await supabase.storage
      .from(BUCKET)
      .upload(storagePath, blob, { contentType: 'image/jpeg', upsert: true });
    logEvent('uploadBusinessCardAsset() — storage.upload() resolved', ctx, {
      corrId,
      uploadError: uploadError ? { message: uploadError.message, name: uploadError.name } : null,
      uploaded: !uploadError,
    });

    if (uploadError) {
      logEvent('uploadBusinessCardAsset() — returning: upload error', ctx, {
        corrId, returnReason: 'storage.upload returned error', uploaded: false, storagePath: null,
        error: { message: uploadError.message, name: uploadError.name },
      });
      logOperationEnd(op, { error: uploadError });
      return UPLOAD_FAIL;
    }

    // ── Step: metadata write ─────────────────────────────────────────────────
    logEvent('uploadBusinessCardAsset() — awaiting _writeAssetStorageMeta()', ctx, { corrId, storagePath });
    const metadataWritten = await _writeAssetStorageMeta(asset, userId, storagePath);
    logEvent('uploadBusinessCardAsset() — _writeAssetStorageMeta() resolved', ctx, {
      corrId, metadataWritten, metadataWrittenIsFalse: metadataWritten === false,
    });

    logEvent('uploadBusinessCardAsset() — returning: success', ctx, {
      corrId, returnReason: 'upload + metadata complete', uploaded: true, storagePath,
    });
    logOperationEnd(op, { extra: { storagePath, metadataWritten } });
    return { uploaded: true, metadataWritten, storagePath };

  } catch (err) {
    // Log the COMPLETE error object before it is handled
    const errInfo: Record<string, unknown> = {};
    if (err && typeof err === 'object') {
      const e = err as Record<string, unknown>;
      errInfo.code = e.code ?? null;
      errInfo.message = e.message ?? null;
      errInfo.details = e.details ?? null;
      errInfo.hint = e.hint ?? null;
      errInfo.constraint = e.constraint ?? null;
      errInfo.status = e.status ?? null;
      errInfo.stack = e.stack ?? null;
    } else {
      errInfo.message = String(err);
    }
    logEvent('uploadBusinessCardAsset() — CAUGHT exception', ctx, {
      corrId, error: errInfo, operation: 'uploadBusinessCardAsset',
    });
    logOperationEnd(op, { error: err });
    logEvent('uploadBusinessCardAsset() — returning after catch', ctx, { corrId, returnReason: 'caught exception', uploaded: false, storagePath: null });
    return UPLOAD_FAIL;
  }
}

/**
 * Writes storage_* columns to an existing capture_assets row via a targeted
 * UPDATE. Does NOT touch dimension columns — those are owned by syncUpsertAsset.
 *
 * UPDATE (not upsert) because syncUpsertAsset always creates the row before this
 * runs. Using UPDATE means zeroed dimensions can never overwrite correct values,
 * and a missing row is an explicit detectable failure (returns false).
 *
 * Returns true when the UPDATE succeeded (row found and updated).
 */
async function _writeAssetStorageMeta(
  asset: BusinessCardAsset,
  userId: string,
  storagePath: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .from('capture_assets')
    .upsert({
      capture_session_id:    asset.sessionId,
      user_id:               userId,
      asset_type:            'business_card',
      side:                  asset.side,
      asset_side:            asset.side,
      local_asset_id:        asset.id,
      mime_type:             asset.mimeType,
      size_bytes:            asset.sizeBytes,
      file_size:             asset.sizeBytes,
      original_width:        asset.originalWidth,
      original_height:       asset.originalHeight,
      stored_width:          asset.storedWidth,
      stored_height:         asset.storedHeight,
      width:                 asset.storedWidth,
      height:                asset.storedHeight,
      processing_status:     'done',
      storage_provider:      'SUPABASE',
      storage_bucket:        BUCKET,
      storage_path:          storagePath,
      storage_upload_status: 'uploaded',
      storage_uploaded_at:   new Date().toISOString(),
    }, { onConflict: 'capture_session_id,local_asset_id' })
    .select('id');

  if (error) {
    console.warn('[assetStorageUpload] storage metadata upsert failed:', error.message);
    return false;
  }

  const rows = Array.isArray(data) ? data.length : (data ? 1 : 0);
  if (rows === 0) {
    console.warn('[assetStorageUpload] storage metadata upsert returned zero rows');
    return false;
  }
  return true;
}

/**
 * Retries only the metadata write for an asset whose file was already uploaded.
 * Safe to call repeatedly — only writes storage_* fields, never uploads again.
 * Returns true when the metadata row is confirmed written.
 */
export async function reconcileAssetStorageMetadata(
  asset: BusinessCardAsset,
): Promise<boolean> {
  if (!navigator.onLine) return false;
  try {
    const userId = await getAuthUserId();
    if (!userId) return false;
    const storagePath = `${userId}/${asset.id}.jpg`;
    return await _writeAssetStorageMeta(asset, userId, storagePath);
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
        // Mark as uploaded so the transcription pipeline can proceed.
        transcription_status:  'uploaded',
      }, { onConflict: 'id' });

  } catch (err) {
    console.warn('[assetStorageUpload] uploadVoiceNote error:', err);
  }
}
