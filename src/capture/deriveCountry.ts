// Address-based country derivation — operates exclusively on the address string.
//
// CRITICAL: This function must NEVER inspect phone numbers, phone country codes,
// or any non-address data. Country derivation from phone numbers is explicitly
// excluded by the architecture.
//
// Matching strategy:
//   1. Tokenize the address by commas and whitespace.
//   2. For each token/phrase, check if it matches a canonical country name or
//      a known alias using word-boundary-aware matching.
//   3. Return the first canonical country name found.
//   4. If no country evidence is found, return "UNSURE".
//
// The function is conservative: if no clear country signal is present in the
// address, it returns "UNSURE" rather than guessing.

import {
  COUNTRIES,
  COUNTRY_ALIASES,
  UNSURE_COUNTRY,
} from './countryData';

// Build a set of all country names (lowercase) for fast lookup.
const COUNTRY_NAMES_LOWER = new Set(
  COUNTRIES.map(c => c.name.toLowerCase()),
);

// Build sorted alias keys for multi-word alias matching.
// Longer aliases first so "united arab emirates" matches before "uae".
const SORTED_ALIASES: Array<{ alias: string; canonical: string }> = Array.from(
  COUNTRY_ALIASES.entries(),
)
  .map(([alias, canonical]) => ({ alias, canonical }))
  .sort((a, b) => b.alias.length - a.alias.length);

// Build sorted country names for multi-word matching.
// Longer names first so "united arab emirates" matches before "emirates".
const SORTED_COUNTRY_NAMES: Array<{ lower: string; canonical: string }> = COUNTRIES
  .map(c => ({ lower: c.name.toLowerCase(), canonical: c.name }))
  .sort((a, b) => b.lower.length - a.lower.length);

// Ambiguous tokens that should NOT be treated as country evidence on their own.
// These are common words or place names that coincidentally match country names
// or aliases but are not reliable country indicators.
const AMBIGUOUS_TOKENS: Set<string> = new Set([
  // "america" could refer to the Americas (continents) rather than the country
  // but in a trade-event context it's almost always the country. Keep it.
  // Add truly ambiguous tokens here if needed in the future.
]);

/**
 * Derive a country from an address string.
 *
 * Returns the canonical country name when the address provides sufficient
 * evidence, or "UNSURE" when it does not.
 *
 * This function operates exclusively on the address. It does NOT inspect
 * phone numbers, phone country codes, or any other data.
 */
export function deriveCountry(address: string | null | undefined): string {
  if (!address || !address.trim()) return UNSURE_COUNTRY;

  const normalized = address.trim();

  // ── Multi-word country name matching ────────────────────────────────────
  // Check full country names first (e.g. "United Arab Emirates", "Saudi Arabia").
  // Use word-boundary-aware matching to avoid false positives.
  for (const { lower, canonical } of SORTED_COUNTRY_NAMES) {
    if (matchWordBoundary(normalized, lower)) {
      return canonical;
    }
  }

  // ── Multi-word alias matching ───────────────────────────────────────────
  // Check aliases that are multi-word (e.g. "united states", "saudi arabia").
  for (const { alias, canonical } of SORTED_ALIASES) {
    if (alias.includes(' ') && matchWordBoundary(normalized, alias)) {
      if (AMBIGUOUS_TOKENS.has(alias)) continue;
      return canonical;
    }
  }

  // ── Single-token alias matching ─────────────────────────────────────────
  // Check single-word aliases (e.g. "uae", "uk", "ksa", "dubai").
  // Tokenize by non-alphanumeric characters and check each token.
  const tokens = normalized.toLowerCase().split(/[^a-z0-9.]+/).filter(Boolean);
  for (const token of tokens) {
    if (AMBIGUOUS_TOKENS.has(token)) continue;
    const aliasResult = COUNTRY_ALIASES.get(token);
    if (aliasResult) return aliasResult;
  }

  // ── Single-token country name matching ──────────────────────────────────
  // Check single-word country names (e.g. "India", "Singapore", "China").
  for (const token of tokens) {
    if (AMBIGUOUS_TOKENS.has(token)) continue;
    if (COUNTRY_NAMES_LOWER.has(token)) {
      const country = COUNTRIES.find(c => c.name.toLowerCase() === token);
      if (country) return country.name;
    }
  }

  return UNSURE_COUNTRY;
}

/**
 * Word-boundary-aware match for a phrase within the address.
 * Uses a regex with word boundaries to avoid substring false positives
 * (e.g. "India" matching inside "Indianapolis").
 */
function matchWordBoundary(haystack: string, needle: string): boolean {
  // Escape regex special characters in the needle
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // \b doesn't work well with non-ASCII; use a broader boundary that
  // also matches start/end of string and non-alphanumeric characters.
  const regex = new RegExp(`(?:^|[^a-zA-Z])${escaped}(?:[^a-zA-Z]|$)`, 'i');
  return regex.test(haystack);
}

// Re-export the sentinel for convenience
export { UNSURE_COUNTRY } from './countryData';
