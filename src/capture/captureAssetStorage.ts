// Local asset storage for business card images.
// Images are compressed with Canvas before being written to IndexedDB.
// No cloud, no Supabase, fully offline.

import { dbGet, dbGetAll, dbPut, dbDelete } from './db';
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

export async function saveAsset(
  sessionId: string,
  side: CardSide,
  rawDataUrl: string,
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
  };

  await dbPut(STORE, asset);
  return asset;
}

export async function getAsset(id: string): Promise<BusinessCardAsset | null> {
  return dbGet<BusinessCardAsset>(STORE, id);
}

export async function getSessionAssets(sessionId: string): Promise<BusinessCardAsset[]> {
  return dbGetAll<BusinessCardAsset>(STORE, 'by_session', sessionId);
}

export async function deleteAsset(id: string): Promise<void> {
  return dbDelete(STORE, id);
}

export async function deleteSessionAssets(sessionId: string): Promise<void> {
  const assets = await getSessionAssets(sessionId);
  await Promise.all(assets.map(a => deleteAsset(a.id)));
}
