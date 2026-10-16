// Exercise the production Layout render decisions without mounting cloud pages.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
let online = true;
let authMode = 'online';
let role = 'admin';
let slots = [], cursor = 0;
const jsx = (type, props) => ({ type, props });
const nodes = tree => !tree || typeof tree !== 'object' ? [] : [tree, ...[tree.props?.children].flat(Infinity).flatMap(nodes)];
const react = {
  useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial; return [slots[i], value => { slots[i] = typeof value === 'function' ? value(slots[i]) : value; }]; },
  useRef(value) { const i = cursor++; if (!(i in slots)) slots[i] = { current: value }; return slots[i]; },
  useEffect() {},
};
const store = {};
const location = { search: '', href: 'https://example.test/' };
const history = { pushState(_a, _b, url) { location.href = url; location.search = new URL(url).search; }, replaceState(_a, _b, url) { location.href = url; location.search = new URL(url).search; } };
const stubs = {
  react,
  'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'fragment' },
  'lucide-react': new Proxy({}, { get: (_, name) => name }),
  './AuthContext': { useAuth: () => ({ user: { name: 'Test', role, authUserId: 'owner', rep_code: 'REP' }, authMode, logout() {} }) },
  './EventContext': { useEvent: () => ({ clearEvent() {} }) },
  './capture/useOnlineStatus': { useOnlineStatus: () => online },
  './alpe/useAlpeScheduler': { useAlpeScheduler() {} },
};
function load(file, extra = '') {
  const exports = {};
  const source = fs.readFileSync(file, 'utf8').replace(/import\.meta\.env\.[A-Z_]+/g, '"Test"') + extra;
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX } }).outputText, {
    exports, require: name => stubs[name] || { default: name }, URL, URLSearchParams,
    window: { location, history }, localStorage: { getItem: key => store[key] ?? null, setItem: (key, value) => { store[key] = value; } },
  });
  return exports;
}
const { Layout } = load('src/App.tsx', '\nexport { Layout };');
const render = () => { cursor = 0; return Layout(); };
const has = (tree, name) => nodes(tree).some(node => node.type === './' + name);
function reset(tab, search = '') { slots = []; store.activeTab = tab; location.search = search; location.href = 'https://example.test/' + search; }
const cloudPages = {
  dashboard: 'DashboardPage', leads: 'LeadsPage', conversations: 'ConversationsPage',
  events: 'EventsPage', salesreps: 'SalesRepsPage',
  whatsapp_assets: 'WhatsAppAssetsPage', followups: 'FollowUpsPage', account: 'MyAccountPage',
};
for (const [tab, page] of Object.entries(cloudPages)) {
  reset(tab); online = true; authMode = 'online';
  assert.ok(has(render(), page), tab + ' online');
  online = false; let tree = render();
  assert.ok(has(tree, 'OnlinePageUnavailable')); assert.ok(!has(tree, page));
  online = true; authMode = 'offline-restored'; tree = render();
  assert.ok(has(tree, 'OnlinePageUnavailable')); assert.ok(!has(tree, page));
  authMode = 'online'; assert.ok(has(render(), page), tab + ' restored');
}
for (const [tab, page] of [['capture', 'CaptureLeadPage'], ['queue', 'LeadQueuePage']]) {
  reset(tab);
  for (const [network, mode] of [[true, 'online'], [false, 'offline-restored'], [true, 'offline-restored'], [true, 'online']]) {
    online = network; authMode = mode;
    const tree = render(); assert.ok(has(tree, page)); assert.ok(!has(tree, 'OnlinePageUnavailable'));
  }
}
for (const userRole of ['admin', 'sales_rep']) {
  role = userRole; reset('queue', '?lead=lead-123'); online = false; authMode = 'offline-restored';
  let tree = render(); assert.ok(has(tree, 'OnlinePageUnavailable')); assert.ok(!has(tree, 'LeadDetailPage'));
  online = true; assert.ok(!has(render(), 'LeadDetailPage'));
  authMode = 'online'; tree = render(); assert.ok(has(tree, 'LeadDetailPage'));
  assert.equal(nodes(tree).find(n => n.type === './LeadDetailPage').props.leadId, 'lead-123');
}
reset('capture', '?followup=followup-123'); online = false; authMode = 'offline-restored';
let tree = render(); assert.ok(has(tree, 'CaptureLeadPage')); assert.ok(!has(tree, 'FollowUpCompleteModal'));
assert.ok(has(tree, 'OnlinePageUnavailable'));
online = true; assert.ok(!has(render(), 'FollowUpCompleteModal'));
authMode = 'online'; assert.ok(has(render(), 'FollowUpCompleteModal'));
online = false; tree = render();
nodes(tree).find(n => n.type === './OnlinePageUnavailable').props.onQueue();
tree = render(); assert.ok(has(tree, 'LeadQueuePage')); assert.ok(!has(tree, 'OnlinePageUnavailable'));
assert.equal(location.search, '');
reset('dashboard'); online = false; authMode = 'offline-restored'; tree = render();
nodes(tree).find(n => n.type === './OnlinePageUnavailable').props.onCapture();
assert.ok(has(render(), 'CaptureLeadPage'));
const Notice = load('src/OnlinePageUnavailable.tsx').default;
const text = tree => typeof tree === 'string' ? tree : !tree || typeof tree !== 'object' ? '' : [tree.props?.children].flat(Infinity).map(text).join(' ');
assert.ok(text(Notice({ online: false })).includes('You’re offline'));
assert.ok(text(Notice({ online: true })).includes('session has not been verified'));
console.log('Online page availability: all tabs, transport/auth transitions, admin/rep deep links, follow-up modal, capture/queue preservation and navigation passed.');
