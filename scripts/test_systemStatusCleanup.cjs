// Execute production filter helpers/handlers extracted with the TypeScript AST.
// Wiring assertions below are source checks, not browser/DOM tests.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'src/LeadsPage.tsx'), 'utf8');
const ast = ts.createSourceFile('LeadsPage.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const names = ['normalizeSystemStatus', 'readParams', 'buildParams', 'applyAdvanced', 'clearAdvanced', 'removeAdvancedChip'];
const functions = new Map();
function visit(node) {
  if (ts.isFunctionDeclaration(node) && names.includes(node.name?.text)) functions.set(node.name.text, node.getText(ast));
  ts.forEachChild(node, visit);
}
visit(ast);
assert.equal(functions.size, names.length);
const filterModule = { exports: {} };
vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(root, 'src/whatsappStatusFilter.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
}).outputText, { exports: filterModule.exports });
const context = vm.createContext({ ...filterModule.exports, URLSearchParams, window: { location: { search: '' } } });
vm.runInContext(ts.transpileModule([...functions.values()].join('\n'), {
  compilerOptions: { target: ts.ScriptTarget.ES2020 }
}).outputText, context);
let checks = 0;
function check(actual, expected) { assert.deepEqual(actual, expected); checks++; }
for (const value of [undefined, null, '', 'CREATED', 'WHATSAPP_SENT', 'WHATSAPP_FAILED', 'unknown']) {
  check(context.normalizeSystemStatus(value), '');
  context.window.location.search = '?systemStatus=' + encodeURIComponent(value ?? '');
  check(context.readParams().adv.systemStatus, '');
}
context.window.location.search = '?systemStatus=INVALID_LEAD&lead=keep';
const filters = context.readParams().adv;
check(filters.systemStatus, 'INVALID_LEAD');
let params = context.buildParams(0, '', '', null, '', '', filters);
check(params.get('systemStatus'), 'INVALID_LEAD');
check(params.get('lead'), 'keep');
filters.systemStatus = 'WHATSAPP_SENT';
check(context.buildParams(0, '', '', null, '', '', filters).has('systemStatus'), false);
filters.systemStatus = '';
context.EMPTY_ADVANCED = { ...filters };
context.draft = { ...filters, systemStatus: 'INVALID_LEAD' };
context.applied = { ...filters };
context.setApplied = value => { context.applied = value; };
context.setDraft = value => { context.draft = value; };
context.setPage = value => { context.page = value; };
context.setPanelOpen = value => { context.panelOpen = value; };
context.applyAdvanced();
check(context.applied.systemStatus, 'INVALID_LEAD');
check(context.page, 0);
check(context.panelOpen, false);
context.removeAdvancedChip('systemStatus');
check(context.applied.systemStatus, '');
check(context.draft.systemStatus, '');
context.draft.systemStatus = 'INVALID_LEAD';
context.applyAdvanced();
context.clearAdvanced();
check(context.applied.systemStatus, '');
check(context.draft.systemStatus, '');
// Guard the production query and navigation wiring without imitating it.
for (const fragment of [
  "query.eq('system_status', adv.systemStatus)",
  "query.eq('system_status', applied.systemStatus)",
  "systemStatus: normalizeSystemStatus(initialFilters?.systemStatus ?? init.adv.systemStatus)",
  "checked={draft.systemStatus === 'INVALID_LEAD'}",
  "patchDraft('systemStatus', e.target.checked ? 'INVALID_LEAD' : '')",
  "label: 'Invalid leads only', key: 'systemStatus'",
  "if (user.role === 'sales_rep') query = query.eq('sales_rep_code', user.rep_code);"
]) check(source.includes(fragment), true);
check(source.includes('label="System Status"'), false);
const app = fs.readFileSync(path.join(root, 'src/App.tsx'), 'utf8');
check(app.includes("setLeadsInitialFilters({ systemStatus: 'INVALID_LEAD' });"), true);
const dashboard = fs.readFileSync(path.join(root, 'src/DashboardPage.tsx'), 'utf8');
check(dashboard.includes('<SectionLabel>System Status</SectionLabel>'), false);
check(dashboard.includes('deriveInvalidLeadsTileState'), true);
context.window.location.search = '?whatsappStatus=FAILED&whatsappStatus=__not_set__&whatsappStatus=FAILED&whatsappStatus=bad';
const waFilters = context.readParams().adv;
check(Array.from(waFilters.whatsappStatuses), ['FAILED', '__not_set__']);
const waParams = context.buildParams(0, '', '', null, '', '', waFilters);
check(waParams.getAll('whatsappStatus'), ['FAILED', '__not_set__']);
context.draft = waFilters;
context.applyAdvanced();
context.removeAdvancedChip('whatsappStatuses');
check(Array.from(context.applied.whatsappStatuses), []);
check(Array.from(context.draft.whatsappStatuses), []);
console.log(`System Status cleanup: ${checks} assertions passed (helpers/handlers + source wiring checks).`);
