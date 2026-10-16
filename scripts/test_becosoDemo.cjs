const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
function load(source, extras = {}) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText,
    { exports, require: () => ({ jsx: (type, props) => ({type, props}), jsxs: (type, props) => ({type, props}) }), ...extras });
  return exports;
}
const constants = load(fs.readFileSync('src/capture/types.ts', 'utf8'));
assert.deepEqual(Array.from(constants.APPLICATION_OPTIONS), ['Leads Inn', 'Founders Suite', 'Custom Workflow', 'Custom Agent', 'Website + Backend', 'Website (Frontend only)']);
assert.ok(constants.APPLICATION_OPTIONS.every(s => !s.includes(',')));
const source = fs.readFileSync('src/capture/ManualEntryForm.tsx', 'utf8');
const ast = ts.createSourceFile('form.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const fn = ast.statements.find(s => ts.isFunctionDeclaration(s) && s.name.text === 'ApplicationChips');
let open = true, selected = ['Leads Inn', 'Fine Fragrances', 'Incense Sticks'];
const { ApplicationChips } = load(fn.getText(ast)+'\nexport { ApplicationChips };', {
  ...constants, useState: () => [open, value => { open = value; }], inputCls: () => '', FieldLabel: 'label', X: 'icon',
});
const nodes = tree => !tree || typeof tree !== 'object' ? [] : [tree, ...[tree.props?.children].flat(Infinity).flatMap(nodes)];
const render = () => nodes(ApplicationChips({ selected, onChange: value => { selected = Array.from(value); } }));
assert.deepEqual(render().filter(n => n.type === 'input').map(n => n.props.value), ['Fine Fragrances','Incense Sticks']);
render().find(n => n.type === 'input').props.onChange({target:{value:'Legacy interest updated'}});
assert.deepEqual(selected, ['Leads Inn','Legacy interest updated','Incense Sticks']);
render().find(n => n.type === 'button' && n.props.children === 'Founders Suite').props.onClick();
assert.deepEqual(selected, ['Leads Inn','Founders Suite','Legacy interest updated','Incense Sticks']);
render().find(n => n.type === 'button' && n.props.children === 'Others').props.onClick();
assert.ok(selected.includes('Incense Sticks'));
render().find(n => n.props['aria-label'] === 'Remove Legacy interest updated').props.onClick();
assert.deepEqual(selected, ['Leads Inn','Founders Suite','Incense Sticks']);
selected = []; open = false;
render().find(n => n.type === 'button' && n.props.children === 'Others').props.onClick();
render().find(n => n.type === 'input').props.onChange({target:{value:'Custom consulting'}});
assert.deepEqual(selected,['Custom consulting']);
assert.ok(!selected.includes(constants.APPLICATION_OTHER));
const html = fs.readFileSync('index.html','utf8');
assert.ok(html.includes('BecosoWebCo CRM'));
assert.ok(!/Abhinav|ap-favicon|og-image\.png/.test(html));
for (const file of ['src/App.tsx','src/LoginPage.tsx']) {
  const s=fs.readFileSync(file,'utf8'); assert.ok(s.includes('<BrandLogo')); assert.ok(!s.includes('VITE_APP_NAME'));
}
for (const file of ['image copy.png','image copy 2.png','ap-favicon.png','og-image.png']) assert.ok(!fs.existsSync('public/'+file));
assert.ok(fs.existsSync('public/becoso-logo.png'));
console.log('Becoso demo: presets, legacy/custom preservation, removal, new custom input, branding and public-asset checks passed.');
