// Local asset storage for business card images.
// Images are compressed with Canvas before being written to IndexedDB.
// No cloud, no Supabase, fully offline.
//
// Ownership: every newly created asset carries the ownerId (Supabase auth UID)
// of the user who captured it. All retrieval and deletion functions accept an
// optional ownerId that, when supplied, restricts results to that owner.
// Legacy assets (ownerId === null) are excluded from owner-scoped calls and
// can only be accessed via the unscoped (no ownerId) path, reserved for
// diagnostic/recovery tooling.

import { dbGet, dbGetAll, dbPutStrict as dbPut, dbDelete } from './db';
import type { BusinessCardAsset, CardSide } from './types';

const STORE = 'assets';

// Target dimensions for stored images — keeps cards readable but tiny
const MAX_WIDTH  = 1200;
const MAX_HEIGHT = 1200;
const JPEG_QUALITY = 0.82;

// ─── Image compression ────────────────────────────────────────────────────────

export interface CompressResult {
  dataUrl: string;
  mimeType: string;
  width: number;
  height: number;
  sizeBytes: number;
}

export async function compressImage(
  source: string,
  maxWidth  = MAX_WIDTH,
  maxHeight = MAX_HEIGHT,
  quality   = JPEG_QUALITY,
): Promise<CompressResult> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      let { width, height } = img;
      const ratio = Math.min(1, maxWidth / width, maxHeight / height);
      width  = Math.round(width  * ratio);
      height = Math.round(height * ratio);

      const canvas = document.createElement('canvas');
      canvas.width  = width;
      canvas.height = height;

      const ctx = canvas.getContext('2d');
      if (!ctx) { reject(new Error('Canvas 2D context unavailable')); return; }
      ctx.drawImage(img, 0, 0, width, height);

      const dataUrl = canvas.toDataURL('image/jpeg', quality);
      // Rough byte estimate: base64 overhead
      const sizeBytes = Math.round((dataUrl.length * 3) / 4);

      resolve({ dataUrl, mimeType: 'image/jpeg', width, height, sizeBytes });
    };
    img.onerror = () => reject(new Error('Failed to load image for compression'));
    img.src = source;
  });
}

// ─── CRUD ─────────────────────────────────────────────────────────────────────

function genId(): string {
  return `asset_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Create and persist a new business card asset.
 * The ownerId must be supplied by the caller (the capture UI) — it is the
 * Supabase auth UID of the user performing the capture. It is captured at
 * creation time and never resolved later from current auth state.
 */
export async function saveAsset(
  sessionId: string,
  side: CardSide,
  rawDataUrl: string,
  ownerId?: string | null,
): Promise<BusinessCardAsset> {
  // Determine original dims before compression
  const orig = await new Promise<{ w: number; h: number }>((res, rej) => {
    const img = new Image();
    img.onload = () => res({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => rej(new Error('Cannot read image dimensions'));
    img.src = rawDataUrl;
  });

  const compressed = await compressImage(rawDataUrl);

  const asset: BusinessCardAsset = {
    id: genId(),
    sessionId,
    side,
    dataUrl: compressed.dataUrl,
    mimeType: compressed.mimeType,
    originalWidth:  orig.w,
    originalHeight: orig.h,
    storedWidth:    compressed.width,
    storedHeight:   compressed.height,
    sizeBytes:      compressed.sizeBytes,
    createdAt: new Date().toISOString(),
    ownerId: ownerId ?? null,
  };

  await dbPut(STORE, asset);
  return asset;
}

/**
 * Retrieve a single asset by ID.
 *
 * If ownerId is supplied, the asset is returned ONLY when
 * asset.ownerId === ownerId. Legacy assets (ownerId === null) and
 * assets belonging to a different owner are excluded (return null).
 *
 * If ownerId is omitted, the unscoped behavior is preserved for
 * explicit diagnostic/recovery tooling only.
 */
export async function getAsset(id: string, ownerId?: string | null): Promise<BusinessCardAsset | null> {
  const asset = await dbGet<BusinessCardAsset>(STORE, id);
  if (!asset) return null;
  if (ownerId !== undefined) {
    if (asset.ownerId !== ownerId) return null;
  }
  return asset;
}

/**
 * Retrieve all assets for a session.
 *
 * If ownerId is supplied, returns ONLY assets where BOTH
 * sessionId matches AND ownerId matches. Legacy ownerless assets
 * are excluded.
 *
 * If ownerId is omitted, unscoped behavior is preserved for
 * diagnostic/recovery tooling only.
 */
export async function getSessionAssets(sessionId: string, ownerId?: string | null): Promise<BusinessCardAsset[]> {
  const assets = await dbGetAll<BusinessCardAsset>(STORE, 'by_session', sessionId);
  if (ownerId !== undefined) {
    return assets.filter(a => a.ownerId === ownerId);
  }
  return assets;
}

/**
 * Delete a single asset by ID.
 *
 * If ownerId is supplied, the asset is deleted ONLY when
 * asset.ownerId === ownerId. Legacy assets and assets belonging
 * to a different owner are not deleted (silent no-op).
 *
 * If ownerId is omitted, unscoped deletion is preserved for
 * diagnostic/recovery tooling only.
 */
export async function deleteAsset(id: string, ownerId?: string | null): Promise<void> {
  if (ownerId !== undefined) {
    const asset = await dbGet<BusinessCardAsset>(STORE, id);
    if (!asset || asset.ownerId !== ownerId) return;
  }
  return dbDelete(STORE, id);
}

/**
 * Delete all assets for a session.
 *
 * If ownerId is supplied, only assets where BOTH sessionId matches
 * AND ownerId matches are deleted. Legacy ownerless assets are never
 * deleted by an owner-scoped call.
 *
 * If ownerId is omitted, unscoped deletion is preserved for
 * diagnostic/recovery tooling only.
 */
export async function deleteSessionAssets(sessionId: string, ownerId?: string | null): Promise<void> {
  const assets = await getSessionAssets(sessionId, ownerId);
  await Promise.all(assets.map(a => deleteAsset(a.id, ownerId)));
}
