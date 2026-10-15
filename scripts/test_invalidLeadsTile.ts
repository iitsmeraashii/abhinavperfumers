// Focused tests for the "Invalid Leads" dashboard attention tile.
//
// Uses the production InvalidLeadsLoader and deriveInvalidLeadsTileState
// from invalidLeadsLoader.ts to verify:
//   - Count query uses head:true/count:exact (no row downloads)
//   - system_status = 'INVALID_LEAD' filter is applied
//   - Admin scope: no client-side rep filter (RLS handles access)
//   - Rep scope: sales_rep_code filter applied server-side
//   - Zero count displays as success(0), not error or hidden
//   - Null/error counts never display as success
//   - Offline/auth-restricted states show unavailable
//   - Stale results after invalidate/identity-change are discarded
//   - Navigation enabled only on success, retry only on error

import {
  InvalidLeadsLoader,
  deriveInvalidLeadsTileState,
  ERR_INVALID_SIGN_IN,
  ERR_INVALID_WAITING,
  ERR_INVALID_UNAVAILABLE,
  type InvalidLeadsCountUser,
} from '../src/invalidLeadsLoader';
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

const adminUser: InvalidLeadsCountUser = { rep_code: '', role: 'admin', authUserId: 'auth-admin-1' };
const repUser: InvalidLeadsCountUser = { rep_code: 'REP01', role: 'sales_rep', authUserId: 'auth-rep-1' };

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

// ─── A. Count query uses head:true/count:exact, no row downloads ────────────

function test_count_query_uses_head_and_exact() {
  let capturedOpts: Record<string, unknown> | undefined;
  let capturedSelectArg = '';

  __setFromHandler(async (_table, selectArg, selectOpts, _filters) => {
    capturedSelectArg = selectArg;
    capturedOpts = selectOpts;
    return { count: 5, error: null, data: null };
  });
  setupOnline();

  const loader = new InvalidLeadsLoader();
  return Promise.resolve(loader.load('admin|admin|', adminUser)).then((res) => {
    assert(res.kind === 'success', `A: result should be success, got ${res.kind}`);
    assert(capturedOpts?.head === true, 'A: select opts must have head:true');
    assert(capturedOpts?.count === 'exact', 'A: select opts must have count:exact');
    assert(capturedSelectArg === 'id', `A: select arg should be 'id', got '${capturedSelectArg}'`);

    __resetFromHandler();
  });
}

// ─── B. system_status = 'INVALID_LEAD' filter is applied ─────────────────────

function test_system_status_filter_applied() {
  let capturedFilters: FilterEntry[] = [];

  __setFromHandler(async (_table, _selectArg, _selectOpts, filters) => {
    capturedFilters = filters;
    return { count: 3, error: null, data: null };
  });
  setupOnline();

  const loader = new InvalidLeadsLoader();
  return Promise.resolve(loader.load('admin|admin|', adminUser)).then((res) => {
    assert(res.kind === 'success', `B: result should be success, got ${res.kind}`);
    const statusFilter = capturedFilters.find(f => f.method === 'eq' && f.column === 'system_status' && f.value === 'INVALID_LEAD');
    assert(!!statusFilter, 'B: must filter by system_status=INVALID_LEAD');

    __resetFromHandler();
  });
}

// ─── C. Admin scope: no client-side rep filter ───────────────────────────────

function test_admin_no_rep_filter() {
  let capturedFilters: FilterEntry[] = [];

  __setFromHandler(async (_table, _selectArg, _selectOpts, filters) => {
    capturedFilters = filters;
    return { count: 10, error: null, data: null };
  });
  setupOnline();

  const loader = new InvalidLeadsLoader();
  return Promise.resolve(loader.load('admin|admin|', adminUser)).then((res) => {
    assert(res.kind === 'success', `C: result should be success, got ${res.kind}`);
    const repFilter = capturedFilters.find(f => f.column === 'sales_rep_code');
    assert(!repFilter, 'C: admin query must NOT have a client-side rep filter');
    assert(capturedFilters.length === 1, `C: admin should have only system_status filter, got ${capturedFilters.length}`);

    __resetFromHandler();
  });
}

// ─── D. Rep scope: sales_rep_code filter applied server-side ─────────────────

function test_rep_has_rep_filter() {
  let capturedFilters: FilterEntry[] = [];

  __setFromHandler(async (_table, _selectArg, _selectOpts, filters) => {
    capturedFilters = filters;
    return { count: 2, error: null, data: null };
  });
  setupOnline();

  const loader = new InvalidLeadsLoader();
  return Promise.resolve(loader.load('rep|sales_rep|REP01', repUser)).then((res) => {
    assert(res.kind === 'success', `D: result should be success, got ${res.kind}`);
    const repFilter = capturedFilters.find(f => f.method === 'eq' && f.column === 'sales_rep_code' && f.value === 'REP01');
    assert(!!repFilter, 'D: rep query must have sales_rep_code=REP01 filter');
    const statusFilter = capturedFilters.find(f => f.column === 'system_status' && f.value === 'INVALID_LEAD');
    assert(!!statusFilter, 'D: rep query must also have system_status filter');
    assert(capturedFilters.length === 2, `D: rep should have 2 filters, got ${capturedFilters.length}`);

    __resetFromHandler();
  });
}

// ─── E. Positive count displays as success with navigation ───────────────────

function test_positive_count_is_success() {
  __setFromHandler(async () => ({ count: 7, error: null, data: null }));
  setupOnline();

  const loader = new InvalidLeadsLoader();
  return Promise.resolve(loader.load('admin|admin|', adminUser)).then((res) => {
    assert(res.kind === 'success', `E: result should be success, got ${res.kind}`);
    if (res.kind === 'success') {
      assert(res.count === 7, `E: count should be 7, got ${res.count}`);
    }

    const tile = deriveInvalidLeadsTileState(
      false, false, false, 7,
      'admin|admin|', 'admin|admin|',
    );
    assert(tile !== null, 'E: tile should not be null');
    assert(tile!.phase === 'success', `E: phase should be success, got ${tile!.phase}`);
    assert(tile!.canNavigate === true, 'E: canNavigate should be true for success');
    assert(tile!.canRetry === false, 'E: canRetry should be false for success');

    __resetFromHandler();
  });
}

// ─── F. Zero count displays as success(0), not error or hidden ───────────────

function test_zero_count_is_success() {
  __setFromHandler(async () => ({ count: 0, error: null, data: null }));
  setupOnline();

  const loader = new InvalidLeadsLoader();
  return Promise.resolve(loader.load('admin|admin|', adminUser)).then((res) => {
    assert(res.kind === 'success', `F: zero should be success, got ${res.kind}`);
    if (res.kind === 'success') {
      assert(res.count === 0, `F: count should be 0, got ${res.count}`);
    }

    const tile = deriveInvalidLeadsTileState(
      false, false, false, 0,
      'admin|admin|', 'admin|admin|',
    );
    assert(tile !== null, 'F: tile should not be null');
    assert(tile!.phase === 'success', `F: phase should be success for zero, got ${tile!.phase}`);
    assert(tile!.count === 0, `F: tile count should be 0, got ${tile!.count}`);
    assert(tile!.canNavigate === true, 'F: canNavigate should be true for success(0)');

    __resetFromHandler();
  });
}

// ─── G. Null count never displays as success ─────────────────────────────────

function test_null_count_never_success() {
  __setFromHandler(async () => ({ count: null, error: null, data: null }));
  setupOnline();

  const loader = new InvalidLeadsLoader();
  return Promise.resolve(loader.load('admin|admin|', adminUser)).then((res) => {
    assert(res.kind === 'error', `G: null count should be error, got ${res.kind}`);

    const tile = deriveInvalidLeadsTileState(
      false, false, false, null,
      'admin|admin|', 'admin|admin|',
    );
    assert(tile !== null, 'G: tile should not be null');
    assert(tile!.phase !== 'success', `G: null count must not be success, got ${tile!.phase}`);
    assert(tile!.phase === 'error', `G: phase should be error, got ${tile!.phase}`);
    assert(tile!.canRetry === true, 'G: canRetry should be true');

    __resetFromHandler();
  });
}

// ─── H. Query error never displays as success ────────────────────────────────

function test_query_error_never_success() {
  __setFromHandler(async () => ({ count: null, error: { message: 'relation not found' }, data: null }));
  setupOnline();

  const loader = new InvalidLeadsLoader();
  return Promise.resolve(loader.load('admin|admin|', adminUser)).then((res) => {
    assert(res.kind === 'error', `H: query error should be error, got ${res.kind}`);
    if (res.kind === 'error') {
      assert(res.message === ERR_INVALID_UNAVAILABLE, `H: should be ERR_INVALID_UNAVAILABLE, got ${res.message}`);
    }

    __resetFromHandler();
  });
}

// ─── I. Offline shows unavailable, not zero or error ─────────────────────────

function test_offline_shows_unavailable() {
  setupOffline();
  const loader = new InvalidLeadsLoader();

  return Promise.resolve(loader.load('admin|admin|', adminUser)).then((res) => {
    assert(res.kind === 'error', `I: offline should be error, got ${res.kind}`);
    if (res.kind === 'error') {
      assert(res.message === ERR_INVALID_WAITING, `I: should be ERR_INVALID_WAITING, got ${res.message}`);
    }

    const tile = deriveInvalidLeadsTileState(
      false, false, true, null,
      'admin|admin|', 'admin|admin|',
    );
    assert(tile !== null, 'I: tile should not be null');
    assert(tile!.phase === 'unavailable', `I: phase should be unavailable, got ${tile!.phase}`);
    assert(tile!.canNavigate === false, 'I: canNavigate should be false');
    assert(tile!.canRetry === false, 'I: canRetry should be false for unavailable');

    setupOnline();
  });
}

// ─── J. Offline-restored auth shows unavailable ──────────────────────────────

function test_offline_restored_auth_unavailable() {
  setupOfflineRestored();
  const loader = new InvalidLeadsLoader();

  return Promise.resolve(loader.load('admin|admin|', adminUser)).then((res) => {
    assert(res.kind === 'error', `J: offline-restored should be error, got ${res.kind}`);
    if (res.kind === 'error') {
      assert(res.message === ERR_INVALID_WAITING, `J: should be ERR_INVALID_WAITING, got ${res.message}`);
    }

    setupOnline();
  });
}

// ─── K. No identity: tile hidden (null) ──────────────────────────────────────

function test_no_identity_tile_hidden() {
  const tile = deriveInvalidLeadsTileState(
    true, false, false, null, null, null,
  );
  assert(tile === null, 'K: tile should be null when currentIdentity is null');
}

// ─── L. Loading visible for valid identity ───────────────────────────────────

function test_loading_visible_for_valid_identity() {
  const tile = deriveInvalidLeadsTileState(
    true, false, false, null,
    null, 'admin|admin|',
  );
  assert(tile !== null, 'L: tile should not be null during loading with valid identity');
  assert(tile!.phase === 'loading', `L: phase should be loading, got ${tile!.phase}`);
  assert(tile!.canNavigate === false, 'L: canNavigate should be false during loading');
  assert(tile!.canRetry === false, 'L: canRetry should be false during loading');
}

// ─── M. Stale after invalidate ───────────────────────────────────────────────

function test_stale_after_invalidate() {
  __setFromHandler(async () => ({ count: 42, error: null, data: null }));
  setupOnline();

  const loader = new InvalidLeadsLoader();
  const promise = loader.load('admin|admin|', adminUser);
  loader.invalidate();

  return Promise.resolve(promise).then((res) => {
    assert(res.kind === 'stale', `M: result after invalidate should be stale, got ${res.kind}`);
    __resetFromHandler();
  });
}

// ─── N. Stale after identity change ──────────────────────────────────────────

function test_stale_after_identity_change() {
  __setFromHandler(async () => ({ count: 42, error: null, data: null }));
  setupOnline();

  const loader = new InvalidLeadsLoader();
  const firstPromise = loader.load('admin|admin|', adminUser);
  const secondPromise = loader.load('rep|sales_rep|REP01', repUser);

  return Promise.all([
    Promise.resolve(firstPromise),
    Promise.resolve(secondPromise),
  ]).then(([first, second]) => {
    assert(first.kind === 'stale',
      `N: first result should be stale after identity change, got ${first.kind}`);
    assert(second.kind === 'success',
      `N: second result should be success, got ${second.kind}`);

    __resetFromHandler();
  });
}

// ─── O. Identity change shows loading (not previous count) ───────────────────

function test_identity_change_shows_loading() {
  const tile = deriveInvalidLeadsTileState(
    false, false, false, 99,
    'old-user|sales_rep|OLD',
    'new-user|sales_rep|NEW',
  );
  assert(tile !== null, 'O: tile should not be null (new identity is valid)');
  assert(tile!.phase === 'loading', `O: phase should be loading during identity transition, got ${tile!.phase}`);
  assert(tile!.count === 0, `O: count should be 0 during transition, got ${tile!.count}`);
  assert(tile!.canNavigate === false, 'O: canNavigate should be false during loading');
}

// ─── P. Loaded tile navigates; error tile retries; unavailable does neither ──

function test_loaded_tile_navigates() {
  const tile = deriveInvalidLeadsTileState(
    false, false, false, 5,
    'rep|sales_rep|REP01', 'rep|sales_rep|REP01',
  );
  assert(tile !== null, 'P-nav: tile should not be null');
  assert(tile!.phase === 'success', `P-nav: phase should be success, got ${tile!.phase}`);
  assert(tile!.canNavigate === true, 'P-nav: canNavigate should be true');
  assert(tile!.canRetry === false, 'P-nav: canRetry should be false');
}

function test_error_tile_retries() {
  const tile = deriveInvalidLeadsTileState(
    false, true, false, null,
    'rep|sales_rep|REP01', 'rep|sales_rep|REP01',
  );
  assert(tile !== null, 'P-retry: tile should not be null');
  assert(tile!.phase === 'error', `P-retry: phase should be error, got ${tile!.phase}`);
  assert(tile!.canNavigate === false, 'P-retry: canNavigate should be false');
  assert(tile!.canRetry === true, 'P-retry: canRetry should be true');
}

function test_unavailable_tile_does_neither() {
  const tile = deriveInvalidLeadsTileState(
    false, false, true, null,
    'rep|sales_rep|REP01', 'rep|sales_rep|REP01',
  );
  assert(tile !== null, 'P-unavail: tile should not be null');
  assert(tile!.phase === 'unavailable', `P-unavail: phase should be unavailable, got ${tile!.phase}`);
  assert(tile!.canNavigate === false, 'P-unavail: canNavigate should be false');
  assert(tile!.canRetry === false, 'P-unavail: canRetry should be false');
}

// ─── Q. Loading overrides stale error/unavailable ────────────────────────────

function test_loading_overrides_stale_error() {
  const tile = deriveInvalidLeadsTileState(
    true, true, false, null,
    'admin|admin|', 'admin|admin|',
  );
  assert(tile !== null, 'Q: tile should not be null');
  assert(tile!.phase === 'loading', `Q: phase should be loading (overrides error), got ${tile!.phase}`);
}

function test_loading_overrides_stale_unavailable() {
  const tile = deriveInvalidLeadsTileState(
    true, false, true, null,
    'admin|admin|', 'admin|admin|',
  );
  assert(tile !== null, 'Q-unavail: tile should not be null');
  assert(tile!.phase === 'loading', `Q-unavail: phase should be loading (overrides unavailable), got ${tile!.phase}`);
}

// ─── R. Zero is distinct from error/unavailable ──────────────────────────────

function test_zero_distinct_from_error() {
  const zeroTile = deriveInvalidLeadsTileState(
    false, false, false, 0,
    'admin|admin|', 'admin|admin|',
  );
  const errorTile = deriveInvalidLeadsTileState(
    false, true, false, null,
    'admin|admin|', 'admin|admin|',
  );
  const unavailTile = deriveInvalidLeadsTileState(
    false, false, true, null,
    'admin|admin|', 'admin|admin|',
  );

  assert(zeroTile!.phase === 'success', 'R: zero should be success');
  assert(errorTile!.phase === 'error', 'R: error should be error');
  assert(unavailTile!.phase === 'unavailable', 'R: unavailable should be unavailable');
  assert(zeroTile!.phase !== errorTile!.phase, 'R: zero and error must differ');
  assert(zeroTile!.phase !== unavailTile!.phase, 'R: zero and unavailable must differ');
}

// ─── S. Repeated loader calls (header-wiring is manually verified) ───────────

function test_repeated_loader_calls() {
  let fromCallCount = 0;
  __setFromHandler(async () => {
    fromCallCount++;
    return { count: 3, error: null, data: null };
  });
  setupOnline();
  const loader = new InvalidLeadsLoader();

  return Promise.resolve(loader.load('admin|admin|', adminUser)).then(() => {
    assert(fromCallCount === 1, `S: first load should call handler once, got ${fromCallCount}`);
    return Promise.resolve(loader.load('admin|admin|', adminUser)).then(() => {
      assert(fromCallCount === 2,
        `S: second call should invoke handler again (total 2), got ${fromCallCount}`);
      __resetFromHandler();
    });
  });
}

// ─── Run all tests ───────────────────────────────────────────────────────────

async function runAll() {
  await test_count_query_uses_head_and_exact();
  await test_system_status_filter_applied();
  await test_admin_no_rep_filter();
  await test_rep_has_rep_filter();
  await test_positive_count_is_success();
  await test_zero_count_is_success();
  await test_null_count_never_success();
  await test_query_error_never_success();
  await test_offline_shows_unavailable();
  await test_offline_restored_auth_unavailable();
  test_no_identity_tile_hidden();
  test_loading_visible_for_valid_identity();
  await test_stale_after_invalidate();
  await test_stale_after_identity_change();
  test_identity_change_shows_loading();
  test_loaded_tile_navigates();
  test_error_tile_retries();
  test_unavailable_tile_does_neither();
  test_loading_overrides_stale_error();
  test_loading_overrides_stale_unavailable();
  test_zero_distinct_from_error();
  await test_repeated_loader_calls();

  console.log(`Invalid Leads tile tests: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

runAll();
