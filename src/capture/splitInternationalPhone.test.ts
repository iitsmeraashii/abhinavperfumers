// Tests for splitInternationalPhone — UI phone splitting utility.
// Run with: npx tsx src/capture/splitInternationalPhone.test.ts

import { splitInternationalPhone } from './splitInternationalPhone';

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

// ─── 1. International extracted phone: +918796314123 ─────────────────────────

assertEq(
  splitInternationalPhone('+918796314123'),
  { dialCode: '+91', localNumber: '8796314123' },
  'S1: +918796314123 → +91 / 8796314123',
);

// ─── 2. Formatted international phone: +91 87963 14123 ───────────────────────

assertEq(
  splitInternationalPhone('+91 87963 14123'),
  { dialCode: '+91', localNumber: '8796314123' },
  'S2: +91 87963 14123 → +91 / 8796314123',
);

// ─── 3. UAE: +971 50 123 4567 ────────────────────────────────────────────────

assertEq(
  splitInternationalPhone('+971 50 123 4567'),
  { dialCode: '+971', localNumber: '501234567' },
  'S3: +971 50 123 4567 → +971 / 501234567',
);

// ─── 4. Bare Indian mobile: 9876543210 (no selection) ────────────────────────

assertEq(
  splitInternationalPhone('9876543210'),
  { dialCode: '+91', localNumber: '9876543210' },
  'S4: 9876543210 → +91 (auto) / 9876543210',
);

// ─── 5. Explicit override: 9876543210 + +971 ─────────────────────────────────

assertEq(
  splitInternationalPhone('9876543210', '+971'),
  { dialCode: '+971', localNumber: '9876543210' },
  'S5: 9876543210 + +971 → +971 / 9876543210',
);

// ─── 6. Ambiguous +1 ─────────────────────────────────────────────────────────

{
  const result = splitInternationalPhone('+14155552671');
  // +1 is ambiguous — dial code may be null or +1 depending on resolver
  // The key requirement: the full international number is preserved
  if (result.dialCode === null) {
    assertEq(result.localNumber, '+14155552671', 'S6: +1 ambiguous → localNumber is full international');
  } else {
    // If resolver returns +1, the local number should be the remainder
    assertEq(result.dialCode, '+1', 'S6: +1 ambiguous → dialCode is +1');
    assertEq(result.localNumber, '4155552671', 'S6: +1 ambiguous → localNumber is 4155552671');
  }
}

// ─── 7. Non-Indian local: 501234567 (no context) ─────────────────────────────

assertEq(
  splitInternationalPhone('501234567'),
  { dialCode: null, localNumber: '501234567' },
  'S7: 501234567 → null / 501234567 (unresolved)',
);

// ─── 8. 00 prefix: 00971501234567 ────────────────────────────────────────────

assertEq(
  splitInternationalPhone('00971501234567'),
  { dialCode: '+971', localNumber: '501234567' },
  'S8: 00971501234567 → +971 / 501234567',
);

// ─── 9. Empty / null ─────────────────────────────────────────────────────────

assertEq(splitInternationalPhone(''),       { dialCode: null, localNumber: '' }, 'S9: empty → null / empty');
assertEq(splitInternationalPhone(null),     { dialCode: null, localNumber: '' }, 'S10: null → null / empty');
assertEq(splitInternationalPhone(undefined), { dialCode: null, localNumber: '' }, 'S11: undefined → null / empty');

// ─── 10. Bare number with dial code digits: 919876543210 ─────────────────────
// Without a + or 00 prefix, the resolver can't identify this as international.
// It doesn't qualify as a 10-digit Indian mobile (it's 12 digits), so it stays
// unresolved. The full number is returned as the local number.
assertEq(
  splitInternationalPhone('919876543210'),
  { dialCode: null, localNumber: '919876543210' },
  'S12: 919876543210 (no + prefix) → null / 919876543210 (unresolved)',
);

// ─── 11. Formatted Indian: +91 98765 43210 ───────────────────────────────────

assertEq(
  splitInternationalPhone('+91 98765 43210'),
  { dialCode: '+91', localNumber: '9876543210' },
  'S13: +91 98765 43210 → +91 / 9876543210',
);

// ─── 12. User selection overrides extraction ─────────────────────────────────

assertEq(
  splitInternationalPhone('+919876543210', '+971'),
  { dialCode: '+91', localNumber: '9876543210' },
  'S14: +919876543210 with +971 selected → international wins → +91 / 9876543210',
);

// ─── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
