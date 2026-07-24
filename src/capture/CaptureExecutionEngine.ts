// Capture Execution Engine — the single orchestration layer that combines
// User Intent (Capture Profile) with Runtime Environment (Connectivity) to
// produce an immutable Execution Plan, and also owns all runtime routing
// decisions for sync, queue, and completed-lead status.
//
// Architecture:
//
//   CaptureProfileEngine                (resolves strategies — INTERNAL)
//         │
//         ▼
//   CaptureExecutionEngine               (translates strategies → policies)
//    · buildPlan()                       ← immutable execution contract
//    · routeSessionSync()                ← routes by QueuePolicy
//    · routeAssetSync()
//    · routeFieldSync()
//    · routeAbandon()
//    · deriveCompletedLeadStatus()
//         │
//         ├──────────────────────┐
//         ▼                      ▼
//   Execution Plan           Shared Services
//   (pipeline consumes)      (backendSync, offlineQueue)
//         │                      ▲
//         ▼                      │
//   Processing Pipeline ─────────┘
//
// Strategies are INTERNAL to this engine. The ExecutionPlan exposes only
// immutable execution policies — runtime behavior, not strategy flags.
// The UI and Processing Pipeline consume policies and never inspect
// strategies.

import type { CaptureProfile }             from './captureProfile';
import { DEFAULT_CAPTURE_PROFILE }          from './captureProfile';
import type { CaptureProfileStrategies }   from './profileStrategies';
import type { SyncCallbacks }              from './captureBackendSync';
import type { BackendSyncState }           from './types';
import type { PromoteSessionOptions, PromoteSessionResult } from './capturePromotionService';
import { executePromotion }                 from './capturePromotionService';
import {
  syncUpsertSession,
  syncUpsertAsset,
  syncUpdateSessionFields,
  syncAbandonSession,
  syncUpsertVisionExtraction,
  syncUpsertOcrExtraction,
  syncUpsertQrExtraction,
  syncUpdateSessionExtractionMeta,
} from './captureBackendSync';
import type {
  UpsertSessionPayload,
  UpsertAssetPayload,
  UpsertVisionExtractionPayload,
  UpsertOcrExtractionPayload,
  UpsertQrExtractionPayload,
  UpdateSessionExtractionMetaPayload,
} from './captureBackendSync';
import { enqueueOp } from './captureOfflineQueue';
import type { CompletedLeadStatus } from './completedLeadsStorage';
import type { DraftData } from './types';

// ─── Execution Policies (PUBLIC) ──────────────────────────────────────────────
// These are the runtime behavior contract. Consumers read policies, never
// strategies. Each policy expresses WHEN an operation should execute, not
// whether a strategy flag is set.

/** When extraction (Vision/OCR) should run relative to capture. */
export type ExtractionPolicy = 'IMMEDIATE' | 'DEFERRED';

/** When a particular evidence type should be uploaded to the backend. */
export type UploadTiming = 'IMMEDIATE' | 'ON_SAVE' | 'NEVER';

export interface UploadPolicy {
  businessCard: UploadTiming;
  notesImage:   UploadTiming;
  voiceNote:    UploadTiming;
}

/** When a sync operation should fire. */
export type SyncTiming = 'IMMEDIATE' | 'ON_SAVE' | 'NEVER';

export interface SyncPolicy {
  session:   SyncTiming;
  fields:    SyncTiming;
  promotion: SyncTiming;
}

/** How the queue (online-vs-offline routing) should behave. */
export type QueuePolicy = 'ONLINE_FIRST' | 'ALWAYS_QUEUE' | 'OFFLINE_ONLY';

/** Whether the review stage should execute and what to do with its result. */
export type ReviewPolicy = 'EVALUATE' | 'SKIP';

/** Whether promotion should proceed to lead_entries insert. */
export type PromotionPolicy = 'PROMOTE' | 'SKIP';

/** Whether the processing result should be transformed before returning to UI. */
export type ResultPolicy = 'PASS_THROUGH' | 'SUPPRESS_TOAST';

// ─── Execution Plan ────────────────────────────────────────────────────────────

export interface ExecutionPlan {
  isOnline:     boolean;
  extraction:   ExtractionPolicy;
  upload:       UploadPolicy;
  queue:        QueuePolicy;
  review:       ReviewPolicy;
  promotion:    PromotionPolicy;
  result:       ResultPolicy;
  /** Internal — pipeline stages still need strategy objects for validation/review/promotion/result. */
  strategies:   CaptureProfileStrategies;
}

// ─── Sync routing callbacks ───────────────────────────────────────────────────
// The engine notifies the UI layer via these lightweight callbacks so React
// state can be updated without the engine importing React.

export interface SyncRoutingCallbacks {
  onBeforeSync:     () => void;
  onSyncing:        () => void;
  onSynced:         (patch: Partial<BackendSyncState>) => void;
  onSyncError:      (err: string) => void;
  onOffline:        () => void;
  onOfflineQueued:  () => void;
}

// ─── Execution Engine ──────────────────────────────────────────────────────────

class CaptureExecutionEngine {

  // ── Execution Plan ──────────────────────────────────────────────────────────

  buildPlan(
    _profile:   CaptureProfile,
    strategies: CaptureProfileStrategies,
    isOnline:   boolean,
  ): ExecutionPlan {
    return {
      isOnline,
      extraction: this._deriveExtractionPolicy(strategies),
      upload:     this._deriveUploadPolicy(strategies),
      queue:      this._deriveQueuePolicy(strategies),
      review:     this._deriveReviewPolicy(strategies),
      promotion:  this._derivePromotionPolicy(strategies),
      result:     this._deriveResultPolicy(strategies),
      strategies,
    };
  }

  // ── Policy derivation (strategies → policies) ───────────────────────────────
  // These methods are the ONLY place where strategy flags are read.
  // They translate internal strategy configuration into public runtime policies.

  private _deriveExtractionPolicy(strategies: CaptureProfileStrategies): ExtractionPolicy {
    return strategies.ai.waitForExtraction ? 'IMMEDIATE' : 'DEFERRED';
  }

  private _deriveUploadPolicy(strategies: CaptureProfileStrategies): UploadPolicy {
    return {
      businessCard: strategies.upload.uploadCardsImmediately ? 'IMMEDIATE' : 'ON_SAVE',
      notesImage:   strategies.upload.uploadNotesOnSave      ? 'ON_SAVE'   : 'NEVER',
      voiceNote:    strategies.upload.uploadVoiceOnSave      ? 'ON_SAVE'   : 'NEVER',
    };
  }

  private _deriveQueuePolicy(strategies: CaptureProfileStrategies): QueuePolicy {
    return strategies.queue.queueOnDisconnect ? 'ONLINE_FIRST' : 'ALWAYS_QUEUE';
  }

  private _deriveReviewPolicy(strategies: CaptureProfileStrategies): ReviewPolicy {
    return strategies.ai.skipReviewForm ? 'SKIP' : 'EVALUATE';
  }

  private _derivePromotionPolicy(_strategies: CaptureProfileStrategies): PromotionPolicy {
    return 'PROMOTE';
  }

  private _deriveResultPolicy(_strategies: CaptureProfileStrategies): ResultPolicy {
    return 'PASS_THROUGH';
  }

  // ── Queue routing ────────────────────────────────────────────────────────────
  // These methods route based on the QueuePolicy + connectivity, not raw
  // `isOnline` booleans. The routing logic:
  //
  //   ONLINE_FIRST  — online: sync immediately / offline: enqueue
  //   ALWAYS_QUEUE  — always enqueue (never sync live)
  //   OFFLINE_ONLY  — always enqueue (sync only via queue replay)
  //
  // For CRM (ONLINE_FIRST), behavior is identical to before:
  //   - Online  → call the backend sync function (fire-and-forget)
  //   - Offline → enqueue the op to IndexedDB for later flush

  private _shouldSync(queue: QueuePolicy, isOnline: boolean): boolean {
    if (queue === 'ALWAYS_QUEUE') return false;
    if (queue === 'OFFLINE_ONLY') return false;
    return isOnline; // ONLINE_FIRST
  }

  // ── Sync routing ─────────────────────────────────────────────────────────────

  routeSessionSync(
    queue:      QueuePolicy,
    isOnline:   boolean,
    payload:    UpsertSessionPayload,
    bsid:       string,
    cbs:        SyncRoutingCallbacks,
  ): void {
    if (this._shouldSync(queue, isOnline)) {
      cbs.onBeforeSync();
      syncUpsertSession(payload, this._toSyncCbs(cbs)).catch(() => {});
    } else {
      enqueueOp('upsert_session', bsid, payload);
      cbs.onOfflineQueued();
    }
  }

  routeAssetSync(
    queue:      QueuePolicy,
    isOnline:   boolean,
    payload:    UpsertAssetPayload,
    cbs:        SyncRoutingCallbacks,
  ): void {
    if (this._shouldSync(queue, isOnline)) {
      cbs.onBeforeSync();
      syncUpsertAsset(payload, this._toSyncCbs(cbs)).catch(() => {});
    } else {
      enqueueOp('upsert_asset', payload.backendSessionId, payload);
      cbs.onOfflineQueued();
    }
  }

  routeFieldSync(
    queue:      QueuePolicy,
    isOnline:   boolean,
    bsid:       string,
    draftData:  DraftData,
    cbs:        SyncRoutingCallbacks,
  ): void {
    if (this._shouldSync(queue, isOnline)) {
      syncUpdateSessionFields(bsid, draftData, this._toSyncCbs(cbs)).catch(() => {});
    } else {
      enqueueOp('update_session_fields', bsid, { sessionId: bsid, draftData });
      cbs.onOfflineQueued();
    }
  }

  routeAbandon(
    queue:          QueuePolicy,
    isOnline:       boolean,
    backendSessionId: string,
    cbs:            SyncRoutingCallbacks,
  ): void {
    if (this._shouldSync(queue, isOnline)) {
      syncAbandonSession(backendSessionId, this._toSyncCbs(cbs)).catch(() => {});
    }
    // Offline: no-op — abandoned sessions are not queued
  }

  // ── Extraction routing ──────────────────────────────────────────────────────

  routeVisionExtraction(
    queue:          QueuePolicy,
    isOnline:       boolean,
    backendSessionId: string,
    payload:        UpsertVisionExtractionPayload,
    cbs:            SyncRoutingCallbacks,
  ): void {
    if (this._shouldSync(queue, isOnline)) {
      cbs.onBeforeSync();
      syncUpsertVisionExtraction(payload, this._toSyncCbs(cbs)).catch(() => {});
    } else {
      enqueueOp('upsert_vision_extraction', backendSessionId, payload);
      cbs.onOfflineQueued();
    }
  }

  routeOcrExtraction(
    queue:          QueuePolicy,
    isOnline:       boolean,
    backendSessionId: string,
    payload:        UpsertOcrExtractionPayload,
    cbs:            SyncRoutingCallbacks,
  ): void {
    if (this._shouldSync(queue, isOnline)) {
      cbs.onBeforeSync();
      syncUpsertOcrExtraction(payload, this._toSyncCbs(cbs)).catch(() => {});
    } else {
      enqueueOp('upsert_ocr_extraction', backendSessionId, payload);
      cbs.onOfflineQueued();
    }
  }

  routeQrExtraction(
    queue:          QueuePolicy,
    isOnline:       boolean,
    backendSessionId: string,
    payload:        UpsertQrExtractionPayload,
    cbs:            SyncRoutingCallbacks,
  ): void {
    if (this._shouldSync(queue, isOnline)) {
      cbs.onBeforeSync();
      syncUpsertQrExtraction(payload, this._toSyncCbs(cbs)).catch(() => {});
    } else {
      enqueueOp('upsert_qr_extraction', backendSessionId, payload);
      cbs.onOfflineQueued();
    }
  }

  routeVisionExtractionMeta(
    queue:          QueuePolicy,
    isOnline:       boolean,
    payload:        UpdateSessionExtractionMetaPayload,
  ): void {
    if (this._shouldSync(queue, isOnline)) {
      syncUpdateSessionExtractionMeta(payload, this._silentCbs()).catch(() => {});
    }
    // Offline: no-op — extraction metadata is not queued; it updates on next
    // session sync when connectivity returns.
  }

  // ── Promotion routing ───────────────────────────────────────────────────────

  async routePromotion(
    queue:          QueuePolicy,
    isOnline:       boolean,
    backendSessionId: string,
    options:          PromoteSessionOptions,
  ): Promise<{ queued: true } | { queued: false; result: PromoteSessionResult }> {
    if (!this._shouldSync(queue, isOnline)) {
      await enqueueOp('promote_session', backendSessionId, options);
      return { queued: true };
    }
    const result = await executePromotion(options);
    return { queued: false, result };
  }

  // ── Completed-lead status derivation ─────────────────────────────────────────

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

  private _silentCbs(): SyncCallbacks {
    return {
      onSyncing:   () => {},
      onSynced:    () => {},
      onSyncError: () => {},
      onOffline:   () => {},
    };
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
