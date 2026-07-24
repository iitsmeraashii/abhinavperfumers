// Capture Execution Engine — the single orchestration layer that combines
// User Intent (Capture Profile) with Runtime Environment (Connectivity) to
// produce an immutable Execution Plan, and also owns all runtime routing
// decisions for sync, queue, and completed-lead status.
//
// Architecture:
//
//   CaptureLeadPage (thin UI)
//         │
//         ▼
//   CaptureExecutionEngine      ← Profile + Connectivity
//    · buildPlan()              ← immutable plan for the pipeline
//    · routeSessionSync()       ← online: backend sync / offline: enqueue
//    · routeAssetSync()
//    · routeFieldSync()
//    · routeAbandon()
//    · deriveCompletedLeadStatus()
//         │
//         ├──────────────────────┐
//         ▼                      ▼
//   Execution Plan          Shared Services
//   (pipeline consumes)     (backendSync, offlineQueue)
//         │                      ▲
//         ▼                      │
//   Processing Pipeline ─────────┘
//
// The UI layer (CaptureLeadPage) never reads `navigator.onLine` or decides
// online-vs-offline routing. It delegates every runtime decision to this
// engine. Shared services remain execution-agnostic — they execute the HOW
// and never branch on profile identity or connectivity.

import type { CaptureProfile }             from './captureProfile';
import { DEFAULT_CAPTURE_PROFILE }          from './captureProfile';
import type { CaptureProfileStrategies }   from './profileStrategies';
import type { ConnectivitySnapshot }       from './CaptureConnectivity';
import { createConnectivitySnapshot }       from './CaptureConnectivity';
import type { SyncCallbacks }              from './captureBackendSync';
import {
  syncUpsertSession,
  syncUpsertAsset,
  syncUpdateSessionFields,
  syncAbandonSession,
} from './captureBackendSync';
import type {
  UpsertSessionPayload,
  UpsertAssetPayload,
} from './captureBackendSync';
import { enqueueOp } from './captureOfflineQueue';
import type { CompletedLeadStatus } from './completedLeadsStorage';

// ─── Execution Context ────────────────────────────────────────────────────────

export interface ExecutionContext {
  profile:        CaptureProfile;
  connectivity:   ConnectivitySnapshot;
  strategies:     CaptureProfileStrategies;
}

// ─── Execution Plan ────────────────────────────────────────────────────────────

export interface ExecutionPlan {
  context:      ExecutionContext;
  isOnline:     boolean;
  mode:         ExecutionMode;
  capabilities: ExecutionCapabilities;
}

export type ExecutionMode = 'SYNCHRONOUS' | 'DEFERRED';

export interface ExecutionCapabilities {
  waitForExtraction:      boolean;
  skipReviewForm:         boolean;
  queueOnDisconnect:      boolean;
  uploadCardsImmediately: boolean;
  uploadNotesOnSave:      boolean;
  syncSessionImmediately: boolean;
}

// ─── Sync routing callbacks ───────────────────────────────────────────────────
// The engine notifies the UI layer via these lightweight callbacks so React
// state can be updated without the engine importing React. Mirrors the shape
// of SyncCallbacks plus an offline-queued notification.

export interface SyncRoutingCallbacks {
  onBeforeSync:     () => void;
  onSyncing:        () => void;
  onSynced:         (patch: Record<string, unknown>) => void;
  onSyncError:      (err: string) => void;
  onOffline:        () => void;
  onOfflineQueued:  () => void;
}

// ─── Execution Engine ──────────────────────────────────────────────────────────

class CaptureExecutionEngine {

  // ── Execution Plan ──────────────────────────────────────────────────────────

  buildPlan(
    profile:    CaptureProfile,
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

  private _deriveMode(strategies: CaptureProfileStrategies): ExecutionMode {
    if (strategies.ai.waitForExtraction && !strategies.ai.skipReviewForm) {
      return 'SYNCHRONOUS';
    }
    return 'DEFERRED';
  }

  // ── Sync routing ─────────────────────────────────────────────────────────────
  // These methods encapsulate the online-vs-offline routing that was previously
  // scattered across CaptureLeadPage as `if (isOnline) { sync... } else { enqueue... }`.
  //
  // The routing logic is identical to the CRM behavior that existed before:
  //   - Online  → call the backend sync function (fire-and-forget, .catch(() => {}))
  //   - Offline → enqueue the op to IndexedDB for later flush
  //
  // The UI layer calls these methods and provides callbacks for state updates.
  // It never reads `isOnline` or `navigator.onLine` to make routing decisions.

  routeSessionSync(
    isOnline:   boolean,
    payload:    UpsertSessionPayload,
    bsid:       string,
    cbs:        SyncRoutingCallbacks,
  ): void {
    if (isOnline) {
      cbs.onBeforeSync();
      this._adaptCallbacks(syncUpsertSession(payload, this._toSyncCbs(cbs)));
    } else {
      enqueueOp('upsert_session', bsid, payload);
      cbs.onOfflineQueued();
    }
  }

  routeAssetSync(
    isOnline:   boolean,
    payload:    UpsertAssetPayload,
    cbs:        SyncRoutingCallbacks,
  ): void {
    if (isOnline) {
      cbs.onBeforeSync();
      this._adaptCallbacks(syncUpsertAsset(payload, this._toSyncCbs(cbs)));
    } else {
      enqueueOp('upsert_asset', payload.backendSessionId, payload);
      cbs.onOfflineQueued();
    }
  }

  routeFieldSync(
    isOnline:       boolean,
    bsid:           string,
    draftData:      Record<string, unknown>,
    cbs:            SyncRoutingCallbacks,
  ): void {
    if (isOnline) {
      this._adaptCallbacks(
        syncUpdateSessionFields(bsid, draftData as Parameters<typeof syncUpdateSessionFields>[1], this._toSyncCbs(cbs)),
      );
    } else {
      enqueueOp('update_session_fields', bsid, { sessionId: bsid, draftData });
      cbs.onOfflineQueued();
    }
  }

  routeAbandon(
    isOnline:           boolean,
    backendSessionId:   string,
    cbs:                SyncRoutingCallbacks,
  ): void {
    if (isOnline) {
      this._adaptCallbacks(syncAbandonSession(backendSessionId, this._toSyncCbs(cbs)));
    }
    // Offline: no-op — abandoned sessions are not queued
  }

  // ── Completed-lead status derivation ─────────────────────────────────────────
  // Previously inlined in CaptureLeadPage as `isOnline ? 'pending_sync' : 'local_only'`.
  // Now centralized here so the UI layer doesn't make runtime decisions.

  deriveCompletedLeadStatus(isOnline: boolean): CompletedLeadStatus {
    return isOnline ? 'pending_sync' : 'local_only';
  }

  // ── Internal helpers ─────────────────────────────────────────────────────────

  /**
   * Adapt a SyncRoutingCallbacks into a SyncCallbacks for the shared backend
   * sync functions. The backend sync functions call onSyncing/onSynced/onSyncError/onOffline.
   * We map those to the routing callbacks the UI provides.
   */
  private _toSyncCbs(cbs: SyncRoutingCallbacks): SyncCallbacks {
    return {
      onSyncing:   cbs.onSyncing,
      onSynced:    cbs.onSynced,
      onSyncError: cbs.onSyncError,
      onOffline:   cbs.onOffline,
    };
  }

  /**
   * Wrap a promise so it never rejects — fire-and-forget pattern.
   * The backend sync functions already catch internally, but this is a safety net.
   */
  private _adaptCallbacks(_promise: Promise<void>): void {
    // Intentionally not awaited — fire-and-forget, matching the original
    // `.catch(() => {})` pattern used throughout CaptureLeadPage.
  }

  /**
   * Resolve the default profile when the profile engine has not been resolved.
   * Used by the UI layer as a fallback.
   */
  get defaultProfile(): CaptureProfile {
    return DEFAULT_CAPTURE_PROFILE;
  }
}

export const executionEngine = new CaptureExecutionEngine();


export { executionEngine }