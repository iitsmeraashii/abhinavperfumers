const _g = globalThis;
if (!_g.localStorage) { const _s = {}; _g.localStorage = { getItem: (k) => _s[k] ?? null, setItem: (k, v) => { _s[k] = v; }, removeItem: (k) => { delete _s[k]; } }; }
if (!_g.navigator) _g.navigator = { onLine: true };
if (!_g.window) _g.window = _g;

// scripts/test_followup_count_stub_supabase.ts
var currentHandler = () => Promise.resolve({ count: null, error: { message: "no handler set" }, data: null });
function __setFromHandler(handler) {
  currentHandler = handler;
}
function __resetFromHandler() {
  currentHandler = () => Promise.resolve({ count: null, error: { message: "no handler set" }, data: null });
}
var rpcHandler = () => Promise.resolve({ data: null, error: { message: "no handler set" } });
var supabase = {
  rpc: (fn, args) => rpcHandler(fn, args ?? {}),
  from(table) {
    const filters = [];
    let selectArg = "";
    let selectOpts;
    const chain = {
      select(arg, opts) {
        selectArg = arg;
        selectOpts = opts;
        return chain;
      },
      eq(column, value) {
        filters.push({ method: "eq", column, value });
        return chain;
      },
      gte(column, value) {
        filters.push({ method: "gte", column, value });
        return chain;
      },
      lt(column, value) {
        filters.push({ method: "lt", column, value });
        return chain;
      },
      order() {
        return chain;
      },
      range() {
        return chain;
      },
      maybeSingle() {
        return Promise.resolve({ data: null, error: null });
      },
      then(resolve, reject) {
        return currentHandler(table, selectArg, selectOpts, filters).then(resolve, reject);
      }
    };
    return chain;
  },
  channel: () => ({ on: () => ({ subscribe: () => {
  } }) }),
  removeChannel: () => {
  }
};

// scripts/test_dashboard_stub_authMode.ts
var mode = "unauthenticated";
function setAuthModeState(m) {
  mode = m;
}
function isCloudSyncAllowed() {
  return mode === "online";
}

// scripts/test_dashboard_stub_connectivity.ts
var online = true;
var isTransportOnline = () => online;
function __setTransportOnline(value) {
  online = value;
}

// src/todaysFollowUpsLoader.ts
var ERR_FOLLOWUP_SIGN_IN = "Follow-up count unavailable: sign-in required.";
var ERR_FOLLOWUP_WAITING = "Follow-up count unavailable: waiting for connection.";
var ERR_FOLLOWUP_UNAVAILABLE = "Follow-up count unavailable. Tap to retry.";
function deriveFollowUpTileState(loading, error, unavailable, count, fuIdentity, currentIdentity) {
  if (!currentIdentity) return null;
  if (fuIdentity !== currentIdentity || loading) {
    return { phase: "loading", count: 0, canNavigate: false, canRetry: false };
  }
  if (unavailable) {
    return { phase: "unavailable", count: 0, canNavigate: false, canRetry: false };
  }
  if (error) {
    return { phase: "error", count: 0, canNavigate: false, canRetry: true };
  }
  if (count === null) {
    return { phase: "error", count: 0, canNavigate: false, canRetry: true };
  }
  return { phase: "success", count, canNavigate: true, canRetry: false };
}
function localStartOfToday() {
  const now = /* @__PURE__ */ new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
}
function localStartOfTomorrow() {
  return new Date(localStartOfToday().getTime() + 24 * 60 * 60 * 1e3);
}
var TodaysFollowUpsLoader = class {
  generation = 0;
  currentIdentity = null;
  mounted = true;
  invalidate() {
    this.generation++;
    this.currentIdentity = null;
  }
  unmount() {
    this.mounted = false;
    this.generation++;
  }
  async load(identity, user) {
    if (!this.mounted) return { kind: "stale" };
    if (!identity || !user) {
      return { kind: "error", message: ERR_FOLLOWUP_SIGN_IN };
    }
    if (!isTransportOnline() || !isCloudSyncAllowed()) {
      return { kind: "error", message: ERR_FOLLOWUP_WAITING };
    }
    const gen = ++this.generation;
    this.currentIdentity = identity;
    const startStr = localStartOfToday().toISOString();
    const endStr = localStartOfTomorrow().toISOString();
    let countVal = null;
    let queryErr = null;
    try {
      const q = supabase.from("lead_follow_ups").select("id, lead_entries!inner(sales_rep_code)", {
        count: "exact",
        head: true
      }).eq("status", "PENDING").gte("reminder_date", startStr).lt("reminder_date", endStr);
      if (user.role !== "admin" && user.rep_code) {
        q.eq("lead_entries.sales_rep_code", user.rep_code);
      }
      const { count, error } = await q;
      countVal = count;
      queryErr = error;
    } catch {
      queryErr = { message: "Network error" };
    }
    if (gen !== this.generation) return { kind: "stale" };
    if (this.currentIdentity !== identity) return { kind: "stale" };
    if (!this.mounted) return { kind: "stale" };
    if (!isTransportOnline() || !isCloudSyncAllowed()) {
      return { kind: "error", message: ERR_FOLLOWUP_WAITING };
    }
    if (queryErr) {
      return { kind: "error", message: ERR_FOLLOWUP_UNAVAILABLE };
    }
    if (countVal === null || countVal === void 0) {
      return { kind: "error", message: ERR_FOLLOWUP_UNAVAILABLE };
    }
    if (gen !== this.generation || !this.mounted) return { kind: "stale" };
    return { kind: "success", count: countVal };
  }
};

// scripts/test_followUpTileRegression.ts
var passed = 0;
var failed = 0;
function assert(condition, message) {
  if (condition) {
    passed++;
  } else {
    failed++;
    console.error(`FAIL: ${message}`);
  }
}
var adminUser = { rep_code: "", role: "admin", authUserId: "auth-admin-1" };
var repUser = { rep_code: "REP01", role: "sales_rep", authUserId: "auth-rep-1" };
function setupOnline() {
  __setTransportOnline(true);
  setAuthModeState("online");
}
function setupOffline() {
  __setTransportOnline(false);
  setAuthModeState("online");
}
function setupOfflineRestored() {
  __setTransportOnline(true);
  setAuthModeState("offline-restored");
}
function test_successful_zero_displays_zero() {
  __setFromHandler(async () => ({ count: 0, error: null, data: null }));
  setupOnline();
  const loader = new TodaysFollowUpsLoader();
  return Promise.resolve(loader.load("admin|admin|", adminUser)).then((res) => {
    assert(res.kind === "success", `A: result should be success, got ${res.kind}`);
    const tile = deriveFollowUpTileState(
      false,
      // loading
      false,
      // error
      false,
      // unavailable
      0,
      // count
      "admin|admin|",
      // fuIdentity
      "admin|admin|"
      // currentIdentity
    );
    assert(tile !== null, "A: tile should not be null for valid identity");
    assert(tile.phase === "success", `A: phase should be success, got ${tile.phase}`);
    assert(tile.count === 0, `A: count should be 0, got ${tile.count}`);
    assert(tile.canNavigate === true, "A: canNavigate should be true for success");
    assert(tile.canRetry === false, "A: canRetry should be false for success");
    __resetFromHandler();
  });
}
function test_offline_never_displays_zero() {
  setupOffline();
  const loader = new TodaysFollowUpsLoader();
  return Promise.resolve(loader.load("admin|admin|", adminUser)).then((res) => {
    assert(res.kind === "error", `B-offline: result should be error, got ${res.kind}`);
    if (res.kind === "error") {
      assert(res.message === ERR_FOLLOWUP_WAITING, `B-offline: should be ERR_FOLLOWUP_WAITING, got ${res.message}`);
    }
    const tile = deriveFollowUpTileState(
      false,
      // loading
      false,
      // error
      true,
      // unavailable
      null,
      // count
      "admin|admin|",
      "admin|admin|"
    );
    assert(tile !== null, "B-offline: tile should not be null");
    assert(tile.phase === "unavailable", `B-offline: phase should be unavailable, got ${tile.phase}`);
    assert(tile.count === 0, `B-offline: count should be 0 (not displayed), got ${tile.count}`);
    assert(tile.canNavigate === false, "B-offline: canNavigate should be false");
    assert(tile.canRetry === false, "B-offline: canRetry should be false");
    setupOnline();
  });
}
function test_null_count_never_displays_zero() {
  __setFromHandler(async () => ({ count: null, error: null, data: null }));
  setupOnline();
  const loader = new TodaysFollowUpsLoader();
  return Promise.resolve(loader.load("admin|admin|", adminUser)).then((res) => {
    assert(res.kind === "error", `B-null: result should be error, got ${res.kind}`);
    const tile = deriveFollowUpTileState(
      false,
      true,
      // error
      false,
      null,
      "admin|admin|",
      "admin|admin|"
    );
    assert(tile !== null, "B-null: tile should not be null");
    assert(tile.phase === "error", `B-null: phase should be error, got ${tile.phase}`);
    assert(tile.canNavigate === false, "B-null: canNavigate should be false");
    assert(tile.canRetry === true, "B-null: canRetry should be true");
    __resetFromHandler();
  });
}
function test_query_error_never_displays_zero() {
  __setFromHandler(async () => ({ count: null, error: { message: "relation not found" }, data: null }));
  setupOnline();
  const loader = new TodaysFollowUpsLoader();
  return Promise.resolve(loader.load("admin|admin|", adminUser)).then((res) => {
    assert(res.kind === "error", `B-query: result should be error, got ${res.kind}`);
    if (res.kind === "error") {
      assert(res.message === ERR_FOLLOWUP_UNAVAILABLE, `B-query: should be ERR_FOLLOWUP_UNAVAILABLE, got ${res.message}`);
    }
    __resetFromHandler();
  });
}
function test_null_count_no_error_returns_error_not_success() {
  const tile = deriveFollowUpTileState(
    false,
    // loading
    false,
    // error
    false,
    // unavailable
    null,
    // count
    "admin|admin|",
    // fuIdentity
    "admin|admin|"
    // currentIdentity
  );
  assert(tile !== null, "B2-null: tile should not be null for valid identity");
  assert(
    tile.phase !== "success",
    `B2-null: phase must not be success when count is null, got ${tile.phase}`
  );
  assert(
    tile.phase === "error",
    `B2-null: phase should be error for null count without error/unavailable, got ${tile.phase}`
  );
  assert(tile.canNavigate === false, "B2-null: canNavigate must be false");
  assert(tile.canRetry === true, "B2-null: canRetry should be true");
}
function test_offline_restored_auth_remains_unavailable() {
  setupOfflineRestored();
  const loader = new TodaysFollowUpsLoader();
  return Promise.resolve(loader.load("admin|admin|", adminUser)).then((res) => {
    assert(res.kind === "error", `C: result should be error, got ${res.kind}`);
    if (res.kind === "error") {
      assert(res.message === ERR_FOLLOWUP_WAITING, `C: should be ERR_FOLLOWUP_WAITING, got ${res.message}`);
    }
    const tile = deriveFollowUpTileState(
      false,
      false,
      true,
      null,
      "admin|admin|",
      "admin|admin|"
    );
    assert(tile !== null, "C: tile should not be null");
    assert(tile.phase === "unavailable", `C: phase should be unavailable, got ${tile.phase}`);
    assert(tile.canNavigate === false, "C: canNavigate should be false");
    assert(tile.canRetry === false, "C: canRetry should be false");
    setupOnline();
  });
}
function test_loaded_tile_navigates() {
  const tile = deriveFollowUpTileState(
    false,
    false,
    false,
    5,
    "rep|sales_rep|REP01",
    "rep|sales_rep|REP01"
  );
  assert(tile !== null, "D-nav: tile should not be null");
  assert(tile.phase === "success", `D-nav: phase should be success, got ${tile.phase}`);
  assert(tile.canNavigate === true, "D-nav: canNavigate should be true");
  assert(tile.canRetry === false, "D-nav: canRetry should be false");
}
function test_error_tile_retries() {
  const tile = deriveFollowUpTileState(
    false,
    true,
    false,
    null,
    "rep|sales_rep|REP01",
    "rep|sales_rep|REP01"
  );
  assert(tile !== null, "D-retry: tile should not be null");
  assert(tile.phase === "error", `D-retry: phase should be error, got ${tile.phase}`);
  assert(tile.canNavigate === false, "D-retry: canNavigate should be false");
  assert(tile.canRetry === true, "D-retry: canRetry should be true");
}
function test_unavailable_tile_does_neither() {
  const tile = deriveFollowUpTileState(
    false,
    false,
    true,
    null,
    "rep|sales_rep|REP01",
    "rep|sales_rep|REP01"
  );
  assert(tile !== null, "D-unavail: tile should not be null");
  assert(tile.phase === "unavailable", `D-unavail: phase should be unavailable, got ${tile.phase}`);
  assert(tile.canNavigate === false, "D-unavail: canNavigate should be false");
  assert(tile.canRetry === false, "D-unavail: canRetry should be false");
}
function test_repeated_followup_loader_calls() {
  let fromCallCount = 0;
  __setFromHandler(async () => {
    fromCallCount++;
    return { count: 3, error: null, data: null };
  });
  setupOnline();
  const loader = new TodaysFollowUpsLoader();
  return Promise.resolve(loader.load("admin|admin|", adminUser)).then(() => {
    const firstCount = fromCallCount;
    assert(firstCount === 1, `E: first load should call handler once, got ${firstCount}`);
    return Promise.resolve(loader.load("admin|admin|", adminUser)).then(() => {
      assert(
        fromCallCount === 2,
        `E: second call should invoke handler again (total 2), got ${fromCallCount}`
      );
      __resetFromHandler();
    });
  });
}
function test_identity_change_hides_previous_count() {
  const tile = deriveFollowUpTileState(
    false,
    false,
    false,
    99,
    // old count of 99
    "old-user|sales_rep|OLD",
    // fuIdentity = old
    "new-user|sales_rep|NEW"
    // currentIdentity = new
  );
  assert(tile !== null, "F: tile should not be null (new identity is valid)");
  assert(tile.phase === "loading", `F: phase should be loading during identity transition, got ${tile.phase}`);
  assert(tile.count === 0, `F: count should be 0 during transition (not old 99), got ${tile.count}`);
  assert(tile.canNavigate === false, "F: canNavigate should be false during loading");
}
function test_identity_change_loader_stale() {
  __setFromHandler(async () => ({ count: 42, error: null, data: null }));
  setupOnline();
  const loader = new TodaysFollowUpsLoader();
  const firstPromise = loader.load("admin|admin|", adminUser);
  const secondPromise = loader.load("rep|sales_rep|REP01", repUser);
  return Promise.all([
    Promise.resolve(firstPromise),
    Promise.resolve(secondPromise)
  ]).then(([first, second]) => {
    assert(
      first.kind === "stale",
      `F-loader: first result should be stale after identity change, got ${first.kind}`
    );
    assert(
      second.kind === "success",
      `F-loader: second result should be success, got ${second.kind}`
    );
    __resetFromHandler();
  });
}
function test_loading_visible_during_initial_load() {
  const tile = deriveFollowUpTileState(
    true,
    // loading
    false,
    // error
    false,
    // unavailable
    null,
    // count
    null,
    // fuIdentity (not yet set)
    "admin|admin|"
    // currentIdentity (valid)
  );
  assert(tile !== null, "G: tile should not be null during initial loading with valid identity");
  assert(tile.phase === "loading", `G: phase should be loading, got ${tile.phase}`);
  assert(tile.canNavigate === false, "G: canNavigate should be false during loading");
  assert(tile.canRetry === false, "G: canRetry should be false during loading");
}
function test_no_identity_tile_hidden() {
  const tile = deriveFollowUpTileState(
    true,
    false,
    false,
    null,
    null,
    null
  );
  assert(tile === null, "H: tile should be null when currentIdentity is null");
}
function test_loading_overrides_stale_error() {
  const tile = deriveFollowUpTileState(
    true,
    // loading
    true,
    // error (from previous load)
    false,
    null,
    "admin|admin|",
    "admin|admin|"
  );
  assert(tile !== null, "I: tile should not be null");
  assert(tile.phase === "loading", `I: phase should be loading (overrides error), got ${tile.phase}`);
}
function test_loading_overrides_stale_unavailable() {
  const tile = deriveFollowUpTileState(
    true,
    // loading
    false,
    true,
    // unavailable (from previous)
    null,
    "admin|admin|",
    "admin|admin|"
  );
  assert(tile !== null, "I-unavail: tile should not be null");
  assert(tile.phase === "loading", `I-unavail: phase should be loading (overrides unavailable), got ${tile.phase}`);
}
async function runAll() {
  await test_successful_zero_displays_zero();
  await test_offline_never_displays_zero();
  await test_null_count_never_displays_zero();
  await test_query_error_never_displays_zero();
  test_null_count_no_error_returns_error_not_success();
  await test_offline_restored_auth_remains_unavailable();
  test_loaded_tile_navigates();
  test_error_tile_retries();
  test_unavailable_tile_does_neither();
  await test_repeated_followup_loader_calls();
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
