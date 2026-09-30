// Lead country resolution — applies the agreed precedence:
//
//   1. Manual country selection (by the sales rep)
//   2. Country derived from the address
//   3. "UNSURE" sentinel
//
// Manual selection always wins. If no manual selection is present, the
// address is consulted. If neither source can establish a country, the
// result is "UNSURE".
//
// Phone numbers are NEVER used for lead-country resolution.

import { canonicalizeCountry, UNSURE_COUNTRY } from './countryData';
import { deriveCountry } from './deriveCountry';

export interface CountryResolutionInput {
  /** Country explicitly selected by the sales rep, if any. */
  selectedCountry?: string | null;
  /** Address string to derive country from, if no manual selection. */
  address?: string | null;
}

/**
 * Resolve the lead's country using the agreed precedence.
 *
 * Returns a canonical country name or "UNSURE".
 */
export function resolveLeadCountry(input: CountryResolutionInput): string {
  // 1. Manual selection — canonicalize and use directly
  if (input.selectedCountry && input.selectedCountry.trim()) {
    const canonical = canonicalizeCountry(input.selectedCountry.trim());
    if (canonical) return canonical;
    // If the manual selection doesn't canonicalize (e.g. stale value),
    // fall through to address derivation rather than dropping it silently.
  }

  // 2. Address derivation
  const derived = deriveCountry(input.address);
  if (derived !== UNSURE_COUNTRY) return derived;

  // 3. No country could be established
  return UNSURE_COUNTRY;
}
