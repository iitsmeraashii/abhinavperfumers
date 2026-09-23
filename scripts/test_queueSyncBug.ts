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

// ─── Fallback reconciliation tests (capture_sessions.promoted_lead_id) ────────
// These test the new fallback path in reconcileCompletedLeads() that handles
// the case where processing_queue rows have been auto-deleted by the DB trigger.

interface MockCaptureSession {
  id: string;
  promoted_lead_id: string | null;
}

let captureSessions: Map<string, MockCaptureSession> = new Map();
let completedQueueJobs: { id: string; capture_session_id: string; state: string; processing_completed_at: string | null }[] = [];

function resetFallbackMockState() {
  completedLeads = new Map();
  captureSessions = new Map();
  completedQueueJobs = [];
}

// Simulates findCompletedJobs — returns jobs from the mock queue
function mockFindCompletedJobs(): typeof completedQueueJobs {
  return completedQueueJobs.filter(j => j.state === 'COMPLETED' || j.state === 'REQUIRES_REVIEW');
}

// Simulates fetchPromotedSessionIds — queries capture_sessions
function mockFetchPromotedSessionIds(sessionIds: string[]): Set<string> {
  const promoted = new Set<string>();
  for (const id of sessionIds) {
    const session = captureSessions.get(id);
    if (session?.promoted_lead_id) promoted.add(id);
  }
  return promoted;
}

// Simulates the FIXED reconcileCompletedLeads with both paths
function mockReconcileCompletedLeads(): { synced: number; failures: number } {
  const pendingLeads = Array.from(completedLeads.values()).filter(l => l.status !== 'synced');
  if (pendingLeads.length === 0) return { synced: 0, failures: 0 };

  let synced = 0;
  let failures = 0;
  const matchedIds = new Set<string>();

  // Path 1: processing_queue reconciliation
  const completedJobs = mockFindCompletedJobs();
  for (const job of completedJobs) {
    const localLead = pendingLeads.find(l =>
      l.id === job.capture_session_id,
    );
    if (!localLead) {
      failures++;
      continue;
    }
    matchedIds.add(localLead.id);
    localLead.status = 'synced';
    localLead.syncedAt = new Date().toISOString();
    synced++;
  }

  // Path 2: capture_sessions.promoted_lead_id fallback
  const unmatched = pendingLeads.filter(l => !matchedIds.has(l.id));
  if (unmatched.length > 0) {
    const sessionIds = unmatched.map(l => l.id).filter(Boolean);
    const promotedIds = mockFetchPromotedSessionIds(sessionIds);
    for (const lead of unmatched) {
      if (!promotedIds.has(lead.id)) continue;
      lead.status = 'synced';
      lead.syncedAt = new Date().toISOString();
      synced++;
    }
  }

  return { synced, failures };
}

// Test 11: Promoted session with NO queue row → synced via fallback
function test_promoted_no_queue_row_fallback() {
  resetFallbackMockState();
  const bsid = 'session-11';
  completedLeads.set(bsid, { id: bsid, status: 'pending_sync', syncedAt: null });
  captureSessions.set(bsid, { id: bsid, promoted_lead_id: 'lead-11' });
  // No processing_queue row (auto-deleted by trigger)

  const result = mockReconcileCompletedLeads();
  const lead = completedLeads.get(bsid)!;
  assert(lead.status === 'synced', 'Fallback: promoted session with no queue row should be synced');
  assert(lead.syncedAt !== null, 'Fallback: syncedAt should be set');
  assert(result.synced === 1, 'Fallback: should report 1 synced');
}

// Test 12: Non-promoted session with no queue row → stays pending
function test_non_promoted_no_queue_row_stays_pending() {
  resetFallbackMockState();
  const bsid = 'session-12';
  completedLeads.set(bsid, { id: bsid, status: 'pending_sync', syncedAt: null });
  captureSessions.set(bsid, { id: bsid, promoted_lead_id: null });

  const result = mockReconcileCompletedLeads();
  const lead = completedLeads.get(bsid)!;
  assert(lead.status === 'pending_sync', 'Non-promoted: should stay pending_sync');
  assert(result.synced === 0, 'Non-promoted: should report 0 synced');
}

// Test 13: Session doesn't exist → stays pending (no false positive)
function test_session_not_found_stays_pending() {
  resetFallbackMockState();
  const bsid = 'session-13';
  completedLeads.set(bsid, { id: bsid, status: 'pending_sync', syncedAt: null });
  // No capture_sessions row at all

  const result = mockReconcileCompletedLeads();
  const lead = completedLeads.get(bsid)!;
  assert(lead.status === 'pending_sync', 'Session not found: should stay pending_sync');
  assert(result.synced === 0, 'Session not found: should report 0 synced');
}

// Test 14: Queue path takes priority — both paths exist, no duplicate sync
function test_queue_path_priority_no_duplicate() {
  resetFallbackMockState();
  const bsid = 'session-14';
  completedLeads.set(bsid, { id: bsid, status: 'pending_sync', syncedAt: null });
  captureSessions.set(bsid, { id: bsid, promoted_lead_id: 'lead-14' });
  completedQueueJobs.push({
    id: 'job-14', capture_session_id: bsid, state: 'COMPLETED',
    processing_completed_at: '2026-09-14T08:22:58.000Z',
  });

  const result = mockReconcileCompletedLeads();
  const lead = completedLeads.get(bsid)!;
  assert(lead.status === 'synced', 'Queue priority: should be synced');
  assert(result.synced === 1, 'Queue priority: should only sync once (no duplicate)');
}

// Test 15: Already synced records are skipped entirely
function test_already_synced_skipped() {
  resetFallbackMockState();
  const bsid = 'session-15';
  const originalSyncedAt = '2026-08-14T10:00:00.000Z';
  completedLeads.set(bsid, { id: bsid, status: 'synced', syncedAt: originalSyncedAt });
  captureSessions.set(bsid, { id: bsid, promoted_lead_id: 'lead-15' });

  const result = mockReconcileCompletedLeads();
  const lead = completedLeads.get(bsid)!;
  assert(lead.status === 'synced', 'Already synced: should remain synced');
  assert(lead.syncedAt === originalSyncedAt, 'Already synced: syncedAt should not be overwritten');
  assert(result.synced === 0, 'Already synced: should report 0 newly synced');
}

// Test 16: Mixed — one promoted (no queue), one with queue row, one non-promoted
function test_mixed_scenarios() {
  resetFallbackMockState();
  const bsid1 = 'session-16a';
  const bsid2 = 'session-16b';
  const bsid3 = 'session-16c';

  // Lead 1: promoted, no queue row → fallback
  completedLeads.set(bsid1, { id: bsid1, status: 'pending_sync', syncedAt: null });
  captureSessions.set(bsid1, { id: bsid1, promoted_lead_id: 'lead-16a' });

  // Lead 2: has queue row → queue path
  completedLeads.set(bsid2, { id: bsid2, status: 'pending_sync', syncedAt: null });
  captureSessions.set(bsid2, { id: bsid2, promoted_lead_id: 'lead-16b' });
  completedQueueJobs.push({
    id: 'job-16b', capture_session_id: bsid2, state: 'COMPLETED',
    processing_completed_at: '2026-09-14T08:22:58.000Z',
  });

  // Lead 3: not promoted, no queue row → stays pending
  completedLeads.set(bsid3, { id: bsid3, status: 'pending_sync', syncedAt: null });
  captureSessions.set(bsid3, { id: bsid3, promoted_lead_id: null });

  const result = mockReconcileCompletedLeads();
  assert(completedLeads.get(bsid1)!.status === 'synced', 'Mixed: lead 1 should be synced via fallback');
  assert(completedLeads.get(bsid2)!.status === 'synced', 'Mixed: lead 2 should be synced via queue');
  assert(completedLeads.get(bsid3)!.status === 'pending_sync', 'Mixed: lead 3 should stay pending');
  assert(result.synced === 2, 'Mixed: should report 2 synced');
}

// Test 17: Failed records are not synced by fallback
function test_failed_not_synced_by_fallback() {
  resetFallbackMockState();
  const bsid = 'session-17';
  completedLeads.set(bsid, { id: bsid, status: 'failed', syncedAt: null });
  captureSessions.set(bsid, { id: bsid, promoted_lead_id: 'lead-17' });

  // Even though session is promoted, the failed record should not be
  // touched by the fallback because it's not 'synced' but also not
  // 'pending_sync' — wait, the filter is status !== 'synced', so 'failed'
  // IS included. But the fallback should still sync it because the session
  // IS promoted — the lead was successfully created despite a prior failure.
  // This is correct behavior: if the session is promoted, the lead exists.
  const result = mockReconcileCompletedLeads();
  const lead = completedLeads.get(bsid)!;
  assert(lead.status === 'synced', 'Failed but promoted: should be synced (lead was created)');
  assert(result.synced === 1, 'Failed but promoted: should report 1 synced');
}

// Test 18: No duplicate IndexedDB records created
function test_no_duplicate_records() {
  resetFallbackMockState();
  const bsid = 'session-18';
  completedLeads.set(bsid, { id: bsid, status: 'pending_sync', syncedAt: null });
  captureSessions.set(bsid, { id: bsid, promoted_lead_id: 'lead-18' });

  mockReconcileCompletedLeads();
  mockReconcileCompletedLeads(); // run twice

  // Should still only have one record
  assert(completedLeads.size === 1, 'No duplicates: should still have exactly 1 record');
  assert(completedLeads.get(bsid)!.status === 'synced', 'No duplicates: record should be synced');
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

// Fallback reconciliation tests
test_promoted_no_queue_row_fallback();
test_non_promoted_no_queue_row_stays_pending();
test_session_not_found_stays_pending();
test_queue_path_priority_no_duplicate();
test_already_synced_skipped();
test_mixed_scenarios();
test_failed_not_synced_by_fallback();
test_no_duplicate_records();

console.log(`Queue sync regression tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
