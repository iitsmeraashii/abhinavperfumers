// Phone-country resolution hierarchy.
//
// Determines the phone-country dial code to use for normalizing a phone number.
// Resolution order (highest priority first):
//
//   1. Phone is already international (`+…` or `00…`) and its dial code
//      uniquely maps to a single country → return that dial code
//   2. Phone is already international but dial code is ambiguous (e.g. +1)
//      → return null (normalization still works; UI display stays generic)
//   3. User explicitly selected a phone-country dial code → use it
//   4. Qualifying 10-digit Indian mobile (starts with 6/7/8/9, no intl prefix,
//      no user selection) → '+91'
//   5. No safe context → null (do not guess)
//
// This module does NOT modify lead country, does NOT call resolveLeadCountry,
// does NOT use address/state/city, and does NOT change the phone value itself.

import { COUNTRIES } from './countryData';

export interface PhoneCountryResolutionInput {
  /** Raw phone number string. */
  phone: string | null | undefined;
  /** Explicitly user-selected dial code (e.g. '+91', '+971'), if any. */
  selectedDialCode?: string | null;
  /** True if capture started as MANUAL from the beginning (kept for API compat). */
  isManualCapture?: boolean;
  /** Address string — no longer used for phone-country resolution. */
  address?: string | null;
}

/**
 * Check if a phone string is already international (starts with `+` or `00`).
 */
export function isInternationalPhone(phone: string | null | undefined): boolean {
  if (!phone || !phone.trim()) return false;
  const cleaned = phone.trim().replace(/[\s\-().]/g, '');
  return cleaned.startsWith('+') || cleaned.startsWith('00');
}

/**
 * Check if a phone is plausibly an Indian mobile number.
 *
 * Indian mobile numbers are 10 digits, starting with 6, 7, 8, or 9.
 * May optionally have a leading 0 (trunk prefix).
 */
export function isPlausiblyIndianMobile(phone: string | null | undefined): boolean {
  if (!phone || !phone.trim()) return false;
  const digits = phone.replace(/\D/g, '');
  // Strip leading 0 (trunk prefix)
  const normalized = digits.startsWith('0') ? digits.slice(1) : digits;
  // Indian mobile: 10 digits, starts with 6/7/8/9
  return normalized.length === 10 && /^[6-9]\d{9}$/.test(normalized);
}

/**
 * Extract the digits from a dial code string (e.g. '+91' → '91').
 */
function dialCodeDigits(dialCode: string): string {
  return dialCode.replace(/\D/g, '');
}

/**
 * Try to find the unique country whose dial code matches the international
 * prefix of the given phone.
 *
 * Returns the dial code (e.g. '+971') if exactly one country matches,
 * or null if the dial code is shared by multiple countries (e.g. +1).
 */
function resolveInternationalDialCode(phone: string): string | null {
  const cleaned = phone.trim().replace(/[\s\-().]/g, '');
  let digitsAfterPrefix: string;
  if (cleaned.startsWith('+')) {
    digitsAfterPrefix = cleaned.slice(1).replace(/\D/g, '');
  } else if (cleaned.startsWith('00')) {
    digitsAfterPrefix = cleaned.slice(2).replace(/\D/g, '');
  } else {
    return null;
  }

  if (!digitsAfterPrefix) return null;

  // Sort dial codes by digit length descending so longer codes match first
  // (e.g. +971 before +9 before +91).
  const sorted = [...COUNTRIES].sort((a, b) =>
    dialCodeDigits(b.dialCode).length - dialCodeDigits(a.dialCode).length,
  );

  for (const country of sorted) {
    const ccDigits = dialCodeDigits(country.dialCode);
    if (!ccDigits) continue;
    if (digitsAfterPrefix.startsWith(ccDigits)) {
      // Check if this dial code is unique
      const matches = COUNTRIES.filter(c => dialCodeDigits(c.dialCode) === ccDigits);
      if (matches.length === 1) {
        return country.dialCode;
      }
      // Ambiguous dial code — do not resolve to a specific country
      return null;
    }
  }

  return null;
}

/**
 * Resolve the phone-country dial code for a phone number.
 *
 * Returns:
 *   - A dial code string (e.g. '+91', '+971') when context is available
 *   - null when no safe context exists (do not guess)
 *
 * The returned dial code is for LOCAL numbers only. If the phone is already
 * international, the dial code is not needed for normalization — but this
 * function still returns the resolved context for UI display purposes.
 */
export function resolvePhoneCountry(
  input: PhoneCountryResolutionInput,
): string | null {
  const { phone, selectedDialCode } = input;

  // 1. If the phone is already international, try to resolve its dial code.
  //    Normalization will ignore any selected/manual default for this number,
  //    but the resolved dial code is returned for UI display.
  if (isInternationalPhone(phone)) {
    const intlDialCode = resolveInternationalDialCode(phone ?? '');
    if (intlDialCode) return intlDialCode;
    // Ambiguous or unknown — fall through to user selection / manual default
    // for UI display, but normalization will still use the phone's own prefix.
  }

  // 2. Explicit user selection wins for local numbers.
  if (selectedDialCode && selectedDialCode.trim()) {
    const trimmed = selectedDialCode.trim();
    // Validate it's a known dial code
    const known = COUNTRIES.some(c => c.dialCode === trimmed);
    if (known) return trimmed;
  }

  // 3. Qualifying 10-digit Indian mobile with no international prefix and
  //    no explicit user selection → default to '+91'.
  //    This applies to BOTH manual and non-manual captures.
  //    Address is NOT consulted.
  if (isPlausiblyIndianMobile(phone)) {
    return '+91';
  }

  // 4. No safe context
  return null;
}
