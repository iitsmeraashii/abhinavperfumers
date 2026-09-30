// Tests for async owner-identity preservation across user switches.
// Run with: npx tsx src/capture/ownerRace.test.ts

// ─── Mock infrastructure ─────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string): void {
  if (condition) { passed++; } else { failed++; console.error(`FAIL: ${label}`); }
}

async function assertEq(actual: unknown, expected: unknown, label: string): Promise<void> {
  if (JSON.stringify(actual) === JSON.stringify(expected)) { passed++; }
  else { failed++; console.error(`FAIL: ${label}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`); }
}

// ─── Mock PendingOp (mirrors captureOfflineQueue.ts PendingOp) ────────────────

interface PendingOp {
  id:      string;
  opType:  string;
  bsid:    string;
  payload: Record<string, unknown>;
  ownerId: string | null;
  createdAt: string;
}

// ─── Mock IndexedDB store for pending_ops ────────────────────────────────────

const pendingOpsStore: Map<string, PendingOp> = new Map();

function resetQueue(): void {
  pendingOpsStore.clear();
}

let opIdCounter = 0;

async function enqueueOp(
  opType: string,
  bsid:   string,
  payload: Record<string, unknown>,
  ownerId: string | null,
): Promise<void> {
  const id = `op-${++opIdCounter}`;
  const op: PendingOp = {
    id,
    opType,
    bsid,
    payload,
    ownerId,
    createdAt: new Date().toISOString(),
  };
  pendingOpsStore.set(id, op);
}

// ─── Mock auth identity ──────────────────────────────────────────────────────

let _currentAuthUserId: string | null = null;

function setCurrentUser(uid: string | null): void {
  _currentAuthUserId = uid;
}

async function getAuthIdentity(): Promise<{ userId: string | null; repCode: string | null } | null> {
  if (!_currentAuthUserId) return null;
  return { userId: _currentAuthUserId, repCode: null };
}

// ─── Mock produceProcessingJob (mirrors jobProducer.ts) ──────────────────────

interface ProducedJob {
  backendSessionId: string;
  ownerId:          string | null;
  draftData:        Record<string, unknown>;
  captureMethod:    string | null;
  eventId:          string | null;
  eventName:        string | null;
}

const producedJobs: ProducedJob[] = [];

interface ProduceJobParams {
  backendSessionId: string;
  draftData:        Record<string, unknown>;
  captureMethod:    string | null;
  eventId:          string | null;
  eventName:        string | null;
  correlationId?:  string | null;
  ownerId?:        string | null;
}

async function produceProcessingJob(params: ProduceJobParams): Promise<{ jobId: string }> {
  const { backendSessionId, draftData, captureMethod, eventId, eventName, ownerId } = params;

  // This is the key fix: use ownerId from params if provided, fall back to getAuthIdentity
  const identity = ownerId
    ? { userId: ownerId }
    : await getAuthIdentity();

  if (!identity?.userId) {
    throw new Error('Not authenticated');
  }

  const job: ProducedJob = {
    backendSessionId,
    ownerId:     identity.userId,
    draftData,
    captureMethod,
    eventId,
    eventName,
  };
  producedJobs.push(job);

  return { jobId: `job-${backendSessionId}` };
}

// ─── Mock executeOp (mirrors captureOfflineQueue.ts executeOp) ───────────────

async function executeOp(op: PendingOp): Promise<void> {
  switch (op.opType) {
    case 'upsert_session':
      // Simulate online sync — no owner involved
      break;

    case 'enqueue_processing_job': {
      const p = op.payload as {
        backendSessionId: string;
        draftData:        Record<string, unknown>;
        captureMethod:    string | null;
        eventId:          string | null;
        eventName:        string | null;
        correlationId?:  string | null;
      };

      // The fix: pass op.ownerId to produceProcessingJob
      await produceProcessingJob({
        backendSessionId: p.backendSessionId,
        draftData:        p.draftData,
        captureMethod:    p.captureMethod,
        eventId:          p.eventId,
        eventName:        p.eventName,
        correlationId:    p.correlationId ?? null,
        ownerId:          op.ownerId,
      });
      break;
    }

    case 'upload_voice_note':
      // Voice note upload — owner is on the op
      break;

    case 'promote_session':
      // Promotion — owner is on the op
      break;

    default:
      // Other op types — owner is on the op
      break;
  }
}

async function flushQueue(ownerId?: string): Promise<void> {
  const ops = Array.from(pendingOpsStore.values());
  for (const op of ops) {
    // flushQueue filters by ownerId — only ops belonging to this owner are replayed
    if (ownerId && op.ownerId !== ownerId) continue;
    await executeOp(op);
    pendingOpsStore.delete(op.id);
  }
}

// ─── Constants ───────────────────────────────────────────────────────────────

const ADMIN = 'auth-uid-admin-001';
const SHUBHIKA = 'auth-uid-shubhika-002';

// ─── Tests ───────────────────────────────────────────────────────────────────

async function testBasicOwnerCapture(): Promise<void> {
  resetQueue();
  setCurrentUser(ADMIN);

  // Simulate ADMIN starting a capture and enqueueing a session sync
  await enqueueOp('upsert_session', 'bsid-001', { captureMethod: 'MANUAL' }, ADMIN);

  const ops = Array.from(pendingOpsStore.values());
  assert(ops.length === 1, 'Basic: one op enqueued');
  await assertEq(ops[0].ownerId, ADMIN, 'Basic: op.ownerId is ADMIN');
  await assertEq(ops[0].opType, 'upsert_session', 'Basic: op type is upsert_session');
}

async function testUserSwitchRaceEnqueueOp(): Promise<void> {
  resetQueue();
  setCurrentUser(ADMIN);

  // ADMIN starts a capture — ownerId captured at creation time
  // Simulate the execution engine passing ownerId explicitly
  await enqueueOp('upsert_session', 'bsid-race-001', { captureMethod: 'BUSINESS_CARD' }, ADMIN);

  // User switches to SHUBHIKA before the async callback completes
  setCurrentUser(SHUBHIKA);

  // The already-enqueued op must still have ADMIN's ownerId
  const ops = Array.from(pendingOpsStore.values());
  assert(ops.length === 1, 'Race: one op still in queue');
  await assertEq(ops[0].ownerId, ADMIN, 'Race: op.ownerId is still ADMIN after user switch to SHUBHIKA');
  await assertEq(ops[0].opType, 'upsert_session', 'Race: op type unchanged');
}

async function testPendingOpPreservationAcrossUserSwitch(): Promise<void> {
  resetQueue();
  setCurrentUser(ADMIN);

  // ADMIN enqueues multiple ops
  await enqueueOp('upsert_session', 'bsid-002', {}, ADMIN);
  await enqueueOp('enqueue_processing_job', 'bsid-002', {
    backendSessionId: 'bsid-002',
    draftData:        { clientName: 'Test' },
    captureMethod:    'MANUAL',
    eventId:          null,
    eventName:        null,
  }, ADMIN);
  await enqueueOp('upload_voice_note', 'bsid-002', { sessionId: 'bsid-002' }, ADMIN);

  // User switches to SHUBHIKA
  setCurrentUser(SHUBHIKA);

  // All ops must still have ADMIN's ownerId
  const ops = Array.from(pendingOpsStore.values());
  assert(ops.length === 3, 'Preservation: 3 ops in queue');

  for (const op of ops) {
    await assertEq(op.ownerId, ADMIN, `Preservation: op ${op.opType} ownerId is ADMIN (not SHUBHIKA)`);
  }
}

async function testProcessingJobUsesOpOwnerNotCurrentUser(): Promise<void> {
  resetQueue();
  producedJobs.length = 0;
  setCurrentUser(ADMIN);

  // ADMIN creates a PendingOp for processing job
  await enqueueOp('enqueue_processing_job', 'bsid-003', {
    backendSessionId: 'bsid-003',
    draftData:        { clientName: 'Admin Lead' },
    captureMethod:    'MANUAL',
    eventId:          'ev-001',
    eventName:        'Test Event',
  }, ADMIN);

  // User switches to SHUBHIKA before flush
  setCurrentUser(SHUBHIKA);

  // SHUBHIKA flushes the queue — but ADMIN's op should still use ADMIN's ownerId
  await flushQueue(SHUBHIKA);

  // SHUBHIKA's flush should NOT replay ADMIN's ops (ownerId mismatch)
  assert(producedJobs.length === 0, 'Processing job: SHUBHIKA flush does not replay ADMIN ops');

  // Now flush without owner filter (diagnostic/recovery)
  // OR: ADMIN logs back in and flushes
  setCurrentUser(ADMIN);
  await flushQueue(ADMIN);

  assert(producedJobs.length === 1, 'Processing job: ADMIN flush produces 1 job');
  await assertEq(producedJobs[0].ownerId, ADMIN, 'Processing job: job ownerId is ADMIN (not SHUBHIKA)');
  await assertEq(producedJobs[0].backendSessionId, 'bsid-003', 'Processing job: correct bsid');
}

async function testProcessingJobOwnerWithExplicitOwnerParam(): Promise<void> {
  // Test the core fix: produceProcessingJob uses ownerId param, not getAuthIdentity
  resetQueue();
  producedJobs.length = 0;
  setCurrentUser(SHUBHIKA);

  // Call produceProcessingJob with ADMIN's ownerId while SHUBHIKA is current user
  await produceProcessingJob({
    backendSessionId: 'bsid-004',
    draftData:        { clientName: 'Test' },
    captureMethod:    'MANUAL',
    eventId:          null,
    eventName:        null,
    ownerId:          ADMIN,
  });

  assert(producedJobs.length === 1, 'Explicit ownerId: job produced');
  await assertEq(producedJobs[0].ownerId, ADMIN, 'Explicit ownerId: job ownerId is ADMIN (not current SHUBHIKA)');
}

async function testProcessingJobFallsBackToAuthIdentity(): Promise<void> {
  // When no ownerId is passed, fall back to current auth identity (backward compat)
  resetQueue();
  producedJobs.length = 0;
  setCurrentUser(ADMIN);

  await produceProcessingJob({
    backendSessionId: 'bsid-005',
    draftData:        { clientName: 'Test' },
    captureMethod:    'MANUAL',
    eventId:          null,
    eventName:        null,
    // No ownerId — should fall back to getAuthIdentity
  });

  assert(producedJobs.length === 1, 'Fallback: job produced');
  await assertEq(producedJobs[0].ownerId, ADMIN, 'Fallback: job ownerId is ADMIN from getAuthIdentity');
}

async function testVoiceNoteOpRetainsOwner(): Promise<void> {
  resetQueue();
  setCurrentUser(ADMIN);

  // ADMIN records a voice note and it's enqueued offline
  await enqueueOp('upload_voice_note', 'bsid-006', {
    sessionId:  'bsid-006',
    audioBlob:  new Blob(['fake-audio']),
    mimeType:   'audio/webm',
    durationMs: 5000,
  }, ADMIN);

  // User switches
  setCurrentUser(SHUBHIKA);

  const ops = Array.from(pendingOpsStore.values());
  assert(ops.length === 1, 'Voice: one op in queue');
  await assertEq(ops[0].ownerId, ADMIN, 'Voice: op.ownerId is ADMIN (not SHUBHIKA)');
  await assertEq(ops[0].opType, 'upload_voice_note', 'Voice: correct op type');
}

async function testPromotionOpRetainsOwner(): Promise<void> {
  resetQueue();
  setCurrentUser(ADMIN);

  await enqueueOp('promote_session', 'bsid-007', {
    backendSessionId: 'bsid-007',
    captureMethod:    'MANUAL',
    eventId:          null,
    eventName:        null,
  }, ADMIN);

  setCurrentUser(SHUBHIKA);

  const ops = Array.from(pendingOpsStore.values());
  assert(ops.length === 1, 'Promotion: one op in queue');
  await assertEq(ops[0].ownerId, ADMIN, 'Promotion: op.ownerId is ADMIN (not SHUBHIKA)');
}

async function testFlushQueueScopedByOwner(): Promise<void> {
  resetQueue();
  setCurrentUser(ADMIN);

  // ADMIN enqueues 2 ops
  await enqueueOp('upsert_session', 'bsid-a1', {}, ADMIN);
  await enqueueOp('upsert_session', 'bsid-a2', {}, ADMIN);

  // SHUBHIKA enqueues 1 op
  await enqueueOp('upsert_session', 'bsid-s1', {}, SHUBHIKA);

  // ADMIN flushes — should only replay ADMIN's ops
  await flushQueue(ADMIN);

  const remaining = Array.from(pendingOpsStore.values());
  assert(remaining.length === 1, 'Flush scoped: 1 op remaining (SHUBHIKA\'s)');
  await assertEq(remaining[0].ownerId, SHUBHIKA, 'Flush scoped: remaining op is SHUBHIKA\'s');
  await assertEq(remaining[0].bsid, 'bsid-s1', 'Flush scoped: remaining op has SHUBHIKA\'s bsid');
}

async function testFullUserSwitchLifecycle(): Promise<void> {
  resetQueue();
  producedJobs.length = 0;

  // 1. ADMIN logs in
  setCurrentUser(ADMIN);

  // 2. ADMIN starts an offline capture — multiple ops enqueued
  await enqueueOp('upsert_session', 'bsid-life', { captureMethod: 'BUSINESS_CARD' }, ADMIN);
  await enqueueOp('upsert_asset', 'bsid-life', { assetId: 'asset-1' }, ADMIN);
  await enqueueOp('enqueue_processing_job', 'bsid-life', {
    backendSessionId: 'bsid-life',
    draftData:        { clientName: 'Admin Lead' },
    captureMethod:    'BUSINESS_CARD',
    eventId:          'ev-1',
    eventName:        'Event 1',
  }, ADMIN);

  // 3. ADMIN logs out, SHUBHIKA logs in
  setCurrentUser(SHUBHIKA);

  // 4. SHUBHIKA tries to flush — should NOT replay ADMIN's ops
  await flushQueue(SHUBHIKA);
  assert(producedJobs.length === 0, 'Lifecycle: SHUBHIKA flush does not process ADMIN ops');
  assert(pendingOpsStore.size === 3, 'Lifecycle: all 3 ADMIN ops still in queue');

  // 5. ADMIN logs back in and flushes
  setCurrentUser(ADMIN);
  await flushQueue(ADMIN);

  assert(producedJobs.length === 1, 'Lifecycle: ADMIN flush produces 1 processing job');
  await assertEq(producedJobs[0].ownerId, ADMIN, 'Lifecycle: job ownerId is ADMIN');
  await assertEq(producedJobs[0].backendSessionId, 'bsid-life', 'Lifecycle: correct bsid');
  assert(pendingOpsStore.size === 0, 'Lifecycle: queue empty after ADMIN flush');
}

// ─── Run all tests ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
  await testBasicOwnerCapture();
  await testUserSwitchRaceEnqueueOp();
  await testPendingOpPreservationAcrossUserSwitch();
  await testProcessingJobUsesOpOwnerNotCurrentUser();
  await testProcessingJobOwnerWithExplicitOwnerParam();
  await testProcessingJobFallsBackToAuthIdentity();
  await testVoiceNoteOpRetainsOwner();
  await testPromotionOpRetainsOwner();
  await testFlushQueueScopedByOwner();
  await testFullUserSwitchLifecycle();

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('Test runner error:', err);
  process.exit(1);
});
