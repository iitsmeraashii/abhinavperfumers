// Fire-and-forget backend sync for the capture lead workflow.
//
// Design principles:
//   - NEVER awaited by UI code — all functions return void
//   - Failures are swallowed silently; UI always uses local state
//   - Each operation is idempotent via upsert (stable IDs from frontend)
//   - Offline detection: skip sync if navigator.onLine is false
//   - No retry queue in this layer — caller re-calls on reconnect
//
// The stable IDs (session ID, asset ID, extraction ID) are generated on the
// frontend before any network call, which makes every upsert safe to replay.

import { supabase } from '../supabaseClient';
import type {
  BackendSyncState,
  BusinessCardAsset,
  CaptureMethod,
  DraftData,
  OcrResult,
} from './types';
import type { ParsedContact } from './parseQrPayload';

// ─── Callbacks ────────────────────────────────────────────────────────────────
// The sync service notifies the caller via lightweight callbacks so the hook
// can update React state without this module knowing about React.

export interface SyncCallbacks {
  onSyncing:    () => void;
  onSynced:     (patch: Partial<BackendSyncState>) => void;
  onSyncError:  (err: string) => void;
  onOffline:    () => void;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function online(): boolean {
  return typeof navigator !== 'undefined' ? navigator.onLine : true;
}

interface AuthIdentity {
  userId:  string;
  repCode: string | null;
}

// Returns the authenticated user's ID and their rep_code from the rep profile.
// rep_code may be null if the profile row hasn't loaded yet — that's fine,
// the column is nullable in capture_sessions.
async function getAuthIdentity(): Promise<AuthIdentity | null> {
  const { data } = await supabase.auth.getUser();
  const userId = data.user?.id;
  if (!userId) return null;

  // Read rep_code from the RLS-filtered view — this is a cheap indexed lookup
  const { data: profile } = await supabase
    .from('my_rep_profile')
    .select('rep_code')
    .maybeSingle();

  return { userId, repCode: profile?.rep_code ?? null };
}

// ─── Session upsert ───────────────────────────────────────────────────────────

export interface UpsertSessionPayload {
  sessionId:       string;   // stable frontend-generated UUID
  captureMethod:   CaptureMethod;
  draftData:       DraftData;
  sessionStatus:   string;
  localDraftKey?:  string;
  eventId?:        string | null;
}

export async function syncUpsertSession(
  payload: UpsertSessionPayload,
  cbs: SyncCallbacks,
): Promise<void> {
  if (!online()) { cbs.onOffline(); return; }

  cbs.onSyncing();

  try {
    const identity = await getAuthIdentity();
    if (!identity) { cbs.onSyncError('Not authenticated'); return; }

    const { userId, repCode } = identity;
    const {
      sessionId, captureMethod, draftData, sessionStatus, localDraftKey, eventId,
    } = payload;

    // Build the phones/emails arrays from the single-value draft fields
    const phones = draftData.phone ? [draftData.phone] : [];
    const emails = draftData.email ? [draftData.email] : [];

    // extracted_fields holds the current best-known contact fields
    const extractedFields: Record<string, unknown> = {};
    if (draftData.clientName)   extractedFields.clientName   = draftData.clientName;
    if (draftData.company)      extractedFields.company      = draftData.company;
    if (draftData.phone)        extractedFields.phone        = draftData.phone;
    if (draftData.email)        extractedFields.email        = draftData.email;
    if (draftData.designation)  extractedFields.designation  = draftData.designation;

    const { error } = await supabase
      .from('capture_sessions')
      .upsert({
        id:               sessionId,
        user_id:          userId,
        sales_rep_code:   repCode,
        event_id:         eventId ?? null,
        capture_method:   captureMethod,
        session_status:   sessionStatus.toLowerCase(),
        extracted_fields: extractedFields,
        notes:            draftData.notes ?? '',
        phones,
        emails,
        local_draft_key:  localDraftKey ?? null,
        // New enrichment fields
        lead_temperature:       draftData.leadTemperature ?? null,
        lead_type:              draftData.leadType ?? null,
        previous_rep_code:      draftData.previousRepCode ?? null,
        application:            draftData.application?.length ? draftData.application : null,
        price_range:            draftData.priceRange ?? null,
        quick_keywords:         draftData.quickKeywords?.length ? draftData.quickKeywords : null,
        target_market:          draftData.targetMarket?.length ? draftData.targetMarket : null,
        certification:          draftData.certification?.length ? draftData.certification : null,
        benchmark:              draftData.benchmark?.length ? draftData.benchmark : null,
        notes_image_url:        draftData.notesImageDataUrl ?? null,
        voice_note_duration_ms: draftData.voiceNoteDurationMs ?? null,
        voice_note_transcript:  draftData.voiceNoteTranscript ?? null,
        // Legacy columns
        client_name:      draftData.clientName ?? null,
        company:          draftData.company    ?? null,
        designation:      draftData.designation ?? null,
        synced_at:        new Date().toISOString(),
      }, { onConflict: 'id' });

    if (error) throw error;

    cbs.onSynced({
      backendSessionId: sessionId,
      lastSyncedAt:     new Date().toISOString(),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[captureBackendSync] syncUpsertSession failed:', msg);
    cbs.onSyncError(msg);
  }
}

// ─── Asset upsert ─────────────────────────────────────────────────────────────

export interface UpsertAssetPayload {
  backendSessionId: string;
  asset:            BusinessCardAsset;
}

export async function syncUpsertAsset(
  payload: UpsertAssetPayload,
  cbs: SyncCallbacks,
): Promise<void> {
  if (!online()) { cbs.onOffline(); return; }

  cbs.onSyncing();

  try {
    const identity = await getAuthIdentity();
    if (!identity) { cbs.onSyncError('Not authenticated'); return; }
    const { userId } = identity;

    const { backendSessionId, asset } = payload;

    // Derive a stable backend asset ID from the local asset ID so upserts
    // are idempotent — same local asset always maps to the same DB row.
    // We store this mapping in BackendSyncState.backendAssetIds.
    const backendAssetId = asset.id; // reuse local ID as PK if it's a UUID,
    // otherwise the DB generates one and we learn it from the response

    const { data, error } = await supabase
      .from('capture_assets')
      .upsert({
        id:                 backendAssetId,
        capture_session_id: backendSessionId,
        user_id:            userId,
        asset_type:         'business_card',
        side:               asset.side,
        asset_side:         asset.side,   // legacy column
        local_asset_id:     asset.id,
        mime_type:          asset.mimeType,
        size_bytes:         asset.sizeBytes,
        file_size:          asset.sizeBytes,  // legacy column
        original_width:     asset.originalWidth,
        original_height:    asset.originalHeight,
        stored_width:       asset.storedWidth,
        stored_height:      asset.storedHeight,
        width:              asset.storedWidth,   // legacy column
        height:             asset.storedHeight,  // legacy column
        processing_state:   'done',
        processing_status:  'done',  // legacy column
      }, { onConflict: 'id' })
      .select('id')
      .maybeSingle();

    if (error) throw error;

    const confirmedId = data?.id ?? backendAssetId;

    cbs.onSynced({
      backendAssetIds:  { [asset.id]: confirmedId },
      lastSyncedAt:     new Date().toISOString(),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[captureBackendSync] syncUpsertAsset failed:', msg);
    cbs.onSyncError(msg);
  }
}

// ─── Extraction result upsert — OCR ──────────────────────────────────────────

export interface UpsertOcrExtractionPayload {
  extractionId:     string;   // stable frontend-generated ID
  backendSessionId: string;
  backendAssetId:   string | null;
  ocrResult:        OcrResult;
  durationMs?:      number;
}

export async function syncUpsertOcrExtraction(
  payload: UpsertOcrExtractionPayload,
  cbs: SyncCallbacks,
): Promise<void> {
  if (!online()) { cbs.onOffline(); return; }

  cbs.onSyncing();

  try {
    const identity = await getAuthIdentity();
    if (!identity) { cbs.onSyncError('Not authenticated'); return; }
    const { userId } = identity;

    const { extractionId, backendSessionId, backendAssetId, ocrResult, durationMs } = payload;

    const { error } = await supabase
      .from('extraction_results')
      .upsert({
        id:                 extractionId,
        capture_session_id: backendSessionId,
        asset_id:           backendAssetId,
        user_id:            userId,
        engine:             'tesseract_ocr',
        extraction_engine:  'tesseract_ocr',   // legacy column
        extraction_type:    'ocr',             // legacy column
        raw_text:           ocrResult.rawText,
        extracted_json:     ocrResult.fields,
        extracted_data:     ocrResult.fields,  // legacy column
        confidence:         ocrResult.confidence,
        overall_confidence: ocrResult.confidence === 'high' ? 0.9 :
                            ocrResult.confidence === 'medium' ? 0.6 : 0.3,
        duration_ms:        durationMs ?? null,
        processing_time_ms: durationMs ?? null, // legacy column
        status:             'done',
        success:            true,  // legacy column
        metadata: {
          inferredFields: ocrResult.inferredFields,
          ignoredLines:   ocrResult.ignoredLines,
          completedAt:    ocrResult.completedAt,
          assetId:        ocrResult.assetId,
        },
      }, { onConflict: 'id' });

    if (error) throw error;

    cbs.onSynced({
      backendExtractionIds: { [extractionId]: extractionId },
      lastSyncedAt:         new Date().toISOString(),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[captureBackendSync] syncUpsertOcrExtraction failed:', msg);
    cbs.onSyncError(msg);
  }
}

// ─── Extraction result upsert — QR ───────────────────────────────────────────

export interface UpsertQrExtractionPayload {
  extractionId:     string;
  backendSessionId: string;
  parsed:           ParsedContact;
  durationMs?:      number;
}

export async function syncUpsertQrExtraction(
  payload: UpsertQrExtractionPayload,
  cbs: SyncCallbacks,
): Promise<void> {
  if (!online()) { cbs.onOffline(); return; }

  cbs.onSyncing();

  try {
    const identity = await getAuthIdentity();
    if (!identity) { cbs.onSyncError('Not authenticated'); return; }
    const { userId } = identity;

    const { extractionId, backendSessionId, parsed, durationMs } = payload;

    const confidenceMap: Record<string, number> = { high: 0.9, medium: 0.6, low: 0.3 };

    const { error } = await supabase
      .from('extraction_results')
      .upsert({
        id:                 extractionId,
        capture_session_id: backendSessionId,
        asset_id:           null,
        user_id:            userId,
        engine:             'qr_parser',
        extraction_engine:  'qr_parser',
        extraction_type:    'qr',
        raw_text:           parsed.raw,
        extracted_json:     parsed.fields,
        extracted_data:     parsed.fields,
        confidence:         parsed.confidence,
        overall_confidence: confidenceMap[parsed.confidence] ?? 0.5,
        duration_ms:        durationMs ?? null,
        processing_time_ms: durationMs ?? null,
        status:             'done',
        success:            true,
        metadata: {
          qrType:             parsed.qrType,
          extractionStrategy: parsed.extractionStrategy,
          hasData:            parsed.hasData,
          ignoredLines:       parsed.ignoredLines,
        },
      }, { onConflict: 'id' });

    if (error) throw error;

    cbs.onSynced({
      backendExtractionIds: { [extractionId]: extractionId },
      lastSyncedAt:         new Date().toISOString(),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[captureBackendSync] syncUpsertQrExtraction failed:', msg);
    cbs.onSyncError(msg);
  }
}

// ─── Session field update ─────────────────────────────────────────────────────
// Called when user edits fields in the manual form — debounced by caller.

export async function syncUpdateSessionFields(
  backendSessionId: string,
  draftData: DraftData,
  cbs: SyncCallbacks,
): Promise<void> {
  if (!online()) { cbs.onOffline(); return; }

  cbs.onSyncing();

  try {
    const identity = await getAuthIdentity();
    if (!identity) { cbs.onSyncError('Not authenticated'); return; }
    const { userId } = identity;

    const extractedFields: Record<string, unknown> = {};
    if (draftData.clientName)   extractedFields.clientName   = draftData.clientName;
    if (draftData.company)      extractedFields.company      = draftData.company;
    if (draftData.phone)        extractedFields.phone        = draftData.phone;
    if (draftData.email)        extractedFields.email        = draftData.email;
    if (draftData.designation)  extractedFields.designation  = draftData.designation;

    const { error } = await supabase
      .from('capture_sessions')
      .update({
        extracted_fields: extractedFields,
        notes:            draftData.notes ?? '',
        phones:           draftData.phone ? [draftData.phone] : [],
        emails:           draftData.email ? [draftData.email] : [],
        client_name:      draftData.clientName ?? null,
        company:          draftData.company    ?? null,
        designation:      draftData.designation ?? null,
        lead_temperature:       draftData.leadTemperature ?? null,
        lead_type:              draftData.leadType ?? null,
        previous_rep_code:      draftData.previousRepCode ?? null,
        application:            draftData.application?.length ? draftData.application : null,
        price_range:            draftData.priceRange ?? null,
        quick_keywords:         draftData.quickKeywords?.length ? draftData.quickKeywords : null,
        target_market:          draftData.targetMarket?.length ? draftData.targetMarket : null,
        certification:          draftData.certification?.length ? draftData.certification : null,
        benchmark:              draftData.benchmark?.length ? draftData.benchmark : null,
        notes_image_url:        draftData.notesImageDataUrl ?? null,
        voice_note_duration_ms: draftData.voiceNoteDurationMs ?? null,
        voice_note_transcript:  draftData.voiceNoteTranscript ?? null,
        synced_at:        new Date().toISOString(),
      })
      .eq('id', backendSessionId)
      .eq('user_id', userId);

    if (error) throw error;

    cbs.onSynced({ lastSyncedAt: new Date().toISOString() });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[captureBackendSync] syncUpdateSessionFields failed:', msg);
    cbs.onSyncError(msg);
  }
}

// ─── Session abandon ──────────────────────────────────────────────────────────

export async function syncAbandonSession(
  backendSessionId: string,
  cbs: SyncCallbacks,
): Promise<void> {
  if (!online()) { cbs.onOffline(); return; }

  try {
    const identity = await getAuthIdentity();
    if (!identity) return;
    const { userId } = identity;

    await supabase
      .from('capture_sessions')
      .update({ session_status: 'abandoned' })
      .eq('id', backendSessionId)
      .eq('user_id', userId);

    cbs.onSynced({ lastSyncedAt: new Date().toISOString() });
  } catch (err) {
    console.warn('[captureBackendSync] syncAbandonSession failed:', err);
  }
}
