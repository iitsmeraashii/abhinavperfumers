// Review Rule Engine — evaluates whether a captured lead requires manual review.
//
// Design: module singleton, mirrors captureExtractionCoordinator pattern.
// Rules are stateless; configuration is injected at construction time.
//
// Current rules:
//   LOW_CONFIDENCE   — fires when AI extraction confidence is below minimumConfidence.
//   QR_NO_EXTRACTION — fires when a QR scan produced no contact fields, even if
//                      the rep entered data manually afterward.
//
// Future rules (not yet implemented):
//   MISSING_REQUIRED_FIELDS, AMBIGUOUS_CONTACT, etc.

import type { DraftData } from './types';

// ─── Configuration ────────────────────────────────────────────────────────────

export interface ReviewConfig {
  /** Minimum AI extraction confidence (0–100). Below this, LOW_CONFIDENCE fires. */
  minimumConfidence: number;
}

export const DEFAULT_REVIEW_CONFIG: ReviewConfig = {
  minimumConfidence: 50,
};

// ─── Types ────────────────────────────────────────────────────────────────────

export enum ReviewReason {
  LOW_CONFIDENCE   = 'LOW_CONFIDENCE',
  QR_NO_EXTRACTION = 'QR_NO_EXTRACTION',
}

export interface ReviewResult {
  /** Whether the lead requires manual review before promotion. */
  required:   boolean;
  /** The rule that triggered review, or null if none triggered. */
  reason:     ReviewReason | null;
  /**
   * The confidence value (0–100) that was evaluated, or null if no AI
   * extraction confidence was available for this capture session.
   */
  confidence: number | null;
}

// ─── Rule Engine ──────────────────────────────────────────────────────────────

class CaptureReviewEngine {
  private readonly config: ReviewConfig;

  constructor(config: ReviewConfig = DEFAULT_REVIEW_CONFIG) {
    this.config = config;
  }

  /**
   * Evaluate review rules for a capture session.
   *
   * @param data                 Full DraftData — needed for QR_NO_EXTRACTION rule.
   * @param extractionConfidence AI extraction confidence on a 0–100 scale,
   *                             or null if no AI extraction occurred.
   * @returns ReviewResult — always non-null; required=false when no rule fires.
   */
  evaluate(data: DraftData, extractionConfidence: number | null): ReviewResult {
    // Rule: QR_NO_EXTRACTION
    // Fires when a QR scan was captured but produced no extractable contact
    // fields. The rep may have entered data manually — the lead is still
    // flagged REQUIRES_REVIEW so an admin can verify the raw QR payload.
    if (data.qrExtractionEmpty) {
      return {
        required:   true,
        reason:     ReviewReason.QR_NO_EXTRACTION,
        confidence: null,
      };
    }

    // Rule: LOW_CONFIDENCE
    // Fires only when AI extraction confidence is known and below the minimum.
    // When confidence is null (manual entry, QR, or confidence not yet
    // propagated into the draft), the rule cannot fire — review is not required.
    if (extractionConfidence !== null) {
      if (extractionConfidence < this.config.minimumConfidence) {
        return {
          required:   true,
          reason:     ReviewReason.LOW_CONFIDENCE,
          confidence: extractionConfidence,
        };
      }
      return { required: false, reason: null, confidence: extractionConfidence };
    }

    return { required: false, reason: null, confidence: null };
  }
}

export const reviewEngine = new CaptureReviewEngine();
