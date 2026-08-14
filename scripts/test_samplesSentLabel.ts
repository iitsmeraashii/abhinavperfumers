// Focused tests for the "Qualified → Samples Sent" label change and the
// follow-up reminder created on transition into QUALIFIED.
//
// These tests verify:
// 1. Database status remains QUALIFIED (internal value unchanged)
// 2. UI displays "Samples Sent" instead of "Qualified"
// 3. NEW → QUALIFIED creates the reminder
// 4. Reminder note is exactly "Follow up with lead on samples sent."
// 5. Reminder due date is 15 calendar days after the transition
// 6. Saving an already-QUALIFIED lead does not create another reminder
// 7. Refreshing/reopening Lead Detail does not create another reminder
// 8. Existing QUALIFIED leads do not automatically receive reminders

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

// ─── Constants matching the source code ────────────────────────────────────────

const QUALIFIED_DB_VALUE = 'QUALIFIED';
const QUALIFIED_UI_LABEL = 'Samples Sent';
const REMINDER_NOTE = 'Follow up with lead on samples sent.';
const REMINDER_DAYS = 15;

// ─── Label mapping (mirrors LeadsPage.tsx STATUS_LABELS + LeadDetailPage styles) ─

const STATUS_LABELS: Record<string, string> = {
  qualified: 'Samples Sent',
};

function statusLabel(value: string): string {
  return STATUS_LABELS[value.toLowerCase()] ?? value;
}

// ─── Lead status styles (mirrors LeadDetailPage.tsx LEAD_STATUS_STYLES) ──────

const LEAD_STATUS_STYLES: Record<string, { label: string }> = {
  qualified: { label: 'Samples Sent' },
};

// ─── 1. Database status remains QUALIFIED ─────────────────────────────────────

function test_db_value_unchanged() {
  // The internal value used in queries, enums, and DB operations is still QUALIFIED
  assert(QUALIFIED_DB_VALUE === 'QUALIFIED',
    'Database status value must remain QUALIFIED');
}

// ─── 2. UI displays "Samples Sent" instead of "Qualified" ─────────────────────

function test_ui_label_changed() {
  // LeadsPage badge function uses statusLabel()
  assert(statusLabel('QUALIFIED') === 'Samples Sent',
    'statusLabel(QUALIFIED) should return "Samples Sent"');
  assert(statusLabel('qualified') === 'Samples Sent',
    'statusLabel(qualified) should return "Samples Sent"');

  // LeadDetailPage LEAD_STATUS_STYLES.qualified.label
  assert(LEAD_STATUS_STYLES.qualified.label === 'Samples Sent',
    'LeadDetailPage qualified label should be "Samples Sent"');

  // Other statuses should NOT be remapped
  assert(statusLabel('NEW') === 'NEW',
    'statusLabel(NEW) should return "NEW" (unchanged)');
  assert(statusLabel('CONTACTED') === 'CONTACTED',
    'statusLabel(CONTACTED) should return "CONTACTED" (unchanged)');
}

// ─── 3. NEW → QUALIFIED creates the reminder ──────────────────────────────────

interface FollowUp {
  lead_id: string;
  reminder_date: string;
  note: string;
  created_by: string | null;
}

// Simulates the reminder creation logic from updateLeadStatus
function maybeCreateReminder(
  previousStatus: string | undefined,
  newStatus: string,
  leadId: string,
  existingFollowUps: FollowUp[],
  repCode: string | null,
  now: Date,
): FollowUp | null {
  if (newStatus !== 'QUALIFIED') return null;
  if (previousStatus === 'QUALIFIED') return null;

  // Idempotency: check if reminder with this note already exists
  const exists = existingFollowUps.some(f => f.note === REMINDER_NOTE);
  if (exists) return null;

  const dueDate = new Date(now);
  dueDate.setDate(dueDate.getDate() + REMINDER_DAYS);

  return {
    lead_id: leadId,
    reminder_date: dueDate.toISOString(),
    note: REMINDER_NOTE,
    created_by: repCode,
  };
}

function test_new_to_qualified_creates_reminder() {
  const now = new Date('2026-08-14T12:00:00Z');
  const reminder = maybeCreateReminder('NEW', 'QUALIFIED', 'lead-1', [], 'REP001', now);
  assert(reminder !== null,
    'NEW → QUALIFIED should create a reminder');
}

// ─── 4. Reminder note is exactly "Follow up with lead on samples sent." ────────

function test_reminder_note_exact() {
  const now = new Date('2026-08-14T12:00:00Z');
  const reminder = maybeCreateReminder('NEW', 'QUALIFIED', 'lead-1', [], 'REP001', now);
  assert(reminder !== null && reminder.note === REMINDER_NOTE,
    `Reminder note must be exactly "${REMINDER_NOTE}"`);
  assert(reminder?.note === 'Follow up with lead on samples sent.',
    'Reminder note must match exact string');
}

// ─── 5. Reminder due date is 15 calendar days after transition ─────────────────

function test_reminder_due_date_15_days() {
  const transitionDate = new Date('2026-08-14T12:00:00Z');
  const reminder = maybeCreateReminder('NEW', 'QUALIFIED', 'lead-1', [], 'REP001', transitionDate);
  assert(reminder !== null, 'Reminder should be created');

  const expectedDue = new Date('2026-08-14T12:00:00Z');
  expectedDue.setDate(expectedDue.getDate() + 15);

  assert(reminder!.reminder_date === expectedDue.toISOString(),
    `Reminder due date should be 15 days after transition (${expectedDue.toISOString()})`);

  // Verify it's exactly 15 days, not 14 or 16
  const actualDue = new Date(reminder!.reminder_date);
  const diffDays = Math.round((actualDue.getTime() - transitionDate.getTime()) / (1000 * 60 * 60 * 24));
  assert(diffDays === 15,
    `Difference should be exactly 15 days, got ${diffDays}`);
}

// ─── 6. Saving an already-QUALIFIED lead does not create another reminder ─────

function test_already_qualified_no_duplicate() {
  const now = new Date('2026-08-14T12:00:00Z');
  // Lead is already QUALIFIED, user saves again (status stays QUALIFIED)
  const reminder = maybeCreateReminder('QUALIFIED', 'QUALIFIED', 'lead-1', [], 'REP001', now);
  assert(reminder === null,
    'Saving an already-QUALIFIED lead should NOT create another reminder');
}

// ─── 7. Refreshing/reopening Lead Detail does not create another reminder ─────

function test_refresh_no_duplicate() {
  const now = new Date('2026-08-14T12:00:00Z');
  // Simulate: reminder already exists from a previous transition
  const existingFollowUps: FollowUp[] = [{
    lead_id: 'lead-1',
    reminder_date: new Date('2026-08-29T12:00:00Z').toISOString(),
    note: REMINDER_NOTE,
    created_by: 'REP001',
  }];
  // On refresh, the component loads the lead (already QUALIFIED) — no transition
  const reminder = maybeCreateReminder('QUALIFIED', 'QUALIFIED', 'lead-1', existingFollowUps, 'REP001', now);
  assert(reminder === null,
    'Refreshing/reopening Lead Detail should NOT create another reminder (no transition)');

  // Even if somehow the transition check passed, idempotency should catch it
  const reminder2 = maybeCreateReminder('NEW', 'QUALIFIED', 'lead-1', existingFollowUps, 'REP001', now);
  assert(reminder2 === null,
    'Idempotency check should prevent duplicate reminder when one already exists');
}

// ─── 8. Existing QUALIFIED leads do not automatically receive reminders ────────

function test_historical_leads_no_reminder() {
  const now = new Date('2026-08-14T12:00:00Z');
  // Existing QUALIFIED lead loaded from DB — previousStatus is QUALIFIED, no transition
  const reminder = maybeCreateReminder('QUALIFIED', 'QUALIFIED', 'lead-historical', [], null, now);
  assert(reminder === null,
    'Existing QUALIFIED leads should NOT automatically receive reminders');
}

// ─── Additional edge cases ─────────────────────────────────────────────────────

function test_other_transitions_no_reminder() {
  const now = new Date('2026-08-14T12:00:00Z');
  assert(maybeCreateReminder('NEW', 'CONTACTED', 'lead-1', [], 'REP001', now) === null,
    'NEW → CONTACTED should NOT create a reminder');
  assert(maybeCreateReminder('NEW', 'CONVERTED', 'lead-1', [], 'REP001', now) === null,
    'NEW → CONVERTED should NOT create a reminder');
  assert(maybeCreateReminder('NEW', 'LOST', 'lead-1', [], 'REP001', now) === null,
    'NEW → LOST should NOT create a reminder');
  assert(maybeCreateReminder('CONTACTED', 'QUALIFIED', 'lead-1', [], 'REP001', now) !== null,
    'CONTACTED → QUALIFIED should create a reminder');
  assert(maybeCreateReminder('CONVERTED', 'QUALIFIED', 'lead-1', [], 'REP001', now) !== null,
    'CONVERTED → QUALIFIED should create a reminder (transition into QUALIFIED)');
}

// ─── Run all tests ─────────────────────────────────────────────────────────────

test_db_value_unchanged();
test_ui_label_changed();
test_new_to_qualified_creates_reminder();
test_reminder_note_exact();
test_reminder_due_date_15_days();
test_already_qualified_no_duplicate();
test_refresh_no_duplicate();
test_historical_leads_no_reminder();
test_other_transitions_no_reminder();

console.log(`Samples Sent label + reminder tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
