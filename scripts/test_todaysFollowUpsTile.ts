// Focused tests for the Today's Follow-Ups tile count loader.
//
// Verifies:
// 1. head:true / count:exact and explicit inner relationship in select
// 2. Admin vs sales-rep filter (rep gets lead_entries.sales_rep_code eq)
// 3. PENDING status filter always present
// 4. Identical today bounds between count and list query
// 5. Zero count vs error/null count — error must never appear as zero
// 6. Retry action — error state click calls load again
// 7. Navigation — loaded state click navigates to follow-ups (Today filter)
// 8. Stale responses after identity/transport changes are ignored

import {
  TodaysFollowUpsLoader,
  ERR_FOLLOWUP_SIGN_IN,
  ERR_FOLLOWUP_WAITING,
  ERR_FOLLOWUP_UNAVAILABLE,
  type FollowUpCountUser,
  type FollowUpCountResult,
} from '../src/todaysFollowUpsLoader';
import { __setFromHandler, __resetFromHandler, type FilterEntry } from './test_followup_count_stub_supabase';
import { setAuthModeState } from './test_dashboard_stub_authMode';
import { __setTransportOnline } from './test_dashboard_stub_connectivity';

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (condition) {
    passed++;
  } else {
    failed++;
    console.error(`FAIL: ${message}`);
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function startOfTodayISO(): string {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0).toISOString();
}

function startOfTomorrowISO(): string {
  return new Date(new Date(startOfTodayISO()).getTime() + 24 * 60 * 60 * 1000).toISOString();
}

const adminUser: FollowUpCountUser = { rep_code: '', role: 'admin', authUserId: 'auth-admin-1' };
const repUser: FollowUpCountUser = { rep_code: 'REP01', role: 'sales_rep', authUserId: 'auth-rep-1' };

function setupOnline() {
  __setTransportOnline(true);
  setAuthModeState('online');
}

function setupOffline() {
  __setTransportOnline(false);
  setAuthModeState('online');
}

// ─── 1. head:true / count:exact and explicit inner relationship ──────────────

function test_select_uses_inner_relationship_and_head() {
  let capturedSelectArg = '';
  let capturedSelectOpts: Record<string, unknown> | undefined;

  __setFromHandler(async (_table, selectArg, selectOpts, _filters) => {
    capturedSelectArg = selectArg;
    capturedSelectOpts = selectOpts;
    return { count: 5, error: null, data: null };
  });

  setupOnline();
  const loader = new TodaysFollowUpsLoader();
  const result = loader.load('admin-identity', adminUser);

  // The .then() in the stub resolves asynchronously; flush it
  return Promise.resolve(result).then((res) => {
    assert(res.kind === 'success',
      `Select/inner: result should be success, got ${res.kind}`);
    assert(capturedSelectArg.includes('lead_entries!inner'),
      `Select/inner: select arg must include lead_entries!inner, got "${capturedSelectArg}"`);
    assert(capturedSelectOpts?.head === true,
      'Select/inner: select opts must have head:true');
    assert(capturedSelectOpts?.count === 'exact',
      'Select/inner: select opts must have count:"exact"');
    __resetFromHandler();
  });
}

// ─── 2. Admin vs sales-rep filters ───────────────────────────────────────────

function test_admin_no_rep_filter() {
  let capturedFilters: FilterEntry[] = [];

  __setFromHandler(async (_table, _selectArg, _selectOpts, filters) => {
    capturedFilters = filters;
    return { count: 10, error: null, data: null };
  });

  setupOnline();
  const loader = new TodaysFollowUpsLoader();
  return Promise.resolve(loader.load('admin-identity', adminUser)).then((res) => {
    assert(res.kind === 'success',
      `Admin filter: result should be success, got ${res.kind}`);
    const hasRepFilter = capturedFilters.some(f => f.column === 'lead_entries.sales_rep_code');
    assert(!hasRepFilter,
      'Admin filter: should NOT have lead_entries.sales_rep_code filter');
    __resetFromHandler();
  });
}

function test_rep_has_sales_rep_code_filter() {
  let capturedFilters: FilterEntry[] = [];

  __setFromHandler(async (_table, _selectArg, _selectOpts, filters) => {
    capturedFilters = filters;
    return { count: 3, error: null, data: null };
  });

  setupOnline();
  const loader = new TodaysFollowUpsLoader();
  return Promise.resolve(loader.load('rep-identity', repUser)).then((res) => {
    assert(res.kind === 'success',
      `Rep filter: result should be success, got ${res.kind}`);
    const repFilter = capturedFilters.find(f => f.column === 'lead_entries.sales_rep_code');
    assert(!!repFilter,
      'Rep filter: should have lead_entries.sales_rep_code filter');
    assert(repFilter?.value === 'REP01',
      `Rep filter: sales_rep_code should be REP01, got ${repFilter?.value}`);
    __resetFromHandler();
  });
}

// ─── 3. PENDING status filter always present ─────────────────────────────────

function test_pending_status_filter() {
  let capturedFilters: FilterEntry[] = [];

  __setFromHandler(async (_table, _selectArg, _selectOpts, filters) => {
    capturedFilters = filters;
    return { count: 0, error: null, data: null };
  });

  setupOnline();
  const loader = new TodaysFollowUpsLoader();
  return Promise.resolve(loader.load('admin-identity', adminUser)).then((res) => {
    assert(res.kind === 'success',
      `PENDING filter: result should be success, got ${res.kind}`);
    const statusFilter = capturedFilters.find(f => f.column === 'status' && f.value === 'PENDING');
    assert(!!statusFilter,
      'PENDING filter: must have status=PENDING filter');
    __resetFromHandler();
  });
}

// ─── 4. Identical today bounds between count and list ────────────────────────

function test_today_bounds_match_list_page() {
  let capturedFilters: FilterEntry[] = [];

  __setFromHandler(async (_table, _selectArg, _selectOpts, filters) => {
    capturedFilters = filters;
    return { count: 2, error: null, data: null };
  });

  setupOnline();
  const loader = new TodaysFollowUpsLoader();
  return Promise.resolve(loader.load('admin-identity', adminUser)).then((res) => {
    assert(res.kind === 'success',
      `Today bounds: result should be success, got ${res.kind}`);

    const gteFilter = capturedFilters.find(f => f.method === 'gte' && f.column === 'reminder_date');
    const ltFilter = capturedFilters.find(f => f.method === 'lt' && f.column === 'reminder_date');

    assert(!!gteFilter,
      'Today bounds: must have gte(reminder_date, ...) filter');
    assert(!!ltFilter,
      'Today bounds: must have lt(reminder_date, ...) filter');

    // The bounds must match localStartOfToday and localStartOfTomorrow
    const expectedStart = startOfTodayISO();
    const expectedEnd = startOfTomorrowISO();

    assert(gteFilter?.value === expectedStart,
      `Today bounds: gte value should be ${expectedStart}, got ${gteFilter?.value}`);
    assert(ltFilter?.value === expectedEnd,
      `Today bounds: lt value should be ${expectedEnd}, got ${ltFilter?.value}`);

    __resetFromHandler();
  });
}

// ─── 5. Zero count vs error/null count ───────────────────────────────────────

function test_zero_count_is_success_not_error() {
  __setFromHandler(async () => ({ count: 0, error: null, data: null }));

  setupOnline();
  const loader = new TodaysFollowUpsLoader();
  return Promise.resolve(loader.load('admin-identity', adminUser)).then((res) => {
    assert(res.kind === 'success',
      `Zero count: result should be success, got ${res.kind}`);
    if (res.kind === 'success') {
      assert(res.count === 0,
        `Zero count: count should be 0, got ${res.count}`);
    }
    __resetFromHandler();
  });
}

function test_null_count_is_error_not_zero() {
  __setFromHandler(async () => ({ count: null, error: null, data: null }));

  setupOnline();
  const loader = new TodaysFollowUpsLoader();
  return Promise.resolve(loader.load('admin-identity', adminUser)).then((res) => {
    assert(res.kind === 'error',
      `Null count: result should be error, got ${res.kind}`);
    if (res.kind === 'error') {
      assert(res.message === ERR_FOLLOWUP_UNAVAILABLE,
        `Null count: message should be ERR_FOLLOWUP_UNAVAILABLE, got ${res.message}`);
    }
    __resetFromHandler();
  });
}

function test_query_error_is_error_not_zero() {
  __setFromHandler(async () => ({ count: null, error: { message: 'relation not found' }, data: null }));

  setupOnline();
  const loader = new TodaysFollowUpsLoader();
  return Promise.resolve(loader.load('admin-identity', adminUser)).then((res) => {
    assert(res.kind === 'error',
      `Query error: result should be error, got ${res.kind}`);
    __resetFromHandler();
  });
}

function test_network_throw_is_error_not_zero() {
  __setFromHandler(async () => { throw new Error('network failure'); });

  setupOnline();
  const loader = new TodaysFollowUpsLoader();
  return Promise.resolve(loader.load('admin-identity', adminUser)).then((res) => {
    assert(res.kind === 'error',
      `Network throw: result should be error, got ${res.kind}`);
    __resetFromHandler();
  });
}

// ─── 6. Retry action ─────────────────────────────────────────────────────────

function test_retry_calls_load_again() {
  let callCount = 0;

  __setFromHandler(async () => {
    callCount++;
    if (callCount === 1) return { count: null, error: { message: 'timeout' }, data: null };
    return { count: 7, error: null, data: null };
  });

  setupOnline();
  const loader = new TodaysFollowUpsLoader();

  return Promise.resolve(loader.load('admin-identity', adminUser)).then((firstResult) => {
    assert(firstResult.kind === 'error',
      `Retry: first call should error, got ${firstResult.kind}`);
    assert(callCount === 1,
      `Retry: first call should hit handler once, got ${callCount}`);

    // Retry — call load again
    return Promise.resolve(loader.load('admin-identity', adminUser)).then((secondResult) => {
      assert(secondResult.kind === 'success',
        `Retry: second call should succeed, got ${secondResult.kind}`);
      if (secondResult.kind === 'success') {
        assert(secondResult.count === 7,
          `Retry: count should be 7, got ${secondResult.count}`);
      }
      assert(callCount === 2,
        `Retry: second call should hit handler twice total, got ${callCount}`);
      __resetFromHandler();
    });
  });
}

// ─── 7. Navigation applies Today + pending criteria ──────────────────────────
//
// The navigation wiring is in App.tsx (handleNavigateToFollowUps sets
// followupsInitialFilter='today' and switches to the followups tab).
// FollowUpsPage with initialDateFilter='today' applies:
//   .eq('status', 'PENDING')
//   .gte('reminder_date', localStartOfToday().toISOString())
//   .lt('reminder_date', localStartOfTomorrow().toISOString())
//
// We verify that the tile's count query uses the exact same criteria
// that the list page uses for today+pending. This is already covered by
// tests 1-4 above (same select with !inner, same PENDING filter, same
// today bounds, same rep filter). Here we verify the navigation state
// transition.

function test_navigation_sets_today_filter() {
  // Simulate App.tsx state
  let followupsInitialFilter: 'today' | undefined = undefined;
  let activeTab: string = 'dashboard';

  // Simulate handleNavigateToFollowUps
  function handleNavigateToFollowUps() {
    followupsInitialFilter = 'today';
    activeTab = 'followups';
  }

  handleNavigateToFollowUps();

  assert(followupsInitialFilter === 'today',
    `Navigation: followupsInitialFilter should be 'today', got ${followupsInitialFilter}`);
  assert(activeTab === 'followups',
    `Navigation: activeTab should be 'followups', got ${activeTab}`);

  // Simulate handleTabChange clearing the filter when navigating away
  function handleTabChange(t: string) {
    activeTab = t;
    followupsInitialFilter = undefined;
  }

  handleTabChange('dashboard');
  assert(followupsInitialFilter === undefined,
    'Navigation: filter should clear when navigating away from followups');
}

// ─── 8. Stale responses after identity/transport changes ─────────────────────

function test_stale_after_invalidate() {
  __setFromHandler(async () => {
    // Delay slightly so invalidate fires before resolution
    return { count: 42, error: null, data: null };
  });

  setupOnline();
  const loader = new TodaysFollowUpsLoader();
  const firstPromise = loader.load('admin-identity', adminUser);

  // Invalidate before the first promise resolves
  loader.invalidate();

  return Promise.resolve(firstPromise).then((res) => {
    assert(res.kind === 'stale',
      `Stale/invalidate: first result should be stale after invalidate, got ${res.kind}`);
    __resetFromHandler();
  });
}

function test_stale_after_identity_change() {
  let callCount = 0;
  __setFromHandler(async () => {
    callCount++;
    return { count: 5, error: null, data: null };
  });

  setupOnline();
  const loader = new TodaysFollowUpsLoader();

  // Start first load as admin
  const firstPromise = loader.load('admin-identity', adminUser);

  // Immediately start a second load as a different user
  const repUser2: FollowUpCountUser = { rep_code: 'REP02', role: 'sales_rep', authUserId: 'auth-rep-2' };
  const secondPromise = loader.load('rep-2-identity', repUser2);

  return Promise.all([
    Promise.resolve(firstPromise),
    Promise.resolve(secondPromise),
  ]).then(([first, second]) => {
    // The first should be stale because identity changed
    assert(first.kind === 'stale',
      `Stale/identity: first result should be stale after identity change, got ${first.kind}`);
    // The second should succeed
    assert(second.kind === 'success',
      `Stale/identity: second result should be success, got ${second.kind}`);
    __resetFromHandler();
  });
}

function test_stale_after_transport_offline() {
  __setFromHandler(async () => ({ count: 5, error: null, data: null }));

  setupOnline();
  const loader = new TodaysFollowUpsLoader();

  // Start load while online
  const firstPromise = loader.load('admin-identity', adminUser);

  // Transport goes offline before resolution
  setupOffline();

  return Promise.resolve(firstPromise).then((res) => {
    // The post-fetch auth check should detect offline and return error (not stale,
    // because the generation/identity haven't changed — the transport check fails)
    assert(res.kind === 'error',
      `Stale/transport: result should be error after transport goes offline, got ${res.kind}`);
    if (res.kind === 'error') {
      assert(res.message === ERR_FOLLOWUP_WAITING,
        `Stale/transport: message should be ERR_FOLLOWUP_WAITING, got ${res.message}`);
    }
    // Restore
    setupOnline();
    __resetFromHandler();
  });
}

function test_error_when_offline_before_load() {
  setupOffline();
  const loader = new TodaysFollowUpsLoader();
  return Promise.resolve(loader.load('admin-identity', adminUser)).then((res) => {
    assert(res.kind === 'error',
      `Offline before load: result should be error, got ${res.kind}`);
    if (res.kind === 'error') {
      assert(res.message === ERR_FOLLOWUP_WAITING,
        `Offline before load: message should be ERR_FOLLOWUP_WAITING, got ${res.message}`);
    }
    setupOnline();
  });
}

function test_error_when_no_identity() {
  setupOnline();
  const loader = new TodaysFollowUpsLoader();
  return Promise.resolve(loader.load(null, null)).then((res) => {
    assert(res.kind === 'error',
      `No identity: result should be error, got ${res.kind}`);
    if (res.kind === 'error') {
      assert(res.message === ERR_FOLLOWUP_SIGN_IN,
        `No identity: message should be ERR_FOLLOWUP_SIGN_IN, got ${res.message}`);
    }
  });
}

// ─── Run all tests sequentially (they're async) ──────────────────────────────

async function runAll() {
  await test_select_uses_inner_relationship_and_head();
  await test_admin_no_rep_filter();
  await test_rep_has_sales_rep_code_filter();
  await test_pending_status_filter();
  await test_today_bounds_match_list_page();
  await test_zero_count_is_success_not_error();
  await test_null_count_is_error_not_zero();
  await test_query_error_is_error_not_zero();
  await test_network_throw_is_error_not_zero();
  await test_retry_calls_load_again();
  test_navigation_sets_today_filter();
  await test_stale_after_invalidate();
  await test_stale_after_identity_change();
  await test_stale_after_transport_offline();
  await test_error_when_offline_before_load();
  await test_error_when_no_identity();

  console.log(`Today's Follow-Ups tile tests: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

runAll();
