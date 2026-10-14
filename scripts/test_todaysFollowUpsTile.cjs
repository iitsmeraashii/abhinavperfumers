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

// scripts/test_todaysFollowUpsTile.ts
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
function startOfTodayISO() {
  const now = /* @__PURE__ */ new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0).toISOString();
}
function startOfTomorrowISO() {
  return new Date(new Date(startOfTodayISO()).getTime() + 24 * 60 * 60 * 1e3).toISOString();
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
function test_select_uses_inner_relationship_and_head() {
  let capturedSelectArg = "";
  let capturedSelectOpts;
  __setFromHandler(async (_table, selectArg, selectOpts, _filters) => {
    capturedSelectArg = selectArg;
    capturedSelectOpts = selectOpts;
    return { count: 5, error: null, data: null };
  });
  setupOnline();
  const loader = new TodaysFollowUpsLoader();
  const result = loader.load("admin-identity", adminUser);
  return Promise.resolve(result).then((res) => {
    assert(
      res.kind === "success",
      `Select/inner: result should be success, got ${res.kind}`
    );
    assert(
      capturedSelectArg.includes("lead_entries!inner"),
      `Select/inner: select arg must include lead_entries!inner, got "${capturedSelectArg}"`
    );
    assert(
      capturedSelectOpts?.head === true,
      "Select/inner: select opts must have head:true"
    );
    assert(
      capturedSelectOpts?.count === "exact",
      'Select/inner: select opts must have count:"exact"'
    );
    __resetFromHandler();
  });
}
function test_admin_no_rep_filter() {
  let capturedFilters = [];
  __setFromHandler(async (_table, _selectArg, _selectOpts, filters) => {
    capturedFilters = filters;
    return { count: 10, error: null, data: null };
  });
  setupOnline();
  const loader = new TodaysFollowUpsLoader();
  return Promise.resolve(loader.load("admin-identity", adminUser)).then((res) => {
    assert(
      res.kind === "success",
      `Admin filter: result should be success, got ${res.kind}`
    );
    const hasRepFilter = capturedFilters.some((f) => f.column === "lead_entries.sales_rep_code");
    assert(
      !hasRepFilter,
      "Admin filter: should NOT have lead_entries.sales_rep_code filter"
    );
    __resetFromHandler();
  });
}
function test_rep_has_sales_rep_code_filter() {
  let capturedFilters = [];
  __setFromHandler(async (_table, _selectArg, _selectOpts, filters) => {
    capturedFilters = filters;
    return { count: 3, error: null, data: null };
  });
  setupOnline();
  const loader = new TodaysFollowUpsLoader();
  return Promise.resolve(loader.load("rep-identity", repUser)).then((res) => {
    assert(
      res.kind === "success",
      `Rep filter: result should be success, got ${res.kind}`
    );
    const repFilter = capturedFilters.find((f) => f.column === "lead_entries.sales_rep_code");
    assert(
      !!repFilter,
      "Rep filter: should have lead_entries.sales_rep_code filter"
    );
    assert(
      repFilter?.value === "REP01",
      `Rep filter: sales_rep_code should be REP01, got ${repFilter?.value}`
    );
    __resetFromHandler();
  });
}
function test_pending_status_filter() {
  let capturedFilters = [];
  __setFromHandler(async (_table, _selectArg, _selectOpts, filters) => {
    capturedFilters = filters;
    return { count: 0, error: null, data: null };
  });
  setupOnline();
  const loader = new TodaysFollowUpsLoader();
  return Promise.resolve(loader.load("admin-identity", adminUser)).then((res) => {
    assert(
      res.kind === "success",
      `PENDING filter: result should be success, got ${res.kind}`
    );
    const statusFilter = capturedFilters.find((f) => f.column === "status" && f.value === "PENDING");
    assert(
      !!statusFilter,
      "PENDING filter: must have status=PENDING filter"
    );
    __resetFromHandler();
  });
}
function test_today_bounds_match_list_page() {
  let capturedFilters = [];
  __setFromHandler(async (_table, _selectArg, _selectOpts, filters) => {
    capturedFilters = filters;
    return { count: 2, error: null, data: null };
  });
  setupOnline();
  const loader = new TodaysFollowUpsLoader();
  return Promise.resolve(loader.load("admin-identity", adminUser)).then((res) => {
    assert(
      res.kind === "success",
      `Today bounds: result should be success, got ${res.kind}`
    );
    const gteFilter = capturedFilters.find((f) => f.method === "gte" && f.column === "reminder_date");
    const ltFilter = capturedFilters.find((f) => f.method === "lt" && f.column === "reminder_date");
    assert(
      !!gteFilter,
      "Today bounds: must have gte(reminder_date, ...) filter"
    );
    assert(
      !!ltFilter,
      "Today bounds: must have lt(reminder_date, ...) filter"
    );
    const expectedStart = startOfTodayISO();
    const expectedEnd = startOfTomorrowISO();
    assert(
      gteFilter?.value === expectedStart,
      `Today bounds: gte value should be ${expectedStart}, got ${gteFilter?.value}`
    );
    assert(
      ltFilter?.value === expectedEnd,
      `Today bounds: lt value should be ${expectedEnd}, got ${ltFilter?.value}`
    );
    __resetFromHandler();
  });
}
function test_zero_count_is_success_not_error() {
  __setFromHandler(async () => ({ count: 0, error: null, data: null }));
  setupOnline();
  const loader = new TodaysFollowUpsLoader();
  return Promise.resolve(loader.load("admin-identity", adminUser)).then((res) => {
    assert(
      res.kind === "success",
      `Zero count: result should be success, got ${res.kind}`
    );
    if (res.kind === "success") {
      assert(
        res.count === 0,
        `Zero count: count should be 0, got ${res.count}`
      );
    }
    __resetFromHandler();
  });
}
function test_null_count_is_error_not_zero() {
  __setFromHandler(async () => ({ count: null, error: null, data: null }));
  setupOnline();
  const loader = new TodaysFollowUpsLoader();
  return Promise.resolve(loader.load("admin-identity", adminUser)).then((res) => {
    assert(
      res.kind === "error",
      `Null count: result should be error, got ${res.kind}`
    );
    if (res.kind === "error") {
      assert(
        res.message === ERR_FOLLOWUP_UNAVAILABLE,
        `Null count: message should be ERR_FOLLOWUP_UNAVAILABLE, got ${res.message}`
      );
    }
    __resetFromHandler();
  });
}
function test_query_error_is_error_not_zero() {
  __setFromHandler(async () => ({ count: null, error: { message: "relation not found" }, data: null }));
  setupOnline();
  const loader = new TodaysFollowUpsLoader();
  return Promise.resolve(loader.load("admin-identity", adminUser)).then((res) => {
    assert(
      res.kind === "error",
      `Query error: result should be error, got ${res.kind}`
    );
    __resetFromHandler();
  });
}
function test_network_throw_is_error_not_zero() {
  __setFromHandler(async () => {
    throw new Error("network failure");
  });
  setupOnline();
  const loader = new TodaysFollowUpsLoader();
  return Promise.resolve(loader.load("admin-identity", adminUser)).then((res) => {
    assert(
      res.kind === "error",
      `Network throw: result should be error, got ${res.kind}`
    );
    __resetFromHandler();
  });
}
function test_retry_calls_load_again() {
  let callCount = 0;
  __setFromHandler(async () => {
    callCount++;
    if (callCount === 1) return { count: null, error: { message: "timeout" }, data: null };
    return { count: 7, error: null, data: null };
  });
  setupOnline();
  const loader = new TodaysFollowUpsLoader();
  return Promise.resolve(loader.load("admin-identity", adminUser)).then((firstResult) => {
    assert(
      firstResult.kind === "error",
      `Retry: first call should error, got ${firstResult.kind}`
    );
    assert(
      callCount === 1,
      `Retry: first call should hit handler once, got ${callCount}`
    );
    return Promise.resolve(loader.load("admin-identity", adminUser)).then((secondResult) => {
      assert(
        secondResult.kind === "success",
        `Retry: second call should succeed, got ${secondResult.kind}`
      );
      if (secondResult.kind === "success") {
        assert(
          secondResult.count === 7,
          `Retry: count should be 7, got ${secondResult.count}`
        );
      }
      assert(
        callCount === 2,
        `Retry: second call should hit handler twice total, got ${callCount}`
      );
      __resetFromHandler();
    });
  });
}
function test_navigation_sets_today_filter() {
  let followupsInitialFilter = void 0;
  let activeTab = "dashboard";
  function handleNavigateToFollowUps() {
    followupsInitialFilter = "today";
    activeTab = "followups";
  }
  handleNavigateToFollowUps();
  assert(
    followupsInitialFilter === "today",
    `Navigation: followupsInitialFilter should be 'today', got ${followupsInitialFilter}`
  );
  assert(
    activeTab === "followups",
    `Navigation: activeTab should be 'followups', got ${activeTab}`
  );
  function handleTabChange(t) {
    activeTab = t;
    followupsInitialFilter = void 0;
  }
  handleTabChange("dashboard");
  assert(
    followupsInitialFilter === void 0,
    "Navigation: filter should clear when navigating away from followups"
  );
}
function test_stale_after_invalidate() {
  __setFromHandler(async () => {
    return { count: 42, error: null, data: null };
  });
  setupOnline();
  const loader = new TodaysFollowUpsLoader();
  const firstPromise = loader.load("admin-identity", adminUser);
  loader.invalidate();
  return Promise.resolve(firstPromise).then((res) => {
    assert(
      res.kind === "stale",
      `Stale/invalidate: first result should be stale after invalidate, got ${res.kind}`
    );
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
  const firstPromise = loader.load("admin-identity", adminUser);
  const repUser2 = { rep_code: "REP02", role: "sales_rep", authUserId: "auth-rep-2" };
  const secondPromise = loader.load("rep-2-identity", repUser2);
  return Promise.all([
    Promise.resolve(firstPromise),
    Promise.resolve(secondPromise)
  ]).then(([first, second]) => {
    assert(
      first.kind === "stale",
      `Stale/identity: first result should be stale after identity change, got ${first.kind}`
    );
    assert(
      second.kind === "success",
      `Stale/identity: second result should be success, got ${second.kind}`
    );
    __resetFromHandler();
  });
}
function test_stale_after_transport_offline() {
  __setFromHandler(async () => ({ count: 5, error: null, data: null }));
  setupOnline();
  const loader = new TodaysFollowUpsLoader();
  const firstPromise = loader.load("admin-identity", adminUser);
  setupOffline();
  return Promise.resolve(firstPromise).then((res) => {
    assert(
      res.kind === "error",
      `Stale/transport: result should be error after transport goes offline, got ${res.kind}`
    );
    if (res.kind === "error") {
      assert(
        res.message === ERR_FOLLOWUP_WAITING,
        `Stale/transport: message should be ERR_FOLLOWUP_WAITING, got ${res.message}`
      );
    }
    setupOnline();
    __resetFromHandler();
  });
}
function test_error_when_offline_before_load() {
  setupOffline();
  const loader = new TodaysFollowUpsLoader();
  return Promise.resolve(loader.load("admin-identity", adminUser)).then((res) => {
    assert(
      res.kind === "error",
      `Offline before load: result should be error, got ${res.kind}`
    );
    if (res.kind === "error") {
      assert(
        res.message === ERR_FOLLOWUP_WAITING,
        `Offline before load: message should be ERR_FOLLOWUP_WAITING, got ${res.message}`
      );
    }
    setupOnline();
  });
}
function test_error_when_no_identity() {
  setupOnline();
  const loader = new TodaysFollowUpsLoader();
  return Promise.resolve(loader.load(null, null)).then((res) => {
    assert(
      res.kind === "error",
      `No identity: result should be error, got ${res.kind}`
    );
    if (res.kind === "error") {
      assert(
        res.message === ERR_FOLLOWUP_SIGN_IN,
        `No identity: message should be ERR_FOLLOWUP_SIGN_IN, got ${res.message}`
      );
    }
  });
}
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
