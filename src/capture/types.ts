// ─── Capture method / status ──────────────────────────────────────────────────

import type { CaptureProfile } from './captureProfile';
export type { CaptureProfile };

export type CaptureMethod = 'BUSINESS_CARD' | 'QR' | 'MANUAL';

export type SessionStatus = 'IDLE' | 'CAPTURING' | 'DRAFT' | 'READY_FOR_REVIEW';

export type CardSide = 'front' | 'back';

// ─── Local (IndexedDB) models ─────────────────────────────────────────────────

export interface BusinessCardAsset {
  id: string;
  sessionId: string;
  side: CardSide;
  dataUrl: string;
  mimeType: string;
  originalWidth: number;
  originalHeight: number;
  storedWidth: number;
  storedHeight: number;
  sizeBytes: number;
  createdAt: string;
}

export type OcrStatus = 'idle' | 'processing' | 'done' | 'error';

export interface OcrResult {
  assetId: string;
  rawText: string;
  fields: Partial<ManualEntryFields>;
  confidence: 'high' | 'medium' | 'low';
  inferredFields: string[];
  ignoredLines: string[];
  completedAt: string;
}

// ─── Vision extraction (OpenAI) ───────────────────────────────────────────────

export type VisionStatus = 'idle' | 'preprocessing' | 'extracting' | 'validating' | 'done' | 'error';

export type FieldConfidence = 'high' | 'medium' | 'low' | 'unknown';

export interface VisionExtractedFields {
  fullName:     string;
  firstName:    string;
  lastName:     string;
  company:      string;
  designation:  string;
  emails:       string[];
  phoneNumbers: string[];
  website:      string;
  address:      string;
  confidence:   number;   // 0-1 overall
  notes:        string;
  rawText:      string;
}

export interface VisionResult {
  assetId:        string;
  fields:         VisionExtractedFields;
  source:         'openai_vision' | 'tesseract_fallback' | 'manual';
  durationMs:     number;
  attempt:        number;
  completedAt:    string;
  // Per-field confidence derived from overall + presence
  fieldConfidence: Record<keyof VisionExtractedFields, FieldConfidence>;
}

export type LeadTemperature = 'Hot' | 'Warm' | 'Cold';
export type LeadType        = 'NEW' | 'EXISTING';

export const APPLICATION_OPTIONS = [
  'Fine Fragrances',
  'Air Care',
  'Incense Sticks',
  'Cosmetics',
  'Fabric Care',
  'Home Care',
  'Candle',
] as const;

export type ApplicationOption = typeof APPLICATION_OPTIONS[number];

export interface DraftData {
  // Section 1 — priority contact
  clientName?:        string;
  company?:           string;
  phone?:             string;
  email?:             string;
  designation?:       string;
  leadTemperature?:   LeadTemperature;
  // Section 2 — quick notes
  notes?:             string;
  notesImageDataUrl?: string;
  voiceNoteDurationMs?: number;
  voiceNoteTranscript?: string;
  // Section 3 — additional details
  leadType?:          LeadType;
  previousRepCode?:   string;
  application?:       ApplicationOption[];
  priceRange?:        string;
  quickKeywords?:     string[];
  targetMarket?:      string[];
  certification?:     string[];
  benchmark?:         string[];
  // Multi-value fields from vision extraction
  phoneNumbers?:      string[];
  emails?:            string[];
  website?:           string;
  address?:           string;
  // Card session references
  cardSessionId?:     string;
  cardFrontAssetId?:  string;
  cardBackAssetId?:   string;
  // Extraction metadata
  ocrRawText?:          string;
  visionRawText?:       string;
  extractionSource?:    string;
  /** Overall AI extraction confidence (0–1 float). Set from VisionResult.fields.confidence. */
  extractionConfidence?: number;
  rawQr?:               string;
  /** True when a QR scan produced no extractable contact fields. Set once at scan time, persists through manual edits. */
  qrExtractionEmpty?:   boolean;
  [key: string]: unknown;
}

export interface ManualEntryFields {
  clientName:   string;
  company:      string;
  phone:        string;
  email:        string;
  designation:  string;
  notes:        string;
  website:      string;
  address:      string;
}

export interface ManualEntryErrors {
  _form?: string;
}

// ─── Backend sync state ───────────────────────────────────────────────────────

export type SyncStatus =
  | 'idle'        // no backend session yet
  | 'syncing'     // upsert in flight
  | 'synced'      // last upsert succeeded
  | 'error'       // last upsert failed
  | 'offline';    // skipped because navigator.onLine was false

export interface BackendSyncState {
  status:             SyncStatus;
  backendSessionId:   string | null;  // capture_sessions.id
  lastSyncedAt:       string | null;  // ISO timestamp
  pendingOps:         number;         // ops queued but not yet confirmed
  lastError:          string | null;
  // per-record backend IDs for debug panel
  backendAssetIds:    Record<string, string>;       // localAssetId → capture_assets.id
  backendExtractionIds: Record<string, string>;     // localKey → extraction_results.id
}

export const INITIAL_SYNC_STATE: BackendSyncState = {
  status:               'idle',
  backendSessionId:     null,
  lastSyncedAt:         null,
  pendingOps:           0,
  lastError:            null,
  backendAssetIds:      {},
  backendExtractionIds: {},
};

// ─── Frontend session (React state) ──────────────────────────────────────────

export interface CaptureSession {
  captureMethod:    CaptureMethod | null;
  sessionStatus:    SessionStatus;
  captureProfile:   CaptureProfile;
  createdAt:        Date | null;
  updatedAt:        Date | null;
  draftData:        DraftData;
  hasUnsavedChanges: boolean;
  sync:             BackendSyncState;
}

// ─── Backend DB row types ─────────────────────────────────────────────────────
// These mirror the Supabase table columns exactly.

export interface DbCaptureSession {
  id:                    string;
  user_id:               string;
  event_id?:             string | null;
  capture_method:        string;
  session_status:        string;
  extracted_fields:      Record<string, unknown>;
  extraction_confidence: string;
  extraction_metadata:   Record<string, unknown>;
  review_state:          Record<string, unknown>;
  notes:                 string;
  phones:                string[];
  emails:                string[];
  local_draft_key?:      string | null;
  promoted_lead_id?:     string | null;
  synced_at?:            string | null;
  created_at:            string;
  updated_at:            string;
  // legacy columns kept for backward compat
  client_name?:          string | null;
  company?:              string | null;
  designation?:          string | null;
  raw_extraction?:       Record<string, unknown> | null;
}

export interface DbCaptureAsset {
  id:               string;
  capture_session_id: string;
  user_id:          string;
  asset_type:       string;
  side?:            string | null;
  local_asset_id:   string;
  storage_path?:    string | null;
  storage_provider?: string | null;
  storage_bucket?:   string | null;
  storage_upload_status?: string | null;
  storage_uploaded_at?:   string | null;
  transcription_status?:  string | null;
  original_width:   number;
  original_height:  number;
  stored_width:     number;
  stored_height:    number;
  size_bytes:       number;
  mime_type:        string;
  processing_status: string;
  created_at:       string;
  updated_at:       string;
}

export interface DbExtractionResult {
  id:                  string;
  capture_session_id:  string;
  asset_id?:           string | null;
  user_id:             string;
  engine:              string;
  raw_text:            string;
  extracted_json:      Record<string, unknown>;
  confidence:          string;
  duration_ms?:        number | null;
  status:              string;
  error_message?:      string | null;
  metadata:            Record<string, unknown>;
  created_at:          string;
  updated_at:          string;
}
