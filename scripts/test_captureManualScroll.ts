// Regression test for the Capture Page manual-entry scroll fix.
//
// Verifies that the manual-entry section uses the same scroll pattern as
// the business-card and QR sections: a ref + a useEffect that calls
// scrollIntoView when the section becomes visible.
//
// Run with: npx tsx scripts/test_captureManualScroll.ts

import { readFileSync } from 'fs';

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string): void {
  if (condition) { passed++; } else {
    failed++;
    console.error(`FAIL: ${label}`);
  }
}

const src = readFileSync('src/CaptureLeadPage.tsx', 'utf-8');

// ── 1. manualSectionRef is declared alongside the other section refs ────────

assert(
  src.includes('const manualSectionRef = useRef<HTMLDivElement>(null)'),
  'M1: manualSectionRef useRef declared',
);

// ── 2. useEffect scrolls manual section into view (same pattern as QR/card) ─

const manualEffectIdx = src.indexOf('showManualForm && manualSectionRef.current');
assert(manualEffectIdx !== -1, 'M2a: useEffect references showManualForm and manualSectionRef');

const manualEffectSlice = src.slice(manualEffectIdx, manualEffectIdx + 200);
assert(
  manualEffectSlice.includes('scrollIntoView({ behavior: \'smooth\', block: \'start\' })'),
  'M2b: manual scroll uses same scrollIntoView call as QR/card',
);

// ── 3. The manual form is wrapped in a div with ref={manualSectionRef} ──────

assert(
  src.includes('<div ref={manualSectionRef}>'),
  'M3: manual form wrapped in div with manualSectionRef',
);

// ── 4. QR and card sections still have their refs and effects (unchanged) ──

assert(
  src.includes('qrSectionRef.current.scrollIntoView'),
  'M4a: QR scroll effect still present (unchanged)',
);
assert(
  src.includes('cardSectionRef.current.scrollIntoView'),
  'M4b: card scroll effect still present (unchanged)',
);
assert(
  src.includes('<div ref={qrSectionRef}>'),
  'M4c: QR section wrapper div still present',
);
assert(
  src.includes('<div ref={cardSectionRef}>'),
  'M4d: card section wrapper div still present',
);

// ── 5. All three sections use identical scroll parameters ────────────────────

const qrCall   = src.match(/qrSectionRef\.current\.scrollIntoView\(\{([^}]+)\}\)/);
const cardCall = src.match(/cardSectionRef\.current\.scrollIntoView\(\{([^}]+)\}\)/);
const manualCall = src.match(/manualSectionRef\.current\.scrollIntoView\(\{([^}]+)\}\)/);

assert(qrCall !== null,    'M5a: QR scrollIntoView call found');
assert(cardCall !== null,  'M5b: card scrollIntoView call found');
assert(manualCall !== null,'M5c: manual scrollIntoView call found');

if (qrCall && cardCall && manualCall) {
  assert(
    qrCall[1].trim() === manualCall[1].trim(),
    'M5d: manual scroll params match QR scroll params',
  );
  assert(
    cardCall[1].trim() === manualCall[1].trim(),
    'M5e: manual scroll params match card scroll params',
  );
}

// ── 6. showManualForm variable is used in the effect dependency ─────────────

assert(
  src.includes('}, [showManualForm]);'),
  'M6: useEffect depends on showManualForm',
);

// ── Summary ────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
