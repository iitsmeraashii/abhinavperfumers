// Capture Profile Strategies — define WHAT happens for each capture behavior.
//
// Each strategy interface declares the decisions a profile makes. The CRM
// profile implements them to match current behavior exactly. Future profiles
// (Exhibition, Kiosk, etc.) implement the same interfaces with different
// decisions, without touching shared services.
//
// Shared services (evidenceManager, validationEngine, promotionService,
// captureBackendSync, offlineQueue) remain profile-agnostic. They execute
// the HOW and never branch on profile identity.

import type { DraftData } from './types';
import type { ValidationResult } from './captureValidationEngine';
import type { ReviewResult } from './captureReviewEngine';
import type { ProcessingResult } from '../alpe/pipeline';
import type { PromoteSessionOptions } from './capturePromotionService';

// ─── Strategy interfaces ──────────────────────────────────────────────────────

/**
 * Validation Strategy — decides whether a capture is eligible for promotion.
 * The strategy delegates the actual rule evaluation to the shared
 * CaptureValidationEngine but may pre/post-process or bypass it entirely.
 */
export interface ValidationStrategy {
  validate(data: DraftData): ValidationResult;
}

/**
 * Review Strategy — decides whether a captured lead requires manual review
 * before promotion. Delegates rule evaluation to CaptureReviewEngine.
 */
export interface ReviewStrategy {
  evaluate(data: DraftData, extractionConfidence: number | null): ReviewResult;
}

/**
 * AI Strategy — controls extraction flow behavior.
 *
 *   waitForExtraction: whether the UI blocks on AI/OCR results before showing
 *                      the review form. CRM waits; Exhibition will not.
 *   skipReviewForm:    whether the capture journey skips the review form and
 *                      saves immediately. CRM shows the form; Exhibition will skip.
 */
export interface AIStrategy {
  waitForExtraction: boolean;
  skipReviewForm:    boolean;
}

/**
 * Queue Strategy — controls how captured data is queued for backend sync.
 *
 *   queueOnDisconnect: whether ops are enqueued to IndexedDB when offline
 *                      (both CRM and Exhibition do this today).
 */
export interface QueueStrategy {
  queueOnDisconnect: boolean;
}

/**
 * Upload Strategy — controls evidence upload timing.
 *
 *   uploadCardsImmediately: upload business card images as soon as captured.
 *   uploadNotesOnSave:      upload notes images at Save & Next.
 */
export interface UploadStrategy {
  uploadCardsImmediately: boolean;
  uploadNotesOnSave:      boolean;
  uploadVoiceOnSave:      boolean;
}

/**
 * Promotion Strategy — wraps the shared executePromotion call with
 * profile-specific options (e.g. requiresReview flag derivation).
 *
 * Returns the options object that the shared promotion service consumes.
 */
export interface PromotionStrategy {
  buildOptions(params: PromotionStrategyParams): PromoteSessionOptions;
}

export interface PromotionStrategyParams {
  backendSessionId: string;
  draftData:        DraftData;
  eventCode:        string | null;
  completedLeadId:  string;
  captureMethod:    DraftData extends { __method: infer M } ? M : unknown;
  eventId:          string | null;
  eventName:        string | null;
  requiresReview:   boolean;
}

/**
 * ProcessingResult Strategy — no-op passthrough; the pipeline result shape
 * is shared. This strategy exists so future profiles can transform the
 * result (e.g. Exhibition may suppress the "queued" toast).
 *
 * Reserved for future use — not wired into the pipeline yet.
 */
export interface ResultStrategy {
  transformResult(result: ProcessingResult): ProcessingResult;
}

/**
 * Bundle of all strategies a profile provides. The ProfileEngine resolves
 * this bundle once and downstream stages read individual strategies from it.
 */
export interface CaptureProfileStrategies {
  validation: ValidationStrategy;
  review:     ReviewStrategy;
  ai:         AIStrategy;
  queue:      QueueStrategy;
  upload:     UploadStrategy;
  promotion:  PromotionStrategy;
  result:     ResultStrategy;
}

// ─── CRM Profile implementation ───────────────────────────────────────────────
// Every method here reproduces the exact behavior that exists today. No logic
// changes — this is a transparent routing layer over the shared services.

import { validationEngine } from './captureValidationEngine';
import { reviewEngine } from './captureReviewEngine';

class CrmValidationStrategy implements ValidationStrategy {
  validate(data: DraftData): ValidationResult {
    return validationEngine.validate(data);
  }
}

class CrmReviewStrategy implements ReviewStrategy {
  evaluate(data: DraftData, extractionConfidence: number | null): ReviewResult {
    return reviewEngine.evaluate(data, extractionConfidence);
  }
}

class CrmAIStrategy implements AIStrategy {
  waitForExtraction = true;
  skipReviewForm    = false;
}

class CrmQueueStrategy implements QueueStrategy {
  queueOnDisconnect = true;
}

class CrmUploadStrategy implements UploadStrategy {
  uploadCardsImmediately = true;
  uploadNotesOnSave      = true;
  uploadVoiceOnSave      = true;
}

class CrmPromotionStrategy implements PromotionStrategy {
  buildOptions(params: PromotionStrategyParams): PromoteSessionOptions {
    return {
      backendSessionId: params.backendSessionId,
      draftData:        params.draftData,
      eventCode:        params.eventCode,
      completedLeadId:  params.completedLeadId,
      captureMethod:    params.captureMethod as PromoteSessionOptions['captureMethod'],
      eventId:          params.eventId,
      eventName:        params.eventName,
      requiresReview:   params.requiresReview,
    };
  }
}


class CrmResultStrategy implements ResultStrategy {
  transformResult(result: ProcessingResult): ProcessingResult {
    return result;
  }
}

const CRM_STRATEGIES: CaptureProfileStrategies = {
  validation: new CrmValidationStrategy(),
  review:     new CrmReviewStrategy(),
  ai:         new CrmAIStrategy(),
  queue:      new CrmQueueStrategy(),
  upload:     new CrmUploadStrategy(),
  promotion:  new CrmPromotionStrategy(),
  result:     new CrmResultStrategy(),
};

// ─── Exhibition Profile implementation ────────────────────────────────────────
// Speed-first: non-blocking capture, deferred extraction, all uploads on save,
// always-queue routing, review skipped, promotion active, result pass-through.

class ExhibitionValidationStrategy implements ValidationStrategy {
  validate(data: DraftData): ValidationResult {
    // Exhibition mode: a lead is valid if it has at least one contact identifier
    // (name, company, phone) OR evidence (business card photo, QR scan).
    // Evidence satisfies the minimum because AI will extract details later.
    const hasName    = !!String(data.clientName ?? '').trim();
    const hasCompany = !!String(data.company    ?? '').trim();
    const hasPhone   = !!String(data.phone      ?? '').trim();
    const hasCard    = !!data.cardFrontAssetId;
    const hasQr      = !!data.rawQr;

    if (hasName || hasCompany || hasPhone || hasCard || hasQr) {
      return { valid: true };
    }

    return {
      valid: false,
      error: {
        message: 'At least one identifier is required — capture a business card, scan a QR code, or enter a name, company, or phone number to save this lead',
      },
    };
  }
}

class ExhibitionReviewStrategy implements ReviewStrategy {
  evaluate(data: DraftData, extractionConfidence: number | null): ReviewResult {
    return reviewEngine.evaluate(data, extractionConfidence);
  }
}

class ExhibitionAIStrategy implements AIStrategy {
  waitForExtraction = false;
  skipReviewForm    = true;
}

class ExhibitionQueueStrategy implements QueueStrategy {
  queueOnDisconnect = true;
}

class ExhibitionUploadStrategy implements UploadStrategy {
  uploadCardsImmediately = false;
  uploadNotesOnSave      = true;
  uploadVoiceOnSave      = true;
}

class ExhibitionPromotionStrategy implements PromotionStrategy {
  buildOptions(params: PromotionStrategyParams): PromoteSessionOptions {
    return {
      backendSessionId: params.backendSessionId,
      draftData:        params.draftData,
      eventCode:        params.eventCode,
      completedLeadId:  params.completedLeadId,
      captureMethod:    params.captureMethod as PromoteSessionOptions['captureMethod'],
      eventId:          params.eventId,
      eventName:        params.eventName,
      requiresReview:   params.requiresReview,
    };
  }
}

class ExhibitionResultStrategy implements ResultStrategy {
  transformResult(result: ProcessingResult): ProcessingResult {
    return result;
  }
}

const EXHIBITION_STRATEGIES: CaptureProfileStrategies = {
  validation: new ExhibitionValidationStrategy(),
  review:     new ExhibitionReviewStrategy(),
  ai:         new ExhibitionAIStrategy(),
  queue:      new ExhibitionQueueStrategy(),
  upload:     new ExhibitionUploadStrategy(),
  promotion:  new ExhibitionPromotionStrategy(),
  result:     new ExhibitionResultStrategy(),
};

// ─── Profile registry ─────────────────────────────────────────────────────────
// Future profiles register here. Adding a profile = adding a new entry.
// Shared services never change.

import type { CaptureProfile } from './captureProfile';

const PROFILE_STRATEGY_REGISTRY: Partial<Record<CaptureProfile, CaptureProfileStrategies>> = {
  CRM:        CRM_STRATEGIES,
  EXHIBITION: EXHIBITION_STRATEGIES,
};

export function getProfileStrategies(profile: CaptureProfile): CaptureProfileStrategies {
  const strategies = PROFILE_STRATEGY_REGISTRY[profile];
  if (!strategies) {
    throw new Error(`No strategies registered for capture profile: ${profile}`);
  }
  return strategies;
}

export { CRM_STRATEGIES };
