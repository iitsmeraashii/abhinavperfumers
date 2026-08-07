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

export interface BusinessCardUploadResult {
  uploaded: boolean;
  metadataWritten: boolean;
  storagePath: string | null;
}

const UPLOAD_FAIL: BusinessCardUploadResult = {
  uploaded: false, metadataWritten: false, storagePath: null,
};

export async function uploadBusinessCardAsset(
  asset: BusinessCardAsset,
): Promise<BusinessCardUploadResult> {
  const corrId = getCorrelationId() ?? 'no_correlation';
  const ts0 = new Date().toISOString();

  console.log('[EVIDENCE_DIAG] UPLOAD_FUNCTION_ENTERED', {
    ts: ts0,
    assetId: asset.id,
    localAssetId: asset.id,
    sessionId: asset.sessionId,
    side: asset.side,
    bucket: BUCKET,
    mime: asset.mimeType,
    imageSize: asset.sizeBytes,
    hasDataUrl: Boolean(asset.dataUrl),
    dataUrlLength: asset.dataUrl?.length ?? 0,
  });

  const ctx = {
    backendSessionId: asset.sessionId,
    assetType: 'business_card' as const,
    assetSide: asset.side,
    localAssetId: asset.id,
  };
  const op = logOperationStart('Storage Upload — uploadBusinessCardAsset()', ctx);

  if (!navigator.onLine) {
    logOperationEnd(op, { extra: { skipped: 'offline' } });
    return UPLOAD_FAIL;
  }

  let userId: string | null;
  try {
    userId = await getAuthUserId();
  } catch (err) {
    console.error('[EVIDENCE_DIAG] GET_AUTH_USER_THREW', {
      ts: new Date().toISOString(),
      assetId: asset.id,
      sessionId: asset.sessionId,
      error: err instanceof Error ? { message: err.message, stack: err.stack, name: err.name } : { String: String(err) },
    });
    logOperationEnd(op, { error: err });
    throw err;
  }
  if (!userId) {
    logOperationEnd(op, { error: new Error('Not authenticated') });
    return UPLOAD_FAIL;
  }

  const storagePath = `${userId}/${asset.id}.jpg`;
  const blob = dataUrlToBlob(asset.dataUrl);

  logEvent('uploadBusinessCardAsset() — entry', ctx, {
    corrId,
    expectedStoragePath: storagePath,
    hasDataUrl: Boolean(asset.dataUrl),
    dataUrlLength: asset.dataUrl?.length ?? 0,
  });

  // ── Pre-upload summary ──
  console.log('[EVIDENCE_DIAG] PRE_UPLOAD_SUMMARY', {
    ts: new Date().toISOString(),
    bucket: BUCKET,
    storagePath,
    fileSize: blob.size,
    mimeType: blob.type,
    assetId: asset.id,
    sessionId: asset.sessionId,
    uploadOptions: { contentType: 'image/jpeg', upsert: true },
  });

  // ── Immediately before the Storage SDK call ──
  const uploadStartMs = Date.now();
  console.log('[EVIDENCE_DIAG] STORAGE_UPLOAD_BEGIN', {
    ts: new Date().toISOString(),
    bucket: BUCKET,
    storagePath,
    fileSize: blob.size,
    mimeType: blob.type,
    assetId: asset.id,
    sessionId: asset.sessionId,
    sdkCall: 'supabase.storage.from(BUCKET).upload(storagePath, blob, { contentType: image/jpeg, upsert: true })',
  });

  let uploadData: unknown;
  let uploadError: unknown;
  try {
    const result = await supabase.storage
      .from(BUCKET)
      .upload(storagePath, blob, { contentType: 'image/jpeg', upsert: true });
    uploadData = result.data;
    uploadError = result.error;
  } catch (err) {
    const uploadEndMs = Date.now();
    const durationMs = uploadEndMs - uploadStartMs;
    console.error('[EVIDENCE_DIAG] STORAGE_UPLOAD_THREW', {
      ts: new Date().toISOString(),
      assetId: asset.id,
      sessionId: asset.sessionId,
      bucket: BUCKET,
      storagePath,
      uploadDurationMs: durationMs,
      error: err instanceof Error
        ? { message: err.message, stack: err.stack, name: err.name }
        : { String: String(err) },
    });
    logOperationEnd(op, { error: err });
    throw err;
  }

  // ── Immediately after the Storage SDK call ──
  const uploadEndMs = Date.now();
  const durationMs = uploadEndMs - uploadStartMs;
  console.log('[EVIDENCE_DIAG] STORAGE_UPLOAD_RESULT', {
    ts: new Date().toISOString(),
    assetId: asset.id,
    sessionId: asset.sessionId,
    bucket: BUCKET,
    storagePath,
    uploadDurationMs: durationMs,
    returnedData: uploadData,
    returnedError: uploadError
      ? {
          message: (uploadError as { message?: string }).message ?? null,
          name: (uploadError as { name?: string }).name ?? null,
          statusCode: (uploadError as Record<string, unknown>).statusCode ?? null,
          raw: uploadError,
        }
      : null,
    success: !uploadError,
  });

  if (uploadError) {
    logOperationEnd(op, { error: uploadError });
    return UPLOAD_FAIL;
  }

  const metadataWritten = await _writeAssetStorageMeta(asset, userId, storagePath);
  logOperationEnd(op, { extra: { storagePath, metadataWritten } });
  return { uploaded: true, metadataWritten, storagePath };
}

/** Waits until every required asset row has a storage path and uploaded status. */
export async function waitForAssetStorageReady(
  sessionId: string,
  localAssetIds: string[],
): Promise<boolean> {
  if (localAssetIds.length === 0) return true;

  const corrId = getCorrelationId() ?? 'no_correlation';
  const deadline = Date.now() + 10_000;
  let pollCount = 0;
  while (Date.now() < deadline) {
    pollCount++;
    const { data, error } = await supabase
      .from('capture_assets')
      .select('id, local_asset_id, storage_path, storage_bucket, storage_upload_status')
      .eq('capture_session_id', sessionId)
      .in('local_asset_id', localAssetIds);

    if (error) {
      logEvent('waitForAssetStorageReady() — poll ERROR', { backendSessionId: sessionId }, { corrId, poll: pollCount, error: error.message });
    } else {
      const rows = data as { id: string; local_asset_id: string; storage_path: string | null; storage_bucket: string | null; storage_upload_status: string | null }[] | null;
      const readyIds = new Set(
        (rows ?? [])
          .filter(asset => asset.storage_upload_status === 'uploaded' && Boolean(asset.storage_path))
          .map(asset => asset.local_asset_id),
      );
      const allReady = localAssetIds.every(id => readyIds.has(id));
      logEvent('waitForAssetStorageReady() — poll', { backendSessionId: sessionId }, {
        corrId,
        poll: pollCount,
        expected: localAssetIds,
        found: rows?.length ?? 0,
        rows: rows?.map(r => ({ id: r.id, localId: r.local_asset_id, storage_path: r.storage_path, upload_status: r.storage_upload_status })) ?? [],
        allReady,
      });
      if (allReady) return true;
    }

    await new Promise<void>(resolve => window.setTimeout(resolve, 250));
  }

  logEvent('waitForAssetStorageReady() — TIMEOUT', { backendSessionId: sessionId }, { corrId, polls: pollCount, expected: localAssetIds });
  return false;
}

async function _writeAssetStorageMeta(
  asset: BusinessCardAsset,
  userId: string,
  storagePath: string,
): Promise<boolean> {
  const corrId = getCorrelationId() ?? 'no_correlation';
  const writeTs = new Date().toISOString();

  const upsertPayload = {
    capture_session_id: asset.sessionId,
    user_id: userId,
    asset_type: 'business_card' as const,
    side: asset.side,
    asset_side: asset.side,
    local_asset_id: asset.id,
    mime_type: asset.mimeType,
    size_bytes: asset.sizeBytes,
    file_size: asset.sizeBytes,
    original_width: asset.originalWidth,
    original_height: asset.originalHeight,
    stored_width: asset.storedWidth,
    stored_height: asset.storedHeight,
    width: asset.storedWidth,
    height: asset.storedHeight,
    processing_status: 'done',
    storage_provider: 'SUPABASE',
    storage_bucket: BUCKET,
    storage_path: storagePath,
    storage_upload_status: 'uploaded',
    storage_uploaded_at: writeTs,
  };

  console.log('[EVIDENCE_DIAG] WRITE_META_BEGIN', {
    ts: writeTs,
    localAssetId: asset.id,
    sessionId: asset.sessionId,
    storagePath,
    bucket: BUCKET,
    status: 'uploaded',
  });
  logEvent('_writeAssetStorageMeta() — BEFORE upsert', {
    backendSessionId: asset.sessionId,
    localAssetId: asset.id,
  }, { corrId, storagePath, payload: upsertPayload });

  const { data, error } = await supabase
    .from('capture_assets')
    .upsert(upsertPayload, { onConflict: 'capture_session_id,local_asset_id' })
    .select('id');

  if (error) {
    console.warn('[assetStorageUpload] storage metadata upsert failed:', error.message);
    logEvent('_writeAssetStorageMeta() — upsert ERROR', {
      backendSessionId: asset.sessionId,
      localAssetId: asset.id,
    }, { corrId, error: { message: error.message, code: error.code, constraint: error.constraint } });
    return false;
  }

  const writtenRowId = Array.isArray(data) && data.length > 0 ? data[0].id : null;
  logEvent('_writeAssetStorageMeta() — upsert resolved', {
    backendSessionId: asset.sessionId,
    localAssetId: asset.id,
  }, { corrId, writtenRowId, returnedRows: data?.length ?? 0 });

  // ── Immediate read-back: verify the row has the storage_path we just wrote.
  // This catches races where another flow overwrote the row between our
  // upsert and this SELECT.
  try {
    const { data: readback, error: rbError } = await supabase
      .from('capture_assets')
      .select('id, storage_path, storage_bucket, storage_upload_status')
      .eq('capture_session_id', asset.sessionId)
      .eq('local_asset_id', asset.id)
      .maybeSingle();

    if (rbError) {
      logEvent('_writeAssetStorageMeta() — readback ERROR', {
        backendSessionId: asset.sessionId,
        localAssetId: asset.id,
      }, { corrId, error: { message: rbError.message, code: rbError.code } });
    } else {
      const rb = readback as { id: string; storage_path: string | null; storage_bucket: string | null; storage_upload_status: string | null } | null;
      const idMismatch = rb?.id && writtenRowId && rb.id !== writtenRowId;
      const pathNulled = rb?.storage_path === null && storagePath !== null;
      logEvent('_writeAssetStorageMeta() — READBACK', {
        backendSessionId: asset.sessionId,
        localAssetId: asset.id,
      }, {
        corrId,
        rowId: rb?.id ?? null,
        expectedRowId: writtenRowId,
        idMismatch,
        storage_path: rb?.storage_path ?? null,
        expected_storage_path: storagePath,
        pathNulled,
        storage_bucket: rb?.storage_bucket ?? null,
        storage_upload_status: rb?.storage_upload_status ?? null,
      });
      console.log('[EVIDENCE_DIAG] WRITE_META_READBACK', {
        ts: new Date().toISOString(),
        localAssetId: asset.id,
        sessionId: asset.sessionId,
        rowId: rb?.id ?? null,
        storagePath: rb?.storage_path ?? null,
        bucket: rb?.storage_bucket ?? null,
        status: rb?.storage_upload_status ?? null,
      });
      if (idMismatch) {
        console.error('[STORAGE_DIAG] ID MISMATCH after _writeAssetStorageMeta!', {
          sessionId: asset.sessionId,
          localAssetId: asset.id,
          writtenRowId,
          readbackRowId: rb?.id,
        });
      }
      if (pathNulled) {
        console.error('[STORAGE_DIAG] storage_path NULL after write!', {
          sessionId: asset.sessionId,
          localAssetId: asset.id,
          writtenPath: storagePath,
          readbackPath: rb?.storage_path,
        });
      }
    }
  } catch (rbErr) {
 logEvent('_writeAssetStorageMeta() — readback threw', {
      backendSessionId: asset.sessionId,
      localAssetId: asset.id,
    }, { corrId, error: String(rbErr) });
  }

  return Array.isArray(data) ? data.length > 0 : Boolean(data);
}

export async function reconcileAssetStorageMetadata(
  asset: BusinessCardAsset,
): Promise<boolean> {
  if (!navigator.onLine) return false;
  try {
    const userId = await getAuthUserId();
    if (!userId) return false;
    return await _writeAssetStorageMeta(asset, userId, `${userId}/${asset.id}.jpg`);
  } catch (err) {
    console.warn('[assetStorageUpload] reconcileAssetStorageMetadata error:', err);
    return false;
  }
}

export async function uploadNotesImage(backendSessionId: string, dataUrl: string): Promise<void> {
  if (!navigator.onLine || !dataUrl?.startsWith('data:')) return;
  try {
    const userId = await getAuthUserId();
    if (!userId) return;
    const storagePath = `${userId}/${backendSessionId}/notes.jpg`;
    const blob = dataUrlToBlob(dataUrl);
    const { error: uploadError } = await supabase.storage.from(BUCKET).upload(storagePath, blob, { contentType: 'image/jpeg', upsert: true });
    if (uploadError) return;
    const { data: existing } = await supabase.from('capture_assets').select('id').eq('capture_session_id', backendSessionId).eq('asset_type', 'notes_image').maybeSingle();
    await supabase.from('capture_assets').upsert({
      id: existing?.id ?? crypto.randomUUID(), capture_session_id: backendSessionId, user_id: userId,
      asset_type: 'notes_image', side: null, asset_side: null, local_asset_id: `${backendSessionId}_notes`,
      mime_type: 'image/jpeg', size_bytes: blob.size, file_size: blob.size, original_width: 0, original_height: 0,
      stored_width: 0, stored_height: 0, width: 0, height: 0, processing_status: 'done',
      storage_provider: 'SUPABASE', storage_bucket: BUCKET, storage_path: storagePath,
      storage_upload_status: 'uploaded', storage_uploaded_at: new Date().toISOString(),
    }, { onConflict: 'id' });
    await supabase.from('capture_sessions').update({ notes_image_url: storagePath }).eq('id', backendSessionId).eq('user_id', userId);
  } catch (err) {
    console.warn('[assetStorageUpload] uploadNotesImage error:', err);
  }
}

export async function uploadVoiceNote(backendSessionId: string, audioBlob: Blob, mimeType: string): Promise<void> {
  if (!navigator.onLine || !audioBlob || audioBlob.size === 0) return;
  try {
    const userId = await getAuthUserId();
    if (!userId) return;
    const ext = mimeType.includes('ogg') ? 'ogg' : mimeType.includes('mp4') ? 'mp4' : 'webm';
    const storagePath = `${userId}/${backendSessionId}/voice.${ext}`;
    const { error: uploadError } = await supabase.storage.from(BUCKET).upload(storagePath, audioBlob, { contentType: mimeType, upsert: true });
    if (uploadError) return;
    const { data: existing } = await supabase.from('capture_assets').select('id').eq('capture_session_id', backendSessionId).eq('asset_type', 'voice_note').maybeSingle();
    await supabase.from('capture_assets').upsert({
      id: existing?.id ?? crypto.randomUUID(), capture_session_id: backendSessionId, user_id: userId,
      asset_type: 'voice_note', side: null, asset_side: null, local_asset_id: `${backendSessionId}_voice`,
      mime_type: mimeType, size_bytes: audioBlob.size, file_size: audioBlob.size, original_width: 0, original_height: 0,
      stored_width: 0, stored_height: 0, width: 0, height: 0, processing_status: 'done',
      storage_provider: 'SUPABASE', storage_bucket: BUCKET, storage_path: storagePath,
      storage_upload_status: 'uploaded', storage_uploaded_at: new Date().toISOString(), transcription_status: 'uploaded',
    }, { onConflict: 'id' });
  } catch (err) {
    console.warn('[assetStorageUpload] uploadVoiceNote error:', err);
  }
}
