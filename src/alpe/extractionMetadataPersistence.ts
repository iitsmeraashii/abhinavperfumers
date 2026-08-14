// ALPE Extraction Metadata Persistence
//
// Dedicated ALPE-owned persistence step that writes extraction metadata
// produced by executeExtractionStage() back to capture_sessions.
//
// This function does NOT perform validation, promotion, lead creation,
// or any business logic. Its sole responsibility is to update the
// extraction-related columns on capture_sessions so that the session
// row reflects the completed AI extraction.

import { supabase } from '../supabaseClient';
import type { DraftData, FieldConfidenceReport, FieldStatusReport } from '../capture/types';
import type { ReviewResult } from '../capture/captureReviewEngine';

/**
 * Extraction metadata collected by executeExtractionStage() and passed
 * to this persistence function. All fields are authoritative values
 * produced inside the ALPE pipeline.
 */
export interface ExtractionMetadata {
  /** Engine that produced the result: 'openai_vision', 'tesseract_fallback', 'qr_parser', 'manual'. */
  source:      string | null;
  /** Lifecycle status: 'done' if extraction produced fields, 'failed' on error, 'skipped' if no evidence. */
  status:      'done' | 'failed' | 'skipped';
  /** Confidence score 0–1 from the extraction engine. */
  confidence:  number | null;
  /** Model-reported per-field confidence. Absent for Tesseract/QR/manual paths. */
  fieldConfidence?: FieldConfidenceReport | null;
  /** Model-reported per-field extraction status. Absent for Tesseract/QR/manual paths. */
  fieldStatus?: FieldStatusReport | null;
  /** DraftData after extraction fields have been merged in. */
  draftData:   DraftData;
}

/**
 * Build the extracted_fields jsonb object from draftData, matching the
 * shape used by the legacy syncUpsertSession: only the five canonical
 * contact fields, omitting empty values.
 */
function buildExtractedFields(draftData: DraftData): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  if (draftData.clientName)  fields.clientName  = draftData.clientName;
  if (draftData.company)     fields.company     = draftData.company;
  if (draftData.phone)       fields.phone       = draftData.phone;
  if (draftData.email)       fields.email       = draftData.email;
  if (draftData.designation) fields.designation = draftData.designation;
  return fields;
}

/**
 * Persist extraction metadata to capture_sessions.
 *
 * Updates ONLY these columns:
 *   - extraction_source
 *   - extraction_status
 *   - extraction_confidence
 *   - extracted_fields
 *
 * Does NOT touch: extracted_entities, raw_extraction, extracted_data,
 * extraction_duration_ms, or any other column.
 *
 * Failures are logged but never throw — the pipeline must continue to
 * validation regardless of whether this persistence succeeded.
 */
export async function persistExtractionMetadata(
  backendSessionId: string,
  metadata: ExtractionMetadata,
): Promise<void> {
  const updatePayload = {
    extraction_source:      metadata.source,
    extraction_status:      metadata.status,
    extraction_confidence:  metadata.confidence,
    extracted_fields:       buildExtractedFields(metadata.draftData),
    extraction_metadata: {
      source:          metadata.source,
      confidence:      metadata.confidence,
      fieldConfidence: metadata.fieldConfidence ?? null,
      fieldStatus:     metadata.fieldStatus ?? null,
      fieldsExtracted: buildExtractedFields(metadata.draftData),
    },
  };

  try {
    const { error } = await supabase
      .from('capture_sessions')
      .update(updatePayload)
      .eq('id', backendSessionId);

    if (error) {
      console.warn(
        '[ALPE] persistExtractionMetadata failed:',
        error.message,
        { backendSessionId },
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      '[ALPE] persistExtractionMetadata threw:',
      msg,
      { backendSessionId },
    );
  }
}

/**
 * Persist the final review decision to capture_sessions.review_metadata.
 *
 * This is the authoritative historical record of why a lead was (or was not)
 * marked REQUIRES_REVIEW. It is written once during the pipeline's review
 * stage and never reconstructed.
 *
 * Failures are logged but never throw — the pipeline must continue to
 * promotion regardless of whether this persistence succeeded.
 */
export async function persistReviewResult(
  backendSessionId: string,
  review: ReviewResult,
): Promise<void> {
  const reviewMetadata = {
    required:                  review.required,
    reason:                    review.reason,
    reasons:                   review.reasons,
    confidence:                review.confidence,
    fieldConfidenceViolations: review.fieldConfidenceViolations ?? null,
    fieldStatusViolations:     review.fieldStatusViolations ?? null,
    contactViolations:         review.contactViolations ?? null,
  };

  try {
    const { error } = await supabase
      .from('capture_sessions')
      .update({ review_metadata: reviewMetadata })
      .eq('id', backendSessionId);

    if (error) {
      console.warn(
        '[ALPE] persistReviewResult failed:',
        error.message,
        { backendSessionId },
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      '[ALPE] persistReviewResult threw:',
      msg,
      { backendSessionId },
    );
  }
}
