// Review metadata types and helpers for the Lead Detail page.
//
// review_metadata is a JSONB column on capture_sessions, written once by the
// ALPE pipeline's review stage (persistReviewResult). The Lead Detail page
// reads it via lead_entries.capture_session_id → capture_sessions.review_metadata
// to display why a lead was marked REQUIRES_REVIEW.

// ─── Review reason labels ────────────────────────────────────────────────────

export const REVIEW_REASON_LABELS: Record<string, string> = {
  UNCERTAIN_FIELD:       'One or more fields were identified as uncertain by AI.',
  LOW_CONFIDENCE:        'Overall extraction confidence is below the configured threshold.',
  LOW_FIELD_CONFIDENCE:  'One or more extracted fields have low confidence.',
  INSUFFICIENT_EXTRACTION: 'Very little information was successfully extracted.',
  INVALID_PHONE:         'An extracted phone number appears invalid.',
  INVALID_EMAIL:         'An extracted email address appears invalid.',
  INVALID_WEBSITE:       'An extracted website appears invalid.',
  EXTRACTION_FAILED:     'AI extraction failed.',
  QR_NO_EXTRACTION:      'QR extraction did not produce usable information.',
  SUSPICIOUS_CONTACT:    'One or more extracted contact details appear suspicious.',
};

// ─── Violation shapes (mirror captureReviewEngine.ts) ─────────────────────────

export interface FieldConfidenceViolation {
  field:  string;
  value:  string;
  index?: number;
  score:  number; // 0–1
}

export interface ContactValidationViolation {
  field:  'phoneNumbers' | 'emails' | 'website';
  value:  string;
  index?: number;
  reason: string;
  detail: string;
}

export interface FieldStatusViolation {
  field:  string;
  index?: number;
  status: 'uncertain';
  value:  string | null;
}

// ─── review_metadata JSONB shape ─────────────────────────────────────────────

export interface ReviewMetadata {
  required:                  boolean;
  reason:                    string | null;
  reasons:                   string[];
  confidence:                number | null;
  fieldConfidenceViolations: FieldConfidenceViolation[] | null;
  fieldStatusViolations:     FieldStatusViolation[] | null;
  contactViolations:         ContactValidationViolation[] | null;
}

// ─── Field display helpers ───────────────────────────────────────────────────

const FIELD_LABELS: Record<string, string> = {
  fullName:     'Full Name',
  company:      'Company',
  designation:  'Designation',
  website:      'Website',
  address:      'Address',
  phoneNumbers: 'Phone Number',
  emails:       'Email Address',
};

export function fieldLabel(field: string): string {
  return FIELD_LABELS[field] ?? field;
}

export function formatConfidencePercent(score: number): string {
  return `${Math.round(score * 100)}%`;
}

// ─── Fetch review metadata for a lead ────────────────────────────────────────

/**
 * Fetch review_metadata from capture_sessions via lead_entries.capture_session_id.
 *
 * Returns null when:
 *   - capture_session_id is null (lead was not created via capture pipeline)
 *   - capture_sessions row not found
 *   - review_metadata is empty '{}' or null
 *
 * Never throws — returns null on any error.
 */
export async function fetchReviewMetadata(
  captureSessionId: string | null,
): Promise<ReviewMetadata | null> {
  if (!captureSessionId) return null;

  try {
    const { supabase } = await import('./supabaseClient');
    const { data, error } = await supabase
      .from('capture_sessions')
      .select('review_metadata')
      .eq('id', captureSessionId)
      .maybeSingle();

    if (error || !data) return null;

    const raw = data.review_metadata;
    if (!raw || typeof raw !== 'object' || Object.keys(raw as Record<string, unknown>).length === 0) {
      return null;
    }

    return raw as ReviewMetadata;
  } catch {
    return null;
  }
}
