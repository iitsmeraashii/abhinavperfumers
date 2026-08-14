# Extraction & Review Architecture — Implementation Reference

Detailed implementation guide for the extraction confidence model, the review rule engine, the configurable threshold, REQUIRES_REVIEW promotion behavior, persistence, and the test scenarios that verify the system.

---

## Table of Contents

1. [Three Confidence Signals](#1-three-confidence-signals)
2. [The 75% Configurable Threshold](#2-the-75-configurable-threshold)
3. [Review Engine — Rule Evaluation](#3-review-engine--rule-evaluation)
4. [Review Reasons Reference](#4-review-reasons-reference)
5. [Deterministic Contact Validation](#5-deterministic-contact-validation)
6. [REQUIRES_REVIEW Promotion Behavior](#6-requires_review-promotion-behavior)
7. [Persistence](#7-persistence)
8. [Test Scenarios](#8-test-scenarios)
9. [Modification Guide](#9-modification-guide)

---

## 1. Three Confidence Signals

The review engine consumes three distinct confidence signals from the extraction pipeline. They are independent — a high value in one does NOT suppress rules that fire on another.

### 1.1 Overall Confidence (`extractionConfidence`)

**Type:** `number` on a 0–100 scale, or `null`.

**Source:** `VisionExtractedFields.confidence` (0–1 float from the model) → multiplied by 100 in the pipeline → passed to `reviewEngine.evaluate()` as `extractionConfidence`.

**File:** `src/capture/types.ts` — `VisionExtractedFields.confidence: number`

**When null:** Manual entry (no AI extraction), skipped extraction (no evidence), or QR parsing (deterministic, not AI — though currently set to a numeric value, not null).

**Consumed by:** `LOW_CONFIDENCE` rule only. When null, the null-confidence guard fires (see Section 3.3) and ALL confidence-based rules are skipped.

### 1.2 Field Confidence (`fieldConfidence`)

**Type:** `FieldConfidenceReport | undefined`

**File:** `src/capture/types.ts`

```typescript
interface FieldConfidenceReport {
  fullName?:     number;   // 0–1
  company?:      number;
  designation?:  number;
  website?:      number;
  address?:      number;
  phoneNumbers?: number[]; // positional — phoneNumbers[i] ↔ confidence[i]
  emails?:       number[];
}
```

**Source:** Model-reported (OpenAI Vision). Absent for Tesseract fallback and QR parsing paths. The edge function returns this in the `fieldConfidence` field of `VisionExtractedFields`.

**Consumed by:** `LOW_FIELD_CONFIDENCE` rule. Each field's confidence is compared against the threshold (converted from 0–100 to 0–1). Only meaningful (non-empty, non-placeholder) extracted values are checked — absent fields are skipped.

**Critical detail:** Array fields (`phoneNumbers`, `emails`) are checked positionally. `fieldConfidence.phoneNumbers[i]` corresponds to `draftData.phoneNumbers[i]`. If the confidence array is shorter than the values array, unmatched entries are skipped.

### 1.3 Field Status (`fieldStatus`)

**Type:** `FieldStatusReport | undefined`

**File:** `src/capture/types.ts`

```typescript
type FieldExtractionStatus = 'extracted' | 'absent' | 'uncertain';

interface FieldStatusReport {
  fullName?:     FieldExtractionStatus;
  company?:      FieldExtractionStatus;
  designation?:  FieldExtractionStatus;
  website?:      FieldExtractionStatus;
  address?:      FieldExtractionStatus;
  phoneNumbers?: FieldExtractionStatus[];
  emails?:       FieldExtractionStatus[];
}
```

**Source:** Model-reported (OpenAI Vision). Absent for Tesseract and QR paths.

**Semantics:**
- `extracted` — field is present and a usable value was extracted
- `absent` — field is genuinely not present on the card
- `uncertain` — field appears present but the value cannot be reliably determined (blurry, obscured, partially visible, illegible)

**Consumed by:** `UNCERTAIN_FIELD` rule. Fires when any field (scalar or array entry) has status `'uncertain'`.

**Critical detail for array fields:** The `fieldStatus` array may contain entries even when the values array is empty. Example: `phoneNumbers: []` with `fieldStatus.phoneNumbers: ['uncertain']` — the model saw a phone number on the card but couldn't read it. The violation's `value` will be `null` in this case.

### 1.4 Independence Matrix

| Rule | Depends on overall confidence? | Depends on fieldConfidence? | Depends on fieldStatus? | Depends on extracted values? |
|---|---|---|---|---|
| LOW_CONFIDENCE | Yes | No | No | No |
| LOW_FIELD_CONFIDENCE | No | Yes | No | Yes (only meaningful values checked) |
| UNCERTAIN_FIELD | No | No | Yes | No |
| INVALID_PHONE/EMAIL/WEBSITE | No | No | No | Yes (deterministic validation) |
| INSUFFICIENT_EXTRACTION | No | No | No | Yes (count of meaningful fields) |
| SUSPICIOUS_CONTACT | No | No | No | Yes (legacy heuristic) |

A lead can trigger `LOW_CONFIDENCE` (overall 60%) while having all field-level confidences above threshold. Conversely, a lead with 95% overall confidence can trigger `LOW_FIELD_CONFIDENCE` if one field has 0.60 confidence, or `INVALID_PHONE` if the phone number is structurally invalid despite high confidence.

---

## 2. The 75% Configurable Threshold

### 2.1 Database Schema

**Table:** `runtime_configuration` (single-row, `id = 1`, enforced by CHECK constraint)

**Column:** `review_minimum_confidence int2 NOT NULL DEFAULT 75`

**Migrations:**
1. `20260809151150_create_runtime_configuration.sql` — creates the table, seeds row with all diagnostics flags false. No `review_minimum_confidence` column yet.
2. `20260814091258_add_review_minimum_confidence_to_runtime_configuration.sql` — adds the column with default 50 (backward-compatible placeholder).
3. `20260814092925_set_default_review_minimum_confidence_to_75.sql` — changes default to 75 and updates existing row from 50 to 75.

**RLS:** Enabled. Any authenticated user can SELECT (config is shared app-wide). Any authenticated user can UPDATE (admin-only enforcement is a future concern).

### 2.2 In-Memory Cache

**File:** `src/runtime/runtimeConfiguration.ts`

The cache is loaded once via `load()` (called at app startup) and all subsequent reads are O(1):

```typescript
let _reviewCache: ReviewConfig | null = null;

export const DEFAULT_REVIEW_CONFIG: ReviewConfig = {
  minimumConfidence: 75,
};

function mapReviewRow(row: ConfigRow | null): ReviewConfig {
  if (!row || row.review_minimum_confidence == null) return { ...DEFAULT_REVIEW_CONFIG };
  const clamped = Math.max(0, Math.min(100, row.review_minimum_confidence));
  return { minimumConfidence: clamped };
}

export function getCachedReviewConfig(): ReviewConfig {
  return _reviewCache ?? { ...DEFAULT_REVIEW_CONFIG };
}
```

The value is clamped to 0–100 on read. Falls back to 75 when the cache is not populated.

### 2.3 Access Path

**File:** `src/runtime/runtimeDiagnostics.ts`

```typescript
export function getReviewMinimumConfidence(): number {
  return getCachedReviewConfig().minimumConfidence;
}
```

**Note:** The JSDoc comment on this function says "Falls back to 50 if the cache has not been loaded yet" — this is stale. The actual fallback is 75, via `DEFAULT_REVIEW_CONFIG.minimumConfidence = 75` in `runtimeConfiguration.ts`.

### 2.4 Review Engine Consumption

**File:** `src/capture/captureReviewEngine.ts`

```typescript
const FALLBACK_MINIMUM_CONFIDENCE = 75;

private get minimumConfidence(): number {
  const configured = getReviewMinimumConfidence();
  return Number.isFinite(configured) ? configured : FALLBACK_MINIMUM_CONFIDENCE;
}
```

Double fallback: `getReviewMinimumConfidence()` → `getCachedReviewConfig()` → `DEFAULT_REVIEW_CONFIG` (75) → `FALLBACK_MINIMUM_CONFIDENCE` (75). Both fallbacks are 75, so the effective threshold is always 75 unless the database row has been explicitly changed.

### 2.5 Threshold Scale Conversion

The threshold is on a 0–100 scale. Model confidence (`fieldConfidence`) is on a 0–1 scale. The `findFieldConfidenceViolations()` function converts:

```typescript
const threshold = thresholdPercent / 100; // convert 0–100 → 0–1
```

Overall confidence is already on a 0–100 scale when passed to `evaluate()` (the pipeline multiplies the model's 0–1 value by 100).

### 2.6 Comparison Operator

Both `LOW_CONFIDENCE` and `LOW_FIELD_CONFIDENCE` use `<=` (less than or equal to):

```typescript
if (extractionConfidence <= this.minimumConfidence) { ... }  // overall
if (score <= threshold) { ... }                                // per-field
```

A confidence of exactly 75 (or 0.75 for field confidence) WILL trigger review. The threshold is inclusive — "at or below" requires review.

### 2.7 Realtime Updates

**File:** `src/runtime/runtimeConfiguration.ts` — `subscribe()`

Infrastructure exists for Supabase realtime updates on the `runtime_configuration` row. When a row change arrives, `reload()` re-fetches and updates the cache. However, no existing code calls `subscribe()` yet — the cache is loaded once at startup and never refreshed unless `reload()` is explicitly called.

---

## 3. Review Engine — Rule Evaluation

**File:** `src/capture/captureReviewEngine.ts`

**Singleton:** `reviewEngine` (instance of `CaptureReviewEngine`)

### 3.1 Entry Point

```typescript
evaluate(
  data: DraftData,
  extractionConfidence: number | null,
  extraction?: ExtractionContext,
): ReviewResult
```

**Parameters:**
- `data` — full `DraftData` with all extracted + manually entered fields
- `extractionConfidence` — AI confidence on 0–100 scale, or `null` for manual entry
- `extraction` — optional context: `{ status, fieldConfidence, fieldStatus, backendSessionId }`

**Returns:** `ReviewResult` — always non-null. `required: false` when no rule fires.

### 3.2 ExtractionContext

```typescript
interface ExtractionContext {
  status: ExtractionStatus;        // 'done' | 'failed' | 'skipped' | null
  fieldConfidence?: FieldConfidenceReport;
  fieldStatus?: FieldStatusReport;
  backendSessionId?: string;       // for diagnostics only
}
```

### 3.3 Rule Evaluation Order

Rules are evaluated in a fixed sequence. Terminal rules return immediately. Non-terminal rules are collected — all triggered reasons appear in `ReviewResult.reasons[]`.

```
Step 1: QR_NO_EXTRACTION         → terminal (returns immediately)
Step 2: EXTRACTION_FAILED        → terminal (returns immediately)
Step 3: null-confidence guard   → terminal (returns immediately, no review)
Step 4: LOW_CONFIDENCE          → non-terminal (collected)
Step 5: LOW_FIELD_CONFIDENCE    → non-terminal (collected)
Step 6: INSUFFICIENT_EXTRACTION  → non-terminal (collected)
Step 7: SUSPICIOUS_CONTACT       → non-terminal (collected)
Step 8: INVALID_PHONE           → non-terminal (collected, deduplicated)
Step 9: INVALID_EMAIL           → non-terminal (collected, deduplicated)
Step 10: INVALID_WEBSITE        → non-terminal (collected, deduplicated)
Step 11: UNCERTAIN_FIELD        → non-terminal (collected)
```

### 3.4 Null-Confidence Guard (Step 3)

When `extractionConfidence === null`:
- This means manual entry or skipped extraction (no AI evidence)
- The engine returns `{ required: false, reason: null, reasons: [], confidence: null }` immediately
- **Deterministic contact validation does NOT apply** — a manually entered invalid phone number does not trigger review
- This is the critical guard: it prevents the review engine from forcing review on every manual entry with a typo

### 3.5 Terminal Rules

**QR_NO_EXTRACTION:** `data.qrExtractionEmpty === true`. Set once at QR scan time when the parser produces no contact fields. Persists through manual edits. Returns with `confidence: null`.

**EXTRACTION_FAILED:** `extraction?.status === 'failed'`. The extraction pipeline reported a failure. Returns with the passed `extractionConfidence` (which may be non-null if the model returned a confidence score but the overall extraction was deemed failed).

### 3.6 ReviewResult Shape

```typescript
interface ReviewResult {
  required:                    boolean;
  reason:                      ReviewReason | null;    // first triggered (backward compat)
  reasons:                     ReviewReason[];          // all triggered, in order
  confidence:                  number | null;           // 0–100 or null
  fieldConfidenceViolations?:  FieldConfidenceViolation[];
  contactViolations?:           ContactValidationViolation[];
  fieldStatusViolations?:       FieldStatusViolation[];
}
```

### 3.7 Violation Types

**FieldConfidenceViolation:**
```typescript
{ field: string; value: string; index?: number; score: number; }
```
`score` is the model-reported confidence (0–1). `index` present only for array fields.

**ContactValidationViolation:**
```typescript
{ field: 'phoneNumbers' | 'emails' | 'website'; value: string; index?: number; reason: ReviewReason; detail: string; }
```
`detail` is a human-readable explanation (e.g. "Incomplete Indian number: only 5 digits after country code (expected 10)").

**FieldStatusViolation:**
```typescript
{ field: string; index?: number; status: 'uncertain'; value: string | null; }
```
`value` is `null` when the values array is empty (model saw the field but couldn't read it).

---

## 4. Review Reasons Reference

### QR_NO_EXTRACTION
- **Trigger:** `data.qrExtractionEmpty === true`
- **Terminal:** Yes
- **Confidence reported:** null
- **Scenario:** QR code was scanned but the payload contained no parseable contact fields (vCard with no name/phone, URL with no embedded data, etc.)

### EXTRACTION_FAILED
- **Trigger:** `extraction?.status === 'failed'`
- **Terminal:** Yes
- **Confidence reported:** `extractionConfidence` (may be non-null)
- **Scenario:** Vision edge function returned an error, or Tesseract fallback also failed, or the extraction service returned `{ source: 'manual', fields: null, error: '...' }`

### LOW_CONFIDENCE
- **Trigger:** `extractionConfidence <= minimumConfidence` (default 75)
- **Terminal:** No
- **Scale:** 0–100 (already converted from model's 0–1)
- **Scenario:** Overall AI confidence is at or below the threshold. The model is not confident enough in the extraction as a whole.

### LOW_FIELD_CONFIDENCE
- **Trigger:** Any model-reported per-field confidence `<= threshold` (threshold converted to 0–1)
- **Terminal:** No
- **Scale:** 0–1 (model-native), compared against `threshold / 100`
- **Only checks:** Meaningful (non-empty, non-placeholder) extracted values
- **Scenario:** One specific field has low confidence even though overall confidence is high. Example: overall 95% but phone confidence 0.60.

### INSUFFICIENT_EXTRACTION
- **Trigger:** `countMeaningfulFields(data) <= 1`
- **Terminal:** No
- **Fields counted:** `clientName`, `company`, `designation`, `phone`/`phoneNumbers`, `email`/`emails`, `website`, `address` (7 possible)
- **Scenario:** The extraction produced only one or zero meaningful fields. The lead has almost no data — likely a failed extraction that returned minimal output.

### SUSPICIOUS_CONTACT
- **Trigger:** `findSuspiciousContact(data) !== null` (legacy heuristic)
- **Terminal:** No
- **Checks:** Email (missing @, missing domain dot, placeholder), phone (< 7 digits, placeholder), website (no dot, placeholder)
- **Note:** Overlaps with `INVALID_PHONE`/`INVALID_EMAIL`/`INVALID_WEBSITE` but is retained for backward compatibility. Both can fire simultaneously.

### INVALID_PHONE
- **Trigger:** `validatePhone()` returns a violation for any meaningful phone number
- **Terminal:** No (deduplicated — reason appears once even if multiple phones are invalid)
- **Checks:** Masked content (XXXX, ***), placeholder (N/A, test), Indian number rules (91 prefix → 10 digits starting 6-9), ITU-T E.164 (7-15 digits)
- **Independent of confidence:** A phone with 0.95 confidence that is structurally invalid still triggers this rule

### INVALID_EMAIL
- **Trigger:** `validateEmail()` returns a violation for any meaningful email
- **Terminal:** No (deduplicated)
- **Checks:** Whitespace, masked content, exactly one @, non-empty local + domain, domain has dot, no placeholder, domain doesn't start/end with dot
- **Independent of confidence**

### INVALID_WEBSITE
- **Trigger:** `validateWebsite()` returns a violation for any meaningful website
- **Terminal:** No (deduplicated)
- **Checks:** Whitespace, masked content, placeholder, domain has dot (after stripping protocol), domain doesn't start/end with dot
- **Does NOT require protocol** — "techcorp.com" is valid, "http://techcorp.com" is valid, "company" is invalid
- **Independent of confidence**

### UNCERTAIN_FIELD
- **Trigger:** Any field in `fieldStatus` is `'uncertain'`
- **Terminal:** No
- **Independent of confidence:** A field can have 1.0 confidence in `fieldConfidence` but `'uncertain'` in `fieldStatus` — both signals are independent
- **Scenario:** The model saw a phone number on the card but couldn't read it (blurry, obscured). `phoneNumbers: []` with `fieldStatus.phoneNumbers: ['uncertain']`.

---

## 5. Deterministic Contact Validation

**File:** `src/capture/captureReviewEngine.ts`

### 5.1 Placeholder Patterns
```typescript
const PLACEHOLDER_PATTERNS = /^(n\/?a|none|null|undefined|unknown|\.+|-+|test|xxx|example\..*|sample)$/i;
```
Matches: "N/A", "none", "null", "undefined", "unknown", "...", "---", "test", "xxx", "example.com", "sample"

### 5.2 Masked Patterns
```typescript
const MASKED_PATTERNS = /x{2,}|\*{2,}|\?{2,}|_{2,}/i;
```
Matches: "XXXX", "***", "????", "____" (2+ repeated masking characters)

### 5.3 isMeaningful()
A value is meaningful if: non-empty, non-whitespace, and does NOT match `PLACEHOLDER_PATTERNS`. Used throughout to skip absent/placeholder fields — absent values are not validation failures.

### 5.4 Phone Validation — `validatePhone(phone, index)`

1. Skip if empty
2. Reject if masked (XXXX, ***)
3. Reject if placeholder (N/A, test)
4. Indian number checks:
   - If starts with `91`: mobile part (after `91`) must be ≥ 10 digits; if exactly 10, must start with 6-9
   - If 10 digits starting 6-9 (no country code): valid Indian mobile
5. International plausibility: 7-15 digits (ITU-T E.164)

Returns `ContactValidationViolation | null`.

### 5.5 Email Validation — `validateEmail(email, index)`

1. Skip if empty
2. Reject if whitespace
3. Reject if masked
4. Must have exactly one `@`
5. Non-empty local part (before @)
6. Non-empty domain (after @)
7. Domain must contain a dot
8. Reject placeholder in local or domain
9. Domain must not start or end with dot

Returns `ContactValidationViolation | null`.

### 5.6 Website Validation — `validateWebsite(website)`

1. Skip if empty
2. Reject if whitespace
3. Reject if masked
4. Reject if placeholder
5. Strip `http://` or `https://` if present
6. Must contain a dot
7. Must not start or end with dot

Does NOT require a protocol. Does NOT validate TLD format. Returns `ContactValidationViolation | null`.

### 5.7 `findContactValidationViolations(data)`

Runs all three validators on all phone/email/website values. Checks both array fields (`phoneNumbers[]`, `emails[]`) and legacy single fields (`phone`, `email`). Uses a `Set` to avoid double-checking `phone` if `phoneNumbers[0]` was already checked.

Returns ALL violations — does NOT short-circuit on the first one. Each violation is individually indexed for array fields.

### 5.8 Legacy `findSuspiciousContact(data)`

Returns the FIRST suspicious field name (`'email'`, `'phone'`, `'website'`) or null. Overlaps with deterministic validators but is retained. Uses slightly different checks (e.g., `isSuspiciousPhone` strips different characters than `validatePhone`).

---

## 6. REQUIRES_REVIEW Promotion Behavior

### 6.1 Database Constraint

**Migration:** `20260703115752_add_requires_review_to_lead_status.sql`

```sql
ALTER TABLE lead_entries
  ADD CONSTRAINT lead_status_check
  CHECK (lead_status = ANY (ARRAY[
    'NEW', 'CONTACTED', 'QUALIFIED', 'CONVERTED', 'LOST', 'REQUIRES_REVIEW'
  ]));
```

`REQUIRES_REVIEW` is a valid `lead_status` value in the database constraint.

### 6.2 Review Audit Fields

**Migration:** `20260706034318_add_review_fields_to_lead_entries.sql`

```sql
ALTER TABLE lead_entries
  ADD COLUMN IF NOT EXISTS reviewed_by  text,
  ADD COLUMN IF NOT EXISTS reviewed_at  timestamptz;
```

Both nullable. Populated only when a rep explicitly verifies a `REQUIRES_REVIEW` lead. Currently no UI code populates these fields — they exist in the schema but the verification flow is not yet implemented.

### 6.3 Pipeline Flow

**File:** `src/alpe/pipeline.ts` — `executeReviewStage()` and `executePromotionStage()`

1. **Review stage:** calls `strategies.review.evaluate(draftData, confidencePercent, extractionContext)`
   - `confidencePercent` = `extractionConfidence * 100` (or null for manual)
   - `extractionContext` = `{ status, fieldConfidence, fieldStatus, backendSessionId }`
   - Result stored on `ctx.review`

2. **Promotion stage:** calls `strategies.promotion.buildOptions({ ..., requiresReview: ctx.review?.required ?? false })`
   - Passes `requiresReview` boolean to `executePromotion()`

3. **Promotion service:** `src/capture/capturePromotionService.ts` — `executePromotion(options)`
   - If `options.requiresReview === true`: inserts `lead_entries` row with `lead_status: 'REQUIRES_REVIEW'`
   - If `options.requiresReview === false`: inserts with `lead_status: 'NEW'`
   - All other fields are identical regardless of review status

### 6.4 ALPE Decision Engine Mapping

**File:** `src/alpe/decisionEngine.ts`

When the worker returns `outcome: 'requires_review'`:
- `decision.newState = 'REQUIRES_REVIEW'` (on the `processing_queue` row)
- `decision.isRetryable = false` (terminal — no retry)
- The scheduler calls `updateJobState(jobId, 'REQUIRES_REVIEW', { failure_reason })`

### 6.5 Current UI Gap

`LeadDetailPage.tsx` `LEAD_STATUS_OPTIONS` does NOT include `REQUIRES_REVIEW`. The dropdown shows only `NEW, CONTACTED, QUALIFIED, CONVERTED, LOST`. A lead promoted with `REQUIRES_REVIEW`:
- Is stored correctly in the database
- Is returned by `leads_list_view`
- But the detail page has no dropdown option, no review banner, no "Mark as Reviewed" button, and no display of `review_metadata` (reasons, violations)

The `reviewed_by` and `reviewed_at` columns exist but are never populated — the verification flow is not yet implemented in the UI.

---

## 7. Persistence

### 7.1 Extraction Metadata

**File:** `src/alpe/extractionMetadataPersistence.ts` — `persistExtractionMetadata()`

**Columns updated on `capture_sessions`:**

| Column | Type | Content |
|---|---|---|
| `extraction_source` | text | Engine: `'openai_vision'`, `'tesseract_fallback'`, `'qr_parser'`, `'manual'` |
| `extraction_status` | text | Lifecycle: `'done'`, `'failed'`, `'skipped'` |
| `extraction_confidence` | float | Overall confidence 0–1 (or null) |
| `extracted_fields` | jsonb | Canonical 5 fields: `clientName`, `company`, `phone`, `email`, `designation` (empty values omitted) |
| `extraction_metadata` | jsonb | Full metadata object: `{ source, confidence, fieldConfidence, fieldStatus, fieldsExtracted }` |

**Migration:** `20260814120000_add_capture_session_link_and_review_metadata.sql` — adds `extraction_metadata jsonb NOT NULL DEFAULT '{}'` and `review_metadata jsonb NOT NULL DEFAULT '{}'` to `capture_sessions`.

**Failure behavior:** Logged via `console.warn`, never throws. The pipeline continues to validation regardless.

### 7.2 Review Result

**File:** `src/alpe/extractionMetadataPersistence.ts` — `persistReviewResult()`

**Column updated on `capture_sessions`:**

| Column | Type | Content |
|---|---|---|
| `review_metadata` | jsonb | `{ required, reason, reasons, confidence, fieldConfidenceViolations, fieldStatusViolations, contactViolations }` |

Written once during the pipeline's review stage. Never reconstructed. This is the authoritative historical record of why a lead was (or was not) marked `REQUIRES_REVIEW`.

**JSONB shape:**
```json
{
  "required": true,
  "reason": "UNCERTAIN_FIELD",
  "reasons": ["UNCERTAIN_FIELD"],
  "confidence": 95,
  "fieldConfidenceViolations": null,
  "fieldStatusViolations": [
    { "field": "phoneNumbers", "index": 0, "status": "uncertain", "value": null }
  ],
  "contactViolations": null
}
```

**Failure behavior:** Logged via `console.warn`, never throws. The pipeline continues to promotion regardless.

### 7.3 Lead Entries Link

**Migration:** `20260814120000_add_capture_session_link_and_review_metadata.sql`

`lead_entries.capture_session_id` — nullable FK to `capture_sessions.id` with `ON DELETE SET NULL`. Populated at promotion time by `executePromotion()`. Indexed via `idx_lead_entries_capture_session_id`.

### 7.4 Persistence Sequence in the Pipeline

```
Stage 3: Extraction          → produces metadata
Stage 4: persistExtractionMetadata()  → writes to capture_sessions
Stage 5: Validation          → may short-circuit
Stage 6: Review              → produces ReviewResult
         persistReviewResult()         → writes to capture_sessions
Stage 7: Promotion           → writes to lead_entries + updates capture_sessions
```

Both persistence steps are fire-and-forget within the pipeline — they are awaited but failures are caught and logged, never thrown.

---

## 8. Test Scenarios

**File:** `scripts/test_reviewEngine.ts`
**Compiled:** `scripts/test_reviewEngine.cjs`

**Run command:**
```bash
npx esbuild scripts/test_reviewEngine.ts --bundle --platform=node --format=cjs \
  --alias:../supabaseClient=./scripts/test_supabase_stub.ts \
  --outfile=scripts/test_reviewEngine.cjs && node scripts/test_reviewEngine.cjs
```

The test script stubs the Supabase client (`scripts/test_supabase_stub.ts`) so the review engine runs in pure isolation. The `runtimeConfiguration` cache is never loaded, so `getReviewMinimumConfidence()` returns the default 75.

### 8.1 Test Matrix

| Test | Overall Conf | Field Conf | Field Status | Key Data | Expected | Reason(s) |
|---|---|---|---|---|---|---|
| 1 | 95% | phone 0.85 | — | phone `+9198344` (incomplete) | REQUIRES_REVIEW | INVALID_PHONE |
| 2 | 95% | phone 0.85 | — | phone `+919876543210` (valid) | NEW (no review) | — |
| 3 | 95% | phone 0.60 | — | phone `+919876543210` (valid) | REQUIRES_REVIEW | LOW_FIELD_CONFIDENCE |
| 4 | 95% | email 0.95 | — | email `rahul@company` (no dot) | REQUIRES_REVIEW | INVALID_EMAIL |
| 5 | 95% | website 0.95 | — | website `company` (no dot) | REQUIRES_REVIEW | INVALID_WEBSITE |
| 6 | 70% | all > 0.75 | — | all valid | REQUIRES_REVIEW | LOW_CONFIDENCE |
| 7 | 95% | phone 0.90 | — | phone `+9198344` (invalid) | REQUIRES_REVIEW | INVALID_PHONE (not LOW_FIELD_CONFIDENCE) |
| 8 | null | — | — | phone `+9198344` (manual entry) | NEW (no review) | — (null-confidence guard) |
| 9 | 95% | phone [0.90, 0.85] | — | phone[0] valid, phone[1] `+9198344` | REQUIRES_REVIEW | INVALID_PHONE (index 1) |
| A | 95% | — | phone `uncertain` | phoneNumbers=[], all else valid | REQUIRES_REVIEW | UNCERTAIN_FIELD |
| B | 95% | — | phone `absent` | phoneNumbers=[], all else valid | NEW (no review) | — (absent ≠ uncertain) |
| C | 95% | phone 0.85 | — | phone `+9198344` | REQUIRES_REVIEW | INVALID_PHONE |
| D | 95% | phone 0.60 | — | phone `+919834412345` (valid) | REQUIRES_REVIEW | LOW_FIELD_CONFIDENCE |
| E | 60% | all > 0.75 | — | all valid | REQUIRES_REVIEW | LOW_CONFIDENCE |
| F | 95% | fullName 0.95 | — | only clientName | REQUIRES_REVIEW | INSUFFICIENT_EXTRACTION |
| G | 60% | phone 0.85 | email `uncertain` | phone invalid, email empty | REQUIRES_REVIEW | LOW_CONFIDENCE + INVALID_PHONE + UNCERTAIN_FIELD |
| H | 95% | all 1.0 | phone `uncertain`, all else `extracted` | phoneNumbers=[], all else present | REQUIRES_REVIEW | UNCERTAIN_FIELD |
| I | 95% | all 1.0 | phone `uncertain`, all else `extracted` | ANITA SHARMA / NOVATECH GLOBAL | REQUIRES_REVIEW | UNCERTAIN_FIELD + verifies serialization |
| J | 95% | all 0.95 | all `extracted` | all fields valid | NEW (no review) | — |

### 8.2 Key Test: TEST I — REQUIRES_REVIEW Promotion Scenario

This is the primary test verifying the full `REQUIRES_REVIEW` path:

**Input:**
```typescript
const data = makeDraft({
  clientName: 'ANITA SHARMA',
  company: 'NOVATECH GLOBAL',
  designation: 'SENIOR MARKETING MANAGER',
  emails: ['anita.sharma@novatechglobal.com'],
  website: 'novatechglobal.com',
  address: 'Mumbai',
  phoneNumbers: [],          // empty — model couldn't read the phone
});

const fc: FieldConfidenceReport = {
  fullName: 1, company: 1, designation: 1, website: 1, address: 1, emails: [1],
};

const fs: FieldStatusReport = {
  fullName: 'extracted', company: 'extracted', designation: 'extracted',
  website: 'extracted', address: 'extracted',
  phoneNumbers: ['uncertain'],   // model saw a phone but couldn't read it
  emails: ['extracted'],
};

const ctx: ExtractionContext = { status: 'done', fieldConfidence: fc, fieldStatus: fs };
const result = reviewEngine.evaluate(data, 95, ctx);
```

**Expected behavior:**
1. `QR_NO_EXTRACTION` — not triggered (`qrExtractionEmpty` is falsy)
2. `EXTRACTION_FAILED` — not triggered (`status === 'done'`)
3. Null-confidence guard — not triggered (`extractionConfidence = 95`, not null)
4. `LOW_CONFIDENCE` — not triggered (95 > 75)
5. `LOW_FIELD_CONFIDENCE` — not triggered (all field confidences = 1.0 > 0.75)
6. `INSUFFICIENT_EXTRACTION` — not triggered (6 meaningful fields: name, company, designation, email, website, address)
7. `SUSPICIOUS_CONTACT` — not triggered (all contact fields valid)
8. `INVALID_PHONE` — not triggered (phoneNumbers is empty, no value to validate)
9. `INVALID_EMAIL` — not triggered (email is valid)
10. `INVALID_WEBSITE` — not triggered (website has dot)
11. `UNCERTAIN_FIELD` — **TRIGGERED** (`fieldStatus.phoneNumbers[0] === 'uncertain'`)

**Result:**
```typescript
{
  required: true,
  reason: 'UNCERTAIN_FIELD',
  reasons: ['UNCERTAIN_FIELD'],
  confidence: 95,
  fieldConfidenceViolations: undefined,
  contactViolations: undefined,
  fieldStatusViolations: [
    { field: 'phoneNumbers', index: 0, status: 'uncertain', value: null }
  ],
}
```

**Serialization check:** The test also verifies that `ReviewResult` can be serialized into the `review_metadata` JSONB shape that `persistReviewResult()` writes:
```typescript
const reviewMetadata = {
  required: result.required,                    // true
  reason: result.reason,                        // 'UNCERTAIN_FIELD'
  reasons: result.reasons,                     // ['UNCERTAIN_FIELD']
  confidence: result.confidence,                // 95
  fieldConfidenceViolations: null,              // null (no violations)
  fieldStatusViolations: result.fieldStatusViolations,  // [{ field, index, status, value }]
  contactViolations: null,                      // null (no violations)
};
```

**Promotion impact:** When this `ReviewResult` reaches the promotion stage, `requiresReview: true` is passed to `executePromotion()`, which inserts the `lead_entries` row with `lead_status: 'REQUIRES_REVIEW'`.

### 8.3 Key Test: TEST 8 — Null-Confidence Guard

This test verifies that manual entries bypass all review rules:

**Input:** `extractionConfidence = null`, phone `+9198344` (structurally invalid)
**Expected:** `required: false`, `reasons: []`

Despite having an invalid phone number, the null-confidence guard fires at step 3 and returns immediately. Deterministic contact validation does NOT apply to manual entries. This is intentional — a rep manually typing a phone number should not be forced into review for a typo; the rep is responsible for their own manual data.

### 8.4 Key Test: TEST G — Multiple Simultaneous Violations

**Input:** overall 60%, phone `+9198344` (invalid), emails `[]` with `fieldStatus.emails: ['uncertain']`
**Expected reasons:** `LOW_CONFIDENCE` + `INVALID_PHONE` + `UNCERTAIN_FIELD` (3 reasons)

This verifies that rules are collected, not short-circuited. All three rules fire independently and all appear in `reasons[]`.

### 8.5 Key Test: TEST 7 — High Confidence Does Not Suppress Deterministic Validation

**Input:** overall 95%, phone confidence 0.90, phone `+9198344` (incomplete Indian number)
**Expected:** `INVALID_PHONE` fires, `LOW_FIELD_CONFIDENCE` does NOT fire (0.90 > 0.75)

This verifies the independence of deterministic validation from confidence scores. A phone with high confidence that is structurally invalid still triggers review.

---

## 9. Modification Guide

### Changing the threshold
1. Update the `runtime_configuration` row: `UPDATE runtime_configuration SET review_minimum_confidence = <value> WHERE id = 1;`
2. Call `reload()` from `runtimeConfiguration.ts` to refresh the cache, OR restart the app
3. The value is clamped to 0–100 on read
4. Both `LOW_CONFIDENCE` and `LOW_FIELD_CONFIDENCE` use the same threshold
5. The comparison is `<=` — a value equal to the threshold triggers review

### Adding a new review reason
1. Add to `ReviewReason` enum
2. Add evaluation logic in `CaptureReviewEngine.evaluate()` following the existing pattern
3. If terminal: return immediately after pushing the reason
4. If non-terminal: push to `reasons[]` and continue
5. Add a violation type if the rule produces structured violation data
6. Add a test case in `scripts/test_reviewEngine.ts`
7. Rebuild the test: `npx esbuild scripts/test_reviewEngine.ts --bundle --platform=node --format=cjs --alias:../supabaseClient=./scripts/test_supabase_stub.ts --outfile=scripts/test_reviewEngine.cjs && node scripts/test_reviewEngine.cjs`

### Adding a new deterministic validator
1. Write a `validateX(value, index?): ContactValidationViolation | null` function
2. Add it to `findContactValidationViolations()` — check both array and legacy single fields
3. Use `isMeaningful()` to skip absent/placeholder values
4. Add the corresponding `ReviewReason` if it doesn't exist
5. The reason will be automatically deduplicated in the reasons array

### Modifying the null-confidence guard
This is the most sensitive rule. Currently, `extractionConfidence === null` skips ALL rules including deterministic validation. If you change this:
- Test 8 will fail — verify the new behavior is intentional
- Manual entries will start being validated — consider whether reps should be forced into review for manual typos
- The QR path may be affected — QR parsing currently sets a numeric confidence, not null, so it should be unaffected

### Modifying persistence
1. `persistExtractionMetadata()` updates 5 columns — if you add columns, add them to the update payload
2. `persistReviewResult()` updates 1 column (`review_metadata`) — if you add fields to `ReviewResult`, add them to the `reviewMetadata` object
3. Both functions catch all errors and never throw — preserve this invariant
4. The `extraction_metadata` and `review_metadata` columns are `jsonb NOT NULL DEFAULT '{}'` — they always exist, never null

### Modifying the test script
The test script is compiled via esbuild (not tsc) because it stubs the Supabase import. After modifying `test_reviewEngine.ts`:
```bash
npx esbuild scripts/test_reviewEngine.ts --bundle --platform=node --format=cjs \
  --alias:../supabaseClient=./scripts/test_supabase_stub.ts \
  --outfile=scripts/test_reviewEngine.cjs && node scripts/test_reviewEngine.cjs
```

The stub (`scripts/test_supabase_stub.ts`) provides an empty module so the import resolves. The `runtimeConfiguration` cache is never loaded in tests, so the default threshold (75) is always used.
