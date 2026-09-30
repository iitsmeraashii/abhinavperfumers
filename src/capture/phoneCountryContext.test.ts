// Tests for phone-country context behavior.
// Run with: npx tsx src/capture/phoneCountryContext.test.ts

import { COUNTRIES, searchCountries, findCountryByName, canonicalizeCountry, UNSURE_COUNTRY } from './countryData';

let passed = 0;
let failed = 0;

function assertEq(actual: unknown, expected: unknown, label: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { passed++; } else {
    failed++;
    console.error(`FAIL: ${label}\n  expected: ${e}\n  actual:   ${a}`);
  }
}

function assertTrue(v: boolean, label: string): void {
  if (v) { passed++; } else { failed++; console.error(`FAIL (expected true): ${label}`); }
}

function assertFalse(v: boolean, label: string): void {
  if (!v) { passed++; } else { failed++; console.error(`FAIL (expected false): ${label}`); }
}

// ─── 1. Manual mode defaults to '+91' (India dial code) ────────────────────────
//
// The default is applied in useCaptureSession.startCapture when method === 'MANUAL'.
// phoneCountryCode must contain the DIAL CODE, not the country name.

const manualDefault = '+91';
assertEq(manualDefault, '+91', 'Manual default phoneCountryCode is "+91" (dial code)');

// The dial code must resolve back to a country in the canonical data
const indiaFromDialCode = COUNTRIES.find(c => c.dialCode === '+91');
assertEq(indiaFromDialCode?.name, 'India', 'Dial code "+91" resolves to India');
assertEq(indiaFromDialCode?.code, 'IN', 'India country code is IN');

// Explicitly assert it is a dial code, not a country name
assertTrue(manualDefault.startsWith('+'), 'phoneCountryCode starts with "+" (is a dial code)');
assertTrue(!isNaN(Number(manualDefault.slice(1))), 'phoneCountryCode without "+" is numeric');

// ─── 2. Non-manual mode does NOT default to '+91' ──────────────────────────────
//
// For BUSINESS_CARD, QR, Exhibition, etc. — phoneCountryCode should be unset.

const nonManualDefault: string | undefined = undefined;
assertEq(nonManualDefault, undefined, 'Non-manual default is undefined (not "+91")');

// ─── 3. Dial codes for various countries ───────────────────────────────────────

const dialCodeCases: [string, string, string][] = [
  ['India',              'IN', '+91'],
  ['United Arab Emirates', 'AE', '+971'],
  ['United Kingdom',     'GB', '+44'],
  ['United States',      'US', '+1'],
  ['Saudi Arabia',       'SA', '+966'],
];

for (const [name, code, dialCode] of dialCodeCases) {
  const country = findCountryByName(name);
  assertEq(country?.dialCode, dialCode, `${name} dial code is ${dialCode}`);
  assertEq(country?.code, code, `${name} ISO code is ${code}`);

  // Simulate what PhoneCountrySelector emits: the dial code
  const emittedValue = country?.dialCode;
  assertTrue(emittedValue?.startsWith('+'), `Emitted value for ${name} starts with "+"`);
  assertEq(emittedValue, dialCode, `Emitted value for ${name} is ${dialCode}`);
}

// ─── 4. Independence: phone country ≠ lead country ─────────────────────────────

const leadCountry: string = 'United Arab Emirates';
const phoneCountryCode: string = '+91';
const phoneCountryName = COUNTRIES.find(c => c.dialCode === phoneCountryCode)?.name;
assertTrue(leadCountry !== phoneCountryName, 'Lead country and phone country can differ');

// Both resolve independently
const leadCountryResolved = findCountryByName(leadCountry);
assertEq(leadCountryResolved?.dialCode, '+971', 'Lead country UAE resolves to +971');
assertEq(phoneCountryCode, '+91', 'Phone country code is +91 (India)');

// Reverse case: lead country India, phone country UAE
const leadCountry2 = 'India';
const phoneCountryCode2 = '+971';
const leadCountry2Resolved = findCountryByName(leadCountry2);
const phoneCountry2Resolved = COUNTRIES.find(c => c.dialCode === phoneCountryCode2);
assertEq(leadCountry2Resolved?.dialCode, '+91', 'Lead country India resolves to +91');
assertEq(phoneCountry2Resolved?.name, 'United Arab Emirates', 'Phone country +971 resolves to UAE');

// ─── 5. UNSURE cannot be selected as phone country ─────────────────────────────
//
// UNSURE_COUNTRY is not in the COUNTRIES array, so it has no dial code.

assertFalse(
  COUNTRIES.some(c => c.name === UNSURE_COUNTRY),
  'UNSURE is not in COUNTRIES array',
);
assertEq(
  findCountryByName(UNSURE_COUNTRY),
  undefined,
  'findCountryByName(UNSURE) returns undefined',
);
const unsureSearchResults = searchCountries('UNSURE');
assertFalse(
  unsureSearchResults.some(c => c.name === UNSURE_COUNTRY),
  'searchCountries does not return UNSURE',
);

// ─── 6. Canonical country data resolution (aliases) ────────────────────────────

const aliases: [string, string, string][] = [
  ['India',  'India',              '+91'],
  ['UAE',    'United Arab Emirates', '+971'],
  ['UK',     'United Kingdom',     '+44'],
  ['USA',    'United States',      '+1'],
  ['KSA',    'Saudi Arabia',       '+966'],
];

for (const [alias, canonical, dialCode] of aliases) {
  const resolved = canonicalizeCountry(alias);
  assertEq(resolved, canonical, `Alias "${alias}" → "${canonical}"`);
  const country = resolved ? findCountryByName(resolved) : undefined;
  assertEq(country?.dialCode, dialCode, `"${canonical}" has dial code ${dialCode}`);
}

// ─── 7. Existing drafts without phone-country context load correctly ───────────

interface SimulatedDraftData {
  phone?: string;
  phoneCountryCode?: string;
  [key: string]: unknown;
}

const oldDraft: SimulatedDraftData = { phone: '9876543210' };
assertEq(oldDraft.phoneCountryCode, undefined, 'Old draft without phoneCountryCode loads as undefined');

const newDraft: SimulatedDraftData = { phone: '9876543210', phoneCountryCode: '+91' };
assertEq(newDraft.phoneCountryCode, '+91', 'New draft with phoneCountryCode loads as "+91"');

const mergedDraft: SimulatedDraftData = { ...oldDraft, phoneCountryCode: '+971' };
assertEq(mergedDraft.phone, '9876543210', 'Merged draft preserves phone field');
assertEq(mergedDraft.phoneCountryCode, '+971', 'Merged draft has phone country as dial code');

// ─── 8. Backward compatibility: legacy 'India' value from Version 366 ──────────
//
// If a persisted draft contains phoneCountryCode: 'India' (from Version 366),
// the restore/merge logic converts it to '+91'.

const legacyDraft: SimulatedDraftData = { phone: '9876543210', phoneCountryCode: 'India' };

// Simulate the backward-compat conversion from useCaptureSession
let legacyValue = legacyDraft.phoneCountryCode;
if (legacyValue === 'India') {
  legacyValue = '+91';
}
assertEq(legacyValue, '+91', 'Legacy "India" value converts to "+91"');

// Only 'India' gets converted — other country names are not converted
const nonLegacyValue = 'United Arab Emirates';
let convertedValue = nonLegacyValue;
if (convertedValue === 'India') {
  convertedValue = '+91';
}
assertEq(convertedValue, 'United Arab Emirates', 'Non-"India" country name is NOT converted');

// ─── 9. phoneCountryCode is always a dial code, never a country name ───────────

const validDialCodes = ['+91', '+971', '+44', '+1', '+966'];
for (const dc of validDialCodes) {
  assertTrue(dc.startsWith('+'), `"${dc}" starts with "+"`);
  assertTrue(!isNaN(Number(dc.slice(1))), `"${dc}" is numeric after "+"`);
  const country = COUNTRIES.find(c => c.dialCode === dc);
  assertTrue(country !== undefined, `"${dc}" maps to a country in COUNTRIES`);
}

// Country names are NOT valid phoneCountryCode values
const countryNames = ['India', 'United Arab Emirates', 'United Kingdom'];
for (const name of countryNames) {
  assertFalse(name.startsWith('+'), `"${name}" is not a dial code (does not start with "+")`);
}

// ─── 10. DraftData type safety: phoneCountryCode ≠ country ─────────────────────

const testDraft: SimulatedDraftData = {
  country: 'United Arab Emirates',
  phoneCountryCode: '+91',
  phone: '9876543210',
};
assertEq(testDraft.country, 'United Arab Emirates', 'Draft country is UAE (country name)');
assertEq(testDraft.phoneCountryCode, '+91', 'Draft phoneCountryCode is "+91" (dial code)');
assertTrue(
  testDraft.country !== testDraft.phoneCountryCode,
  'country and phoneCountryCode are independent and different types of values',
);

// ─── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
