// Split an international phone number into country dial code + local number
// for UI display. Uses the existing resolvePhoneCountry + normalizePhone —
// no new normalization logic.
//
// Examples:
//   '+918796314123'   → { dialCode: '+91',  localNumber: '8796314123' }
//   '+971501234567'   → { dialCode: '+971', localNumber: '501234567'  }
//   '9876543210'      → { dialCode: '+91',  localNumber: '9876543210' }  (Indian mobile default)
//   '501234567'       → { dialCode: null,   localNumber: '501234567'  }  (unresolved)
//   '+14155552671'    → { dialCode: null,   localNumber: '+14155552671' } (ambiguous +1)

import { resolvePhoneCountry } from './phoneCountryResolver';
import { normalizePhone } from './normalizePhone';
import { COUNTRIES } from './countryData';

export interface SplitPhoneResult {
  /** Resolved dial code (e.g. '+91', '+971'), or null if unresolved. */
  dialCode: string | null;
  /** The local/national portion of the number, or the original if unresolved. */
  localNumber: string;
}

/**
 * Split a phone number into its dial-code and local-number components
 * for UI display. The dial code is determined by the existing resolver
 * hierarchy (international prefix → user selection → Indian mobile default).
 *
 * For international numbers with an unambiguous dial code, the prefix is
 * stripped from the local number. For ambiguous dial codes (e.g. +1),
 * the full international number is returned as the local number.
 *
 * This does NOT normalize or canonicalize — it only splits for display.
 */
export function splitInternationalPhone(
  phone: string | null | undefined,
  selectedDialCode?: string | null,
): SplitPhoneResult {
  if (!phone || !phone.trim()) {
    return { dialCode: null, localNumber: '' };
  }

  const dialCode = resolvePhoneCountry({
    phone,
    selectedDialCode,
    isManualCapture: false,
    address: null,
  });

  if (!dialCode) {
    return { dialCode: null, localNumber: phone };
  }

  // For international phones (+ or 00), strip the prefix to get the local number.
  // For user-selected or Indian-default dial codes applied to local numbers,
  // the phone is already local — return as-is.
  const trimmed = phone.trim();

  // Check if the phone starts with an international prefix
  if (trimmed.startsWith('+') || trimmed.startsWith('00')) {
    // Normalize to get the canonical digits, then strip the dial code digits
    const result = normalizePhone(trimmed, { dialCode });
    if (result.ok) {
      const digits = result.value;
      const dialDigits = dialCode.replace(/\D/g, '');
      if (digits.startsWith(dialDigits)) {
        const local = digits.slice(dialDigits.length);
        if (local.length >= 4) {
          return { dialCode, localNumber: local };
        }
      }
      // Dial code didn't match or local portion too short —
      // try to strip the raw prefix manually
      const country = COUNTRIES.find(c => c.dialCode === dialCode);
      if (country) {
        const dialDigitsFromCode = dialCode.replace(/\D/g, '');
        // Strip + and leading zeros from the phone, then remove dial digits
        let phoneDigits = trimmed.replace(/^[+0]+/, '');
        if (phoneDigits.startsWith(dialDigitsFromCode)) {
          const local = phoneDigits.slice(dialDigitsFromCode.length);
          if (local.length >= 4) {
            return { dialCode, localNumber: local };
          }
        }
      }
      // Couldn't split — return the original phone as the local number
      return { dialCode, localNumber: trimmed };
    }
    // Normalization failed — return original
    return { dialCode, localNumber: trimmed };
  }

  // Phone is already local (no international prefix)
  // If the phone starts with the dial code digits (e.g. '91' prefix), strip them
  const dialDigits = dialCode.replace(/\D/g, '');
  const phoneDigits = trimmed.replace(/\D/g, '');
  if (phoneDigits.startsWith(dialDigits) && phoneDigits.length > dialDigits.length + 3) {
    // Check if this is a bare number that happens to start with the dial code digits
    // e.g. '919876543210' with dialCode '+91' → local '9876543210'
    // But only if the remaining digits look like a valid local number
    const local = phoneDigits.slice(dialDigits.length);
    if (local.length >= 7 && local.length <= 12) {
      return { dialCode, localNumber: local };
    }
  }

  // Phone is local, return as-is
  return { dialCode, localNumber: trimmed };
}
