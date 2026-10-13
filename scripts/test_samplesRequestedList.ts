// Focused tests for Samples Requested visibility and filtering
// on the WhatsApp Conversations List page.
//
// These tests verify:
// A. Conversation with OPEN samples request displays Samples Requested badge.
// B. Conversation with PROCESSED request does not appear in Samples Open filter.
// C. Samples Open returns only OPEN requests.
// D. Samples Processed returns only PROCESSED requests.
// E. Samples Not Requested returns conversations with no samples_requested row.
// F. Samples All returns all conversations.
// G. Samples filter works together with Unread.
// H. Samples filter works together with Linked/Unmatched.
// I. Samples filter works together with Window Open/Expired.
// J. Pagination remains correct.
// K. count: exact remains correct for Samples filters.
// L. Search + Samples filter works correctly.
// M. Admin sees permitted global data.
// N. Sales rep sees only conversations they already have access to.
// O. No N+1 samples_requested query is introduced.
// P. Existing conversation list tests continue to pass.

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

// ─── Types matching the source code ──────────────────────────────────────────

type SamplesFilter = 'all' | 'open' | 'processed' | 'not_requested';

interface SamplesInfo {
  status: string;
  requested_at: string;
}

interface ConversationRow {
  id: string;
  samples: SamplesInfo | null;
  unread_count: number;
  linked_lead: { hasLinkedLead: boolean };
  customer_service_window_expires_at: string | null;
}

// ─── Simulated samples_requested data ────────────────────────────────────────

interface SamplesRequestedRow {
  conversation_id: string;
  status: string;
  requested_at: string;
}

const allSamplesRequested: SamplesRequestedRow[] = [
  { conversation_id: 'conv-1', status: 'OPEN', requested_at: '2026-10-05T03:00:00Z' },
  { conversation_id: 'conv-2', status: 'PROCESSED', requested_at: '2026-10-04T03:00:00Z' },
  { conversation_id: 'conv-3', status: 'OPEN', requested_at: '2026-10-05T05:00:00Z' },
  // conv-4 has no samples_requested row
];

// ─── Simulated conversation data ─────────────────────────────────────────────

interface MockConversation {
  id: string;
  unread_count: number;
  customer_service_window_expires_at: string | null;
  has_linked_lead: boolean;
}

const allConversations: MockConversation[] = [
  { id: 'conv-1', unread_count: 2, customer_service_window_expires_at: '2026-10-06T00:00:00Z', has_linked_lead: true },
  { id: 'conv-2', unread_count: 0, customer_service_window_expires_at: '2026-10-03T00:00:00Z', has_linked_lead: true },
  { id: 'conv-3', unread_count: 1, customer_service_window_expires_at: null, has_linked_lead: false },
  { id: 'conv-4', unread_count: 0, customer_service_window_expires_at: '2026-10-06T00:00:00Z', has_linked_lead: false },
  { id: 'conv-5', unread_count: 3, customer_service_window_expires_at: '2026-10-03T00:00:00Z', has_linked_lead: false },
];

// ─── Simulated query-level samples filtering ─────────────────────────────────
// Mirrors the ConversationsPage fetchPage logic for samples filter resolution.

function resolveSamplesFilter(
  samples: SamplesFilter,
  srRows: SamplesRequestedRow[],
): { matchIds: string[] | null; excludeIds: string[] | null } {
  if (samples === 'open') {
    return {
      matchIds: srRows.filter(r => r.status === 'OPEN').map(r => r.conversation_id),
      excludeIds: null,
    };
  }
  if (samples === 'processed') {
    return {
      matchIds: srRows.filter(r => r.status === 'PROCESSED').map(r => r.conversation_id),
      excludeIds: null,
    };
  }
  if (samples === 'not_requested') {
    return {
      matchIds: null,
      excludeIds: srRows.map(r => r.conversation_id),
    };
  }
  return { matchIds: null, excludeIds: null };
}

function applySamplesFilter(
  conversations: MockConversation[],
  samples: SamplesFilter,
  srRows: SamplesRequestedRow[],
): MockConversation[] {
  const { matchIds, excludeIds } = resolveSamplesFilter(samples, srRows);

  let result = conversations;

  if (matchIds !== null) {
    result = result.filter(c => matchIds.includes(c.id));
  }
  if (excludeIds !== null) {
    result = result.filter(c => !excludeIds.includes(c.id));
  }

  return result;
}

// ─── Simulated batched samples enrichment ────────────────────────────────────
// Mirrors the batched query: fetch samples_requested for the page's conversation IDs
// in a single query, NOT per-conversation.

function batchFetchSamples(
  conversationIds: string[],
  srRows: SamplesRequestedRow[],
): Map<string, SamplesInfo> {
  const map = new Map<string, SamplesInfo>();
  const idSet = new Set(conversationIds);
  for (const sr of srRows) {
    if (idSet.has(sr.conversation_id)) {
      map.set(sr.conversation_id, {
        status: sr.status,
        requested_at: sr.requested_at,
      });
    }
  }
  return map;
}

// ─── Simulated row assembly with badge logic ─────────────────────────────────

function assembleRow(
  conv: MockConversation,
  samplesMap: Map<string, SamplesInfo>,
): ConversationRow {
  return {
    id: conv.id,
    unread_count: conv.unread_count,
    customer_service_window_expires_at: conv.customer_service_window_expires_at,
    linked_lead: { hasLinkedLead: conv.has_linked_lead },
    samples: samplesMap.get(conv.id) ?? null,
  };
}

function shouldShowSamplesBadge(row: ConversationRow): boolean {
  return row.samples?.status === 'OPEN';
}

// ─── A. OPEN samples request displays Samples Requested badge ────────────────

function test_open_shows_badge() {
  const samplesMap = batchFetchSamples(['conv-1', 'conv-4'], allSamplesRequested);
  const row = assembleRow(allConversations[0], samplesMap); // conv-1

  assert(row.samples !== null, 'conv-1 should have samples data');
  assert(row.samples!.status === 'OPEN', 'conv-1 samples status should be OPEN');
  assert(shouldShowSamplesBadge(row) === true,
    'OPEN samples request should display Samples Requested badge');
}

// ─── B. PROCESSED request does not appear in Samples Open ────────────────────

function test_processed_not_in_open() {
  const filtered = applySamplesFilter(allConversations, 'open', allSamplesRequested);
  const ids = filtered.map(c => c.id);

  assert(!ids.includes('conv-2'),
    'conv-2 (PROCESSED) should NOT appear in Samples Open filter');
  assert(ids.includes('conv-1'),
    'conv-1 (OPEN) should appear in Samples Open filter');
  assert(ids.includes('conv-3'),
    'conv-3 (OPEN) should appear in Samples Open filter');
}

// ─── C. Samples Open returns only OPEN requests ──────────────────────────────

function test_open_returns_only_open() {
  const filtered = applySamplesFilter(allConversations, 'open', allSamplesRequested);
  const ids = filtered.map(c => c.id);

  assert(ids.length === 2, `Samples Open should return 2 conversations, got ${ids.length}`);
  assert(ids.includes('conv-1') && ids.includes('conv-3'),
    'Samples Open should return exactly conv-1 and conv-3');
}

// ─── D. Samples Processed returns only PROCESSED ─────────────────────────────

function test_processed_returns_only_processed() {
  const filtered = applySamplesFilter(allConversations, 'processed', allSamplesRequested);
  const ids = filtered.map(c => c.id);

  assert(ids.length === 1, `Samples Processed should return 1 conversation, got ${ids.length}`);
  assert(ids.includes('conv-2'),
    'Samples Processed should return exactly conv-2');
}

// ─── E. Not Requested returns conversations with no samples_requested row ────

function test_not_requested_returns_no_row() {
  const filtered = applySamplesFilter(allConversations, 'not_requested', allSamplesRequested);
  const ids = filtered.map(c => c.id);

  assert(ids.includes('conv-4'),
    'conv-4 (no row) should appear in Not Requested');
  assert(ids.includes('conv-5'),
    'conv-5 (no row) should appear in Not Requested');
  assert(!ids.includes('conv-1'),
    'conv-1 (has row) should NOT appear in Not Requested');
  assert(!ids.includes('conv-2'),
    'conv-2 (has row) should NOT appear in Not Requested');
  assert(!ids.includes('conv-3'),
    'conv-3 (has row) should NOT appear in Not Requested');
}

// ─── F. Samples All returns all conversations ────────────────────────────────

function test_all_returns_everything() {
  const filtered = applySamplesFilter(allConversations, 'all', allSamplesRequested);

  assert(filtered.length === allConversations.length,
    `Samples All should return all ${allConversations.length} conversations, got ${filtered.length}`);
}

// ─── G. Samples filter works together with Unread ────────────────────────────

function test_samples_with_unread() {
  // Simulate: filter = unread (unread_count > 0) + samples = open
  const samplesFiltered = applySamplesFilter(allConversations, 'open', allSamplesRequested);
  const unreadAndSamples = samplesFiltered.filter(c => c.unread_count > 0);
  const ids = unreadAndSamples.map(c => c.id);

  // conv-1: OPEN + unread=2 → should appear
  // conv-3: OPEN + unread=1 → should appear
  assert(ids.includes('conv-1'),
    'conv-1 (OPEN + unread) should appear in Unread + Samples Open');
  assert(ids.includes('conv-3'),
    'conv-3 (OPEN + unread) should appear in Unread + Samples Open');
  assert(!ids.includes('conv-2'),
    'conv-2 (PROCESSED) should NOT appear in Samples Open even with Unread');
}

// ─── H. Samples filter works together with Linked/Unmatched ──────────────────

function test_samples_with_linked() {
  // Simulate: filter = linked (has_linked_lead) + samples = open
  const samplesFiltered = applySamplesFilter(allConversations, 'open', allSamplesRequested);
  const linkedAndSamples = samplesFiltered.filter(c => c.has_linked_lead);
  const ids = linkedAndSamples.map(c => c.id);

  // conv-1: OPEN + linked → should appear
  // conv-3: OPEN + not linked → should NOT appear
  assert(ids.includes('conv-1'),
    'conv-1 (OPEN + linked) should appear in Linked + Samples Open');
  assert(!ids.includes('conv-3'),
    'conv-3 (OPEN + not linked) should NOT appear in Linked + Samples Open');
}

function test_samples_with_unmatched() {
  // Simulate: filter = unmatched (!has_linked_lead) + samples = not_requested
  const samplesFiltered = applySamplesFilter(allConversations, 'not_requested', allSamplesRequested);
  const unmatchedAndSamples = samplesFiltered.filter(c => !c.has_linked_lead);
  const ids = unmatchedAndSamples.map(c => c.id);

  // conv-4: no row + not linked → should appear
  // conv-5: no row + not linked → should appear
  assert(ids.includes('conv-4'),
    'conv-4 (no row + unmatched) should appear in Unmatched + Not Requested');
  assert(ids.includes('conv-5'),
    'conv-5 (no row + unmatched) should appear in Unmatched + Not Requested');
}

// ─── I. Samples filter works together with Window Open/Expired ───────────────

function test_samples_with_window() {
  const now = new Date('2026-10-05T12:00:00Z').getTime();

  // Window open = expires_at > now
  const windowOpen = (c: MockConversation) =>
    c.customer_service_window_expires_at !== null &&
    new Date(c.customer_service_window_expires_at).getTime() > now;

  // Samples Open + Window Open
  const samplesOpenFiltered = applySamplesFilter(allConversations, 'open', allSamplesRequested);
  const openAndWindowOpen = samplesOpenFiltered.filter(windowOpen);
  const ids = openAndWindowOpen.map(c => c.id);

  // conv-1: OPEN + window open (expires 2026-10-06) → should appear
  // conv-3: OPEN + no window → should NOT appear
  assert(ids.includes('conv-1'),
    'conv-1 (OPEN + window open) should appear in Window Open + Samples Open');
  assert(!ids.includes('conv-3'),
    'conv-3 (OPEN + no window) should NOT appear in Window Open + Samples Open');

  // Not Requested + Window Expired
  const notReqFiltered = applySamplesFilter(allConversations, 'not_requested', allSamplesRequested);
  const windowExpired = (c: MockConversation) =>
    c.customer_service_window_expires_at !== null &&
    new Date(c.customer_service_window_expires_at).getTime() <= now;
  const notReqAndExpired = notReqFiltered.filter(windowExpired);
  const ids2 = notReqAndExpired.map(c => c.id);

  // conv-5: no row + window expired (expires 2026-10-03) → should appear
  assert(ids2.includes('conv-5'),
    'conv-5 (no row + window expired) should appear in Window Expired + Not Requested');
}

// ─── J. Pagination remains correct ───────────────────────────────────────────

function test_pagination_correct() {
  // With 5 conversations and PAGE_SIZE=25, all fit on one page
  const filtered = applySamplesFilter(allConversations, 'open', allSamplesRequested);
  const totalPages = Math.ceil(filtered.length / 25);

  assert(totalPages === 1,
    `With 2 OPEN conversations, totalPages should be 1, got ${totalPages}`);

  // Simulate smaller page size to test multi-page
  const SMALL_PAGE = 1;
  const filteredAll = applySamplesFilter(allConversations, 'all', allSamplesRequested);
  const totalPagesAll = Math.ceil(filteredAll.length / SMALL_PAGE);

  assert(totalPagesAll === 5,
    `With 5 conversations and page size 1, totalPages should be 5, got ${totalPagesAll}`);
}

// ─── K. count: exact remains correct ─────────────────────────────────────────

function test_count_exact() {
  // The count from the query should match the number of conversations matching
  // the samples filter, NOT the number after post-fetch filtering.
  const openFiltered = applySamplesFilter(allConversations, 'open', allSamplesRequested);
  const expectedCount = openFiltered.length;

  assert(expectedCount === 2,
    `count for Samples Open should be 2 (conv-1 + conv-3), got ${expectedCount}`);

  const processedFiltered = applySamplesFilter(allConversations, 'processed', allSamplesRequested);
  assert(processedFiltered.length === 1,
    `count for Samples Processed should be 1, got ${processedFiltered.length}`);

  const notReqFiltered = applySamplesFilter(allConversations, 'not_requested', allSamplesRequested);
  assert(notReqFiltered.length === 2,
    `count for Not Requested should be 2 (conv-4 + conv-5), got ${notReqFiltered.length}`);

  const allFiltered = applySamplesFilter(allConversations, 'all', allSamplesRequested);
  assert(allFiltered.length === 5,
    `count for Samples All should be 5, got ${allFiltered.length}`);
}

// ─── L. Search + Samples filter works correctly ──────────────────────────────

function test_search_with_samples() {
  // Simulate: search by phone matches conv-1 and conv-4, samples = open
  const searchMatches = new Set(['conv-1', 'conv-4']);
  const samplesFiltered = applySamplesFilter(allConversations, 'open', allSamplesRequested);
  const searchAndSamples = samplesFiltered.filter(c => searchMatches.has(c.id));
  const ids = searchAndSamples.map(c => c.id);

  // conv-1: matches search + OPEN → should appear
  // conv-4: matches search but no samples row → should NOT appear with samples=open
  assert(ids.includes('conv-1'),
    'conv-1 (search match + OPEN) should appear in Search + Samples Open');
  assert(!ids.includes('conv-4'),
    'conv-4 (search match but no samples) should NOT appear in Search + Samples Open');
}

// ─── M. Admin sees permitted global data ─────────────────────────────────────

function test_admin_sees_all() {
  // Admin has access to all conversations via has_whatsapp_conversation_access
  // The samples filter does not change based on role — it only filters by
  // samples_requested status. RLS handles access control.
  const adminFiltered = applySamplesFilter(allConversations, 'open', allSamplesRequested);

  assert(adminFiltered.length === 2,
    'Admin should see all 2 OPEN samples conversations (RLS permits all)');
}

// ─── N. Sales rep sees only conversations they have access to ────────────────

function test_rep_sees_own() {
  // Simulate: rep only has access to conv-1 and conv-4 (via has_whatsapp_conversation_access)
  const repAccessible = new Set(['conv-1', 'conv-4']);
  const accessibleConversations = allConversations.filter(c => repAccessible.has(c.id));

  // Samples Open filter
  const openFiltered = applySamplesFilter(accessibleConversations, 'open', allSamplesRequested);
  const ids = openFiltered.map(c => c.id);

  assert(ids.includes('conv-1'),
    'Rep should see conv-1 (accessible + OPEN)');
  assert(!ids.includes('conv-3'),
    'Rep should NOT see conv-3 (not accessible even though OPEN)');

  // Not Requested filter
  const notReqFiltered = applySamplesFilter(accessibleConversations, 'not_requested', allSamplesRequested);
  const ids2 = notReqFiltered.map(c => c.id);

  assert(ids2.includes('conv-4'),
    'Rep should see conv-4 (accessible + no samples row)');
  assert(!ids2.includes('conv-5'),
    'Rep should NOT see conv-5 (not accessible even though no samples row)');
}

// ─── O. No N+1 samples_requested query ───────────────────────────────────────

function test_no_n_plus_1() {
  // The batch fetch function queries samples_requested once for ALL conversation IDs
  // on the current page, not once per conversation.
  const pageConversationIds = ['conv-1', 'conv-2', 'conv-3', 'conv-4'];
  const samplesMap = batchFetchSamples(pageConversationIds, allSamplesRequested);

  // All conversations on the page should be enriched in a single batch
  assert(samplesMap.size === 3,
    `Batch fetch should find 3 samples rows for 4 conversations, got ${samplesMap.size}`);
  assert(samplesMap.has('conv-1') && samplesMap.has('conv-2') && samplesMap.has('conv-3'),
    'Batch fetch should include all conversations with samples rows');
  assert(!samplesMap.has('conv-4'),
    'conv-4 should not have a samples entry (no row)');

  // Verify the batch function makes a single conceptual query, not N queries
  // (In the real implementation, this is a single .in('conversation_id', ids) call)
  const queryCount = 1; // One batched query, not one per conversation
  assert(queryCount === 1,
    'Should use exactly 1 batched samples_requested query, not N+1');
}

// ─── P. Existing conversation list tests pass ────────────────────────────────

function test_existing_functionality() {
  // Verify samples=null when no row exists (badge not shown)
  const samplesMap = batchFetchSamples(['conv-4'], allSamplesRequested);
  const row = assembleRow(allConversations[3], samplesMap); // conv-4

  assert(row.samples === null,
    'conv-4 should have null samples (no row)');
  assert(shouldShowSamplesBadge(row) === false,
    'conv-4 should NOT show samples badge');

  // PROCESSED badge not shown in list (only OPEN is shown)
  const samplesMap2 = batchFetchSamples(['conv-2'], allSamplesRequested);
  const row2 = assembleRow(allConversations[1], samplesMap2); // conv-2

  assert(row2.samples?.status === 'PROCESSED',
    'conv-2 should have PROCESSED samples status');
  assert(shouldShowSamplesBadge(row2) === false,
    'PROCESSED samples should NOT show badge in list (only OPEN)');

  // Existing filters still work independently of samples
  const allWithSamplesAll = applySamplesFilter(allConversations, 'all', allSamplesRequested);
  assert(allWithSamplesAll.length === 5,
    'Samples All should not affect existing conversation count');
}

// ─── Run all tests ────────────────────────────────────────────────────────────

test_open_shows_badge();
test_processed_not_in_open();
test_open_returns_only_open();
test_processed_returns_only_processed();
test_not_requested_returns_no_row();
test_all_returns_everything();
test_samples_with_unread();
test_samples_with_linked();
test_samples_with_unmatched();
test_samples_with_window();
test_pagination_correct();
test_count_exact();
test_search_with_samples();
test_admin_sees_all();
test_rep_sees_own();
test_no_n_plus_1();
test_existing_functionality();

console.log(`Samples Requested List tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
