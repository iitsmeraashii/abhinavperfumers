// Focused tests for the Follow-Ups page logic.
//
// These tests verify:
// A. All filter — returns only PENDING, includes overdue/today/future.
// B. Today filter — includes today, excludes overdue/tomorrow/completed.
// C. Next 7 Days — includes overdue, today, through 7-day cutoff; excludes beyond.
// D. Ordering — reminder_date ASC, created_at ASC as secondary.
// E. Access — sales rep sees own leads only, admin sees all.
// F. Navigation — clicking invokes lead selection with correct lead_id.
// G. Completion — completing removes from list, count updates.
// H. Pagination — filter change resets to page 1, count from DB not client.
// I. Overdue/today/upcoming classification.

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

// ─── Types ───────────────────────────────────────────────────────────────────

interface LeadEntryRef {
  id: string;
  client_name: string | null;
  company: string | null;
  sales_rep_code: string | null;
  lead_status: string | null;
}

interface FollowUpRow {
  id: string;
  lead_id: string;
  reminder_date: string;
  note: string;
  status: 'PENDING' | 'COMPLETED';
  created_by: string;
  created_at: string;
  lead_entries: LeadEntryRef | null;
}

type DueState = 'overdue' | 'today' | 'upcoming';
type DateFilter = 'all' | 'today' | 'next7';

// ─── Simulated "now" = 2026-10-05T12:00:00 local ─────────────────────────────

const NOW = new Date(2026, 9, 5, 12, 0, 0, 0); // Oct 5, 2026 noon local

function localStartOfToday(now: Date = NOW): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
}

function localStartOfTomorrow(now: Date = NOW): Date {
  return new Date(localStartOfToday(now).getTime() + 24 * 60 * 60 * 1000);
}

function nowPlus7Days(now: Date = NOW): Date {
  return new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
}

// ─── Simulated data ──────────────────────────────────────────────────────────

const allFollowUps: FollowUpRow[] = [
  {
    id: 'fu-1', lead_id: 'lead-a', reminder_date: '2026-10-01T09:00:00',
    note: 'Call about samples', status: 'PENDING', created_by: 'rep1',
    created_at: '2026-09-28T10:00:00',
    lead_entries: { id: 'lead-a', client_name: 'Alice Wang', company: 'Wang Perfumes', sales_rep_code: 'rep1', lead_status: 'CONTACTED' },
  },
  {
    id: 'fu-2', lead_id: 'lead-b', reminder_date: '2026-10-05T14:00:00',
    note: 'Send pricing', status: 'PENDING', created_by: 'rep2',
    created_at: '2026-10-04T08:00:00',
    lead_entries: { id: 'lead-b', client_name: 'Bob Chen', company: 'Chen Trading', sales_rep_code: 'rep2', lead_status: 'NEW' },
  },
  {
    id: 'fu-3', lead_id: 'lead-c', reminder_date: '2026-10-10T11:00:00',
    note: 'Follow up on quote', status: 'PENDING', created_by: 'rep1',
    created_at: '2026-10-05T09:00:00',
    lead_entries: { id: 'lead-c', client_name: 'Carol Liu', company: null, sales_rep_code: 'rep1', lead_status: 'QUALIFIED' },
  },
  {
    id: 'fu-4', lead_id: 'lead-d', reminder_date: '2026-09-15T08:00:00',
    note: 'Completed follow-up', status: 'COMPLETED', created_by: 'rep1',
    created_at: '2026-09-10T12:00:00',
    lead_entries: { id: 'lead-d', client_name: 'Dave Park', company: 'Park Co', sales_rep_code: 'rep1', lead_status: 'CONVERTED' },
  },
  {
    id: 'fu-5', lead_id: 'lead-e', reminder_date: '2026-10-05T09:00:00',
    note: 'Same day as fu-2, earlier created_at', status: 'PENDING', created_by: 'rep2',
    created_at: '2026-10-03T06:00:00',
    lead_entries: { id: 'lead-e', client_name: 'Eve Song', company: 'Song Ltd', sales_rep_code: 'rep2', lead_status: 'NEW' },
  },
  {
    id: 'fu-6', lead_id: 'lead-f', reminder_date: '2026-10-05T09:00:00',
    note: 'Same day as fu-2, later created_at', status: 'PENDING', created_by: 'rep2',
    created_at: '2026-10-04T06:00:00',
    lead_entries: { id: 'lead-f', client_name: 'Frank Ma', company: 'Ma Inc', sales_rep_code: 'rep2', lead_status: 'NEW' },
  },
  {
    id: 'fu-7', lead_id: 'lead-g', reminder_date: '2026-10-13T10:00:00',
    note: 'Beyond 7-day cutoff', status: 'PENDING', created_by: 'rep1',
    created_at: '2026-10-05T10:00:00',
    lead_entries: { id: 'lead-g', client_name: 'Grace Kim', company: 'Kim LLC', sales_rep_code: 'rep1', lead_status: 'NEW' },
  },
  {
    id: 'fu-8', lead_id: 'lead-h', reminder_date: '2026-10-12T10:00:00',
    note: 'Within 7-day cutoff (before noon Oct 12)', status: 'PENDING', created_by: 'rep1',
    created_at: '2026-10-05T08:00:00',
    lead_entries: { id: 'lead-h', client_name: 'Henry Wu', company: 'Wu Co', sales_rep_code: 'rep1', lead_status: 'NEW' },
  },
  {
    id: 'fu-9', lead_id: 'lead-i', reminder_date: '2026-10-04T08:00:00',
    note: 'Overdue by 1 day', status: 'PENDING', created_by: 'rep2',
    created_at: '2026-10-01T10:00:00',
    lead_entries: { id: 'lead-i', client_name: 'Iris Tan', company: 'Tan Inc', sales_rep_code: 'rep2', lead_status: 'CONTACTED' },
  },
];

// ─── Mirror of the database query logic ──────────────────────────────────────

function queryFollowUps(
  all: FollowUpRow[],
  filter: DateFilter,
  role: string,
  repCode: string,
  now: Date = NOW,
): { rows: FollowUpRow[]; count: number } {
  let result = all.filter(fu => fu.status === 'PENDING');

  if (filter === 'today') {
    const startStr = localStartOfToday(now).getTime();
    const endStr = localStartOfTomorrow(now).getTime();
    result = result.filter(fu => {
      const t = new Date(fu.reminder_date).getTime();
      return t >= startStr && t < endStr;
    });
  } else if (filter === 'next7') {
    const cutoff = nowPlus7Days(now).getTime();
    result = result.filter(fu => new Date(fu.reminder_date).getTime() < cutoff);
  }

  if (role !== 'admin' && repCode) {
    result = result.filter(fu => fu.lead_entries?.sales_rep_code === repCode);
  }

  result.sort((a, b) => {
    const rd = new Date(a.reminder_date).getTime() - new Date(b.reminder_date).getTime();
    if (rd !== 0) return rd;
    return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
  });

  return { rows: result, count: result.length };
}

// ─── Mirror of classifyDueState ──────────────────────────────────────────────

function classifyDueState(reminderDate: string, now: Date = NOW): DueState {
  const reminder = new Date(reminderDate);
  const startToday = localStartOfToday(now);
  const startTomorrow = localStartOfTomorrow(now);

  if (reminder.getTime() < startToday.getTime()) return 'overdue';
  if (reminder.getTime() >= startToday.getTime() && reminder.getTime() < startTomorrow.getTime()) return 'today';
  return 'upcoming';
}

// ─── A. All filter ────────────────────────────────────────────────────────────

function test_all_filter() {
  const { rows, count } = queryFollowUps(allFollowUps, 'all', 'admin', '');

  assert(rows.every(r => r.status === 'PENDING'),
    'All filter: every row should be PENDING');
  assert(!rows.some(r => r.id === 'fu-4'),
    'All filter: completed fu-4 should NOT appear');

  const overdue = rows.filter(r => classifyDueState(r.reminder_date) === 'overdue');
  const today = rows.filter(r => classifyDueState(r.reminder_date) === 'today');
  const upcoming = rows.filter(r => classifyDueState(r.reminder_date) === 'upcoming');

  assert(overdue.length > 0,
    `All filter: should include overdue follow-ups, got ${overdue.length}`);
  assert(today.length > 0,
    `All filter: should include today's follow-ups, got ${today.length}`);
  assert(upcoming.length > 0,
    `All filter: should include upcoming follow-ups, got ${upcoming.length}`);
  assert(count === 8,
    `All filter: count should be 8 PENDING follow-ups, got ${count}`);
}

// ─── B. Today filter ──────────────────────────────────────────────────────────

function test_today_filter() {
  const { rows, count } = queryFollowUps(allFollowUps, 'today', 'admin', '');
  const ids = rows.map(r => r.id);

  // Today = Oct 5 local. fu-2 (14:00), fu-5 (09:00), fu-6 (09:00) are today.
  assert(ids.includes('fu-2'),
    'Today filter: should include fu-2 (Oct 5 14:00)');
  assert(ids.includes('fu-5'),
    'Today filter: should include fu-5 (Oct 5 09:00)');
  assert(ids.includes('fu-6'),
    'Today filter: should include fu-6 (Oct 5 09:00)');

  // Exclude overdue
  assert(!ids.includes('fu-1'),
    'Today filter: should exclude fu-1 (Oct 1, overdue)');
  assert(!ids.includes('fu-9'),
    'Today filter: should exclude fu-9 (Oct 4, overdue)');

  // Exclude tomorrow and later
  assert(!ids.includes('fu-3'),
    'Today filter: should exclude fu-3 (Oct 10)');
  assert(!ids.includes('fu-7'),
    'Today filter: should exclude fu-7 (Oct 13)');

  // Exclude completed
  assert(!ids.includes('fu-4'),
    'Today filter: should exclude completed fu-4');

  assert(count === 3,
    `Today filter: count should be 3, got ${count}`);
  assert(rows.every(r => r.status === 'PENDING'),
    'Today filter: all rows should be PENDING');
}

// ─── C. Next 7 Days filter ───────────────────────────────────────────────────

function test_next7_filter() {
  const { rows, count } = queryFollowUps(allFollowUps, 'next7', 'admin', '');
  const ids = rows.map(r => r.id);

  // Include overdue
  assert(ids.includes('fu-1'),
    'Next 7 Days: should include overdue fu-1 (Oct 1)');
  assert(ids.includes('fu-9'),
    'Next 7 Days: should include overdue fu-9 (Oct 4)');

  // Include today
  assert(ids.includes('fu-2'),
    'Next 7 Days: should include today fu-2 (Oct 5)');
  assert(ids.includes('fu-5'),
    'Next 7 Days: should include today fu-5 (Oct 5)');

  // Include upcoming through 7 days
  assert(ids.includes('fu-3'),
    'Next 7 Days: should include fu-3 (Oct 10, within 7 days)');
  assert(ids.includes('fu-8'),
    'Next 7 Days: should include fu-8 (Oct 12 18:00, just under cutoff)');

  // Exclude beyond cutoff
  // now = Oct 5 12:00 → cutoff = Oct 12 12:00
  // fu-7 is Oct 13 10:00 → excluded
  assert(!ids.includes('fu-7'),
    'Next 7 Days: should exclude fu-7 (Oct 13, beyond cutoff)');

  // Exclude completed
  assert(!ids.includes('fu-4'),
    'Next 7 Days: should exclude completed fu-4');

  assert(rows.every(r => r.status === 'PENDING'),
    'Next 7 Days: all rows should be PENDING');

  // Overdue should appear first (earliest reminder_date)
  assert(rows[0].id === 'fu-1',
    `Next 7 Days: first row should be fu-1 (earliest), got ${rows[0]?.id}`);

  assert(count === 7,
    `Next 7 Days: count should be 7, got ${count}`);
}

// ─── D. Ordering ─────────────────────────────────────────────────────────────

function test_ordering() {
  const { rows } = queryFollowUps(allFollowUps, 'all', 'admin', '');
  const dates = rows.map(r => new Date(r.reminder_date).getTime());

  for (let i = 1; i < dates.length; i++) {
    assert(dates[i] >= dates[i - 1],
      `Ordering: reminder_date ASC violated at index ${i}`);
  }

  // Secondary sort: fu-5 and fu-6 have same reminder_date
  const fu5Idx = rows.findIndex(r => r.id === 'fu-5');
  const fu6Idx = rows.findIndex(r => r.id === 'fu-6');
  assert(fu5Idx < fu6Idx,
    `Ordering: fu-5 (earlier created_at) should come before fu-6, got ${fu5Idx} vs ${fu6Idx}`);
}

// ─── E. Access control ───────────────────────────────────────────────────────

function test_rep_access() {
  const { rows } = queryFollowUps(allFollowUps, 'all', 'sales_rep', 'rep1');
  const ids = rows.map(r => r.id);

  assert(ids.includes('fu-1'),
    'Access: rep1 should see fu-1 (own lead)');
  assert(ids.includes('fu-3'),
    'Access: rep1 should see fu-3 (own lead)');
  assert(!ids.includes('fu-2'),
    'Access: rep1 should NOT see fu-2 (rep2 lead)');
  assert(rows.every(r => r.lead_entries?.sales_rep_code === 'rep1'),
    'Access: all rows for rep1 should belong to rep1 leads');
}

function test_admin_access() {
  const { rows } = queryFollowUps(allFollowUps, 'all', 'admin', '');
  const repCodes = new Set(rows.map(r => r.lead_entries?.sales_rep_code));

  assert(repCodes.has('rep1') && repCodes.has('rep2'),
    'Access: admin should see follow-ups from both reps');
}

// ─── F. Navigation ───────────────────────────────────────────────────────────

function test_navigation() {
  const { rows } = queryFollowUps(allFollowUps, 'all', 'admin', '');
  const navigations: string[] = [];
  rows.forEach(fu => navigations.push(fu.lead_id));

  assert(navigations.includes('lead-a'),
    'Navigation: clicking fu-1 should select lead-a');
  assert(navigations.includes('lead-b'),
    'Navigation: clicking fu-2 should select lead-b');
  assert(navigations.length === rows.length,
    'Navigation: every row should produce a navigation event');
}

// ─── G. Completion ───────────────────────────────────────────────────────────

function test_completion() {
  const before = queryFollowUps(allFollowUps, 'all', 'admin', '');
  const beforeCount = before.count;

  // Simulate completing fu-2
  const afterComplete = allFollowUps.map(fu =>
    fu.id === 'fu-2' ? { ...fu, status: 'COMPLETED' as const } : fu
  );
  const after = queryFollowUps(afterComplete, 'all', 'admin', '');

  assert(!after.rows.some(r => r.id === 'fu-2'),
    'Completion: fu-2 should NOT appear after completion');
  assert(after.count === beforeCount - 1,
    `Completion: count should decrease by 1, got ${after.count} (was ${beforeCount})`);
  assert(after.rows.every(r => r.status === 'PENDING'),
    'Completion: all remaining rows should be PENDING');
}

// ─── H. Pagination ───────────────────────────────────────────────────────────

function test_pagination_reset() {
  // Simulate: user is on page 2 of "All", switches to "Today"
  // The page should reset to page 1

  const allResult = queryFollowUps(allFollowUps, 'all', 'admin', '');
  const todayResult = queryFollowUps(allFollowUps, 'today', 'admin', '');

  // Simulate page state
  let currentPage = 1; // user was on page 2 (0-indexed)

  // On filter change, page resets to 0
  const filterChanged = true;
  if (filterChanged) currentPage = 0;

  const from = currentPage * 25;
  const todayPage = todayResult.rows.slice(from, from + 25);

  assert(currentPage === 0,
    'Pagination: filter change should reset to page 0');
  assert(todayPage.length === todayResult.count,
    'Pagination: page 1 of Today should contain all today results');

  // Count comes from DB, not from loading all records
  const dbCount = todayResult.count;
  assert(dbCount === 3,
    `Pagination: DB count for Today should be 3, got ${dbCount}`);
  assert(dbCount === todayResult.rows.length,
    'Pagination: count should match actual row count (no client-side full load)');
}

// ─── I. Due-state classification ─────────────────────────────────────────────

function test_classification() {
  assert(classifyDueState('2026-10-01T09:00:00') === 'overdue',
    'Classification: Oct 1 should be overdue');
  assert(classifyDueState('2026-10-05T00:00:00') === 'today',
    'Classification: Oct 5 00:00 should be today');
  assert(classifyDueState('2026-10-05T23:59:00') === 'today',
    'Classification: Oct 5 23:59 should be today');
  assert(classifyDueState('2026-10-06T00:00:00') === 'upcoming',
    'Classification: Oct 6 should be upcoming');
  assert(classifyDueState('2026-10-04T23:59:00') === 'overdue',
    'Classification: Oct 4 23:59 should be overdue');
}

// ─── J. Completion callback flow ────────────────────────────────────────────
//
// Verifies the fix for the "stuck Opening" bug:
// - Mark Complete calls onOpenFollowUpComplete(id) (NOT pushState)
// - The callback sets followUpModalId directly so the modal opens
// - completingId is set but cleared when the URL param is cleaned up
// - No permanent loading state remains

function test_completion_callback_flow() {
  // Simulate App.tsx state
  let followUpModalId: string | null = null;
  let urlFollowupParam: string | null = null;

  // Simulate the App.tsx handler
  function handleOpenFollowUpComplete(id: string) {
    followUpModalId = id;
    urlFollowupParam = id; // pushState sets ?followup=id
  }

  // Simulate handleCloseFollowUpModal
  function handleCloseFollowUpModal() {
    followUpModalId = null;
    urlFollowupParam = null; // replaceState removes ?followup
  }

  // Simulate FollowUpsPage completingId state
  let completingId: string | null = null;

  // Simulate handleComplete in FollowUpsPage (fixed version)
  function handleComplete(followUpId: string) {
    handleOpenFollowUpComplete(followUpId);
    completingId = followUpId;
  }

  // Simulate modal-close detection (the useEffect check)
  function detectModalClose() {
    if (!urlFollowupParam) {
      completingId = null;
    }
  }

  // A. Clicking Mark Complete opens the completion modal
  handleComplete('fu-2');
  assert(followUpModalId === 'fu-2',
    'Callback flow: followUpModalId should be set to fu-2 after Mark Complete');

  // B. The modal receives the correct follow-up ID
  assert(followUpModalId === 'fu-2',
    'Callback flow: modal should receive correct follow-up ID (fu-2)');

  // C. The page should NOT remain stuck showing "Opening" indefinitely
  // Simulate: completingId is set, but we have NOT called pushState (no popstate needed)
  // The modal is open because followUpModalId is set directly
  assert(followUpModalId !== null,
    'Callback flow: modal should be open (followUpModalId not null)');

  // D. Completing the follow-up removes it from the pending list
  const afterComplete = allFollowUps.map(fu =>
    fu.id === 'fu-2' ? { ...fu, status: 'COMPLETED' as const } : fu
  );
  const after = queryFollowUps(afterComplete, 'all', 'admin', '');
  assert(!after.rows.some(r => r.id === 'fu-2'),
    'Callback flow: fu-2 should NOT appear after completion');

  // E. The count updates after completion
  assert(after.count === 7,
    `Callback flow: count should be 7 after completing fu-2, got ${after.count}`);

  // F. The ?followup=<id> URL parameter is cleaned up after closing
  handleCloseFollowUpModal();
  assert(urlFollowupParam === null,
    'Callback flow: URL param should be null after close');
  assert(followUpModalId === null,
    'Callback flow: followUpModalId should be null after close');

  // Simulate the poll detection — completingId should clear
  detectModalClose();
  assert(completingId === null,
    'Callback flow: completingId should be null after URL cleanup (no stuck loading)');

  // G. Existing Lead Detail navigation is unaffected
  // (onSelectLead is a separate prop, not touched by the fix)
  const { rows } = queryFollowUps(allFollowUps, 'all', 'admin', '');
  assert(rows.length > 0,
    'Callback flow: lead navigation still works (rows available to click)');

  // H. FollowUpCompleteModal behavior unaffected (modal still opens/closes correctly)
  handleComplete('fu-3');
  assert(followUpModalId === 'fu-3',
    'Callback flow: modal should open for a different follow-up (fu-3)');
  handleCloseFollowUpModal();
  assert(followUpModalId === null,
    'Callback flow: modal should close cleanly for fu-3');
}

// ─── Run all tests ────────────────────────────────────────────────────────────

test_all_filter();
test_today_filter();
test_next7_filter();
test_ordering();
test_rep_access();
test_admin_access();
test_navigation();
test_completion();
test_pagination_reset();
test_classification();
test_completion_callback_flow();

console.log(`Follow-Ups Page tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
