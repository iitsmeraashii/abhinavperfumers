// Regression test for WhatsApp template parameter validation.
//
// Validates the templateParamsValid() helper that gates both the Send button
// disabled state and the defensive guard in handleSend().
//
// Run with: npx tsx scripts/test_templateParamsValid.ts

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

// ── Reproduce the helper from ConversationDetailPage.tsx ───────────────────

function templateParamsValid(params: string[], paramCount: number): boolean {
  if (paramCount === 0) return true;
  for (let i = 0; i < paramCount; i++) {
    if (!params[i] || !params[i].trim()) return false;
  }
  return true;
}

// ── 1. Zero parameters → valid ─────────────────────────────────────────────

assertEq(
  templateParamsValid([], 0),
  true,
  'C1: zero parameters → valid',
);

assertEq(
  templateParamsValid(['', ''], 0),
  true,
  'C1b: zero parameters with garbage array → valid (paramCount=0 short-circuits)',
);

// ── 2. All parameters filled → valid ───────────────────────────────────────

assertEq(
  templateParamsValid(['John', 'Mumbai'], 2),
  true,
  'C2: all parameters filled → valid',
);

assertEq(
  templateParamsValid(['Hello'], 1),
  true,
  'C2b: single parameter filled → valid',
);

// ── 3. One required parameter blank → invalid ──────────────────────────────

assertEq(
  templateParamsValid(['John', ''], 2),
  false,
  'C3: second parameter blank → invalid',
);

assertEq(
  templateParamsValid(['', 'Mumbai'], 2),
  false,
  'C3b: first parameter blank → invalid',
);

assertEq(
  templateParamsValid(['', ''], 2),
  false,
  'C3c: all parameters blank → invalid',
);

// ── 4. Whitespace-only parameter → invalid ─────────────────────────────────

assertEq(
  templateParamsValid(['   ', 'Mumbai'], 2),
  false,
  'C4: first parameter whitespace-only → invalid',
);

assertEq(
  templateParamsValid(['John', '\t\n'], 2),
  false,
  'C4b: second parameter tabs/newlines only → invalid',
);

assertEq(
  templateParamsValid([' '], 1),
  false,
  'C4c: single space → invalid',
);

// ── 5. Missing/undefined parameter → invalid ───────────────────────────────

assertEq(
  templateParamsValid([], 2),
  false,
  'C5: empty array with paramCount=2 → invalid (undefined params)',
);

assertEq(
  templateParamsValid(['John'], 2),
  false,
  'C5b: one param provided, paramCount=2 → invalid (second undefined)',
);

// ── 6. Leading/trailing whitespace around a value → valid after trim ───────

assertEq(
  templateParamsValid(['  John  ', '  Mumbai  '], 2),
  true,
  'C6: leading/trailing whitespace around values → valid (trim passes)',
);

assertEq(
  templateParamsValid(['  Hello World  '], 1),
  true,
  'C6b: whitespace around multi-word value → valid',
);

assertEq(
  templateParamsValid([' John ', ''], 2),
  false,
  'C6c: first param valid with whitespace, second blank → invalid',
);

// ── 7. handleSend rejects invalid parameters before sending ────────────────
//
// Simulates the defensive guard logic in handleSend(). When parameters are
// invalid, the guard should return early with an error message — setSending(true)
// must NOT be reached.

const ERROR_MSG = 'Please fill in all template parameters before sending.';

function simulateHandleSendGuard(
  params: string[],
  paramCount: number,
): { rejected: boolean; errorMessage: string | null; sendingReached: boolean } {
  let sendingReached = false;
  let errorMessage: string | null = null;

  if (paramCount > 0 && !templateParamsValid(params, paramCount)) {
    errorMessage = ERROR_MSG;
    return { rejected: true, errorMessage, sendingReached };
  }

  // If we reach here, setSending(true) would be called
  sendingReached = true;
  return { rejected: false, errorMessage: null, sendingReached };
}

// Invalid params → rejected, sending NOT reached
{
  const result = simulateHandleSendGuard(['John', ''], 2);
  assertEq(result.rejected, true, 'C7a: invalid params → rejected by guard');
  assertEq(result.sendingReached, false, 'C7b: invalid params → setSending(true) NOT reached');
  assertEq(result.errorMessage, ERROR_MSG, 'C7c: invalid params → correct error message');
}

// Valid params → not rejected, sending IS reached
{
  const result = simulateHandleSendGuard(['John', 'Mumbai'], 2);
  assertEq(result.rejected, false, 'C7d: valid params → not rejected');
  assertEq(result.sendingReached, true, 'C7e: valid params → setSending(true) reached');
  assertEq(result.errorMessage, null, 'C7f: valid params → no error message');
}

// Zero params → not rejected, sending IS reached
{
  const result = simulateHandleSendGuard([], 0);
  assertEq(result.rejected, false, 'C7g: zero params → not rejected');
  assertEq(result.sendingReached, true, 'C7h: zero params → setSending(true) reached');
}

// Whitespace-only params → rejected
{
  const result = simulateHandleSendGuard(['  '], 1);
  assertEq(result.rejected, true, 'C7i: whitespace-only param → rejected by guard');
  assertEq(result.sendingReached, false, 'C7j: whitespace-only param → setSending NOT reached');
}

// ─── Summary ────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
