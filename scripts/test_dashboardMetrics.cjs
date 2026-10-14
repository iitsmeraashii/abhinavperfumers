const _g = globalThis;
if (!_g.localStorage) { const _s = {}; _g.localStorage = { getItem: (k) => _s[k] ?? null, setItem: (k, v) => { _s[k] = v; }, removeItem: (k) => { delete _s[k]; } }; }
if (!_g.navigator) _g.navigator = { onLine: true };
if (!_g.window) _g.window = _g;

// scripts/test_dashboard_stub_supabase.ts
var currentHandler = () => Promise.resolve({ data: null, error: { message: "no handler set" } });
function __setRpcHandler(handler) {
  currentHandler = handler;
}
function __resetRpcHandler() {
  currentHandler = () => Promise.resolve({ data: null, error: { message: "no handler set" } });
}
var supabase = {
  rpc: (fn, args) => currentHandler(fn, args ?? {}),
  from: () => ({
    select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) })
  }),
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

// src/dashboardMetricsLoader.ts
var EMPTY_DASHBOARD = {
  total_leads: 0,
  leads_today: 0,
  leads_last_7_days: 0,
  leads_last_30_days: 0,
  whatsapp_sent: 0,
  whatsapp_failed: 0,
  invalid_leads: 0,
  new_leads: 0,
  contacted_leads: 0,
  qualified_leads: 0,
  converted_leads: 0,
  lost_leads: 0,
  hot_leads: 0,
  warm_leads: 0,
  cold_leads: 0,
  unassigned_temperature_leads: 0
};
var METRIC_FIELDS = [
  "total_leads",
  "leads_today",
  "leads_last_7_days",
  "leads_last_30_days",
  "whatsapp_sent",
  "whatsapp_failed",
  "invalid_leads",
  "new_leads",
  "contacted_leads",
  "qualified_leads",
  "converted_leads",
  "lost_leads",
  "hot_leads",
  "warm_leads",
  "cold_leads",
  "unassigned_temperature_leads"
];
function isValidCount(value) {
  if (value === null || value === void 0) return false;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return false;
    const n2 = Number(trimmed);
    if (typeof n2 !== "number" || !Number.isFinite(n2)) return false;
    if (n2 < 0 || !Number.isInteger(n2) || n2 > Number.MAX_SAFE_INTEGER) return false;
    return true;
  }
  const n = value;
  if (typeof n !== "number") return false;
  if (!Number.isFinite(n)) return false;
  if (n < 0) return false;
  if (!Number.isInteger(n)) return false;
  if (n > Number.MAX_SAFE_INTEGER) return false;
  return true;
}
function parseMetricsResponse(rpcData) {
  if (!rpcData) return null;
  const row = Array.isArray(rpcData) ? rpcData[0] : rpcData;
  if (!row || typeof row !== "object") return null;
  const obj = row;
  for (const field of METRIC_FIELDS) {
    if (!isValidCount(obj[field])) return null;
  }
  return {
    total_leads: Number(obj.total_leads),
    leads_today: Number(obj.leads_today),
    leads_last_7_days: Number(obj.leads_last_7_days),
    leads_last_30_days: Number(obj.leads_last_30_days),
    whatsapp_sent: Number(obj.whatsapp_sent),
    whatsapp_failed: Number(obj.whatsapp_failed),
    invalid_leads: Number(obj.invalid_leads),
    new_leads: Number(obj.new_leads),
    contacted_leads: Number(obj.contacted_leads),
    qualified_leads: Number(obj.qualified_leads),
    converted_leads: Number(obj.converted_leads),
    lost_leads: Number(obj.lost_leads),
    hot_leads: Number(obj.hot_leads),
    warm_leads: Number(obj.warm_leads),
    cold_leads: Number(obj.cold_leads),
    unassigned_temperature_leads: Number(obj.unassigned_temperature_leads)
  };
}
function getTodayIso(now = /* @__PURE__ */ new Date()) {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
}
var SUPPORTED_ROLES = /* @__PURE__ */ new Set(["admin", "sales_rep"]);
function identityKey(user) {
  if (!user?.authUserId || !user?.role) return null;
  if (!SUPPORTED_ROLES.has(user.role)) return null;
  if (user.role === "sales_rep" && !user.rep_code) return null;
  return `${user.authUserId}|${user.role}|${user.rep_code}`;
}
function isAuthorized() {
  return isTransportOnline() && isCloudSyncAllowed();
}
var ERR_SIGN_IN = "Dashboard metrics unavailable: sign-in required.";
var ERR_WAITING = "Dashboard metrics unavailable: waiting for connection.";
var ERR_UNAVAILABLE = "Dashboard metrics unavailable. Tap Retry to try again.";
function deriveDisplayState(loading, error, dataIdentity, errorIdentity, currentIdentity, data) {
  const displayData = dataIdentity === currentIdentity ? data : EMPTY_DASHBOARD;
  const isIdentityTransition = dataIdentity !== currentIdentity && errorIdentity !== currentIdentity;
  const showLoading = loading || currentIdentity !== null && isIdentityTransition;
  const showError = !!error && currentIdentity !== null && errorIdentity === currentIdentity;
  return { displayData, showLoading, showError };
}
var DashboardMetricsLoader = class {
  generation = 0;
  currentIdentity = null;
  mounted = true;
  /** Increment generation to invalidate any in-flight request. */
  invalidate() {
    this.generation++;
    this.currentIdentity = null;
  }
  /** Mark as unmounted — all future results are stale. */
  unmount() {
    this.mounted = false;
    this.generation++;
  }
  /**
   * Fetch dashboard metrics for the given identity.
   * Returns a discriminated result: success, error, or stale (discarded).
   *
   * The caller MUST check `kind === 'stale'` and NOT update state.
   */
  async load(identity) {
    if (!this.mounted) return { kind: "stale" };
    if (!identity) {
      return { kind: "error", message: ERR_SIGN_IN };
    }
    if (!isAuthorized()) {
      return { kind: "error", message: ERR_WAITING };
    }
    const gen = ++this.generation;
    this.currentIdentity = identity;
    let rpcData = null;
    let rpcErr = null;
    try {
      const result = await supabase.rpc("get_dashboard_metrics", { p_today_iso: getTodayIso() });
      rpcData = result.data;
      rpcErr = result.error;
    } catch {
      rpcErr = { message: "Network error" };
    }
    if (gen !== this.generation) return { kind: "stale" };
    if (this.currentIdentity !== identity) return { kind: "stale" };
    if (!this.mounted) return { kind: "stale" };
    if (!isAuthorized()) {
      return { kind: "error", message: ERR_WAITING };
    }
    if (rpcErr) {
      return { kind: "error", message: ERR_UNAVAILABLE };
    }
    const parsed = parseMetricsResponse(rpcData);
    if (!parsed) {
      return { kind: "error", message: ERR_UNAVAILABLE };
    }
    if (gen !== this.generation || !this.mounted) return { kind: "stale" };
    return { kind: "success", data: parsed };
  }
};

// scripts/test_dashboard_wiring.ts
var DashboardWiringHarness = class {
  // ── Refs (mirror DashboardPage) ──
  loader = new DashboardMetricsLoader();
  // ── State (mirror DashboardPage) ──
  data = EMPTY_DASHBOARD;
  dataIdentity = null;
  errorIdentity = null;
  loading = true;
  error = "";
  // ── Props/inputs (controlled by test) ──
  user = null;
  authMode = "unauthenticated";
  isOnline = true;
  // ── Cleanup tracking ──
  cleanupRegistered = false;
  // Simulate setting the user/auth context.
  setUser(user) {
    this.user = user;
  }
  setAuthMode(mode2) {
    this.authMode = mode2;
  }
  setIsOnline(online2) {
    this.isOnline = online2;
  }
  get currentIdentity() {
    return identityKey(this.user);
  }
  // ── fetchData (exact mirror of DashboardPage's useCallback) ──
  async fetchData() {
    this.loading = true;
    this.error = "";
    const result = await this.loader.load(this.currentIdentity);
    if (result.kind === "stale") return;
    if (result.kind === "error") {
      this.error = result.message;
      this.data = EMPTY_DASHBOARD;
      this.dataIdentity = null;
      this.errorIdentity = this.currentIdentity;
      this.loading = false;
      return;
    }
    this.data = result.data;
    this.dataIdentity = this.currentIdentity;
    this.errorIdentity = null;
    this.loading = false;
  }
  // ── Main effect (exact mirror of DashboardPage's useEffect) ──
  // Fires on mount, identity change, authMode change, transport change.
  triggerEffect() {
    this.data = EMPTY_DASHBOARD;
    this.dataIdentity = null;
    this.errorIdentity = null;
    this.loading = true;
    this.error = "";
    this.loader.invalidate();
    void this.fetchData();
  }
  // ── Cleanup effect (exact mirror of DashboardPage's cleanup useEffect) ──
  // In StrictMode: setup → cleanup → setup. Cleanup must NOT permanently
  // unmount the loader — it only invalidates in-flight requests.
  cleanup() {
    this.loader.invalidate();
  }
  // Simulate StrictMode: setup → cleanup → setup
  strictModeCycle() {
    this.triggerEffect();
    this.cleanup();
    this.triggerEffect();
  }
  // ── Identity display guard (exact mirror of DashboardPage's derived values) ──
  get state() {
    const currentIdentity = this.currentIdentity;
    const { displayData, showLoading, showError } = deriveDisplayState(
      this.loading,
      this.error,
      this.dataIdentity,
      this.errorIdentity,
      currentIdentity,
      this.data
    );
    return {
      displayData,
      showLoading,
      showError,
      errorMessage: this.error,
      dataIdentity: this.dataIdentity
    };
  }
};

// scripts/test_dashboardMetrics.ts
var passed = 0;
var failed = 0;
function assert(condition, message) {
  if (condition) {
    passed++;
    console.log(`  PASS: ${message}`);
  } else {
    failed++;
    console.error(`  FAIL: ${message}`);
  }
}
function flushPromises() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
var VALID_METRICS = {
  total_leads: 100,
  leads_today: 10,
  leads_last_7_days: 50,
  leads_last_30_days: 80,
  whatsapp_sent: 30,
  whatsapp_failed: 5,
  invalid_leads: 2,
  new_leads: 40,
  contacted_leads: 20,
  qualified_leads: 15,
  converted_leads: 10,
  lost_leads: 5,
  hot_leads: 25,
  warm_leads: 30,
  cold_leads: 40,
  unassigned_temperature_leads: 5
};
var ZERO_METRICS = {
  total_leads: 0,
  leads_today: 0,
  leads_last_7_days: 0,
  leads_last_30_days: 0,
  whatsapp_sent: 0,
  whatsapp_failed: 0,
  invalid_leads: 0,
  new_leads: 0,
  contacted_leads: 0,
  qualified_leads: 0,
  converted_leads: 0,
  lost_leads: 0,
  hot_leads: 0,
  warm_leads: 0,
  cold_leads: 0,
  unassigned_temperature_leads: 0
};
var ADMIN_IDENTITY = "auth-admin-001|admin|ADMIN001";
var REP_IDENTITY = "auth-rep-001|sales_rep|REP001";
function setAuthorized() {
  __setTransportOnline(true);
  setAuthModeState("online");
}
function setTransportDown() {
  __setTransportOnline(false);
  setAuthModeState("online");
}
function setAuthOffline() {
  __setTransportOnline(true);
  setAuthModeState("offline-restored");
}
async function main() {
  console.log("\n--- isValidCount ---");
  assert(isValidCount(0), "isValidCount(0) = true");
  assert(isValidCount(100), "isValidCount(100) = true");
  assert(isValidCount("42"), 'isValidCount("42") = true');
  assert(!isValidCount(null), "isValidCount(null) = false");
  assert(!isValidCount(void 0), "isValidCount(undefined) = false");
  assert(!isValidCount(-1), "isValidCount(-1) = false");
  assert(!isValidCount(10.5), "isValidCount(10.5) = false");
  assert(!isValidCount(NaN), "isValidCount(NaN) = false");
  assert(!isValidCount(Infinity), "isValidCount(Infinity) = false");
  assert(!isValidCount(""), 'isValidCount("") = false');
  assert(!isValidCount("abc"), 'isValidCount("abc") = false');
  assert(!isValidCount(Number.MAX_SAFE_INTEGER + 1), "isValidCount(unsafe) = false");
  assert(!isValidCount({}), "isValidCount({}) = false");
  assert(!isValidCount([]), "isValidCount([]) = false");
  console.log("\n--- parseMetricsResponse ---");
  console.log("TEST: valid object response");
  {
    const result = parseMetricsResponse(VALID_METRICS);
    assert(result !== null, "non-null for valid object");
    assert(result?.total_leads === 100, "total_leads = 100");
  }
  console.log("TEST: valid array response");
  {
    const result = parseMetricsResponse([VALID_METRICS]);
    assert(result !== null, "non-null for valid array");
    assert(result?.total_leads === 100, "total_leads = 100");
  }
  console.log("TEST: valid all-zero response");
  {
    const result = parseMetricsResponse(ZERO_METRICS);
    assert(result !== null, "non-null for all zeros");
    assert(result?.total_leads === 0, "total_leads = 0");
  }
  console.log("TEST: null \u2192 null");
  assert(parseMetricsResponse(null) === null, "null for null input");
  console.log("TEST: empty array \u2192 null");
  assert(parseMetricsResponse([]) === null, "null for empty array");
  console.log("TEST: missing field \u2192 null");
  {
    const partial = { ...VALID_METRICS, hot_leads: void 0 };
    assert(parseMetricsResponse(partial) === null, "null for missing field");
  }
  console.log("TEST: null field \u2192 null");
  {
    const withNull = { ...VALID_METRICS, total_leads: null };
    assert(parseMetricsResponse(withNull) === null, "null for null field");
  }
  console.log("TEST: negative value \u2192 null");
  {
    const withNeg = { ...VALID_METRICS, total_leads: -1 };
    assert(parseMetricsResponse(withNeg) === null, "null for negative");
  }
  console.log("TEST: fractional value \u2192 null");
  {
    const withFrac = { ...VALID_METRICS, total_leads: 10.5 };
    assert(parseMetricsResponse(withFrac) === null, "null for fractional");
  }
  console.log("TEST: NaN \u2192 null");
  {
    const withNaN = { ...VALID_METRICS, total_leads: NaN };
    assert(parseMetricsResponse(withNaN) === null, "null for NaN");
  }
  console.log("TEST: Infinity \u2192 null");
  {
    const withInf = { ...VALID_METRICS, total_leads: Infinity };
    assert(parseMetricsResponse(withInf) === null, "null for Infinity");
  }
  console.log("TEST: empty object \u2192 null");
  assert(parseMetricsResponse({}) === null, "null for empty object");
  console.log("TEST: numeric string values accepted");
  {
    const strMetrics = {};
    for (const k of Object.keys(VALID_METRICS)) {
      strMetrics[k] = String(VALID_METRICS[k]);
    }
    const result = parseMetricsResponse(strMetrics);
    assert(result !== null, "non-null for numeric strings");
    assert(result?.total_leads === 100, "total_leads = 100 from string");
  }
  console.log("TEST: unsafe integer \u2192 null");
  {
    const withUnsafe = { ...VALID_METRICS, total_leads: Number.MAX_SAFE_INTEGER + 1 };
    assert(parseMetricsResponse(withUnsafe) === null, "null for unsafe integer");
  }
  console.log("\n--- getTodayIso ---");
  console.log("TEST: local midnight ISO");
  {
    const now = new Date(2026, 9, 14, 15, 30, 0);
    const iso = getTodayIso(now);
    const midnight = new Date(2026, 9, 14, 0, 0, 0);
    assert(new Date(iso).getTime() === midnight.getTime(), "equals local midnight");
  }
  console.log("\n--- identityKey ---");
  assert(identityKey({ authUserId: "a1", role: "admin", rep_code: "ADMIN" }) === "a1|admin|ADMIN", "admin identity");
  assert(identityKey({ authUserId: "r1", role: "sales_rep", rep_code: "REP" }) === "r1|sales_rep|REP", "rep identity");
  assert(identityKey(null) === null, "null user \u2192 null");
  assert(identityKey({ authUserId: "", role: "admin", rep_code: "A" }) === null, "missing authUserId \u2192 null");
  assert(identityKey({ authUserId: "a", role: "", rep_code: "A" }) === null, "missing role \u2192 null");
  assert(identityKey({ authUserId: "a", role: "sales_rep", rep_code: "" }) === null, "rep missing rep_code \u2192 null");
  console.log("\n--- isAuthorized (dual gate) ---");
  __setTransportOnline(true);
  setAuthModeState("online");
  assert(isAuthorized() === true, "transport up + online \u2192 authorized");
  __setTransportOnline(false);
  setAuthModeState("online");
  assert(isAuthorized() === false, "transport down + online \u2192 NOT authorized");
  __setTransportOnline(true);
  setAuthModeState("offline-restored");
  assert(isAuthorized() === false, "transport up + offline-restored \u2192 NOT authorized");
  __setTransportOnline(true);
  setAuthModeState("unauthenticated");
  assert(isAuthorized() === false, "transport up + unauthenticated \u2192 NOT authorized");
  __setTransportOnline(false);
  setAuthModeState("offline-restored");
  assert(isAuthorized() === false, "both down \u2192 NOT authorized");
  console.log("\n--- Loader: success path ---");
  console.log("TEST: admin authorized \u2192 success with data");
  {
    setAuthorized();
    __setRpcHandler(async () => ({ data: VALID_METRICS, error: null }));
    const loader = new DashboardMetricsLoader();
    const result = await loader.load(ADMIN_IDENTITY);
    assert(result.kind === "success", "kind = success");
    assert(result.data.total_leads === 100, "total_leads = 100");
    loader.unmount();
    __resetRpcHandler();
  }
  console.log("TEST: rep authorized \u2192 success with data");
  {
    setAuthorized();
    __setRpcHandler(async () => ({ data: VALID_METRICS, error: null }));
    const loader = new DashboardMetricsLoader();
    const result = await loader.load(REP_IDENTITY);
    assert(result.kind === "success", "kind = success");
    assert(result.data.total_leads === 100, "total_leads = 100");
    loader.unmount();
    __resetRpcHandler();
  }
  console.log("TEST: valid all-zero \u2192 success (not error)");
  {
    setAuthorized();
    __setRpcHandler(async () => ({ data: ZERO_METRICS, error: null }));
    const loader = new DashboardMetricsLoader();
    const result = await loader.load(ADMIN_IDENTITY);
    assert(result.kind === "success", "kind = success for zeros");
    assert(result.data.total_leads === 0, "total_leads = 0");
    loader.unmount();
    __resetRpcHandler();
  }
  console.log("\n--- Loader: missing/invalid identity ---");
  console.log("TEST: null identity \u2192 sign-in required error");
  {
    setAuthorized();
    let rpcCalled = false;
    __setRpcHandler(async () => {
      rpcCalled = true;
      return { data: VALID_METRICS, error: null };
    });
    const loader = new DashboardMetricsLoader();
    const result = await loader.load(null);
    assert(result.kind === "error", "kind = error");
    assert(result.message === ERR_SIGN_IN, "message = sign-in required");
    assert(!rpcCalled, "RPC never called");
    loader.unmount();
    __resetRpcHandler();
  }
  console.log("\n--- Loader: transport/auth gate ---");
  console.log("TEST: transport down \u2192 waiting error, no RPC");
  {
    setTransportDown();
    let rpcCalled = false;
    __setRpcHandler(async () => {
      rpcCalled = true;
      return { data: VALID_METRICS, error: null };
    });
    const loader = new DashboardMetricsLoader();
    const result = await loader.load(ADMIN_IDENTITY);
    assert(result.kind === "error", "kind = error");
    assert(result.message === ERR_WAITING, "message = waiting");
    assert(!rpcCalled, "RPC never called when transport down");
    loader.unmount();
    __resetRpcHandler();
  }
  console.log("TEST: auth offline-restored \u2192 waiting error, no RPC");
  {
    setAuthOffline();
    let rpcCalled = false;
    __setRpcHandler(async () => {
      rpcCalled = true;
      return { data: VALID_METRICS, error: null };
    });
    const loader = new DashboardMetricsLoader();
    const result = await loader.load(ADMIN_IDENTITY);
    assert(result.kind === "error", "kind = error");
    assert(result.message === ERR_WAITING, "message = waiting");
    assert(!rpcCalled, "RPC never called when offline-restored");
    loader.unmount();
    __resetRpcHandler();
  }
  console.log("\n--- Loader: RPC errors ---");
  console.log("TEST: RPC returns error \u2192 unavailable");
  {
    setAuthorized();
    __setRpcHandler(async () => ({
      data: null,
      error: { message: "function get_dashboard_metrics does not exist", code: "42883" }
    }));
    const loader = new DashboardMetricsLoader();
    const result = await loader.load(ADMIN_IDENTITY);
    assert(result.kind === "error", "kind = error");
    assert(result.message === ERR_UNAVAILABLE, "message = unavailable");
    loader.unmount();
    __resetRpcHandler();
  }
  console.log("TEST: RPC throws \u2192 unavailable (try/catch)");
  {
    setAuthorized();
    __setRpcHandler(async () => {
      throw new Error("network failure");
    });
    const loader = new DashboardMetricsLoader();
    const result = await loader.load(ADMIN_IDENTITY);
    assert(result.kind === "error", "kind = error after throw");
    assert(result.message === ERR_UNAVAILABLE, "message = unavailable");
    loader.unmount();
    __resetRpcHandler();
  }
  console.log("TEST: RPC error does NOT become zero-as-success");
  {
    setAuthorized();
    __setRpcHandler(async () => ({ data: null, error: { message: "permission denied" } }));
    const loader = new DashboardMetricsLoader();
    const result = await loader.load(ADMIN_IDENTITY);
    assert(result.kind !== "success", "NOT success");
    assert(result.kind === "error", "kind = error");
    loader.unmount();
    __resetRpcHandler();
  }
  console.log("\n--- Loader: malformed results ---");
  console.log("TEST: empty object \u2192 unavailable");
  {
    setAuthorized();
    __setRpcHandler(async () => ({ data: {}, error: null }));
    const loader = new DashboardMetricsLoader();
    const result = await loader.load(ADMIN_IDENTITY);
    assert(result.kind === "error", "kind = error for empty object");
    assert(result.message === ERR_UNAVAILABLE, "message = unavailable");
    loader.unmount();
    __resetRpcHandler();
  }
  console.log("TEST: null data, null error \u2192 unavailable");
  {
    setAuthorized();
    __setRpcHandler(async () => ({ data: null, error: null }));
    const loader = new DashboardMetricsLoader();
    const result = await loader.load(ADMIN_IDENTITY);
    assert(result.kind === "error", "kind = error for null/null");
    loader.unmount();
    __resetRpcHandler();
  }
  console.log("TEST: negative count \u2192 unavailable");
  {
    setAuthorized();
    __setRpcHandler(async () => ({ data: { ...VALID_METRICS, total_leads: -5 }, error: null }));
    const loader = new DashboardMetricsLoader();
    const result = await loader.load(ADMIN_IDENTITY);
    assert(result.kind === "error", "kind = error for negative");
    loader.unmount();
    __resetRpcHandler();
  }
  console.log("TEST: missing field \u2192 unavailable");
  {
    setAuthorized();
    __setRpcHandler(async () => ({ data: { ...VALID_METRICS, hot_leads: void 0 }, error: null }));
    const loader = new DashboardMetricsLoader();
    const result = await loader.load(ADMIN_IDENTITY);
    assert(result.kind === "error", "kind = error for missing field");
    loader.unmount();
    __resetRpcHandler();
  }
  console.log("\n--- Loader: stale-response guard ---");
  console.log("TEST: identity change during in-flight \u2192 stale");
  {
    setAuthorized();
    const resolvers = [];
    __setRpcHandler(async () => new Promise((resolve) => {
      resolvers.push(resolve);
    }));
    const loader = new DashboardMetricsLoader();
    const firstPromise = loader.load(ADMIN_IDENTITY);
    await flushPromises();
    loader.invalidate();
    const secondPromise = loader.load(REP_IDENTITY);
    await flushPromises();
    resolvers.forEach((r) => r({ data: VALID_METRICS, error: null }));
    const [firstResult, secondResult] = await Promise.all([firstPromise, secondPromise]);
    assert(firstResult.kind === "stale", "first result is stale after identity change");
    assert(secondResult.kind === "success", "second result succeeds after identity change");
    loader.unmount();
    __resetRpcHandler();
  }
  console.log("TEST: unmount during in-flight \u2192 stale");
  {
    setAuthorized();
    __setRpcHandler(async () => new Promise((resolve) => {
      setTimeout(() => resolve({ data: VALID_METRICS, error: null }), 50);
    }));
    const loader = new DashboardMetricsLoader();
    const promise = loader.load(ADMIN_IDENTITY);
    loader.unmount();
    const result = await promise;
    assert(result.kind === "stale", "result is stale after unmount");
    __resetRpcHandler();
  }
  console.log("TEST: auth loss during in-flight \u2192 stale or waiting, not success");
  {
    setAuthorized();
    const resolvers = [];
    __setRpcHandler(async () => new Promise((resolve) => {
      resolvers.push(resolve);
    }));
    const loader = new DashboardMetricsLoader();
    const promise = loader.load(ADMIN_IDENTITY);
    await flushPromises();
    setAuthModeState("unauthenticated");
    resolvers.forEach((r) => r({ data: VALID_METRICS, error: null }));
    const result = await promise;
    assert(result.kind !== "success", "NOT success after auth loss");
    assert(
      result.kind === "stale" || result.kind === "error" && result.message === ERR_WAITING,
      "stale or waiting after auth loss"
    );
    loader.unmount();
    __resetRpcHandler();
  }
  console.log("\n--- Loader: overlapping requests ---");
  console.log("TEST: overlapping requests \u2014 later invalidates earlier");
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
    assert(firstResult.kind === "stale", "first is stale");
    assert(secondResult.kind === "success", "second succeeds");
    assert(secondResult.data.total_leads === 200, "second has total_leads = 200");
    loader.unmount();
    __resetRpcHandler();
  }
  console.log("\n--- Loader: reconnect resume ---");
  console.log("TEST: offline \u2192 online \u2192 success");
  {
    setTransportDown();
    __setRpcHandler(async () => ({ data: VALID_METRICS, error: null }));
    const loader = new DashboardMetricsLoader();
    const offlineResult = await loader.load(ADMIN_IDENTITY);
    assert(offlineResult.kind === "error", "offline \u2192 error");
    assert(offlineResult.message === ERR_WAITING, "offline \u2192 waiting");
    setAuthorized();
    const onlineResult = await loader.load(ADMIN_IDENTITY);
    assert(onlineResult.kind === "success", "online \u2192 success");
    assert(onlineResult.data.total_leads === 100, "online \u2192 total_leads = 100");
    loader.unmount();
    __resetRpcHandler();
  }
  console.log("TEST: auth offline-restored \u2192 online \u2192 success");
  {
    setAuthOffline();
    __setRpcHandler(async () => ({ data: VALID_METRICS, error: null }));
    const loader = new DashboardMetricsLoader();
    const offlineResult = await loader.load(ADMIN_IDENTITY);
    assert(offlineResult.kind === "error", "offline-restored \u2192 error");
    setAuthorized();
    const onlineResult = await loader.load(ADMIN_IDENTITY);
    assert(onlineResult.kind === "success", "online after offline-restored \u2192 success");
    loader.unmount();
    __resetRpcHandler();
  }
  console.log("\n--- Loader: post-publish re-check ---");
  console.log("TEST: transport goes down during in-flight \u2192 waiting, not success");
  {
    setAuthorized();
    const resolvers = [];
    __setRpcHandler(async () => new Promise((resolve) => {
      resolvers.push(resolve);
    }));
    const loader = new DashboardMetricsLoader();
    const promise = loader.load(ADMIN_IDENTITY);
    await flushPromises();
    setTransportDown();
    resolvers.forEach((r) => r({ data: VALID_METRICS, error: null }));
    const result = await promise;
    assert(result.kind !== "success", "NOT success after transport down");
    assert(
      result.kind === "stale" || result.kind === "error" && result.message === ERR_WAITING,
      "stale or waiting after transport down during in-flight"
    );
    loader.unmount();
    __resetRpcHandler();
  }
  console.log("\n--- deriveDisplayState ---");
  console.log("TEST: current-user RPC error \u2192 error visible, loading false, Retry enabled");
  {
    const s = deriveDisplayState(
      false,
      ERR_UNAVAILABLE,
      null,
      ADMIN_IDENTITY,
      ADMIN_IDENTITY,
      EMPTY_DASHBOARD
    );
    assert(s.showError, "error visible");
    assert(!s.showLoading, "loading false");
    assert(s.displayData.total_leads === 0, "no metrics shown");
  }
  console.log("TEST: Retry in progress \u2192 loading true, Retry disabled");
  {
    const s = deriveDisplayState(
      true,
      "",
      null,
      null,
      ADMIN_IDENTITY,
      EMPTY_DASHBOARD
    );
    assert(s.showLoading, "loading true");
    assert(!s.showError, "error not shown during loading");
  }
  console.log("TEST: Retry success \u2192 metrics visible, error cleared");
  {
    const s = deriveDisplayState(
      false,
      "",
      ADMIN_IDENTITY,
      null,
      ADMIN_IDENTITY,
      VALID_METRICS
    );
    assert(!s.showLoading, "loading false");
    assert(!s.showError, "error cleared");
    assert(s.displayData.total_leads === 100, "metrics visible");
  }
  console.log("TEST: identity change \u2192 old data and old error hidden before effects");
  {
    const sData = deriveDisplayState(
      false,
      "",
      ADMIN_IDENTITY,
      null,
      REP_IDENTITY,
      VALID_METRICS
    );
    assert(sData.displayData.total_leads === 0, "old data hidden (EMPTY)");
    assert(sData.showLoading, "loading shown (identity transition)");
    assert(!sData.showError, "no error during identity transition");
    const sErr = deriveDisplayState(
      false,
      ERR_UNAVAILABLE,
      null,
      ADMIN_IDENTITY,
      REP_IDENTITY,
      EMPTY_DASHBOARD
    );
    assert(!sErr.showError, "old error hidden after identity change");
    assert(sErr.showLoading, "loading shown (identity transition)");
  }
  console.log("TEST: current-identity error after retry start \u2192 error wins over loading");
  {
    const s = deriveDisplayState(
      true,
      ERR_UNAVAILABLE,
      null,
      ADMIN_IDENTITY,
      ADMIN_IDENTITY,
      EMPTY_DASHBOARD
    );
    assert(s.showLoading, "loading shown during in-flight even with stale error");
  }
  console.log("TEST: null currentIdentity (signed out) \u2192 no loading, no error");
  {
    const s = deriveDisplayState(
      false,
      ERR_UNAVAILABLE,
      null,
      null,
      null,
      EMPTY_DASHBOARD
    );
    assert(!s.showLoading, "no loading when signed out");
    assert(!s.showError, "no error when signed out");
  }
  console.log("\n--- EMPTY_DASHBOARD ---");
  assert(EMPTY_DASHBOARD.total_leads === 0, "total_leads = 0");
  assert(Object.values(EMPTY_DASHBOARD).every((v) => v === 0), "all fields are 0");
  console.log("\n--- identityKey: unsupported roles ---");
  assert(identityKey({ authUserId: "x", role: "super_admin", rep_code: "SA" }) === null, "super_admin \u2192 null");
  assert(identityKey({ authUserId: "x", role: "manager", rep_code: "M" }) === null, "manager \u2192 null");
  assert(identityKey({ authUserId: "x", role: "viewer", rep_code: "V" }) === null, "viewer \u2192 null");
  assert(identityKey({ authUserId: "x", role: "guest", rep_code: "G" }) === null, "guest \u2192 null");
  assert(identityKey({ authUserId: "x", role: "support", rep_code: "S" }) === null, "support \u2192 null");
  assert(identityKey({ authUserId: "x", role: "admin", rep_code: "A" }) !== null, "admin still accepted");
  assert(identityKey({ authUserId: "x", role: "sales_rep", rep_code: "R" }) !== null, "sales_rep still accepted");
  console.log("TEST: unsupported role \u2192 no RPC");
  {
    setAuthorized();
    let rpcCalled = false;
    __setRpcHandler(async () => {
      rpcCalled = true;
      return { data: VALID_METRICS, error: null };
    });
    const loader = new DashboardMetricsLoader();
    const result = await loader.load(identityKey({ authUserId: "x", role: "super_admin", rep_code: "SA" }));
    assert(result.kind === "error", "unsupported role \u2192 error (not RPC)");
    assert(result.message === ERR_SIGN_IN, "unsupported role \u2192 sign-in required");
    assert(!rpcCalled, "RPC never called for unsupported role");
    loader.unmount();
    __resetRpcHandler();
  }
  console.log("\n--- Lifecycle wiring: StrictMode ---");
  console.log("TEST: StrictMode setup\u2192cleanup\u2192setup \u2192 successful loading");
  {
    setAuthorized();
    __setRpcHandler(async () => ({ data: VALID_METRICS, error: null }));
    const harness = new DashboardWiringHarness();
    harness.setUser({ authUserId: "auth-admin", role: "admin", rep_code: "ADMIN" });
    harness.setAuthMode("online");
    harness.setIsOnline(true);
    harness.strictModeCycle();
    await flushPromises();
    const s = harness.state;
    assert(!s.showLoading, "StrictMode: not loading after setup\u2192cleanup\u2192setup");
    assert(!s.showError, "StrictMode: no error after setup\u2192cleanup\u2192setup");
    assert(s.displayData.total_leads === 100, "StrictMode: shows metrics = 100 after cycle");
    assert(s.dataIdentity === "auth-admin|admin|ADMIN", "StrictMode: data identity set correctly");
    __resetRpcHandler();
  }
  console.log("TEST: StrictMode cleanup does not permanently unmount loader");
  {
    setAuthorized();
    __setRpcHandler(async () => ({ data: VALID_METRICS, error: null }));
    const harness = new DashboardWiringHarness();
    harness.setUser({ authUserId: "auth-admin", role: "admin", rep_code: "ADMIN" });
    harness.setAuthMode("online");
    harness.setIsOnline(true);
    harness.triggerEffect();
    await flushPromises();
    assert(harness.state.displayData.total_leads === 100, "first setup loads data");
    harness.cleanup();
    harness.triggerEffect();
    await flushPromises();
    assert(harness.state.displayData.total_leads === 100, "re-setup after cleanup loads data");
    assert(!harness.state.showLoading, "re-setup not stuck loading");
    __resetRpcHandler();
  }
  console.log("\n--- Lifecycle wiring: Retry ---");
  console.log("TEST: RPC error \u2192 Retry \u2192 success \u2192 metrics visible");
  {
    setAuthorized();
    const harness = new DashboardWiringHarness();
    harness.setUser({ authUserId: "auth-admin", role: "admin", rep_code: "ADMIN" });
    harness.setAuthMode("online");
    harness.setIsOnline(true);
    __setRpcHandler(async () => ({ data: null, error: { message: "function missing" } }));
    harness.triggerEffect();
    await flushPromises();
    let s = harness.state;
    assert(s.showError, "error state visible after RPC error");
    assert(s.errorMessage === ERR_UNAVAILABLE, "error message = unavailable");
    assert(s.displayData.total_leads === 0, "no metrics shown on error");
    __setRpcHandler(async () => ({ data: VALID_METRICS, error: null }));
    await harness.fetchData();
    await flushPromises();
    s = harness.state;
    assert(!s.showError, "no error after successful Retry");
    assert(!s.showLoading, "not loading after successful Retry");
    assert(s.displayData.total_leads === 100, "metrics visible after Retry = 100");
    __resetRpcHandler();
  }
  console.log("TEST: Retry sets loading and clears previous error at start");
  {
    setAuthorized();
    const resolvers = [];
    const harness = new DashboardWiringHarness();
    harness.setUser({ authUserId: "auth-admin", role: "admin", rep_code: "ADMIN" });
    harness.setAuthMode("online");
    harness.setIsOnline(true);
    __setRpcHandler(async () => ({ data: null, error: { message: "fail" } }));
    harness.triggerEffect();
    await flushPromises();
    assert(harness.state.showError, "error shown before Retry");
    __setRpcHandler(async () => new Promise((resolve) => {
      resolvers.push(resolve);
    }));
    const retryPromise = harness.fetchData();
    assert(harness.state.showLoading, "loading set at Retry start");
    assert(!harness.state.showError, "error cleared at Retry start");
    resolvers.forEach((r) => r({ data: VALID_METRICS, error: null }));
    await retryPromise;
    await flushPromises();
    assert(!harness.state.showLoading, "not loading after Retry completes");
    assert(harness.state.displayData.total_leads === 100, "metrics shown after Retry");
    __resetRpcHandler();
  }
  console.log("TEST: stale completion does not clear another request's loading/error");
  {
    setAuthorized();
    const resolvers = [];
    const harness = new DashboardWiringHarness();
    harness.setUser({ authUserId: "auth-admin", role: "admin", rep_code: "ADMIN" });
    harness.setAuthMode("online");
    harness.setIsOnline(true);
    __setRpcHandler(async () => new Promise((resolve) => {
      resolvers.push(resolve);
    }));
    harness.triggerEffect();
    await flushPromises();
    assert(harness.state.showLoading, "first request: loading");
    harness.triggerEffect();
    await flushPromises();
    assert(harness.state.showLoading, "second request: loading");
    if (resolvers[0]) resolvers[0]({ data: { ...VALID_METRICS, total_leads: 999 }, error: null });
    await flushPromises();
    assert(harness.state.displayData.total_leads !== 999, "stale completion does not set data");
    assert(harness.state.showLoading, "still loading after stale resolves");
    if (resolvers[1]) resolvers[1]({ data: VALID_METRICS, error: null });
    await flushPromises();
    assert(harness.state.displayData.total_leads === 100, "current request succeeds with 100");
    assert(!harness.state.showLoading, "not loading after current resolves");
    __resetRpcHandler();
  }
  console.log("\n--- Lifecycle wiring: identity change ---");
  console.log("TEST: identity change \u2192 no previous-user metrics displayed");
  {
    setAuthorized();
    const harness = new DashboardWiringHarness();
    __setRpcHandler(async () => ({ data: VALID_METRICS, error: null }));
    harness.setUser({ authUserId: "auth-admin", role: "admin", rep_code: "ADMIN" });
    harness.setAuthMode("online");
    harness.setIsOnline(true);
    harness.triggerEffect();
    await flushPromises();
    assert(harness.state.displayData.total_leads === 100, "admin sees 100");
    assert(harness.state.dataIdentity === "auth-admin|admin|ADMIN", "admin identity set");
    harness.setUser({ authUserId: "auth-rep", role: "sales_rep", rep_code: "REP" });
    const stateBeforeEffect = harness.state;
    assert(stateBeforeEffect.showLoading, "identity change: shows loading before effect");
    assert(stateBeforeEffect.displayData.total_leads === 0, "identity change: old metrics hidden (EMPTY) before effect");
    assert(!stateBeforeEffect.showError, "identity change: no error before effect");
    harness.triggerEffect();
    await flushPromises();
    assert(harness.state.displayData.total_leads === 100, "rep sees 100 after loading");
    assert(harness.state.dataIdentity === "auth-rep|sales_rep|REP", "rep identity set");
    assert(!harness.state.showLoading, "rep: not loading after data loads");
    __resetRpcHandler();
  }
  console.log("TEST: identity change with pending data \u2014 old metrics never flash");
  {
    setAuthorized();
    const resolvers = [];
    const harness = new DashboardWiringHarness();
    __setRpcHandler(async () => ({ data: { ...VALID_METRICS, total_leads: 100 }, error: null }));
    harness.setUser({ authUserId: "auth-admin", role: "admin", rep_code: "ADMIN" });
    harness.setAuthMode("online");
    harness.setIsOnline(true);
    harness.triggerEffect();
    await flushPromises();
    assert(harness.state.displayData.total_leads === 100, "admin loaded 100");
    harness.setUser({ authUserId: "auth-rep", role: "sales_rep", rep_code: "REP" });
    assert(harness.state.displayData.total_leads === 0, "rep: old admin data hidden before effect");
    assert(harness.state.showLoading, "rep: loading shown before effect");
    __setRpcHandler(async () => new Promise((resolve) => {
      resolvers.push(resolve);
    }));
    harness.triggerEffect();
    await flushPromises();
    assert(harness.state.showLoading, "rep: loading while RPC pending");
    assert(harness.state.displayData.total_leads === 0, "rep: no old data while RPC pending");
    resolvers.forEach((r) => r({ data: { ...VALID_METRICS, total_leads: 50 }, error: null }));
    await flushPromises();
    assert(harness.state.displayData.total_leads === 50, "rep: sees 50 after load");
    __resetRpcHandler();
  }
  console.log(`
=== Results: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exitCode = 1;
}
main().catch((err) => {
  console.error("Test runner crashed:", err);
  process.exitCode = 1;
});
