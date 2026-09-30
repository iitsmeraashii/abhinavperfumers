// Tests for phone normalization.
// Run with: npx tsx src/capture/normalizePhone.test.ts

import { normalizePhone, phoneDedupKey } from './normalizePhone';

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

// ─── International `+` format ──────────────────────────────────────────────────

assertEq(normalizePhone('+919876543210'),     { ok: true, value: '919876543210' }, '+919876543210');
assertEq(normalizePhone('+91 98765 43210'),   { ok: true, value: '919876543210' }, '+91 98765 43210');
assertEq(normalizePhone('+971501234567'),     { ok: true, value: '971501234567' }, '+971501234567');
assertEq(normalizePhone('+971 50 123 4567'),  { ok: true, value: '971501234567' }, '+971 50 123 4567');
assertEq(normalizePhone('+447911123456'),     { ok: true, value: '447911123456' }, '+447911123456');
assertEq(normalizePhone('+14155552671'),      { ok: true, value: '14155552671' }, '+14155552671');
assertEq(normalizePhone('+1 415 555 2671'),   { ok: true, value: '14155552671' }, '+1 415 555 2671');

// ─── 00 international prefix ──────────────────────────────────────────────────

assertEq(normalizePhone('0091 98765 43210'),   { ok: true, value: '919876543210' }, '0091 98765 43210');
assertEq(normalizePhone('00919876543210'),     { ok: true, value: '919876543210' }, '00919876543210');
assertEq(normalizePhone('00971501234567'),     { ok: true, value: '971501234567' }, '00971501234567');
assertEq(normalizePhone('00971 50 123 4567'),  { ok: true, value: '971501234567' }, '00971 50 123 4567');
assertEq(normalizePhone('00447911123456'),     { ok: true, value: '447911123456' }, '00447911123456');

// ─── Explicit dial code ───────────────────────────────────────────────────────

assertEq(
  normalizePhone('9876543210', { dialCode: '+91' }),
  { ok: true, value: '919876543210' },
  '9876543210 + +91 → 919876543210',
);
assertEq(
  normalizePhone('501234567', { dialCode: '+971' }),
  { ok: true, value: '971501234567' },
  '501234567 + +971 → 971501234567',
);
assertEq(
  normalizePhone('7911123456', { dialCode: '+44' }),
  { ok: true, value: '447911123456' },
  '7911123456 + +44 → 447911123456 (UK local without trunk 0)',
);
assertEq(
  normalizePhone('07911123456', { dialCode: '+44' }),
  { ok: true, value: '447911123456' },
  '07911123456 + +44 → 447911123456 (UK local with trunk 0 stripped)',
);
assertEq(
  normalizePhone('4155552671', { dialCode: '+1' }),
  { ok: true, value: '14155552671' },
  '4155552671 + +1 → 14155552671',
);

// ─── No country context — MUST NOT guess ──────────────────────────────────────

assertEq(
  normalizePhone('9876543210'),
  { ok: false, value: null, reason: 'MISSING_COUNTRY_CONTEXT' },
  '9876543210 without context → MISSING_COUNTRY_CONTEXT (NOT 919876543210)',
);
assertEq(
  normalizePhone('501234567'),
  { ok: false, value: null, reason: 'MISSING_COUNTRY_CONTEXT' },
  '501234567 without context → MISSING_COUNTRY_CONTEXT',
);
assertEq(
  normalizePhone('1234567890'),
  { ok: false, value: null, reason: 'MISSING_COUNTRY_CONTEXT' },
  '1234567890 without context → MISSING_COUNTRY_CONTEXT (NOT assumed Indian)',
);

// ─── Formatting: spaces, hyphens, parentheses, dots ───────────────────────────

assertEq(normalizePhone('+91 (98765) 43210'),  { ok: true, value: '919876543210' }, '+91 (98765) 43210');
assertEq(normalizePhone('+91-98765-43210'),    { ok: true, value: '919876543210' }, '+91-98765-43210');
assertEq(normalizePhone('+91.98765.43210'),    { ok: true, value: '919876543210' }, '+91.98765.43210');
assertEq(normalizePhone('+ 91 98765 43210'),   { ok: true, value: '919876543210' }, '+ 91 98765 43210');
assertEq(
  normalizePhone('(050) 123-4567', { dialCode: '+971' }),
  { ok: true, value: '971501234567' },
  '(050) 123-4567 + +971 → 971501234567 (local UAE, trunk 0 stripped)',
);
assertEq(
  normalizePhone('98-765-43210', { dialCode: '+91' }),
  { ok: true, value: '919876543210' },
  '98-765-43210 + +91 → 919876543210',
);

// ─── Invalid input ────────────────────────────────────────────────────────────

assertEq(normalizePhone(''),          { ok: false, value: null, reason: 'INVALID_PHONE' }, 'empty string');
assertEq(normalizePhone('   '),       { ok: false, value: null, reason: 'INVALID_PHONE' }, 'whitespace only');
assertEq(normalizePhone(null),        { ok: false, value: null, reason: 'INVALID_PHONE' }, 'null');
assertEq(normalizePhone(undefined),   { ok: false, value: null, reason: 'INVALID_PHONE' }, 'undefined');
assertEq(normalizePhone('abcdef'),    { ok: false, value: null, reason: 'INVALID_PHONE' }, 'no digits');
assertEq(normalizePhone('call me'),   { ok: false, value: null, reason: 'INVALID_PHONE' }, 'text, no digits');
assertEq(normalizePhone('+'),         { ok: false, value: null, reason: 'INVALID_PHONE' }, 'plus only, no digits');
assertEq(normalizePhone('00'),        { ok: false, value: null, reason: 'INVALID_PHONE' }, '00 only, no digits');
assertEq(normalizePhone('+123'),      { ok: false, value: null, reason: 'INVALID_PHONE' }, 'too few digits after +');
assertEq(normalizePhone('00123'),     { ok: false, value: null, reason: 'INVALID_PHONE' }, 'too few digits after 00');
assertEq(normalizePhone('123'),       { ok: false, value: null, reason: 'INVALID_PHONE' }, 'too few digits, no context');
assertEq(
  normalizePhone('+1234567890123456'),
  { ok: false, value: null, reason: 'INVALID_PHONE' },
  'too many digits (> 15)',
);

// ─── Dedup key ─────────────────────────────────────────────────────────────────

assertEq(phoneDedupKey('+91 98765 43210'),  '919876543210',  'dedupKey +91 98765 43210');
assertEq(phoneDedupKey('+919876543210'),    '919876543210',  'dedupKey +919876543210 (same canonical)');
assertEq(phoneDedupKey('0091 98765 43210'), '919876543210',  'dedupKey 0091 98765 43210 (same canonical)');
assertEq(phoneDedupKey('9876543210'),       '9876543210',    'dedupKey bare local → raw digits fallback');
assertEq(
  phoneDedupKey('9876543210', { dialCode: '+91' }),
  '919876543210',
  'dedupKey 9876543210 + +91 → canonical',
);
assertEq(phoneDedupKey(''),  '',  'dedupKey empty');
assertEq(phoneDedupKey(null), '', 'dedupKey null');

// ─── Isolation: normalization must NOT infer country ──────────────────────────

// A bare 10-digit number must never become 919876543210 without explicit context.
const bare = normalizePhone('9876543210');
assertEq(bare.ok, false, 'Bare 10-digit: ok is false');
assertEq(bare.ok === false && bare.reason, 'MISSING_COUNTRY_CONTEXT', 'Bare 10-digit: reason is MISSING_COUNTRY_CONTEXT');

// A bare 10-digit number with +44 context must become 447911123456, not 91…
assertEq(
  normalizePhone('7911123456', { dialCode: '+44' })?.ok === true
    ? (normalizePhone('7911123456', { dialCode: '+44' }) as { value: string }).value
    : null,
  '447911123456',
  '7911123456 + +44 → 447911123456 (NOT 917911123456)',
);

// A bare 10-digit number with +971 context must become 971…, not 91…
assertEq(
  normalizePhone('501234567', { dialCode: '+971' })?.ok === true
    ? (normalizePhone('501234567', { dialCode: '+971' }) as { value: string }).value
    : null,
  '971501234567',
  '501234567 + +971 → 971501234567 (NOT 91501234567)',
);

// Normalization must never derive or assume India.
// The only way to get 91 prefix is via explicit dialCode or +91/0091 input.
assertEq(
  normalizePhone('9876543210', { dialCode: '+971' }).ok === true
    ? (normalizePhone('9876543210', { dialCode: '+971' }) as { value: string }).value
    : null,
  '9719876543210',
  '9876543210 + +971 → 9719876543210 (NOT 919876543210)',
);

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
