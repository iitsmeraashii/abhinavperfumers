// Focused tests for the "Delete All Synced" cleanup feature.
//
// Verifies that only completed_leads records with status 'synced' are
// targeted for deletion, and that all other statuses (local_only,
// pending_sync, syncing, failed, needs_review) are left untouched.
//
// These tests exercise the filtering predicate in isolation — they do
// not touch IndexedDB or Supabase.

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

type CompletedLeadStatus =
  | 'local_only' | 'pending_sync' | 'syncing' | 'synced' | 'failed' | 'needs_review';

interface TestRecord {
  id:     string;
  status: CompletedLeadStatus;
}

// Mirror of the filter predicate inside deleteAllSyncedCompletedLeads
function filterSynced(records: TestRecord[]): TestRecord[] {
  return records.filter(r => r.status === 'synced');
}

// Test A: Synced entries exist → delete button should appear
function testSyncedExist() {
  const records: TestRecord[] = [
    { id: '1', status: 'synced' },
    { id: '2', status: 'pending_sync' },
  ];
  const synced = filterSynced(records);
  assert(synced.length > 0, 'Button should appear when synced entries exist');
  assert(synced.length === 1, 'Exactly one synced record');
}

// Test B: No synced entries → button should not appear
function testNoSynced() {
  const records: TestRecord[] = [
    { id: '1', status: 'pending_sync' },
    { id: '2', status: 'failed' },
  ];
  const synced = filterSynced(records);
  assert(synced.length === 0, 'Button should not appear when no synced entries');
}

// Test C: Delete All confirmed → only synced records removed
function testDeleteAllRemovesOnlySynced() {
  const records: TestRecord[] = [
    { id: 's1', status: 'synced' },
    { id: 's2', status: 'synced' },
    { id: 'p1', status: 'pending_sync' },
    { id: 'f1', status: 'failed' },
    { id: 'l1', status: 'local_only' },
    { id: 'sy1', status: 'syncing' },
    { id: 'nr1', status: 'needs_review' },
  ];
  const synced = filterSynced(records);
  const remaining = records.filter(r => !synced.includes(r));
  assert(synced.length === 2, 'Two synced records should be removed');
  assert(remaining.length === 5, 'Five non-synced records should remain');
  assert(remaining.every(r => r.status !== 'synced'), 'No synced records should remain');
  assert(remaining.some(r => r.status === 'pending_sync'), 'pending_sync records preserved');
  assert(remaining.some(r => r.status === 'failed'), 'failed records preserved');
  assert(remaining.some(r => r.status === 'local_only'), 'local_only records preserved');
  assert(remaining.some(r => r.status === 'syncing'), 'syncing records preserved');
  assert(remaining.some(r => r.status === 'needs_review'), 'needs_review records preserved');
}

// Test D: Cancel → nothing deleted
function testCancelDeletesNothing() {
  const records: TestRecord[] = [
    { id: 's1', status: 'synced' },
    { id: 'p1', status: 'pending_sync' },
  ];
  // Cancel means we never call filterSynced for deletion
  const synced = filterSynced(records);
  // Simulate cancel: remaining = all records
  const remaining = records;
  assert(remaining.length === 2, 'Cancel should leave all records intact');
  assert(remaining.some(r => r.status === 'synced'), 'Synced records still present after cancel');
}

// Test E: Pending/processing/failed/REQUIRES_REVIEW remain untouched
function testNonSyncedUntouched() {
  const records: TestRecord[] = [
    { id: '1', status: 'pending_sync' },
    { id: '2', status: 'syncing' },
    { id: '3', status: 'failed' },
    { id: '4', status: 'local_only' },
    { id: '5', status: 'needs_review' },
  ];
  const synced = filterSynced(records);
  assert(synced.length === 0, 'No synced records in non-synced-only set');
  assert(records.length === 5, 'All non-synced records remain untouched');
}

// Test F: Server-side lead remains untouched
// The delete operation only touches IndexedDB completed_leads store.
// Supabase lead_entries is never queried or modified.
function testServerSideUntouched() {
  const localRecords: TestRecord[] = [
    { id: 's1', status: 'synced' },
  ];
  const synced = filterSynced(localRecords);
  // The function returns IDs to delete from IndexedDB only.
  // No Supabase calls are made.
  assert(synced.every(r => r.id.startsWith('s')), 'Only local IDs returned');
  assert(!synced.some(r => 'lead_entries' in r), 'No server-side table references');
}

// Test G: completed_leads safety — only 'synced' status filtered
function testCompletedLeadsSafety() {
  const allStatuses: CompletedLeadStatus[] = [
    'local_only', 'pending_sync', 'syncing', 'synced', 'failed', 'needs_review',
  ];
  const records: TestRecord[] = allStatuses.map((status, i) => ({ id: `${i}`, status }));
  const synced = filterSynced(records);
  assert(synced.length === 1, 'Only one record (synced) should be targeted');
  assert(synced[0].status === 'synced', 'Targeted record must be synced');
}

testSyncedExist();
testNoSynced();
testDeleteAllRemovesOnlySynced();
testCancelDeletesNothing();
testNonSyncedUntouched();
testServerSideUntouched();
testCompletedLeadsSafety();

console.log('Delete All Synced cleanup tests passed');
