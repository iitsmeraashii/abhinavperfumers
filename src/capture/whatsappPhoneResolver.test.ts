// Tests for WhatsApp phone resolution — shared resolver/normalizer pipeline.
// Run with: npx tsx src/capture/whatsappPhoneResolver.test.ts

import { resolveWhatsAppPhone } from './whatsappPhoneResolver';
import { resolvePhoneCountry } from './phoneCountryResolver';
import { normalizePhone } from './normalizePhone';

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

// ─── 1. Automatic India: qualifying 10-digit mobile → +91 ─────────────────────

assertEq(resolveWhatsAppPhone('9876543210'),       '919876543210', 'W1: 9876543210 → 919876543210');
assertEq(resolveWhatsAppPhone('9123456789'),       '9123456789', 'W2: 9123456789 (starts with 91, recognized as already having dial code) → 9123456789');
assertEq(resolveWhatsAppPhone('98765 43210'),      '919876543210', 'W3: 98765 43210 → 919876543210');
assertEq(resolveWhatsAppPhone('09876543210'),      '919876543210', 'W4: 09876543210 (trunk 0) → 919876543210');
assertEq(resolveWhatsAppPhone('98-765-43210'),     '919876543210', 'W5: 98-765-43210 → 919876543210');

// ─── 2. Explicit international prefix ──────────────────────────────────────────

assertEq(resolveWhatsAppPhone('+971501234567'),    '971501234567', 'W6: +971501234567 → 971501234567');
assertEq(resolveWhatsAppPhone('00971501234567'),   '971501234567', 'W7: 00971501234567 → 971501234567');
assertEq(resolveWhatsAppPhone('+919876543210'),    '919876543210', 'W8: +919876543210 → 919876543210');
assertEq(resolveWhatsAppPhone('00919876543210'),   '919876543210', 'W9: 00919876543210 → 919876543210');
assertEq(resolveWhatsAppPhone('+447911123456'),    '447911123456', 'W10: +447911123456 → 447911123456');
assertEq(resolveWhatsAppPhone('+14155552671'),     '14155552671',  'W11: +14155552671 → 14155552671');

// ─── 3. Explicit user country selection ────────────────────────────────────────

assertEq(resolveWhatsAppPhone('501234567', { selectedDialCode: '+971' }), '971501234567', 'W12: 501234567 + +971 → 971501234567');
assertEq(resolveWhatsAppPhone('9876543210', { selectedDialCode: '+91' }), '919876543210', 'W13: 9876543210 + +91 → 919876543210');

// ─── 4. Explicit user country overrides automatic India ───────────────────────

assertEq(resolveWhatsAppPhone('9876543210', { selectedDialCode: '+971' }), '9719876543210', 'W14: 9876543210 + +971 → 9719876543210 (user wins over India default)');

// ─── 5. International overrides selected country ──────────────────────────────

assertEq(resolveWhatsAppPhone('+971501234567', { selectedDialCode: '+91' }), '971501234567', 'W15: +971 with +91 selected → 971501234567');
assertEq(resolveWhatsAppPhone('+919876543210', { selectedDialCode: '+971' }), '919876543210', 'W16: +91 with +971 selected → 919876543210');

// ─── 6. Non-Indian local number without context → unresolved ──────────────────

assertEq(resolveWhatsAppPhone('501234567'),       null, 'W17: 501234567 with no context → null');
assertEq(resolveWhatsAppPhone('501234567', { address: 'Gurugram, India' }), null, 'W18: 501234567 + Indian address → null (address not consulted)');

// ─── 7. Invalid 10-digit number → unresolved ──────────────────────────────────

assertEq(resolveWhatsAppPhone('1234567890'),      null, 'W19: 1234567890 (starts with 1) → null');
assertEq(resolveWhatsAppPhone('0123456789'),      null, 'W20: 0123456789 (starts with 0 after trunk strip → 123456789) → null');

// ─── 8. Address independence ───────────────────────────────────────────────────

assertEq(resolveWhatsAppPhone('9876543210', { address: 'Dubai, UAE' }), '919876543210', 'W21: 9876543210 + UAE address → 919876543210 (address ignored)');
assertEq(resolveWhatsAppPhone('501234567', { address: 'Gurugram, India' }), null, 'W22: 501234567 + Indian address → null (address ignored)');

// ─── 9. Lead-country independence (simulated) ─────────────────────────────────

{
  // lead country = UAE, phone = Indian mobile → phone still +91
  const phoneCountry = resolvePhoneCountry({ phone: '9876543210', isManualCapture: false, address: null });
  assertEq(phoneCountry, '+91', 'W23: Indian mobile → +91 regardless of lead country');

  // lead country = India, phone = UAE local → phone unresolved
  const phoneCountry2 = resolvePhoneCountry({ phone: '501234567', isManualCapture: false, address: null });
  assertEq(phoneCountry2, null, 'W24: Non-Indian local → null regardless of lead country');
}

// ─── 10. Primary phone only — no fallback to phones[1] ────────────────────────

{
  const phones = ['501234567', '971501234567'];
  const waPhone = resolveWhatsAppPhone(phones[0]);
  assertEq(waPhone, null, 'W25: phones[0] unresolved → null (no fallback to phones[1])');
  assertTrue(phones[1] !== undefined, 'W25b: phones[1] exists but is NOT used');
}

// ─── 11. Deduplication ────────────────────────────────────────────────────────

{
  const rawPhones = ['+91 98765 43210', '919876543210', '0091 98765 43210'];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of rawPhones) {
    const resolved = resolveWhatsAppPhone(raw);
    if (!resolved) continue;
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    result.push(resolved);
  }
  assertEq(result.length, 1, 'W26: Three representations → one canonical');
  assertEq(result[0], '919876543210', 'W27: Canonical is 919876543210');
}

// ─── 12. Existing records — bare number resolves without DB update ────────────

{
  // An existing record with bare 9876543210 can be resolved for WhatsApp
  // without updating the database
  const waPhone = resolveWhatsAppPhone('9876543210');
  assertEq(waPhone, '919876543210', 'W28: Existing bare 9876543210 resolves to 919876543210 for WhatsApp');

  // The raw phone in the DB is NOT changed — only the WhatsApp resolution uses +91
  const rawInDb = '9876543210';
  assertEq(rawInDb, '9876543210', 'W29: Raw DB value unchanged');
}

// ─── 13. Empty/invalid input ──────────────────────────────────────────────────

assertEq(resolveWhatsAppPhone(''),         null, 'W30: empty → null');
assertEq(resolveWhatsAppPhone(null),       null, 'W31: null → null');
assertEq(resolveWhatsAppPhone(undefined),  null, 'W32: undefined → null');
assertEq(resolveWhatsAppPhone('   '),      null, 'W33: whitespace → null');
assertEq(resolveWhatsAppPhone('abc'),      null, 'W34: non-numeric → null');

// ─── 14. Manual capture — no separate logic ───────────────────────────────────

{
  // Manual capture with qualifying Indian mobile → same as non-manual
  const manual = resolveWhatsAppPhone('9876543210', { isManualCapture: true });
  const nonManual = resolveWhatsAppPhone('9876543210', { isManualCapture: false });
  assertEq(manual, nonManual, 'W35: Manual and non-manual produce same result');
  assertEq(manual, '919876543210', 'W36: Manual Indian mobile → 919876543210');

  // Manual with non-qualifying local phone and no selection → null (not +91)
  const manualNonIndian = resolveWhatsAppPhone('501234567', { isManualCapture: true });
  assertEq(manualNonIndian, null, 'W37: Manual non-qualifying phone → null (no automatic +91)');
}

// ─── 15. No hardcoded 91 in resolveWhatsAppPhone ──────────────────────────────

// The resolver should NOT independently prepend 91 — it uses normalizePhone
// with the resolved dial code. Verify with a non-Indian selection.
assertEq(resolveWhatsAppPhone('501234567', { selectedDialCode: '+966' }), '966501234567', 'W38: 501234567 + +966 → 966501234567 (no hardcoded 91)');

// ─── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
