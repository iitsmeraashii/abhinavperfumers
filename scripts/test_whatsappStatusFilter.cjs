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
assert.ok(source.includes('buildLeadFilterOr(adv)'));
assert.ok(source.includes('buildLeadFilterOr(applied)'));
assert.equal((source.match(/query = query\.or\(/g) || []).length, 2);
console.log('WhatsApp filter: 16 assertions passed; no requests sent.');
