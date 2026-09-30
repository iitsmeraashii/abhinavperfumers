// Tests for LeadDetailPage.makeDraft phone initialization.
// Verifies that stored international phones are split into dial code + local number
// using splitInternationalPhone(), and ambiguous numbers are preserved.
// Run with: npx tsx scripts/test_leadDetailPhoneInit.ts

import { splitInternationalPhone } from '../src/capture/splitInternationalPhone';

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

// makeDraft uses splitInternationalPhone(rawPhone) with no selectedDialCode.
// This simulates the exact call path: splitInternationalPhone(rawPhone0)

// ─── 1. +971504067075 → AE/+971, phone 504067075 ─────────────────────────────

{
  const raw = '+971504067075';
  const split = splitInternationalPhone(raw);
  assertEq(split.dialCode, '+971', 'L1: +971504067075 → dialCode +971');
  assertEq(split.localNumber, '504067075', 'L1: +971504067075 → localNumber 504067075');
}

// ─── 2. +918796314123 → IN/+91, phone 8796314123 ─────────────────────────────

{
  const raw = '+918796314123';
  const split = splitInternationalPhone(raw);
  assertEq(split.dialCode, '+91', 'L2: +918796314123 → dialCode +91');
  assertEq(split.localNumber, '8796314123', 'L2: +918796314123 → localNumber 8796314123');
}

// ─── 3. 9953256684 → IN/+91, phone 9953256684 ────────────────────────────────

{
  const raw = '9953256684';
  const split = splitInternationalPhone(raw);
  assertEq(split.dialCode, '+91', 'L3: 9953256684 → dialCode +91 (Indian mobile default)');
  assertEq(split.localNumber, '9953256684', 'L3: 9953256684 → localNumber 9953256684 (unchanged)');
}

// ─── 4. Ambiguous international number — preserve original ───────────────────
// +1 is ambiguous (US/Canada + many Caribbean). The number must be preserved
// rather than guessing a split. splitInternationalPhone returns dialCode +1
// but with the full international number as localNumber (it can't strip
// confidently). We verify the original is preserved in localNumber.

{
  const raw = '+14155552671';
  const split = splitInternationalPhone(raw);
  // Either: dialCode null + full number preserved, OR dialCode +1 but
  // localNumber is the full international (not stripped).
  // The key requirement: the phone editor shows the full number, not a
  // truncated/guessed local portion.
  if (split.dialCode === null) {
    assertEq(split.localNumber, '+14155552671', 'L4: ambiguous +1 → full number preserved (no dial code)');
  } else {
    // If a dial code is returned, the local number must still contain
    // the full number (not stripped to just '4155552671')
    assertEq(split.localNumber, '+14155552671', 'L4: ambiguous +1 → full number preserved in localNumber');
  }
}

// ─── 5. Empty phone → no crash, empty values ─────────────────────────────────

{
  const split = splitInternationalPhone('');
  assertEq(split.dialCode, null, 'L5: empty → dialCode null');
  assertEq(split.localNumber, '', 'L5: empty → localNumber empty');
}

// ─── 6. Secondary phone also splits correctly ────────────────────────────────

{
  const rawPhone0 = '+971504067075';
  const rawPhone1 = '+918796314123';
  const split0 = splitInternationalPhone(rawPhone0);
  const split1 = splitInternationalPhone(rawPhone1);
  assertEq(split0.dialCode, '+971', 'L6a: phone0 +971504067075 → dialCode +971');
  assertEq(split0.localNumber, '504067075', 'L6a: phone0 +971504067075 → localNumber 504067075');
  assertEq(split1.dialCode, '+91', 'L6b: phone1 +918796314123 → dialCode +91');
  assertEq(split1.localNumber, '8796314123', 'L6b: phone1 +918796314123 → localNumber 8796314123');
}

// ─── 7. Save flow recombine: local number + dialCode → same normalized value ─
// Verify that splitting then re-normalizing produces the same canonical phone.
// This proves the round-trip is lossless for the save path.

import { normalizePhone } from '../src/capture/normalizePhone';

{
  const raw = '+971504067075';
  const split = splitInternationalPhone(raw);
  const recombined = normalizePhone(split.localNumber, { dialCode: split.dialCode ?? undefined });
  const original = normalizePhone(raw, { dialCode: undefined });
  assertEq(recombined.ok, true, 'L7a: recombined normalize succeeds');
  assertEq(original.ok, true, 'L7b: original normalize succeeds');
  if (recombined.ok && original.ok) {
    assertEq(recombined.value, original.value, 'L7: round-trip +971504067075 → same normalized value');
  }
}

{
  const raw = '+918796314123';
  const split = splitInternationalPhone(raw);
  const recombined = normalizePhone(split.localNumber, { dialCode: split.dialCode ?? undefined });
  const original = normalizePhone(raw, { dialCode: undefined });
  if (recombined.ok && original.ok) {
    assertEq(recombined.value, original.value, 'L8: round-trip +918796314123 → same normalized value');
  }
}

{
  const raw = '9953256684';
  const split = splitInternationalPhone(raw);
  const recombined = normalizePhone(split.localNumber, { dialCode: split.dialCode ?? undefined });
  const original = normalizePhone(raw, { dialCode: undefined });
  if (recombined.ok && original.ok) {
    assertEq(recombined.value, original.value, 'L9: round-trip 9953256684 → same normalized value');
  }
}

// ─── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
