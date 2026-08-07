// ALPE Processing Pipeline — the stage orchestration that the ALPE Worker
// executes for each claimed job. Moved here from the legacy synchronous
// Capture Processing Engine so that ALPE owns the full processing lifecycle.
//
// Stage contract:
//   Every pipeline stage has the same signature:
//     (ctx: ProcessingContext) => void | Promise<void>
//   Stages operate on ProcessingContext — the shared mutable pipeline object.
//   Stages enrich ProcessingContext by writing outputs into it for downstream
//   stages. The terminal stage (Promotion) writes the final ProcessingResult
//   into ctx.result. processCaptureSession reads ctx.result and returns it.
//
// Owned pipeline stages:
//   executeEvidenceStage    — notes image upload (fire-and-forget)
//   executeExtractionStage  — enriches context with extraction metadata
//   executeValidationStage  — gates promotion on data completeness
//   executeReviewStage      — evaluates LOW_CONFIDENCE rule
//   executePromotionStage   — lead_entries INSERT, terminal stage

import { evidenceManager }            from '../capture/captureEvidenceManager';
import type { ReviewResult }           from '../capture/captureReviewEngine';
import { executionEngine } from '../capture/CaptureExecutionEngine';
import type { ExecutionPlan } from '../capture/CaptureExecutionEngine';
import { buildCompletedLead, saveCompletedLead } from '../capture/completedLeadsStorage';
import type { CaptureSession } from '../capture/types';
import { alpeLog, updateAlpeRuntime } from './diagnostics';
import { supabase } from '../supabaseClient';

function traceStage(backendSessionId: string, stage: string, payload: Record<string, unknown>): void {
  const ts = new Date().toISOString();
  const entry = { stage, ts, ...payload };
  console.log(`[ALPE TRACE] ${stage}`, entry);
  try {
    supabase.from('alpe_runtime_dumps').insert({
      id: `trace_${backendSessionId}_${stage}_${ts}`,
      job_id: backendSessionId,
      dump_point: `TRACE:${stage}`,
      dump_data: entry,
    }).then(() => {}, () => {});
  } catch { /* ignore */ }
}
import type { EvidenceAssets } from './assetReference';
import type { ResolvedEvidenceGroup } from './evidenceResolver';
import { resolveAllEvidence } from './evidenceResolver';
import { extractBusinessCard, extractQr } from './extractionService';
import type { ExtractionOutcome } from './extractionService';

// ─── Pipeline Contract ────────────────────────────────────────────────────────

/**
 * Processing context — the shared mutable pipeline object.
 *
 * Flows through every stage. Each stage may enrich it with new information
 * for downstream stages to consume without re-reading the session.
 */
export interface ProcessingContext {
  session:          CaptureSession;
  backendSessionId: string;
  eventCode:        string | null;
  eventId:          string | null;
  eventName:        string | null;
  completedLeadId:  string;
  plan:             ExecutionPlan;

  /** Canonical evidence references hydrated from capture_assets by the Worker. */
  evidence: EvidenceAssets;

  /** Resolved evidence payloads produced by the Evidence Resolver stage. */
  resolvedEvidence?: ResolvedEvidenceGroup;

  extractionSource?:    string | null;
  extractionConfidence?: number | null;
  review?: ReviewResult;
  result?: ProcessingResult;
}

export type ProcessingOutcome = 'success' | 'queued' | 'failed';

export interface ProcessingResult {
  outcome: ProcessingOutcome;
  leadId:  string | null;
  error:   string | null;
}

// ─── Pipeline stages ──────────────────────────────────────────────────────────

function executeEvidenceStage(ctx: ProcessingContext): void {
  alpeLog('Pipeline stage → UPLOAD_ASSETS');
  updateAlpeRuntime({ currentPipelineStage: 'UPLOAD_ASSETS' });
  const { session, backendSessionId, plan } = ctx;

  if (typeof session.draftData.notesImageDataUrl === 'string') {
    evidenceManager.register({
      type:        'notes_image',
      sessionId:   backendSessionId,
      dataUrl:     session.draftData.notesImageDataUrl,
      uploadTiming: plan.upload.notesImage,
    });
  }
  evidenceManager.onSaveAndNext(backendSessionId);
}

async function executeEvidenceResolutionStage(ctx: ProcessingContext): Promise<void> {
  alpeLog('Pipeline stage → EVIDENCE_RESOLUTION');
  updateAlpeRuntime({ currentPipelineStage: 'EVIDENCE_RESOLUTION' });

  traceStage(ctx.backendSessionId, 'EVIDENCE_RESOLUTION_START', {
    evidenceInput: {
      front: ctx.evidence.businessCard.front,
      back: ctx.evidence.businessCard.back,
      qr: ctx.evidence.qr,
      notesImage: ctx.evidence.notesImage,
      audio: ctx.evidence.audio,
    },
  });

  const resolved = await resolveAllEvidence(ctx.evidence);
  ctx.resolvedEvidence = resolved;

  // ── TEMPORARY DIAGNOSTICS: resolved evidence ──
  const logEntry = {
    businessCardFront: resolved.businessCard.front.status,
    businessCardBack:  resolved.businessCard.back.status,
    qr:                resolved.qr.status,
    notesImage:        resolved.notesImage.status,
    audio:             resolved.audio.status,
    details: [
      resolved.businessCard.front,
      resolved.businessCard.back,
      resolved.qr,
      resolved.notesImage,
      resolved.audio,
    ].filter(r => r.reference).map(r => ({
      assetType:      r.reference!.assetType,
      assetId:        r.reference!.assetId,
      storagePath:    r.storagePath,
      status:         r.status,
      urlResolved:    r.url !== null,
      blobResolved:   r.blob !== null,
      mimeType:       r.mimeType,
    })),
  };
  console.log('[ALPE DIAG] Evidence Resolution:', logEntry);
  traceStage(ctx.backendSessionId, 'EVIDENCE_RESOLUTION_COMPLETE', logEntry);
  try {
    supabase.from('alpe_runtime_dumps').insert({
      id: `evidence_resolved_${ctx.backendSessionId}`,
      job_id: ctx.backendSessionId,
      dump_point: 'EVIDENCE_RESOLUTION',
      dump_data: logEntry,
    }).then(() => {}, () => {});
  } catch { /* ignore */ }
}

async function executeExtractionStage(ctx: ProcessingContext): Promise<void> {
  alpeLog('Pipeline stage → AI_EXTRACTION');
  updateAlpeRuntime({ currentPipelineStage: 'AI_EXTRACTION' });

  const resolved = ctx.resolvedEvidence;
  traceStage(ctx.backendSessionId, 'AI_EXTRACTION_START', {
    hasResolved: !!resolved,
    frontStatus: resolved?.businessCard.front.status ?? null,
    backStatus: resolved?.businessCard.back.status ?? null,
    qrStatus: resolved?.qr.status ?? null,
  });
  const diag: {
    started: boolean;
    evidenceType: string | null;
    provider: string | null;
    confidence: number | null;
    fieldsExtracted: string[];
    error: string | null;
  } = {
    started: false,
    evidenceType: null,
    provider: null,
    confidence: null,
    fieldsExtracted: [],
    error: null,
  };

  if (!resolved) {
    ctx.extractionSource = (ctx.session.draftData.extractionSource as string | undefined) ?? null;
    diag.error = 'No resolved evidence available';
    logExtractionDiagnostics(ctx, diag);
    return;
  }

  let outcome: ExtractionOutcome | null = null;
  let evidenceType = 'none';

  // Business card — prefer front, fall back to back
  if (resolved.businessCard.front.status === 'resolved' || resolved.businessCard.back.status === 'resolved') {
    evidenceType = 'business_card';
    const cardRef = resolved.businessCard.front.status === 'resolved'
      ? resolved.businessCard.front
      : resolved.businessCard.back;
    diag.started = true;
    diag.evidenceType = evidenceType;
    outcome = await extractBusinessCard(cardRef);
  }
  // QR
  else if (resolved.qr.status === 'resolved') {
    evidenceType = 'qr';
    diag.started = true;
    diag.evidenceType = evidenceType;
    outcome = await extractQr(resolved.qr);
  }
  // Notes image — prepare hook only, no extraction yet
  else if (resolved.notesImage.status === 'resolved') {
    evidenceType = 'notes_image';
    diag.started = true;
    diag.evidenceType = evidenceType;
    diag.provider = 'none (hook only)';
    diag.confidence = 0;
    diag.fieldsExtracted = [];
    logExtractionDiagnostics(ctx, diag);
    ctx.extractionSource = (ctx.session.draftData.extractionSource as string | undefined) ?? null;
    return;
  }

  if (outcome && outcome.fields) {
    const f = outcome.fields;
    diag.provider    = outcome.source;
    diag.confidence  = outcome.confidence;
    diag.error       = outcome.error;

    const extracted: string[] = [];
    if (f.fullName)     extracted.push('clientName');
    if (f.company)      extracted.push('company');
    if (f.designation)  extracted.push('designation');
    if (f.emails.length)      extracted.push('emails');
    if (f.phoneNumbers.length) extracted.push('phoneNumbers');
    if (f.website)      extracted.push('website');
    if (f.address)      extracted.push('address');
    diag.fieldsExtracted = extracted;

    // Merge into draftData (don't overwrite fields already set by manual entry)
    const d = ctx.session.draftData;
    if (!d.clientName  && f.fullName)     d.clientName  = f.fullName;
    if (!d.company     && f.company)      d.company     = f.company;
    if (!d.designation && f.designation)  d.designation = f.designation;
    if (!d.phone       && f.phoneNumbers.length) d.phone = f.phoneNumbers[0];
    if (!d.email       && f.emails.length)       d.email  = f.emails[0];
    if (!d.website     && f.website)      d.website     = f.website;
    if (!d.address     && f.address)      d.address     = f.address;
    if (!d.phoneNumbers?.length && f.phoneNumbers.length) d.phoneNumbers = f.phoneNumbers;
    if (!d.emails?.length       && f.emails.length)       d.emails       = f.emails;
    if (!d.visionRawText)  d.visionRawText  = f.rawText;
    if (!d.ocrRawText)     d.ocrRawText     = f.rawText;
    d.extractionSource    = outcome.source;
    d.extractionConfidence = outcome.confidence;

    ctx.extractionSource    = outcome.source;
    ctx.extractionConfidence = outcome.confidence;
  } else {
    ctx.extractionSource = (ctx.session.draftData.extractionSource as string | undefined) ?? null;
    if (outcome?.error) diag.error = outcome.error;
  }

  logExtractionDiagnostics(ctx, diag);
}

function logExtractionDiagnostics(
  ctx: ProcessingContext,
  diag: {
    started: boolean;
    evidenceType: string | null;
    provider: string | null;
    confidence: number | null;
    fieldsExtracted: string[];
    error: string | null;
  },
): void {
  const logEntry = {
    ...diag,
    backendSessionId: ctx.backendSessionId,
    updatedDraftData: {
      clientName:           ctx.session.draftData.clientName ?? null,
      company:              ctx.session.draftData.company ?? null,
      phone:                ctx.session.draftData.phone ?? null,
      email:                ctx.session.draftData.email ?? null,
      phoneNumbers:         ctx.session.draftData.phoneNumbers ?? null,
      emails:               ctx.session.draftData.emails ?? null,
      extractionSource:    ctx.session.draftData.extractionSource ?? null,
      extractionConfidence: ctx.session.draftData.extractionConfidence ?? null,
    },
    ctxExtractionSource:    ctx.extractionSource ?? null,
    ctxExtractionConfidence: ctx.extractionConfidence ?? null,
  };
  console.log('[ALPE DIAG] AI Extraction:', logEntry);
  traceStage(ctx.backendSessionId, 'AI_EXTRACTION_COMPLETE', logEntry);
  try {
    supabase.from('alpe_runtime_dumps').insert({
      id: `extraction_${ctx.backendSessionId}`,
      job_id: ctx.backendSessionId,
      dump_point: 'AI_EXTRACTION',
      dump_data: logEntry,
    }).then(() => {}, () => {});
  } catch { /* ignore */ }
}

function executeValidationStage(ctx: ProcessingContext): void {
  alpeLog('Pipeline stage → VALIDATION');
  updateAlpeRuntime({ currentPipelineStage: 'VALIDATION' });

  const strategies = ctx.plan.strategies;
  const draftData = ctx.session.draftData;
  traceStage(ctx.backendSessionId, 'VALIDATION_START', {
    clientName: draftData.clientName ?? null,
    company: draftData.company ?? null,
    phone: draftData.phone ?? null,
    email: draftData.email ?? null,
  });
  const result = strategies.validation.validate(draftData);
  traceStage(ctx.backendSessionId, 'VALIDATION_RESULT', { valid: result.valid, error: result.error?.message ?? null });
  if (!result.valid) {
    ctx.result = {
      outcome: 'failed',
      leadId:  null,
      error:   result.error?.message ?? 'Capture has no data to save',
    };
  }
}

function executeReviewStage(ctx: ProcessingContext): void {
  alpeLog('Pipeline stage → DECISION (review)');
  updateAlpeRuntime({ currentPipelineStage: 'DECISION' });
  if (ctx.plan.review === 'SKIP') {
    traceStage(ctx.backendSessionId, 'REVIEW', { skipped: true });
    ctx.review = { required: false, reason: null, confidence: null } as ReviewResult;
    return;
  }
  const strategies = ctx.plan.strategies;
  const rawConfidence = ctx.session.draftData.extractionConfidence;
  const confidencePercent =
    typeof rawConfidence === 'number'
      ? rawConfidence <= 1
        ? rawConfidence * 100
        : rawConfidence
      : null;

  ctx.review = strategies.review.evaluate(ctx.session.draftData, confidencePercent);
  traceStage(ctx.backendSessionId, 'REVIEW', { required: ctx.review.required, reason: ctx.review.reason, confidence: ctx.review.confidence });
}

async function executePromotionStage(ctx: ProcessingContext): Promise<void> {
  alpeLog('Pipeline stage → PROMOTION');
  updateAlpeRuntime({ currentPipelineStage: 'PROMOTION' });
  alpeLog('Promotion start', { backendSessionId: ctx.backendSessionId });
  const { session, backendSessionId, eventCode, eventId, eventName, completedLeadId, plan } = ctx;
  const strategies = plan.strategies;
  const isOnline = plan.isOnline;

  traceStage(backendSessionId, 'PROMOTION_START', { promotion: plan.promotion, isOnline, queue: plan.queue });

  if (plan.promotion === 'SKIP') {
    ctx.result = { outcome: 'queued', leadId: null, error: null };
    return;
  }

  const promotionOptions = strategies.promotion.buildOptions({
    backendSessionId,
    draftData:      session.draftData,
    eventCode,
    completedLeadId,
    captureMethod:  session.captureMethod,
    eventId,
    eventName,
    requiresReview: ctx.review?.required ?? false,
  });

  const _queuePromotion = async (): Promise<void> => {
    const lead = buildCompletedLead(
      completedLeadId, session.captureMethod, session.draftData,
      backendSessionId, eventId, eventName,
    );
    lead.status = 'pending_sync';
    await saveCompletedLead(lead);
    await executionEngine.routePromotion(plan.queue, false, backendSessionId, promotionOptions);
    ctx.result = { outcome: 'queued', leadId: null, error: null };
  };

  const routeResult = await executionEngine.routePromotion(plan.queue, isOnline, backendSessionId, promotionOptions);
  if (routeResult.queued) {
    await _queuePromotion();
    return;
  }

  const result = routeResult.result;

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
  traceStage(backendSessionId, 'PROMOTION_COMPLETE', { outcome: 'success', leadId: result.leadId });
  alpeLog('Promotion completion', { outcome: 'success', leadId: result.leadId });
}

// ─── Engine entry point ───────────────────────────────────────────────────────

export async function processCaptureSession(
  ctx: ProcessingContext,
): Promise<ProcessingResult> {
  alpeLog('Pipeline stage → LOAD_CONTEXT');
  updateAlpeRuntime({ currentPipelineStage: 'LOAD_CONTEXT' });
  const strategies = ctx.plan.strategies;
  executeEvidenceStage(ctx);
  await executeEvidenceResolutionStage(ctx);
  await executeExtractionStage(ctx);
  executeValidationStage(ctx);
  if (ctx.result) {
    return ctx.plan.result === 'SUPPRESS_TOAST'
      ? strategies.result.transformResult(ctx.result)
      : ctx.result;
  }
  executeReviewStage(ctx);
  await executePromotionStage(ctx);
  alpeLog('Pipeline stage → COMPLETE');
  updateAlpeRuntime({ currentPipelineStage: 'COMPLETE' });
  return ctx.plan.result === 'SUPPRESS_TOAST'
    ? strategies.result.transformResult(ctx.result!)
    : ctx.result!;
}
