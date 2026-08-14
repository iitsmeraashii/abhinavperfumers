// Review Rule Engine — evaluates whether a captured lead requires manual review.
//
// Design: module singleton, mirrors captureExtractionCoordinator pattern.
// Rules are stateless; the threshold is read from runtime configuration.
//
// Rules:
//   QR_NO_EXTRACTION        — QR scan produced no contact fields.
//   LOW_CONFIDENCE          — AI confidence <= configured threshold.
//   LOW_FIELD_CONFIDENCE    — a model-reported per-field confidence <= threshold.
//   INSUFFICIENT_EXTRACTION — only one meaningful extracted field.
//   SUSPICIOUS_CONTACT      — extracted email/phone/website looks invalid (legacy heuristic).
//   INVALID_PHONE           — deterministic phone sanity check failed.
//   INVALID_EMAIL           — deterministic email sanity check failed.
//   INVALID_WEBSITE         — deterministic website sanity check failed.
//   EXTRACTION_FAILED       — extraction pipeline reported failure or partial result.

import type { DraftData, FieldConfidenceReport, FieldStatusReport } from './types';
import { getReviewMinimumConfidence } from '../runtime/runtimeDiagnostics';

// ─── Configuration ───────────────────────────────────────────────────────────

/**
 * Fallback threshold used only when the runtime configuration has not been
 * loaded yet. The live value is read from the runtime_configuration table
 * via RuntimeConfiguration's in-memory cache.
 */
const FALLBACK_MINIMUM_CONFIDENCE = 75;

/** Extraction lifecycle status from the pipeline. */
export type ExtractionStatus = 'done' | 'failed' | 'skipped' | null;

// ─── Types ────────────────────────────────────────────────────────────────────

export enum ReviewReason {
  LOW_CONFIDENCE          = 'LOW_CONFIDENCE',
  LOW_FIELD_CONFIDENCE    = 'LOW_FIELD_CONFIDENCE',
  QR_NO_EXTRACTION        = 'QR_NO_EXTRACTION',
  INSUFFICIENT_EXTRACTION = 'INSUFFICIENT_EXTRACTION',
  SUSPICIOUS_CONTACT      = 'SUSPICIOUS_CONTACT',
  INVALID_PHONE           = 'INVALID_PHONE',
  INVALID_EMAIL           = 'INVALID_EMAIL',
  INVALID_WEBSITE         = 'INVALID_WEBSITE',
  UNCERTAIN_FIELD         = 'UNCERTAIN_FIELD',
  EXTRACTION_FAILED       = 'EXTRACTION_FAILED',
}

/** A single field-confidence violation with enough detail to surface in the UI. */
export interface FieldConfidenceViolation {
  field:  string;   // e.g. "company", "phoneNumbers", "emails"
  value:  string;   // the extracted value that triggered the violation
  index?: number;   // for array fields — positional index of the low-confidence entry
  score:  number;   // model-reported confidence (0–1)
}

/** A deterministic contact-validation violation. */
export interface ContactValidationViolation {
  field:  'phoneNumbers' | 'emails' | 'website';
  value:  string;
  index?: number;   // for array fields
  reason: ReviewReason;  // INVALID_PHONE | INVALID_EMAIL | INVALID_WEBSITE
  detail: string;   // human-readable explanation
}

/** A field-status violation — model marked a field as 'uncertain'. */
export interface FieldStatusViolation {
  field:  string;   // e.g. "phoneNumbers", "website"
  index?: number;   // for array fields
  status: 'uncertain';
  value:  string | null;  // the extracted value (null when array is empty)
}

export interface ReviewResult {
  /** Whether the lead requires manual review before promotion. */
  required:   boolean;
  /** The first rule that triggered review, or null if none triggered.
   *  Kept for backward compatibility — {@link reasons} holds the full list. */
  reason:     ReviewReason | null;
  /** All review reasons that triggered, in evaluation order. Empty when no rule fires. */
  reasons:    ReviewReason[];
  /**
   * The confidence value (0–100) that was evaluated, or null if no AI
   * extraction confidence was available for this capture session.
   */
  confidence: number | null;
  /** Per-field confidence violations (only populated when LOW_FIELD_CONFIDENCE fires). */
  fieldConfidenceViolations?: FieldConfidenceViolation[];
  /** Deterministic contact-validation violations (phone/email/website). */
  contactViolations?: ContactValidationViolation[];
  /** Field-status violations — model marked a field as 'uncertain'. */
  fieldStatusViolations?: FieldStatusViolation[];
}

/** Additional extraction context passed to evaluate() from the pipeline. */
export interface ExtractionContext {
  /** Lifecycle status of the extraction stage: 'done', 'failed', 'skipped', or null when no extraction ran. */
  status: ExtractionStatus;
  /** Model-reported per-field confidence. */
  fieldConfidence?: FieldConfidenceReport;
  /** Model-reported per-field extraction status. */
  fieldStatus?: FieldStatusReport;
  /** Correlation ID for diagnostics — set by the pipeline, read by strategy-level diagnostics. */
  backendSessionId?: string;
}

// ─── Review-only validation helpers ───────────────────────────────────────────

const PLACEHOLDER_PATTERNS = /^(n\/?a|none|null|undefined|unknown|\.+|-+|test|xxx|example\..*|sample)$/i;

/** Patterns that indicate masked/obscured content — e.g. "XXXX", "***", "????". */
const MASKED_PATTERNS = /x{2,}|\*{2,}|\?{2,}|_{2,}/i;

function isMeaningful(value: string | undefined | null): boolean {
  if (!value) return false;
  const trimmed = String(value).trim();
  if (!trimmed) return false;
  if (PLACEHOLDER_PATTERNS.test(trimmed)) return false;
  return true;
}

// ─── Deterministic phone validation ───────────────────────────────────────────

/**
 * Strip formatting characters from a phone number, keeping only digits.
 */
function phoneDigits(phone: string): string {
  return phone.replace(/\D/g, '');
}

/**
 * Deterministic sanity check for a single phone number.
 *
 * Checks:
 * - Obvious placeholders / masked content (XXXX, ***, ????)
 * - Indian number plausibility (+91 / 91 prefix → 10 digits starting 6-9)
 * - Generic international plausibility (7-15 digits)
 *
 * Returns a ContactValidationViolation when invalid, or null when the number
 * passes all checks.
 */
function validatePhone(phone: string, index: number): ContactValidationViolation | null {
  const trimmed = phone.trim();
  if (!trimmed) return null; // absent values are not validation failures

  // Check for masked/obscured content
  if (MASKED_PATTERNS.test(trimmed)) {
    return { field: 'phoneNumbers', value: phone, index, reason: ReviewReason.INVALID_PHONE, detail: 'Contains masked or obscured characters' };
  }
  if (PLACEHOLDER_PATTERNS.test(trimmed)) {
    return { field: 'phoneNumbers', value: phone, index, reason: ReviewReason.INVALID_PHONE, detail: 'Placeholder value' };
  }

  const digits = phoneDigits(trimmed);

  // Indian number checks
  // A number starting with 91 is claiming an Indian country code.
  // +91 followed by a 10-digit mobile → 12 digits total (91 + 10).
  // If it starts with 91 but has fewer than 12 digits, the mobile part is incomplete.
  if (digits.startsWith('91')) {
    const mobilePart = digits.slice(2);
    if (mobilePart.length < 10) {
      return { field: 'phoneNumbers', value: phone, index, reason: ReviewReason.INVALID_PHONE, detail: `Incomplete Indian number: only ${mobilePart.length} digits after country code (expected 10)` };
    }
    if (mobilePart.length === 10 && !/^[6-9]/.test(mobilePart)) {
      return { field: 'phoneNumbers', value: phone, index, reason: ReviewReason.INVALID_PHONE, detail: 'Indian mobile number should start with 6, 7, 8, or 9' };
    }
    // Valid Indian number with 91 prefix
    return null;
  }

  // 10-digit Indian mobile without country code (starts 6-9)
  if (digits.length === 10 && /^[6-9]/.test(digits)) {
    return null; // valid Indian mobile
  }

  // Generic international plausibility: 7-15 digits
  if (digits.length < 7) {
    return { field: 'phoneNumbers', value: phone, index, reason: ReviewReason.INVALID_PHONE, detail: `Too short: only ${digits.length} digits` };
  }
  if (digits.length > 15) {
    return { field: 'phoneNumbers', value: phone, index, reason: ReviewReason.INVALID_PHONE, detail: `Too long: ${digits.length} digits (max 15 per ITU-T E.164)` };
  }

  return null;
}

// ─── Deterministic email validation ───────────────────────────────────────────

/**
 * Deterministic sanity check for a single email address.
 *
 * Checks:
 * - Exactly one @
 * - Non-empty local part and domain
 * - Domain contains a dot
 * - No whitespace
 * - No placeholder/masked content
 *
 * Returns a ContactValidationViolation when invalid, or null when valid.
 */
function validateEmail(email: string, index: number): ContactValidationViolation | null {
  const trimmed = email.trim();
  if (!trimmed) return null;

  // No whitespace allowed
  if (/\s/.test(trimmed)) {
    return { field: 'emails', value: email, index, reason: ReviewReason.INVALID_EMAIL, detail: 'Contains whitespace' };
  }

  // Masked content
  if (MASKED_PATTERNS.test(trimmed)) {
    return { field: 'emails', value: email, index, reason: ReviewReason.INVALID_EMAIL, detail: 'Contains masked or obscured characters' };
  }

  // Exactly one @
  const atCount = (trimmed.match(/@/g) ?? []).length;
  if (atCount !== 1) {
    return { field: 'emails', value: email, index, reason: ReviewReason.INVALID_EMAIL, detail: atCount === 0 ? 'Missing @ symbol' : 'Multiple @ symbols' };
  }

  const [local, domain] = trimmed.split('@');

  if (!local || local.length < 1) {
    return { field: 'emails', value: email, index, reason: ReviewReason.INVALID_EMAIL, detail: 'Empty local part (before @)' };
  }

  if (!domain || domain.length < 1) {
    return { field: 'emails', value: email, index, reason: ReviewReason.INVALID_EMAIL, detail: 'Empty domain (after @)' };
  }

  if (!domain.includes('.')) {
    return { field: 'emails', value: email, index, reason: ReviewReason.INVALID_EMAIL, detail: 'Domain missing dot (e.g. "company" instead of "company.com")' };
  }

  // Placeholder check on parts
  if (PLACEHOLDER_PATTERNS.test(local) || PLACEHOLDER_PATTERNS.test(domain)) {
    return { field: 'emails', value: email, index, reason: ReviewReason.INVALID_EMAIL, detail: 'Placeholder value in local or domain' };
  }

  // Domain structural check — reject domains starting/ending with dot or hyphen
  if (domain.startsWith('.') || domain.endsWith('.')) {
    return { field: 'emails', value: email, index, reason: ReviewReason.INVALID_EMAIL, detail: 'Malformed domain (starts or ends with dot)' };
  }

  return null;
}

// ─── Deterministic website validation ─────────────────────────────────────────

/**
 * Deterministic sanity check for a website URL.
 *
 * Checks:
 * - No whitespace
 * - No placeholder/masked content
 * - Domain contains a dot
 * - Rejects bare strings without domain structure
 * - Does NOT require protocol (http:// or https://)
 *
 * Returns a ContactValidationViolation when invalid, or null when valid.
 */
function validateWebsite(website: string): ContactValidationViolation | null {
  const trimmed = website.trim();
  if (!trimmed) return null;

  if (/\s/.test(trimmed)) {
    return { field: 'website', value: website, reason: ReviewReason.INVALID_WEBSITE, detail: 'Contains whitespace' };
  }

  if (MASKED_PATTERNS.test(trimmed)) {
    return { field: 'website', value: website, reason: ReviewReason.INVALID_WEBSITE, detail: 'Contains masked or obscured characters' };
  }

  if (PLACEHOLDER_PATTERNS.test(trimmed)) {
    return { field: 'website', value: website, reason: ReviewReason.INVALID_WEBSITE, detail: 'Placeholder value' };
  }

  // Strip protocol if present for domain check
  const withoutProtocol = trimmed.replace(/^https?:\/\//i, '');

  if (!withoutProtocol.includes('.')) {
    return { field: 'website', value: website, reason: ReviewReason.INVALID_WEBSITE, detail: 'Domain missing dot (e.g. "company" instead of "company.com")' };
  }

  // Reject domains starting/ending with dot
  if (withoutProtocol.startsWith('.') || withoutProtocol.endsWith('.')) {
    return { field: 'website', value: website, reason: ReviewReason.INVALID_WEBSITE, detail: 'Malformed domain (starts or ends with dot)' };
  }

  return null;
}

/**
 * Run deterministic contact validation on all extracted phone/email/website fields.
 * Returns all violations found — does NOT short-circuit on the first one.
 */
function findContactValidationViolations(data: DraftData): ContactValidationViolation[] {
  const violations: ContactValidationViolation[] = [];

  // Phones — check both phoneNumbers array and legacy phone field
  const checkedPhoneIndices = new Set<number>();
  if (Array.isArray(data.phoneNumbers)) {
    for (let i = 0; i < data.phoneNumbers.length; i++) {
      const v = String(data.phoneNumbers[i] ?? '').trim();
      if (!isMeaningful(v)) continue;
      const violation = validatePhone(v, i);
      if (violation) violations.push(violation);
      checkedPhoneIndices.add(i);
    }
  }
  // Legacy single phone field — only if not already covered by array[0]
  if (isMeaningful(data.phone) && (!Array.isArray(data.phoneNumbers) || !checkedPhoneIndices.has(0))) {
    const violation = validatePhone(data.phone!, 0);
    if (violation) violations.push(violation);
  }

  // Emails — check both emails array and legacy email field
  const checkedEmailIndices = new Set<number>();
  if (Array.isArray(data.emails)) {
    for (let i = 0; i < data.emails.length; i++) {
      const v = String(data.emails[i] ?? '').trim();
      if (!isMeaningful(v)) continue;
      const violation = validateEmail(v, i);
      if (violation) violations.push(violation);
      checkedEmailIndices.add(i);
    }
  }
  if (isMeaningful(data.email) && (!Array.isArray(data.emails) || !checkedEmailIndices.has(0))) {
    const violation = validateEmail(data.email!, 0);
    if (violation) violations.push(violation);
  }

  // Website
  if (isMeaningful(data.website)) {
    const violation = validateWebsite(data.website!);
    if (violation) violations.push(violation);
  }

  return violations;
}

// ─── Legacy suspicious-contact helpers (SUSPICIOUS_CONTACT rule) ──────────────

function isSuspiciousEmail(email: string): boolean {
  const trimmed = email.trim();
  if (!trimmed) return false;
  const atCount = (trimmed.match(/@/g) ?? []).length;
  if (atCount !== 1) return true;
  const [local, domain] = trimmed.split('@');
  if (!local || local.length < 1) return true;
  if (!domain || !domain.includes('.')) return true;
  if (PLACEHOLDER_PATTERNS.test(local) || PLACEHOLDER_PATTERNS.test(domain)) return true;
  return false;
}

function isSuspiciousPhone(phone: string): boolean {
  const trimmed = phone.trim();
  if (!trimmed) return false;
  const digits = trimmed.replace(/[\s\-().+#]/g, '');
  if (digits.length < 7) return true;
  if (PLACEHOLDER_PATTERNS.test(trimmed)) return true;
  return false;
}

function isSuspiciousWebsite(website: string): boolean {
  const trimmed = website.trim();
  if (!trimmed) return false;
  if (PLACEHOLDER_PATTERNS.test(trimmed)) return true;
  if (!trimmed.includes('.')) return true;
  return false;
}

/**
 * Count the number of meaningful extracted business-card fields in DraftData.
 * Uses the same field set as the pipeline's extraction merge logic.
 */
function countMeaningfulFields(d: DraftData): number {
  let count = 0;
  if (isMeaningful(d.clientName)) count++;
  if (isMeaningful(d.company)) count++;
  if (isMeaningful(d.designation)) count++;
  if (isMeaningful(d.phone) || (Array.isArray(d.phoneNumbers) && d.phoneNumbers.some(p => isMeaningful(p)))) count++;
  if (isMeaningful(d.email) || (Array.isArray(d.emails) && d.emails.some(e => isMeaningful(e)))) count++;
  if (isMeaningful(d.website)) count++;
  if (isMeaningful(d.address)) count++;
  return count;
}

/**
 * Legacy suspicious-contact check. Returns the first suspicious field name
 * found, or null if all look valid. This overlaps with the deterministic
 * validators but is retained per the "do not change existing rules" constraint.
 */
function findSuspiciousContact(d: DraftData): string | null {
  const emails: string[] = [];
  if (isMeaningful(d.email)) emails.push(d.email!);
  if (Array.isArray(d.emails)) for (const e of d.emails) if (isMeaningful(e)) emails.push(e);
  for (const e of emails) if (isSuspiciousEmail(e)) return 'email';

  const phones: string[] = [];
  if (isMeaningful(d.phone)) phones.push(d.phone!);
  if (Array.isArray(d.phoneNumbers)) for (const p of d.phoneNumbers) if (isMeaningful(p)) phones.push(p);
  for (const p of phones) if (isSuspiciousPhone(p)) return 'phone';

  if (isMeaningful(d.website) && isSuspiciousWebsite(d.website!)) return 'website';

  return null;
}

// ─── Field-confidence helpers ─────────────────────────────────────────────────

/** Scalar fields to check and their corresponding DraftData key. */
const SCALAR_FIELD_MAP: ReadonlyArray<{ fcKey: keyof FieldConfidenceReport; draftKey: keyof DraftData }> = [
  { fcKey: 'fullName',    draftKey: 'clientName'  },
  { fcKey: 'company',     draftKey: 'company'     },
  { fcKey: 'designation', draftKey: 'designation' },
  { fcKey: 'website',     draftKey: 'website'     },
  { fcKey: 'address',     draftKey: 'address'     },
];

/**
 * Inspect model-reported per-field confidence and return violations for any
 * extracted field whose confidence is at or below the threshold.
 *
 * - Scalar fields: checked only when the extracted value is meaningful.
 * - Array fields (phoneNumbers, emails): each entry checked positionally
 *   against the parallel confidence array; only meaningful entries with a
 *   matching confidence entry are considered.
 *
 * The threshold is on a 0–100 scale; model confidence is 0–1, so we convert.
 * Returns an empty array when fieldConfidence is absent.
 */
function findFieldConfidenceViolations(
  data: DraftData,
  fc: FieldConfidenceReport | undefined,
  thresholdPercent: number,
): FieldConfidenceViolation[] {
  if (!fc) return [];
  const threshold = thresholdPercent / 100; // convert 0–100 → 0–1
  const violations: FieldConfidenceViolation[] = [];

  // Scalar fields
  for (const { fcKey, draftKey } of SCALAR_FIELD_MAP) {
    const score = fc[fcKey];
    if (typeof score !== 'number') continue;
    const value = String(data[draftKey] ?? '').trim();
    if (!isMeaningful(value)) continue;
    if (score <= threshold) {
      violations.push({ field: fcKey, value, score });
    }
  }

  // Array field: phoneNumbers
  if (Array.isArray(fc.phoneNumbers) && Array.isArray(data.phoneNumbers)) {
    for (let i = 0; i < data.phoneNumbers.length; i++) {
      const score = fc.phoneNumbers[i];
      if (typeof score !== 'number') continue;
      const value = String(data.phoneNumbers[i] ?? '').trim();
      if (!isMeaningful(value)) continue;
      if (score <= threshold) {
        violations.push({ field: 'phoneNumbers', value, index: i, score });
      }
    }
  }

  // Array field: emails
  if (Array.isArray(fc.emails) && Array.isArray(data.emails)) {
    for (let i = 0; i < data.emails.length; i++) {
      const score = fc.emails[i];
      if (typeof score !== 'number') continue;
      const value = String(data.emails[i] ?? '').trim();
      if (!isMeaningful(value)) continue;
      if (score <= threshold) {
        violations.push({ field: 'emails', value, index: i, score });
      }
    }
  }

  return violations;
}

// ─── Field-status helpers ─────────────────────────────────────────────────────

/**
 * Scalar fields to check in fieldStatus and their corresponding DraftData key.
 */
const STATUS_SCALAR_FIELD_MAP: ReadonlyArray<{ fsKey: keyof FieldStatusReport; draftKey: keyof DraftData }> = [
  { fsKey: 'fullName',    draftKey: 'clientName'  },
  { fsKey: 'company',     draftKey: 'company'     },
  { fsKey: 'designation', draftKey: 'designation' },
  { fsKey: 'website',     draftKey: 'website'     },
  { fsKey: 'address',     draftKey: 'address'     },
];

/**
 * Inspect model-reported fieldStatus and return violations for any field
 * explicitly marked as 'uncertain'.
 *
 * - Scalar fields: checked via the fieldStatus report directly.
 * - Array fields (phoneNumbers, emails): each entry checked positionally;
 *   an 'uncertain' entry may not have a corresponding value in the values
 *   array (e.g. phoneNumbers: [] with fieldStatus.phoneNumbers: ['uncertain']).
 *
 * Returns an empty array when fieldStatus is absent.
 */
function findFieldStatusViolations(
  data: DraftData,
  fs: FieldStatusReport | undefined,
): FieldStatusViolation[] {
  if (!fs) return [];
  const violations: FieldStatusViolation[] = [];

  // Scalar fields
  for (const { fsKey, draftKey } of STATUS_SCALAR_FIELD_MAP) {
    const status = fs[fsKey];
    if (status !== 'uncertain') continue;
    const value = String(data[draftKey] ?? '').trim() || null;
    violations.push({ field: fsKey, status: 'uncertain', value });
  }

  // Array field: phoneNumbers
  if (Array.isArray(fs.phoneNumbers)) {
    for (let i = 0; i < fs.phoneNumbers.length; i++) {
      if (fs.phoneNumbers[i] !== 'uncertain') continue;
      const value = Array.isArray(data.phoneNumbers) ? String(data.phoneNumbers[i] ?? '').trim() || null : null;
      violations.push({ field: 'phoneNumbers', index: i, status: 'uncertain', value });
    }
  }

  // Array field: emails
  if (Array.isArray(fs.emails)) {
    for (let i = 0; i < fs.emails.length; i++) {
      if (fs.emails[i] !== 'uncertain') continue;
      const value = Array.isArray(data.emails) ? String(data.emails[i] ?? '').trim() || null : null;
      violations.push({ field: 'emails', index: i, status: 'uncertain', value });
    }
  }

  return violations;
}

// ─── Rule Engine ──────────────────────────────────────────────────────────────

class CaptureReviewEngine {
  /**
   * Return the current minimum confidence threshold (0–100).
   * Reads from the in-memory runtime configuration cache — O(1), no DB call.
   * Falls back to 75 when the cache has not been populated yet.
   */
  private get minimumConfidence(): number {
    const configured = getReviewMinimumConfidence();
    return Number.isFinite(configured) ? configured : FALLBACK_MINIMUM_CONFIDENCE;
  }

  /**
   * Evaluate review rules for a capture session.
   *
   * All applicable rules are evaluated — the result retains the full list of
   * triggered reasons in {@link ReviewResult.reasons}. The {@link ReviewResult.reason}
   * field holds the first triggered reason for backward compatibility.
   *
   * Rule evaluation order:
   *   1. QR_NO_EXTRACTION        (terminal — returns immediately)
   *   2. EXTRACTION_FAILED       (terminal — returns immediately)
   *   3. null-confidence guard   (manual entry — returns immediately, no review)
   *   4. LOW_CONFIDENCE
   *   5. LOW_FIELD_CONFIDENCE
   *   6. INSUFFICIENT_EXTRACTION
   *   7. SUSPICIOUS_CONTACT      (legacy heuristic)
   *   8. INVALID_PHONE           (deterministic)
   *   9. INVALID_EMAIL           (deterministic)
   *  10. INVALID_WEBSITE         (deterministic)
   *
   * @param data                 Full DraftData — needed for all field-level rules.
   * @param extractionConfidence AI extraction confidence on a 0–100 scale,
   *                             or null if no AI extraction occurred.
   * @param extraction           Extraction lifecycle context (status, fieldConfidence),
   *                             or undefined if called from a context that doesn't track it.
   * @returns ReviewResult — always non-null; required=false when no rule fires.
   */
  evaluate(
    data: DraftData,
    extractionConfidence: number | null,
    extraction?: ExtractionContext,
  ): ReviewResult {
    const reasons: ReviewReason[] = [];
    let fieldConfidenceViolations: FieldConfidenceViolation[] | undefined;
    let contactViolations: ContactValidationViolation[] | undefined;

    // Rule: QR_NO_EXTRACTION
    if (data.qrExtractionEmpty) {
      reasons.push(ReviewReason.QR_NO_EXTRACTION);
      return {
        required:   true,
        reason:     reasons[0]!,
        reasons,
        confidence: null,
      };
    }

    // Rule: EXTRACTION_FAILED
    if (extraction?.status === 'failed') {
      reasons.push(ReviewReason.EXTRACTION_FAILED);
      return {
        required:   true,
        reason:     reasons[0]!,
        reasons,
        confidence: extractionConfidence,
      };
    }

    // When confidence is null and extraction did not fail, this is a genuine
    // manual entry or a skipped extraction (no AI evidence). Do not force
    // review solely because confidence is null.
    // Deterministic contact validation also does NOT apply to manual entries.
    if (extractionConfidence === null) {
      return { required: false, reason: null, reasons: [], confidence: null };
    }

    // Rule: LOW_CONFIDENCE
    if (extractionConfidence <= this.minimumConfidence) {
      reasons.push(ReviewReason.LOW_CONFIDENCE);
    }

    // Rule: LOW_FIELD_CONFIDENCE
    const fcViolations = findFieldConfidenceViolations(
      data,
      extraction?.fieldConfidence,
      this.minimumConfidence,
    );
    if (fcViolations.length > 0) {
      reasons.push(ReviewReason.LOW_FIELD_CONFIDENCE);
      fieldConfidenceViolations = fcViolations;
    }

    // Rule: INSUFFICIENT_EXTRACTION
    if (countMeaningfulFields(data) <= 1) {
      reasons.push(ReviewReason.INSUFFICIENT_EXTRACTION);
    }

    // Rule: SUSPICIOUS_CONTACT (legacy heuristic — retained)
    const suspiciousField = findSuspiciousContact(data);
    if (suspiciousField) {
      reasons.push(ReviewReason.SUSPICIOUS_CONTACT);
    }

    // ── Deterministic contact validation ──
    // These rules are independent of AI confidence. A high overall or
    // field-level confidence does NOT suppress them. They catch structurally
    // invalid extracted values that the model reported with high confidence.
    const detViolations = findContactValidationViolations(data);
    if (detViolations.length > 0) {
      contactViolations = detViolations;
      // Add each distinct reason (INVALID_PHONE, INVALID_EMAIL, INVALID_WEBSITE)
      // — deduplicated so each reason appears at most once.
      const seen = new Set<ReviewReason>();
      for (const v of detViolations) {
        if (!seen.has(v.reason)) {
          reasons.push(v.reason);
          seen.add(v.reason);
        }
      }
    }

    // Rule: UNCERTAIN_FIELD
    // Fires when the model explicitly marks a field as 'uncertain' in
    // fieldStatus. This is independent of AI confidence — a high overall
    // score does NOT suppress it. It catches cases where a field was visibly
    // present on the card but could not be reliably extracted.
    const fsViolations = findFieldStatusViolations(data, extraction?.fieldStatus);
    if (fsViolations.length > 0) {
      reasons.push(ReviewReason.UNCERTAIN_FIELD);
    }

    if (reasons.length > 0) {
      return {
        required:   true,
        reason:     reasons[0]!,
        reasons,
        confidence: extractionConfidence,
        fieldConfidenceViolations,
        contactViolations,
        fieldStatusViolations: fsViolations.length > 0 ? fsViolations : undefined,
      };
    }

    return { required: false, reason: null, reasons: [], confidence: extractionConfidence };
  }
}

export const reviewEngine = new CaptureReviewEngine();
