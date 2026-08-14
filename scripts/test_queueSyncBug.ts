// Regression test for the Queue synchronization bug where a completed_leads
// record stays 'pending_sync' even though processing and promotion succeeded.
//
// The bug occurs when:
//   1. The worker takes the early-return path (session already promoted)
//      and executePromotion() is never called — so _updateCompletedLead()
//      never runs and the local record stays 'pending_sync'.
//   2. _updateCompletedLead()'s IndexedDB write fails silently — promotion
//      succeeded at the DB level but the local record is never updated.
//
// The fix: after a COMPLETED or REQUIRES_REVIEW decision, the scheduler
// reconciles the local completed_leads record to 'synced'.

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

interface MockCompletedLead {
  id: string;
  status: 'local_only' | 'pending_sync' | 'syncing' | 'synced' | 'failed' | 'needs_review';
  syncedAt: string | null;
}

interface MockWorkerResult {
  outcome: 'completed' | 'failed' | 'requires_review' | 'queued';
  leadId: string | null;
  error: string | null;
}

interface MockDecision {
  newState: 'COMPLETED' | 'REQUIRES_REVIEW' | 'RETRYING' | 'FAILED' | 'INVALID';
  isRetryable: boolean;
}

// ─── Mock state ─────────────────────────────────────────────────────────────────

let completedLeads: Map<string, MockCompletedLead> = new Map();
let promotionCalled = false;
let promotionIdbWriteSucceeded = true;

function resetMockState() {
  completedLeads = new Map();
  promotionCalled = false;
  promotionIdbWriteSucceeded = true;
}

// ─── Mock functions (mirror the actual code paths) ────────────────────────────

// Simulates _updateCompletedLead in capturePromotionService.ts
function mockUpdateCompletedLeadViaPromotion(backendSessionId: string): void {
  promotionCalled = true;
  if (!promotionIdbWriteSucceeded) return; // silent failure
  const lead = completedLeads.get(backendSessionId);
  if (lead) {
    lead.status = 'synced';
    lead.syncedAt = new Date().toISOString();
  }
}

// Simulates updateCompletedLeadStatus in completedLeadsStorage.ts
function mockUpdateCompletedLeadStatus(
  backendSessionId: string,
  status: MockCompletedLead['status'],
  extra?: { syncedAt?: string },
): void {
  const lead = completedLeads.get(backendSessionId);
  if (!lead) return;
  lead.status = status;
  if (extra?.syncedAt) lead.syncedAt = extra.syncedAt;
}

// Simulates the worker's early-return path (session already promoted)
function mockWorkerAlreadyPromoted(): MockWorkerResult {
  return { outcome: 'completed', leadId: 'lead-123', error: null };
}

// Simulates the worker running the full pipeline
function mockWorkerFullPipeline(backendSessionId: string): MockWorkerResult {
  mockUpdateCompletedLeadViaPromotion(backendSessionId);
  return { outcome: 'completed', leadId: 'lead-123', error: null };
}

// Simulates decide()
function mockDecide(result: MockWorkerResult): MockDecision {
  if (result.outcome === 'completed') return { newState: 'COMPLETED', isRetryable: false };
  if (result.outcome === 'requires_review') return { newState: 'REQUIRES_REVIEW', isRetryable: false };
  if (result.outcome === 'queued') return { newState: 'RETRYING', isRetryable: true };
  return { newState: 'FAILED', isRetryable: false };
}

// ─── Simulates the FIXED scheduler tick() ──────────────────────────────────────

function mockSchedulerTickFixed(
  backendSessionId: string,
  workerResult: MockWorkerResult,
): void {
  const decision = mockDecide(workerResult);

  if (decision.newState === 'RETRYING' || decision.newState === 'FAILED') {
    mockUpdateCompletedLeadStatus(backendSessionId, 'failed');
    return;
  }

  if (decision.newState === 'COMPLETED' || decision.newState === 'REQUIRES_REVIEW') {
    // The fix: reconcile local state regardless of whether promotion already did it
    mockUpdateCompletedLeadStatus(backendSessionId, 'synced', {
      syncedAt: new Date().toISOString(),
    });
  }
}

// ─── Simulates the OLD (buggy) scheduler tick() ─────────────────────────────────

function mockSchedulerTickOld(
  _backendSessionId: string,
  _workerResult: MockWorkerResult,
): void {
  // Old code: only incremented jobsProcessed, never updated completed_leads on success
}

// ─── Tests ──────────────────────────────────────────────────────────────────────

// Test 1: Normal success path — promotion updates local state, scheduler reconciles
function test_normal_success_fixed() {
  resetMockState();
  const bsid = 'session-1';
  completedLeads.set(bsid, { id: bsid, status: 'pending_sync', syncedAt: null });

  const result = mockWorkerFullPipeline(bsid);
  mockSchedulerTickFixed(bsid, result);

  const lead = completedLeads.get(bsid)!;
  assert(lead.status === 'synced', 'Normal success: status should be synced');
  assert(lead.syncedAt !== null, 'Normal success: syncedAt should be set');
  assert(promotionCalled, 'Normal success: promotion should have been called');
}

// Test 2: Already-promoted early return — OLD behavior (bug)
function test_already_promoted_old_behavior() {
  resetMockState();
  const bsid = 'session-2';
  completedLeads.set(bsid, { id: bsid, status: 'pending_sync', syncedAt: null });

  const result = mockWorkerAlreadyPromoted();
  mockSchedulerTickOld(bsid, result);

  const lead = completedLeads.get(bsid)!;
  assert(lead.status === 'pending_sync', 'Old behavior: status should stay pending_sync (BUG)');
  assert(!promotionCalled, 'Old behavior: promotion should NOT have been called');
}

// Test 3: Already-promoted early return — FIXED behavior
function test_already_promoted_fixed() {
  resetMockState();
  const bsid = 'session-3';
  completedLeads.set(bsid, { id: bsid, status: 'pending_sync', syncedAt: null });

  const result = mockWorkerAlreadyPromoted();
  mockSchedulerTickFixed(bsid, result);

  const lead = completedLeads.get(bsid)!;
  assert(lead.status === 'synced', 'Fixed: status should be synced even on early return');
  assert(lead.syncedAt !== null, 'Fixed: syncedAt should be set');
  assert(!promotionCalled, 'Fixed: promotion should NOT have been called (early return)');
}

// Test 4: Promotion's IndexedDB write fails silently — OLD behavior (bug)
function test_promotion_idb_failure_old() {
  resetMockState();
  const bsid = 'session-4';
  completedLeads.set(bsid, { id: bsid, status: 'pending_sync', syncedAt: null });
  promotionIdbWriteSucceeded = false;

  const result = mockWorkerFullPipeline(bsid);
  mockSchedulerTickOld(bsid, result);

  const lead = completedLeads.get(bsid)!;
  assert(lead.status === 'pending_sync', 'Old behavior: silent IDB failure leaves pending_sync (BUG)');
  assert(promotionCalled, 'Old behavior: promotion was called but IDB write failed');
}

// Test 5: Promotion's IndexedDB write fails silently — FIXED behavior
function test_promotion_idb_failure_fixed() {
  resetMockState();
  const bsid = 'session-5';
  completedLeads.set(bsid, { id: bsid, status: 'pending_sync', syncedAt: null });
  promotionIdbWriteSucceeded = false;

  const result = mockWorkerFullPipeline(bsid);
  mockSchedulerTickFixed(bsid, result);

  const lead = completedLeads.get(bsid)!;
  assert(lead.status === 'synced', 'Fixed: scheduler reconciles even after promotion IDB failure');
  assert(lead.syncedAt !== null, 'Fixed: syncedAt should be set by scheduler reconciliation');
}

// Test 6: REQUIRES_REVIEW outcome also gets reconciled
function test_requires_review_fixed() {
  resetMockState();
  const bsid = 'session-6';
  completedLeads.set(bsid, { id: bsid, status: 'pending_sync', syncedAt: null });

  const result: MockWorkerResult = { outcome: 'requires_review', leadId: 'lead-6', error: null };
  mockSchedulerTickFixed(bsid, result);

  const lead = completedLeads.get(bsid)!;
  assert(lead.status === 'synced', 'REQUIRES_REVIEW: status should be synced');
}

// Test 7: FAILED outcome still updates to failed (unchanged behavior)
function test_failed_unchanged() {
  resetMockState();
  const bsid = 'session-7';
  completedLeads.set(bsid, { id: bsid, status: 'pending_sync', syncedAt: null });

  const result: MockWorkerResult = { outcome: 'failed', leadId: null, error: 'Validation failed' };
  mockSchedulerTickFixed(bsid, result);

  const lead = completedLeads.get(bsid)!;
  assert(lead.status === 'failed', 'FAILED: status should be failed');
}

// Test 8: Idempotent — if promotion already set synced, scheduler overwrite is harmless
function test_idempotent_overwrite() {
  resetMockState();
  const bsid = 'session-8';
  const originalSyncedAt = '2026-08-14T10:00:00.000Z';
  completedLeads.set(bsid, { id: bsid, status: 'synced', syncedAt: originalSyncedAt });

  const result = mockWorkerFullPipeline(bsid);
  mockSchedulerTickFixed(bsid, result);

  const lead = completedLeads.get(bsid)!;
  assert(lead.status === 'synced', 'Idempotent: status should remain synced');
  // syncedAt will be overwritten — that's acceptable and expected
  assert(lead.syncedAt !== null, 'Idempotent: syncedAt should be non-null');
}

// Test 9: Non-existent completed_lead doesn't crash (updateCompletedLeadStatus is a no-op)
function test_nonexistent_lead() {
  resetMockState();
  const bsid = 'session-9';
  // No completed_lead record exists

  const result = mockWorkerAlreadyPromoted();
  mockSchedulerTickFixed(bsid, result);

  // Should not throw, should not crash
  assert(!completedLeads.has(bsid), 'Non-existent: no record should be created');
}

// Test 10: Queued outcome does NOT reconcile to synced (stays for retry)
function test_queued_not_synced() {
  resetMockState();
  const bsid = 'session-10';
  completedLeads.set(bsid, { id: bsid, status: 'pending_sync', syncedAt: null });

  const result: MockWorkerResult = { outcome: 'queued', leadId: null, error: null };
  // Queued maps to RETRYING in decide()
  const decision = mockDecide(result);
  assert(decision.newState === 'RETRYING', 'Queued should map to RETRYING');

  mockSchedulerTickFixed(bsid, result);

  const lead = completedLeads.get(bsid)!;
  assert(lead.status === 'failed', 'Queued/RETRYING: status should be failed (retry diagnostics)');
}

// ─── Run all tests ───────────────────────────────────────────────────────────────

test_normal_success_fixed();
test_already_promoted_old_behavior();
test_already_promoted_fixed();
test_promotion_idb_failure_old();
test_promotion_idb_failure_fixed();
test_requires_review_fixed();
test_failed_unchanged();
test_idempotent_overwrite();
test_nonexistent_lead();
test_queued_not_synced();

console.log(`Queue sync regression tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
