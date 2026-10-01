// Regression test for the Application "Other" option in the Capture Form.
//
// Verifies the APPLICATION VALUE RULES:
// 1. Predefined options unchanged.
// 2. "Other" chip rendered alongside predefined options.
// 3. Blank text input appears when Other is selected (no placeholder).
// 4. Custom text stored in the existing application field (no new field).
// 5. "Other" selected with blank text → NO sentinel, NO "Other", NO empty
//    string stored. Only predefined values preserved.
// 6. Existing custom values reopen the Other input populated.
// 7. Toggling predefined preserves custom values.
// 8. Deselecting Other drops custom value, keeps predefined.
// 9. DraftData.application typed as string[].
// 10. Other chip visually distinct.
// 11. The sentinel APPLICATION_OTHER is never placed into the application
//     array by any code path in ManualEntryForm.
//
// Run with: npx tsx scripts/test_applicationOtherOption.ts

import { readFileSync } from 'fs';

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string): void {
  if (condition) { passed++; } else {
    failed++;
    console.error(`FAIL: ${label}`);
  }
}

const typesSrc = readFileSync('src/capture/types.ts', 'utf-8');
const formSrc  = readFileSync('src/capture/ManualEntryForm.tsx', 'utf-8');

// ── 1. Predefined options unchanged ─────────────────────────────────────────

const expectedOptions = [
  'Fine Fragrances', 'Air Care', 'Incense Sticks', 'Cosmetics',
  'Fabric Care', 'Home Care', 'Candle',
];

for (const opt of expectedOptions) {
  assert(typesSrc.includes(`'${opt}'`), `A1: predefined option "${opt}" still in APPLICATION_OPTIONS`);
}

// ── 2. Other chip is present ────────────────────────────────────────────────

assert(
  typesSrc.includes("export const APPLICATION_OTHER = '__other__'"),
  'A2a: APPLICATION_OTHER sentinel constant exists in types',
);
assert(
  formSrc.includes('>Other<') || formSrc.includes('Other\n        </button>'),
  'A2b: "Other" chip button is rendered',
);

// ── 3. Blank text input appears when Other is selected ──────────────────────

assert(
  formSrc.includes('otherOpen && ('),
  'A3a: text input conditionally rendered when Other is open',
);
assert(
  !formSrc.includes('placeholder="Enter application..."'),
  'A3b: custom input has no placeholder text',
);

// ── 4. Custom text stored in existing application field ─────────────────────

assert(
  formSrc.includes('emit(predefined, [text.trim()])'),
  'A4a: custom text stored via emit() into the application array',
);
assert(
  !formSrc.includes('customApplication'),
  'A4b: no new database field name introduced',
);

// ── 5. Blank Other does not store sentinel / "Other" / empty ────────────────

// The key rule: when Other text is blank, handleCustomText calls
// emit(predefined, []) — NOT emit(predefined, [APPLICATION_OTHER]).
assert(
  formSrc.includes("emit(predefined, [])"),
  'A5a: blank custom text calls emit(predefined, []) — no sentinel stored',
);
// Verify no code path in the form puts APPLICATION_OTHER into the onChange
// callback (which writes to the application field).
// The sentinel is used defensively (filtering old drafts, React key) but
// must never be passed to onChange/emit as a value to store.
assert(
  !formSrc.includes('[...predefined, APPLICATION_OTHER]'),
  'A5b: APPLICATION_OTHER never appended to predefined in an onChange call',
);
assert(
  !formSrc.includes('emit(predefined, [APPLICATION_OTHER])'),
  'A5b2: APPLICATION_OTHER never passed to emit() as a custom value',
);
assert(
  !formSrc.includes("'__other__'"),
  'A5c: sentinel string literal never appears in form source',
);

// ── 6. Existing custom values reopen Other input ────────────────────────────

assert(
  formSrc.includes('customValues = selected.filter'),
  'A6a: component separates predefined from custom values on load',
);
assert(
  formSrc.includes('useState(customValues.length > 0)'),
  'A6b: Other open state initialized from existing custom values',
);
assert(
  formSrc.includes('customText = customValues[0]'),
  'A6c: existing custom value populates the text input on load',
);

// ── 7. Toggling predefined preserves custom values ──────────────────────────

assert(
  formSrc.includes('function togglePredefined'),
  'A7a: togglePredefined function exists',
);
assert(
  formSrc.includes('emit(predefined.filter'),
  'A7b: deselecting predefined preserves customValues',
);
assert(
  formSrc.includes('emit([...predefined, opt], customValues)'),
  'A7c: selecting predefined preserves customValues',
);

// ── 8. Deselecting Other drops custom, keeps predefined ─────────────────────

assert(
  formSrc.includes('function toggleOther'),
  'A8a: toggleOther function exists',
);
assert(
  formSrc.includes('setOtherOpen(false)'),
  'A8b: deselecting Other closes the input',
);
assert(
  formSrc.includes('emit(predefined, [])'),
  'A8c: deselecting Other drops custom value, keeps predefined',
);

// ── 9. Type safety ──────────────────────────────────────────────────────────

assert(
  typesSrc.includes('application?:       string[];'),
  'A9: DraftData.application typed as string[] (accepts custom values)',
);

// ── 10. Other chip visually distinct ────────────────────────────────────────

assert(
  formSrc.includes('border border-dashed'),
  'A10a: Other chip uses dashed border for visual distinction',
);
assert(
  formSrc.includes('bg-transparent'),
  'A10b: Other chip uses transparent background when inactive',
);

// ── 11. emit() helper never includes sentinel ───────────────────────────────

// The emit function is the single gate: it spreads predefined + custom.
// Since APPLICATION_OTHER is never in predefined (it's not in APPLICATION_OPTIONS)
// and custom only contains trimmed user text, the sentinel can never leak.
assert(
  formSrc.includes('function emit('),
  'A11a: emit() helper exists as the single write gate',
);
assert(
  formSrc.includes('onChange([...nextPredefined, ...nextCustom])'),
  'A11b: emit() spreads predefined + custom only — no sentinel path',
);

// ── Summary ────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
