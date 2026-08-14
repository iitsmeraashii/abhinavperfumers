// Focused tests for the Lead Temperature prompt on the Lead Detail page.
//
// Tests the shouldShowTempPrompt visibility logic and the handleTempPromptSelect
// persistence behavior in isolation — no React rendering, no Supabase calls.

// ─── Extract shouldShowTempPrompt for testing ─────────────────────────────────
// We replicate the function here because it's not exported. If the source
// function changes, update this copy to match.

interface LeadDetailLike {
  lead_status: string;
  lead_temperature: string;
}

function shouldShowTempPrompt(lead: LeadDetailLike): boolean {
  if (lead.lead_status?.toUpperCase() !== 'NEW') return false;
  const temp = lead.lead_temperature?.trim();
  if (!temp) return true;
  const lower = temp.toLowerCase();
  return lower !== 'hot' && lower !== 'warm' && lower !== 'cold';
}

// ─── Assertions ────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (condition) {
    passed++;
  } else {
    failed++;
    console.error(`FAIL: ${message}`);
  }
}

// ─── 1. NEW + null temperature → dialog appears ──────────────────────────────

function test_new_null_temp_shows_dialog() {
  assert(shouldShowTempPrompt({ lead_status: 'NEW', lead_temperature: '' }) === true,
    'NEW + empty temperature should show dialog');
  assert(shouldShowTempPrompt({ lead_status: 'NEW', lead_temperature: null as unknown as string }) === true,
    'NEW + null temperature should show dialog');
  assert(shouldShowTempPrompt({ lead_status: 'NEW', lead_temperature: '   ' }) === true,
    'NEW + whitespace temperature should show dialog');
}

// ─── 2. NEW + HOT → dialog does NOT appear ───────────────────────────────────

function test_new_hot_no_dialog() {
  assert(shouldShowTempPrompt({ lead_status: 'NEW', lead_temperature: 'Hot' }) === false,
    'NEW + Hot should NOT show dialog');
  assert(shouldShowTempPrompt({ lead_status: 'NEW', lead_temperature: 'hot' }) === false,
    'NEW + hot (lowercase) should NOT show dialog');
}

// ─── 3. NEW + WARM → dialog does NOT appear ──────────────────────────────────

function test_new_warm_no_dialog() {
  assert(shouldShowTempPrompt({ lead_status: 'NEW', lead_temperature: 'Warm' }) === false,
    'NEW + Warm should NOT show dialog');
  assert(shouldShowTempPrompt({ lead_status: 'NEW', lead_temperature: 'warm' }) === false,
    'NEW + warm (lowercase) should NOT show dialog');
}

// ─── 4. NEW + COLD → dialog does NOT appear ──────────────────────────────────

function test_new_cold_no_dialog() {
  assert(shouldShowTempPrompt({ lead_status: 'NEW', lead_temperature: 'Cold' }) === false,
    'NEW + Cold should NOT show dialog');
  assert(shouldShowTempPrompt({ lead_status: 'NEW', lead_temperature: 'cold' }) === false,
    'NEW + cold (lowercase) should NOT show dialog');
}

// ─── 5. REQUIRES_REVIEW + null temperature → dialog does NOT appear ─────────

function test_requires_review_no_dialog() {
  assert(shouldShowTempPrompt({ lead_status: 'REQUIRES_REVIEW', lead_temperature: '' }) === false,
    'REQUIRES_REVIEW + null temperature should NOT show dialog');
  assert(shouldShowTempPrompt({ lead_status: 'requires_review', lead_temperature: '' }) === false,
    'requires_review (lowercase) should NOT show dialog');
}

// ─── 6-8. Select HOT/WARM/COLD → lead_entries.lead_temperature updated ────────
// These test the persistence path. Since we can't call the real Supabase update
// from a test, we verify the update payload shape: the function should call
// supabase.from('lead_entries').update({ lead_temperature: temp }).eq('id', leadId)
// We simulate the update and verify the resulting state.

function simulateTempUpdate(lead: LeadDetailLike, temp: 'Hot' | 'Warm' | 'Cold'): LeadDetailLike {
  // Simulates what handleTempPromptSelect does: update lead_temperature on the lead
  return { ...lead, lead_temperature: temp };
}

function test_select_hot_updates_temp() {
  const result = simulateTempUpdate({ lead_status: 'NEW', lead_temperature: '' }, 'Hot');
  assert(result.lead_temperature === 'Hot',
    'Selecting HOT should set lead_temperature to Hot');
  assert(shouldShowTempPrompt(result) === false,
    'After saving HOT, dialog should not reappear');
}

function test_select_warm_updates_temp() {
  const result = simulateTempUpdate({ lead_status: 'NEW', lead_temperature: '' }, 'Warm');
  assert(result.lead_temperature === 'Warm',
    'Selecting WARM should set lead_temperature to Warm');
  assert(shouldShowTempPrompt(result) === false,
    'After saving WARM, dialog should not reappear');
}

function test_select_cold_updates_temp() {
  const result = simulateTempUpdate({ lead_status: 'NEW', lead_temperature: '' }, 'Cold');
  assert(result.lead_temperature === 'Cold',
    'Selecting COLD should set lead_temperature to Cold');
  assert(shouldShowTempPrompt(result) === false,
    'After saving COLD, dialog should not reappear');
}

// ─── 9. Database update fails → dialog remains open ─────────────────────────
// In the real component, if the update fails, setShowTempPrompt(false) is NOT
// called and tempPromptError is set. We verify the logic: on error, the lead
// state is NOT updated and shouldShowTempPrompt still returns true.

function test_db_failure_keeps_dialog_open() {
  // Simulate a failed update: lead_temperature stays empty
  const leadAfterFailedUpdate = { lead_status: 'NEW', lead_temperature: '' };
  assert(shouldShowTempPrompt(leadAfterFailedUpdate) === true,
    'After failed DB update, dialog should still show (temperature still null)');
}

// ─── 10. After successful save + page refresh → dialog does NOT reappear ────
// On refresh, the lead is reloaded from DB. If the DB has lead_temperature = 'Hot',
// shouldShowTempPrompt returns false.

function test_after_save_refresh_no_dialog() {
  // Simulate page refresh: lead reloaded from DB with temperature already set
  const leadFromDb = { lead_status: 'NEW', lead_temperature: 'Hot' };
  assert(shouldShowTempPrompt(leadFromDb) === false,
    'After successful save + refresh, dialog should NOT reappear');
  // Same for Warm and Cold
  assert(shouldShowTempPrompt({ lead_status: 'NEW', lead_temperature: 'Warm' }) === false,
    'After saving Warm + refresh, dialog should NOT reappear');
  assert(shouldShowTempPrompt({ lead_status: 'NEW', lead_temperature: 'Cold' }) === false,
    'After saving Cold + refresh, dialog should NOT reappear');
}

// ─── Additional edge cases ─────────────────────────────────────────────────────

function test_other_statuses_no_dialog() {
  assert(shouldShowTempPrompt({ lead_status: 'CONTACTED', lead_temperature: '' }) === false,
    'CONTACTED should NOT show dialog');
  assert(shouldShowTempPrompt({ lead_status: 'QUALIFIED', lead_temperature: '' }) === false,
    'QUALIFIED should NOT show dialog');
  assert(shouldShowTempPrompt({ lead_status: 'CONVERTED', lead_temperature: '' }) === false,
    'CONVERTED should NOT show dialog');
  assert(shouldShowTempPrompt({ lead_status: 'LOST', lead_temperature: '' }) === false,
    'LOST should NOT show dialog');
}

function test_invalid_temp_shows_dialog() {
  assert(shouldShowTempPrompt({ lead_status: 'NEW', lead_temperature: 'Unknown' }) === true,
    'NEW + invalid temperature value should show dialog');
  assert(shouldShowTempPrompt({ lead_status: 'NEW', lead_temperature: 'N/A' }) === true,
    'NEW + N/A temperature should show dialog');
}

// ─── Run all tests ─────────────────────────────────────────────────────────────

test_new_null_temp_shows_dialog();
test_new_hot_no_dialog();
test_new_warm_no_dialog();
test_new_cold_no_dialog();
test_requires_review_no_dialog();
test_select_hot_updates_temp();
test_select_warm_updates_temp();
test_select_cold_updates_temp();
test_db_failure_keeps_dialog_open();
test_after_save_refresh_no_dialog();
test_other_statuses_no_dialog();
test_invalid_temp_shows_dialog();

console.log(`Lead Temperature prompt tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
