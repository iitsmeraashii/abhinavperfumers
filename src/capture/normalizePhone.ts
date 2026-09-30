// Phone-number normalization utility.
//
// Converts raw phone strings into a canonical digits-only international
// representation WITHOUT guessing the phone's country.
//
// Key rules:
//   - `+` prefix  → strip `+`, return digits (already international)
//   - `00` prefix → strip `00`, return digits (already international)
//   - Explicit dialCode supplied → prepend dial code digits to local number
//   - No international prefix AND no dialCode → return MISSING_COUNTRY_CONTEXT
//   - NEVER prepends a country code based on digit count, lead country, or any
//     other heuristic.
//   - NEVER calls deriveCountry, resolveLeadCountry, or any country function.
//
// The canonical form is bare digits without `+` (E.164 minus the leading `+`),
// which is the format WhatsApp/Meta expects.

export interface NormalizePhoneOptions {
  /** Explicit international dial code, e.g. `+91`, `+971`. Must NOT be derived from lead country. */
  dialCode?: string;
}

export type PhoneNormalizationResult =
  | { ok: true; value: string }
  | { ok: false; value: null; reason: 'MISSING_COUNTRY_CONTEXT' | 'INVALID_PHONE' };

const MIN_DIGITS = 7;
const MAX_DIGITS = 15;

function extractDigits(s: string): string {
  return s.replace(/\D/g, '');
}

function stripPresentation(s: string): string {
  return s.replace(/[\s\-().]/g, '');
}

function normalizeDialCode(dialCode: string): string {
  return extractDigits(dialCode);
}

/**
 * Normalize a raw phone number into canonical digits-only international form.
 *
 * - Already-international numbers (`+…` or `00…`) are normalized without
 *   requiring country context.
 * - Local/national numbers require an explicit `dialCode` in options.
 * - A bare 10-digit number will NOT be assumed Indian.
 *
 * Returns a discriminated union: `{ ok: true, value }` on success, or
 * `{ ok: false, value: null, reason }` on failure.
 */
export function normalizePhone(
  rawPhone: string | null | undefined,
  options?: NormalizePhoneOptions,
): PhoneNormalizationResult {
  if (!rawPhone || !rawPhone.trim()) {
    return { ok: false, value: null, reason: 'INVALID_PHONE' };
  }

  const cleaned = stripPresentation(rawPhone.trim());

  if (!cleaned) {
    return { ok: false, value: null, reason: 'INVALID_PHONE' };
  }

  // ── Already international: `+` prefix ──────────────────────────────────
  if (cleaned.startsWith('+')) {
    const digits = extractDigits(cleaned);
    if (digits.length < MIN_DIGITS || digits.length > MAX_DIGITS) {
      return { ok: false, value: null, reason: 'INVALID_PHONE' };
    }
    return { ok: true, value: digits };
  }

  // ── Already international: `00` prefix ─────────────────────────────────
  if (cleaned.startsWith('00')) {
    const digits = extractDigits(cleaned.slice(2));
    if (digits.length < MIN_DIGITS || digits.length > MAX_DIGITS) {
      return { ok: false, value: null, reason: 'INVALID_PHONE' };
    }
    return { ok: true, value: digits };
  }

  // ── Local/national number with explicit dial code ──────────────────────
  const dialCode = options?.dialCode?.trim();
  if (dialCode) {
    const ccDigits = normalizeDialCode(dialCode);
    if (!ccDigits) {
      return { ok: false, value: null, reason: 'INVALID_PHONE' };
    }

    let localDigits = extractDigits(cleaned);

    // If the number already starts with the dial code digits, it is already
    // in international form — recognize it as such rather than prepending the
    // dial code a second time (which would produce e.g. 91919876543210).
    if (localDigits.startsWith(ccDigits) && localDigits.length > ccDigits.length) {
      if (localDigits.length >= MIN_DIGITS && localDigits.length <= MAX_DIGITS) {
        return { ok: true, value: localDigits };
      }
      return { ok: false, value: null, reason: 'INVALID_PHONE' };
    }

    // Strip trunk-prefix `0` when converting local → international.
    if (localDigits.startsWith('0')) {
      localDigits = localDigits.slice(1);
    }

    if (!localDigits) {
      return { ok: false, value: null, reason: 'INVALID_PHONE' };
    }

    const combined = ccDigits + localDigits;
    if (combined.length < MIN_DIGITS || combined.length > MAX_DIGITS) {
      return { ok: false, value: null, reason: 'INVALID_PHONE' };
    }
    return { ok: true, value: combined };
  }

  // ── Local/national number without any country context ──────────────────
  // Do NOT guess. Return a clearly distinguishable result.
  const digits = extractDigits(cleaned);
  if (digits.length < MIN_DIGITS) {
    return { ok: false, value: null, reason: 'INVALID_PHONE' };
  }
  return { ok: false, value: null, reason: 'MISSING_COUNTRY_CONTEXT' };
}

/**
 * Produce a deduplication key for a phone number.
 *
 * Returns the canonical digits if normalization succeeds. If the number
 * cannot be normalized (missing country context), falls back to the raw
 * digits so that visually-different but digit-identical values still dedup.
 *
 * Always returns a string — never null — so it can be used directly as a
 * Map key or array includes() comparator.
 */
export function phoneDedupKey(
  rawPhone: string | null | undefined,
  options?: NormalizePhoneOptions,
): string {
  const result = normalizePhone(rawPhone, options);
  if (result.ok) return result.value;
  // Fallback: raw digits (presentation stripped) for best-effort dedup.
  if (!rawPhone) return '';
  return extractDigits(stripPresentation(rawPhone.trim()));
}
