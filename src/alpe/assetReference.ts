// AssetReference — canonical evidence model for the ALPE processing pipeline.
//
// A single generic shape that represents any captured evidence artifact
// (business card photo, QR image, notes image, voice note) regardless of
// where it is stored.  The Worker builds these from capture_assets rows
// during ProcessingContext hydration; downstream stages read from
// ctx.evidence instead of scattered draftData fields.

/** Source system that produced or owns the asset. */
export type AssetSource =
  | 'capture_assets'
  | 'local_indexeddb'
  | 'supabase_storage'
  | 'unknown';

/** Extra metadata that varies per asset type (dimensions, duration, etc). */
export interface AssetMetadata {
  width?:              number;
  height?:             number;
  fileSize?:           number;
  transcriptionStatus?: string | null;
  processingStatus?:   string;
  storageBucket?:      string | null;
  storageProvider?:   string | null;
  [key: string]:       unknown;
}

/**
 * Canonical reference to a single evidence artifact.
 *
 * Generic enough to represent business cards (front/back), QR images,
 * notes images, and voice notes.  Every field is optional except
 * `assetId` and `assetType` so the model degrades gracefully when
 * the backend row is incomplete.
 */
export interface AssetReference {
  /** capture_assets.id (UUID) or local IndexedDB asset key. */
  assetId:       string;
  /** 'business_card' | 'qr' | 'notes_image' | 'voice_note'. */
  assetType:     string;
  /** 'front' | 'back' — only meaningful for business_card assets. */
  assetSide?:    string | null;
  /** Supabase Storage object path, e.g. '<uid>/asset_123.jpg'. */
  storagePath?:  string | null;
  /** Public URL if the bucket is public and the path is resolved. */
  publicUrl?:    string | null;
  /** Frontend-generated local ID from capture time. */
  localAssetId?: string;
  /** MIME type of the stored file. */
  mimeType?:     string;
  /** Where the reference was resolved from. */
  source:        AssetSource;
  /** Whether the asset has been uploaded to backend storage. */
  uploaded:      boolean;
  /** Type-specific extras (dimensions, duration, transcription status). */
  metadata?:     AssetMetadata;
}

/**
 * Grouped evidence references exposed on ProcessingContext.evidence.
 * Each slot is null when no asset of that type was captured.
 */
export interface EvidenceAssets {
  businessCard: {
    front: AssetReference | null;
    back:  AssetReference | null;
  };
  qr:        AssetReference | null;
  notesImage: AssetReference | null;
  audio:     AssetReference | null;
}

export const EMPTY_EVIDENCE: EvidenceAssets = {
  businessCard: { front: null, back: null },
  qr:           null,
  notesImage:   null,
  audio:        null,
};
