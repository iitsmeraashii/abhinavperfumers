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
      gt(column, value) {
        filters.push({ method: "gt", column, value });
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

// src/unreadConversationsLoader.ts
var ERR_UNREAD_SIGN_IN = "Unread count unavailable: sign-in required.";
var ERR_UNREAD_WAITING = "Unread count unavailable: waiting for connection.";
var ERR_UNREAD_UNAVAILABLE = "Unread count unavailable. Tap to retry.";
function deriveUnreadTileState(loading, error, unavailable, count, ucIdentity, currentIdentity) {
  if (!currentIdentity) return null;
  if (ucIdentity !== currentIdentity || loading) {
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
  if (count === 0) {
    return { phase: "hidden", count: 0, canNavigate: false, canRetry: false };
  }
  return { phase: "success", count, canNavigate: true, canRetry: false };
}
var UnreadConversationsLoader = class {
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
      return { kind: "error", message: ERR_UNREAD_SIGN_IN };
    }
    if (!isTransportOnline() || !isCloudSyncAllowed()) {
      return { kind: "error", message: ERR_UNREAD_WAITING };
    }
    const gen = ++this.generation;
    this.currentIdentity = identity;
    let countVal = null;
    let queryErr = null;
    try {
      const { count, error } = await supabase.from("whatsapp_conversations").select("id", { count: "exact", head: true }).gt("unread_count", 0);
      countVal = count;
      queryErr = error;
    } catch {
      queryErr = { message: "Network error" };
    }
    if (gen !== this.generation) return { kind: "stale" };
    if (this.currentIdentity !== identity) return { kind: "stale" };
    if (!this.mounted) return { kind: "stale" };
    if (!isTransportOnline() || !isCloudSyncAllowed()) {
      return { kind: "error", message: ERR_UNREAD_WAITING };
    }
    if (queryErr) {
      return { kind: "error", message: ERR_UNREAD_UNAVAILABLE };
    }
    if (countVal === null || countVal === void 0) {
      return { kind: "error", message: ERR_UNREAD_UNAVAILABLE };
    }
    if (gen !== this.generation || !this.mounted) return { kind: "stale" };
    return { kind: "success", count: countVal };
  }
};

// scripts/test_unreadConversationsTile.ts
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
function test_count_query_uses_head_and_exact() {
  let capturedOpts;
  let capturedSelectArg = "";
  __setFromHandler(async (_table, selectArg, selectOpts, _filters) => {
    capturedSelectArg = selectArg;
    capturedOpts = selectOpts;
    return { count: 5, error: null, data: null };
  });
  setupOnline();
  const loader = new UnreadConversationsLoader();
  return Promise.resolve(loader.load("admin|admin|", adminUser)).then((res) => {
    assert(res.kind === "success", `A: result should be success, got ${res.kind}`);
    assert(capturedOpts?.head === true, "A: select opts must have head:true");
    assert(capturedOpts?.count === "exact", "A: select opts must have count:exact");
    assert(capturedSelectArg === "id", `A: select arg should be 'id', got '${capturedSelectArg}'`);
    __resetFromHandler();
  });
}
function test_unread_count_gt_filter_applied() {
  let capturedFilters = [];
  __setFromHandler(async (_table, _selectArg, _selectOpts, filters) => {
    capturedFilters = filters;
    return { count: 3, error: null, data: null };
  });
  setupOnline();
  const loader = new UnreadConversationsLoader();
  return Promise.resolve(loader.load("admin|admin|", adminUser)).then((res) => {
    assert(res.kind === "success", `B: result should be success, got ${res.kind}`);
    const gtFilter = capturedFilters.find((f) => f.method === "gt" && f.column === "unread_count" && String(f.value) === "0");
    assert(!!gtFilter, "B: must filter by unread_count > 0 using gt method");
    assert(capturedFilters.length === 1, `B: should have exactly 1 filter, got ${capturedFilters.length}`);
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
  const loader = new UnreadConversationsLoader();
  return Promise.resolve(loader.load("admin|admin|", adminUser)).then((res) => {
    assert(res.kind === "success", `C: result should be success, got ${res.kind}`);
    const repFilter = capturedFilters.find((f) => f.column === "sales_rep_code");
    assert(!repFilter, "C: admin query must NOT have a client-side rep filter");
    assert(capturedFilters.length === 1, `C: admin should have only unread_count filter, got ${capturedFilters.length}`);
    __resetFromHandler();
  });
}
function test_rep_no_client_filter() {
  let capturedFilters = [];
  __setFromHandler(async (_table, _selectArg, _selectOpts, filters) => {
    capturedFilters = filters;
    return { count: 2, error: null, data: null };
  });
  setupOnline();
  const loader = new UnreadConversationsLoader();
  return Promise.resolve(loader.load("rep|sales_rep|REP01", repUser)).then((res) => {
    assert(res.kind === "success", `D: result should be success, got ${res.kind}`);
    const repFilter = capturedFilters.find((f) => f.column === "sales_rep_code");
    assert(!repFilter, "D: rep query must NOT have a client-side rep filter (RLS handles it)");
    __resetFromHandler();
  });
}
function test_positive_count_is_success() {
  __setFromHandler(async () => ({ count: 7, error: null, data: null }));
  setupOnline();
  const loader = new UnreadConversationsLoader();
  return Promise.resolve(loader.load("admin|admin|", adminUser)).then((res) => {
    assert(res.kind === "success", `E: result should be success, got ${res.kind}`);
    if (res.kind === "success") {
      assert(res.count === 7, `E: count should be 7, got ${res.count}`);
    }
    const tile = deriveUnreadTileState(
      false,
      false,
      false,
      7,
      "admin|admin|",
      "admin|admin|"
    );
    assert(tile !== null, "E: tile should not be null");
    assert(tile.phase === "success", `E: phase should be success, got ${tile.phase}`);
    assert(tile.canNavigate === true, "E: canNavigate should be true for success");
    assert(tile.canRetry === false, "E: canRetry should be false for success");
    __resetFromHandler();
  });
}
function test_zero_count_hides_tile() {
  __setFromHandler(async () => ({ count: 0, error: null, data: null }));
  setupOnline();
  const loader = new UnreadConversationsLoader();
  return Promise.resolve(loader.load("admin|admin|", adminUser)).then((res) => {
    assert(res.kind === "success", `F: zero should be success, got ${res.kind}`);
    if (res.kind === "success") {
      assert(res.count === 0, `F: count should be 0, got ${res.count}`);
    }
    const tile = deriveUnreadTileState(
      false,
      false,
      false,
      0,
      "admin|admin|",
      "admin|admin|"
    );
    assert(tile !== null, "F: tile should not be null");
    assert(tile.phase === "hidden", `F: phase should be hidden for zero, got ${tile.phase}`);
    assert(tile.canNavigate === false, "F: canNavigate should be false for hidden");
    assert(tile.canRetry === false, "F: canRetry should be false for hidden");
    __resetFromHandler();
  });
}
function test_null_count_never_success() {
  __setFromHandler(async () => ({ count: null, error: null, data: null }));
  setupOnline();
  const loader = new UnreadConversationsLoader();
  return Promise.resolve(loader.load("admin|admin|", adminUser)).then((res) => {
    assert(res.kind === "error", `G: null count should be error, got ${res.kind}`);
    const tile = deriveUnreadTileState(
      false,
      false,
      false,
      null,
      "admin|admin|",
      "admin|admin|"
    );
    assert(tile !== null, "G: tile should not be null");
    assert(tile.phase !== "success", `G: null count must not be success, got ${tile.phase}`);
    assert(tile.phase !== "hidden", `G: null count must not be hidden, got ${tile.phase}`);
    assert(tile.phase === "error", `G: phase should be error, got ${tile.phase}`);
    assert(tile.canRetry === true, "G: canRetry should be true");
    __resetFromHandler();
  });
}
function test_query_error_never_success() {
  __setFromHandler(async () => ({ count: null, error: { message: "relation not found" }, data: null }));
  setupOnline();
  const loader = new UnreadConversationsLoader();
  return Promise.resolve(loader.load("admin|admin|", adminUser)).then((res) => {
    assert(res.kind === "error", `H: query error should be error, got ${res.kind}`);
    if (res.kind === "error") {
      assert(res.message === ERR_UNREAD_UNAVAILABLE, `H: should be ERR_UNREAD_UNAVAILABLE, got ${res.message}`);
    }
    __resetFromHandler();
  });
}
function test_offline_shows_unavailable() {
  setupOffline();
  const loader = new UnreadConversationsLoader();
  return Promise.resolve(loader.load("admin|admin|", adminUser)).then((res) => {
    assert(res.kind === "error", `I: offline should be error, got ${res.kind}`);
    if (res.kind === "error") {
      assert(res.message === ERR_UNREAD_WAITING, `I: should be ERR_UNREAD_WAITING, got ${res.message}`);
    }
    const tile = deriveUnreadTileState(
      false,
      false,
      true,
      null,
      "admin|admin|",
      "admin|admin|"
    );
    assert(tile !== null, "I: tile should not be null");
    assert(tile.phase === "unavailable", `I: phase should be unavailable, got ${tile.phase}`);
    assert(tile.canNavigate === false, "I: canNavigate should be false");
    assert(tile.canRetry === false, "I: canRetry should be false for unavailable");
    setupOnline();
  });
}
function test_offline_restored_auth_unavailable() {
  setupOfflineRestored();
  const loader = new UnreadConversationsLoader();
  return Promise.resolve(loader.load("admin|admin|", adminUser)).then((res) => {
    assert(res.kind === "error", `J: offline-restored should be error, got ${res.kind}`);
    if (res.kind === "error") {
      assert(res.message === ERR_UNREAD_WAITING, `J: should be ERR_UNREAD_WAITING, got ${res.message}`);
    }
    setupOnline();
  });
}
function test_no_identity_tile_hidden() {
  const tile = deriveUnreadTileState(
    true,
    false,
    false,
    null,
    null,
    null
  );
  assert(tile === null, "K: tile should be null when currentIdentity is null");
}
function test_loading_visible_for_valid_identity() {
  const tile = deriveUnreadTileState(
    true,
    false,
    false,
    null,
    null,
    "admin|admin|"
  );
  assert(tile !== null, "L: tile should not be null during loading with valid identity");
  assert(tile.phase === "loading", `L: phase should be loading, got ${tile.phase}`);
  assert(tile.canNavigate === false, "L: canNavigate should be false during loading");
  assert(tile.canRetry === false, "L: canRetry should be false during loading");
}
function test_stale_after_invalidate() {
  __setFromHandler(async () => ({ count: 42, error: null, data: null }));
  setupOnline();
  const loader = new UnreadConversationsLoader();
  const promise = loader.load("admin|admin|", adminUser);
  loader.invalidate();
  return Promise.resolve(promise).then((res) => {
    assert(res.kind === "stale", `M: result after invalidate should be stale, got ${res.kind}`);
    __resetFromHandler();
  });
}
function test_stale_after_identity_change() {
  __setFromHandler(async () => ({ count: 42, error: null, data: null }));
  setupOnline();
  const loader = new UnreadConversationsLoader();
  const firstPromise = loader.load("admin|admin|", adminUser);
  const secondPromise = loader.load("rep|sales_rep|REP01", repUser);
  return Promise.all([
    Promise.resolve(firstPromise),
    Promise.resolve(secondPromise)
  ]).then(([first, second]) => {
    assert(
      first.kind === "stale",
      `N: first result should be stale after identity change, got ${first.kind}`
    );
    assert(
      second.kind === "success",
      `N: second result should be success, got ${second.kind}`
    );
    __resetFromHandler();
  });
}
function test_identity_change_shows_loading() {
  const tile = deriveUnreadTileState(
    false,
    false,
    false,
    99,
    "old-user|sales_rep|OLD",
    "new-user|sales_rep|NEW"
  );
  assert(tile !== null, "O: tile should not be null (new identity is valid)");
  assert(tile.phase === "loading", `O: phase should be loading during identity transition, got ${tile.phase}`);
  assert(tile.count === 0, `O: count should be 0 during transition, got ${tile.count}`);
  assert(tile.canNavigate === false, "O: canNavigate should be false during loading");
}
function test_loaded_tile_navigates() {
  const tile = deriveUnreadTileState(
    false,
    false,
    false,
    5,
    "rep|sales_rep|REP01",
    "rep|sales_rep|REP01"
  );
  assert(tile !== null, "P-nav: tile should not be null");
  assert(tile.phase === "success", `P-nav: phase should be success, got ${tile.phase}`);
  assert(tile.canNavigate === true, "P-nav: canNavigate should be true");
  assert(tile.canRetry === false, "P-nav: canRetry should be false");
}
function test_error_tile_retries() {
  const tile = deriveUnreadTileState(
    false,
    true,
    false,
    null,
    "rep|sales_rep|REP01",
    "rep|sales_rep|REP01"
  );
  assert(tile !== null, "P-retry: tile should not be null");
  assert(tile.phase === "error", `P-retry: phase should be error, got ${tile.phase}`);
  assert(tile.canNavigate === false, "P-retry: canNavigate should be false");
  assert(tile.canRetry === true, "P-retry: canRetry should be true");
}
function test_unavailable_tile_does_neither() {
  const tile = deriveUnreadTileState(
    false,
    false,
    true,
    null,
    "rep|sales_rep|REP01",
    "rep|sales_rep|REP01"
  );
  assert(tile !== null, "P-unavail: tile should not be null");
  assert(tile.phase === "unavailable", `P-unavail: phase should be unavailable, got ${tile.phase}`);
  assert(tile.canNavigate === false, "P-unavail: canNavigate should be false");
  assert(tile.canRetry === false, "P-unavail: canRetry should be false");
}
function test_loading_overrides_stale_error() {
  const tile = deriveUnreadTileState(
    true,
    true,
    false,
    null,
    "admin|admin|",
    "admin|admin|"
  );
  assert(tile !== null, "Q: tile should not be null");
  assert(tile.phase === "loading", `Q: phase should be loading (overrides error), got ${tile.phase}`);
}
function test_loading_overrides_stale_unavailable() {
  const tile = deriveUnreadTileState(
    true,
    false,
    true,
    null,
    "admin|admin|",
    "admin|admin|"
  );
  assert(tile !== null, "Q-unavail: tile should not be null");
  assert(tile.phase === "loading", `Q-unavail: phase should be loading (overrides unavailable), got ${tile.phase}`);
}
function test_zero_distinct_from_error() {
  const zeroTile = deriveUnreadTileState(
    false,
    false,
    false,
    0,
    "admin|admin|",
    "admin|admin|"
  );
  const errorTile = deriveUnreadTileState(
    false,
    true,
    false,
    null,
    "admin|admin|",
    "admin|admin|"
  );
  const unavailTile = deriveUnreadTileState(
    false,
    false,
    true,
    null,
    "admin|admin|",
    "admin|admin|"
  );
  assert(zeroTile.phase === "hidden", "R: zero should be hidden");
  assert(errorTile.phase === "error", "R: error should be error");
  assert(unavailTile.phase === "unavailable", "R: unavailable should be unavailable");
  assert(zeroTile.phase !== errorTile.phase, "R: zero and error must differ");
  assert(zeroTile.phase !== unavailTile.phase, "R: zero and unavailable must differ");
}
function test_repeated_loader_calls() {
  let fromCallCount = 0;
  __setFromHandler(async () => {
    fromCallCount++;
    return { count: 3, error: null, data: null };
  });
  setupOnline();
  const loader = new UnreadConversationsLoader();
  return Promise.resolve(loader.load("admin|admin|", adminUser)).then(() => {
    assert(fromCallCount === 1, `S: first load should call handler once, got ${fromCallCount}`);
    return Promise.resolve(loader.load("admin|admin|", adminUser)).then(() => {
      assert(
        fromCallCount === 2,
        `S: second call should invoke handler again (total 2), got ${fromCallCount}`
      );
      __resetFromHandler();
    });
  });
}
async function runAll() {
  await test_count_query_uses_head_and_exact();
  await test_unread_count_gt_filter_applied();
  await test_admin_no_rep_filter();
  await test_rep_no_client_filter();
  await test_positive_count_is_success();
  await test_zero_count_hides_tile();
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
  console.log(`Unread Conversations tile tests: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}
runAll();
