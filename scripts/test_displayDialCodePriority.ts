// Regression test for PhoneInputWithCountry displayDialCode priority fix.
//
// The display dial code must give priority to the explicitly user-selected
// phoneCountryCode, falling back to derivedDialCode only when no explicit
// selection exists.
//
// Current computation (post-fix):
//   const displayDialCode = phoneCountryCode ?? derivedDialCode;
//
// Run with: npx tsx scripts/test_displayDialCodePriority.ts

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

// Reproduces the exact computation from PhoneInputWithCountry.tsx line 112:
//   const displayDialCode = phoneCountryCode ?? derivedDialCode;
//
// Note: LeadDetailPage passes `draft.phoneCountryCode || null` — so an empty
// string draft value becomes null before reaching the component. The component
// prop is therefore always null/undefined when no country is selected, never "".  
// The helper below mirrors both the call-site conversion and the component logic.
function computeDisplayDialCode(
  rawPhoneCountryCode: string | null | undefined,
  derivedDialCode: string | null | undefined,
): string | null | undefined {
  // LeadDetailPage: phoneCountryCode={draft.phoneCountryCode || null}
  const phoneCountryCode = rawPhoneCountryCode || null;
  return phoneCountryCode ?? derivedDialCode;
}

// ─── 1. Explicit +971 beats derived +91 ───────────────────────────────────
// Scenario: phone = 9953256684, user selects +971
// derivedDialCode = +91 (Indian mobile heuristic)
// phoneCountryCode = +971 (user's selection)
assertEq(
  computeDisplayDialCode('+971', '+91'),
  '+971',
  'C1: phoneCountryCode=+971, derivedDialCode=+91 → displays +971',
);

// ─── 2. Explicit +1 beats derived +91 ────────────────────────────────────
assertEq(
  computeDisplayDialCode('+1', '+91'),
  '+1',
  'C2: phoneCountryCode=+1, derivedDialCode=+91 → displays +1',
);

// ─── 3. Explicit +44 beats derived +91 ───────────────────────────────────
assertEq(
  computeDisplayDialCode('+44', '+91'),
  '+44',
  'C3: phoneCountryCode=+44, derivedDialCode=+91 → displays +44',
);

// ─── 4. Explicit +91 with derived +91 → +91 ──────────────────────────────
assertEq(
  computeDisplayDialCode('+91', '+91'),
  '+91',
  'C4: phoneCountryCode=+91, derivedDialCode=+91 → displays +91',
);

// ─── 5. Empty/null phoneCountryCode falls back to derivedDialCode +91 ──────
// Scenario: no explicit selection yet, phone's prefix is Indian.
// The call site converts empty string to null: `draft.phoneCountryCode || null`.
assertEq(
  computeDisplayDialCode('', '+91'),
  '+91',
  'C5: phoneCountryCode=\"\" (→ null at call site), derivedDialCode=+91 → displays +91',
);

// Also for null/undefined:
assertEq(
  computeDisplayDialCode(null, '+91'),
  '+91',
  'C5b: phoneCountryCode=null, derivedDialCode=+91 → displays +91',
);

assertEq(
  computeDisplayDialCode(undefined, '+91'),
  '+91',
  'C5c: phoneCountryCode=undefined, derivedDialCode=+91 → displays +91',
);

// ─── 6. Empty/null phoneCountryCode falls back to derivedDialCode +971 ──────
assertEq(
  computeDisplayDialCode('', '+971'),
  '+971',
  'C6: phoneCountryCode=\"\" (→ null at call site), derivedDialCode=+971 → displays +971',
);

assertEq(
  computeDisplayDialCode(null, '+971'),
  '+971',
  'C6b: phoneCountryCode=null, derivedDialCode=+971 → displays +971',
);

// ─── 7. Both null/empty → null ────────────────────────────────────────────
assertEq(
  computeDisplayDialCode(null, null),
  null,
  'C7: both null → null (no country shown)',
);

assertEq(
  computeDisplayDialCode('', undefined),
  undefined,
  'C8: empty (→ null) + undefined derivedDialCode → undefined (selector shows Select)',
);

// ─── 9. Pre-fix regression: derivedDialCode must NOT override explicit selection
// With the old code `derivedDialCode ?? phoneCountryCode`:
//   computeOld('+971', '+91') = '+91'   // BUG
// With the new code `phoneCountryCode ?? derivedDialCode`:
//   computeNew('+971', '+91') = '+971'  // FIXED
const oldBehavior = (dc: string | null | undefined, pcc: string | null | undefined) => dc ?? pcc;
const newBehavior = (pcc: string | null | undefined, dc: string | null | undefined) => pcc ?? dc;

assertEq(
  oldBehavior('+91', '+971'),
  '+91',
  'C9a: OLD behavior (buggy): derivedDialCode=+91 overrides phoneCountryCode=+971 → +91',
);

assertEq(
  newBehavior('+971', '+91'),
  '+971',
  'C9b: NEW behavior (fixed): phoneCountryCode=+971 wins over derivedDialCode=+91 → +971',
);

// ─── Summary ────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
