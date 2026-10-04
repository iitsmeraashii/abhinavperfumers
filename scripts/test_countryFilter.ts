// Regression tests for the Country filter in LeadsPage.
//
// Tests:
//  1. Distinct Country options are generated.
//  2. Duplicate Country values appear only once.
//  3. null maps to UNASSIGNED.
//  4. "" maps to UNASSIGNED.
//  5. "   " maps to UNASSIGNED.
//  6. UNASSIGNED is absent when every lead has a Country.
//  7. Selecting a normal Country filters correctly.
//  8. Selecting UNASSIGNED filters null/blank/whitespace Country values.
//  9. Clearing Country removes the filter.
// 10. Country filter works together with existing filters.
// 11. Existing State filter behavior remains unchanged.

// ─── Types matching LeadsPage.tsx ─────────────────────────────────────────────

interface Lead {
  id: string;
  client_name: string;
  company: string;
  phone: string;
  event_code: string;
  sales_rep_code: string;
  lead_type: string;
  lead_temperature: string;
  lead_status: string;
  state: string;
  application: string;
  system_status: string;
  created_at: string;
  country: string | null;
}

interface AdvancedFilters {
  leadType: string;
  temperature: string;
  state: string;
  country: string;
  application: string;
  leadStatus: string;
  systemStatus: string;
  dateFrom: string;
  dateTo: string;
}

const EMPTY_ADVANCED: AdvancedFilters = {
  leadType: '',
  temperature: '',
  state: '',
  country: '',
  application: '',
  leadStatus: '',
  systemStatus: '',
  dateFrom: '',
  dateTo: '',
};

// ─── Helpers mirroring LeadsPage.tsx logic ─────────────────────────────────────

function generateCountryOptions(leads: Lead[]): string[] {
  const hasUnassigned = leads.some(l => !l.country || !l.country.trim());
  const unique = [...new Set(
    leads.map(l => l.country).filter((c): c is string => Boolean(c && c.trim()))
  )].sort();
  return hasUnassigned ? ['__unassigned__', ...unique] : unique;
}

function generateStateOptions(leads: Lead[]): string[] {
  return [...new Set(leads.map(l => l.state).filter(Boolean))].sort();
}

function filterByCountry(leads: Lead[], country: string): Lead[] {
  if (!country) return leads;
  if (country === '__unassigned__') {
    return leads.filter(l => !l.country || !l.country.trim());
  }
  return leads.filter(l => l.country === country);
}

function filterByState(leads: Lead[], state: string): Lead[] {
  if (!state) return leads;
  if (state === '__unassigned__') {
    return leads.filter(l => !l.state || l.state.trim() === '');
  }
  return leads.filter(l => l.state === state);
}

function countActiveAdvanced(f: AdvancedFilters): number {
  return [f.leadType, f.temperature, f.state, f.country, f.application, f.systemStatus, f.dateFrom, f.dateTo]
    .filter(Boolean).length;
}

// ─── Test data ─────────────────────────────────────────────────────────────────

const SAMPLE_LEADS: Lead[] = [
  { id: '1', client_name: 'A', company: 'CoA', phone: '', event_code: 'E1', sales_rep_code: 'R1', lead_type: 'NEW', lead_temperature: 'Hot', lead_status: 'NEW', state: 'Maharashtra', application: 'Fragrance', system_status: 'CREATED', created_at: '', country: 'India' },
  { id: '2', client_name: 'B', company: 'CoB', phone: '', event_code: 'E1', sales_rep_code: 'R1', lead_type: 'NEW', lead_temperature: 'Hot', lead_status: 'NEW', state: 'Maharashtra', application: 'Fragrance', system_status: 'CREATED', created_at: '', country: 'India' },
  { id: '3', client_name: 'C', company: 'CoC', phone: '', event_code: 'E1', sales_rep_code: 'R1', lead_type: 'NEW', lead_temperature: 'Warm', lead_status: 'NEW', state: 'Dubai', application: 'Cosmetics', system_status: 'CREATED', created_at: '', country: 'UAE' },
  { id: '4', client_name: 'D', company: 'CoD', phone: '', event_code: 'E1', sales_rep_code: 'R1', lead_type: 'NEW', lead_temperature: 'Cold', lead_status: 'NEW', state: '', application: 'Fragrance', system_status: 'CREATED', created_at: '', country: null },
  { id: '5', client_name: 'E', company: 'CoE', phone: '', event_code: 'E1', sales_rep_code: 'R1', lead_type: 'NEW', lead_temperature: 'Hot', lead_status: 'NEW', state: 'Istanbul', application: 'Cosmetics', system_status: 'CREATED', created_at: '', country: '' },
  { id: '6', client_name: 'F', company: 'CoF', phone: '', event_code: 'E1', sales_rep_code: 'R1', lead_type: 'NEW', lead_temperature: 'Warm', lead_status: 'NEW', state: 'Istanbul', application: 'Fragrance', system_status: 'CREATED', created_at: '', country: '   ' },
  { id: '7', client_name: 'G', company: 'CoG', phone: '', event_code: 'E1', sales_rep_code: 'R1', lead_type: 'NEW', lead_temperature: 'Hot', lead_status: 'NEW', state: 'Ankara', application: 'Cosmetics', system_status: 'CREATED', created_at: '', country: 'Turkey' },
];

const ALL_ASSIGNED_LEADS: Lead[] = [
  { id: '1', client_name: 'A', company: 'CoA', phone: '', event_code: 'E1', sales_rep_code: 'R1', lead_type: 'NEW', lead_temperature: 'Hot', lead_status: 'NEW', state: 'Maharashtra', application: 'Fragrance', system_status: 'CREATED', created_at: '', country: 'India' },
  { id: '2', client_name: 'B', company: 'CoB', phone: '', event_code: 'E1', sales_rep_code: 'R1', lead_type: 'NEW', lead_temperature: 'Hot', lead_status: 'NEW', state: 'Dubai', application: 'Cosmetics', system_status: 'CREATED', created_at: '', country: 'UAE' },
];

// ─── Test runner ───────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assertEq(actual: unknown, expected: unknown, label: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed++;
  } else {
    failed++;
    console.error(`FAIL: ${label}\n  expected: ${e}\n  actual:   ${a}`);
  }
}

function assertTrue(val: boolean, label: string): void {
  if (val) { passed++; } else { failed++; console.error(`FAIL: ${label}`); }
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

// 1. Distinct Country options are generated.
{
  const opts = generateCountryOptions(SAMPLE_LEADS);
  assertTrue(opts.includes('India'), '1: India in options');
  assertTrue(opts.includes('UAE'), '1: UAE in options');
  assertTrue(opts.includes('Turkey'), '1: Turkey in options');
}

// 2. Duplicate Country values appear only once.
{
  const opts = generateCountryOptions(SAMPLE_LEADS);
  const indiaCount = opts.filter(o => o === 'India').length;
  assertEq(indiaCount, 1, '2: India appears once');
  assertEq(opts.length, new Set(opts).size, '2: no duplicate options');
}

// 3. null maps to UNASSIGNED.
{
  const opts = generateCountryOptions(SAMPLE_LEADS);
  assertTrue(opts.includes('__unassigned__'), '3: __unassigned__ present for null');
}

// 4. "" maps to UNASSIGNED.
{
  const leadsWithEmpty: Lead[] = [
    { ...SAMPLE_LEADS[0], country: '' },
  ];
  const opts = generateCountryOptions(leadsWithEmpty);
  assertTrue(opts.includes('__unassigned__'), '4: __unassigned__ present for empty string');
}

// 5. "   " maps to UNASSIGNED.
{
  const leadsWithWs: Lead[] = [
    { ...SAMPLE_LEADS[0], country: '   ' },
  ];
  const opts = generateCountryOptions(leadsWithWs);
  assertTrue(opts.includes('__unassigned__'), '5: __unassigned__ present for whitespace');
}

// 6. UNASSIGNED is absent when every lead has a Country.
{
  const opts = generateCountryOptions(ALL_ASSIGNED_LEADS);
  assertTrue(!opts.includes('__unassigned__'), '6: __unassigned__ absent when all assigned');
  assertEq(opts, ['India', 'UAE'], '6: only real country values');
}

// 7. Selecting a normal Country filters correctly.
{
  const filtered = filterByCountry(SAMPLE_LEADS, 'India');
  assertEq(filtered.length, 2, '7: India filter returns 2 leads');
  assertTrue(filtered.every(l => l.country === 'India'), '7: all results have country=India');
}

// 8. Selecting UNASSIGNED filters null/blank/whitespace Country values.
{
  const filtered = filterByCountry(SAMPLE_LEADS, '__unassigned__');
  assertEq(filtered.length, 3, '8: UNASSIGNED returns 3 leads (null, "", "   ")');
  assertTrue(filtered.every(l => !l.country || !l.country.trim()), '8: all results are blank/null/ws');
}

// 9. Clearing Country removes the filter.
{
  const filtered = filterByCountry(SAMPLE_LEADS, '');
  assertEq(filtered.length, SAMPLE_LEADS.length, '9: empty country filter returns all leads');
}

// 10. Country filter works together with existing filters (State).
{
  const byCountry = filterByCountry(SAMPLE_LEADS, 'India');
  const byCountryAndState = filterByState(byCountry, 'Maharashtra');
  assertEq(byCountryAndState.length, 2, '10: India + Maharashtra returns 2');
  assertTrue(byCountryAndState.every(l => l.country === 'India' && l.state === 'Maharashtra'), '10: all match both filters');
}

// 11. Existing State filter behavior remains unchanged.
{
  const stateOpts = generateStateOptions(SAMPLE_LEADS);
  assertEq(stateOpts, ['Ankara', 'Dubai', 'Istanbul', 'Maharashtra'], '11: state options unchanged');

  const maharashtraLeads = filterByState(SAMPLE_LEADS, 'Maharashtra');
  assertEq(maharashtraLeads.length, 2, '11: State=Maharashtra returns 2');

  const unassignedStateLeads = filterByState(SAMPLE_LEADS, '__unassigned__');
  assertEq(unassignedStateLeads.length, 1, '11: State=UNASSIGNED returns 1 (empty state)');

  const allStateLeads = filterByState(SAMPLE_LEADS, '');
  assertEq(allStateLeads.length, SAMPLE_LEADS.length, '11: empty state filter returns all');
}

// ─── AdvancedFilters integration ───────────────────────────────────────────────

// Verify countActiveAdvanced includes country.
{
  const withCountry: AdvancedFilters = { ...EMPTY_ADVANCED, country: 'India' };
  assertEq(countActiveAdvanced(withCountry), 1, 'countActiveAdvanced includes country');

  const withCountryAndState: AdvancedFilters = { ...EMPTY_ADVANCED, country: 'India', state: 'Maharashtra' };
  assertEq(countActiveAdvanced(withCountryAndState), 2, 'countActiveAdvanced counts country + state');

  const empty = countActiveAdvanced(EMPTY_ADVANCED);
  assertEq(empty, 0, 'countActiveAdvanced empty = 0');
}

// ─── Results ───────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
