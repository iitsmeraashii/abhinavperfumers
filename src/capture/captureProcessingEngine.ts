// Capture Processing Engine — single orchestration layer for the Lead Capture pipeline.
//
// Purpose:
//   This is the future integration point for all capture processing:
//     - CRM Profile (synchronous, rep reviews extraction results)
//     - Exhibition Profile (non-blocking, deferred processing)
//     - Offline Queue Replay
//     - Future Admin / AI Reprocessing
//
// Stage contract:
//   Every pipeline stage has the same signature:
//     (ctx: ProcessingContext) => void | Promise<void>
//
//   Stages operate on ProcessingContext — the shared mutable pipeline object.
//   Stages enrich ProcessingContext by writing outputs into it for downstream stages.
//   The terminal stage (Promotion) writes the final ProcessingResult into ctx.result.
//   processCaptureSession reads ctx.result and returns it to the UI.
//
// Owned pipeline stages:
//   executeEvidenceStage    ✓ ACTIVE  — notes image upload (fire-and-forget)
//   executeExtractionStage  ✓ ACTIVE  — enriches context with extraction metadata
//   executeValidationStage  ✓ ACTIVE  — gates promotion on data completeness
//   executeReviewStage      ✓ ACTIVE  — evaluates LOW_CONFIDENCE rule
//   executePromotionStage   ✓ ACTIVE  — lead_entries INSERT, terminal stage
//   executeCleanupStage     (not yet migrated)
//
// Public helpers for events that occur outside the Save & Next pipeline:
//   registerCardEvidence      — card image registration at capture time
//   notifySessionReset        — session cleared
//   handleVisionExtraction    — Vision result received (dedup + sync)
//   handleOcrExtraction       — OCR result received (dedup + sync)
//   handleQrExtraction        — QR result received (sync)

import { evidenceManager }            from './captureEvidenceManager';
import { extractionCoordinator }       from './captureExtractionCoordinator';
import { reviewEngine }                from './captureReviewEngine';
import type { ReviewResult }           from './captureReviewEngine';
import { validationEngine }            from './captureValidationEngine';
import {
  syncUpsertVisionExtraction,
  syncUpsertOcrExtraction,
  syncUpsertQrExtraction,
  syncUpdateSessionExtractionMeta,
} from './captureBackendSync';
import type { SyncCallbacks }          from './captureBackendSync';
import { enqueueOp }                   from './captureOfflineQueue';
import { executePromotion }            from './capturePromotionService';
import type { PromoteSessionOptions }  from './capturePromotionService';
import { buildCompletedLead, saveCompletedLead } from './completedLeadsStorage';
import type {
  BackendSyncState,
  BusinessCardAsset,
  CaptureSession,
  OcrResult,
  VisionResult,
} from './types';
import type { ParsedContact }          from './parseQrPayload';

// ─── Public evidence helpers ──────────────────────────────────────────────────
// Business card registration and session reset happen at different points in
// the lifecycle than Save & Next, so they are not part of processCaptureSession.

/**
 * Register business card image evidence at capture time.
 * Called by CaptureLeadPage when card assets change (before Save & Next).
 */
export function registerCardEvidence(
  sessionId: string,
  assets: { front: BusinessCardAsset | null; back: BusinessCardAsset | null },
): void {
  const { front, back } = assets;
  if (front) evidenceManager.register({ type: 'business_card_front', sessionId, asset: front, uploadImmediately: true });
  if (back)  evidenceManager.register({ type: 'business_card_back',  sessionId, asset: back,  uploadImmediately: true });
}

/**
 * Register a completed voice note recording as evidence.
 * Called by CaptureLeadPage when the recorder emits a blob.
 */
export function registerVoiceNoteEvidence(
  sessionId: string,
  audioBlob: Blob,
  durationMs: number,
  mimeType: string,
): void {
  evidenceManager.register({ type: 'voice_note', sessionId, audioBlob, durationMs, mimeType, uploadImmediately: false });
}

/**
 * Notify the engine that the active capture session has been reset.
 * Called from every session reset path in CaptureLeadPage.
 */
export function notifySessionReset(): void {
  evidenceManager.onSessionReset();
}

// ─── Extraction Stage — real-time event handlers ──────────────────────────────
// Called as extraction results arrive during capture (before Save & Next).
// The engine owns dedup and online/offline routing; React state callbacks are
// injected by the caller so the engine has no React dependency.

/**
 * ExtractionSyncCallbacks — extends the standard SyncCallbacks with two hooks
 * that allow CaptureLeadPage to update React state for the extraction paths.
 *
 *   onBeforeOnlineSync — called just before firing the async sync (e.g. incrementPendingOps)
 *   onOfflineQueued    — called after enqueueOp (e.g. setSyncStatus + incrementPendingCount)
 */
export interface ExtractionSyncCallbacks extends SyncCallbacks {
  onBeforeOnlineSync: () => void;
  onOfflineQueued:    () => void;
}

export type ExtractionHandlerOutcome = 'synced' | 'queued' | 'skipped';

/**
 * Handle a Vision extraction result.
 *
 * Responsibilities:
 *   - Guard: only openai_vision writes an extraction_results row
 *   - Mark this asset in the dedup set so a subsequent Tesseract row is suppressed
 *   - Route sync: online → fire-and-forget; offline → enqueue
 */
export async function handleVisionExtraction(params: {
  result:           VisionResult;
  backendSessionId: string;
  backendAssetId:   string | null;
  isOnline:         boolean;
  syncCbs:          ExtractionSyncCallbacks;
}): Promise<ExtractionHandlerOutcome> {
  const { result, backendSessionId, backendAssetId, isOnline, syncCbs } = params;

  // Only openai_vision writes an extraction_results row.
  // tesseract_fallback is covered by the OCR path via handleOcrExtraction.
  if (result.source !== 'openai_vision') return 'skipped';

  // Mark asset so handleOcrExtraction suppresses the duplicate Tesseract row.
  extractionCoordinator.markVisionExtracted(result.assetId);

  const extractionId = crypto.randomUUID();
  const payload = { extractionId, backendSessionId, backendAssetId, visionResult: result };

  if (isOnline) {
    syncCbs.onBeforeOnlineSync();
    syncUpsertVisionExtraction(payload, {
      onSyncing:   syncCbs.onSyncing,
      onSynced:    syncCbs.onSynced,
      onSyncError: syncCbs.onSyncError,
      onOffline:   syncCbs.onOffline,
    }).catch(() => {});

    // Update session-level extraction metadata (fire-and-forget, no UI impact).
    syncUpdateSessionExtractionMeta({
      backendSessionId: backendSessionId,
      source:           result.source,
      confidence:       result.fields.confidence,
      durationMs:       result.durationMs,
    }, { onSyncing: () => {}, onSynced: () => {}, onSyncError: () => {}, onOffline: () => {} })
      .catch(() => {});

    return 'synced';
  }

  await enqueueOp('upsert_vision_extraction', backendSessionId, payload);
  syncCbs.onOfflineQueued();
  return 'queued';
}

/**
 * Handle an OCR extraction result.
 *
 * Responsibilities:
 *   - Dedup: skip if Vision already wrote a row for this asset
 *   - Route sync: online → fire-and-forget; offline → enqueue
 */
export async function handleOcrExtraction(params: {
  result:           OcrResult;
  backendSessionId: string;
  backendAssetId:   string | null;
  isOnline:         boolean;
  syncCbs:          ExtractionSyncCallbacks;
}): Promise<ExtractionHandlerOutcome> {
  const { result, backendSessionId, backendAssetId, isOnline, syncCbs } = params;

  // Vision already wrote the extraction_results row for this asset.
  if (extractionCoordinator.hasVisionExtraction(result.assetId)) return 'skipped';

  const extractionId = crypto.randomUUID();
  const payload = { extractionId, backendSessionId, backendAssetId, ocrResult: result };

  if (isOnline) {
    syncCbs.onBeforeOnlineSync();
    syncUpsertOcrExtraction(payload, {
      onSyncing:   syncCbs.onSyncing,
      onSynced:    syncCbs.onSynced,
      onSyncError: syncCbs.onSyncError,
      onOffline:   syncCbs.onOffline,
    }).catch(() => {});
    return 'synced';
  }

  await enqueueOp('upsert_ocr_extraction', backendSessionId, payload);
  syncCbs.onOfflineQueued();
  return 'queued';
}

/**
 * Handle a QR extraction result.
 *
 * Responsibilities:
 *   - Route sync: online → fire-and-forget; offline → enqueue
 */
export async function handleQrExtraction(params: {
  parsed:           ParsedContact;
  backendSessionId: string;
  durationMs:       number;
  isOnline:         boolean;
  syncCbs:          ExtractionSyncCallbacks;
}): Promise<ExtractionHandlerOutcome> {
  const { parsed, backendSessionId, durationMs, isOnline, syncCbs } = params;

  const extractionId = crypto.randomUUID();
  const payload = { extractionId, backendSessionId, parsed, durationMs };

  if (isOnline) {
    syncCbs.onBeforeOnlineSync();
    syncUpsertQrExtraction(payload, {
      onSyncing:   syncCbs.onSyncing,
      onSynced:    syncCbs.onSynced,
      onSyncError: syncCbs.onSyncError,
      onOffline:   syncCbs.onOffline,
    }).catch(() => {});
    return 'synced';
  }

  await enqueueOp('upsert_qr_extraction', backendSessionId, payload);
  syncCbs.onOfflineQueued();
  return 'queued';
}

// ─── Pipeline Contract ────────────────────────────────────────────────────────

/**
 * Processing context — the shared mutable pipeline object.
 *
 * Flows through every stage. Each stage may enrich it with new information
 * for downstream stages to consume without re-reading the session.
 *
 * `backendSessionId` is required (non-nullable). Callers must verify the session
 * has a confirmed backend ID before building the context.
 */
export interface ProcessingContext {
  /** Full CaptureSession snapshot at the moment processing is triggered. */
  session:          CaptureSession;
  /**
   * Confirmed backend session ID (FK to capture_sessions.id).
   * Required — callers guard against null before building the context.
   */
  backendSessionId: string;
  /** Event code — passed to lead_entries and capture_sessions. */
  eventCode:        string | null;
  /** Event ID — FK to events table. */
  eventId:          string | null;
  /** Event display name — stored on local completed_leads record. */
  eventName:        string | null;
  /**
   * Key used to upsert the completed_leads IndexedDB record.
   * Frontend-generated before building the context so offline and online paths
   * reference the same local record.
   */
  completedLeadId:  string;
  /** Whether the device has network connectivity at the moment Save & Next was tapped. */
  isOnline:         boolean;

  // ── Enrichment fields — written by pipeline stages ─────────────────────────

  /**
   * Written by executeExtractionStage.
   * Source of the extraction that produced the contact fields
   * (e.g. 'openai_vision', 'tesseract_ocr', undefined for manual/QR).
   */
  extractionSource?: string | null;

  /**
   * Written by executeReviewStage.
   * null until the Review Stage runs; always set after processCaptureSession starts.
   */
  review?: ReviewResult;

  /**
   * Written by the terminal stage (Promotion).
   * processCaptureSession reads this and returns it to the UI.
   */
  result?: ProcessingResult;
}

/**
 * The three outcomes the UI must handle after calling processCaptureSession.
 */
export type ProcessingOutcome = 'success' | 'queued' | 'failed';

/**
 * Processing result — the only value the UI needs from the engine.
 *
 *   'success' or 'queued': reset form, show toast.
 *   'failed': keep form visible, surface error.
 */
export interface ProcessingResult {
  outcome: ProcessingOutcome;
  leadId:  string | null;
  error:   string | null;
}

// ─── Pipeline stages ──────────────────────────────────────────────────────────
// All stages share the signature: (ctx: ProcessingContext) => void | Promise<void>
// Stages enrich ctx for downstream stages. The terminal stage writes ctx.result.

/**
 * Evidence Stage — registers pending notes image and triggers upload.
 * Non-terminal — does not write ctx.result.
 */
function executeEvidenceStage(ctx: ProcessingContext): void {
  const { session, backendSessionId } = ctx;

  if (typeof session.draftData.notesImageDataUrl === 'string') {
    evidenceManager.register({
      type:              'notes_image',
      sessionId:         backendSessionId,
      dataUrl:           session.draftData.notesImageDataUrl,
      uploadImmediately: false,
    });
  }
  evidenceManager.onSaveAndNext(backendSessionId);
}

/**
 * Extraction Stage — enriches ctx with extraction metadata from the session draft.
 *
 * Extraction already occurred at capture time (via the real-time event handlers
 * above). This stage reads the resulting metadata from draftData and surfaces it
 * in the context for downstream stages (Promotion, future Review) without them
 * needing to inspect draftData directly.
 *
 * Non-terminal — does not write ctx.result.
 */
function executeExtractionStage(ctx: ProcessingContext): void {
  ctx.extractionSource = (ctx.session.draftData.extractionSource as string | undefined) ?? null;
}

/**
 * Validation Stage — gates promotion on data completeness.
 *
 * Delegates to validationEngine (CaptureValidationEngine) which is the single
 * source of truth for what constitutes a promotable capture. If validation fails,
 * writes ctx.result immediately so processCaptureSession can return early —
 * Review and Promotion stages do not execute.
 *
 * Terminal when invalid — writes ctx.result with outcome 'failed'.
 * Non-terminal when valid — does not write ctx.result.
 */
function executeValidationStage(ctx: ProcessingContext): void {
  const result = validationEngine.validate(ctx.session.draftData);
  if (!result.valid) {
    ctx.result = {
      outcome: 'failed',
      leadId:  null,
      error:   result.error?.message ?? 'Capture has no data to save',
    };
  }
}

/**
 * Review Stage — evaluates whether the captured lead requires manual review.
 *
 * Delegates to reviewEngine (CaptureReviewEngine) which applies the configured
 * rule set. Currently one rule: LOW_CONFIDENCE fires when AI extraction
 * confidence falls below ReviewConfig.minimumConfidence (default 50).
 *
 * Confidence is read from draftData.extractionConfidence (0–1 float stored at
 * card capture time). The value is normalised to 0–100 before evaluation.
 * When confidence is absent (manual entry, QR, or not yet propagated), the rule
 * cannot fire and review.required is false.
 *
 * Non-terminal — writes ctx.review; does not write ctx.result.
 */
function executeReviewStage(ctx: ProcessingContext): void {
  const rawConfidence = ctx.session.draftData.extractionConfidence;
  const confidencePercent =
    typeof rawConfidence === 'number'
      ? rawConfidence <= 1
        ? rawConfidence * 100   // normalise 0-1 → 0-100
        : rawConfidence          // already 0-100
      : null;

  ctx.review = reviewEngine.evaluate(confidencePercent);
}

/**
 * Promotion Stage — inserts the lead_entries row and updates the capture session.
 *
 * Owns all promotion branching:
 *   - Offline: queues a promote_session op (with requiresReview) and returns 'queued'.
 *   - Online retryable error: same — queue and return 'queued'.
 *   - Online non-retryable error: returns 'failed'.
 *   - Online success: returns 'success'.
 *
 * Terminal stage — writes ctx.result. Never throws.
 */
async function executePromotionStage(ctx: ProcessingContext): Promise<void> {
  const { session, backendSessionId, eventCode, eventId, eventName, completedLeadId, isOnline } = ctx;

  const promotionOptions: PromoteSessionOptions = {
    backendSessionId,
    draftData:      session.draftData,
    eventCode,
    completedLeadId,
    captureMethod:  session.captureMethod,
    eventId,
    eventName,
    requiresReview: ctx.review?.required ?? false,
  };

  const _queuePromotion = async (): Promise<void> => {
    const lead = buildCompletedLead(
      completedLeadId, session.captureMethod, session.draftData,
      backendSessionId, eventId, eventName,
    );
    lead.status = 'pending_sync';
    await saveCompletedLead(lead);
    await enqueueOp('promote_session', backendSessionId, promotionOptions);
    ctx.result = { outcome: 'queued', leadId: null, error: null };
  };

  if (!isOnline) {
    await _queuePromotion();
    return;
  }

  const result = await executePromotion(promotionOptions);

  if (result.error) {
    const isNonRetryable =
      result.error.includes('Not authenticated') ||
      result.error.includes('JWT')               ||
      result.error.includes('row-level security')||
      result.error.includes('policy')            ||
      result.error.includes('permission');

    if (isNonRetryable) {
      ctx.result = { outcome: 'failed', leadId: null, error: result.error };
    } else {
      await _queuePromotion();
    }
    return;
  }

  ctx.result = { outcome: 'success', leadId: result.leadId, error: null };
}

// ─── Engine entry point ───────────────────────────────────────────────────────

/**
 * Single entry point for lead capture processing at Save & Next.
 *
 * Orchestrates pipeline stages in sequence. Each stage enriches the shared
 * ProcessingContext. The terminal stage writes ctx.result, returned to the UI.
 *
 *   1. Evidence Stage    — notes image upload
 *   2. Extraction Stage  — enriches ctx.extractionSource
 *   3. Validation Stage  — gates on data completeness; short-circuits on failure
 *   4. Review Stage      — evaluates ctx.review (LOW_CONFIDENCE rule)
 *   5. Promotion Stage   — lead_entries INSERT, writes ctx.result
 */
export async function processCaptureSession(
  ctx: ProcessingContext,
): Promise<ProcessingResult> {
  executeEvidenceStage(ctx);
  executeExtractionStage(ctx);
  executeValidationStage(ctx);
  if (ctx.result) return ctx.result;   // validation failed — skip Review + Promotion
  executeReviewStage(ctx);
  await executePromotionStage(ctx);
  // ctx.result is always set by executePromotionStage
  return ctx.result!;
}
