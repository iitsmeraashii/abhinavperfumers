// Capture Execution Engine — combines User Intent (Capture Profile) with
// Runtime Environment (Connectivity) to produce an immutable Execution Plan.
//
// Architecture:
//
//   Capture Session
//         │
//         ▼
//   CaptureProfileEngine        ← User Intent (which profile?)
//         │
//         ▼
//   CaptureExecutionEngine      ← Profile + Connectivity
//         │
//         ▼
//   Execution Plan              ← immutable, consumed by the pipeline
//         │
//         ▼
//   Processing Pipeline         ← executes the plan, no environment awareness
//         │
//         ▼
//   Shared Domain Services      ← profile-agnostic, connectivity-agnostic
//
// The execution engine does NOT contain business logic. It reads the resolved
// strategy bundle from the profile engine, reads a connectivity snapshot, and
// packages them into a single object that the pipeline consumes. The pipeline
// never asks "am I online?" or "which profile am I?" — it reads the plan.
//
// The five previously-passive strategy interfaces (AIStrategy, UploadStrategy,
// QueueStrategy, SyncStrategy, ResultStrategy) are surfaced through the
// execution plan so pipeline stages can consult them. Their CRM
// implementations return today's exact values — no behavior changes.

import type { CaptureProfileStrategies } from './profileStrategies';
import type { ConnectivitySnapshot }     from './CaptureConnectivity';
import { createConnectivitySnapshot }     from './CaptureConnectivity';

// ─── Execution Context ────────────────────────────────────────────────────────

/**
 * Immutable description of the runtime environment at the moment processing
 * is triggered. Combines the resolved profile identity with connectivity.
 *
 * The pipeline does not construct this — the execution engine does. The
 * pipeline only reads it from the ExecutionPlan.
 */
export interface ExecutionContext {
  /** The active capture profile identifier. */
  profile:        string;
  /** Connectivity snapshot at the moment the plan was built. */
  connectivity:   ConnectivitySnapshot;
  /** The resolved strategy bundle for the active profile. */
  strategies:     CaptureProfileStrategies;
}

// ─── Execution Plan ────────────────────────────────────────────────────────────

/**
 * The single object consumed by the processing pipeline.
 *
 * Contains everything the pipeline needs to make decisions:
 *   - Which strategies to consult for each stage
 *   - Whether the device is online (for sync routing)
 *   - Which execution mode is active
 *
 * The pipeline never reads `navigator.onLine` directly. It never asks
 * `profileEngine.getProfile()`. It reads `plan.connectivity.isOnline` and
 * `plan.strategies.*` instead.
 *
 * Immutable after construction. Pipeline stages enrich the ProcessingContext
 * (their own mutable working object), not this plan.
 */
export interface ExecutionPlan {
  /** The execution context — profile + connectivity + strategies. */
  context:    ExecutionContext;
  /** Convenience: whether the device is online at plan construction time. */
  isOnline:   boolean;
  /**
   * Execution mode — derived from profile + connectivity. Currently always
   * 'SYNCHRONOUS' for CRM (both online and offline fall back to the same
   * pipeline stages; offline just queues at the promotion step). Future
   * profiles (Exhibition) will produce 'DEFERRED'.
   */
  mode:       ExecutionMode;
  /**
   * Execution capabilities — what the pipeline is allowed to do given the
   * profile + connectivity combination. Each capability maps to a strategy
   * that was previously passive. Stages consult these instead of
   * hardcoding behavior.
   */
  capabilities: ExecutionCapabilities;
}

export type ExecutionMode = 'SYNCHRONOUS' | 'DEFERRED';

/**
 * Strongly typed capability flags derived from the strategy bundle.
 * Avoids boolean explosion by grouping related capabilities.
 *
 * Each flag is sourced from the strategy layer — never from the descriptor.
 */
export interface ExecutionCapabilities {
  /** Whether to block UI on AI/OCR results before showing the review form. */
  waitForExtraction:      boolean;
  /** Whether to skip the review form and save immediately. */
  skipReviewForm:         boolean;
  /** Whether to enqueue ops to IndexedDB when offline. */
  queueOnDisconnect:      boolean;
  /** Whether to upload business card images as soon as captured. */
  uploadCardsImmediately: boolean;
  /** Whether to upload notes images at Save & Next. */
  uploadNotesOnSave:      boolean;
  /** Whether to upsert the capture_sessions row immediately on creation. */
  syncSessionImmediately: boolean;
}

// ─── Execution Engine ──────────────────────────────────────────────────────────

class CaptureExecutionEngine {
  /**
   * Build an execution plan from a resolved strategy bundle and a
   * connectivity snapshot. This is the ONLY place that combines profile
   * intent with runtime environment. Every other component receives the
   * resulting plan — they never combine the two inputs themselves.
   *
   * @param profile    - the active profile identifier (from profileEngine)
   * @param strategies - the resolved strategy bundle (from profileEngine)
   * @param isOnline   - raw connectivity boolean (from useOnlineStatus)
   * @returns immutable ExecutionPlan for the pipeline to consume
   */
  buildPlan(
    profile:    string,
    strategies: CaptureProfileStrategies,
    isOnline:   boolean,
  ): ExecutionPlan {
    const connectivity = createConnectivitySnapshot(isOnline);

    const context: ExecutionContext = {
      profile,
      connectivity,
      strategies,
    };

    const capabilities = this._deriveCapabilities(strategies);

    const mode = this._deriveMode(strategies);

    return { context, isOnline, mode, capabilities };
  }

  /**
   * Derive capability flags from the strategy bundle.
   * Each flag reads from exactly one strategy — the single source of truth.
   */
  private _deriveCapabilities(strategies: CaptureProfileStrategies): ExecutionCapabilities {
    return {
      waitForExtraction:      strategies.ai.waitForExtraction,
      skipReviewForm:         strategies.ai.skipReviewForm,
      queueOnDisconnect:      strategies.queue.queueOnDisconnect,
      uploadCardsImmediately: strategies.upload.uploadCardsImmediately,
      uploadNotesOnSave:      strategies.upload.uploadNotesOnSave,
      syncSessionImmediately: strategies.sync.syncSessionImmediately,
    };
  }

  /**
   * Derive the execution mode from the strategy bundle.
   * CRM is always synchronous (inline processing at Save & Next).
   * Exhibition will be deferred (background processing after capture).
   */
  private _deriveMode(strategies: CaptureProfileStrategies): ExecutionMode {
    // CRM waits for extraction and shows the review form → synchronous.
    // Exhibition will skip both → deferred.
    if (strategies.ai.waitForExtraction && !strategies.ai.skipReviewForm) {
      return 'SYNCHRONOUS';
    }
    return 'DEFERRED';
  }
}

// Module singleton — one engine instance for the app lifetime.
export const executionEngine = new CaptureExecutionEngine();
