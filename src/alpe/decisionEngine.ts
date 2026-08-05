// ALPE Decision Engine — maps a WorkerResult to a processing_queue state
// transition.
//
// Decisions:
//   completed       → COMPLETED
//   queued          → RETRYING (offline/queued — retry later)
//   requires_review → REQUIRES_REVIEW
//   failed          → RETRYING (retryable) or FAILED (non-retryable)
//
// Non-retryable errors: auth/RLS/permission failures that won't succeed on
// retry. These match the classification in the ALPE pipeline's
// executePromotionStage.

import type { WorkerResult } from './worker';
import type { ProcessingState } from './types';
import { alpeLog } from './diagnostics';

export interface Decision {
  newState:        ProcessingState;
  failureReason:   string | null;
  isRetryable:     boolean;
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

export function decide(result: WorkerResult): Decision {
  alpeLog('Decision engine input', result);
  switch (result.outcome) {
    case 'completed':
      return { newState: 'COMPLETED', failureReason: null, isRetryable: false };

    case 'requires_review':
      return { newState: 'REQUIRES_REVIEW', failureReason: null, isRetryable: false };

    case 'queued':
      // Offline or queued — will be retried on next poll after reconnect
      return {
        newState:      'RETRYING',
        failureReason:  result.error ?? 'Queued for retry (offline)',
        isRetryable:   true,
      };

    case 'failed':
      if (result.error && isNonRetryableError(result.error)) {
        return {
          newState:      'FAILED',
          failureReason:  result.error,
          isRetryable:   false,
        };
      }
      return {
        newState:      'RETRYING',
        failureReason:  result.error ?? 'Processing failed, will retry',
        isRetryable:   true,
      };

    default:
      return {
        newState:      'FAILED',
        failureReason:  `Unknown outcome: ${result.outcome}`,
        isRetryable:   false,
      };
  }
}
