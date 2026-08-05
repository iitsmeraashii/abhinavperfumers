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

  extractionSource?: string | null;
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

function executeExtractionStage(ctx: ProcessingContext): void {
  alpeLog('Pipeline stage → AI_EXTRACTION');
  updateAlpeRuntime({ currentPipelineStage: 'AI_EXTRACTION' });
  ctx.extractionSource = (ctx.session.draftData.extractionSource as string | undefined) ?? null;
}

function executeValidationStage(ctx: ProcessingContext): void {
  alpeLog('Pipeline stage → VALIDATION');
  updateAlpeRuntime({ currentPipelineStage: 'VALIDATION' });
  const strategies = ctx.plan.strategies;
  const result = strategies.validation.validate(ctx.session.draftData);
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
}

async function executePromotionStage(ctx: ProcessingContext): Promise<void> {
  alpeLog('Pipeline stage → PROMOTION');
  updateAlpeRuntime({ currentPipelineStage: 'PROMOTION' });
  alpeLog('Promotion start', { backendSessionId: ctx.backendSessionId });
  const { session, backendSessionId, eventCode, eventId, eventName, completedLeadId, plan } = ctx;
  const strategies = plan.strategies;
  const isOnline = plan.isOnline;

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
  executeExtractionStage(ctx);
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
