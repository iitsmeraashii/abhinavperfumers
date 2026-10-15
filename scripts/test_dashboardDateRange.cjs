const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
function load(file, dependencies = {}) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
  }).outputText, { exports, Date, require: name => {
    if (!(name in dependencies)) throw new Error('Unexpected import: ' + name);
    return dependencies[name];
  }});
  return exports;
}
const dates = load('src/dashboardDateRange.ts');
if (process.argv.includes('--dates')) {
  const now = new Date(2026, 9, 16, 12);
  for (const [range, expected] of [['today','2026-10-16'], ['7days','2026-10-10'], ['30days','2026-09-17'], ['90days','2026-07-19']]) {
    const bounds = dates.getDashboardDateBounds(range, now);
    assert.equal(bounds.dateFrom, expected);
    assert.equal(bounds.dateTo, '2026-10-16');
    assert.equal(bounds.from, dates.localDateBoundary(expected));
    assert.equal(bounds.before, dates.localDateBoundary(bounds.dateTo, true));
    assert.equal(new Date(bounds.from).getHours(), 0);
  }
  assert.equal(dates.localDateBoundary('2026-02-30'), null);
  assert.equal(dates.localDateBoundary('bad'), null);
  assert.equal(dates.getDashboardDateBounds('7days', new Date(2026,0,3)).dateFrom, '2025-12-28');
  if (process.env.TZ === 'America/New_York') {
    const spring = dates.getDashboardDateBounds('today', new Date(2026,2,8,12));
    assert.equal((Date.parse(spring.before)-Date.parse(spring.from))/3600000, 23);
    const fall = dates.getDashboardDateBounds('today', new Date(2026,10,1,12));
    assert.equal((Date.parse(fall.before)-Date.parse(fall.from))/3600000, 25);
  }
  console.log(`Calendar boundaries passed: ${process.env.TZ}`);
  process.exit(0);
}
for (const TZ of ['UTC', 'Asia/Kolkata', 'America/New_York']) {
  const run = spawnSync(process.execPath, [__filename, '--dates'], { env: { ...process.env, TZ }, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr); process.stdout.write(run.stdout);
}
let allowed = true, online = true, pending = [], requests = [];
const metrics = load('src/dashboardMetricsLoader.ts', {
  './supabaseClient': { supabase: { rpc: (name, args) => { requests.push({name, args}); return new Promise(resolve => pending.push(resolve)); } } },
  './authModeState': { isCloudSyncAllowed: () => allowed },
  './connectivity/connectivityStore': { isTransportOnline: () => online },
});
(async () => {
  const loader = new metrics.DashboardMetricsLoader();
  const a = dates.getDashboardDateBounds('7days');
  const b = dates.getDashboardDateBounds('90days');
  const first = loader.load('admin-A', a);
  const second = loader.load('admin-A', b);
  assert.equal(requests[0].name, 'get_dashboard_metrics_range');
  assert.equal(requests[0].args.p_from, a.from);
  assert.equal(requests[1].args.p_before, b.before);
  pending.shift()({data: [metrics.EMPTY_DASHBOARD], error: null});
  assert.equal((await first).kind, 'stale');
  pending.shift()({data: [metrics.EMPTY_DASHBOARD], error: null});
  assert.equal((await second).kind, 'success');
  const third = loader.load('rep-B', a); loader.invalidate();
  pending.shift()({data: [metrics.EMPTY_DASHBOARD], error: null});
  assert.equal((await third).kind, 'stale');
  allowed = false; assert.equal((await loader.load('rep-B', a)).kind, 'error');
  assert.equal(requests.length, 3);
  allowed = true;
  const failed = loader.load('rep-B', a);
  pending.shift()({data: null, error: {code: '42883'}});
  assert.equal((await failed).kind, 'error');
  const display = metrics.deriveDisplayState(false, '', 'admin|old-range', null, 'admin|new-range', metrics.EMPTY_DASHBOARD);
  assert.equal(display.showLoading, true);
  // Source checks explicitly cover UI wiring; these are not DOM tests.
  const dashboard = fs.readFileSync(path.join(root,'src/DashboardPage.tsx'),'utf8');
  assert.ok(dashboard.includes("useState<DashboardRange>('30days')"));
  assert.ok(dashboard.includes('dateFrom: bounds.dateFrom, dateTo: bounds.dateTo, ...f'));
  assert.ok(dashboard.includes('[fetchFollowUpCount, fetchSamplesOpenCount, fetchUnreadCount, fetchInvalidLeadsCount, fetchRequiresReviewCount, authMode, isOnline]'));
  const sql = fs.readFileSync(path.join(root,'docs/dashboard-date-range-rpcs.sql'),'utf8');
  assert.equal((sql.match(/SECURITY INVOKER/g)||[]).length, 2);
  assert.equal((sql.match(/sr.auth_user_id = auth.uid\(\)/g)||[]).length, 2);
  assert.equal((sql.match(/v_role = 'admin' OR/g)||[]).length, 2);
  assert.equal((sql.match(/AT TIME ZONE 'UTC'/g)||[]).length, 4);
  console.log('Ranged loader, stale results, auth gates, navigation and SQL guard source checks passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
