# Queue Implementation — Technical Handoff

Complete lifecycle trace from capture submission through the Queue UI, covering every file, function, state transition, and current gap. This is a descriptive document — it does not propose redesigns.

---

## 1. Entry Point: Save & Next

**File:** `src/CaptureLeadPage.tsx`

When the rep presses "Save & Next", the capture session hook (`useCaptureSession`) calls one of two paths depending on the `USE_ALPE_PROCESSING` feature flag (`src/alpe/featureFlag.ts`):

### Path A — ALPE Processing (current default path)
1. `useCaptureSession` calls `produceProcessingJob()` from `src/alpe/jobProducer.ts`.
2. `produceProcessingJob()` does, in order:
   - Resolves auth identity via `getAuthIdentity()` (`src/capture/captureAuth.ts`) → `{ userId, repCode }`.
   - Calls `syncUpsertSession()` (`src/capture/captureBackendSync.ts`) with `sessionStatus: 'CAPTURING'` — an **awaited** upsert to guarantee the `capture_sessions` row exists before enqueue (FK constraint on `processing_queue.capture_session_id`).
   - Calls `evidenceManager.flushPendingUploads(backendSessionId)` to start any deferred (ON_SAVE) business card uploads.
   - Awaits `evidenceManager.waitForUploads(backendSessionId)` — waits for all upload promises.
   - For BUSINESS_CARD captures, calls `waitForAssetStorageReady()` (`src/capture/assetStorageUpload.ts`) to confirm `storage_path` is written to `capture_assets` rows. Returns `{ outcome: 'failed' }` if the 30s deadline expires.
   - Generates `jobId = crypto.randomUUID()`.
   - Calls `enqueueJob()` (`src/alpe/processingQueueRepository.ts`) → inserts a row into `processing_queue` with `state: 'QUEUED'`.
   - Writes a local `completed_leads` record with `status: 'pending_sync'` via `buildCompletedLead()` + `saveCompletedLead()` (`src/capture/completedLeadsStorage.ts`).
   - Returns `{ outcome: 'queued', jobId }`.

### Path B — Legacy Synchronous (feature flag off)
1. `useCaptureSession` calls `processCaptureSession()` directly from `src/alpe/pipeline.ts`.
2. The pipeline runs synchronously in the browser: evidence → extraction → validation → review → promotion.
3. Promotion calls `executePromotion()` from `src/capture/capturePromotionService.ts`.

---

## 2. IndexedDB Stores

**File:** `src/capture/db.ts` (version 3) and `src/capture/completedLeadsStorage.ts` (version 5)

Three IndexedDB stores participate in the Queue:

| Store | Key | Written by | Read by |
|---|---|---|---|
| `drafts` | `active_capture_draft` (single) or `id` (multi) | `captureDraftStorage.ts` — autosave every 700ms | `leadQueueStorage.ts` |
| `completed_leads` | `id` (= sessionId UUID) | `completedLeadsStorage.ts` — `saveCompletedLead()` | `leadQueueStorage.ts` |
| `pending_ops` | `id` (`op_<timestamp>_<rand>`) | `captureOfflineQueue.ts` — `enqueueOp()` | `captureOfflineQueue.ts` — `flushQueue()` |

The `completed_leads` store has a pub/sub layer: `subscribeCompletedLeads()` / `getCompletedLeadsVersion()` for `useSyncExternalStore` reactivity.

---

## 3. completed_leads Record Lifecycle

**File:** `src/capture/completedLeadsStorage.ts`

### Creation — `buildCompletedLead()`
```
Input:  sessionId, captureMethod, draftData, backendSessionId, eventId, eventName
Logic:  hasKey = clientName || company (trimmed, non-empty)
        status  = hasKey ? 'local_only' : 'needs_review'
Output: CompletedLead { id, status, captureMethod, draftData, backendSessionId, ... }
```

### Status Values
| Status | Meaning | Set by |
|---|---|---|
| `local_only` | Captured, sync not yet attempted | `buildCompletedLead()` |
| `pending_sync` | Sync ops queued / in-flight | `jobProducer.ts` (ALPE path) or pipeline `_queuePromotion()` |
| `syncing` | Flush in-flight | (declared but not currently set by any code path) |
| `synced` | Confirmed on backend | `capturePromotionService._updateCompletedLead()` |
| `failed` | Sync failed after retries | (declared; not currently set — see Gaps) |
| `needs_review` | Missing key fields (no clientName AND no company) | `buildCompletedLead()` |

### Updates — `updateCompletedLeadStatus()`
Mutates status + optional `{ syncedAt, retries, lastError, backendSessionId }`. Emits `notify()` to trigger Queue UI re-render.

### Deletion — `deleteCompletedLead()`
Removes the record and emits `notify()`.

---

## 4. Offline Queue (pending_ops)

**File:** `src/capture/captureOfflineQueue.ts`

### Enqueue
When `navigator.onLine === false`, sync calls from `captureBackendSync.ts` are redirected to `enqueueOp()` instead of being dropped. Each op stores `{ id, type, sessionId, createdAt, retries, payload }`.

Op types: `upsert_session`, `upsert_asset`, `upsert_ocr_extraction`, `upsert_qr_extraction`, `upsert_vision_extraction`, `update_session_fields`, `promote_session`, `upload_voice_note`, `enqueue_processing_job`.

### Flush — `flushQueue()`
Called by `useOnlineStatus` hook's `onReconnect` callback when connectivity returns.
1. Loads all ops from `pending_ops`, sorted by `createdAt` ascending.
2. For each op: calls `executeOp()` → dispatches to the matching `sync*` function in `captureBackendSync.ts` with silent callbacks.
3. On success: deletes the op from IndexedDB.
4. On auth error (`'Not authenticated'`, `'JWT'`): deletes the op (non-retryable).
5. On network/server error: increments `retries` and keeps the op in the store.
6. Guard: `flushInProgress` flag prevents concurrent flushes.

### Integration with ALPE
After `flushQueue()` completes, `CaptureLeadPage` calls `notifyAlpeReconnect()` (`src/alpe/scheduler.ts`) to trigger an immediate scheduler poll so ALPE jobs replayed from the offline queue are picked up.

---

## 5. ALPE Processing Queue (Supabase `processing_queue` table)

### Enqueue — `enqueueJob()`
**File:** `src/alpe/processingQueueRepository.ts`

Inserts a row: `{ id: jobId, capture_session_id, user_id, event_id, state: 'QUEUED', priority, processing_version, enqueued_at, scheduled_at, ... }`.

### Claim — `claimNextJob(userId)`
1. Selects highest-priority `QUEUED` job for the user, ordered by `priority DESC, enqueued_at ASC`.
2. Atomic transition `QUEUED → PROCESSING` via optimistic lock (`.eq('state', 'QUEUED')`).
3. Returns the claimed `QueueEntry` or null.

### State Machine
```
QUEUED → PROCESSING → COMPLETED
                    → REQUIRES_REVIEW
                    → RETRYING → QUEUED (requeue) or FAILED
                    → FAILED (non-retryable)
                    → RECOVERING → QUEUED (recovery)
```

**State transitions** (`updateJobState()`):
- `COMPLETED`, `FAILED`, `INVALID`, `REQUIRES_REVIEW` → sets `processing_completed_at`.
- `markRetrying()` → calls `increment_retry_count` RPC, falls back to manual update.
- `markRecovering()` → sets state to `RECOVERING`, stamps `processing_started_at`.
- `requeueJob()` → resets state to `QUEUED`, clears `processing_started_at`.

### Recovery — `recoveryService.ts`
On scheduler start, `runRecovery(userId)`:
1. Finds interrupted jobs (`PROCESSING` state — crashed mid-flight) → `markRecovering()` → `requeueJob()`.
2. Finds retryable jobs (`RETRYING` state) → `requeueJob()`.

---

## 6. Scheduler

**File:** `src/alpe/scheduler.ts`

Singleton `AlpeScheduler` with:
- `start(userId)` — idempotent; runs recovery, then begins polling.
- `stop()` — graceful; waits for in-flight tick (max 10s).
- `notifyReconnect()` — triggers immediate tick when connectivity returns.
- `notifyOffline()` — suppresses polling while offline.

**Polling tick:**
1. Calls `claimNextJob(userId)`.
2. If no job: returns.
3. If job claimed: calls `processJob(job)` from `src/alpe/worker.ts`.
4. Feeds `WorkerResult` to `decide()` from `src/alpe/decisionEngine.ts`.
5. Applies decision: `markRetrying()` for retryable failures, `updateJobState()` for terminal states.
6. Increments `jobsProcessed` on `COMPLETED` or `REQUIRES_REVIEW`.

**Poll interval:** 5000ms. Skips when offline.

---

## 7. Worker

**File:** `src/alpe/worker.ts`

`processJob(job)`:
1. Fetches `capture_sessions` row by `job.capture_session_id`.
2. If `promoted_lead_id` is already set → returns `{ outcome: 'completed' }` (idempotent).
3. Fetches all `capture_assets` rows for the session.
4. If extractable assets exist (business_card, qr): polls `waitForAssetsUploaded()` up to 30s. If timeout → returns `{ outcome: 'failed', error: 'Assets not yet uploaded' }` (retryable).
5. Builds `EvidenceAssets` from asset rows via `buildEvidence()`.
6. Reconstructs `DraftData` from the session row's `extracted_fields` + enrichment columns.
7. Resolves event info (event_code, name) from `events` table.
8. Builds an `ExecutionPlan` via `executionEngine.buildPlan()` (`src/capture/CaptureExecutionEngine.ts`).
9. Constructs `ProcessingContext` and calls `processCaptureSession(ctx)`.

---

## 8. Pipeline Stages

**File:** `src/alpe/pipeline.ts`

`processCaptureSession(ctx)` runs stages in order:

### Stage 1: Evidence Upload (`executeEvidenceStage`)
- Registers notes image with `evidenceManager` if present.
- Calls `evidenceManager.onSaveAndNext()`.

### Stage 2: Evidence Resolution (`executeEvidenceResolutionStage`)
- Calls `resolveAllEvidence(ctx.evidence)` from `src/alpe/evidenceResolver.ts`.
- Resolves storage paths to URLs/blobs for each evidence type.

### Stage 3: AI Extraction (`executeExtractionStage`)
- Calls `extractBusinessCard()` or `extractQr()` from `src/alpe/extractionService.ts`.
- Merges extracted fields into `ctx.session.draftData` (does not overwrite manually-set fields).
- Sets `ctx.extractionSource`, `ctx.extractionConfidence`, `ctx.fieldConfidence`, `ctx.fieldStatus`.

### Stage 4: Persist Extraction Metadata (`executeExtractionMetadataStage`)
- Calls `persistExtractionMetadata()` from `src/alpe/extractionMetadataPersistence.ts`.
- Writes `extraction_source`, `extraction_status`, `extraction_confidence` to `capture_sessions`.

### Stage 5: Validation (`executeValidationStage`)
- Calls `strategies.validation.validate(draftData)`.
- If invalid: sets `ctx.result = { outcome: 'failed', error }` and returns early.

### Stage 6: Review (`executeReviewStage`)
- If `plan.review === 'SKIP'`: sets `ctx.review = { required: false }`.
- Otherwise: calls `strategies.review.evaluate(draftData, confidencePercent, extractionContext)`.
- The review engine is `captureReviewEngine.ts` (see Section 9).
- Persists review result via `persistReviewResult()`.

### Stage 7: Promotion (`executePromotionStage`)
- If `plan.promotion === 'SKIP'`: sets `ctx.result = { outcome: 'queued' }`.
- Builds promotion options via `strategies.promotion.buildOptions()`, passing `requiresReview: ctx.review?.required ?? false`.
- Calls `executionEngine.routePromotion(plan.queue, isOnline, ...)`.
- If queued (offline): writes `completed_leads` with `status: 'pending_sync'` and enqueues offline op.
- If success: sets `ctx.result = { outcome: 'success', leadId }`.
- If error and non-retryable: sets `ctx.result = { outcome: 'failed', error }`.
- If error and retryable: queues promotion for offline replay.

---

## 9. Review Engine

**File:** `src/capture/captureReviewEngine.ts`

Singleton `reviewEngine` with `evaluate(data, extractionConfidence, extractionContext)`.

### Rule Evaluation Order
1. **QR_NO_EXTRACTION** — `data.qrExtractionEmpty` is true → terminal, returns immediately.
2. **EXTRACTION_FAILED** — `extraction.status === 'failed'` → terminal.
3. **Null-confidence guard** — `extractionConfidence === null` (manual entry or skipped extraction) → returns `{ required: false }` immediately. Deterministic validation does NOT apply to manual entries.
4. **LOW_CONFIDENCE** — `extractionConfidence <= minimumConfidence` (from `runtime_configuration` table, default 75).
5. **LOW_FIELD_CONFIDENCE** — any model-reported per-field confidence <= threshold.
6. **INSUFFICIENT_EXTRACTION** — `countMeaningfulFields(data) <= 1`.
7. **SUSPICIOUS_CONTACT** — legacy heuristic on email/phone/website.
8. **INVALID_PHONE** — deterministic phone validation (Indian number rules, ITU-T E.164).
9. **INVALID_EMAIL** — deterministic email validation (exactly one @, domain has dot, no whitespace).
10. **INVALID_WEBSITE** — deterministic website validation.
11. **UNCERTAIN_FIELD** — model's `fieldStatus` marks a field as 'uncertain'.

All triggered reasons are collected in `ReviewResult.reasons[]`. The `reason` field holds the first for backward compatibility.

### Output
`ReviewResult` includes: `required`, `reason`, `reasons[]`, `confidence`, `fieldConfidenceViolations[]`, `contactViolations[]`, `fieldStatusViolations[]`.

### Persistence
`persistReviewResult()` in `src/alpe/extractionMetadataPersistence.ts` writes the review result to `capture_sessions` (review metadata columns).

### Promotion Impact
When `review.required === true`, `executePromotionStage` passes `requiresReview: true` to `buildOptions()`, which causes `executePromotion()` to insert the `lead_entries` row with `lead_status: 'REQUIRES_REVIEW'` instead of `'NEW'`.

The ALPE decision engine (`src/alpe/decisionEngine.ts`) maps `outcome: 'requires_review'` → `state: 'REQUIRES_REVIEW'` on the `processing_queue` row (non-retryable, terminal).

---

## 10. Promotion Service

**File:** `src/capture/capturePromotionService.ts`

`executePromotion(options)`:
1. Resolves auth identity.
2. Idempotency check: reads `capture_sessions.promoted_lead_id`. If already set → updates local `completed_leads` to `synced` and returns `{ alreadyPromoted: true }`.
3. Builds phones/emails arrays from draftData.
4. Inserts `lead_entries` row with:
   - `id: crypto.randomUUID()`
   - `capture_session_id: backendSessionId`
   - `lead_status: requiresReview ? 'REQUIRES_REVIEW' : 'NEW'`
   - `system_status: 'CREATED'`
   - All contact/business/qualification fields from draftData.
5. Updates `capture_sessions` → `{ promoted_lead_id: leadId, session_status: 'promoted' }`.
6. Updates `completed_leads` IndexedDB → `status: 'synced'`, `syncedAt: now`.
7. Returns `{ leadId, error: null, alreadyPromoted: false }`.

Never throws — catches all errors and returns `{ error }`.

---

## 11. Queue UI

**File:** `src/LeadQueuePage.tsx`

### Data Loading
`loadQueueItems()` from `src/capture/leadQueueStorage.ts` aggregates from three sources in parallel:
1. **Saved drafts** — `loadAllSavedDrafts()` from `captureDraftStorage.ts` → `source: 'saved_draft'`, `status: 'draft'`.
2. **Active recovery draft** — `dbGet('drafts', 'active_capture_draft')` → `source: 'draft'`, `status: 'draft'`. Suppressed if a `completed_leads` entry already exists for the same `backendSessionId`.
3. **Completed leads** — `loadCompletedLeads()` → `source: 'completed'`, `status: mapStatus(c.status)`.

Items are deduplicated by `id` and sorted by `updatedAt` descending.

### Reactivity
Uses `useSyncExternalStore` subscribing to:
- `subscribeCompletedLeads` / `getCompletedLeadsVersion` — fires on any `completed_leads` write.
- A similar version counter for saved drafts.
Also polls `loadQueueItems()` on a 3-second interval as a fallback.

### Filter Tabs
`all | pending | failed | drafts | synced`
- `pending` → statuses `local_only`, `pending_sync`, `syncing`
- `failed` → status `failed`
- `drafts` → status `draft`
- `synced` → status `synced`

### QueueItem Display
Each card shows:
- Display name (`getDisplayName()`): clientName → company → 'Unnamed Lead'.
- Company (if both name and company exist).
- Capture method icon.
- Status badge with color.
- Timestamps (created, synced, last error).
- Expand/collapse for details.

### Card Actions
| Source | Actions |
|---|---|
| `draft` (active) | Continue (navigates to capture page) |
| `saved_draft` | Continue, Delete |
| `completed` (failed) | Retry |
| `completed` (synced) | View Lead (navigates to lead detail via `backendSessionId`) |
| Any | Details (expand), Delete |

### `onViewLead(backendSessionId)`
Calls `onViewLead` prop → `App.tsx` sets `?lead=<id>` URL param → `LeadDetailPage` loads the lead by ID from `lead_entries`.

### Debug Panel
Toggleable panel showing ALPE runtime diagnostics: scheduler status, poll count, current job, pipeline stage, worker state, queue state.

---

## 12. Lead Detail Page

**File:** `src/LeadDetailPage.tsx`

Fetches from `lead_entries` by ID. Displays:
- Contact info (name, company, designation, phones, emails, address, website).
- Business details (lead temperature, type, applications, keywords, etc.).
- Sales info (rep code, event, previous rep).
- Lead status dropdown: `NEW | CONTACTED | QUALIFIED | CONVERTED | LOST`.
- Notes system (add/list notes).
- Follow-ups system (create/complete follow-ups).
- Evidence section (`LeadEvidenceSection`).
- WhatsApp status card.

---

## 13. Current Gaps

### Gap 1: `REQUIRES_REVIEW` not in Lead Detail UI
`LeadDetailPage.tsx` `LEAD_STATUS_OPTIONS` does not include `REQUIRES_REVIEW`. The status dropdown shows only `NEW, CONTACTED, QUALIFIED, CONVERTED, LOST`. If a lead was promoted with `REQUIRES_REVIEW`, it:
- Is stored correctly in the database.
- Is returned by `leads_list_view`.
- But the detail page dropdown has no option for it, no review banner, no "Mark as Reviewed" button, and no display of `review_metadata` (review reasons, confidence violations, contact violations).

### Gap 2: `completed_leads` status `failed` is never set
`buildCompletedLead()` sets `local_only` or `needs_review`. `jobProducer.ts` sets `pending_sync`. `_updateCompletedLead()` sets `synced`. No code path sets `failed`. The Queue UI has a "failed" filter tab and Retry button, but no completed lead ever reaches `failed` status through the current flow.

### Gap 3: `completed_leads` status `syncing` is never set
Declared in the type but no code path assigns it.

### Gap 4: Queue does not reflect `processing_queue` state
The Queue UI reads only from IndexedDB (`completed_leads`). It does not query `processing_queue` for the current backend state. A job in `PROCESSING` or `RETRYING` state on the backend still shows as `pending_sync` locally until promotion succeeds (→ `synced`) or the user manually retries.

### Gap 5: No feedback path from ALPE completion to `completed_leads`
When the scheduler's worker successfully promotes a lead (`outcome: 'completed'`), `executePromotion()` updates `completed_leads` to `synced`. But when the worker returns `requires_review`, the `processing_queue` row transitions to `REQUIRES_REVIEW` — the local `completed_leads` record remains `pending_sync`. There is no callback or polling mechanism to update the local record to reflect the review-required state.

### Gap 6: `needs_review` status in completed_leads is a dead end
`buildCompletedLead()` sets `needs_review` when there is no clientName and no company. But nothing in the pipeline or UI transitions this status — there is no "edit and resubmit" flow from the Queue for `needs_review` items.

### Gap 7: No promotion from capture session to lead_entries in the UI
The CLAUDE.md notes: "Capture sessions are not yet automatically promoted to `lead_entries` — that step is not yet implemented in the UI." The ALPE pipeline handles promotion automatically when the feature flag is on, but the non-ALPE path does not have a UI-triggered promotion step.

### Gap 8: `QueueItemDetailSheet` exists but is not wired
`src/capture/QueueItemDetailSheet.tsx` exists as a component file but `LeadQueuePage.tsx` uses its own inline expand/collapse for card details rather than importing this component.

### Gap 9: Review metadata not surfaced in Queue
The `ReviewResult` (reasons, field confidence violations, contact violations) is persisted to `capture_sessions` but never displayed in the Queue UI. A `needs_review` or `REQUIRES_REVIEW` item shows no explanation of why review was triggered.

### Gap 10: No retry path from Queue for ALPE-processed leads
The Queue's Retry button is wired for the legacy offline-queue path (re-calling `flushQueue()`). For ALPE-processed leads, a failed job sits in `processing_queue` with state `RETRYING` or `FAILED`. The Queue UI has no mechanism to trigger `requeueJob()` or `markRecovering()` for these backend jobs.
