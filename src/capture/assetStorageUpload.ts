// Evidence storage upload — uploads captured assets to Supabase Storage.
//
// Design:
//   - Fire-and-forget: all exports are void, never throw to caller
//   - Offline-safe: immediate no-op when offline; capture_assets row stays 'pending'
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
// Uploads a business card image (front or back) to Supabase Storage and
// updates the capture_assets row with the storage path and upload status.
//
// Path: lead-evidence/{userId}/{assetId}.jpg
// No-op when offline or unauthenticated.

export async function uploadBusinessCardAsset(
  asset: BusinessCardAsset,
): Promise<void> {
  if (!navigator.onLine) return;

  try {
    const userId = await getAuthUserId();
    if (!userId) return;

    const storagePath = `${userId}/${asset.id}.jpg`;
    const blob = dataUrlToBlob(asset.dataUrl);

    const { error: uploadError } = await supabase.storage
      .from(BUCKET)
      .upload(storagePath, blob, { contentType: 'image/jpeg', upsert: true });

    if (uploadError) {
      console.warn('[assetStorageUpload] business card upload failed:', uploadError.message);
      return;
    }

    // Upsert the capture_assets row with storage metadata.
    // Using upsert (not update) so this succeeds even when the DB row hasn't been
    // created yet by syncUpsertAsset — resolving the upload / DB-row race condition.
    // syncUpsertAsset will later upsert the same row with correct dimensions;
    // columns not in that payload (storage_*) are left untouched.
    await supabase
      .from('capture_assets')
      .upsert({
        capture_session_id:    asset.sessionId,
        user_id:               userId,
        asset_type:            'business_card',
        side:                  asset.side,
        asset_side:            asset.side,
        local_asset_id:        asset.id,
        mime_type:             'image/jpeg',
        size_bytes:            0,
        file_size:             0,
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
      }, { onConflict: 'capture_session_id,local_asset_id' });

  } catch (err) {
    console.warn('[assetStorageUpload] uploadBusinessCardAsset error:', err);
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
