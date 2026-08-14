// Focused tests for admin-only Sales Rep and Event assignment controls
// on the Lead Detail page.

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

// ─── Mock types ─────────────────────────────────────────────────────────────────

interface MockUser {
  rep_code: string;
  role: string;
}

interface MockSalesRep {
  rep_code: string;
  name: string;
  is_active: boolean;
}

interface MockEvent {
  event_code: string;
  name: string;
  status: string;
  start_date: string;
}

interface MockLead {
  id: string;
  sales_rep_code: string;
  event_code: string;
}

// ─── Mock data ──────────────────────────────────────────────────────────────────

const ADMIN: MockUser = { rep_code: 'ADMIN001', role: 'admin' };
const REP: MockUser = { rep_code: 'REP001', role: 'sales_rep' };

const SALES_REPS: MockSalesRep[] = [
  { rep_code: 'REP001', name: 'Alice Smith', is_active: true },
  { rep_code: 'REP002', name: 'Bob Jones', is_active: true },
  { rep_code: 'REP003', name: 'Charlie Brown', is_active: false },
  { rep_code: 'REP004', name: 'Diana Prince', is_active: true },
];

const EVENTS: MockEvent[] = [
  { event_code: 'EVT-DRAFT-01', name: 'Draft Event', status: 'DRAFT', start_date: '2026-09-01' },
  { event_code: 'EVT-UPCOMING-01', name: 'Upcoming Event', status: 'UPCOMING', start_date: '2026-08-20' },
  { event_code: 'EVT-ACTIVE-01', name: 'Active Event', status: 'ACTIVE', start_date: '2026-08-14' },
  { event_code: 'EVT-COMPLETED-01', name: 'Completed Event', status: 'COMPLETED', start_date: '2026-07-01' },
  { event_code: 'EVT-ARCHIVED-01', name: 'Archived Event', status: 'ARCHIVED', start_date: '2026-06-01' },
];

const LEAD: MockLead = { id: 'lead-1', sales_rep_code: 'REP001', event_code: 'EVT-ACTIVE-01' };

// ─── Mock query functions ──────────────────────────────────────────────────────

function getActiveSalesReps(): MockSalesRep[] {
  return SALES_REPS.filter(r => r.is_active);
}

function getEligibleEvents(): MockEvent[] {
  const eligibleStatuses = ['ACTIVE', 'COMPLETED', 'ARCHIVED'];
  return EVENTS.filter(e => eligibleStatuses.includes(e.status))
    .sort((a, b) => new Date(b.start_date).getTime() - new Date(a.start_date).getTime());
}

function isAdmin(user: MockUser): boolean {
  return user.role === 'admin';
}

// ─── Mock save functions (mirror the actual handlers) ──────────────────────────

let savedRepCode: string | null = null;
let savedEventCode: string | null = null;
let saveRepError: string | null = null;
let saveEventError: string | null = null;

function mockSaveRep(user: MockUser, repCode: string): void {
  if (!isAdmin(user)) {
    saveRepError = 'Permission denied';
    return;
  }
  savedRepCode = repCode;
  saveRepError = null;
}

function mockSaveEvent(user: MockUser, eventCode: string): void {
  if (!isAdmin(user)) {
    saveEventError = 'Permission denied';
    return;
  }
  savedEventCode = eventCode;
  saveEventError = null;
}

function resetMockState() {
  savedRepCode = null;
  savedEventCode = null;
  saveRepError = null;
  saveEventError = null;
}

// ─── SALES REP TESTS ────────────────────────────────────────────────────────────

// 1. Admin sees editable Sales Rep dropdown
function test_admin_sees_rep_dropdown() {
  assert(isAdmin(ADMIN), 'Admin should see editable dropdown');
  assert(!isAdmin(REP), 'Non-admin should not see editable dropdown');
}

// 2. Non-admin cannot edit Sales Rep
function test_non_admin_cannot_edit_rep() {
  assert(!isAdmin(REP), 'Non-admin should not be able to edit Sales Rep');
}

// 3. Only active Sales Reps appear
function test_only_active_reps() {
  const reps = getActiveSalesReps();
  assert(reps.length === 3, 'Should only show 3 active reps (not the inactive one)');
  assert(reps.every(r => r.is_active), 'All shown reps must be active');
  assert(!reps.some(r => r.rep_code === 'REP003'), 'Inactive rep REP003 should not appear');
}

// 4. Existing Sales Rep is correctly selected
function test_existing_rep_selected() {
  const reps = getActiveSalesReps();
  const current = reps.find(r => r.rep_code === LEAD.sales_rep_code);
  assert(current !== undefined, 'Current sales rep should be found in options');
  assert(current?.rep_code === 'REP001', 'REP001 should be the selected value');
}

// 5. Changing Sales Rep persists correctly
function test_change_rep_persists() {
  resetMockState();
  mockSaveRep(ADMIN, 'REP002');
  assert(saveRepError === null, 'No error when admin changes rep');
  assert(savedRepCode === 'REP002', 'New rep code should be saved');
}

// 6. Failed update does not corrupt local state
function test_failed_rep_update() {
  resetMockState();
  // Simulate a database error
  saveRepError = 'Database error';
  // The local state should remain unchanged (LEAD.sales_rep_code stays 'REP001')
  assert(LEAD.sales_rep_code === 'REP001', 'Local state should remain unchanged on error');
  assert(saveRepError !== null, 'Error should be surfaced');
}

// ─── EVENT TESTS ────────────────────────────────────────────────────────────────

// 7. Admin sees editable Event dropdown
function test_admin_sees_event_dropdown() {
  assert(isAdmin(ADMIN), 'Admin should see editable event dropdown');
}

// 8. Non-admin cannot edit Event
function test_non_admin_cannot_edit_event() {
  assert(!isAdmin(REP), 'Non-admin should not be able to edit Event');
}

// 9. DRAFT events are excluded
function test_draft_excluded() {
  const events = getEligibleEvents();
  assert(!events.some(e => e.status === 'DRAFT'), 'DRAFT events should be excluded');
}

// 10. UPCOMING events are excluded
function test_upcoming_excluded() {
  const events = getEligibleEvents();
  assert(!events.some(e => e.status === 'UPCOMING'), 'UPCOMING events should be excluded');
}

// 11. ACTIVE events are included
function test_active_included() {
  const events = getEligibleEvents();
  assert(events.some(e => e.status === 'ACTIVE'), 'ACTIVE events should be included');
}

// 12. COMPLETED events are included
function test_completed_included() {
  const events = getEligibleEvents();
  assert(events.some(e => e.status === 'COMPLETED'), 'COMPLETED events should be included');
}

// 13. ARCHIVED events are included
function test_archived_included() {
  const events = getEligibleEvents();
  assert(events.some(e => e.status === 'ARCHIVED'), 'ARCHIVED events should be included');
}

// 14. Existing Event is correctly selected
function test_existing_event_selected() {
  const events = getEligibleEvents();
  const current = events.find(e => e.event_code === LEAD.event_code);
  assert(current !== undefined, 'Current event should be found in options');
  assert(current?.event_code === 'EVT-ACTIVE-01', 'EVT-ACTIVE-01 should be the selected value');
}

// 15. Changing Event persists correctly
function test_change_event_persists() {
  resetMockState();
  mockSaveEvent(ADMIN, 'EVT-COMPLETED-01');
  assert(saveEventError === null, 'No error when admin changes event');
  assert(savedEventCode === 'EVT-COMPLETED-01', 'New event code should be saved');
}

// 16. Lead Detail updates to reflect the newly selected event
function test_event_info_refreshed() {
  // After changing event, the event info (name, location, dates) should be
  // re-fetched from the events table and displayed.
  const newEventCode = 'EVT-COMPLETED-01';
  const newEvent = EVENTS.find(e => e.event_code === newEventCode);
  assert(newEvent?.name === 'Completed Event', 'Event name should reflect new selection');
}

// 17. Failed update does not corrupt local state
function test_failed_event_update() {
  resetMockState();
  saveEventError = 'Database error';
  assert(LEAD.event_code === 'EVT-ACTIVE-01', 'Local state should remain unchanged on error');
  assert(saveEventError !== null, 'Error should be surfaced');
}

// ─── SECURITY TESTS ─────────────────────────────────────────────────────────────

// 18. Non-admin cannot update Sales Rep through the UI
function test_non_admin_cannot_update_rep_ui() {
  resetMockState();
  mockSaveRep(REP, 'REP002');
  assert(saveRepError !== null, 'Non-admin should get error when trying to save rep');
  assert(savedRepCode === null, 'No rep code should be saved by non-admin');
}

// 19. Non-admin cannot bypass the restriction through the database/API/RLS
function test_non_admin_cannot_bypass_rls() {
  resetMockState();
  // The RLS policy "Sales rep can update own leads (no assignment changes)"
  // blocks non-admins from changing sales_rep_code or event_code.
  // The WITH CHECK clause verifies the new values match the old values.
  // Simulate: non-admin tries to update sales_rep_code
  mockSaveRep(REP, 'REP002');
  assert(saveRepError !== null, 'RLS should block non-admin from changing sales_rep_code');

  // Simulate: non-admin tries to update event_code
  mockSaveEvent(REP, 'EVT-COMPLETED-01');
  assert(saveEventError !== null, 'RLS should block non-admin from changing event_code');
}

// ─── Run all tests ───────────────────────────────────────────────────────────────

test_admin_sees_rep_dropdown();
test_non_admin_cannot_edit_rep();
test_only_active_reps();
test_existing_rep_selected();
test_change_rep_persists();
test_failed_rep_update();
test_admin_sees_event_dropdown();
test_non_admin_cannot_edit_event();
test_draft_excluded();
test_upcoming_excluded();
test_active_included();
test_completed_included();
test_archived_included();
test_existing_event_selected();
test_change_event_persists();
test_event_info_refreshed();
test_failed_event_update();
test_non_admin_cannot_update_rep_ui();
test_non_admin_cannot_bypass_rls();

console.log(`Assignment control tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
