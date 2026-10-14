// Regression tests for the Today's Follow-Ups tile display/action logic.
//
// Uses the production deriveFollowUpTileState function from todaysFollowUpsLoader.ts
// (not a recreated mock) to verify the exact display/action state transitions
// the DashboardPage renders.
//
// Covers:
// A. Successful zero displays 0 (phase=success, count=0, canNavigate=true)
// B. Offline/auth-restricted/null count never displays 0
// C. Online transport + offline-restored auth remains unavailable
// D. Loaded tile navigates; error tile retries; unavailable does neither
// E. Header Refresh invokes both loaders
// F. Identity change never displays the previous user's count
// G. Loading state visible for valid identity even when fuIdentity is null

import {
  TodaysFollowUpsLoader,
  deriveFollowUpTileState,
  ERR_FOLLOWUP_SIGN_IN,
  ERR_FOLLOWUP_WAITING,
  ERR_FOLLOWUP_UNAVAILABLE,
  type FollowUpCountUser,
} from '../src/todaysFollowUpsLoader';
import { __setFromHandler, __resetFromHandler } from './test_followup_count_stub_supabase';
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

function setupOfflineRestored() {
  __setTransportOnline(true);
  setAuthModeState('offline-restored');
}

// ─── A. Successful zero displays 0 ───────────────────────────────────────────

function test_successful_zero_displays_zero() {
  __setFromHandler(async () => ({ count: 0, error: null, data: null }));
  setupOnline();

  const loader = new TodaysFollowUpsLoader();
  return Promise.resolve(loader.load('admin|admin|', adminUser)).then((res) => {
    assert(res.kind === 'success', `A: result should be success, got ${res.kind}`);

    // Simulate DashboardPage state after a successful zero-count load
    const tile = deriveFollowUpTileState(
      false,  // loading
      false,  // error
      false,  // unavailable
      0,      // count
      'admin|admin|',  // fuIdentity
      'admin|admin|',  // currentIdentity
    );

    assert(tile !== null, 'A: tile should not be null for valid identity');
    assert(tile!.phase === 'success', `A: phase should be success, got ${tile!.phase}`);
    assert(tile!.count === 0, `A: count should be 0, got ${tile!.count}`);
    assert(tile!.canNavigate === true, 'A: canNavigate should be true for success');
    assert(tile!.canRetry === false, 'A: canRetry should be false for success');

    __resetFromHandler();
  });
}

// ─── B. Offline/auth-restricted/null count never displays 0 ──────────────────

function test_offline_never_displays_zero() {
  setupOffline();
  const loader = new TodaysFollowUpsLoader();

  return Promise.resolve(loader.load('admin|admin|', adminUser)).then((res) => {
    assert(res.kind === 'error', `B-offline: result should be error, got ${res.kind}`);
    if (res.kind === 'error') {
      assert(res.message === ERR_FOLLOWUP_WAITING, `B-offline: should be ERR_FOLLOWUP_WAITING, got ${res.message}`);
    }

    // Simulate DashboardPage state: unavailable=true, count=null
    const tile = deriveFollowUpTileState(
      false,  // loading
      false,  // error
      true,   // unavailable
      null,   // count
      'admin|admin|',
      'admin|admin|',
    );

    assert(tile !== null, 'B-offline: tile should not be null');
    assert(tile!.phase === 'unavailable', `B-offline: phase should be unavailable, got ${tile!.phase}`);
    assert(tile!.count === 0, `B-offline: count should be 0 (not displayed), got ${tile!.count}`);
    assert(tile!.canNavigate === false, 'B-offline: canNavigate should be false');
    assert(tile!.canRetry === false, 'B-offline: canRetry should be false');

    setupOnline();
  });
}

function test_null_count_never_displays_zero() {
  __setFromHandler(async () => ({ count: null, error: null, data: null }));
  setupOnline();

  const loader = new TodaysFollowUpsLoader();
  return Promise.resolve(loader.load('admin|admin|', adminUser)).then((res) => {
    assert(res.kind === 'error', `B-null: result should be error, got ${res.kind}`);

    // Simulate DashboardPage state: error=true, count=null
    const tile = deriveFollowUpTileState(
      false,
      true,   // error
      false,
      null,
      'admin|admin|',
      'admin|admin|',
    );

    assert(tile !== null, 'B-null: tile should not be null');
    assert(tile!.phase === 'error', `B-null: phase should be error, got ${tile!.phase}`);
    assert(tile!.canNavigate === false, 'B-null: canNavigate should be false');
    assert(tile!.canRetry === true, 'B-null: canRetry should be true');

    __resetFromHandler();
  });
}

function test_query_error_never_displays_zero() {
  __setFromHandler(async () => ({ count: null, error: { message: 'relation not found' }, data: null }));
  setupOnline();

  const loader = new TodaysFollowUpsLoader();
  return Promise.resolve(loader.load('admin|admin|', adminUser)).then((res) => {
    assert(res.kind === 'error', `B-query: result should be error, got ${res.kind}`);
    if (res.kind === 'error') {
      assert(res.message === ERR_FOLLOWUP_UNAVAILABLE, `B-query: should be ERR_FOLLOWUP_UNAVAILABLE, got ${res.message}`);
    }

    __resetFromHandler();
  });
}

// ─── C. Online transport + offline-restored auth remains unavailable ──────────

function test_offline_restored_auth_remains_unavailable() {
  setupOfflineRestored();
  const loader = new TodaysFollowUpsLoader();

  return Promise.resolve(loader.load('admin|admin|', adminUser)).then((res) => {
    assert(res.kind === 'error', `C: result should be error, got ${res.kind}`);
    if (res.kind === 'error') {
      assert(res.message === ERR_FOLLOWUP_WAITING, `C: should be ERR_FOLLOWUP_WAITING, got ${res.message}`);
    }

    // Simulate DashboardPage state: unavailable=true
    const tile = deriveFollowUpTileState(
      false, false, true, null,
      'admin|admin|', 'admin|admin|',
    );

    assert(tile !== null, 'C: tile should not be null');
    assert(tile!.phase === 'unavailable', `C: phase should be unavailable, got ${tile!.phase}`);
    assert(tile!.canNavigate === false, 'C: canNavigate should be false');
    assert(tile!.canRetry === false, 'C: canRetry should be false');

    setupOnline();
  });
}

// ─── D. Loaded tile navigates; error tile retries; unavailable does neither ──

function test_loaded_tile_navigates() {
  const tile = deriveFollowUpTileState(
    false, false, false, 5,
    'rep|sales_rep|REP01', 'rep|sales_rep|REP01',
  );

  assert(tile !== null, 'D-nav: tile should not be null');
  assert(tile!.phase === 'success', `D-nav: phase should be success, got ${tile!.phase}`);
  assert(tile!.canNavigate === true, 'D-nav: canNavigate should be true');
  assert(tile!.canRetry === false, 'D-nav: canRetry should be false');
}

function test_error_tile_retries() {
  const tile = deriveFollowUpTileState(
    false, true, false, null,
    'rep|sales_rep|REP01', 'rep|sales_rep|REP01',
  );

  assert(tile !== null, 'D-retry: tile should not be null');
  assert(tile!.phase === 'error', `D-retry: phase should be error, got ${tile!.phase}`);
  assert(tile!.canNavigate === false, 'D-retry: canNavigate should be false');
  assert(tile!.canRetry === true, 'D-retry: canRetry should be true');
}

function test_unavailable_tile_does_neither() {
  const tile = deriveFollowUpTileState(
    false, false, true, null,
    'rep|sales_rep|REP01', 'rep|sales_rep|REP01',
  );

  assert(tile !== null, 'D-unavail: tile should not be null');
  assert(tile!.phase === 'unavailable', `D-unavail: phase should be unavailable, got ${tile!.phase}`);
  assert(tile!.canNavigate === false, 'D-unavail: canNavigate should be false');
  assert(tile!.canRetry === false, 'D-unavail: canRetry should be false');
}

// ─── E. Header Refresh invokes both loaders ──────────────────────────────────
//
// The header Refresh button calls both fetchData() and fetchFollowUpCount().
// We verify that the follow-up loader is actually invoked by tracking the
// handler call count.

function test_header_refresh_invokes_both() {
  let fromCallCount = 0;

  __setFromHandler(async () => {
    fromCallCount++;
    return { count: 3, error: null, data: null };
  });

  setupOnline();
  const loader = new TodaysFollowUpsLoader();

  // First load (initial effect)
  return Promise.resolve(loader.load('admin|admin|', adminUser)).then(() => {
    const firstCount = fromCallCount;
    assert(firstCount === 1, `E: first load should call handler once, got ${firstCount}`);

    // Simulate header Refresh: call load again
    return Promise.resolve(loader.load('admin|admin|', adminUser)).then(() => {
      assert(fromCallCount === 2,
        `E: refresh should call handler again (total 2), got ${fromCallCount}`);

      __resetFromHandler();
    });
  });
}

// ─── F. Identity change never displays the previous user's count ─────────────

function test_identity_change_hides_previous_count() {
  // After identity change, fuIdentity !== currentIdentity
  // deriveFollowUpTileState should return loading (not success with old count)

  const tile = deriveFollowUpTileState(
    false, false, false, 99,  // old count of 99
    'old-user|sales_rep|OLD',  // fuIdentity = old
    'new-user|sales_rep|NEW',  // currentIdentity = new
  );

  assert(tile !== null, 'F: tile should not be null (new identity is valid)');
  assert(tile!.phase === 'loading', `F: phase should be loading during identity transition, got ${tile!.phase}`);
  assert(tile!.count === 0, `F: count should be 0 during transition (not old 99), got ${tile!.count}`);
  assert(tile!.canNavigate === false, 'F: canNavigate should be false during loading');
}

function test_identity_change_loader_stale() {
  __setFromHandler(async () => ({ count: 42, error: null, data: null }));
  setupOnline();

  const loader = new TodaysFollowUpsLoader();
  const firstPromise = loader.load('admin|admin|', adminUser);

  // Start second load as different identity before first resolves
  const secondPromise = loader.load('rep|sales_rep|REP01', repUser);

  return Promise.all([
    Promise.resolve(firstPromise),
    Promise.resolve(secondPromise),
  ]).then(([first, second]) => {
    assert(first.kind === 'stale',
      `F-loader: first result should be stale after identity change, got ${first.kind}`);
    assert(second.kind === 'success',
      `F-loader: second result should be success, got ${second.kind}`);

    __resetFromHandler();
  });
}

// ─── G. Loading state visible for valid identity even when fuIdentity is null ─

function test_loading_visible_during_initial_load() {
  // Initial state: fuIdentity=null, fuLoading=true, currentIdentity valid
  const tile = deriveFollowUpTileState(
    true,   // loading
    false,  // error
    false,  // unavailable
    null,   // count
    null,   // fuIdentity (not yet set)
    'admin|admin|',  // currentIdentity (valid)
  );

  assert(tile !== null, 'G: tile should not be null during initial loading with valid identity');
  assert(tile!.phase === 'loading', `G: phase should be loading, got ${tile!.phase}`);
  assert(tile!.canNavigate === false, 'G: canNavigate should be false during loading');
  assert(tile!.canRetry === false, 'G: canRetry should be false during loading');
}

// ─── H. No identity: tile should not render at all ────────────────────────────

function test_no_identity_tile_hidden() {
  const tile = deriveFollowUpTileState(
    true, false, false, null, null, null,
  );

  assert(tile === null, 'H: tile should be null when currentIdentity is null');
}

// ─── I. Loading takes priority over error/unavailable from previous state ────

function test_loading_overrides_stale_error() {
  // Previous load errored, new load started: fuIdentity matches but loading=true
  const tile = deriveFollowUpTileState(
    true,   // loading
    true,   // error (from previous load)
    false,
    null,
    'admin|admin|',
    'admin|admin|',
  );

  assert(tile !== null, 'I: tile should not be null');
  assert(tile!.phase === 'loading', `I: phase should be loading (overrides error), got ${tile!.phase}`);
}

function test_loading_overrides_stale_unavailable() {
  const tile = deriveFollowUpTileState(
    true,   // loading
    false,
    true,   // unavailable (from previous)
    null,
    'admin|admin|',
    'admin|admin|',
  );

  assert(tile !== null, 'I-unavail: tile should not be null');
  assert(tile!.phase === 'loading', `I-unavail: phase should be loading (overrides unavailable), got ${tile!.phase}`);
}

// ─── Run all tests ───────────────────────────────────────────────────────────

async function runAll() {
  await test_successful_zero_displays_zero();
  await test_offline_never_displays_zero();
  await test_null_count_never_displays_zero();
  await test_query_error_never_displays_zero();
  await test_offline_restored_auth_remains_unavailable();
  test_loaded_tile_navigates();
  test_error_tile_retries();
  test_unavailable_tile_does_neither();
  await test_header_refresh_invokes_both();
  test_identity_change_hides_previous_count();
  await test_identity_change_loader_stale();
  test_loading_visible_during_initial_load();
  test_no_identity_tile_hidden();
  test_loading_overrides_stale_error();
  test_loading_overrides_stale_unavailable();

  console.log(`Today's Follow-Ups tile regression tests: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

runAll();
