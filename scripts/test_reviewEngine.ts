// Test script for captureReviewEngine deterministic contact validation.
// Run via: npx esbuild test_reviewEngine.ts --bundle --platform=node --format=cjs --alias:../supabaseClient=./test_supabase_stub.ts --outfile=test_reviewEngine.cjs && node test_reviewEngine.cjs

import { reviewEngine, ReviewReason } from '../src/capture/captureReviewEngine';
import type { ExtractionContext } from '../src/capture/captureReviewEngine';
import type { DraftData, FieldConfidenceReport, FieldStatusReport } from '../src/capture/types';
import type { ReviewResult, FieldStatusViolation } from '../src/capture/captureReviewEngine';

let passed = 0;
let failed = 0;

function makeDraft(overrides: Partial<DraftData> = {}): DraftData {
  return {
    clientName: '',
    company: '',
    designation: '',
    phone: '',
    email: '',
    website: '',
    address: '',
    phoneNumbers: [],
    emails: [],
    notes: '',
    ...overrides,
  } as DraftData;
}

function assert(condition: boolean, message: string): void {
  if (condition) {
    passed++;
    console.log(`  PASS: ${message}`);
  } else {
    failed++;
    console.error(`  FAIL: ${message}`);
  }
}

function assertReasons(result: { reasons: ReviewReason[] }, expected: ReviewReason[], label: string): void {
  for (const r of expected) {
    assert(result.reasons.includes(r), `${label} — includes ${r}`);
  }
  assert(result.reasons.length === expected.length, `${label} — reasons count = ${expected.length} (got ${result.reasons.length}: ${result.reasons.join(', ')})`);
}

// ─── TEST 1 ──────────────────────────────────────────────────────────────────
// overall = 0.95, phone = "+9198344", phone confidence = 0.85
// Expected: REQUIRES_REVIEW, reason includes INVALID_PHONE
console.log('\nTEST 1: overall 95%, phone "+9198344", phone confidence 0.85');
{
  const data = makeDraft({
    clientName: 'Rahul Sharma',
    company: 'Tech Corp',
    phoneNumbers: ['+9198344'],
  });
  const fc: FieldConfidenceReport = { phoneNumbers: [0.85], fullName: 0.95, company: 0.95 };
  const ctx: ExtractionContext = { status: 'done', fieldConfidence: fc };
  const result = reviewEngine.evaluate(data, 95, ctx);
  assert(result.required, 'TEST 1 — required = true');
  assert(result.reasons.includes(ReviewReason.INVALID_PHONE), 'TEST 1 — includes INVALID_PHONE');
  assert(!!result.contactViolations, 'TEST 1 — has contactViolations');
  if (result.contactViolations) {
    assert(result.contactViolations[0]?.field === 'phoneNumbers', 'TEST 1 — violation field = phoneNumbers');
    assert(result.contactViolations[0]?.index === 0, 'TEST 1 — violation index = 0');
    assert(result.contactViolations[0]?.value === '+9198344', 'TEST 1 — violation value = +9198344');
  }
}

// ─── TEST 2 ──────────────────────────────────────────────────────────────────
// overall = 0.95, phone = valid 10-digit Indian mobile, phone confidence = 0.85
// Expected: NEW (no review)
console.log('\nTEST 2: overall 95%, valid Indian mobile, phone confidence 0.85');
{
  const data = makeDraft({
    clientName: 'Rahul Sharma',
    company: 'Tech Corp',
    phoneNumbers: ['+919876543210'],
  });
  const fc: FieldConfidenceReport = { phoneNumbers: [0.85], fullName: 0.95, company: 0.95 };
  const ctx: ExtractionContext = { status: 'done', fieldConfidence: fc };
  const result = reviewEngine.evaluate(data, 95, ctx);
  assert(!result.required, 'TEST 2 — required = false (no review)');
  assert(result.reasons.length === 0, 'TEST 2 — no reasons');
}

// ─── TEST 3 ──────────────────────────────────────────────────────────────────
// overall = 0.95, phone = valid, phone confidence = 0.60
// Expected: REQUIRES_REVIEW, reason includes LOW_FIELD_CONFIDENCE
console.log('\nTEST 3: overall 95%, valid phone, phone confidence 0.60');
{
  const data = makeDraft({
    clientName: 'Rahul Sharma',
    company: 'Tech Corp',
    phoneNumbers: ['+919876543210'],
  });
  const fc: FieldConfidenceReport = { phoneNumbers: [0.60], fullName: 0.95, company: 0.95 };
  const ctx: ExtractionContext = { status: 'done', fieldConfidence: fc };
  const result = reviewEngine.evaluate(data, 95, ctx);
  assert(result.required, 'TEST 3 — required = true');
  assert(result.reasons.includes(ReviewReason.LOW_FIELD_CONFIDENCE), 'TEST 3 — includes LOW_FIELD_CONFIDENCE');
  assert(!result.reasons.includes(ReviewReason.INVALID_PHONE), 'TEST 3 — does NOT include INVALID_PHONE');
}

// ─── TEST 4 ──────────────────────────────────────────────────────────────────
// overall = 0.95, email = "rahul@company", email confidence = 0.95
// Expected: REQUIRES_REVIEW, reason includes INVALID_EMAIL
console.log('\nTEST 4: overall 95%, email "rahul@company", email confidence 0.95');
{
  const data = makeDraft({
    clientName: 'Rahul Sharma',
    company: 'Tech Corp',
    emails: ['rahul@company'],
  });
  const fc: FieldConfidenceReport = { emails: [0.95], fullName: 0.95, company: 0.95 };
  const ctx: ExtractionContext = { status: 'done', fieldConfidence: fc };
  const result = reviewEngine.evaluate(data, 95, ctx);
  assert(result.required, 'TEST 4 — required = true');
  assert(result.reasons.includes(ReviewReason.INVALID_EMAIL), 'TEST 4 — includes INVALID_EMAIL');
}

// ─── TEST 5 ──────────────────────────────────────────────────────────────────
// overall = 0.95, website = "company", website confidence = 0.95
// Expected: REQUIRES_REVIEW, reason includes INVALID_WEBSITE
console.log('\nTEST 5: overall 95%, website "company", website confidence 0.95');
{
  const data = makeDraft({
    clientName: 'Rahul Sharma',
    company: 'Tech Corp',
    website: 'company',
  });
  const fc: FieldConfidenceReport = { website: 0.95, fullName: 0.95, company: 0.95 };
  const ctx: ExtractionContext = { status: 'done', fieldConfidence: fc };
  const result = reviewEngine.evaluate(data, 95, ctx);
  assert(result.required, 'TEST 5 — required = true');
  assert(result.reasons.includes(ReviewReason.INVALID_WEBSITE), 'TEST 5 — includes INVALID_WEBSITE');
}

// ─── TEST 6 ──────────────────────────────────────────────────────────────────
// overall = 0.70, all fields valid, field confidence all > 0.75
// Expected: REQUIRES_REVIEW, reason includes LOW_CONFIDENCE
console.log('\nTEST 6: overall 70%, all valid, field confidence > 0.75');
{
  const data = makeDraft({
    clientName: 'Rahul Sharma',
    company: 'Tech Corp',
    phoneNumbers: ['+919876543210'],
    emails: ['rahul@techcorp.com'],
    website: 'techcorp.com',
  });
  const fc: FieldConfidenceReport = {
    fullName: 0.95, company: 0.95, phoneNumbers: [0.90], emails: [0.90], website: 0.90,
  };
  const ctx: ExtractionContext = { status: 'done', fieldConfidence: fc };
  const result = reviewEngine.evaluate(data, 70, ctx);
  assert(result.required, 'TEST 6 — required = true');
  assert(result.reasons.includes(ReviewReason.LOW_CONFIDENCE), 'TEST 6 — includes LOW_CONFIDENCE');
}

// ─── TEST 7 ──────────────────────────────────────────────────────────────────
// overall = 0.95, phone = invalid, phone confidence = 0.90
// Expected: REQUIRES_REVIEW (deterministic validation independent of confidence)
console.log('\nTEST 7: overall 95%, phone invalid, phone confidence 0.90');
{
  const data = makeDraft({
    clientName: 'Rahul Sharma',
    company: 'Tech Corp',
    phoneNumbers: ['+9198344'],
  });
  const fc: FieldConfidenceReport = { phoneNumbers: [0.90], fullName: 0.95, company: 0.95 };
  const ctx: ExtractionContext = { status: 'done', fieldConfidence: fc };
  const result = reviewEngine.evaluate(data, 95, ctx);
  assert(result.required, 'TEST 7 — required = true');
  assert(result.reasons.includes(ReviewReason.INVALID_PHONE), 'TEST 7 — includes INVALID_PHONE');
  assert(!result.reasons.includes(ReviewReason.LOW_FIELD_CONFIDENCE), 'TEST 7 — does NOT include LOW_FIELD_CONFIDENCE (0.90 > 0.75)');
}

// ─── TEST 8 ──────────────────────────────────────────────────────────────────
// Manual entry: extractionConfidence = null
// Expected: no review forced by contact validation
console.log('\nTEST 8: manual entry, extractionConfidence = null');
{
  const data = makeDraft({
    clientName: 'Rahul Sharma',
    company: 'Tech Corp',
    phoneNumbers: ['+9198344'], // invalid phone, but manual entry
  });
  const ctx: ExtractionContext = { status: null, fieldConfidence: undefined };
  const result = reviewEngine.evaluate(data, null, ctx);
  assert(!result.required, 'TEST 8 — required = false (manual entry, no review)');
  assert(result.reasons.length === 0, 'TEST 8 — no reasons');
}

// ─── TEST 9 ──────────────────────────────────────────────────────────────────
// Two phone numbers: phone[0] valid, phone[1] invalid
// Expected: REQUIRES_REVIEW, violation identifies index 1
console.log('\nTEST 9: two phones, phone[0] valid, phone[1] invalid');
{
  const data = makeDraft({
    clientName: 'Rahul Sharma',
    company: 'Tech Corp',
    phoneNumbers: ['+919876543210', '+9198344'],
  });
  const fc: FieldConfidenceReport = { phoneNumbers: [0.90, 0.85], fullName: 0.95, company: 0.95 };
  const ctx: ExtractionContext = { status: 'done', fieldConfidence: fc };
  const result = reviewEngine.evaluate(data, 95, ctx);
  assert(result.required, 'TEST 9 — required = true');
  assert(result.reasons.includes(ReviewReason.INVALID_PHONE), 'TEST 9 — includes INVALID_PHONE');
  if (result.contactViolations) {
    const phoneViolations = result.contactViolations.filter(v => v.field === 'phoneNumbers');
    assert(phoneViolations.length === 1, 'TEST 9 — exactly 1 phone violation');
    assert(phoneViolations[0]?.index === 1, 'TEST 9 — violation index = 1');
    assert(phoneViolations[0]?.value === '+9198344', 'TEST 9 — violation value = +9198344');
  } else {
    assert(false, 'TEST 9 — contactViolations missing');
  }
}

// ─── TEST A: uncertain phone (empty array, fieldStatus uncertain) ───────────
console.log('\nTEST A: overall 95%, phoneNumbers=[], fieldStatus.phoneNumbers=["uncertain"]');
{
  const data = makeDraft({
    clientName: 'Rahul Sharma',
    company: 'Tech Corp',
    emails: ['rahul@techcorp.com'],
    website: 'techcorp.com',
    phoneNumbers: [],
  });
  const fs: FieldStatusReport = { phoneNumbers: ['uncertain'] };
  const ctx: ExtractionContext = { status: 'done', fieldStatus: fs };
  const result = reviewEngine.evaluate(data, 95, ctx);
  assert(result.required, 'TEST A — required = true');
  assert(result.reasons.includes(ReviewReason.UNCERTAIN_FIELD), 'TEST A — includes UNCERTAIN_FIELD');
  assert(!!result.fieldStatusViolations, 'TEST A — has fieldStatusViolations');
  if (result.fieldStatusViolations) {
    assert(result.fieldStatusViolations[0]?.field === 'phoneNumbers', 'TEST A — violation field = phoneNumbers');
    assert(result.fieldStatusViolations[0]?.index === 0, 'TEST A — violation index = 0');
    assert(result.fieldStatusViolations[0]?.value === null, 'TEST A — violation value = null');
  }
}

// ─── TEST B: absent phone (empty array, fieldStatus absent) ─────────────────
console.log('\nTEST B: overall 95%, phoneNumbers=[], fieldStatus.phoneNumbers=["absent"]');
{
  const data = makeDraft({
    clientName: 'Rahul Sharma',
    company: 'Tech Corp',
    emails: ['rahul@techcorp.com'],
    website: 'techcorp.com',
    phoneNumbers: [],
  });
  const fs: FieldStatusReport = { phoneNumbers: ['absent'] };
  const ctx: ExtractionContext = { status: 'done', fieldStatus: fs };
  const result = reviewEngine.evaluate(data, 95, ctx);
  assert(!result.required, 'TEST B — required = false (absent phone, no review)');
  assert(!result.reasons.includes(ReviewReason.UNCERTAIN_FIELD), 'TEST B — does NOT include UNCERTAIN_FIELD');
}

// ─── TEST C: invalid phone with confidence (real-world failure case) ────────
console.log('\nTEST C: overall 95%, phone "+9198344", phone confidence 0.85');
{
  const data = makeDraft({
    clientName: 'Rahul Sharma',
    company: 'Tech Corp',
    phoneNumbers: ['+9198344'],
  });
  const fc: FieldConfidenceReport = { phoneNumbers: [0.85], fullName: 0.95, company: 0.95 };
  const ctx: ExtractionContext = { status: 'done', fieldConfidence: fc };
  const result = reviewEngine.evaluate(data, 95, ctx);
  assert(result.required, 'TEST C — required = true');
  assert(result.reasons.includes(ReviewReason.INVALID_PHONE), 'TEST C — includes INVALID_PHONE');
}

// ─── TEST D: low field confidence ───────────────────────────────────────────
console.log('\nTEST D: overall 95%, valid phone, phone confidence 0.60');
{
  const data = makeDraft({
    clientName: 'Rahul Sharma',
    company: 'Tech Corp',
    phoneNumbers: ['+919834412345'],
  });
  const fc: FieldConfidenceReport = { phoneNumbers: [0.60], fullName: 0.95, company: 0.95 };
  const ctx: ExtractionContext = { status: 'done', fieldConfidence: fc };
  const result = reviewEngine.evaluate(data, 95, ctx);
  assert(result.required, 'TEST D — required = true');
  assert(result.reasons.includes(ReviewReason.LOW_FIELD_CONFIDENCE), 'TEST D — includes LOW_FIELD_CONFIDENCE');
}

// ─── TEST E: low overall confidence ─────────────────────────────────────────
console.log('\nTEST E: overall 60%, all fields valid');
{
  const data = makeDraft({
    clientName: 'Rahul Sharma',
    company: 'Tech Corp',
    phoneNumbers: ['+919876543210'],
    emails: ['rahul@techcorp.com'],
    website: 'techcorp.com',
  });
  const fc: FieldConfidenceReport = {
    fullName: 0.95, company: 0.95, phoneNumbers: [0.90], emails: [0.90], website: 0.90,
  };
  const ctx: ExtractionContext = { status: 'done', fieldConfidence: fc };
  const result = reviewEngine.evaluate(data, 60, ctx);
  assert(result.required, 'TEST E — required = true');
  assert(result.reasons.includes(ReviewReason.LOW_CONFIDENCE), 'TEST E — includes LOW_CONFIDENCE');
}

// ─── TEST F: insufficient extraction ────────────────────────────────────────
console.log('\nTEST F: overall 95%, only one meaningful field');
{
  const data = makeDraft({
    clientName: 'Rahul Sharma',
  });
  const fc: FieldConfidenceReport = { fullName: 0.95 };
  const ctx: ExtractionContext = { status: 'done', fieldConfidence: fc };
  const result = reviewEngine.evaluate(data, 95, ctx);
  assert(result.required, 'TEST F — required = true');
  assert(result.reasons.includes(ReviewReason.INSUFFICIENT_EXTRACTION), 'TEST F — includes INSUFFICIENT_EXTRACTION');
}

// ─── TEST G: multiple simultaneous violations ───────────────────────────────
console.log('\nTEST G: overall 60%, phone invalid + uncertain email');
{
  const data = makeDraft({
    clientName: 'Rahul Sharma',
    company: 'Tech Corp',
    phoneNumbers: ['+9198344'],
    emails: [],
  });
  const fc: FieldConfidenceReport = { phoneNumbers: [0.85], fullName: 0.90, company: 0.90 };
  const fs: FieldStatusReport = { emails: ['uncertain'] };
  const ctx: ExtractionContext = { status: 'done', fieldConfidence: fc, fieldStatus: fs };
  const result = reviewEngine.evaluate(data, 60, ctx);
  assert(result.required, 'TEST G — required = true');
  assert(result.reasons.includes(ReviewReason.LOW_CONFIDENCE), 'TEST G — includes LOW_CONFIDENCE');
  assert(result.reasons.includes(ReviewReason.INVALID_PHONE), 'TEST G — includes INVALID_PHONE');
  assert(result.reasons.includes(ReviewReason.UNCERTAIN_FIELD), 'TEST G — includes UNCERTAIN_FIELD');
  assert(result.reasons.length >= 3, `TEST G — at least 3 reasons (got ${result.reasons.length})`);
}

// ─── TEST H: exact runtime scenario — uncertain phone, all else extracted ───
console.log('\nTEST H: overall 95%, phoneNumbers=[], fieldStatus phone uncertain, all else extracted');
{
  const data = makeDraft({
    clientName: 'Rahul Sharma',
    company: 'Tech Corp',
    designation: 'Manager',
    emails: ['rahul@techcorp.com'],
    website: 'techcorp.com',
    address: 'Mumbai',
    phoneNumbers: [],
  });
  const fc: FieldConfidenceReport = {
    fullName: 1, company: 1, designation: 1, website: 1, address: 1, emails: [1],
  };
  const fs: FieldStatusReport = {
    fullName: 'extracted', company: 'extracted', designation: 'extracted',
    website: 'extracted', address: 'extracted',
    phoneNumbers: ['uncertain'], emails: ['extracted'],
  };
  const ctx: ExtractionContext = { status: 'done', fieldConfidence: fc, fieldStatus: fs };
  const result = reviewEngine.evaluate(data, 95, ctx);
  assert(result.required, 'TEST H — required = true');
  assert(result.reasons.includes(ReviewReason.UNCERTAIN_FIELD), 'TEST H — includes UNCERTAIN_FIELD');
  assert(!!result.fieldStatusViolations, 'TEST H — has fieldStatusViolations');
  if (result.fieldStatusViolations) {
    const phoneV = result.fieldStatusViolations.find(v => v.field === 'phoneNumbers');
    assert(!!phoneV, 'TEST H — phoneNumbers violation exists');
    assert(phoneV?.index === 0, 'TEST H — violation index = 0');
    assert(phoneV?.value === null, 'TEST H — violation value = null');
    assert(phoneV?.status === 'uncertain', 'TEST H — violation status = uncertain');
  }
}

// ─── TEST I: promotion scenario — uncertain phone, verify review output shape ─
console.log('\nTEST I: promotion scenario, verify ReviewResult shape for REQUIRES_REVIEW');
{
  const data = makeDraft({
    clientName: 'ANITA SHARMA',
    company: 'NOVATECH GLOBAL',
    designation: 'SENIOR MARKETING MANAGER',
    emails: ['anita.sharma@novatechglobal.com'],
    website: 'novatechglobal.com',
    address: 'Mumbai',
    phoneNumbers: [],
  });
  const fc: FieldConfidenceReport = {
    fullName: 1, company: 1, designation: 1, website: 1, address: 1, emails: [1],
  };
  const fs: FieldStatusReport = {
    fullName: 'extracted', company: 'extracted', designation: 'extracted',
    website: 'extracted', address: 'extracted',
    phoneNumbers: ['uncertain'], emails: ['extracted'],
  };
  const ctx: ExtractionContext = { status: 'done', fieldConfidence: fc, fieldStatus: fs };
  const result = reviewEngine.evaluate(data, 95, ctx);

  assert(result.required, 'TEST I — required = true');
  assert(result.reasons.includes(ReviewReason.UNCERTAIN_FIELD), 'TEST I — includes UNCERTAIN_FIELD');
  assert(!!result.fieldStatusViolations, 'TEST I — has fieldStatusViolations');

  if (result.fieldStatusViolations) {
    const phoneV: FieldStatusViolation | undefined = result.fieldStatusViolations.find(v => v.field === 'phoneNumbers');
    assert(!!phoneV, 'TEST I — phoneNumbers violation exists');
    assert(phoneV?.index === 0, 'TEST I — violation index = 0');
    assert(phoneV?.value === null, 'TEST I — violation value = null (empty array)');
    assert(phoneV?.status === 'uncertain', 'TEST I — violation status = uncertain');
  }

  // Verify the ReviewResult can be serialized into the review_metadata JSONB shape
  const reviewMetadata = {
    required:                  result.required,
    reason:                    result.reason,
    reasons:                   result.reasons,
    confidence:                result.confidence,
    fieldConfidenceViolations: result.fieldConfidenceViolations ?? null,
    fieldStatusViolations:     result.fieldStatusViolations ?? null,
    contactViolations:         result.contactViolations ?? null,
  };
  assert(reviewMetadata.required === true, 'TEST I — reviewMetadata.required = true');
  assert(Array.isArray(reviewMetadata.reasons), 'TEST I — reviewMetadata.reasons is array');
  assert(reviewMetadata.reasons.includes('UNCERTAIN_FIELD'), 'TEST I — reviewMetadata.reasons includes UNCERTAIN_FIELD');
  assert(Array.isArray(reviewMetadata.fieldStatusViolations), 'TEST I — reviewMetadata.fieldStatusViolations is array');
}

// ─── TEST J: normal lead, verify review output shape for NEW ─────────────────
console.log('\nTEST J: normal lead, verify ReviewResult shape for NEW (no review)');
{
  const data = makeDraft({
    clientName: 'Rahul Sharma',
    company: 'Tech Corp',
    designation: 'Manager',
    emails: ['rahul@techcorp.com'],
    website: 'techcorp.com',
    phoneNumbers: ['+919876543210'],
  });
  const fc: FieldConfidenceReport = {
    fullName: 0.95, company: 0.95, designation: 0.95,
    website: 0.95, phoneNumbers: [0.95], emails: [0.95],
  };
  const fs: FieldStatusReport = {
    fullName: 'extracted', company: 'extracted', designation: 'extracted',
    website: 'extracted', phoneNumbers: ['extracted'], emails: ['extracted'],
  };
  const ctx: ExtractionContext = { status: 'done', fieldConfidence: fc, fieldStatus: fs };
  const result = reviewEngine.evaluate(data, 95, ctx);

  assert(!result.required, 'TEST J — required = false (normal lead)');
  assert(result.reasons.length === 0, 'TEST J — no reasons');
  assert(!result.fieldStatusViolations, 'TEST J — no fieldStatusViolations');

  const reviewMetadata = {
    required:                  result.required,
    reason:                    result.reason,
    reasons:                   result.reasons,
    confidence:                result.confidence,
    fieldConfidenceViolations: result.fieldConfidenceViolations ?? null,
    fieldStatusViolations:     result.fieldStatusViolations ?? null,
    contactViolations:         result.contactViolations ?? null,
  };
  assert(reviewMetadata.required === false, 'TEST J — reviewMetadata.required = false');
  assert(reviewMetadata.reasons.length === 0, 'TEST J — reviewMetadata.reasons empty');
}

// ─── Summary ─────────────────────────────────────────────────────────────────
console.log(`\n${'='.repeat(60)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
