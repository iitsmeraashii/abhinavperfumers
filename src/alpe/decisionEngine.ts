// ALPE Decision Engine — maps a WorkerResult to a processing_queue state
// transition.
//
// Decisions:
//   completed       → COMPLETED
//   queued          → RETRYING (offline/queued — retry later)
//   requires_review → REQUIRES_REVIEW
//   failed          → RETRYING (retryable, retry_count < MAX) or FAILED (exhausted/non-retryable)
//
// Non-retryable errors: auth/RLS/permission failures that won't succeed on
// retry. These match the classification in the ALPE pipeline's
// executePromotionStage.

import type { WorkerResult } from './worker';
import type { ProcessingState } from './types';
import { isRetryEligible } from './types';
import { alpeLog } from './diagnostics';export interface Decision {
  newState:        ProcessingState;
  failureReason:   string | null;
  isRetryable:     boolean;
  failedStage:     string | null;
  errorMessage:    string | null;
  /** retry_count after this decision is applied (caller sets via RPC). */
  nextRetryCount:  number | null;
}

const NON_RETRYABLE_PATTERNS = [
  'Not authenticated',
  'JWT',
  'row-level security',
  'policy',
  'permission',
];

function isNonRetryableError(error: string): boolean {
  return NON_RETRYABLE_PATTERNS.some(p => error.toLowerCase().includes(p.toLowerCase()));
}

export function decide(result: WorkerResult, currentRetryCount: number = 0): Decision {
  alpeLog('Decision engine input', { ...result, currentRetryCount });

  const failedStage = result.failedStage ?? null;

  switch (result.outcome) {
    case 'completed':
      return {
        newState: 'COMPLETED',
        failureReason: null,
        isRetryable: false,
        failedStage: null,
        errorMessage: null,
        nextRetryCount: null,
      };

    case 'requires_review':
      return {
        newState: 'REQUIRES_REVIEW',
        failureReason: null,
        isRetryable: false,
        failedStage: null,
        errorMessage: null,
        nextRetryCount: null,
      };

    case 'queued':
      // Offline or queued — will be retried on next poll after reconnect
      return {
        newState:        'RETRYING',
        failureReason:   result.error ?? 'Queued for retry (offline)',
        isRetryable:    true,
        failedStage,
        errorMessage:    result.error,
        nextRetryCount:  currentRetryCount + 1,
      };

    case 'failed': {
      const nonRetryable = !!(result.error && isNonRetryableError(result.error));
      const nextCount = currentRetryCount + 1;
      const exhausted = !isRetryEligible(nextCount); // nextCount >= MAX_RETRY_COUNT

      if (nonRetryable || exhausted) {
        return {
          newState:        'FAILED',
          failureReason:   result.error ?? 'Processing failed',
          isRetryable:     false,
          failedStage,
          errorMessage:    result.error,
          nextRetryCount:  nextCount,
        };
      }
      return {
        newState:        'RETRYING',
        failureReason:   result.error ?? 'Processing failed, will retry',
        isRetryable:     true,
        failedStage,
        errorMessage:    result.error,
        nextRetryCount:  nextCount,
      };
    }

    default:
      return {
        newState:        'FAILED',
        failureReason:   `Unknown outcome: ${result.outcome}`,
        isRetryable:     false,
        failedStage,
        errorMessage:    `Unknown outcome: ${result.outcome}`,
        nextRetryCount:  currentRetryCount + 1,
      };
  }
}
