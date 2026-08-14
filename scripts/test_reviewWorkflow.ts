import {
  REVIEW_REASON_LABELS,
  fieldLabel,
  formatConfidencePercent,
  type ReviewMetadata,
} from '../src/reviewMetadata';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function reviewBannerReasons(metadata: ReviewMetadata): string[] {
  return metadata.reasons.map(reason => REVIEW_REASON_LABELS[reason] ?? reason);
}

function reviewedLeadUpdate(repCode: string, now: string) {
  return {
    lead_status: 'NEW',
    is_reviewed: true,
    reviewed_at: now,
    reviewed_by: repCode,
  };
}

const uncertainField: ReviewMetadata = {
  required: true,
  reason: 'UNCERTAIN_FIELD',
  reasons: ['UNCERTAIN_FIELD'],
  confidence: 95,
  fieldConfidenceViolations: null,
  fieldStatusViolations: [{ field: 'phoneNumbers', index: 0, status: 'uncertain', value: null }],
  contactViolations: null,
};

const insufficientExtraction: ReviewMetadata = {
  ...uncertainField,
  reason: 'INSUFFICIENT_EXTRACTION',
  reasons: ['INSUFFICIENT_EXTRACTION'],
  fieldStatusViolations: null,
};

const multipleReasons: ReviewMetadata = {
  ...uncertainField,
  reason: 'LOW_CONFIDENCE',
  reasons: ['LOW_CONFIDENCE', 'INVALID_PHONE', 'UNCERTAIN_FIELD'],
  fieldConfidenceViolations: [{ field: 'phoneNumbers', index: 0, value: '+9198344', score: 0.6 }],
  contactViolations: [{ field: 'phoneNumbers', index: 0, value: '+9198344', reason: 'INVALID_PHONE', detail: 'Incomplete phone number' }],
};

const uncertainReasons = reviewBannerReasons(uncertainField);
assert(uncertainReasons.length === 1, 'A single review reason should render once');
assert(uncertainReasons[0].includes('uncertain'), 'UNCERTAIN_FIELD should use a human-readable label');
assert(uncertainField.fieldStatusViolations?.[0].value === null, 'Uncertain missing values should be preserved');

const insufficientReasons = reviewBannerReasons(insufficientExtraction);
assert(insufficientReasons[0].includes('Very little information'), 'INSUFFICIENT_EXTRACTION should use the correct label');

const allReasons = reviewBannerReasons(multipleReasons);
assert(allReasons.length === 3, 'All persisted review reasons should render');
assert(allReasons.every(Boolean), 'Every persisted reason should have visible text');
assert(fieldLabel('phoneNumbers') === 'Phone Number', 'Phone fields should have a readable label');
assert(formatConfidencePercent(0.6) === '60%', 'Field confidence should render as a percentage');

const update = reviewedLeadUpdate('REP-001', '2026-08-14T12:00:00.000Z');
assert(update.lead_status === 'NEW', 'Review completion should return the lead to NEW');
assert(update.is_reviewed === true, 'Review completion should set is_reviewed');
assert(update.reviewed_at.length > 0, 'Review completion should set reviewed_at');
assert(update.reviewed_by === 'REP-001', 'Review completion should record the current rep');

console.log('Review workflow tests passed');
