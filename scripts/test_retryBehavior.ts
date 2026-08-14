// Focused tests for the ALPE retry behavior.
//
// Tests the decision engine's retry policy, the scheduler eligibility filter,
// and the retry_count semantics — all in isolation without touching
// Supabase or IndexedDB.

import { decide } from '../src/alpe/decisionEngine';
import {
  MAX_RETRY_COUNT,
  isRetryEligible,
  isSchedulable,
  type ProcessingState,
} from '../src/alpe/types';
import type { WorkerResult } from '../src/alpe/worker';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function failedResult(error: string, failedStage: string | null = null): WorkerResult {
  return { outcome: 'failed', leadId: null, error, failedStage, result: null };
}

function completedResult(): WorkerResult {
  return { outcome: 'completed', leadId: 'lead-123', error: null, failedStage: null, result: null };
}

function requiresReviewResult(): WorkerResult {
  return { outcome: 'requires_review', leadId: null, error: null, failedStage: null, result: null };
}

function queuedResult(error: string = 'Offline'): WorkerResult {
  return { outcome: 'queued', leadId: null, error, failedStage: null, result: null };
}

// ─── 1. Pending job → scheduler picks it up ─────────────────────────────────────

function testPendingJobSchedulable() {
  assert(isSchedulable('QUEUED', 0), 'QUEUED job with retry_count=0 should be schedulable');
  assert(isSchedulable('QUEUED', 1), 'QUEUED job with retry_count=1 should be schedulable');
  assert(isSchedulable('QUEUED', 3), 'QUEUED job should be schedulable regardless of retry_count');
}

// ─── 2. Failed job retry_count=0 → scheduler picks it up ──────────────────────

function testFailedRetry0Eligible() {
  assert(isRetryEligible(0), 'retry_count=0 should be eligible');
  assert(isSchedulable('RETRYING', 0), 'RETRYING job with retry_count=0 should be schedulable');
}

// ─── 3. Failed job retry_count=1 → scheduler picks it up ──────────────────────

function testFailedRetry1Eligible() {
  assert(isRetryEligible(1), 'retry_count=1 should be eligible');
  assert(isSchedulable('RETRYING', 1), 'RETRYING job with retry_count=1 should be schedulable');
}

// ─── 4. Failed job retry_count=2 → scheduler picks it up ──────────────────────

function testFailedRetry2Eligible() {
  assert(isRetryEligible(2), 'retry_count=2 should be eligible');
  assert(isSchedulable('RETRYING', 2), 'RETRYING job with retry_count=2 should be schedulable');
}

// ─── 5. Failed job retry_count=3 → scheduler does NOT pick it up ───────────────

function testFailedRetry3NotEligible() {
  assert(!isRetryEligible(3), 'retry_count=3 should NOT be eligible');
  assert(!isSchedulable('RETRYING', 3), 'RETRYING job with retry_count=3 should NOT be schedulable');
  assert(!isSchedulable('RETRYING', 4), 'RETRYING job with retry_count=4 should NOT be schedulable');
  assert(!isSchedulable('FAILED', 3), 'FAILED job should NOT be schedulable');
}

// ─── 6. First failed attempt → retry_count becomes 1 ──────────────────────────

function testFirstFailedAttempt() {
  const result = failedResult('Vision extraction timed out', 'AI_EXTRACTION');
  const decision = decide(result, 0); // currentRetryCount=0
  assert(decision.newState === 'RETRYING', 'First failure should go to RETRYING');
  assert(decision.isRetryable === true, 'First failure should be retryable');
  assert(decision.nextRetryCount === 1, 'First failure should set nextRetryCount=1');
  assert(decision.failedStage === 'AI_EXTRACTION', 'Failed stage should be preserved');
}

// ─── 7. Second failed attempt → retry_count becomes 2 ─────────────────────────

function testSecondFailedAttempt() {
  const result = failedResult('Vision extraction timed out', 'AI_EXTRACTION');
  const decision = decide(result, 1); // currentRetryCount=1
  assert(decision.newState === 'RETRYING', 'Second failure should go to RETRYING');
  assert(decision.isRetryable === true, 'Second failure should be retryable');
  assert(decision.nextRetryCount === 2, 'Second failure should set nextRetryCount=2');
}

// ─── 8. Third failed attempt → retry_count becomes 3, FAILED ──────────────────

function testThirdFailedAttempt() {
  const result = failedResult('Vision extraction timed out', 'AI_EXTRACTION');
  const decision = decide(result, 2); // currentRetryCount=2
  assert(decision.newState === 'FAILED', 'Third failure should go to FAILED (exhausted)');
  assert(decision.isRetryable === false, 'Third failure should NOT be retryable');
  assert(decision.nextRetryCount === 3, 'Third failure should set nextRetryCount=3');
  assert(decision.failedStage === 'AI_EXTRACTION', 'Failed stage should be preserved');
}

// ─── 9. Failure details persist correctly ─────────────────────────────────────

function testFailureDetailsPersist() {
  const result = failedResult('Promotion failed: RLS violation', 'PROMOTION');
  const decision = decide(result, 0);
  assert(decision.failureReason === 'Promotion failed: RLS violation', 'Failure reason should be preserved');
  assert(decision.errorMessage === 'Promotion failed: RLS violation', 'Error message should be preserved');
  assert(decision.failedStage === 'PROMOTION', 'Failed stage should be preserved');
}

// ─── 10. Retry updates last_attempt_at ────────────────────────────────────────
// (Verified via the RPC — increment_retry_count sets last_attempt_at = now().
//  Here we verify the decision engine produces the correct nextRetryCount
//  which the RPC uses to increment.)

function testRetryUpdatesLastAttempt() {
  const result = failedResult('Timeout', 'AI_EXTRACTION');
  const d1 = decide(result, 0);
  assert(d1.nextRetryCount === 1, 'First retry: nextRetryCount should be 1');
  const d2 = decide(result, 1);
  assert(d2.nextRetryCount === 2, 'Second retry: nextRetryCount should be 2');
  const d3 = decide(result, 2);
  assert(d3.nextRetryCount === 3, 'Third retry: nextRetryCount should be 3');
}

// ─── 11. Successful retry clears FAILED state ─────────────────────────────────

function testSuccessfulRetryClearsFailed() {
  const result = completedResult();
  const decision = decide(result, 1); // Was retrying, now succeeds
  assert(decision.newState === 'COMPLETED', 'Successful retry should go to COMPLETED');
  assert(decision.isRetryable === false, 'Completed job is not retryable');
  assert(decision.failureReason === null, 'Completed job should have no failure reason');
  assert(decision.failedStage === null, 'Completed job should have no failed stage');
}

// ─── 12. Exhausted failed jobs remain visible in Queue ─────────────────────────
// (Verified in UI — exhausted jobs have isExhausted=true and still appear
//  in the Failed section. Here we verify the decision engine produces FAILED
//  state which keeps them visible.)

function testExhaustedRemainsFailed() {
  const result = failedResult('Persistent error', 'PROMOTION');
  const decision = decide(result, 2);
  assert(decision.newState === 'FAILED', 'Exhausted job should be FAILED');
  assert(!decision.isRetryable, 'Exhausted job should not be retryable');
  // FAILED jobs are not schedulable, so they stay visible without being re-processed
  assert(!isSchedulable('FAILED', 3), 'FAILED exhausted job should not be schedulable');
}

// ─── 13. REQUIRES_REVIEW jobs are not treated as processing failures ───────────

function testRequiresReviewNotFailure() {
  const result = requiresReviewResult();
  const decision = decide(result, 0);
  assert(decision.newState === 'REQUIRES_REVIEW', 'Review job should be REQUIRES_REVIEW');
  assert(!decision.isRetryable, 'Review job should not be retryable');
  assert(decision.failureReason === null, 'Review job should have no failure reason');
  assert(decision.failedStage === null, 'Review job should have no failed stage');
  assert(!isSchedulable('REQUIRES_REVIEW', 0), 'REQUIRES_REVIEW should not be schedulable');
}

// ─── 14. Synced entries are unaffected ────────────────────────────────────────

function testSyncedUnaffected() {
  const result = completedResult();
  const decision = decide(result, 0);
  assert(decision.newState === 'COMPLETED', 'Completed job should be COMPLETED');
  assert(!isSchedulable('COMPLETED', 0), 'COMPLETED should not be schedulable');
}

// ─── 15. Non-retryable errors go straight to FAILED ───────────────────────────

function testNonRetryableError() {
  const result = failedResult('row-level security policy violation', 'PROMOTION');
  const decision = decide(result, 0);
  assert(decision.newState === 'FAILED', 'Non-retryable error should go to FAILED immediately');
  assert(!decision.isRetryable, 'Non-retryable error should not be retryable');
  assert(decision.nextRetryCount === 1, 'Non-retryable error should still increment retry_count');
}

// ─── 16. Queued (offline) result goes to RETRYING ─────────────────────────────

function testQueuedGoesToRetrying() {
  const result = queuedResult('Offline — will retry');
  const decision = decide(result, 0);
  assert(decision.newState === 'RETRYING', 'Queued result should go to RETRYING');
  assert(decision.isRetryable === true, 'Queued result should be retryable');
  assert(decision.nextRetryCount === 1, 'Queued result should increment retry_count');
}

// ─── 17. MAX_RETRY_COUNT is 3 ────────────────────────────────────────────────

function testMaxRetryCount() {
  assert(MAX_RETRY_COUNT === 3, 'MAX_RETRY_COUNT should be 3');
}

// ─── Run all tests ─────────────────────────────────────────────────────────────

testPendingJobSchedulable();
testFailedRetry0Eligible();
testFailedRetry1Eligible();
testFailedRetry2Eligible();
testFailedRetry3NotEligible();
testFirstFailedAttempt();
testSecondFailedAttempt();
testThirdFailedAttempt();
testFailureDetailsPersist();
testRetryUpdatesLastAttempt();
testSuccessfulRetryClearsFailed();
testExhaustedRemainsFailed();
testRequiresReviewNotFailure();
testSyncedUnaffected();
testNonRetryableError();
testQueuedGoesToRetrying();
testMaxRetryCount();

console.log('ALPE retry behavior tests passed');
