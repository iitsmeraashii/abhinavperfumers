# Capture → ALPE Architecture — Implementation Reference

Detailed implementation guide for engineers modifying the capture and processing system. Every section names exact files, functions, types, and state transitions. This is descriptive — it documents what exists, not what should change.

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Capture Profiles: CRM vs Exhibition](#2-capture-profiles-crm-vs-exhibition)
3. [Execution Engine & Plan](#3-execution-engine--plan)
4. [Capture Session Lifecycle](#4-capture-session-lifecycle)
5. [Evidence Management](#5-evidence-management)
6. [Backend Sync & Offline Queue](#6-backend-sync--offline-queue)
7. [ALPE Processing Queue](#7-alpe-processing-queue)
8. [Scheduler](#8-scheduler)
9. [Worker](#9-worker)
10. [Pipeline Stages](#10-pipeline-stages)
11. [Extraction Service](#11-extraction-service)
12. [Review Engine](#12-review-engine)
13. [Promotion Service](#13-promotion-service)
14. [Decision Engine](#14-decision-engine)
15. [Recovery Service](#15-recovery-service)
16. [Diagnostics & Runtime Configuration](#16-diagnostics--runtime-configuration)
17. [Modification Guide](#17-modification-guide)

---

## 1. System Overview

The capture system has two processing paths controlled by a single feature flag:

**File:** `src/alpe/featureFlag.ts`
```typescript
export function useAlpeProcessing(): boolean {
  return import.meta.env.VITE_USE_ALPE_PROCESSING === 'true';
}
```

### Path A — Synchronous (flag off, default)
The capture UI runs extraction, validation, review, and promotion inline during the capture session. The rep sees extracted fields, reviews them on-screen, and presses Save & Next to promote. All processing completes before the UI advances.

### Path B — ALPE Asynchronous (flag on)
The capture UI submits the session to a backend `processing_queue` table and immediately advances. A browser-resident scheduler polls the queue, claims jobs, and runs the same pipeline stages asynchronously via a worker. The rep does not wait for extraction or promotion.

### Key architectural invariant
Both paths share the **same pipeline** (`src/alpe/pipeline.ts`), the **same promotion service** (`src/capture/capturePromotionService.ts`), the **same review engine** (`src/capture/captureReviewEngine.ts`), and the **same validation engine** (`src/capture/captureValidationEngine.ts`). The worker reconstructs a `ProcessingContext` from backend rows and feeds it into the identical `processCaptureSession()` function. No business logic is duplicated.

---

## 2. Capture Profiles: CRM vs Exhibition

### Type Definition
**File:** `src/capture/captureProfile.ts`

```typescript
export type CaptureProfile = 'CRM' | 'EXHIBITION';
export const DEFAULT_CAPTURE_PROFILE: CaptureProfile = 'CRM';
```

`captureProfile.ts` contains **presentation metadata only** (display names, icons, colors). No runtime code reads these descriptors. All behavioral decisions live in the strategy layer.

### Strategy Bundles
**File:** `src/capture/profileStrategies.ts`

Each profile provides a `CaptureProfileStrategies` bundle with six strategy interfaces:

| Strategy | Interface | CRM Behavior | Exhibition Behavior |
|---|---|---|---|
| Validation | `ValidationStrategy` | Requires name, company, OR phone (evidence alone is insufficient) | Accepts name, company, phone, OR evidence (card/QR) — extraction will fill details later |
| Review | `ReviewStrategy` | Delegates to `reviewEngine.evaluate()` | Same — delegates to `reviewEngine.evaluate()` |
| AI | `AIStrategy` | `waitForExtraction: true`, `skipReviewForm: false` | `waitForExtraction: false`, `skipReviewForm: true` |
| Queue | `QueueStrategy` | `queueOnDisconnect: true` | `queueOnDisconnect: true` |
| Upload | `UploadStrategy` | `uploadCardsImmediately: true` | `uploadCardsImmediately: false` (deferred to ON_SAVE) |
| Promotion | `PromotionStrategy` | Passes `requiresReview` through | Same — passes `requiresReview` through |
| Result | `ResultStrategy` | Pass-through | Pass-through |

### Strategy Resolution
**File:** `src/capture/profileStrategies.ts` — `getProfileStrategies(profile)`

```typescript
const PROFILE_STRATEGY_REGISTRY: Partial<Record<CaptureProfile, CaptureProfileStrategies>> = {
  CRM:        CRM_STRATEGIES,
  EXHIBITION: EXHIBITION_STRATEGIES,
};
```

Throws if the profile is not registered. Adding a new profile requires: (1) new union member in `CaptureProfile`, (2) new descriptor in `CAPTURE_PROFILE_DESCRIPTORS`, (3) new strategy bundle + registry entry.

### CRM Validation (strict)
**File:** `src/capture/captureValidationEngine.ts`

```typescript
validate(data: DraftData): ValidationResult
```
Requires at least one of: `clientName`, `company`, `phone` (all trimmed, non-empty). Evidence (card photo, QR) is NOT sufficient — extraction may have failed. Returns `{ valid: false, error: { message } }` when none are present.

### Exhibition Validation (lenient)
**File:** `src/capture/profileStrategies.ts` — `ExhibitionValidationStrategy`

Accepts name, company, phone, OR evidence (`cardFrontAssetId`, `rawQr`). Rationale: AI extraction will fill contact details later during async processing.

### Critical difference for engineers
CRM mode blocks Save & Next if no identifier is present. Exhibition mode allows saving with only a photo or QR scan, trusting the async pipeline to extract identifiers. If you modify validation rules, check both strategy classes — they are independent implementations of the same interface.

---

## 3. Execution Engine & Plan

**File:** `src/capture/CaptureExecutionEngine.ts`

Singleton `executionEngine` (class `CaptureExecutionEngine`). Translates strategy bundles + connectivity into an immutable `ExecutionPlan`.

### buildPlan()
```typescript
buildPlan(profile, strategies, isOnline): ExecutionPlan
```

Returns:
```typescript
interface ExecutionPlan {
  isOnline:     boolean;
  extraction:  'IMMEDIATE' | 'DEFERRED';
  upload:      { businessCard: UploadTiming; notesImage: UploadTiming; voiceNote: UploadTiming };
  queue:       'ONLINE_FIRST' | 'ALWAYS_QUEUE' | 'OFFLINE_ONLY';
  review:      'EVALUATE' | 'SKIP';
  promotion:   'PROMOTE' | 'SKIP';
  result:      'PASS_THROUGH' | 'SUPPRESS_TOAST';
  strategies:  CaptureProfileStrategies;  // internal — stages still need strategy objects
}
```

### Policy derivation (strategies → policies)
| Method | Reads | Returns |
|---|---|---|
| `_deriveExtractionPolicy` | `strategies.ai.waitForExtraction` | `IMMEDIATE` if true, `DEFERRED` if false |
| `_deriveUploadPolicy` | `strategies.upload.*` | `IMMEDIATE` / `ON_SAVE` / `NEVER` per evidence type |
| `_deriveQueuePolicy` | `strategies.queue.queueOnDisconnect` | `ONLINE_FIRST` if true, `ALWAYS_QUEUE` if false |
| `_deriveReviewPolicy` | `strategies.ai.skipReviewForm` | `EVALUATE` if false, `SKIP` if true |
| `_derivePromotionPolicy` | (hardcoded) | Always `PROMOTE` |
| `_deriveResultPolicy` | (hardcoded) | Always `PASS_THROUGH` |

### Sync routing
The engine routes all sync operations via `_shouldSync(queue, isOnline)`:
- `ONLINE_FIRST` → sync immediately if online, enqueue if offline
- `ALWAYS_QUEUE` → always enqueue (never sync live)
- `OFFLINE_ONLY` → always enqueue

Routing methods: `routeSessionSync()`, `routeAssetSync()`, `routeFieldSync()`, `routeAbandon()`, `routeVisionExtraction()`, `routeOcrExtraction()`, `routeQrExtraction()`, `routeVisionExtractionMeta()`, `routePromotion()`.

All sync routing is **fire-and-forget** — promises are `.catch(() => {})` swallowed. The UI never blocks on sync. The only exception is `routePromotion()`, which is async and returns `{ queued: true } | { queued: false, result }`.

### Completed-lead status derivation
```typescript
deriveCompletedLeadStatus(isOnline): CompletedLeadStatus
```
Returns `'pending_sync'` if online, `'local_only'` if offline.

---

## 4. Capture Session Lifecycle

### Session State
**File:** `src/capture/types.ts`

```typescript
interface CaptureSession {
  captureMethod:           CaptureMethod | null;       // current UI method
  originalCaptureMethod:   CaptureMethod | null;       // set once, never overwritten
  sessionStatus:          SessionStatus;              // 'IDLE' | 'CAPTURING' | 'DRAFT' | 'READY_FOR_REVIEW'
  captureProfile:         CaptureProfile;
  createdAt:              Date | null;
  updatedAt:              Date | null;
  draftData:              DraftData;
  hasUnsavedChanges:      boolean;
  sync:                   BackendSyncState;
}
```

`originalCaptureMethod` is set when the session starts and never overwritten. When a BUSINESS_CARD or QR capture transitions to MANUAL (for the review form), `captureMethod` changes but `originalCaptureMethod` stays — so `capture_sessions.capture_method` reflects how the lead was originally captured.

### DraftData
**File:** `src/capture/types.ts`

The central data structure. Contains all extracted + manually entered fields:
- Priority contact: `clientName`, `company`, `phone`, `email`, `designation`, `leadTemperature`
- Quick notes: `notes`, `notesImageDataUrl`, `voiceNoteDurationMs`, `voiceNoteTranscript`
- Additional details: `leadType`, `previousRepCode`, `application[]`, `priceRange`, `quickKeywords[]`, `targetMarket[]`, `certification[]`, `benchmark[]`
- Multi-value from vision: `phoneNumbers[]`, `emails[]`, `website`, `address`
- Card references: `cardFrontAssetId`, `cardBackAssetId`
- Extraction metadata: `extractionSource`, `extractionConfidence` (0–1 float), `ocrRawText`, `visionRawText`
- QR: `rawQr`, `qrExtractionEmpty`
- Has an index signature `[key: string]: unknown` for backward-compat scattered fields

### Session Hook
**File:** `src/capture/useCaptureSession.ts`

The hook manages the top-level state machine. Key behaviors:
- **Autosave**: every 700ms (debounced) via `useAutosave.ts`, writes to IndexedDB `drafts` store
- **Draft recovery**: on page reload, `loadDraft()` restores the session from IndexedDB
- **Sync**: fire-and-forget via `captureBackendSync.ts` functions
- **Save & Next**: branches on `useAlpeProcessing()` flag → either `produceProcessingJob()` (ALPE) or `processCaptureSession()` (sync)

### BackendSyncState
**File:** `src/capture/types.ts`

```typescript
interface BackendSyncState {
  status:               SyncStatus;         // 'idle' | 'syncing' | 'synced' | 'error' | 'offline'
  backendSessionId:     string | null;      // capture_sessions.id
  lastSyncedAt:         string | null;
  pendingOps:           number;             // in-flight ops counter for UI indicators
  lastError:            string | null;
  backendAssetIds:      Record<string, string>;    // localAssetId → capture_assets.id
  backendExtractionIds: Record<string, string>;    // localKey → extraction_results.id
}
```

`INITIAL_SYNC_STATE` constant provides the starting state.

---

## 5. Evidence Management

### Evidence Model
**File:** `src/capture/captureEvidenceManager.ts`

The `CaptureEvidenceManager` singleton (exported as `evidenceManager`) is the single owner of evidence lifecycle. It is profile-agnostic — it receives `UploadTiming` policies from the `ExecutionPlan`.

Evidence types: `business_card_front`, `business_card_back`, `notes_image`, `voice_note`.

### Registration Flow
```typescript
evidenceManager.register(evidence: CaptureEvidence): void
```

For business cards:
- If `uploadTiming === 'ON_SAVE'`: asset is buffered in `_pendingCardUploads` Map (deferred)
- If `uploadTiming === 'IMMEDIATE'`: calls `_uploadBusinessCard()` immediately, tracks the promise

For notes images: buffered in `_pendingNotes` (always ON_SAVE).

For voice notes: delegated entirely to `voiceEvidenceManager` (`src/capture/voiceEvidenceManager.ts`), which owns the full upload → transcription lifecycle including offline queueing.

### Upload Flow
**File:** `src/capture/assetStorageUpload.ts`

`uploadBusinessCardAsset(asset, correlationId)`:
1. Uploads JPEG dataURL to Supabase Storage bucket `lead-evidence` at path `{sessionId}/{assetId}.jpg`
2. Writes metadata to `capture_assets` row (`storage_path`, `storage_bucket`, `storage_upload_status: 'uploaded'`)
3. Returns `{ uploaded, metadataWritten, storagePath }`

If the file uploads but the metadata write fails, the asset is queued for reconciliation via `_pendingReconciliation`.

### Save & Next Upload Sequence
```typescript
evidenceManager.onSaveAndNext(sessionId, correlationId): void
```
1. Calls `voiceEvidenceManager.onSaveAndNext(sessionId)` — voice uploads are NOT gated by `navigator.onLine` (voice has its own offline queue)
2. If offline: returns (notes + reconciliation wait for connectivity)
3. Uploads pending notes image
4. Reconciles any pending asset metadata

```typescript
evidenceManager.flushPendingUploads(sessionId, correlationId): void
```
Starts all deferred (ON_SAVE) business card uploads. Called by `jobProducer.ts` before `waitForUploads()`.

```typescript
evidenceManager.waitForUploads(sessionId): Promise<void>
```
Awaits all tracked upload promises via `Promise.allSettled()`. Called by `jobProducer.ts` to ensure uploads complete before enqueuing the processing job.

### Session Reset
```typescript
evidenceManager.onSessionReset(): void
```
Clears pending notes, reconciliation, and card uploads. Does NOT clear `_uploadTrackers` — `produceProcessingJob()` may still need to await them after the session resets.

### Evidence Resolver (ALPE path)
**File:** `src/alpe/evidenceResolver.ts`

`resolveEvidence(ref: AssetReference | null): Promise<ResolvedEvidence>`

Converts an `AssetReference` (built by the worker from `capture_assets` rows) into a `ResolvedEvidence` payload with a signed URL and optional blob. Never throws — returns a structured result with status:
- `resolved` — signed URL created, blob fetched
- `no_asset` — reference was null
- `no_storage` — asset exists but has no `storage_path`
- `fetch_failed` — signed URL creation or fetch failed
- `corrupt` — exception during resolution

Includes a pre-resolution diagnostic query: reads the `capture_assets` row to compare DB state against the `AssetReference`. If the DB has a `storage_path` but the reference does not (stale from before upload completed), it patches the reference.

`resolveAllEvidence(evidence: EvidenceAssets)` resolves all five evidence slots (front, back, qr, notesImage, audio) in parallel.

### AssetReference Model
**File:** `src/alpe/assetReference.ts`

```typescript
interface AssetReference {
  assetId:       string;
  assetType:     string;
  assetSide:     string | null;
  storagePath:   string | null;
  publicUrl:     string | null;
  localAssetId:  string;
  mimeType:      string;
  source:        'capture_assets';
  uploaded:      boolean;
  metadata: { width, height, fileSize, transcriptionStatus, processingStatus, storageBucket, storageProvider };
}

interface EvidenceAssets {
  businessCard: { front: AssetReference | null; back: AssetReference | null };
  qr:           AssetReference | null;
  notesImage:   AssetReference | null;
  audio:        AssetReference | null;
}
```

`EMPTY_EVIDENCE` constant provides a null-filled default.

---

## 6. Backend Sync & Offline Queue

### Backend Sync
**File:** `src/capture/captureBackendSync.ts`

All sync functions use stable frontend-generated UUIDs (`crypto.randomUUID()`) for idempotent upserts. Functions:
- `syncUpsertSession(payload, callbacks)` — upserts `capture_sessions` row
- `syncUpsertAsset(payload, callbacks)` — upserts `capture_assets` row
- `syncUpdateSessionFields(sessionId, draftData, callbacks)` — updates `extracted_fields`, `phones`, `emails`, enrichment columns
- `syncUpsertVisionExtraction(payload, callbacks)` — upserts `extraction_results` row (engine: `openai_vision`)
- `syncUpsertOcrExtraction(payload, callbacks)` — upserts `extraction_results` row (engine: `tesseract_ocr`)
- `syncUpsertQrExtraction(payload, callbacks)` — upserts `extraction_results` row (engine: `qr_parser`)
- `syncUpdateSessionExtractionMeta(payload)` — updates extraction metadata on session
- `syncAbandonSession(sessionId, callbacks)` — marks session as abandoned

All functions accept a `SyncCallbacks` object: `{ onSyncing, onSynced, onSyncError, onOffline, correlationId }`.

**Critical invariant:** No sync function is ever awaited by UI code. All are fire-and-forget. Failures update `BackendSyncState` but never throw to the user.

### Offline Queue
**File:** `src/capture/captureOfflineQueue.ts`

When `navigator.onLine === false`, sync calls are redirected to `enqueueOp()` instead of being dropped.

#### IndexedDB Store: `pending_ops`
Each op: `{ id, type, sessionId, createdAt, retries, payload }`

Op types: `upsert_session`, `upsert_asset`, `upsert_ocr_extraction`, `upsert_vision_extraction`, `upsert_qr_extraction`, `update_session_fields`, `promote_session`, `upload_voice_note`, `enqueue_processing_job`

#### Flush — `flushQueue()`
Called by `useOnlineStatus` hook's `onReconnect` callback:
1. Loads all ops sorted by `createdAt` ascending
2. For each op: calls `executeOp()` → dispatches to the matching `sync*` function
3. Success → deletes op from IndexedDB
4. Auth error (`'Not authenticated'`, `'JWT'`) → deletes op (non-retryable)
5. Network/server error → increments `retries`, keeps op
6. Guard: `flushInProgress` flag prevents concurrent flushes

#### ALPE Integration
After `flushQueue()` completes, `CaptureLeadPage` calls `notifyAlpeReconnect()` to trigger an immediate scheduler poll.

### Online Status Hook
**File:** `src/capture/useOnlineStatus.ts`

Returns `{ isOnline, onReconnect }`. The `onReconnect` callback fires when connectivity returns after being offline. `CaptureLeadPage` wires this to both `flushQueue()` and `notifyAlpeReconnect()`.

---

## 7. ALPE Processing Queue

### Job Producer
**File:** `src/alpe/jobProducer.ts`

`produceProcessingJob()` is the entry point when ALPE is enabled. Sequence:
1. Resolves auth identity via `getAuthIdentity()` (`src/capture/captureAuth.ts`) → `{ userId, repCode }`
2. **Awaits** `syncUpsertSession()` with `sessionStatus: 'CAPTURING'` — this is the only awaited sync call, to guarantee the `capture_sessions` row exists before enqueue (FK constraint)
3. Calls `evidenceManager.flushPendingUploads(backendSessionId)` — starts deferred card uploads
4. **Awaits** `evidenceManager.waitForUploads(backendSessionId)` — waits for all upload promises
5. For BUSINESS_CARD captures, calls `waitForAssetStorageReady()` (`src/capture/assetStorageUpload.ts`) — confirms `storage_path` is written to `capture_assets` rows (30s deadline)
6. Generates `jobId = crypto.randomUUID()`
7. Calls `enqueueJob()` → inserts `processing_queue` row with `state: 'QUEUED'`
8. Writes local `completed_leads` record with `status: 'pending_sync'`
9. Returns `{ outcome: 'queued', jobId }`

Returns `{ outcome: 'failed', error }` if session sync or asset readiness fails.

### Processing Queue Repository
**File:** `src/alpe/processingQueueRepository.ts`

#### enqueueJob()
Inserts: `{ id: jobId, capture_session_id, user_id, event_id, state: 'QUEUED', priority, processing_version, enqueued_at, scheduled_at, metadata }`

#### claimNextJob(userId)
1. Selects highest-priority `QUEUED` job for the user, ordered by `priority DESC, enqueued_at ASC`
2. Atomic transition `QUEUED → PROCESSING` via optimistic lock (`.eq('state', 'QUEUED')`)
3. Returns `QueueEntry` or null

#### State Transitions
| Function | From → To | Notes |
|---|---|---|
| `claimNextJob()` | `QUEUED → PROCESSING` | Atomic optimistic lock |
| `updateJobState(id, newState, patch)` | Any → terminal | Sets `processing_completed_at` for `COMPLETED`, `FAILED`, `INVALID`, `REQUIRES_REVIEW` |
| `markRetrying(jobId, reason)` | `PROCESSING → RETRYING` | Calls `increment_retry_count` RPC, falls back to manual update |
| `markRecovering(jobId)` | `PROCESSING → RECOVERING` | Stamps `processing_started_at` |
| `requeueJob(jobId)` | `RECOVERING/RETRYING → QUEUED` | Resets `processing_started_at`, increments `retry_count` |

### Queue State Machine
```
QUEUED → PROCESSING → COMPLETED (terminal)
                    → REQUIRES_REVIEW (terminal)
                    → FAILED (terminal, non-retryable)
                    → RETRYING → QUEUED (requeue) or FAILED (max retries)
RECOVERING → QUEUED (recovery on scheduler start)
```

### QueueEntry Type
**File:** `src/alpe/types.ts`

```typescript
interface QueueEntry {
  id:                  string;
  capture_session_id:  string;
  user_id:             string;
  event_id:            string | null;
  state:               QueueState;
  priority:            number;
  processing_version:  number;
  enqueued_at:         string;
  scheduled_at:        string | null;
  processing_started_at: string | null;
  processing_completed_at: string | null;
  retry_count:         number;
  max_retries:         number;
  failure_reason:      string | null;
  metadata:            Record<string, unknown> | null;
}
```

---

## 8. Scheduler

**File:** `src/alpe/scheduler.ts`

Singleton `AlpeScheduler` (exported as `scheduler`).

### Lifecycle
- `start(userId)` — idempotent (no-op if already running). Runs recovery, then begins polling.
- `stop()` — graceful. Cancels poll timer, waits for in-flight tick (max 10s), sets status to `stopped`.
- `notifyReconnect()` — sets `isOnline = true`, triggers immediate tick if running and no tick in-flight.
- `notifyOffline()` — sets `isOnline = false`, suppresses polling.

### Polling
- **Interval:** 5000ms (`POLL_INTERVAL_MS`)
- **Guard:** `inFlightTick` flag prevents concurrent ticks
- **Offline skip:** if `isOnline === false`, tick returns immediately

### Tick Sequence
1. `claimNextJob(userId)` — atomic claim from `processing_queue`
2. If no job: return
3. `processJob(job)` — run the worker (see Section 9)
4. `decide(workerResult)` — map worker result to queue decision (see Section 14)
5. If `RETRYING` and retryable: `markRetrying(jobId, reason)`
6. Otherwise: `updateJobState(jobId, decision.newState, { failure_reason })`
7. Increment `jobsProcessed` on `COMPLETED` or `REQUIRES_REVIEW`

### Scheduler State
```typescript
interface SchedulerState {
  status:          'stopped' | 'starting' | 'running' | 'stopping';
  pollCount:       number;
  jobsProcessed:   number;
  lastPollAt:      string | null;
  lastError:       string | null;
  recoveryReport:  RecoveryReport | null;
}
```

### Scheduler Hook
**File:** `src/alpe/useAlpeScheduler.ts`

React hook that starts/stops the scheduler based on auth state. Called from `CaptureLeadPage` or `App.tsx`.

### Runtime Updates
The scheduler calls `updateAlpeRuntime()` throughout the tick to update diagnostics state (current job, queue state, pipeline stage, worker state). See Section 16.

---

## 9. Worker

**File:** `src/alpe/worker.ts`

`processJob(job: QueueEntry): Promise<WorkerResult>`

### WorkerResult
```typescript
interface WorkerResult {
  outcome:   'completed' | 'failed' | 'requires_review' | 'queued';
  leadId:    string | null;
  error:     string | null;
  result:    ProcessingResult | null;
}
```

### Execution Sequence

#### Step 1: Load session
Fetches `capture_sessions` row by `job.capture_session_id` via `fetchBackendSession()`. If not found → `{ outcome: 'failed', error: 'Capture session not found' }`.

If `promoted_lead_id` is already set → `{ outcome: 'completed', leadId: row.promoted_lead_id }` (idempotent — safe for retries).

#### Step 2: Load assets
Fetches all `capture_assets` rows via `fetchBackendAssets()`. Builds `EvidenceAssets` via `buildEvidence()`.

#### Step 3: Wait for asset uploads
If extractable assets exist (`business_card` or `qr`):
- Calls `waitForAssetsUploaded(backendSessionId)` — polls `capture_assets` every 1s up to 30s
- If timeout → returns `{ outcome: 'failed', error: 'Assets not yet uploaded' }` — this is a **retryable** failure; the scheduler will retry on the next poll
- If ready: re-fetches assets so `storage_path` is current

#### Step 4: Reconstruct DraftData
`reconstructDraftData(row, assets, evidence)` — reads `extracted_fields` JSON + enrichment columns from the session row and maps them to `DraftData`. Also populates deprecated scattered fields (`cardFrontAssetId`, `cardFrontStoragePath`, etc.) from `EvidenceAssets` for backward compatibility with downstream code.

#### Step 5: Resolve event info
`fetchEventInfo(eventId)` → `{ eventCode, eventName }` from the `events` table.

#### Step 6: Build execution plan
```typescript
const isOnline = typeof navigator !== 'undefined' ? navigator.onLine : true;
const plan = executionEngine.buildPlan(profile, strategies, isOnline);
```
`profile` is currently hardcoded to `'CRM'` via `resolveProfile()`.

#### Step 7: Build ProcessingContext
Constructs a `CaptureSession` object with `sync.status: 'synced'` and `sync.backendSessionId` set, then wraps it in a `ProcessingContext`:

```typescript
interface ProcessingContext {
  session:          CaptureSession;
  backendSessionId: string;
  eventCode:        string | null;
  eventId:          string | null;
  eventName:        string | null;
  completedLeadId:  string;           // = backendSessionId
  plan:             ExecutionPlan;
  evidence:         EvidenceAssets;
  correlationId:   string | null;     // from job.metadata
}
```

#### Step 8: Run pipeline
```typescript
const result = await processCaptureSession(ctx);
```
Maps `ProcessingResult.outcome` to `WorkerResult.outcome`:
- `'success'` → `'completed'`
- `'queued'` → `'queued'`
- `'requires_review'` → `'requires_review'`
- else → `'failed'`

#### Diagnostics
The worker is heavily instrumented with `traceStage()` calls that log to console and insert into `alpe_runtime_dumps` table. Stages: `WORKER_START`, `LOAD_SESSION`, `LOAD_ASSETS`, `WAIT_ASSETS_START`, `WAIT_ASSETS_RESULT`, `ASSET_REFERENCES`, `DRAFT_DATA`, `EVENT_INFO`, `PLAN_BUILT`, `PIPELINE_START`, `PIPELINE_COMPLETE`, `PIPELINE_ERROR`, `ALREADY_PROMOTED`.

---

## 10. Pipeline Stages

**File:** `src/alpe/pipeline.ts`

`processCaptureSession(ctx: ProcessingContext): Promise<ProcessingResult>`

### ProcessingResult
```typescript
interface ProcessingResult {
  outcome:   'success' | 'failed' | 'queued' | 'requires_review';
  leadId:    string | null;
  error:     string | null;
}
```

### Stage 1: Evidence Upload — `executeEvidenceStage(ctx)`
- Registers notes image with `evidenceManager` if `draftData.notesImageDataUrl` exists
- Calls `evidenceManager.onSaveAndNext(backendSessionId)`

### Stage 2: Evidence Resolution — `executeEvidenceResolutionStage(ctx)`
- Calls `resolveAllEvidence(ctx.evidence)` from `src/alpe/evidenceResolver.ts`
- Resolves storage paths to signed URLs and blobs for each evidence slot
- Stores resolved evidence on `ctx` for the extraction stage

### Stage 3: AI Extraction — `executeExtractionStage(ctx)`
- For `BUSINESS_CARD` captures: calls `extractBusinessCard(resolvedFront)` from `src/alpe/extractionService.ts`
  - If back card exists and front extraction yielded no email/phone, also calls `extractBusinessCard(resolvedBack)`
  - Merges extracted fields into `ctx.session.draftData` — does NOT overwrite manually-set fields
- For `QR` captures: calls `extractQr(resolvedQr)`
- Sets `ctx.extractionSource`, `ctx.extractionConfidence` (0–1), `ctx.fieldConfidence`, `ctx.fieldStatus`
- For `MANUAL` captures: skips extraction, sets `extractionConfidence = null`

### Stage 4: Persist Extraction Metadata — `executeExtractionMetadataStage(ctx)`
**File:** `src/alpe/extractionMetadataPersistence.ts`
- Calls `persistExtractionMetadata()` — writes `extraction_source`, `extraction_status`, `extraction_confidence` to `capture_sessions` row
- Also persists `field_confidence` and `field_status` JSON if available

### Stage 5: Validation — `executeValidationStage(ctx)`
- Calls `strategies.validation.validate(draftData)`
- CRM: requires name, company, or phone
- Exhibition: accepts name, company, phone, OR evidence
- If invalid: sets `ctx.result = { outcome: 'failed', error }` and returns early — pipeline stops

### Stage 6: Review — `executeReviewStage(ctx)`
- If `plan.review === 'SKIP'`: sets `ctx.review = { required: false }`
- Otherwise: calls `strategies.review.evaluate(draftData, confidencePercent, extractionContext)`
  - `confidencePercent` = `extractionConfidence * 100` (or null for manual)
  - `extractionContext` = `{ status, fieldConfidence, fieldStatus, backendSessionId }`
- Persists review result via `persistReviewResult()` — writes `review_state` JSON to `capture_sessions`

### Stage 7: Promotion — `executePromotionStage(ctx)`
- If `plan.promotion === 'SKIP'`: sets `ctx.result = { outcome: 'queued' }`
- Otherwise:
  - Builds options via `strategies.promotion.buildOptions({ ..., requiresReview: ctx.review?.required ?? false })`
  - Calls `executionEngine.routePromotion(plan.queue, isOnline, backendSessionId, options)`
  - If queued (offline): writes `completed_leads` with `status: 'pending_sync'`, enqueues offline op
  - If success: sets `ctx.result = { outcome: 'success', leadId }`
  - If error and non-retryable: sets `ctx.result = { outcome: 'failed', error }`
  - If error and retryable: queues promotion for offline replay

### Stage Ordering
Stages run sequentially. A failure in any stage short-circuits the pipeline — subsequent stages do not run. The `ctx.result` field holds the final outcome.

---

## 11. Extraction Service

**File:** `src/alpe/extractionService.ts`

### extractBusinessCard(resolved: ResolvedEvidence): Promise<ExtractionOutcome>

Flow (mirrors `useVisionExtraction.ts` exactly):
1. Fetch image from resolved signed URL → blob → dataURL
2. Preprocess: resize (max 1600px), sharpen (3x3 kernel), JPEG quality 0.82
3. Call OpenAI Vision edge function (`extract-business-card`) with 30s timeout
4. If vision fails: fall back to Tesseract OCR (`ocrFallback.ts`) → `parseBusinessCard.ts`
5. Return `ExtractionOutcome` with `source`, `confidence` (0–1), `fields`, `fieldConfidence`, `fieldStatus`

### extractQr(resolved: ResolvedEvidence): Promise<ExtractionOutcome>
1. Fetch QR text from resolved URL
2. Parse via `parseQrPayload()` (`src/capture/parseQrPayload.ts`)
3. Return `ExtractionOutcome` — note: `source` is set to `'openai_vision'` even though QR is deterministic (not AI)

### ExtractionOutcome
```typescript
interface ExtractionOutcome {
  source:          'openai_vision' | 'tesseract_fallback' | 'manual';
  confidence:      number;              // 0–1
  fields:          VisionExtractedFields | null;
  error:           string | null;
  fieldConfidence?: FieldConfidenceReport | null;
  fieldStatus?:    FieldStatusReport | null;
}
```

### Edge Function
**File:** `supabase/functions/extract-business-card/index.ts`

Accepts multipart form data, JSON with base64, or raw image. Calls `gpt-4o` with a structured system prompt. Retries once on failure. Returns 503 if `OPENAI_API_KEY` secret is missing — frontend falls back to Tesseract.

### Image Preprocessing
`preprocessImage(dataUrl)`:
1. Converts dataURL → blob → HTMLImageElement
2. Resizes to max 1600px maintaining aspect ratio
3. Applies sharpening kernel: `[0, -0.5, 0, -0.5, 3, -0.5, 0, -0.5, 0]`
4. Falls back to unsharpened canvas if sharpening fails
5. Returns JPEG blob at quality 0.82

### Field Confidence Model
**File:** `src/capture/types.ts`

```typescript
interface FieldConfidenceReport {
  fullName?:     number;   // 0–1
  company?:      number;
  designation?:  number;
  website?:      number;
  address?:      number;
  phoneNumbers?: number[];
  emails?:       number[];
}

interface FieldStatusReport {
  fullName?:     'extracted' | 'absent' | 'uncertain';
  company?:      'extracted' | 'absent' | 'uncertain';
  designation?:  'extracted' | 'absent' | 'uncertain';
  website?:      'extracted' | 'absent' | 'uncertain';
  address?:      'extracted' | 'absent' | 'uncertain';
  phoneNumbers?: ('extracted' | 'absent' | 'uncertain')[];
  emails?:       ('extracted' | 'absent' | 'uncertain')[];
}
```

These are model-reported (OpenAI Vision). Tesseract and QR paths do not populate them.

---

## 12. Review Engine

**File:** `src/capture/captureReviewEngine.ts`

Singleton `reviewEngine` with `evaluate(data, extractionConfidence, extractionContext): ReviewResult`.

### ReviewResult
```typescript
interface ReviewResult {
  required:                    boolean;
  reason:                      ReviewReason | null;     // first triggered, backward compat
  reasons:                     ReviewReason[];           // all triggered
  confidence:                  number | null;            // 0–100 or null
  fieldConfidenceViolations?:  FieldConfidenceViolation[];
  contactViolations?:           ContactValidationViolation[];
  fieldStatusViolations?:       FieldStatusViolation[];
}
```

### ReviewReason Enum
```
QR_NO_EXTRACTION, EXTRACTION_FAILED, LOW_CONFIDENCE, LOW_FIELD_CONFIDENCE,
INSUFFICIENT_EXTRACTION, SUSPICIOUS_CONTACT, INVALID_PHONE, INVALID_EMAIL,
INVALID_WEBSITE, UNCERTAIN_FIELD
```

### Rule Evaluation Order
1. **QR_NO_EXTRACTION** — `data.qrExtractionEmpty === true` → terminal, returns immediately
2. **EXTRACTION_FAILED** — `extraction.status === 'failed'` → terminal, returns immediately
3. **Null-confidence guard** — `extractionConfidence === null` (manual entry or skipped extraction) → returns `{ required: false }` immediately. Deterministic validation does NOT apply to manual entries.
4. **LOW_CONFIDENCE** — `extractionConfidence <= minimumConfidence` (threshold from `runtime_configuration` table, default 75)
5. **LOW_FIELD_CONFIDENCE** — any model-reported per-field confidence <= threshold
6. **INSUFFICIENT_EXTRACTION** — `countMeaningfulFields(data) <= 1`
7. **SUSPICIOUS_CONTACT** — legacy heuristic on email/phone/website
8. **INVALID_PHONE** — deterministic: Indian number rules (91 prefix → 10 digits starting 6-9), ITU-T E.164 (7-15 digits), masked/placeholder detection
9. **INVALID_EMAIL** — deterministic: exactly one @, non-empty local + domain, domain has dot, no whitespace, no masked/placeholder
10. **INVALID_WEBSITE** — deterministic: no whitespace, domain has dot, no masked/placeholder
11. **UNCERTAIN_FIELD** — model's `fieldStatus` marks any field as `'uncertain'`

Rules 4-11 are all collected (non-terminal). The result retains all triggered reasons in `reasons[]`.

### Threshold
**File:** `src/runtime/runtimeDiagnostics.ts` — `getReviewMinimumConfidence()`

Reads from `RuntimeConfiguration` in-memory cache (O(1), no DB call). Falls back to 75 when cache is not populated. The threshold is on a 0–100 scale; model confidence is 0–1, so the engine converts.

### Deterministic Validation Functions
- `validatePhone(phone, index)` — Indian number checks, E.164 compliance, masked/placeholder detection
- `validateEmail(email, index)` — structural email validation
- `validateWebsite(website)` — structural website validation
- `findContactValidationViolations(data)` — runs all three on all phone/email/website values (both array and legacy single fields), returns all violations (does not short-circuit)

### Promotion Impact
When `review.required === true`, the promotion stage passes `requiresReview: true` to `executePromotion()`, which inserts the `lead_entries` row with `lead_status: 'REQUIRES_REVIEW'` instead of `'NEW'`.

---

## 13. Promotion Service

**File:** `src/capture/capturePromotionService.ts`

### executePromotion(options: PromoteSessionOptions): Promise<PromoteSessionResult>

```typescript
interface PromoteSessionOptions {
  backendSessionId:  string;
  draftData:         DraftData;
  eventCode:         string | null;
  completedLeadId:   string;
  captureMethod:    CaptureMethod;
  eventId:          string | null;
  eventName:        string | null;
  requiresReview:   boolean;
}

interface PromoteSessionResult {
  leadId:           string | null;
  error:            string | null;
  alreadyPromoted:  boolean;
}
```

### Sequence
1. Resolves auth identity via `getAuthIdentity()`
2. **Idempotency check**: reads `capture_sessions.promoted_lead_id`. If already set → updates local `completed_leads` to `synced` and returns `{ alreadyPromoted: true }`
3. Builds phones/emails arrays from `draftData.phoneNumbers` / `draftData.emails` (falls back to `draftData.phone` / `draftData.email`)
4. Inserts `lead_entries` row:
   - `id: crypto.randomUUID()`
   - `capture_session_id: backendSessionId`
   - `lead_status: requiresReview ? 'REQUIRES_REVIEW' : 'NEW'`
   - `system_status: 'CREATED'`
   - All contact/business/qualification fields from draftData
5. Updates `capture_sessions` → `{ promoted_lead_id: leadId, session_status: 'promoted' }`
6. Updates `completed_leads` IndexedDB → `status: 'synced'`, `syncedAt: now`
7. Returns `{ leadId, error: null, alreadyPromoted: false }`

**Never throws** — catches all errors and returns `{ leadId: null, error }`.

### Critical invariant
The promotion service is the only code that inserts into `lead_entries`. Both the synchronous and ALPE paths call the same `executePromotion()`. The `requiresReview` flag is the only behavioral difference — it controls the initial `lead_status`.

---

## 14. Decision Engine

**File:** `src/alpe/decisionEngine.ts`

`decide(workerResult: WorkerResult): Decision`

### Decision
```typescript
interface Decision {
  newState:       QueueState;           // 'COMPLETED' | 'FAILED' | 'RETRYING' | 'REQUIRES_REVIEW'
  isRetryable:    boolean;
  failureReason:  string | null;
}
```

### Mapping
| WorkerResult.outcome | Decision.newState | Retryable? |
|---|---|---|
| `completed` | `COMPLETED` | No |
| `requires_review` | `REQUIRES_REVIEW` | No |
| `queued` | `COMPLETED` | No (promotion was queued for offline replay) |
| `failed` (with retryable error) | `RETRYING` | Yes |
| `failed` (non-retryable) | `FAILED` | No |

### Retryable error detection
The decision engine inspects the error message for known retryable patterns:
- "Assets not yet uploaded" → retryable (uploads may complete on next poll)
- Network errors → retryable
- Auth errors → non-retryable
- Validation failures → non-retryable

### Scheduler Application
In `scheduler.ts` tick:
```typescript
if (decision.newState === 'RETRYING' && decision.isRetryable) {
  await markRetrying(job.id, decision.failureReason);
} else {
  await updateJobState(job.id, decision.newState, { failure_reason: decision.failureReason });
}
```

---

## 15. Recovery Service

**File:** `src/alpe/recoveryService.ts`

`runRecovery(userId): Promise<RecoveryReport>`

Called by `scheduler.start()` before polling begins.

### Recovery Steps
1. **Interrupted jobs** — finds `PROCESSING` state jobs (crashed mid-flight, browser closed, etc.) → `markRecovering()` → `requeueJob()` (resets to `QUEUED`)
2. **Retryable jobs** — finds `RETRYING` state jobs → `requeueJob()` (resets to `QUEUED`)

### RecoveryReport
```typescript
interface RecoveryReport {
  interruptedRequeued:  number;
  retryableRequeued:   number;
  totalRecovered:      number;
  errors:              string[];
}
```

### Important
Recovery runs **before** the first poll. If recovery fails, the scheduler still starts — the error is captured in `recoveryReport` and `lastError`, but polling proceeds. Recovered jobs are requeued to `QUEUED` and will be claimed on subsequent polls.

---

## 16. Diagnostics & Runtime Configuration

### ALPE Diagnostics
**File:** `src/alpe/diagnostics.ts`

Functions: `alpeLog()`, `alpeError()`, `updateAlpeRuntime()`.

`updateAlpeRuntime()` merges a patch into an in-memory runtime state object and notifies subscribers. Used by the scheduler and worker to surface real-time status to the debug panel.

### Runtime Configuration
**File:** `src/runtime/runtimeConfiguration.ts`

In-memory cache of the `runtime_configuration` table. Provides O(1) access to configured values without DB calls. Currently stores:
- `review_minimum_confidence` (default 75, on 0–100 scale)

**File:** `src/runtime/runtimeDiagnostics.ts`

`getReviewMinimumConfidence()` — reads from the in-memory cache, falls back to 75.

### Asset Sync Diagnostics
**File:** `src/capture/assetSyncDiagnostics.ts`

Provides `logEvent()`, `logOperationStart()`, `logOperationEnd()`, `getCorrelationId()` for tracing sync operations. The correlation ID is threaded through all sync calls so diagnostics can trace a single capture session across multiple operations.

### ALPE Runtime Dumps
The worker writes diagnostic dumps to an `alpe_runtime_dumps` table via `supabase.from('alpe_runtime_dumps').insert(...)`. These are fire-and-forget (`.then(() => {}, () => {})`) and should not affect processing. Dump points: `TRACE:WORKER_START`, `TRACE:LOAD_SESSION`, `TRACE:LOAD_ASSETS`, `TRACE:WAIT_ASSETS`, `ASSETS_LOADED`, `HYDRATED_CONTEXT`, `TRACE:PIPELINE_START`, `TRACE:PIPELINE_COMPLETE`, `TRACE:PIPELINE_ERROR`.

---

## 17. Modification Guide

### Adding a new capture profile
1. Add union member to `CaptureProfile` in `src/capture/captureProfile.ts`
2. Add descriptor to `CAPTURE_PROFILE_DESCRIPTORS`
3. Create strategy classes in `src/capture/profileStrategies.ts` implementing all six strategy interfaces
4. Register in `PROFILE_STRATEGY_REGISTRY`
5. Add to `getProfileStrategies()` — it will throw if not registered

**Do not** modify shared services (`captureEvidenceManager`, `captureBackendSync`, `capturePromotionService`, `captureOfflineQueue`) — they are profile-agnostic and receive all behavioral decisions via policies from the `ExecutionPlan`.

### Adding a new review rule
1. Add to `ReviewReason` enum in `src/capture/captureReviewEngine.ts`
2. Add evaluation logic in `CaptureReviewEngine.evaluate()` — follow the existing pattern: push to `reasons[]`, set violation arrays
3. If the rule should be terminal (return immediately), follow the `QR_NO_EXTRACTION` pattern
4. If the rule should be collected (non-terminal), follow the `LOW_CONFIDENCE` pattern
5. Add to `countMeaningfulFields()` if it affects the `INSUFFICIENT_EXTRACTION` rule

### Adding a new pipeline stage
1. Add the stage function in `src/alpe/pipeline.ts`
2. Add it to the `processCaptureSession()` sequence
3. If the stage can fail, set `ctx.result = { outcome: 'failed', error }` and return early
4. Add `ctx` fields needed by the stage to the `ProcessingContext` interface
5. If the worker needs to populate those fields, update `processJob()` in `src/alpe/worker.ts`

### Modifying extraction
1. Modify `extractBusinessCard()` or `extractQr()` in `src/alpe/extractionService.ts`
2. If you change the return shape, update `ExtractionOutcome` and all consumers (pipeline stage 3, extraction metadata persistence)
3. If you add new model-reported fields, update `VisionExtractedFields`, `FieldConfidenceReport`, and `FieldStatusReport` in `src/capture/types.ts`
4. If you add new confidence fields, update the review engine's `SCALAR_FIELD_MAP` or array-field handling in `findFieldConfidenceViolations()`
5. If you change the edge function contract, update `supabase/functions/extract-business-card/index.ts` and the `EdgeResponse` interface

### Modifying promotion
1. Modify `executePromotion()` in `src/capture/capturePromotionService.ts`
2. If you change `PromoteSessionOptions`, update `PromotionStrategy.buildOptions()` in both CRM and Exhibition strategy classes
3. If you add new `lead_entries` columns, add a migration and update the insert in `executePromotion()`
4. If you change the `lead_status` values, update `LeadDetailPage.tsx` `LEAD_STATUS_OPTIONS` and `leads_list_view`

### Modifying the queue state machine
1. Add the new state to `QueueState` in `src/alpe/types.ts`
2. Add transition logic in `processingQueueRepository.ts` (`updateJobState`, `markRetrying`, etc.)
3. Update `decide()` in `src/alpe/decisionEngine.ts` to map worker results to the new state
4. Update `scheduler.ts` tick to handle the new state
5. Update `recoveryService.ts` if the new state requires recovery handling

### Modifying offline behavior
1. Add new op type to `captureOfflineQueue.ts` `executeOp()` switch
2. Add the corresponding sync function in `captureBackendSync.ts`
3. Wire the routing in `CaptureExecutionEngine.ts` if it should go through the execution engine
4. Update `flushQueue()` if the op needs special handling during replay

### Critical invariants to preserve
1. **Sync IDs are frontend-generated** — all upserts use `crypto.randomUUID()`. Never use backend-generated IDs.
2. **No sync operation blocks the UI** — all sync calls are fire-and-forget. The only exception is `produceProcessingJob()` which awaits the initial session upsert (FK constraint).
3. **The promotion service never throws** — it catches all errors and returns `{ error }`.
4. **The review engine's null-confidence guard** — when `extractionConfidence === null`, deterministic validation does NOT apply. This is the manual-entry path.
5. **`originalCaptureMethod` is immutable** — set once at session creation, never overwritten. Used for backend attribution.
6. **The worker is idempotent** — if `promoted_lead_id` is already set, it returns `completed` without re-processing.
7. **Recovery runs before polling** — the scheduler's `start()` awaits `runRecovery()` before scheduling the first poll.
8. **Evidence manager does not clear `_uploadTrackers` on session reset** — `produceProcessingJob()` may still need to await them.
9. **Migrations use `IF EXISTS` / `IF NOT EXISTS` guards** — never assume a column or table doesn't exist.
10. **`leads_list_view` must stay aligned with the `Lead` interface in `LeadsPage.tsx`** — if you add columns to the view, add them to the interface and the `countActiveAdvanced` / `buildParams` / `readParams` functions.
