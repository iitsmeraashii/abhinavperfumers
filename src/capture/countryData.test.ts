// Tests for country derivation and resolution.
// Run with: npx tsx src/capture/countryData.test.ts

import { deriveCountry } from './deriveCountry';
import { resolveLeadCountry } from './resolveLeadCountry';
import { canonicalizeCountry, searchCountries, UNSURE_COUNTRY, findCountryByName, COUNTRIES } from './countryData';

let passed = 0;
let failed = 0;

function assertEq(actual: unknown, expected: unknown, label: string): void {
  const actualStr   = JSON.stringify(actual);
  const expectedStr = JSON.stringify(expected);
  if (actualStr === expectedStr) {
    passed++;
  } else {
    failed++;
    console.error(`FAIL: ${label}`);
    console.error(`  expected: ${expectedStr}`);
    console.error(`  actual:   ${actualStr}`);
  }
}

// ─── Address-based country derivation ─────────────────────────────────────────

// Strong signals
assertEq(deriveCountry('India'), 'India', 'Single country name');
assertEq(deriveCountry('India, New Delhi'), 'India', 'Country + city');
assertEq(deriveCountry('Mumbai, India'), 'India', 'City + country');
assertEq(deriveCountry('Dubai, UAE'), 'United Arab Emirates', 'City + alias');
assertEq(deriveCountry('Dubai, United Arab Emirates'), 'United Arab Emirates', 'City + full name');
assertEq(deriveCountry('Riyadh, Saudi Arabia'), 'Saudi Arabia', 'Riyadh + Saudi Arabia');
assertEq(deriveCountry('Singapore'), 'Singapore', 'Singapore alone');
assertEq(deriveCountry('London, United Kingdom'), 'United Kingdom', 'London + UK full');
assertEq(deriveCountry('London, UK'), 'United Kingdom', 'London + UK alias');
assertEq(deriveCountry('Abu Dhabi, UAE'), 'United Arab Emirates', 'Abu Dhabi + UAE');
assertEq(deriveCountry('Doha, Qatar'), 'Qatar', 'Doha + Qatar');
assertEq(deriveCountry('Kuwait City, Kuwait'), 'Kuwait', 'Kuwait City + Kuwait');
assertEq(deriveCountry('Muscat, Oman'), 'Oman', 'Muscat + Oman');
assertEq(deriveCountry('Manama, Bahrain'), 'Bahrain', 'Manama + Bahrain');
assertEq(deriveCountry('New York, USA'), 'United States', 'New York + USA alias');
assertEq(deriveCountry('New York, United States'), 'United States', 'New York + full name');

// Case insensitivity
assertEq(deriveCountry('india'), 'India', 'Lowercase india');
assertEq(deriveCountry('INDIA'), 'India', 'Uppercase INDIA');
assertEq(deriveCountry('mumbai, india'), 'India', 'Lowercase mumbai, india');
assertEq(deriveCountry('UAE'), 'United Arab Emirates', 'Uppercase UAE');

// Aliases
assertEq(deriveCountry('KSA'), 'Saudi Arabia', 'KSA alias');
assertEq(deriveCountry('ksa'), 'Saudi Arabia', 'lowercase ksa alias');
assertEq(deriveCountry('America'), 'United States', 'America alias');
assertEq(deriveCountry('Holland'), 'Netherlands', 'Holland alias');
assertEq(deriveCountry('Czechia'), 'Czech Republic', 'Czechia alias');
assertEq(deriveCountry('Britain'), 'United Kingdom', 'Britain alias');

// Unknown / insufficient evidence
assertEq(deriveCountry('Sector 51, Gurugram'), UNSURE_COUNTRY, 'Gurugram only — no country');
assertEq(deriveCountry('123 Main Street'), UNSURE_COUNTRY, 'Generic address');
assertEq(deriveCountry('Business Park, Downtown'), UNSURE_COUNTRY, 'Business park');
assertEq(deriveCountry(''), UNSURE_COUNTRY, 'Empty string');
assertEq(deriveCountry(null), UNSURE_COUNTRY, 'null');
assertEq(deriveCountry(undefined), UNSURE_COUNTRY, 'undefined');
assertEq(deriveCountry('   '), UNSURE_COUNTRY, 'Whitespace only');

// Word-boundary safety — must not match substrings
assertEq(deriveCountry('Indianapolis, IN'), UNSURE_COUNTRY, 'Indianapolis must not match India');
assertEq(deriveCountry('Indiana, US'), 'United States', 'Indiana + US — should match US, not India');

// ─── Phone isolation ──────────────────────────────────────────────────────────

// Country derivation operates on address only — phone data is not accepted.
// Even if a phone with +971 is in the draft, deriveCountry only sees the address.
assertEq(deriveCountry('Mumbai, India'), 'India', 'Phone isolation: address has India');
assertEq(deriveCountry('Sector 51, Gurugram'), UNSURE_COUNTRY, 'Phone isolation: Gurugram with no country signal');

// ─── Country resolution precedence ────────────────────────────────────────────

// Manual selection wins over address
assertEq(
  resolveLeadCountry({ selectedCountry: 'India', address: 'Dubai, UAE' }),
  'India',
  'Precedence: manual India over address UAE',
);
assertEq(
  resolveLeadCountry({ selectedCountry: 'United Arab Emirates', address: 'Mumbai, India' }),
  'United Arab Emirates',
  'Precedence: manual UAE over address India',
);

// No manual selection → address derivation
assertEq(
  resolveLeadCountry({ selectedCountry: null, address: 'Mumbai, India' }),
  'India',
  'No manual + address India',
);
assertEq(
  resolveLeadCountry({ selectedCountry: undefined, address: 'Dubai, UAE' }),
  'United Arab Emirates',
  'No manual + address UAE',
);

// No manual + no address country → UNSURE
assertEq(
  resolveLeadCountry({ selectedCountry: null, address: 'Sector 51, Gurugram' }),
  UNSURE_COUNTRY,
  'No manual + Gurugram → UNSURE',
);
assertEq(
  resolveLeadCountry({ selectedCountry: null, address: '' }),
  UNSURE_COUNTRY,
  'No manual + empty address → UNSURE',
);
assertEq(
  resolveLeadCountry({ selectedCountry: null, address: null }),
  UNSURE_COUNTRY,
  'No manual + null address → UNSURE',
);
assertEq(
  resolveLeadCountry({}),
  UNSURE_COUNTRY,
  'No inputs at all → UNSURE',
);

// Manual selection canonicalization
assertEq(
  resolveLeadCountry({ selectedCountry: 'uae', address: null }),
  'United Arab Emirates',
  'Manual alias uae canonicalized',
);
assertEq(
  resolveLeadCountry({ selectedCountry: 'UAE', address: null }),
  'United Arab Emirates',
  'Manual alias UAE canonicalized',
);
assertEq(
  resolveLeadCountry({ selectedCountry: 'INDIA', address: null }),
  'India',
  'Manual INDIA canonicalized',
);

// Stale/invalid manual selection falls through to address
assertEq(
  resolveLeadCountry({ selectedCountry: 'Atlantis', address: 'Mumbai, India' }),
  'India',
  'Invalid manual selection falls through to address',
);

// ─── Canonicalization ─────────────────────────────────────────────────────────

assertEq(canonicalizeCountry('India'), 'India', 'Canonicalize India');
assertEq(canonicalizeCountry('INDIA'), 'India', 'Canonicalize INDIA');
assertEq(canonicalizeCountry('uae'), 'United Arab Emirates', 'Canonicalize uae');
assertEq(canonicalizeCountry('UAE'), 'United Arab Emirates', 'Canonicalize UAE');
assertEq(canonicalizeCountry('United Arab Emirates'), 'United Arab Emirates', 'Canonicalize full name');
assertEq(canonicalizeCountry('USA'), 'United States', 'Canonicalize USA');
assertEq(canonicalizeCountry('us'), 'United States', 'Canonicalize us');
assertEq(canonicalizeCountry('UK'), 'United Kingdom', 'Canonicalize UK');
assertEq(canonicalizeCountry('Holland'), 'Netherlands', 'Canonicalize Holland');
assertEq(canonicalizeCountry('Atlantis'), null, 'Canonicalize unknown → null');
assertEq(canonicalizeCountry(''), null, 'Canonicalize empty → null');
assertEq(canonicalizeCountry('Ind'), null, 'Canonicalize Ind → null (not an alias)');
assertEq(canonicalizeCountry('Dubai country'), null, 'Canonicalize Dubai country → null');

// ─── Search ───────────────────────────────────────────────────────────────────

assertEq(searchCountries('').length > 50, true, 'Empty search returns all countries');
assertEq(searchCountries('India').length >= 1, true, 'Search India finds results');
assertEq(searchCountries('India').some(c => c.name === 'India'), true, 'Search India includes India');
assertEq(searchCountries('united').length >= 3, true, 'Search united finds multiple');
assertEq(searchCountries('zzzzz').length, 0, 'Nonsense search returns empty');

// ─── Turkey ───────────────────────────────────────────────────────────────────

assertEq(canonicalizeCountry('Turkey'), 'Turkey', 'Canonicalize Turkey');
assertEq(canonicalizeCountry('Türkiye'), 'Turkey', 'Canonicalize Türkiye');
assertEq(canonicalizeCountry('turkey'), 'Turkey', 'Canonicalize lowercase turkey');
assertEq(findCountryByName('Turkey')?.code, 'TR', 'findCountryByName Turkey — code TR');
assertEq(findCountryByName('Turkey')?.dialCode, '+90', 'findCountryByName Turkey — dialCode +90');
assertEq(searchCountries('Turkey').some(c => c.name === 'Turkey'), true, 'Search Turkey finds Turkey');
assertEq(searchCountries('Turkey').length, 1, 'Search Turkey returns exactly one');
assertEq(deriveCountry('Istanbul, Turkey'), 'Turkey', 'Derive Istanbul, Turkey');

// ─── Alias search ─────────────────────────────────────────────────────────────

assertEq(searchCountries('UAE').some(c => c.name === 'United Arab Emirates'), true, 'Search UAE → United Arab Emirates');
assertEq(searchCountries('UAE').filter(c => c.name === 'United Arab Emirates').length, 1, 'Search UAE → exactly one United Arab Emirates');
assertEq(searchCountries('UK').some(c => c.name === 'United Kingdom'), true, 'Search UK → United Kingdom found');
assertEq(searchCountries('UK').filter(c => c.name === 'United Kingdom').length, 1, 'Search UK → exactly one United Kingdom');
assertEq(searchCountries('USA').some(c => c.name === 'United States'), true, 'Search USA → United States found');
assertEq(searchCountries('USA').filter(c => c.name === 'United States').length, 1, 'Search USA → exactly one United States');
assertEq(searchCountries('KSA').some(c => c.name === 'Saudi Arabia'), true, 'Search KSA → Saudi Arabia found');
assertEq(searchCountries('KSA').filter(c => c.name === 'Saudi Arabia').length, 1, 'Search KSA → exactly one Saudi Arabia');
assertEq(searchCountries('Türkiye').some(c => c.name === 'Turkey'), true, 'Search Türkiye → Turkey found');
assertEq(searchCountries('Türkiye').filter(c => c.name === 'Turkey').length, 1, 'Search Türkiye → exactly one Turkey');
assertEq(searchCountries('Holland').some(c => c.name === 'Netherlands'), true, 'Search Holland → Netherlands found');
assertEq(searchCountries('Holland').filter(c => c.name === 'Netherlands').length, 1, 'Search Holland → exactly one Netherlands');

// ─── Country list invariants ──────────────────────────────────────────────────

const names = COUNTRIES.map(c => c.name);
const codes = COUNTRIES.map(c => c.code);
const duplicateNames = names.filter((n, i) => names.indexOf(n) !== i);
const duplicateCodes = codes.filter((c, i) => codes.indexOf(c) !== i);
assertEq(duplicateNames.length, 0, 'No duplicate country names');
assertEq(duplicateCodes.length, 0, 'No duplicate ISO codes');
assertEq(COUNTRIES.some(c => c.name === UNSURE_COUNTRY), false, 'UNSURE is not in COUNTRIES');
assertEq(COUNTRIES.every(c => c.code.length === 2), true, 'Every country has a 2-letter ISO code');
assertEq(COUNTRIES.every(c => c.dialCode.startsWith('+')), true, 'Every country has a dial code starting with +');
assertEq(searchCountries('UNSURE').length, 0, 'Search UNSURE returns no results');

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
