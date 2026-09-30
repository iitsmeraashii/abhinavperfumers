// Tests for per-owner flush lock behavior.
// Run with: npx tsx src/capture/flushLock.test.ts

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string): void {
  if (condition) { passed++; } else { failed++; console.error(`FAIL: ${label}`); }
}

async function assertEq(actual: unknown, expected: unknown, label: string): Promise<void> {
  if (JSON.stringify(actual) === JSON.stringify(expected)) { passed++; }
  else { failed++; console.error(`FAIL: ${label}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`); }
}

// ─── Per-owner flush lock (mirrors captureOfflineQueue.ts) ───────────────────

const flushLocks = new Map<string, boolean>();
const UNSCOPED_KEY = '__unscoped__';

interface FlushResult { flushed: number; remaining: number; }

// Simulated op store — per-owner lists
interface SimOp { id: string; ownerId: string | null; type: string; }
const opStore: SimOp[] = [];

function resetStore(): void {
  opStore.length = 0;
  flushLocks.clear();
}

let opCounter = 0;
function addOp(ownerId: string | null, type = 'upsert_session'): SimOp {
  const op: SimOp = { id: `op-${++opCounter}`, ownerId, type };
  opStore.push(op);
  return op;
}

// Simulated flush — mirrors the real implementation's lock + filter + execute
async function flushQueue(
  ownerId?: string,
  delayMs = 0,
  shouldFail = false,
): Promise<FlushResult> {
  const lockKey = ownerId ?? UNSCOPED_KEY;

  if (flushLocks.get(lockKey)) return { flushed: 0, remaining: 0 };

  flushLocks.set(lockKey, true);

  try {
    if (shouldFail) throw new Error('Simulated flush failure');

    const ops = ownerId ? opStore.filter(op => op.ownerId === ownerId) : [...opStore];
    if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs));

    // Remove processed ops
    for (const op of ops) {
      const idx = opStore.indexOf(op);
      if (idx >= 0) opStore.splice(idx, 1);
    }

    return { flushed: ops.length, remaining: opStore.length };
  } finally {
    flushLocks.delete(lockKey);
  }
}

// ─── Constants ───────────────────────────────────────────────────────────────

const ADMIN   = 'auth-uid-admin-001';
const SHUBHIKA = 'auth-uid-shubhika-002';

// ─── Test A — same-owner deduplication ──────────────────────────────────────

async function testSameOwnerDedup(): Promise<void> {
  resetStore();
  addOp(ADMIN);
  addOp(ADMIN);

  // Start a slow flush for ADMIN
  const flush1 = flushQueue(ADMIN, 50);

  // Immediately try a second ADMIN flush — should be deduplicated
  const result2 = await flushQueue(ADMIN, 0);

  await assertEq(result2, { flushed: 0, remaining: 0 }, 'TestA: second ADMIN flush deduplicated (returned 0)');

  const result1 = await flush1;
  assert(result1.flushed === 2, 'TestA: first ADMIN flush processed both ops');
  assert(result1.remaining === 0, 'TestA: queue empty after first flush');
  assert(!flushLocks.get(ADMIN), 'TestA: ADMIN lock released after flush');
}

// ─── Test B — different owners can flush independently ───────────────────────

async function testDifferentOwnersIndependent(): Promise<void> {
  resetStore();
  addOp(ADMIN);
  addOp(SHUBHIKA);

  // Start ADMIN flush (slow)
  const adminFlush = flushQueue(ADMIN, 50);

  // SHUBHIKA flush should NOT be blocked
  const shubhikaResult = await flushQueue(SHUBHIKA, 0);

  assert(shubhikaResult.flushed === 1, 'TestB: SHUBHIKA flush ran while ADMIN flush in progress');
  assert(shubhikaResult.remaining >= 1, 'TestB: ADMIN op still in queue during SHUBHIKA flush');

  const adminResult = await adminFlush;
  assert(adminResult.flushed === 1, 'TestB: ADMIN flush completed after SHUBHIKA');
  assert(adminResult.remaining === 0, 'TestB: queue empty after both flushes');
}

// ─── Test C — user switch ───────────────────────────────────────────────────

async function testUserSwitch(): Promise<void> {
  resetStore();
  addOp(ADMIN);
  addOp(SHUBHIKA);

  // ADMIN starts a flush, then "logs out" (we just switch)
  const adminFlush = flushQueue(ADMIN, 50);

  // SHUBHIKA logs in and flushes — must proceed even though ADMIN's flush is running
  const shubhikaResult = await flushQueue(SHUBHIKA, 0);

  assert(shubhikaResult.flushed === 1, 'TestC: SHUBHIKA flush proceeded despite ADMIN flush in progress');
  assert(shubhikaResult.remaining >= 1, 'TestC: ADMIN op untouched by SHUBHIKA flush');

  const adminResult = await adminFlush;
  assert(adminResult.flushed === 1, 'TestC: ADMIN flush completed independently');
  assert(adminResult.remaining === 0, 'TestC: all ops processed');
}

// ─── Test D — lock release on failure ───────────────────────────────────────

async function testLockReleaseOnFailure(): Promise<void> {
  resetStore();
  addOp(ADMIN);

  // First flush fails
  await flushQueue(ADMIN, 0, true).catch(() => {});

  assert(!flushLocks.get(ADMIN), 'TestD: ADMIN lock released after failure');

  // Second flush should be allowed to run
  const successResult = await flushQueue(ADMIN, 0);

  assert(successResult.flushed === 1, 'TestD: second ADMIN flush ran after first failed');
  assert(successResult.remaining === 0, 'TestD: queue empty after retry');
}

// ─── Test E — one owner failure doesn't block another ───────────────────────

async function testCrossOwnerFailureIsolation(): Promise<void> {
  resetStore();
  addOp(ADMIN);
  addOp(SHUBHIKA);

  // ADMIN flush fails
  await flushQueue(ADMIN, 0, true).catch(() => {});

  assert(!flushLocks.get(ADMIN), 'TestE: ADMIN lock released after failure');

  // SHUBHIKA flush should still work
  const shubhikaResult = await flushQueue(SHUBHIKA, 0);

  assert(shubhikaResult.flushed === 1, 'TestE: SHUBHIKA flush ran after ADMIN failure');
  assert(shubhikaResult.remaining >= 1, 'TestE: ADMIN op still in queue');
}

// ─── Test F — owner filtering remains intact ────────────────────────────────

async function testOwnerFilteringIntact(): Promise<void> {
  resetStore();
  addOp(ADMIN);
  addOp(SHUBHIKA);
  addOp(null); // legacy null-owner op

  // ADMIN flush — should only process ADMIN's op
  const adminResult = await flushQueue(ADMIN, 0);
  assert(adminResult.flushed === 1, 'TestF: ADMIN flush processed 1 op');
  assert(adminResult.remaining === 2, 'TestF: 2 ops remaining (SHUBHIKA + null)');

  // SHUBHIKA flush — should only process SHUBHIKA's op
  const shubhikaResult = await flushQueue(SHUBHIKA, 0);
  assert(shubhikaResult.flushed === 1, 'TestF: SHUBHIKA flush processed 1 op');
  assert(shubhikaResult.remaining === 1, 'TestF: 1 op remaining (null-owner)');

  // Verify null-owner op was NOT processed by either flush
  const nullOps = opStore.filter(op => op.ownerId === null);
  assert(nullOps.length === 1, 'TestF: null-owner op remains untouched');
}

// ─── Run all tests ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
  await testSameOwnerDedup();
  await testDifferentOwnersIndependent();
  await testUserSwitch();
  await testLockReleaseOnFailure();
  await testCrossOwnerFailureIsolation();
  await testOwnerFilteringIntact();

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('Test runner error:', err);
  process.exit(1);
});
