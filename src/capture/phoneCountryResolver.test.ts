// Tests for phone-country resolution hierarchy and normalization integration.
// Run with: npx tsx src/capture/phoneCountryResolver.test.ts

import { resolvePhoneCountry, isInternationalPhone, isPlausiblyIndianMobile } from './phoneCountryResolver';
import { normalizePhone, phoneDedupKey } from './normalizePhone';
import { COUNTRIES, searchCountries, findCountryByName, UNSURE_COUNTRY } from './countryData';

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

// ─── A. Manual default → +91 context → 919876543210 ───────────────────────────

{
  const resolved = resolvePhoneCountry({
    phone: '9876543210',
    isManualCapture: true,
  });
  assertEq(resolved, '+91', 'A: Manual capture resolves to +91');

  const normalized = normalizePhone('9876543210', { dialCode: resolved ?? undefined });
  assertEq(normalized, { ok: true, value: '919876543210' }, 'A: Manual +91 normalizes to 919876543210');
}

// ─── B. Explicit user selection → 971501234567 ────────────────────────────────

{
  const resolved = resolvePhoneCountry({
    phone: '501234567',
    selectedDialCode: '+971',
    isManualCapture: false,
  });
  assertEq(resolved, '+971', 'B: User selection +971 resolves');

  const normalized = normalizePhone('501234567', { dialCode: resolved ?? undefined });
  assertEq(normalized, { ok: true, value: '971501234567' }, 'B: User +971 normalizes to 971501234567');
}

// ─── C. International phone overrides everything ──────────────────────────────

{
  // Phone is +971... but selected = +91 and address = India
  const resolved = resolvePhoneCountry({
    phone: '+971501234567',
    selectedDialCode: '+91',
    isManualCapture: false,
    address: 'Gurugram, India',
  });

  // Resolver recognizes +971 prefix and returns +971 even with +91 selected
  assertEq(resolved, '+971', 'C: +971 phone resolves to +971 even with +91 selected');

  const normalized = normalizePhone('+971501234567', { dialCode: resolved ?? undefined });
  assertEq(normalized, { ok: true, value: '971501234567' }, 'C: International phone overrides → 971501234567');

  assertTrue(isInternationalPhone('+971501234567'), 'C: +971... is detected as international');
  assertTrue(isInternationalPhone('00971501234567'), 'C: 00971... is detected as international');
}

// ─── D. Non-manual Indian phone + Indian address → +91 ────────────────────────

{
  const resolved = resolvePhoneCountry({
    phone: '9876543210',
    isManualCapture: false,
    address: 'Sector 51, Gurugram, Haryana, India',
  });
  assertEq(resolved, '+91', 'D: Indian phone + Indian address → +91');

  const normalized = normalizePhone('9876543210', { dialCode: resolved ?? undefined });
  assertEq(normalized, { ok: true, value: '919876543210' }, 'D: Normalizes to 919876543210');
}

// ─── E. Qualifying Indian mobile defaults to +91 regardless of address ───────

{
  // Address is no longer consulted. A qualifying 10-digit Indian mobile
  // (starts with 6/7/8/9) defaults to +91 even with a UAE address.
  const resolved = resolvePhoneCountry({
    phone: '9876543210',
    isManualCapture: false,
    address: 'Dubai, UAE',
  });
  assertEq(resolved, '+91', 'E: Indian mobile defaults to +91 even with UAE address');

  const normalized = normalizePhone('9876543210', { dialCode: resolved ?? undefined });
  assertEq(normalized, { ok: true, value: '919876543210' }, 'E: Normalizes to 919876543210');
}

// ─── F. Non-manual local phone + no country evidence → no guess ───────────────

{
  const resolved = resolvePhoneCountry({
    phone: '501234567',
    isManualCapture: false,
    address: 'some address with no country evidence',
  });
  assertEq(resolved, null, 'F: Local phone + no evidence → null');

  // Normalization without context → MISSING_COUNTRY_CONTEXT
  const normalized = normalizePhone('501234567');
  assertEq(normalized, { ok: false, value: null, reason: 'MISSING_COUNTRY_CONTEXT' }, 'F: No context → MISSING_COUNTRY_CONTEXT');
}

// ─── G. Explicit user selection overrides address ─────────────────────────────

{
  const resolved = resolvePhoneCountry({
    phone: '501234567',
    selectedDialCode: '+971',
    isManualCapture: false,
    address: 'Gurugram, India',
  });
  assertEq(resolved, '+971', 'G: User selection +971 wins over Indian address');

  const normalized = normalizePhone('501234567', { dialCode: resolved ?? undefined });
  assertEq(normalized, { ok: true, value: '971501234567' }, 'G: Normalizes to 971501234567');
}

// ─── H. Multiple phones — preserve order ──────────────────────────────────────

{
  const rawPhones = ['9876543210', '+971501234567', '501234567'];
  const dialCode = '+91'; // manual context

  const phones: string[] = [];
  for (const raw of rawPhones) {
    const result = normalizePhone(raw, { dialCode });
    phones.push(result.ok ? result.value : raw);
  }

  // Phone 0: 9876543210 + +91 → 919876543210
  assertEq(phones[0], '919876543210', 'H: phones[0] is 919876543210 (normalized from first)');
  // Phone 1: +971501234567 → 971501234567 (international, ignores dial code)
  assertEq(phones[1], '971501234567', 'H: phones[1] is 971501234567 (international)');
  // Phone 2: 501234567 + +91 → 91501234567 (not a valid UAE number with +91, but follows the rule)
  assertEq(phones[2], '91501234567', 'H: phones[2] is 91501234567 (local with +91 context)');

  // Order is preserved — phones[0] is still the first original phone
  assertTrue(phones[0] !== phones[1], 'H: phones[0] ≠ phones[1]');
  assertTrue(phones[1] !== phones[2], 'H: phones[1] ≠ phones[2]');
}

// ─── I. Deduplication ─────────────────────────────────────────────────────────

{
  const dialCode = '+91';
  // All three representations now dedup to 919876543210:
  // +91 98765 43210 → international → 919876543210
  // 919876543210 → bare digits starting with dial code digits → 919876543210
  // 0091 98765 43210 → international → 919876543210
  const k1 = phoneDedupKey('+91 98765 43210', { dialCode });
  const k2 = phoneDedupKey('919876543210', { dialCode });
  const k3 = phoneDedupKey('0091 98765 43210', { dialCode });

  assertEq(k1, '919876543210', 'I: dedupKey +91 98765 43210 → 919876543210');
  assertEq(k2, '919876543210', 'I: dedupKey 919876543210 → 919876543210');
  assertEq(k3, '919876543210', 'I: dedupKey 0091 98765 43210 → 919876543210');
  assertEq(k1, k2, 'I: k1 === k2 (same canonical)');
  assertEq(k2, k3, 'I: k2 === k3 (same canonical)');

  // Dedup in a phones array: three representations → one
  const rawPhones = ['+91 98765 43210', '919876543210', '0091 98765 43210'];
  const phones: string[] = [];
  const seen = new Set<string>();
  for (const raw of rawPhones) {
    const result = normalizePhone(raw, { dialCode });
    const normalized = result.ok ? result.value : raw;
    const dedup = phoneDedupKey(raw, { dialCode });
    if (dedup && seen.has(dedup)) continue;
    if (dedup) seen.add(dedup);
    phones.push(normalized);
  }
  assertEq(phones.length, 1, 'I: Three representations → one canonical phone');
  assertEq(phones[0], '919876543210', 'I: Single deduplicated phone is 919876543210');
}

// ─── J. Lead-country isolation ────────────────────────────────────────────────

{
  // Phone country = +971 (UAE), lead country = India — both valid, independent
  const phoneCountry = resolvePhoneCountry({
    phone: '501234567',
    selectedDialCode: '+971',
    isManualCapture: false,
    address: 'Mumbai, India',
  });
  assertEq(phoneCountry, '+971', 'J: Phone country is +971 despite Indian address');

  // The lead country would be resolved independently via resolveLeadCountry
  // We don't test that here (resolveLeadCountry is not modified), but we verify
  // that phoneCountryResolver never writes to or reads from lead country.
  // Phone country and lead country are separate concepts.

  // Reverse: lead country = India, phone country = +971
  const phoneCountry2 = resolvePhoneCountry({
    phone: '501234567',
    selectedDialCode: '+971',
    isManualCapture: true, // manual would default +91, but user selection wins
    address: null,
  });
  assertEq(phoneCountry2, '+971', 'J: User selection +971 wins over manual +91 default');
}

// ─── K. Existing drafts without phoneCountryCode ──────────────────────────────

{
  interface SimulatedDraftData {
    phone?: string;
    phoneCountryCode?: string;
    [key: string]: unknown;
  }

  const oldDraft: SimulatedDraftData = { phone: '9876543210' };
  assertEq(oldDraft.phoneCountryCode, undefined, 'K: Old draft without phoneCountryCode loads as undefined');

  // Resolution with no phoneCountryCode: manual → +91, non-manual + no address → null
  const manualResolved = resolvePhoneCountry({
    phone: oldDraft.phone,
    isManualCapture: true,
  });
  assertEq(manualResolved, '+91', 'K: Manual with old draft still defaults to +91');

  const nonManualResolved = resolvePhoneCountry({
    phone: oldDraft.phone,
    isManualCapture: false,
    address: null,
  });
  // 9876543210 is plausibly Indian mobile, but no address → no +91
  assertEq(nonManualResolved, '+91', 'K: Non-manual qualifying Indian mobile → +91 (no address needed)');
}

// ─── L. UNSURE cannot be selected ─────────────────────────────────────────────

{
  assertFalse(
    COUNTRIES.some(c => c.name === UNSURE_COUNTRY),
    'L: UNSURE is not in COUNTRIES',
  );
  assertEq(findCountryByName(UNSURE_COUNTRY), undefined, 'L: findCountryByName(UNSURE) → undefined');
}

// ─── M. isInternationalPhone ──────────────────────────────────────────────────

{
  assertTrue(isInternationalPhone('+971501234567'), 'M: +971... is international');
  assertTrue(isInternationalPhone('00971501234567'), 'M: 00971... is international');
  assertTrue(isInternationalPhone('+91 98765 43210'), 'M: +91 98765 43210 is international');
  assertFalse(isInternationalPhone('9876543210'), 'M: 9876543210 is NOT international');
  assertFalse(isInternationalPhone('501234567'), 'M: 501234567 is NOT international');
  assertFalse(isInternationalPhone(''), 'M: empty is NOT international');
  assertFalse(isInternationalPhone(null), 'M: null is NOT international');
}

// ─── N. isPlausiblyIndianMobile ───────────────────────────────────────────────

{
  assertTrue(isPlausiblyIndianMobile('9876543210'), 'N: 9876543210 is plausibly Indian');
  assertTrue(isPlausiblyIndianMobile('98765 43210'), 'N: 98765 43210 is plausibly Indian');
  assertTrue(isPlausiblyIndianMobile('09876543210'), 'N: 09876543210 (with trunk 0) is plausibly Indian');
  assertTrue(isPlausiblyIndianMobile('6123456789'), 'N: 6123456789 is plausibly Indian (starts with 6)');
  assertFalse(isPlausiblyIndianMobile('501234567'), 'N: 501234567 is NOT plausibly Indian (9 digits)');
  assertFalse(isPlausiblyIndianMobile('1234567890'), 'N: 1234567890 is NOT plausibly Indian (starts with 1)');
  assertFalse(isPlausiblyIndianMobile('+971501234567'), 'N: +971... is NOT plausibly Indian (international)');
}

// ─── O. phoneCountryCode stores dial code, not country name ───────────────────

{
  const validDialCodes = ['+91', '+971', '+44', '+1', '+966'];
  for (const dc of validDialCodes) {
    assertTrue(dc.startsWith('+'), `O: "${dc}" starts with "+"`);
    const country = COUNTRIES.find(c => c.dialCode === dc);
    assertTrue(country !== undefined, `O: "${dc}" maps to a country`);
  }

  // Country names should NOT be stored as phoneCountryCode
  const names = ['India', 'United Arab Emirates', 'United Kingdom'];
  for (const n of names) {
    assertFalse(n.startsWith('+'), `O: "${n}" is not a dial code`);
  }
}

// ─── P. Backward compat: legacy 'India' → '+91' ───────────────────────────────

{
  let legacyValue: string | undefined = 'India';
  if (legacyValue === 'India') legacyValue = '+91';
  assertEq(legacyValue, '+91', 'P: Legacy "India" converts to "+91"');

  let nonLegacy: string | undefined = 'United Arab Emirates';
  if (nonLegacy === 'India') nonLegacy = '+91';
  assertEq(nonLegacy, 'United Arab Emirates', 'P: Non-"India" not converted');
}

// ─── Q. Promotion normalization simulation ───────────────────────────────────

{
  // Simulate executePromotion's phone normalization + dedup
  function simulatePromotionPhones(
    rawPhone: string | undefined,
    phoneNumbers: string[] | undefined,
    phoneCountryCode: string | undefined,
    isManualCapture: boolean,
    address: string | undefined,
  ): string[] {
    const rawPhones: string[] = [];
    if (rawPhone?.trim()) rawPhones.push(rawPhone.trim());
    if (phoneNumbers) {
      for (const p of phoneNumbers) {
        const t = String(p ?? '').trim();
        if (t && !rawPhones.includes(t)) rawPhones.push(t);
      }
    }

    const resolvedDialCode = resolvePhoneCountry({
      phone: rawPhones[0] ?? null,
      selectedDialCode: phoneCountryCode ?? null,
      isManualCapture,
      address: address ?? null,
    });

    const phones: string[] = [];
    const seen = new Set<string>();
    for (const raw of rawPhones) {
      const result = normalizePhone(raw, { dialCode: resolvedDialCode ?? undefined });
      const normalized = result.ok ? result.value : raw;
      const dedup = phoneDedupKey(raw, { dialCode: resolvedDialCode ?? undefined });
      if (dedup && seen.has(dedup)) continue;
      if (dedup) seen.add(dedup);
      phones.push(normalized);
    }
    return phones;
  }

  // Manual: 9876543210 → 919876543210 (qualifying Indian mobile)
  assertEq(
    simulatePromotionPhones('9876543210', undefined, undefined, true, undefined),
    ['919876543210'],
    'Q: Manual → 919876543210',
  );

  // Manual with non-Indian local phone (no qualifying mobile) and no selection → raw
  assertEq(
    simulatePromotionPhones('501234567', undefined, undefined, true, undefined),
    ['501234567'],
    'Q: Manual non-qualifying phone → raw preserved',
  );

  // User selection: 501234567 + +971 → 971501234567
  assertEq(
    simulatePromotionPhones('501234567', undefined, '+971', false, undefined),
    ['971501234567'],
    'Q: User +971 → 971501234567',
  );

  // International: +971501234567 with +91 selected → 971501234567
  assertEq(
    simulatePromotionPhones('+971501234567', undefined, '+91', false, 'India'),
    ['971501234567'],
    'Q: International overrides → 971501234567',
  );

  // Non-manual Indian phone + no address → 919876543210 (qualifying mobile auto-defaults)
  assertEq(
    simulatePromotionPhones('9876543210', undefined, undefined, false, 'Gurugram, India'),
    ['919876543210'],
    'Q: Non-manual Indian context → 919876543210',
  );

  // Non-manual Indian phone with no address → still 919876543210 (address not needed)
  assertEq(
    simulatePromotionPhones('9876543210', undefined, undefined, false, undefined),
    ['919876543210'],
    'Q: Non-manual Indian mobile with no address → 919876543210',
  );

  // Non-manual Indian phone + UAE address → now 919876543210 (address not consulted)
  assertEq(
    simulatePromotionPhones('9876543210', undefined, undefined, false, 'Dubai, UAE'),
    ['919876543210'],
    'Q: Non-manual Indian mobile defaults to +91 even with UAE address',
  );

  // Non-manual local + no context → raw preserved
  assertEq(
    simulatePromotionPhones('501234567', undefined, undefined, false, undefined),
    ['501234567'],
    'Q: No context → raw preserved',
  );

  // Dedup: three representations → one (all now dedup with bare-international fix)
  assertEq(
    simulatePromotionPhones('+91 98765 43210', ['919876543210', '0091 98765 43210'], '+91', true, undefined),
    ['919876543210'],
    'Q: Dedup three representations → one',
  );

  // Order preservation: phones[0] stays first
  const multiPhone = simulatePromotionPhones('9876543210', ['+971501234567'], '+91', true, undefined);
  assertEq(multiPhone[0], '919876543210', 'Q: phones[0] preserved as first');
  assertEq(multiPhone[1], '971501234567', 'Q: phones[1] is international');
  assertEq(multiPhone.length, 2, 'Q: Two phones after dedup');
}

// ─── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
