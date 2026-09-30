// WhatsApp phone resolution — shared utility.
//
// Converts a raw phone string into the canonical digits-only international
// form that WhatsApp/Meta expects (E.164 minus the leading `+`), using the
// shared normalizePhone + resolvePhoneCountry pipeline.
//
// This replaces the old hardcoded `91` + 10-digit logic.
//
// Rules (via the shared resolver):
//   1. International prefix (`+` / `00`) → normalized as-is
//   2. Explicit user-selected dial code → prepended
//   3. Qualifying 10-digit Indian mobile (6/7/8/9) → +91
//   4. Unresolved → null (WhatsApp cannot use the number)

import { normalizePhone } from './normalizePhone';
import { resolvePhoneCountry, type PhoneCountryResolutionInput } from './phoneCountryResolver';

export interface WhatsAppPhoneOptions {
  /** Explicitly user-selected dial code, if any. */
  selectedDialCode?: string | null;
  /** Whether the capture started as manual (kept for API compat, not used for resolution). */
  isManualCapture?: boolean;
  /** Address — not used for phone-country resolution. */
  address?: string | null;
}

/**
 * Resolve a raw phone into the canonical WhatsApp format.
 *
 * Returns the digits-only international string (e.g. `919876543210`,
 * `971501234567`) or `null` if the phone cannot be resolved.
 */
export function resolveWhatsAppPhone(
  rawPhone: string | null | undefined,
  options?: WhatsAppPhoneOptions,
): string | null {
  if (!rawPhone || !rawPhone.trim()) return null;

  const resolverInput: PhoneCountryResolutionInput = {
    phone: rawPhone,
    selectedDialCode: options?.selectedDialCode ?? null,
    isManualCapture: options?.isManualCapture ?? false,
    address: options?.address ?? null,
  };

  const dialCode = resolvePhoneCountry(resolverInput);
  const result = normalizePhone(rawPhone, { dialCode: dialCode ?? undefined });
  return result.ok ? result.value : null;
}
