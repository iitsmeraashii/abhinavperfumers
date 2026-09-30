// Regression test for navigation responsiveness fix.
// Verifies:
// 1. Desktop header uses lg breakpoint (not md)
// 2. Mobile top bar, bottom nav, and More drawer use lg:hidden (not md:hidden)
// 3. Page content uses pb-mobile-nav lg:pb-0 (not md:pb-0)
// 4. Bottom nav buttons use px-1.5 (not px-1)
// 5. MOBILE_TABS contents are unchanged
// 6. More drawer admin options are unchanged
// 7. z-index values are preserved
//
// Run with: npx tsx scripts/test_navResponsiveness.ts

import { readFileSync } from 'fs';

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string): void {
  if (condition) { passed++; } else {
    failed++;
    console.error(`FAIL: ${label}`);
  }
}

const src = readFileSync('src/App.tsx', 'utf-8');

// ── 1. Desktop header uses lg breakpoint ────────────────────────────────────

assert(
  src.includes('hidden lg:flex bg-white border-b border-stone-200'),
  'N1: desktop header has hidden lg:flex',
);
assert(
  !src.includes('hidden md:flex bg-white'),
  'N1b: desktop header does NOT have hidden md:flex',
);

// ── 2. Mobile/tablet elements use lg:hidden ─────────────────────────────────

assert(
  src.includes('z-30 flex lg:hidden'),
  'N2a: mobile top bar uses lg:hidden',
);
assert(
  src.includes('z-40 bg-white border-t border-stone-200 flex lg:hidden'),
  'N2b: mobile bottom nav uses lg:hidden',
);
assert(
  src.includes('z-45 bg-black/30 lg:hidden'),
  'N2c: More drawer backdrop uses lg:hidden',
);
assert(
  src.includes('z-50 bg-white rounded-t-2xl shadow-2xl lg:hidden'),
  'N2d: More drawer panel uses lg:hidden',
);
assert(
  !src.includes('md:hidden'),
  'N2e: no md:hidden remains anywhere in App.tsx',
);

// ── 3. Page content padding uses lg breakpoint ──────────────────────────────

assert(
  src.includes('pb-mobile-nav lg:pb-0'),
  'N3: page content uses pb-mobile-nav lg:pb-0',
);
assert(
  !src.includes('md:pb-0'),
  'N3b: page content does NOT use md:pb-0',
);

// ── 4. Bottom nav button padding is px-1.5 ──────────────────────────────────

assert(
  src.includes('min-h-[3.75rem] px-1.5 relative'),
  'N4a: bottom nav tab buttons use px-1.5',
);
assert(
  !src.includes('min-h-[3.75rem] px-1 '),
  'N4b: no bottom nav buttons still use px-1 (with trailing space)',
);

// ── 5. MOBILE_TABS contents unchanged ───────────────────────────────────────

assert(
  src.includes("{ id: 'dashboard', label: 'Dashboard', icon: <LayoutDashboard"),
  'N5a: MOBILE_TABS has Dashboard (adminOnly)',
);
assert(
  src.includes("{ id: 'leads',     label: 'Leads',     icon: <List"),
  'N5b: MOBILE_TABS has Leads',
);
assert(
  src.includes("{ id: 'capture',   label: 'Capture',   icon: <PlusCircle"),
  'N5c: MOBILE_TABS has Capture (emphasize)',
);
assert(
  src.includes("{ id: 'queue',          label: 'Queue',         icon: <Layers"),
  'N5d: MOBILE_TABS has Queue',
);
assert(
  src.includes("{ id: 'conversations',  label: 'WhatsApp',      icon: <MessageCircle"),
  'N5e: MOBILE_TABS has WhatsApp',
);
assert(
  src.includes("{ id: 'events',          label: 'Events',        icon: <CalendarDays"),
  'N5f: MOBILE_TABS has Events (adminOnly)',
);

// ── 6. More drawer admin options unchanged ──────────────────────────────────

assert(
  src.includes("{ id: 'account', label: 'My Account', icon: <User"),
  'N6a: More drawer has My Account',
);
assert(
  src.includes("{ id: 'notifications' as Tab, label: 'Notifications', icon: <Bell"),
  'N6b: More drawer has Notifications (admin)',
);
assert(
  src.includes("{ id: 'salesreps' as Tab,      label: 'Sales Reps',     icon: <Users"),
  'N6c: More drawer has Sales Reps (admin)',
);
assert(
  src.includes("{ id: 'whatsapp_assets' as Tab, label: 'WhatsApp Assets', icon: <Package"),
  'N6d: More drawer has WhatsApp Assets (admin)',
);

// ── 7. z-index values preserved ─────────────────────────────────────────────

assert(src.includes('z-30'), 'N7a: mobile top bar z-30 preserved');
assert(src.includes('z-40'), 'N7b: bottom nav z-40 preserved');
assert(src.includes('z-45'), 'N7c: More drawer backdrop z-45 preserved');
assert(src.includes('z-50'), 'N7d: More drawer panel z-50 preserved');

// ── 8. min-h-[3.75rem] unchanged ────────────────────────────────────────────

assert(
  src.includes('min-h-[3.75rem]'),
  'N8: bottom nav min height 3.75rem preserved',
);

// ── Summary ────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
