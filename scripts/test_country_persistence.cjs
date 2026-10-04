/*
 * Regression test: country persistence via update_lead_with_audit RPC.
 *
 * Tests scenarios A–F from the fix spec:
 *   A. India → Saudi Arabia → DB has Saudi Arabia
 *   B. NULL country → save with Saudi Arabia → DB has Saudi Arabia
 *   C. India → no country in updates → stays India
 *   D. India → change address to UAE but country=Saudi Arabia → country stays Saudi Arabia
 *   E. Country change creates audit/activity entry
 *   F. Other field updates still work
 *
 * Run: node scripts/test_country_persistence.cjs
 */
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing Supabase env vars. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ── Helpers ──────────────────────────────────────────────────────────

let passCount = 0;
let failCount = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  PASS: ${label}`);
    passCount++;
  } else {
    console.log(`  FAIL: ${label}`);
    failCount++;
  }
}

async function fetchLead(leadId) {
  const { data, error } = await supabase
    .from('lead_entries')
    .select('id, country, address, state, company')
    .eq('id', leadId)
    .maybeSingle();
  if (error) throw new Error(`fetchLead error: ${error.message}`);
  return data;
}

async function fetchActivities(leadId) {
  const { data, error } = await supabase
    .from('lead_activities')
    .select('action_type, field_name, old_value, new_value, note')
    .eq('lead_id', leadId)
    .order('created_at', { ascending: false })
    .limit(20);
  if (error) throw new Error(`fetchActivities error: ${error.message}`);
  return data || [];
}

// ── Setup: create a test lead using service-role admin ───────────────
// We use the service role key to create leads directly, bypassing RLS.

const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const adminClient = SERVICE_KEY
  ? createClient(SUPABASE_URL, SERVICE_KEY)
  : supabase;

async function createTestLead(country, address = '123 Test St') {
  const id = 'test-country-' + Math.random().toString(36).slice(2, 10);
  const { data, error } = await adminClient
    .from('lead_entries')
    .insert({
      id,
      client_name: 'Country Test Lead',
      company: 'Test Co',
      address,
      state: 'Test State',
      country: country || null,
      phones: ['+919999999999'],
      emails: ['test@example.com'],
      lead_type: 'NEW',
      lead_status: 'NEW',
      system_status: 'CREATED',
      sales_rep_code: 'ADMIN',
      event_code: 'TEST',
      lead_temperature: 'Warm',
      quick_keywords: '',
      target_market: '',
      certification: '',
      benchmark: '',
    })
    .select()
    .maybeSingle();
  if (error) throw new Error(`createTestLead error: ${error.message}`);
  return data;
}

async function deleteTestLead(leadId) {
  await adminClient.from('lead_activities').delete().eq('lead_id', leadId);
  await adminClient.from('lead_entries').delete().eq('id', leadId);
}

// ── Tests ────────────────────────────────────────────────────────────

async function runTests() {
  console.log('\n=== Country Persistence Regression Tests ===\n');

  // ── Scenario A: India → Saudi Arabia ─────────────────────────────
  console.log('Scenario A: India → edit to Saudi Arabia → save');
  {
    const lead = await createTestLead('India');
    try {
      const { data: rpcResult, error } = await supabase.rpc('update_lead_with_audit', {
        p_lead_id: lead.id,
        p_updates: { country: 'Saudi Arabia' },
      });
      if (error) throw new Error(`RPC error: ${error.message}`);

      const refreshed = await fetchLead(lead.id);
      assert(refreshed.country === 'Saudi Arabia', `DB country should be "Saudi Arabia", got "${refreshed.country}"`);
    } finally {
      await deleteTestLead(lead.id);
    }
  }

  // ── Scenario B: NULL → Saudi Arabia ──────────────────────────────
  console.log('\nScenario B: NULL country → save Saudi Arabia');
  {
    const lead = await createTestLead(null);
    try {
      const { error } = await supabase.rpc('update_lead_with_audit', {
        p_lead_id: lead.id,
        p_updates: { country: 'Saudi Arabia' },
      });
      if (error) throw new Error(`RPC error: ${error.message}`);

      const refreshed = await fetchLead(lead.id);
      assert(refreshed.country === 'Saudi Arabia', `DB country should be "Saudi Arabia", got "${refreshed.country}"`);
    } finally {
      await deleteTestLead(lead.id);
    }
  }

  // ── Scenario C: India → no country key → stays India ─────────────
  console.log('\nScenario C: India → no country in updates → stays India');
  {
    const lead = await createTestLead('India');
    try {
      const { error } = await supabase.rpc('update_lead_with_audit', {
        p_lead_id: lead.id,
        p_updates: { company: 'Changed Co' },
      });
      if (error) throw new Error(`RPC error: ${error.message}`);

      const refreshed = await fetchLead(lead.id);
      assert(refreshed.country === 'India', `DB country should remain "India", got "${refreshed.country}"`);
    } finally {
      await deleteTestLead(lead.id);
    }
  }

  // ── Scenario D: India → address=UAE, country=Saudi Arabia ────────
  console.log('\nScenario D: India → address=UAE, country=Saudi Arabia → country stays Saudi Arabia');
  {
    const lead = await createTestLead('India');
    try {
      const { error } = await supabase.rpc('update_lead_with_audit', {
        p_lead_id: lead.id,
        p_updates: { address: 'Dubai, UAE', country: 'Saudi Arabia' },
      });
      if (error) throw new Error(`RPC error: ${error.message}`);

      const refreshed = await fetchLead(lead.id);
      assert(refreshed.country === 'Saudi Arabia', `Country should be "Saudi Arabia" (explicit wins), got "${refreshed.country}"`);
      assert(refreshed.address === 'Dubai, UAE', `Address should be "Dubai, UAE", got "${refreshed.address}"`);
    } finally {
      await deleteTestLead(lead.id);
    }
  }

  // ── Scenario E: Country change creates audit entry ───────────────
  console.log('\nScenario E: Country change creates audit/activity entry');
  {
    const lead = await createTestLead('India');
    try {
      const { error } = await supabase.rpc('update_lead_with_audit', {
        p_lead_id: lead.id,
        p_updates: { country: 'Saudi Arabia' },
      });
      if (error) throw new Error(`RPC error: ${error.message}`);

      const activities = await fetchActivities(lead.id);
      const countryActivity = activities.find(a => a.field_name === 'country');
      assert(!!countryActivity, 'Should have an activity record with field_name="country"');
      if (countryActivity) {
        assert(countryActivity.action_type === 'FIELD_UPDATED', `action_type should be FIELD_UPDATED, got "${countryActivity.action_type}"`);
        const oldVal = typeof countryActivity.old_value === 'string' ? countryActivity.old_value : JSON.stringify(countryActivity.old_value);
        const newVal = typeof countryActivity.new_value === 'string' ? countryActivity.new_value : JSON.stringify(countryActivity.new_value);
        assert(oldVal.includes('India'), `old_value should contain "India", got "${oldVal}"`);
        assert(newVal.includes('Saudi Arabia'), `new_value should contain "Saudi Arabia", got "${newVal}"`);
      }
    } finally {
      await deleteTestLead(lead.id);
    }
  }

  // ── Scenario F: Other field updates still work ───────────────────
  console.log('\nScenario F: Other field updates continue working');
  {
    const lead = await createTestLead('India');
    try {
      const { error } = await supabase.rpc('update_lead_with_audit', {
        p_lead_id: lead.id,
        p_updates: {
          company: 'New Company Ltd',
          address: '456 New Ave',
          state: 'New State',
          application: 'Fragrances',
        },
      });
      if (error) throw new Error(`RPC error: ${error.message}`);

      const refreshed = await fetchLead(lead.id);
      assert(refreshed.company === 'New Company Ltd', `company should be "New Company Ltd", got "${refreshed.company}"`);
      assert(refreshed.address === '456 New Ave', `address should be "456 New Ave", got "${refreshed.address}"`);
      assert(refreshed.state === 'New State', `state should be "New State", got "${refreshed.state}"`);
      // country should be untouched since it wasn't in updates
      assert(refreshed.country === 'India', `country should remain "India", got "${refreshed.country}"`);
    } finally {
      await deleteTestLead(lead.id);
    }
  }

  // ── Summary ──────────────────────────────────────────────────────
  console.log(`\n=== Results: ${passCount} passed, ${failCount} failed ===\n`);
  process.exit(failCount > 0 ? 1 : 0);
}

runTests().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
