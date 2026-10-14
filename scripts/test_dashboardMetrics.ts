// Component-level tests for Dashboard loading correctness.
//
// Exercises the production-used DashboardMetricsLoader controller (the class
// that DashboardPage delegates to) plus the exported pure functions. Mocks
// only external boundaries: supabase RPC, authMode, connectivity.
//
// Build & run:
//   npx esbuild scripts/test_dashboardMetrics.ts --bundle --platform=node --format=cjs \
//     --alias:supabaseClient=./scripts/test_dashboard_stub_supabase.ts \
//     --alias:authModeState=./scripts/test_dashboard_stub_authMode.ts \
//     --alias:connectivityStore=./scripts/test_dashboard_stub_connectivity.ts \
//     --outfile=scripts/test_dashboardMetrics.cjs && node scripts/test_dashboardMetrics.cjs

import {
  DashboardMetricsLoader,
  parseMetricsResponse,
  getTodayIso,
  identityKey,
  isAuthorized,
  isValidCount,
  ERR_SIGN_IN,
  ERR_WAITING,
  ERR_UNAVAILABLE,
  EMPTY_DASHBOARD,
  type DashboardData,
} from '../src/dashboardMetricsLoader';
import { __setRpcHandler, __resetRpcHandler } from './test_dashboard_stub_supabase';
import { setAuthModeState } from './test_dashboard_stub_authMode';
import { __setTransportOnline } from './test_dashboard_stub_connectivity';

// ─── Test helpers ────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (condition) {
    passed++;
    console.log(`  PASS: ${message}`);
  } else {
    failed++;
    console.error(`  FAIL: ${message}`);
  }
}

function flushPromises(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}

// ─── Test data ───────────────────────────────────────────────────────────────

const VALID_METRICS = {
  total_leads: 100, leads_today: 10, leads_last_7_days: 50, leads_last_30_days: 80,
  whatsapp_sent: 30, whatsapp_failed: 5, invalid_leads: 2,
  new_leads: 40, contacted_leads: 20, qualified_leads: 15, converted_leads: 10, lost_leads: 5,
  hot_leads: 25, warm_leads: 30, cold_leads: 40, unassigned_temperature_leads: 5,
};

const ZERO_METRICS = {
  total_leads: 0, leads_today: 0, leads_last_7_days: 0, leads_last_30_days: 0,
  whatsapp_sent: 0, whatsapp_failed: 0, invalid_leads: 0,
  new_leads: 0, contacted_leads: 0, qualified_leads: 0, converted_leads: 0, lost_leads: 0,
  hot_leads: 0, warm_leads: 0, cold_leads: 0, unassigned_temperature_leads: 0,
};

const ADMIN_IDENTITY = 'auth-admin-001|admin|ADMIN001';
const REP_IDENTITY = 'auth-rep-001|sales_rep|REP001';

function setAuthorized(): void {
  __setTransportOnline(true);
  setAuthModeState('online');
}

function setTransportDown(): void {
  __setTransportOnline(false);
  setAuthModeState('online');
}

function setAuthOffline(): void {
  __setTransportOnline(true);
  setAuthModeState('offline-restored');
}

// ─── Main test runner ────────────────────────────────────────────────────────

async function main(): Promise<void> {

  // ═══ Section 1: isValidCount (strict validation primitive) ═════════════════

  console.log('\n--- isValidCount ---');

  assert(isValidCount(0), 'isValidCount(0) = true');
  assert(isValidCount(100), 'isValidCount(100) = true');
  assert(isValidCount('42'), 'isValidCount("42") = true');
  assert(!isValidCount(null), 'isValidCount(null) = false');
  assert(!isValidCount(undefined), 'isValidCount(undefined) = false');
  assert(!isValidCount(-1), 'isValidCount(-1) = false');
  assert(!isValidCount(10.5), 'isValidCount(10.5) = false');
  assert(!isValidCount(NaN), 'isValidCount(NaN) = false');
  assert(!isValidCount(Infinity), 'isValidCount(Infinity) = false');
  assert(!isValidCount(''), 'isValidCount("") = false');
  assert(!isValidCount('abc'), 'isValidCount("abc") = false');
  assert(!isValidCount(Number.MAX_SAFE_INTEGER + 1), 'isValidCount(unsafe) = false');
  assert(!isValidCount({}), 'isValidCount({}) = false');
  assert(!isValidCount([]), 'isValidCount([]) = false');

  // ═══ Section 2: parseMetricsResponse (strict response validation) ══════════

  console.log('\n--- parseMetricsResponse ---');

  console.log('TEST: valid object response');
  {
    const result = parseMetricsResponse(VALID_METRICS);
    assert(result !== null, 'non-null for valid object');
    assert(result?.total_leads === 100, 'total_leads = 100');
  }

  console.log('TEST: valid array response');
  {
    const result = parseMetricsResponse([VALID_METRICS]);
    assert(result !== null, 'non-null for valid array');
    assert(result?.total_leads === 100, 'total_leads = 100');
  }

  console.log('TEST: valid all-zero response');
  {
    const result = parseMetricsResponse(ZERO_METRICS);
    assert(result !== null, 'non-null for all zeros');
    assert(result?.total_leads === 0, 'total_leads = 0');
  }

  console.log('TEST: null → null');
  assert(parseMetricsResponse(null) === null, 'null for null input');

  console.log('TEST: empty array → null');
  assert(parseMetricsResponse([]) === null, 'null for empty array');

  console.log('TEST: missing field → null');
  {
    const partial = { ...VALID_METRICS, hot_leads: undefined };
    assert(parseMetricsResponse(partial) === null, 'null for missing field');
  }

  console.log('TEST: null field → null');
  {
    const withNull = { ...VALID_METRICS, total_leads: null };
    assert(parseMetricsResponse(withNull) === null, 'null for null field');
  }

  console.log('TEST: negative value → null');
  {
    const withNeg = { ...VALID_METRICS, total_leads: -1 };
    assert(parseMetricsResponse(withNeg) === null, 'null for negative');
  }

  console.log('TEST: fractional value → null');
  {
    const withFrac = { ...VALID_METRICS, total_leads: 10.5 };
    assert(parseMetricsResponse(withFrac) === null, 'null for fractional');
  }

  console.log('TEST: NaN → null');
  {
    const withNaN = { ...VALID_METRICS, total_leads: NaN };
    assert(parseMetricsResponse(withNaN) === null, 'null for NaN');
  }

  console.log('TEST: Infinity → null');
  {
    const withInf = { ...VALID_METRICS, total_leads: Infinity };
    assert(parseMetricsResponse(withInf) === null, 'null for Infinity');
  }

  console.log('TEST: empty object → null');
  assert(parseMetricsResponse({}) === null, 'null for empty object');

  console.log('TEST: numeric string values accepted');
  {
    const strMetrics: Record<string, unknown> = {};
    for (const k of Object.keys(VALID_METRICS)) {
      strMetrics[k] = String(VALID_METRICS[k as keyof typeof VALID_METRICS]);
    }
    const result = parseMetricsResponse(strMetrics);
    assert(result !== null, 'non-null for numeric strings');
    assert(result?.total_leads === 100, 'total_leads = 100 from string');
  }

  console.log('TEST: unsafe integer → null');
  {
    const withUnsafe = { ...VALID_METRICS, total_leads: Number.MAX_SAFE_INTEGER + 1 };
    assert(parseMetricsResponse(withUnsafe) === null, 'null for unsafe integer');
  }

  // ═══ Section 3: getTodayIso ════════════════════════════════════════════════

  console.log('\n--- getTodayIso ---');

  console.log('TEST: local midnight ISO');
  {
    const now = new Date(2026, 9, 14, 15, 30, 0);
    const iso = getTodayIso(now);
    const midnight = new Date(2026, 9, 14, 0, 0, 0);
    assert(new Date(iso).getTime() === midnight.getTime(), 'equals local midnight');
  }

  // ═══ Section 4: identityKey ════════════════════════════════════════════════

  console.log('\n--- identityKey ---');

  assert(identityKey({ authUserId: 'a1', role: 'admin', rep_code: 'ADMIN' }) === 'a1|admin|ADMIN', 'admin identity');
  assert(identityKey({ authUserId: 'r1', role: 'sales_rep', rep_code: 'REP' }) === 'r1|sales_rep|REP', 'rep identity');
  assert(identityKey(null) === null, 'null user → null');
  assert(identityKey({ authUserId: '', role: 'admin', rep_code: 'A' }) === null, 'missing authUserId → null');
  assert(identityKey({ authUserId: 'a', role: '', rep_code: 'A' }) === null, 'missing role → null');
  assert(identityKey({ authUserId: 'a', role: 'sales_rep', rep_code: '' }) === null, 'rep missing rep_code → null');

  // ═══ Section 5: isAuthorized (dual gate) ═══════════════════════════════════

  console.log('\n--- isAuthorized (dual gate) ---');

  __setTransportOnline(true); setAuthModeState('online');
  assert(isAuthorized() === true, 'transport up + online → authorized');

  __setTransportOnline(false); setAuthModeState('online');
  assert(isAuthorized() === false, 'transport down + online → NOT authorized');

  __setTransportOnline(true); setAuthModeState('offline-restored');
  assert(isAuthorized() === false, 'transport up + offline-restored → NOT authorized');

  __setTransportOnline(true); setAuthModeState('unauthenticated');
  assert(isAuthorized() === false, 'transport up + unauthenticated → NOT authorized');

  __setTransportOnline(false); setAuthModeState('offline-restored');
  assert(isAuthorized() === false, 'both down → NOT authorized');

  // ═══ Section 6: DashboardMetricsLoader — success path ══════════════════════

  console.log('\n--- Loader: success path ---');

  console.log('TEST: admin authorized → success with data');
  {
    setAuthorized();
    __setRpcHandler(async () => ({ data: VALID_METRICS, error: null }));
    const loader = new DashboardMetricsLoader();
    const result = await loader.load(ADMIN_IDENTITY);
    assert(result.kind === 'success', 'kind = success');
    assert((result as { data: DashboardData }).data.total_leads === 100, 'total_leads = 100');
    loader.unmount();
    __resetRpcHandler();
  }

  console.log('TEST: rep authorized → success with data');
  {
    setAuthorized();
    __setRpcHandler(async () => ({ data: VALID_METRICS, error: null }));
    const loader = new DashboardMetricsLoader();
    const result = await loader.load(REP_IDENTITY);
    assert(result.kind === 'success', 'kind = success');
    assert((result as { data: DashboardData }).data.total_leads === 100, 'total_leads = 100');
    loader.unmount();
    __resetRpcHandler();
  }

  console.log('TEST: valid all-zero → success (not error)');
  {
    setAuthorized();
    __setRpcHandler(async () => ({ data: ZERO_METRICS, error: null }));
    const loader = new DashboardMetricsLoader();
    const result = await loader.load(ADMIN_IDENTITY);
    assert(result.kind === 'success', 'kind = success for zeros');
    assert((result as { data: DashboardData }).data.total_leads === 0, 'total_leads = 0');
    loader.unmount();
    __resetRpcHandler();
  }

  // ═══ Section 7: Loader — missing/invalid identity ══════════════════════════

  console.log('\n--- Loader: missing/invalid identity ---');

  console.log('TEST: null identity → sign-in required error');
  {
    setAuthorized();
    let rpcCalled = false;
    __setRpcHandler(async () => { rpcCalled = true; return { data: VALID_METRICS, error: null }; });
    const loader = new DashboardMetricsLoader();
    const result = await loader.load(null);
    assert(result.kind === 'error', 'kind = error');
    assert((result as { message: string }).message === ERR_SIGN_IN, 'message = sign-in required');
    assert(!rpcCalled, 'RPC never called');
    loader.unmount();
    __resetRpcHandler();
  }

  // ═══ Section 8: Loader — transport/auth gate ═══════════════════════════════

  console.log('\n--- Loader: transport/auth gate ---');

  console.log('TEST: transport down → waiting error, no RPC');
  {
    setTransportDown();
    let rpcCalled = false;
    __setRpcHandler(async () => { rpcCalled = true; return { data: VALID_METRICS, error: null }; });
    const loader = new DashboardMetricsLoader();
    const result = await loader.load(ADMIN_IDENTITY);
    assert(result.kind === 'error', 'kind = error');
    assert((result as { message: string }).message === ERR_WAITING, 'message = waiting');
    assert(!rpcCalled, 'RPC never called when transport down');
    loader.unmount();
    __resetRpcHandler();
  }

  console.log('TEST: auth offline-restored → waiting error, no RPC');
  {
    setAuthOffline();
    let rpcCalled = false;
    __setRpcHandler(async () => { rpcCalled = true; return { data: VALID_METRICS, error: null }; });
    const loader = new DashboardMetricsLoader();
    const result = await loader.load(ADMIN_IDENTITY);
    assert(result.kind === 'error', 'kind = error');
    assert((result as { message: string }).message === ERR_WAITING, 'message = waiting');
    assert(!rpcCalled, 'RPC never called when offline-restored');
    loader.unmount();
    __resetRpcHandler();
  }

  // ═══ Section 9: Loader — RPC errors ════════════════════════════════════════

  console.log('\n--- Loader: RPC errors ---');

  console.log('TEST: RPC returns error → unavailable');
  {
    setAuthorized();
    __setRpcHandler(async () => ({
      data: null,
      error: { message: 'function get_dashboard_metrics does not exist', code: '42883' },
    }));
    const loader = new DashboardMetricsLoader();
    const result = await loader.load(ADMIN_IDENTITY);
    assert(result.kind === 'error', 'kind = error');
    assert((result as { message: string }).message === ERR_UNAVAILABLE, 'message = unavailable');
    loader.unmount();
    __resetRpcHandler();
  }

  console.log('TEST: RPC throws → unavailable (try/catch)');
  {
    setAuthorized();
    __setRpcHandler(async () => { throw new Error('network failure'); });
    const loader = new DashboardMetricsLoader();
    const result = await loader.load(ADMIN_IDENTITY);
    assert(result.kind === 'error', 'kind = error after throw');
    assert((result as { message: string }).message === ERR_UNAVAILABLE, 'message = unavailable');
    loader.unmount();
    __resetRpcHandler();
  }

  console.log('TEST: RPC error does NOT become zero-as-success');
  {
    setAuthorized();
    __setRpcHandler(async () => ({ data: null, error: { message: 'permission denied' } }));
    const loader = new DashboardMetricsLoader();
    const result = await loader.load(ADMIN_IDENTITY);
    assert(result.kind !== 'success', 'NOT success');
    assert(result.kind === 'error', 'kind = error');
    loader.unmount();
    __resetRpcHandler();
  }

  // ═══ Section 10: Loader — malformed results ════════════════════════════════

  console.log('\n--- Loader: malformed results ---');

  console.log('TEST: empty object → unavailable');
  {
    setAuthorized();
    __setRpcHandler(async () => ({ data: {}, error: null }));
    const loader = new DashboardMetricsLoader();
    const result = await loader.load(ADMIN_IDENTITY);
    assert(result.kind === 'error', 'kind = error for empty object');
    assert((result as { message: string }).message === ERR_UNAVAILABLE, 'message = unavailable');
    loader.unmount();
    __resetRpcHandler();
  }

  console.log('TEST: null data, null error → unavailable');
  {
    setAuthorized();
    __setRpcHandler(async () => ({ data: null, error: null }));
    const loader = new DashboardMetricsLoader();
    const result = await loader.load(ADMIN_IDENTITY);
    assert(result.kind === 'error', 'kind = error for null/null');
    loader.unmount();
    __resetRpcHandler();
  }

  console.log('TEST: negative count → unavailable');
  {
    setAuthorized();
    __setRpcHandler(async () => ({ data: { ...VALID_METRICS, total_leads: -5 }, error: null }));
    const loader = new DashboardMetricsLoader();
    const result = await loader.load(ADMIN_IDENTITY);
    assert(result.kind === 'error', 'kind = error for negative');
    loader.unmount();
    __resetRpcHandler();
  }

  console.log('TEST: missing field → unavailable');
  {
    setAuthorized();
    __setRpcHandler(async () => ({ data: { ...VALID_METRICS, hot_leads: undefined }, error: null }));
    const loader = new DashboardMetricsLoader();
    const result = await loader.load(ADMIN_IDENTITY);
    assert(result.kind === 'error', 'kind = error for missing field');
    loader.unmount();
    __resetRpcHandler();
  }

  // ═══ Section 11: Loader — stale-response guard (identity change) ═══════════

  console.log('\n--- Loader: stale-response guard ---');

  console.log('TEST: identity change during in-flight → stale');
  {
    setAuthorized();
    const resolvers: Array<(v: { data: unknown; error: unknown }) => void> = [];
    __setRpcHandler(async () => new Promise(resolve => { resolvers.push(resolve); }));

    const loader = new DashboardMetricsLoader();
    const firstPromise = loader.load(ADMIN_IDENTITY);
    await flushPromises();

    // Invalidate with a new identity before the first resolves.
    loader.invalidate();
    const secondPromise = loader.load(REP_IDENTITY);
    await flushPromises();

    // Resolve both pending RPC calls.
    resolvers.forEach(r => r({ data: VALID_METRICS, error: null }));
    const [firstResult, secondResult] = await Promise.all([firstPromise, secondPromise]);

    // The first should be stale (generation was invalidated).
    assert(firstResult.kind === 'stale', 'first result is stale after identity change');
    // The second should succeed (it's the latest generation).
    assert(secondResult.kind === 'success', 'second result succeeds after identity change');
    loader.unmount();
    __resetRpcHandler();
  }

  console.log('TEST: unmount during in-flight → stale');
  {
    setAuthorized();
    __setRpcHandler(async () => new Promise(resolve => {
      setTimeout(() => resolve({ data: VALID_METRICS, error: null }), 50);
    }));
    const loader = new DashboardMetricsLoader();
    const promise = loader.load(ADMIN_IDENTITY);
    loader.unmount();
    const result = await promise;
    assert(result.kind === 'stale', 'result is stale after unmount');
    __resetRpcHandler();
  }

  console.log('TEST: auth loss during in-flight → stale or waiting, not success');
  {
    setAuthorized();
    const resolvers: Array<(v: { data: unknown; error: unknown }) => void> = [];
    __setRpcHandler(async () => new Promise(resolve => { resolvers.push(resolve); }));

    const loader = new DashboardMetricsLoader();
    const promise = loader.load(ADMIN_IDENTITY);
    await flushPromises();

    // Auth is lost while the request is in flight.
    setAuthModeState('unauthenticated');

    resolvers.forEach(r => r({ data: VALID_METRICS, error: null }));
    const result = await promise;
    assert(result.kind !== 'success', 'NOT success after auth loss');
    assert(result.kind === 'stale' || (result.kind === 'error' && (result as { message: string }).message === ERR_WAITING),
      'stale or waiting after auth loss');
    loader.unmount();
    __resetRpcHandler();
  }

  // ═══ Section 12: Loader — overlapping requests ═════════════════════════════

  console.log('\n--- Loader: overlapping requests ---');

  console.log('TEST: overlapping requests — later invalidates earlier');
  {
    setAuthorized();
    let callCount = 0;
    __setRpcHandler(async () => {
      callCount++;
      return { data: { ...VALID_METRICS, total_leads: callCount * 100 }, error: null };
    });

    const loader = new DashboardMetricsLoader();
    const first = loader.load(ADMIN_IDENTITY);
    const second = loader.load(ADMIN_IDENTITY);
    const [firstResult, secondResult] = await Promise.all([first, second]);
    // The second call increments generation, so the first should be stale.
    assert(firstResult.kind === 'stale', 'first is stale');
    assert(secondResult.kind === 'success', 'second succeeds');
    assert((secondResult as { data: DashboardData }).data.total_leads === 200, 'second has total_leads = 200');
    loader.unmount();
    __resetRpcHandler();
  }

  // ═══ Section 13: Loader — reconnect resume ═════════════════════════════════

  console.log('\n--- Loader: reconnect resume ---');

  console.log('TEST: offline → online → success');
  {
    setTransportDown();
    __setRpcHandler(async () => ({ data: VALID_METRICS, error: null }));
    const loader = new DashboardMetricsLoader();

    // First call while offline → waiting error.
    const offlineResult = await loader.load(ADMIN_IDENTITY);
    assert(offlineResult.kind === 'error', 'offline → error');
    assert((offlineResult as { message: string }).message === ERR_WAITING, 'offline → waiting');

    // Now go online.
    setAuthorized();
    const onlineResult = await loader.load(ADMIN_IDENTITY);
    assert(onlineResult.kind === 'success', 'online → success');
    assert((onlineResult as { data: DashboardData }).data.total_leads === 100, 'online → total_leads = 100');
    loader.unmount();
    __resetRpcHandler();
  }

  console.log('TEST: auth offline-restored → online → success');
  {
    setAuthOffline();
    __setRpcHandler(async () => ({ data: VALID_METRICS, error: null }));
    const loader = new DashboardMetricsLoader();

    const offlineResult = await loader.load(ADMIN_IDENTITY);
    assert(offlineResult.kind === 'error', 'offline-restored → error');

    setAuthorized();
    const onlineResult = await loader.load(ADMIN_IDENTITY);
    assert(onlineResult.kind === 'success', 'online after offline-restored → success');
    loader.unmount();
    __resetRpcHandler();
  }

  // ═══ Section 14: Loader — post-publish authorization re-check ═══════════════

  console.log('\n--- Loader: post-publish re-check ---');

  console.log('TEST: transport goes down during in-flight → waiting, not success');
  {
    setAuthorized();
    const resolvers: Array<(v: { data: unknown; error: unknown }) => void> = [];
    __setRpcHandler(async () => new Promise(resolve => { resolvers.push(resolve); }));

    const loader = new DashboardMetricsLoader();
    const promise = loader.load(ADMIN_IDENTITY);
    await flushPromises();

    // Transport goes down while waiting for RPC.
    setTransportDown();
    resolvers.forEach(r => r({ data: VALID_METRICS, error: null }));
    const result = await promise;
    assert(result.kind !== 'success', 'NOT success after transport down');
    assert(result.kind === 'stale' || (result.kind === 'error' && (result as { message: string }).message === ERR_WAITING),
      'stale or waiting after transport down during in-flight');
    loader.unmount();
    __resetRpcHandler();
  }

  // ═══ Section 15: EMPTY_DASHBOARD constant ═══════════════════════════════════

  console.log('\n--- EMPTY_DASHBOARD ---');

  assert(EMPTY_DASHBOARD.total_leads === 0, 'total_leads = 0');
  assert(Object.values(EMPTY_DASHBOARD).every(v => v === 0), 'all fields are 0');

  // ═══ Summary ═══════════════════════════════════════════════════════════════

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);

  if (failed > 0) process.exitCode = 1;
}

main().catch(err => {
  console.error('Test runner crashed:', err);
  process.exitCode = 1;
});
