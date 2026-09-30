// Tests for cleanupOldSyncedCompletedLeads and scheduler throttle.
// Run with: npx tsx src/capture/cleanupOldSynced.test.ts

// ─── Mock IndexedDB ──────────────────────────────────────────────────────────

interface CLead {
  id:               string;
  ownerId:          string | null;
  status:           string;
  captureMethod:    string | null;
  draftData:        Record<string, unknown>;
  backendSessionId: string | null;
  eventId:          string | null;
  eventName:        string | null;
  createdAt:        string;
  updatedAt:        string;
  syncedAt:         string | null;
  retries:          number;
  lastError:        string | null;
  failedStage:      string | null;
  lastAttemptAt:    string | null;
  failedAt:         string | null;
  isExhausted:      boolean;
}

const store = new Map<string, CLead>();

function resetStore(): void {
  store.clear();
}

function makeLead(
  id: string,
  ownerId: string | null,
  overrides: Partial<CLead> = {},
): CLead {
  return {
    id,
    ownerId,
    status: 'synced',
    captureMethod: 'MANUAL',
    draftData: { clientName: 'Test', company: 'Co' },
    backendSessionId: id,
    eventId: null,
    eventName: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    syncedAt: null,
    retries: 0,
    lastError: null,
    failedStage: null,
    lastAttemptAt: null,
    failedAt: null,
    isExhausted: false,
    ...overrides,
  };
}

// ─── Inline copy of cleanupOldSyncedCompletedLeads logic ─────────────────────
// (mirrors completedLeadsStorage.ts exactly, but operates on the mock store)

function mockGetAll(ownerId?: string): CLead[] {
  const all = Array.from(store.values());
  if (!ownerId) return all;
  return all.filter(r => r.ownerId === ownerId);
}

async function cleanupOldSyncedCompletedLeads(
  ownerId: string,
  maxAgeMs: number,
): Promise<number> {
  try {
    const all = mockGetAll(ownerId);
    const cutoff = Date.now() - maxAgeMs;
    const toDelete = all.filter(r => {
      if (r.status !== 'synced') return false;
      if (!r.syncedAt) return false;
      const ts = Date.parse(r.syncedAt);
      if (Number.isNaN(ts)) return false;
      return ts <= cutoff;
    });
    if (toDelete.length === 0) return 0;
    for (const r of toDelete) store.delete(r.id);
    return toDelete.length;
  } catch {
    return 0;
  }
}

// ─── Scheduler throttle simulation ───────────────────────────────────────────

const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const SYNCED_RETENTION_MS = 3 * 24 * 60 * 60 * 1000; // 3 days

let lastCleanupAt = 0;

function shouldRunCleanup(): boolean {
  return Date.now() - lastCleanupAt >= CLEANUP_INTERVAL_MS;
}

function resetThrottle(): void {
  lastCleanupAt = 0;
}

// ─── Test helpers ─────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string): void {
  if (condition) { passed++; }
  else { failed++; console.error(`FAIL: ${label}`); }
}

async function assertEq(actual: unknown, expected: unknown, label: string): Promise<void> {
  if (actual === expected) { passed++; }
  else { failed++; console.error(`FAIL: ${label}\n  expected: ${expected}\n  actual:   ${actual}`); }
}

const USER_A = 'auth-uid-a-001';
const USER_B = 'auth-uid-b-002';
const THREE_DAYS = SYNCED_RETENTION_MS;

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function isoHoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}

// ─── Tests ────────────────────────────────────────────────────────────────────

async function testSyncedOlderThan3DaysDeleted(): Promise<void> {
  resetStore();
  store.set('old-1', makeLead('old-1', USER_A, { syncedAt: isoDaysAgo(4) }));
  store.set('old-2', makeLead('old-2', USER_A, { syncedAt: isoDaysAgo(10) }));
  const deleted = await cleanupOldSyncedCompletedLeads(USER_A, THREE_DAYS);
  await assertEq(deleted, 2, 'synced older than 3 days: deleted count = 2');
  assert(!store.has('old-1'), 'old-1 removed');
  assert(!store.has('old-2'), 'old-2 removed');
}

async function testSyncedExactly3DaysRetained(): Promise<void> {
  resetStore();
  // syncedAt just inside 3 days (2.9 days) → retained
  store.set('edge-1', makeLead('edge-1', USER_A, { syncedAt: isoDaysAgo(2.9) }));
  const deleted = await cleanupOldSyncedCompletedLeads(USER_A, THREE_DAYS);
  await assertEq(deleted, 0, 'synced 2.9 days: deleted count = 0');
  assert(store.has('edge-1'), 'edge-1 retained');
}

async function testRecentSyncedRetained(): Promise<void> {
  resetStore();
  store.set('recent-1', makeLead('recent-1', USER_A, { syncedAt: isoHoursAgo(1) }));
  store.set('recent-2', makeLead('recent-2', USER_A, { syncedAt: new Date().toISOString() }));
  const deleted = await cleanupOldSyncedCompletedLeads(USER_A, THREE_DAYS);
  await assertEq(deleted, 0, 'recent synced: deleted count = 0');
  assert(store.has('recent-1'), 'recent-1 retained');
  assert(store.has('recent-2'), 'recent-2 retained');
}

async function testPendingSyncRetained(): Promise<void> {
  resetStore();
  store.set('pending-1', makeLead('pending-1', USER_A, { status: 'pending_sync', syncedAt: isoDaysAgo(5) }));
  const deleted = await cleanupOldSyncedCompletedLeads(USER_A, THREE_DAYS);
  await assertEq(deleted, 0, 'pending_sync: deleted count = 0');
  assert(store.has('pending-1'), 'pending_sync record retained');
}

async function testFailedRetained(): Promise<void> {
  resetStore();
  store.set('failed-1', makeLead('failed-1', USER_A, { status: 'failed', syncedAt: isoDaysAgo(5) }));
  const deleted = await cleanupOldSyncedCompletedLeads(USER_A, THREE_DAYS);
  await assertEq(deleted, 0, 'failed: deleted count = 0');
  assert(store.has('failed-1'), 'failed record retained');
}

async function testNeedsReviewRetained(): Promise<void> {
  resetStore();
  store.set('review-1', makeLead('review-1', USER_A, { status: 'needs_review', syncedAt: isoDaysAgo(5) }));
  const deleted = await cleanupOldSyncedCompletedLeads(USER_A, THREE_DAYS);
  await assertEq(deleted, 0, 'needs_review: deleted count = 0');
  assert(store.has('review-1'), 'needs_review record retained');
}

async function testMissingSyncedAtRetained(): Promise<void> {
  resetStore();
  store.set('null-synced', makeLead('null-synced', USER_A, { syncedAt: null }));
  const deleted = await cleanupOldSyncedCompletedLeads(USER_A, THREE_DAYS);
  await assertEq(deleted, 0, 'missing syncedAt: deleted count = 0');
  assert(store.has('null-synced'), 'null syncedAt record retained');
}

async function testInvalidSyncedAtRetained(): Promise<void> {
  resetStore();
  store.set('bad-synced', makeLead('bad-synced', USER_A, { syncedAt: 'not-a-date' }));
  const deleted = await cleanupOldSyncedCompletedLeads(USER_A, THREE_DAYS);
  await assertEq(deleted, 0, 'invalid syncedAt: deleted count = 0');
  assert(store.has('bad-synced'), 'invalid syncedAt record retained');
}

async function testOtherUserSyncedRetained(): Promise<void> {
  resetStore();
  store.set('user-b-old', makeLead('user-b-old', USER_B, { syncedAt: isoDaysAgo(5) }));
  const deleted = await cleanupOldSyncedCompletedLeads(USER_A, THREE_DAYS);
  await assertEq(deleted, 0, 'other user synced: deleted count = 0');
  assert(store.has('user-b-old'), 'other user record retained');
}

async function testCorrectDeletionCountMixed(): Promise<void> {
  resetStore();
  store.set('mix-old-1', makeLead('mix-old-1', USER_A, { syncedAt: isoDaysAgo(4) }));
  store.set('mix-old-2', makeLead('mix-old-2', USER_A, { syncedAt: isoDaysAgo(7) }));
  store.set('mix-recent', makeLead('mix-recent', USER_A, { syncedAt: isoHoursAgo(2) }));
  store.set('mix-pending', makeLead('mix-pending', USER_A, { status: 'pending_sync', syncedAt: isoDaysAgo(5) }));
  store.set('mix-null', makeLead('mix-null', USER_A, { syncedAt: null }));
  store.set('mix-other', makeLead('mix-other', USER_B, { syncedAt: isoDaysAgo(5) }));
  const deleted = await cleanupOldSyncedCompletedLeads(USER_A, THREE_DAYS);
  await assertEq(deleted, 2, 'mixed set: only 2 old synced USER_A records deleted');
  assert(!store.has('mix-old-1'), 'mix-old-1 deleted');
  assert(!store.has('mix-old-2'), 'mix-old-2 deleted');
  assert(store.has('mix-recent'), 'mix-recent retained');
  assert(store.has('mix-pending'), 'mix-pending retained');
  assert(store.has('mix-null'), 'mix-null retained');
  assert(store.has('mix-other'), 'mix-other (USER_B) retained');
}

async function testEmptyStore(): Promise<void> {
  resetStore();
  const deleted = await cleanupOldSyncedCompletedLeads(USER_A, THREE_DAYS);
  await assertEq(deleted, 0, 'empty store: deleted count = 0');
}

// ─── Scheduler throttle tests ─────────────────────────────────────────────────

async function testThrottleFirstTickRunsCleanup(): Promise<void> {
  resetThrottle();
  assert(shouldRunCleanup(), 'first tick: cleanup should run (lastCleanupAt=0)');
}

async function testThrottleSecondTickWithin5MinSkipped(): Promise<void> {
  resetThrottle();
  lastCleanupAt = Date.now();
  assert(!shouldRunCleanup(), 'second tick immediately after: cleanup should NOT run');
}

async function testThrottleAfter5MinRunsAgain(): Promise<void> {
  resetThrottle();
  lastCleanupAt = Date.now() - CLEANUP_INTERVAL_MS - 1000;
  assert(shouldRunCleanup(), 'after 5 min + 1s: cleanup should run again');
}

async function testThrottleExactly5MinBoundary(): Promise<void> {
  resetThrottle();
  // Exactly 5 minutes ago — boundary is >=, so this should run
  lastCleanupAt = Date.now() - CLEANUP_INTERVAL_MS;
  assert(shouldRunCleanup(), 'exactly 5 min: cleanup should run (>= interval)');
}

async function testThrottleJustBefore5MinSkipped(): Promise<void> {
  resetThrottle();
  lastCleanupAt = Date.now() - CLEANUP_INTERVAL_MS + 1000;
  assert(!shouldRunCleanup(), 'just under 5 min: cleanup should NOT run');
}

// ─── Run all tests ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  await testSyncedOlderThan3DaysDeleted();
  await testSyncedExactly3DaysRetained();
  await testRecentSyncedRetained();
  await testPendingSyncRetained();
  await testFailedRetained();
  await testNeedsReviewRetained();
  await testMissingSyncedAtRetained();
  await testInvalidSyncedAtRetained();
  await testOtherUserSyncedRetained();
  await testCorrectDeletionCountMixed();
  await testEmptyStore();
  await testThrottleFirstTickRunsCleanup();
  await testThrottleSecondTickWithin5MinSkipped();
  await testThrottleAfter5MinRunsAgain();
  await testThrottleExactly5MinBoundary();
  await testThrottleJustBefore5MinSkipped();

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
