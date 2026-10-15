const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
function load(file, dependencies) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX }
  }).outputText, { exports, require: name => {
    if (!(name in dependencies)) throw new Error('Unexpected import: ' + name);
    return dependencies[name];
  }});
  return exports;
}
const options = load('src/whatsappStatusFilter.ts', {});
const parser = load('src/dashboardWhatsAppCounts.ts', { './whatsappStatusFilter': options });
const counts = Object.fromEntries(options.WHATSAPP_STATUS_OPTIONS.map((option, index) => [option.value, index]));
assert.ok(parser.parseWhatsAppCounts(counts));
for (const bad of [null, [], {}, { ...counts, READ: null }, { ...counts, READ: -1 }, { ...counts, READ: 1.2 }, { ...counts, READ: '1' }, { ...counts, READ: Number.MAX_SAFE_INTEGER + 1 }]) assert.equal(parser.parseWhatsAppCounts(bad), null);
let auth = { user: { id: 'A' }, authMode: 'online' };
let online = true;
let slots = [], cursor = 0, queued = [], pending = [], calls = 0;
const react = {
  useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = initial; return [slots[i], value => { slots[i] = typeof value === 'function' ? value(slots[i]) : value; }]; },
  useRef(initial) { const i = cursor++; if (!(i in slots)) slots[i] = { current: initial }; return slots[i]; },
  useEffect(fn, deps) { const i = cursor++; const old = slots[i]; if (!old || deps.some((v, j) => v !== old.deps[j])) queued.push(() => { old?.cleanup?.(); slots[i] = { deps, cleanup: fn() }; }); }
};
const jsx = (type, props) => ({ type, props });
const Component = load('src/DashboardWhatsAppSection.tsx', {
  react, 'react/jsx-runtime': { jsx, jsxs: jsx }, 'lucide-react': { ArrowRight: 'arrow', MessageCircle: 'message' },
  './AuthContext': { useAuth: () => auth }, './capture/useOnlineStatus': { useOnlineStatus: () => online },
  './dashboardMetricsLoader': { identityKey: user => user?.id ?? null, isAuthorized: () => online && auth.authMode === 'online' },
  './supabaseClient': { supabase: { rpc: name => { assert.equal(name, 'get_dashboard_whatsapp_status_counts'); calls++; return new Promise(resolve => pending.push(resolve)); } } },
  './whatsappStatusFilter': options, './dashboardWhatsAppCounts': parser,
}).default;
let refresh = 0, navigated;
function render() { cursor = 0; const tree = Component({ refresh, onNavigate: statuses => navigated = statuses }); const effects = queued; queued = []; effects.forEach(fn => fn()); return tree; }
function nodes(tree) { if (!tree || typeof tree !== 'object') return []; return [tree, ...[tree.props?.children].flat(Infinity).flatMap(nodes)]; }
const tick = () => new Promise(resolve => setImmediate(resolve));
(async () => {
  render(); assert.equal(calls, 1);
  pending.shift()({ data: counts, error: null }); await tick();
  let tree = render();
  const buttons = nodes(tree).filter(node => node.type === 'button');
  assert.equal(buttons.length, 8);
  buttons[0].props.onClick(); assert.equal(navigated[0], 'READ');
  refresh++; render(); assert.equal(calls, 2);
  auth = { user: { id: 'B' }, authMode: 'online' }; render(); assert.equal(calls, 3);
  pending.shift()({ data: counts, error: null }); await tick();
  assert.equal(nodes(render()).filter(node => node.type === 'button').length, 0);
  pending.shift()({ data: null, error: {} }); await tick();
  tree = render(); const retry = nodes(tree).find(node => node.type === 'button');
  assert.equal(retry.props.children, 'Retry'); retry.props.onClick(); render(); assert.equal(calls, 4);
  online = false; render(); pending.shift()({ data: counts, error: null }); await tick();
  assert.equal(nodes(render()).filter(node => node.type === 'button').length, 0);
  online = true; auth.authMode = 'offline-restored'; render(); assert.equal(calls, 4);
  auth.authMode = 'online'; render(); assert.equal(calls, 5);
  auth.user = null; assert.equal(render(), null);
  pending.shift()({ data: counts, error: null }); await tick(); assert.equal(render(), null);
  const dashboard = fs.readFileSync(path.join(root, 'src/DashboardPage.tsx'), 'utf8');
  assert.ok(!dashboard.includes('<SectionLabel>System Status</SectionLabel>'));
  const leads = fs.readFileSync(path.join(root, 'src/LeadsPage.tsx'), 'utf8');
  assert.ok(leads.includes('normalizeWhatsAppStatuses(initialFilters?.whatsappStatuses ?? init.adv.whatsappStatuses)'));
  console.log('Dashboard WhatsApp: parser, hook lifecycle/races, retry, auth gates, navigation and wiring checks passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
