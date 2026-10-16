const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { createClient } = require('@supabase/supabase-js');
const exportsObject = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/whatsappStatusFilter.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
}).outputText, { exports: exportsObject });
const { normalizeWhatsAppStatuses, buildLeadFilterOr } = exportsObject;
const base = { whatsappStatuses: [], temperature: '', state: '', country: '' };
assert.equal(buildLeadFilterOr(base), null);
assert.deepEqual(Array.from(normalizeWhatsAppStatuses(['FAILED', 'READ', 'FAILED', 'null', 'PROCESSING', 'x),id.gt.0'])), ['READ', 'FAILED']);
assert.equal(buildLeadFilterOr({ ...base, whatsappStatuses: ['__not_set__'] }), 'and(or(whatsapp_status.is.null))');
assert.equal(buildLeadFilterOr({ ...base, whatsappStatuses: ['processing'] }), 'and(or(whatsapp_status.eq.processing))');
const expression = buildLeadFilterOr({ whatsappStatuses: ['FAILED', '__not_set__'], temperature: '__unassigned__', state: '__unassigned__', country: '__unassigned__' });
assert.equal(expression, 'and(or(lead_temperature.is.null,lead_temperature.eq.),or(state.is.null,state.eq.),or(country.is.null,country.eq.),or(whatsapp_status.eq.FAILED,whatsapp_status.is.null))');
// Inspect real Supabase builder URLs without awaiting or sending any request.
const client = createClient('https://example.supabase.co', 'test-key', { auth: { persistSession: false, autoRefreshToken: false } });
for (const table of ['leads_list_view', 'lead_entries']) {
  const query = client.from(table).select('*', { count: 'exact' })
    .eq('sales_rep_code', 'REP_A').eq('system_status', 'INVALID_LEAD').or(expression).range(20, 39);
  assert.equal(query.url.searchParams.get('sales_rep_code'), 'eq.REP_A');
  assert.equal(query.url.searchParams.get('system_status'), 'eq.INVALID_LEAD');
  assert.equal(query.url.searchParams.get('or'), `(${expression})`);
  assert.equal(query.url.searchParams.get('limit'), '20');
}
const source = fs.readFileSync(path.join(__dirname, '../src/LeadsPage.tsx'), 'utf8');
assert.ok(source.includes("buildLeadFilterOr({ ...adv, repFilter: user.role === 'admin' ? repFilt : '' })"));
assert.ok(source.includes("buildLeadFilterOr({ ...applied, repFilter: user.role === 'admin' ? repFilter : '' })"));
assert.equal((source.match(/query = query\.or\(/g) || []).length, 2);
const unassignedRep = buildLeadFilterOr({ ...base, repFilter: '__unassigned__', country: '__unassigned__', whatsappStatuses: ['READ'] });
assert.equal(unassignedRep, 'and(or(country.is.null,country.eq.),or(sales_rep_code.is.null,sales_rep_code.eq.),or(whatsapp_status.eq.READ))');
assert.equal(buildLeadFilterOr({ ...base, repFilter: 'REP_A' }), null);
for (const table of ['leads_list_view', 'lead_entries']) {
  const query = client.from(table).select('*').eq('event_code', 'EVENT_A')
    .eq('country', ' India ').eq('lead_status', 'QUALIFIED').or(unassignedRep);
  assert.equal(query.url.searchParams.get('event_code'), 'eq.EVENT_A');
  assert.equal(query.url.searchParams.get('country'), 'eq. India ');
  assert.equal(query.url.searchParams.get('lead_status'), 'eq.QUALIFIED');
  assert.equal(query.url.searchParams.get('or'), `(${unassignedRep})`);
}
// Source wiring checks supplement the real builder assertions above.
assert.ok(source.includes('initialFilters?.country ?? init.adv.country'));
assert.ok(source.includes('initialFilters?.state ?? init.adv.state'));
assert.ok(source.includes('initialFilters?.repCode ?? init.repFilter'));
assert.ok(source.includes("else if (repFilter && repFilter !== '__unassigned__') query = query.eq('sales_rep_code', repFilter)"));
assert.ok(source.includes('const effectiveStatus = statusFilter || applied.leadStatus'));
const app = fs.readFileSync(path.join(__dirname, '../src/App.tsx'), 'utf8');
const eventNavigation = app.slice(app.indexOf('function handleViewLeads('), app.indexOf('\n  function ', app.indexOf('function handleViewLeads(') + 1));
assert.ok(eventNavigation.includes("url.search = ''"));
assert.ok(eventNavigation.includes('setLeadsEventFilter(eventCode)'));
assert.ok(eventNavigation.includes('setLeadsInitialFilters(filters)'));
console.log('WhatsApp/event filters: 34 assertions passed; no requests sent.');
