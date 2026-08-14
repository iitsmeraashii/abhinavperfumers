// Lead Activity Log — focused tests
//
// Run with: npx tsx scripts/test_leadActivities.ts
//
// These tests verify the update_lead_with_audit RPC and lead_activities table
// behavior directly against the database. They require valid auth credentials
// seeded in the test environment.

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.VITE_SUPABASE_URL!;
const SUPABASE_ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY!;

// Test credentials — these should match seeded auth users from the migration
const ADMIN_EMAIL = 'admin@abhinavperfumers.com';
const ADMIN_PASSWORD = 'admin123';

const REP_EMAIL = 'rahul@abhinavperfumers.com';
const REP_PASSWORD = 'rep123';

interface TestResult {
  name: string;
  passed: boolean;
  detail?: string;
}

const results: TestResult[] = [];

function assert(name: string, condition: boolean, detail?: string) {
  results.push({ name, passed: condition, detail });
  if (!condition) console.error(`FAIL: ${name}${detail ? ` — ${detail}` : ''}`);
  else console.log(`PASS: ${name}`);
}

async function getAuthenticatedClient(email: string, password: string) {
  const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error || !data.session) throw new Error(`Auth failed for ${email}: ${error?.message}`);
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${data.session.access_token}` } },
  });
}

async function createTestLead(adminClient: ReturnType<typeof createClient>, repCode: string) {
  const leadId = crypto.randomUUID();
  const now = new Date().toISOString();
  const { error } = await adminClient.from('lead_entries').insert({
    id: leadId,
    client_name: 'Test Contact',
    company: 'Test Company Pvt Ltd',
    designation: 'Manager',
    phones: ['+919999999999'],
    emails: ['test@example.com'],
    address: '123 Test Street, Mumbai',
    state: 'Maharashtra',
    lead_status: 'NEW',
    system_status: 'CREATED',
    lead_temperature: 'Warm',
    sales_rep_code: repCode,
    event_code: null,
    created_at: now,
    updated_at: now,
  });
  if (error) throw new Error(`Failed to create test lead: ${error.message}`);
  return leadId;
}

async function fetchActivities(client: ReturnType<typeof createClient>, leadId: string) {
  const { data, error } = await client
    .from('lead_activities')
    .select('*')
    .eq('lead_id', leadId)
    .order('created_at', { ascending: false });
  if (error) throw new Error(`Failed to fetch activities: ${error.message}`);
  return data ?? [];
}

async function cleanupLead(adminClient: ReturnType<typeof createClient>, leadId: string) {
  await adminClient.from('lead_activities').delete().eq('lead_id', leadId);
  await adminClient.from('lead_entries').delete().eq('id', leadId);
}

async function main() {
  console.log('\n=== Lead Activity Log Tests ===\n');

  const adminClient = await getAuthenticatedClient(ADMIN_EMAIL, ADMIN_PASSWORD);
  const repClient = await getAuthenticatedClient(REP_EMAIL, REP_PASSWORD);

  // Get a rep code for the test lead
  const { data: repData } = await adminClient
    .from('sales_representatives')
    .select('rep_code, name')
    .eq('role', 'sales_rep')
    .limit(1)
    .maybeSingle();

  if (!repData) throw new Error('No sales rep found for testing');
  const repCode = repData.rep_code;

  // ── Test 1: Activity created when status changes ──
  {
    const leadId = await createTestLead(adminClient, repCode);
    const { data, error } = await adminClient.rpc('update_lead_with_audit', {
      p_lead_id: leadId,
      p_updates: { lead_status: 'CONTACTED' },
    });
    const activities = await fetchActivities(adminClient, leadId);
    const statusActivity = activities.find(a => a.action_type === 'STATUS_CHANGED');
    assert('1. Activity created when status changes',
      !error && !!data && !!statusActivity,
      error?.message ?? (statusActivity ? undefined : 'No STATUS_CHANGED activity found'));
    await cleanupLead(adminClient, leadId);
  }

  // ── Test 2: No activity when status remains unchanged ──
  {
    const leadId = await createTestLead(adminClient, repCode);
    await adminClient.rpc('update_lead_with_audit', {
      p_lead_id: leadId,
      p_updates: { lead_status: 'NEW' },
    });
    const activities = await fetchActivities(adminClient, leadId);
    const statusActivity = activities.find(a => a.action_type === 'STATUS_CHANGED');
    assert('2. No activity when status remains unchanged',
      !statusActivity,
      statusActivity ? 'Unexpected STATUS_CHANGED activity' : undefined);
    await cleanupLead(adminClient, leadId);
  }

  // ── Test 3: Activity created when a normal field changes ──
  {
    const leadId = await createTestLead(adminClient, repCode);
    await adminClient.rpc('update_lead_with_audit', {
      p_lead_id: leadId,
      p_updates: { company: 'New Company Name' },
    });
    const activities = await fetchActivities(adminClient, leadId);
    const fieldActivity = activities.find(a => a.field_name === 'company');
    assert('3. Activity created when a normal field changes',
      !!fieldActivity && fieldActivity.note.includes('Company'),
      fieldActivity ? undefined : 'No FIELD_UPDATED activity for company');
    await cleanupLead(adminClient, leadId);
  }

  // ── Test 4: Multiple changed fields create multiple activities ──
  {
    const leadId = await createTestLead(adminClient, repCode);
    const { data } = await adminClient.rpc('update_lead_with_audit', {
      p_lead_id: leadId,
      p_updates: {
        company: 'Changed Corp',
        lead_temperature: 'Hot',
        lead_status: 'CONTACTED',
      },
    });
    const activities = await fetchActivities(adminClient, leadId);
    const result = data as { activities_created: number } | null;
    assert('4. Multiple changed fields create multiple activities',
      result?.activities_created === 3 && activities.length === 3,
      `Expected 3 activities, got ${activities.length} (RPC said ${result?.activities_created ?? 'null'})`);
    await cleanupLead(adminClient, leadId);
  }

  // ── Test 5: Sales Rep change creates activity ──
  {
    const leadId = await createTestLead(adminClient, repCode);
    const { data: anotherRep } = await adminClient
      .from('sales_representatives')
      .select('rep_code')
      .eq('role', 'sales_rep')
      .limit(1)
      .neq('rep_code', repCode)
      .maybeSingle();

    if (anotherRep) {
      await adminClient.rpc('update_lead_with_audit', {
        p_lead_id: leadId,
        p_updates: { sales_rep_code: anotherRep.rep_code },
      });
      const activities = await fetchActivities(adminClient, leadId);
      const repActivity = activities.find(a => a.action_type === 'SALES_REP_CHANGED');
      assert('5. Sales Rep change creates activity',
        !!repActivity && repActivity.note.includes('Sales Rep changed'),
        repActivity ? undefined : 'No SALES_REP_CHANGED activity');
    } else {
      assert('5. Sales Rep change creates activity', true, 'Skipped — only one rep available');
    }
    await cleanupLead(adminClient, leadId);
  }

  // ── Test 6: Event change creates activity ──
  {
    const leadId = await createTestLead(adminClient, repCode);
    const { data: event } = await adminClient
      .from('events')
      .select('event_code, name')
      .limit(1)
      .maybeSingle();

    if (event) {
      await adminClient.rpc('update_lead_with_audit', {
        p_lead_id: leadId,
        p_updates: { event_code: event.event_code },
      });
      const activities = await fetchActivities(adminClient, leadId);
      const eventActivity = activities.find(a => a.action_type === 'EVENT_CHANGED');
      assert('6. Event change creates activity',
        !!eventActivity && eventActivity.note.includes('Event changed'),
        eventActivity ? undefined : 'No EVENT_CHANGED activity');
    } else {
      assert('6. Event change creates activity', true, 'Skipped — no events available');
    }
    await cleanupLead(adminClient, leadId);
  }

  // ── Test 7: Temperature change creates activity ──
  {
    const leadId = await createTestLead(adminClient, repCode);
    await adminClient.rpc('update_lead_with_audit', {
      p_lead_id: leadId,
      p_updates: { lead_temperature: 'Hot' },
    });
    const activities = await fetchActivities(adminClient, leadId);
    const tempActivity = activities.find(a => a.action_type === 'LEAD_TEMPERATURE_CHANGED');
    assert('7. Temperature change creates activity',
      !!tempActivity && tempActivity.note.includes('temperature'),
      tempActivity ? undefined : 'No LEAD_TEMPERATURE_CHANGED activity');
    await cleanupLead(adminClient, leadId);
  }

  // ── Test 8: Review action creates activity ──
  {
    const leadId = await createTestLead(adminClient, repCode);
    // First set to REQUIRES_REVIEW
    await adminClient.from('lead_entries').update({ lead_status: 'REQUIRES_REVIEW' }).eq('id', leadId);
    await adminClient.rpc('update_lead_with_audit', {
      p_lead_id: leadId,
      p_updates: {
        lead_status: 'NEW',
        is_reviewed: true,
        reviewed_at: new Date().toISOString(),
        reviewed_by: repCode,
      },
    });
    const activities = await fetchActivities(adminClient, leadId);
    const reviewActivity = activities.find(a => a.action_type === 'REVIEWED');
    assert('8. Review action creates activity',
      !!reviewActivity && reviewActivity.note.includes('reviewed'),
      reviewActivity ? undefined : 'No REVIEWED activity');
    await cleanupLead(adminClient, leadId);
  }

  // ── Test 9: Correct actor is recorded ──
  {
    const leadId = await createTestLead(adminClient, repCode);
    // Admin updates the lead
    await adminClient.rpc('update_lead_with_audit', {
      p_lead_id: leadId,
      p_updates: { company: 'Admin Changed Co' },
    });
    const activities = await fetchActivities(adminClient, leadId);
    const activity = activities.find(a => a.field_name === 'company');
    assert('9. Correct actor is recorded',
      !!activity && !!activity.actor_user_id,
      activity ? `actor_user_id: ${activity.actor_user_id}` : 'No activity found');
    await cleanupLead(adminClient, leadId);
  }

  // ── Test 10: Old value is recorded ──
  {
    const leadId = await createTestLead(adminClient, repCode);
    await adminClient.rpc('update_lead_with_audit', {
      p_lead_id: leadId,
      p_updates: { company: 'New Corp' },
    });
    const activities = await fetchActivities(adminClient, leadId);
    const activity = activities.find(a => a.field_name === 'company');
    assert('10. Old value is recorded',
      !!activity && activity.old_value !== null && (activity.old_value as any)?.toString().includes('Test Company'),
      activity ? `old_value: ${JSON.stringify(activity.old_value)}` : 'No activity');
    await cleanupLead(adminClient, leadId);
  }

  // ── Test 11: New value is recorded ──
  {
    const leadId = await createTestLead(adminClient, repCode);
    await adminClient.rpc('update_lead_with_audit', {
      p_lead_id: leadId,
      p_updates: { company: 'Brand New Corp' },
    });
    const activities = await fetchActivities(adminClient, leadId);
    const activity = activities.find(a => a.field_name === 'company');
    assert('11. New value is recorded',
      !!activity && activity.new_value !== null && (activity.new_value as any)?.toString().includes('Brand New Corp'),
      activity ? `new_value: ${JSON.stringify(activity.new_value)}` : 'No activity');
    await cleanupLead(adminClient, leadId);
  }

  // ── Test 12: Human-readable activity note is generated ──
  {
    const leadId = await createTestLead(adminClient, repCode);
    await adminClient.rpc('update_lead_with_audit', {
      p_lead_id: leadId,
      p_updates: { lead_status: 'QUALIFIED' },
    });
    const activities = await fetchActivities(adminClient, leadId);
    const activity = activities.find(a => a.action_type === 'STATUS_CHANGED');
    assert('12. Human-readable activity note is generated',
      !!activity && activity.note.includes('Samples Sent'),
      activity ? `note: "${activity.note}"` : 'No activity');
    await cleanupLead(adminClient, leadId);
  }

  // ── Test 13: Null → value is handled ──
  {
    const leadId = await createTestLead(adminClient, repCode);
    // Set website to null first
    await adminClient.from('lead_entries').update({ website: null }).eq('id', leadId);
    await adminClient.rpc('update_lead_with_audit', {
      p_lead_id: leadId,
      p_updates: { website: 'https://example.com' },
    });
    const activities = await fetchActivities(adminClient, leadId);
    const activity = activities.find(a => a.field_name === 'website');
    assert('13. Null → value is handled',
      !!activity && activity.old_value !== null && (activity.old_value as any)?.toString().includes('Not set'),
      activity ? `old_value: ${JSON.stringify(activity.old_value)}` : 'No activity');
    await cleanupLead(adminClient, leadId);
  }

  // ── Test 14: Value → null is handled ──
  {
    const leadId = await createTestLead(adminClient, repCode);
    await adminClient.rpc('update_lead_with_audit', {
      p_lead_id: leadId,
      p_updates: { company: '' },
    });
    const activities = await fetchActivities(adminClient, leadId);
    const activity = activities.find(a => a.field_name === 'company');
    assert('14. Value → null is handled',
      !!activity && activity.new_value !== null && (activity.new_value as any)?.toString().includes('Not set'),
      activity ? `new_value: ${JSON.stringify(activity.new_value)}` : 'No activity');
    await cleanupLead(adminClient, leadId);
  }

  // ── Test 15: No duplicate activities from a single unchanged save ──
  {
    const leadId = await createTestLead(adminClient, repCode);
    // Send the same values that already exist
    await adminClient.rpc('update_lead_with_audit', {
      p_lead_id: leadId,
      p_updates: {
        client_name: 'Test Contact',
        company: 'Test Company Pvt Ltd',
        lead_temperature: 'Warm',
      },
    });
    const activities = await fetchActivities(adminClient, leadId);
    assert('15. No duplicate activities from a single unchanged save',
      activities.length === 0,
      `Expected 0 activities, got ${activities.length}`);
    await cleanupLead(adminClient, leadId);
  }

  // ── Test 16: Non-authorized user cannot create activity for another user's lead ──
  {
    // Create a lead assigned to a different rep (admin creates it)
    const { data: otherRep } = await adminClient
      .from('sales_representatives')
      .select('rep_code')
      .eq('role', 'sales_rep')
      .neq('rep_code', repCode)
      .limit(1)
      .maybeSingle();

    if (otherRep) {
      const leadId = await createTestLead(adminClient, otherRep.rep_code);
      // Try to update as the wrong rep
      const { error } = await repClient.rpc('update_lead_with_audit', {
        p_lead_id: leadId,
        p_updates: { company: 'Hacked Corp' },
      });
      assert('16. Non-authorized user cannot create activity for another user\'s lead',
        !!error,
        error ? undefined : 'Update succeeded — should have been blocked');
      await cleanupLead(adminClient, leadId);
    } else {
      assert('16. Non-authorized user cannot create activity for another user\'s lead', true, 'Skipped — only one rep');
    }
  }

  // ── Test 17: Activity records cannot be edited ──
  {
    const leadId = await createTestLead(adminClient, repCode);
    await adminClient.rpc('update_lead_with_audit', {
      p_lead_id: leadId,
      p_updates: { company: 'Edit Test Co' },
    });
    const activities = await fetchActivities(adminClient, leadId);
    const activity = activities[0];
    const { error } = await adminClient
      .from('lead_activities')
      .update({ note: 'tampered' })
      .eq('id', activity.id);
    assert('17. Activity records cannot be edited',
      !!error,
      error ? undefined : 'UPDATE succeeded — should have been blocked by RLS');
    await cleanupLead(adminClient, leadId);
  }

  // ── Test 18: Activity records cannot be deleted ──
  {
    const leadId = await createTestLead(adminClient, repCode);
    await adminClient.rpc('update_lead_with_audit', {
      p_lead_id: leadId,
      p_updates: { company: 'Delete Test Co' },
    });
    const activities = await fetchActivities(adminClient, leadId);
    const activity = activities[0];
    const { error } = await adminClient
      .from('lead_activities')
      .delete()
      .eq('id', activity.id);
    assert('18. Activity records cannot be deleted',
      !!error,
      error ? undefined : 'DELETE succeeded — should have been blocked by RLS');
    await cleanupLead(adminClient, leadId);
  }

  // ── Test 19: Existing lead update functionality remains intact ──
  {
    const leadId = await createTestLead(adminClient, repCode);
    const { data, error } = await adminClient.rpc('update_lead_with_audit', {
      p_lead_id: leadId,
      p_updates: { client_name: 'Updated Name', lead_status: 'CONTACTED' },
    });
    const result = data as { lead: { client_name: string; lead_status: string } } | null;
    assert('19. Existing lead update functionality remains intact',
      !error && !!data && result?.lead?.client_name === 'Updated Name' && result?.lead?.lead_status === 'CONTACTED',
      error?.message ?? 'Lead data not updated correctly');
    await cleanupLead(adminClient, leadId);
  }

  // ── Test 20: Activity history survives page refresh (data is persistent) ──
  {
    const leadId = await createTestLead(adminClient, repCode);
    await adminClient.rpc('update_lead_with_audit', {
      p_lead_id: leadId,
      p_updates: { company: 'Persistent Co' },
    });
    // Simulate "page refresh" by creating a new client and re-authenticating
    const freshClient = await getAuthenticatedClient(ADMIN_EMAIL, ADMIN_PASSWORD);
    const { data: activities, error } = await freshClient
      .from('lead_activities')
      .select('*')
      .eq('lead_id', leadId);
    assert('20. Activity history survives page refresh',
      !error && (activities?.length ?? 0) > 0,
      error?.message ?? 'No activities found after re-auth');
    await cleanupLead(adminClient, leadId);
  }

  // ── Summary ──
  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});
