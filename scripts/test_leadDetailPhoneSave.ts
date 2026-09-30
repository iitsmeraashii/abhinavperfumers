// Regression test for Lead Detail phone-save representation.
//
// Verifies that:
//   1. normalizePhone() returns bare E.164 digits (no "+") — its contract.
//   2. The Lead Detail save path stores the phone WITH a leading "+".
//   3. Re-opening the edit form (splitInternationalPhone) recovers the
//      correct dial code + local number round-trip.
//   4. resolveWhatsAppPhone() still returns bare digits (no "+") when
//      given a "+..." stored phone — WhatsApp/Meta representation unchanged.
//   5. An existing bare stored number is not incorrectly changed by the
//      save flow unless the user explicitly edits it (the fallback path
//      preserves the raw value as-is).
//
// Run with: npx tsx scripts/test_leadDetailPhoneSave.ts

import { normalizePhone } from '../src/capture/normalizePhone';
import { splitInternationalPhone } from '../src/capture/splitInternationalPhone';
import { resolveWhatsAppPhone } from '../src/capture/whatsappPhoneResolver';

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

// Reproduces the LeadDetailPage.handleSave phone-computation logic.
// Returns the value that would be pushed into the persisted phones[] array.
function computeStoredPhone(raw: string, dialCode: string | undefined): string {
  const result = normalizePhone(raw, { dialCode });
  return result.ok ? '+' + result.value : raw;
}

// ─── 1. normalizePhone contract: bare digits, no "+" ────────────────────────

assertEq(
  normalizePhone('504067076', { dialCode: '+971' }),
  { ok: true, value: '971504067076' },
  'R1: normalizePhone(+971, 504067076) → bare 971504067076',
);

assertEq(
  normalizePhone('8796314123', { dialCode: '+91' }),
  { ok: true, value: '918796314123' },
  'R1b: normalizePhone(+91, 8796314123) → bare 918796314123',
);

// ─── 2. Save path stores WITH "+" ───────────────────────────────────────────

assertEq(
  computeStoredPhone('504067076', '+971'),
  '+971504067076',
  'R2: UAE edit/save → stored +971504067076',
);

assertEq(
  computeStoredPhone('8796314123', '+91'),
  '+918796314123',
  'R2b: IN edit/save → stored +918796314123',
);

// ─── 3. Round-trip: stored "+..." re-opens as correct dial code + local ─────

{
  const stored = '+971504067076';
  const split = splitInternationalPhone(stored);
  assertEq(split.dialCode, '+971', 'R3a: reopen +971504067076 → dialCode +971');
  assertEq(split.localNumber, '504067076', 'R3b: reopen +971504067076 → local 504067076');
  // Re-saving the split values must produce the same stored phone.
  assertEq(
    computeStoredPhone(split.localNumber, split.dialCode ?? undefined),
    '+971504067076',
    'R3c: re-save round-trip → +971504067076',
  );
}

{
  const stored = '+918796314123';
  const split = splitInternationalPhone(stored);
  assertEq(split.dialCode, '+91', 'R3d: reopen +918796314123 → dialCode +91');
  assertEq(split.localNumber, '8796314123', 'R3e: reopen +918796314123 → local 8796314123');
  assertEq(
    computeStoredPhone(split.localNumber, split.dialCode ?? undefined),
    '+918796314123',
    'R3f: re-save round-trip → +918796314123',
  );
}

// ─── 4. WhatsApp representation stays bare digits (no "+") ──────────────────

assertEq(
  resolveWhatsAppPhone('+971504067076'),
  '971504067076',
  'R4a: WhatsApp sees 971504067076 (no +) from stored +971504067076',
);

assertEq(
  resolveWhatsAppPhone('+918796314123'),
  '918796314123',
  'R4b: WhatsApp sees 918796314123 (no +) from stored +918796314123',
);

// ─── 5. Existing bare stored number is not incorrectly changed ──────────────
// A bare stored number (no "+") like "971504067075" cannot be resolved by
// resolveWhatsAppPhone without explicit country context — that is the
// existing, correct behavior (normalizePhone returns MISSING_COUNTRY_CONTEXT
// for bare numbers without a dial code). This is not changed by our fix.
// The save path only prepends "+" on SUCCESSFUL normalization; the fallback
// (normalize fails) preserves the raw value as-is.

// 5a. A bare 12-digit number without "+" is NOT resolvable by WhatsApp alone.
assertEq(
  resolveWhatsAppPhone('971504067075'),
  null,
  'R5a: bare 971504067075 (no +) → WhatsApp null (missing country context)',
);

// 5b. The same bare number WITH "+" resolves correctly to bare digits.
assertEq(
  resolveWhatsAppPhone('+971504067075'),
  '971504067075',
  'R5b: +971504067075 → WhatsApp 971504067075 (bare, no +)',
);

// 5c. Fallback: if normalizePhone fails (e.g. too short), raw is preserved
// as-is — the save path does NOT prepend "+" to a failed normalization.
assertEq(
  computeStoredPhone('12345', undefined),
  '12345',
  'R5c: unresolvable short number → preserved as-is (no spurious +)',
);

// ─── Summary ────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
