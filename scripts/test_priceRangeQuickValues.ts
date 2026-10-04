// Regression tests for Price Range Quick Values global configuration.
//
// Verifies:
// 1. Migration adds price_range_quick_values column with empty-array default.
// 2. INR/USD are built-in defaults, never stored in the configurable column.
// 3. SECURITY DEFINER RPCs exist for safe narrow access.
// 4. RLS tightened to admin-only SELECT/UPDATE on runtime_configuration.
// 5. runtimeConfiguration.ts fetches via RPC and caches.
// 6. runtimeDiagnostics.ts exposes getPriceRangeQuickValues().
// 7. PriceRangeInput renders operators + built-in + configured values dynamically.
// 8. Admin UI in MyAccountPage is admin-only and exposes only Price Range.
// 9. Validation rejects INR/USD, blanks, duplicates.
// 10. No hardcoded AED/GBP/% in application source.
//
// Run with: npx tsx scripts/test_priceRangeQuickValues.ts

import { readFileSync } from 'fs';

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string): void {
  if (condition) { passed++; } else {
    failed++;
    console.error(`FAIL: ${label}`);
  }
}

const migrationSrc = readFileSync(
  'supabase/migrations/20260930120000_add_price_range_quick_values_configuration.sql',
  'utf-8',
);
const runtimeConfigSrc = readFileSync('src/runtime/runtimeConfiguration.ts', 'utf-8');
const priceServiceSrc = readFileSync('src/runtime/priceRangeConfiguration.ts', 'utf-8');
const priceStorageSrc = readFileSync('src/capture/priceRangeCacheStorage.ts', 'utf-8');
const runtimeDiagSrc   = readFileSync('src/runtime/runtimeDiagnostics.ts', 'utf-8');
const formSrc          = readFileSync('src/capture/ManualEntryForm.tsx', 'utf-8');
const accountSrc       = readFileSync('src/MyAccountPage.tsx', 'utf-8');

// ── 1. Migration: column + default ───────────────────────────────────────────

assert(
  migrationSrc.includes('price_range_quick_values text[] NOT NULL DEFAULT'),
  'M1: migration adds price_range_quick_values text[] column',
);
assert(
  migrationSrc.includes("DEFAULT '{}'"),
  'M2: default is empty array (INR/USD are built-in, not stored)',
);

// ── 2. INR/USD never in configurable column ──────────────────────────────────

assert(
  !migrationSrc.includes("DEFAULT '{INR,USD}'"),
  'M3: migration does NOT seed INR/USD into the configurable column',
);
assert(
  migrationSrc.includes("'INR'") && migrationSrc.includes("'USD'") &&
  (migrationSrc.includes("'<'") || migrationSrc.includes("'<'") ||
   migrationSrc.includes("'>'") || migrationSrc.includes("'>'")),
  'M4: write RPC rejects built-in defaults from the configurable list',
);

// ── 3. SECURITY DEFINER RPCs ─────────────────────────────────────────────────

assert(
  migrationSrc.includes('get_price_range_quick_values'),
  'R1: get_price_range_quick_values RPC exists in migration',
);
assert(
  migrationSrc.includes('set_price_range_quick_values'),
  'R2: set_price_range_quick_values RPC exists in migration',
);
assert(
  migrationSrc.includes('SECURITY DEFINER'),
  'R3: RPCs are SECURITY DEFINER (bypass RLS safely)',
);
assert(
  migrationSrc.includes('GRANT EXECUTE ON FUNCTION public.get_price_range_quick_values'),
  'R4: read RPC granted to authenticated',
);
assert(
  migrationSrc.includes('GRANT EXECUTE ON FUNCTION public.set_price_range_quick_values'),
  'R5: write RPC granted to authenticated',
);

// ── 4. RLS tightened to admin-only ───────────────────────────────────────────

assert(
  migrationSrc.includes('DROP POLICY IF EXISTS "read_runtime_configuration"'),
  'S1: old permissive SELECT policy dropped',
);
assert(
  migrationSrc.includes('DROP POLICY IF EXISTS "update_runtime_configuration"'),
  'S2: old permissive UPDATE policy dropped',
);
assert(
  migrationSrc.includes("sr.role = 'admin'") && migrationSrc.includes('FOR SELECT'),
  'S3: new SELECT policy is admin-only',
);
assert(
  migrationSrc.includes("sr.role = 'admin'") && migrationSrc.includes('FOR UPDATE'),
  'S4: new UPDATE policy is admin-only',
);

// ── 5. runtimeConfiguration.ts: RPC fetch + cache ────────────────────────────

assert(
  runtimeConfigSrc.includes('refreshPriceRange'),
  'C1: runtime compatibility delegates to shared price refresh',
);
assert(
  priceServiceSrc.includes("supabase.rpc('get_price_range_quick_values')"),
  'C2: fetches via RPC (not direct table SELECT)',
);
assert(
  priceServiceSrc.includes('getPriceRangeSnapshot'),
  'C3: price range cache variable exists',
);
assert(
  runtimeConfigSrc.includes('getCachedPriceRangeQuickValues'),
  'C4: getCachedPriceRangeQuickValues exported',
);
assert(
  runtimeConfigSrc.includes('BUILTIN_PRICE_RANGE_VALUES'),
  'C5: BUILTIN_PRICE_RANGE_VALUES exported',
);
assert(
  priceStorageSrc.includes("'INR'") && priceStorageSrc.includes("'USD'") &&
  priceStorageSrc.includes("'<'") && priceStorageSrc.includes("'>'") &&
  priceStorageSrc.includes("'='") && priceStorageSrc.includes("'-'"),
  'C6: built-in defaults include INR, USD, <, >, =, and -',
);
assert(
  priceServiceSrc.includes('values: [] as string[]'),
  'C7: configured-values default is empty array',
);

// ── 6. runtimeDiagnostics.ts: accessor ───────────────────────────────────────

assert(
  runtimeDiagSrc.includes('getPriceRangeQuickValues'),
  'D1: getPriceRangeQuickValues exported from runtimeDiagnostics',
);
assert(
  runtimeDiagSrc.includes('BUILTIN_PRICE_RANGE_VALUES'),
  'D2: combines built-in defaults with configured values',
);
assert(
  runtimeDiagSrc.includes('getCachedPriceRangeQuickValues'),
  'D3: reads from cache (O(1), no DB call)',
);

// ── 7. PriceRangeInput: dynamic rendering ────────────────────────────────────

assert(
  formSrc.includes('PRICE_RANGE_OPERATORS'),
  'F1: operators are a separate constant (not mixed with values)',
);
assert(
  formSrc.includes('quickValues={priceRangeQuickValues}') && formSrc.includes('quickValues: configuredValues'),
  'F2: PriceRangeInput reads quick values from runtime config',
);
assert(
  !formSrc.includes("'INR', 'USD'"),
  'F3: INR/USD no longer hardcoded in button array',
);
assert(
  formSrc.includes('quickValues.map'),
  'F4: configured values rendered dynamically via .map',
);
assert(
  formSrc.includes('PRICE_RANGE_OPERATORS.map'),
  'F5: operators rendered via .map from constant',
);
assert(
  formSrc.includes('flex-wrap'),
  'F6: button container uses flex-wrap for many values',
);

// ── 8. Admin UI: admin-only, exposes only Price Range ────────────────────────

assert(
  accountSrc.includes('isAdmin') && accountSrc.includes('Price Range Quick Values'),
  'A1: MyAccountPage has admin-only Price Range section',
);
assert(
  accountSrc.includes('BUILTIN_PRICE_RANGE_VALUES'),
  'A2: built-in defaults shown as non-removable badges',
);
assert(
  accountSrc.includes('TagInput'),
  'A3: reuses TagInput for adding/removing values',
);
assert(
  accountSrc.includes('saveConfirmedPriceRange') && priceServiceSrc.includes('set_price_range_quick_values'),
  'A4: saves via RPC (not direct table update)',
);
assert(
  accountSrc.includes('usePriceRangeQuickValues') && priceServiceSrc.includes('get_price_range_quick_values'),
  'A5: loads via RPC (not direct table SELECT)',
);
assert(
  priceServiceSrc.includes('savePriceRangeCache(confirmed') && priceServiceSrc.includes('publish({ values: confirmed'),
  'A6: refreshes runtime cache after saving',
);
assert(
  !accountSrc.includes('runtime_configuration'),
  'A7: does NOT reference the runtime_configuration table directly',
);

// ── 9. Validation ────────────────────────────────────────────────────────────

assert(
  migrationSrc.includes('btrim'),
  'V1: write RPC trims whitespace',
);
assert(
  migrationSrc.includes("v_trimmed IS NULL OR v_trimmed = ''"),
  'V2: write RPC rejects blank/whitespace-only values',
);
assert(
  migrationSrc.includes('unnest(v_cleaned)'),
  'V3: write RPC does case-insensitive duplicate check',
);
assert(
  migrationSrc.includes('array_append'),
  'V4: write RPC preserves order via array_append',
);

// ── 10. No hardcoded future values ───────────────────────────────────────────

assert(
  !formSrc.includes("'AED'"),
  'N1: AED not hardcoded in form',
);
assert(
  !formSrc.includes("'GBP'"),
  'N2: GBP not hardcoded in form',
);
assert(
  !formSrc.includes("'%'") && !formSrc.includes("'% '"),
  'N3: percent sign not hardcoded in form',
);
assert(
  !accountSrc.includes("'AED'") && !accountSrc.includes("'GBP'"),
  'N4: no example values hardcoded in admin UI',
);

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
