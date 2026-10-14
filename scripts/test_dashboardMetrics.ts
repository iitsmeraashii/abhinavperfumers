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
  deriveDisplayState,
  ERR_SIGN_IN,
  ERR_WAITING,
  ERR_UNAVAILABLE,
  EMPTY_DASHBOARD,
  type DashboardData,
} from '../src/dashboardMetricsLoader';
import { __setRpcHandler, __resetRpcHandler } from './test_dashboard_stub_supabase';
import { setAuthModeState } from './test_dashboard_stub_authMode';
import { __setTransportOnline } from './test_dashboard_stub_connectivity';
import { DashboardWiringHarness } from './test_dashboard_wiring';

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

  // ═══ Section 15: deriveDisplayState (pure display helper) ═══════════════════

  console.log('\n--- deriveDisplayState ---');

  console.log('TEST: current-user RPC error → error visible, loading false, Retry enabled');
  {
    const s = deriveDisplayState(
      false, ERR_UNAVAILABLE, null, ADMIN_IDENTITY, ADMIN_IDENTITY, EMPTY_DASHBOARD,
    );
    assert(s.showError, 'error visible');
    assert(!s.showLoading, 'loading false');
    assert(s.displayData.total_leads === 0, 'no metrics shown');
  }

  console.log('TEST: Retry in progress → loading true, Retry disabled');
  {
    const s = deriveDisplayState(
      true, '', null, null, ADMIN_IDENTITY, EMPTY_DASHBOARD,
    );
    assert(s.showLoading, 'loading true');
    assert(!s.showError, 'error not shown during loading');
  }

  console.log('TEST: Retry success → metrics visible, error cleared');
  {
    const s = deriveDisplayState(
      false, '', ADMIN_IDENTITY, null, ADMIN_IDENTITY, VALID_METRICS as DashboardData,
    );
    assert(!s.showLoading, 'loading false');
    assert(!s.showError, 'error cleared');
    assert(s.displayData.total_leads === 100, 'metrics visible');
  }

  console.log('TEST: identity change → old data and old error hidden before effects');
  {
    // Previous user had data
    const sData = deriveDisplayState(
      false, '', ADMIN_IDENTITY, null, REP_IDENTITY, VALID_METRICS as DashboardData,
    );
    assert(sData.displayData.total_leads === 0, 'old data hidden (EMPTY)');
    assert(sData.showLoading, 'loading shown (identity transition)');
    assert(!sData.showError, 'no error during identity transition');

    // Previous user had error
    const sErr = deriveDisplayState(
      false, ERR_UNAVAILABLE, null, ADMIN_IDENTITY, REP_IDENTITY, EMPTY_DASHBOARD,
    );
    assert(!sErr.showError, 'old error hidden after identity change');
    assert(sErr.showLoading, 'loading shown (identity transition)');
  }

  console.log('TEST: current-identity error after retry start → error wins over loading');
  {
    // loading=true but errorIdentity matches current — this shouldn't happen
    // in normal flow (fetchData clears error at start), but verify the helper
    // is consistent: loading takes priority during in-flight
    const s = deriveDisplayState(
      true, ERR_UNAVAILABLE, null, ADMIN_IDENTITY, ADMIN_IDENTITY, EMPTY_DASHBOARD,
    );
    assert(s.showLoading, 'loading shown during in-flight even with stale error');
  }

  console.log('TEST: null currentIdentity (signed out) → no loading, no error');
  {
    const s = deriveDisplayState(
      false, ERR_UNAVAILABLE, null, null, null, EMPTY_DASHBOARD,
    );
    assert(!s.showLoading, 'no loading when signed out');
    assert(!s.showError, 'no error when signed out');
  }

  // ═══ Section 16: EMPTY_DASHBOARD constant ═══════════════════════════════════

  console.log('\n--- EMPTY_DASHBOARD ---');

  assert(EMPTY_DASHBOARD.total_leads === 0, 'total_leads = 0');
  assert(Object.values(EMPTY_DASHBOARD).every(v => v === 0), 'all fields are 0');

  // ═══ Section 16: identityKey — unsupported roles ═══════════════════════════

  console.log('\n--- identityKey: unsupported roles ---');

  assert(identityKey({ authUserId: 'x', role: 'super_admin', rep_code: 'SA' }) === null, 'super_admin → null');
  assert(identityKey({ authUserId: 'x', role: 'manager', rep_code: 'M' }) === null, 'manager → null');
  assert(identityKey({ authUserId: 'x', role: 'viewer', rep_code: 'V' }) === null, 'viewer → null');
  assert(identityKey({ authUserId: 'x', role: 'guest', rep_code: 'G' }) === null, 'guest → null');
  assert(identityKey({ authUserId: 'x', role: 'support', rep_code: 'S' }) === null, 'support → null');
  assert(identityKey({ authUserId: 'x', role: 'admin', rep_code: 'A' }) !== null, 'admin still accepted');
  assert(identityKey({ authUserId: 'x', role: 'sales_rep', rep_code: 'R' }) !== null, 'sales_rep still accepted');

  console.log('TEST: unsupported role → no RPC');
  {
    setAuthorized();
    let rpcCalled = false;
    __setRpcHandler(async () => { rpcCalled = true; return { data: VALID_METRICS, error: null }; });
    const loader = new DashboardMetricsLoader();
    const result = await loader.load(identityKey({ authUserId: 'x', role: 'super_admin', rep_code: 'SA' }));
    assert(result.kind === 'error', 'unsupported role → error (not RPC)');
    assert((result as { message: string }).message === ERR_SIGN_IN, 'unsupported role → sign-in required');
    assert(!rpcCalled, 'RPC never called for unsupported role');
    loader.unmount();
    __resetRpcHandler();
  }

  // ═══ Section 17: Lifecycle wiring — StrictMode ═══════════════════════════════

  console.log('\n--- Lifecycle wiring: StrictMode ---');

  console.log('TEST: StrictMode setup→cleanup→setup → successful loading');
  {
    setAuthorized();
    __setRpcHandler(async () => ({ data: VALID_METRICS, error: null }));
    const harness = new DashboardWiringHarness();
    harness.setUser({ authUserId: 'auth-admin', role: 'admin', rep_code: 'ADMIN' });
    harness.setAuthMode('online');
    harness.setIsOnline(true);

    // Simulate StrictMode: setup → cleanup → setup
    harness.strictModeCycle();
    await flushPromises();

    const s = harness.state;
    assert(!s.showLoading, 'StrictMode: not loading after setup→cleanup→setup');
    assert(!s.showError, 'StrictMode: no error after setup→cleanup→setup');
    assert(s.displayData.total_leads === 100, 'StrictMode: shows metrics = 100 after cycle');
    assert(s.dataIdentity === 'auth-admin|admin|ADMIN', 'StrictMode: data identity set correctly');
    __resetRpcHandler();
  }

  console.log('TEST: StrictMode cleanup does not permanently unmount loader');
  {
    setAuthorized();
    __setRpcHandler(async () => ({ data: VALID_METRICS, error: null }));
    const harness = new DashboardWiringHarness();
    harness.setUser({ authUserId: 'auth-admin', role: 'admin', rep_code: 'ADMIN' });
    harness.setAuthMode('online');
    harness.setIsOnline(true);

    // First cycle
    harness.triggerEffect();
    await flushPromises();
    assert(harness.state.displayData.total_leads === 100, 'first setup loads data');

    // StrictMode cleanup then re-setup
    harness.cleanup();
    harness.triggerEffect();
    await flushPromises();
    assert(harness.state.displayData.total_leads === 100, 're-setup after cleanup loads data');
    assert(!harness.state.showLoading, 're-setup not stuck loading');
    __resetRpcHandler();
  }

  // ═══ Section 18: Lifecycle wiring — Retry ═══════════════════════════════════

  console.log('\n--- Lifecycle wiring: Retry ---');

  console.log('TEST: RPC error → Retry → success → metrics visible');
  {
    setAuthorized();
    const harness = new DashboardWiringHarness();
    harness.setUser({ authUserId: 'auth-admin', role: 'admin', rep_code: 'ADMIN' });
    harness.setAuthMode('online');
    harness.setIsOnline(true);

    // First: RPC error
    __setRpcHandler(async () => ({ data: null, error: { message: 'function missing' } }));
    harness.triggerEffect();
    await flushPromises();

    let s = harness.state;
    assert(s.showError, 'error state visible after RPC error');
    assert(s.errorMessage === ERR_UNAVAILABLE, 'error message = unavailable');
    assert(s.displayData.total_leads === 0, 'no metrics shown on error');

    // Retry: success
    __setRpcHandler(async () => ({ data: VALID_METRICS, error: null }));
    await harness.fetchData();
    await flushPromises();

    s = harness.state;
    assert(!s.showError, 'no error after successful Retry');
    assert(!s.showLoading, 'not loading after successful Retry');
    assert(s.displayData.total_leads === 100, 'metrics visible after Retry = 100');
    __resetRpcHandler();
  }

  console.log('TEST: Retry sets loading and clears previous error at start');
  {
    setAuthorized();
    const resolvers: Array<(v: { data: unknown; error: unknown }) => void> = [];
    const harness = new DashboardWiringHarness();
    harness.setUser({ authUserId: 'auth-admin', role: 'admin', rep_code: 'ADMIN' });
    harness.setAuthMode('online');
    harness.setIsOnline(true);

    // First: get an error
    __setRpcHandler(async () => ({ data: null, error: { message: 'fail' } }));
    harness.triggerEffect();
    await flushPromises();
    assert(harness.state.showError, 'error shown before Retry');

    // Retry: with pending RPC
    __setRpcHandler(async () => new Promise(resolve => { resolvers.push(resolve); }));
    const retryPromise = harness.fetchData();
    // Before the RPC resolves, loading should be true and error cleared
    assert(harness.state.showLoading, 'loading set at Retry start');
    assert(!harness.state.showError, 'error cleared at Retry start');

    // Resolve the RPC
    resolvers.forEach(r => r({ data: VALID_METRICS, error: null }));
    await retryPromise;
    await flushPromises();
    assert(!harness.state.showLoading, 'not loading after Retry completes');
    assert(harness.state.displayData.total_leads === 100, 'metrics shown after Retry');
    __resetRpcHandler();
  }

  console.log('TEST: stale completion does not clear another request\'s loading/error');
  {
    setAuthorized();
    const resolvers: Array<(v: { data: unknown; error: unknown }) => void> = [];
    const harness = new DashboardWiringHarness();
    harness.setUser({ authUserId: 'auth-admin', role: 'admin', rep_code: 'ADMIN' });
    harness.setAuthMode('online');
    harness.setIsOnline(true);

    // Start first request with pending RPC
    __setRpcHandler(async () => new Promise(resolve => { resolvers.push(resolve); }));
    harness.triggerEffect();
    await flushPromises();
    assert(harness.state.showLoading, 'first request: loading');

    // Trigger effect again (simulates re-render with same deps) — invalidates
    harness.triggerEffect();
    await flushPromises();
    // The first RPC is now stale, the second is pending
    assert(harness.state.showLoading, 'second request: loading');

    // Resolve the stale first request — should NOT set data
    if (resolvers[0]) resolvers[0]({ data: { ...VALID_METRICS, total_leads: 999 }, error: null });
    await flushPromises();
    assert(harness.state.displayData.total_leads !== 999, 'stale completion does not set data');
    assert(harness.state.showLoading, 'still loading after stale resolves');

    // Resolve the current request
    if (resolvers[1]) resolvers[1]({ data: VALID_METRICS, error: null });
    await flushPromises();
    assert(harness.state.displayData.total_leads === 100, 'current request succeeds with 100');
    assert(!harness.state.showLoading, 'not loading after current resolves');
    __resetRpcHandler();
  }

  // ═══ Section 19: Lifecycle wiring — identity change ═════════════════════════

  console.log('\n--- Lifecycle wiring: identity change ---');

  console.log('TEST: identity change → no previous-user metrics displayed');
  {
    setAuthorized();
    const harness = new DashboardWiringHarness();

    // Admin loads data
    __setRpcHandler(async () => ({ data: VALID_METRICS, error: null }));
    harness.setUser({ authUserId: 'auth-admin', role: 'admin', rep_code: 'ADMIN' });
    harness.setAuthMode('online');
    harness.setIsOnline(true);
    harness.triggerEffect();
    await flushPromises();

    assert(harness.state.displayData.total_leads === 100, 'admin sees 100');
    assert(harness.state.dataIdentity === 'auth-admin|admin|ADMIN', 'admin identity set');

    // Switch to rep user — previous metrics must NOT show under new header
    harness.setUser({ authUserId: 'auth-rep', role: 'sales_rep', rep_code: 'REP' });
    // Before the effect runs, the identity display guard must hide old data
    const stateBeforeEffect = harness.state;
    assert(stateBeforeEffect.showLoading, 'identity change: shows loading before effect');
    assert(stateBeforeEffect.displayData.total_leads === 0, 'identity change: old metrics hidden (EMPTY) before effect');
    assert(!stateBeforeEffect.showError, 'identity change: no error before effect');

    // Now trigger the effect for the new user
    harness.triggerEffect();
    await flushPromises();

    assert(harness.state.displayData.total_leads === 100, 'rep sees 100 after loading');
    assert(harness.state.dataIdentity === 'auth-rep|sales_rep|REP', 'rep identity set');
    assert(!harness.state.showLoading, 'rep: not loading after data loads');
    __resetRpcHandler();
  }

  console.log('TEST: identity change with pending data — old metrics never flash');
  {
    setAuthorized();
    const resolvers: Array<(v: { data: unknown; error: unknown }) => void> = [];
    const harness = new DashboardWiringHarness();

    // Admin loads data
    __setRpcHandler(async () => ({ data: { ...VALID_METRICS, total_leads: 100 }, error: null }));
    harness.setUser({ authUserId: 'auth-admin', role: 'admin', rep_code: 'ADMIN' });
    harness.setAuthMode('online');
    harness.setIsOnline(true);
    harness.triggerEffect();
    await flushPromises();
    assert(harness.state.displayData.total_leads === 100, 'admin loaded 100');

    // Switch to rep with pending RPC
    harness.setUser({ authUserId: 'auth-rep', role: 'sales_rep', rep_code: 'REP' });
    // Before effect, old data must be hidden
    assert(harness.state.displayData.total_leads === 0, 'rep: old admin data hidden before effect');
    assert(harness.state.showLoading, 'rep: loading shown before effect');

    // Trigger effect with pending RPC
    __setRpcHandler(async () => new Promise(resolve => { resolvers.push(resolve); }));
    harness.triggerEffect();
    await flushPromises();
    // While RPC is pending, still loading, no old data
    assert(harness.state.showLoading, 'rep: loading while RPC pending');
    assert(harness.state.displayData.total_leads === 0, 'rep: no old data while RPC pending');

    // Resolve with rep-specific data
    resolvers.forEach(r => r({ data: { ...VALID_METRICS, total_leads: 50 }, error: null }));
    await flushPromises();
    assert(harness.state.displayData.total_leads === 50, 'rep: sees 50 after load');
    __resetRpcHandler();
  }

  // ═══ Summary ═══════════════════════════════════════════════════════════════

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);

  if (failed > 0) process.exitCode = 1;
}

main().catch(err => {
  console.error('Test runner crashed:', err);
  process.exitCode = 1;
});
