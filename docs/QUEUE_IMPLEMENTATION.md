# Queue Implementation

> **Current implementation reference.** This document describes the three queue
> systems in the application as they exist today. Source files are cited
> throughout. For the ALPE processing pipeline, see also
> `docs/CAPTURE_ALPE_ARCHITECTURE.md`.

---

## Table of Contents

1. [Overview](#1-overview)
2. [Queue 1 — Offline Sync Queue (IndexedDB)](#2-queue-1--offline-sync-queue-indexeddb)
3. [Queue 2 — Processing Queue (Supabase)](#3-queue-2--processing-queue-supabase)
4. [Queue 3 — Lead Queue (Aggregation)](#4-queue-3--lead-queue-aggregation)
5. [How the Queues Interact](#5-how-the-queues-interact)
6. [Concurrency and Locking](#6-concurrency-and-locking)
7. [Error Handling and Retry Semantics](#7-error-handling-and-retry-semantics)
8. [Data Flow Diagrams](#8-data-flow-diagrams)
9. [Database Objects](#9-database-objects)
10. [Module Reference](#10-module-reference)

---

## 1. Overview

The application has three distinct queue systems, each serving a different
purpose and operating at a different layer:

| Queue | Storage | Purpose | Scope |
|-------|---------|---------|-------|
| Offline Sync Queue | IndexedDB (`pending_ops` store) | Buffers backend write operations when the device is offline; replays them on reconnect | Per-device |
| Processing Queue | Supabase (`processing_queue` table) | Tracks ALPE processing jobs through their lifecycle (QUEUED → PROCESSING → terminal) | Per-user (server-side) |
| Lead Queue | IndexedDB (read-only aggregation) | Unifies drafts, saved drafts, and completed leads into a single list for the Queue page UI | Per-user |

**Key distinction:** The offline sync queue and processing queue are
independent systems. The offline sync queue handles *transport-level* buffering
(any Supabase write that fails due to no network). The processing queue handles
*domain-level* job lifecycle (an ALPE job moves through processing stages). They
can interact — an `enqueue_processing_job` op can be queued offline — but they
are not the same queue.

---

## 2. Queue 1 — Offline Sync Queue (IndexedDB)

**Source:** `src/capture/captureOfflineQueue.ts`
**IndexedDB store:** `pending_ops` (in `capture_app` database, version 8)

### 2.1 Purpose

When a sales rep captures a lead while offline, every backend write operation
that would normally fire immediately is instead enqueued to IndexedDB. On
reconnect, all queued operations are replayed in creation order. Each operation
is idempotent (upserts with stable frontend-generated UUIDs), so replaying is
safe even if some ops partially succeeded before the connection dropped.

### 2.2 Op Types

11 operation types are defined in `PendingOpType`:

| Op Type | Handler | Description |
|---------|---------|-------------|
| `upsert_session` | `syncUpsertSession` | Create/update the `capture_sessions` row |
| `upsert_asset` | `syncUpsertAsset` | Create/update a `capture_assets` metadata row |
| `upsert_ocr_extraction` | `syncUpsertOcrExtraction` | Write Tesseract OCR results to `extraction_results` |
| `upsert_qr_extraction` | `syncUpsertQrExtraction` | Write QR parse results to `extraction_results` |
| `upsert_vision_extraction` | `syncUpsertVisionExtraction` | Write OpenAI Vision results to `extraction_results` |
| `update_session_fields` | `syncUpdateSessionFields` | Update enriched fields on `capture_sessions` |
| `promote_session` | `syncPromoteSession` | Promote a capture session to a `lead_entries` row |
| `upload_voice_note` | `executeVoiceNoteUploadOp` | Upload audio blob to Storage and chain transcription |
| `upload_notes_image` | `uploadNotesImage` | Upload a notes image to Supabase Storage |
| `upload_business_card` | `uploadBusinessCardAsset` | Upload a business card image to Supabase Storage |
| `enqueue_processing_job` | `produceProcessingJob` (dynamic import) | Enqueue an ALPE job to `processing_queue` (offline fallback) |

### 2.3 PendingOp Structure

Each queued op is stored as a `PendingOp` record:

```typescript
interface PendingOp {
  id:        string;        // "op_{timestamp}_{random}" — stable op ID
  ownerId:   string | null; // auth UID of the rep who queued this op
  type:      PendingOpType;
  sessionId: string;        // for grouping/filtering by capture session
  createdAt: string;        // ISO timestamp — ops flush in this order
  retries:   number;        // incremented on network errors
  payload:   unknown;       // op-specific data (typed at execution time)
}
```

### 2.4 Enqueue

`enqueueOp(type, sessionId, payload, ownerId?)` creates a `PendingOp` with a
unique ID and writes it to the `pending_ops` IndexedDB store. The caller does
not await this operation from the UI thread — it is fire-and-forget.

**Call sites:** The capture page (`CaptureLeadPage.tsx`) and the capture event
handlers (`captureEventHandlers.ts`) check `navigator.onLine` before each sync
call. If online, the sync function fires immediately. If offline,
`enqueueOp(...)` is called instead.

### 2.5 Flush

`flushQueue(ownerId?, onProgress?)` is triggered when connectivity returns
(via `useOnlineStatus` → `onReconnect`). It:

1. Acquires a per-owner flush lock (see [Concurrency](#6-concurrency-and-locking)).
2. Loads all ops from the `pending_ops` store.
3. Filters by `ownerId` if provided.
4. Sorts by `createdAt` (ISO string comparison — earliest first).
5. Iterates ops in order:
   - If `navigator.onLine` becomes false during flush, stops immediately.
   - Calls `executeOp(op)` which dispatches to the appropriate sync handler.
   - On success: deletes the op from the store, increments `flushed`.
   - On auth error (message contains "Not authenticated" or "JWT"): deletes the op (non-retryable).
   - On network/server error: increments `op.retries`, writes the updated op back, continues to the next op.
6. Returns `{ flushed, remaining }`.

**Progress callback:** `onProgress(flushed, total)` is called after each
successful op, allowing the UI to show a progress indicator.

### 2.6 Offline Detection

`useOnlineStatus` (in `src/capture/useOnlineStatus.ts`) wraps the browser's
`online`/`offline` events. On the `online` event, it calls `onReconnect()` which
triggers `flushQueue()`. The hook returns `isOnline: boolean` for conditional
rendering (e.g., the `OfflineBanner` component).

### 2.7 Queue Size

`getPendingCount(ownerId?)` returns the number of ops in the store, optionally
filtered by owner. Used by the UI to display a pending-ops badge.

---

## 3. Queue 2 — Processing Queue (Supabase)

**Source:** `src/alpe/processingQueueRepository.ts`
**Supabase table:** `processing_queue`

### 3.1 Purpose

The processing queue is the server-side job queue for the Autonomous Lead
Processing Engine (ALPE). When a capture session is submitted, an ALPE job is
enqueued to this table. A browser-resident scheduler polls the table, claims
jobs, processes them through the pipeline, and updates their state.

### 3.2 QueueEntry Fields

The `QueueEntry` type (defined in `src/alpe/types.ts`) maps to the
`processing_queue` table columns:

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | Job UUID (frontend-generated) |
| `capture_session_id` | `string` | FK to `capture_sessions.id` |
| `user_id` | `string` | Auth UID of the rep |
| `event_id` | `string \| null` | FK to `events.id` |
| `state` | `ProcessingState` | Current job state (see below) |
| `priority` | `number` | Higher = claimed first (default 0) |
| `processing_version` | `number` | Pipeline version (default 1) |
| `enqueued_at` | `string` | ISO timestamp when job was enqueued |
| `scheduled_at` | `string \| null` | Optional scheduled execution time |
| `processing_started_at` | `string \| null` | When the job was last claimed |
| `processing_completed_at` | `string \| null` | When the job reached a terminal state |
| `last_attempt_at` | `string \| null` | Timestamp of the most recent attempt |
| `failed_at` | `string \| null` | When the job was marked FAILED |
| `failure_reason` | `string \| null` | Human-readable failure reason |
| `failed_stage` | `string \| null` | Pipeline stage where failure occurred |
| `error_code` | `string \| null` | Machine-readable error code |
| `error_message` | `string \| null` | Detailed error message |
| `retry_count` | `number` | Number of retries (incremented by `markRetrying`) |
| `recovery_count` | `number` | Number of recovery attempts |
| `metadata` | `Record<string, unknown>` | Arbitrary job metadata (correlation IDs, etc.) |
| `updated_at` | `string` | Last update timestamp |

**Retry limit:** `MAX_RETRY_COUNT = 3` (constant in `types.ts`). There is no
per-row `max_retries` column.

### 3.3 Processing States

Eight states are defined in `ProcessingState`:

```
QUEUED → PROCESSING → COMPLETED      (success)
                    → REQUIRES_REVIEW (success, but needs human review)
                    → RETRYING        (retryable failure)
                    → FAILED          (non-retryable or exhausted retries)

RETRYING → QUEUED    (requeueJob — ready for next attempt)
RECOVERING → QUEUED   (recovery on scheduler start)
```

**`INVALID` is defined in the type but never emitted by the decision engine.**
It exists as a placeholder for future classification logic.

### 3.4 Enqueue

`enqueueJob(input: EnqueueJobInput)` inserts a new row with `state: 'QUEUED'`
and returns `{ success, jobId, error, queued }`. The job ID is a stable
frontend-generated UUID, making the insert idempotent.

**Call site:** `produceProcessingJob()` in `src/alpe/jobProducer.ts` is the
primary caller. If the enqueue fails due to being offline, the
`enqueue_processing_job` op type in the offline sync queue buffers the request
for later replay.

### 3.5 Claim

`claimNextJob(userId)` atomically transitions a job from `QUEUED` or `RETRYING`
to `PROCESSING`:

1. Fetches all `QUEUED` and `RETRYING` jobs for the user, ordered by
   `priority DESC, enqueued_at ASC`.
2. Filters out exhausted `RETRYING` jobs (`retry_count >= MAX_RETRY_COUNT`).
3. Selects the first eligible job.
4. Performs an optimistic-lock update: `.eq('id', job.id).in('state',
   ['QUEUED', 'RETRYING'])` — if another scheduler claimed the job between the
   fetch and the update, the lock fails and `null` is returned.
5. Stamps `processing_started_at` and `last_attempt_at`.
6. Returns the claimed `QueueEntry` or `null`.

### 3.6 State Transitions

| Function | Transition | Notes |
|----------|------------|-------|
| `enqueueJob` | (none) → `QUEUED` | Initial insert |
| `claimNextJob` | `QUEUED`/`RETRYING` → `PROCESSING` | Atomic optimistic lock |
| `updateJobState` | any → any | General-purpose; stamps `processing_completed_at` for terminal states, `failed_at` for `FAILED` |
| `markRetrying` | `PROCESSING` → `RETRYING` | Calls `increment_retry_count` RPC; falls back to manual update |
| `markRecovering` | `PROCESSING` → `RECOVERING` | Stamps `processing_started_at` |
| `requeueJob` | `RECOVERING`/`RETRYING` → `QUEUED` | Resets `processing_started_at`; does **not** increment `retry_count` |

### 3.7 Recovery Queries

| Function | Purpose |
|----------|---------|
| `findInterruptedJobs(userId)` | Finds jobs stuck in `PROCESSING` (crash/refresh during processing) |
| `findRetryableJobs(userId)` | Finds `RETRYING` jobs within retry limit (`retry_count < MAX_RETRY_COUNT`) |
| `findCompletedJobs(userId)` | Finds terminal jobs (`COMPLETED`/`REQUIRES_REVIEW`) for reconciliation |
| `findJobBySession(captureSessionId)` | Looks up a job by its capture session |

### 3.8 Scheduler Integration

The scheduler (`src/alpe/scheduler.ts`) runs a periodic tick that:

1. **Local cleanup** (throttled, 5-minute interval): calls
   `cleanupOldSyncedCompletedLeads` to remove synced `completed_leads` records
   older than 3 days.
2. **Reconciliation**: calls `reconcileCompletedLeads(userId)` every tick to
   sync local `completed_leads` records with terminal `processing_queue` rows.
3. **Claim**: `claimNextJob(userId)` — claims the next eligible job.
4. **Process**: runs the job through the ALPE pipeline.
5. **Decide**: the decision engine determines the new state.
6. **Apply**: updates the job state in `processing_queue`.
7. **Update local**: updates `completed_leads` in IndexedDB with the outcome
   (`synced` on `COMPLETED`/`REQUIRES_REVIEW`, `failed` on `RETRYING`/`FAILED`).

### 3.9 Auto-Deletion

A database trigger (migration `20260807212855_auto_delete_completed_queue_entries.sql`)
automatically deletes `processing_queue` rows that reach a terminal state
(`COMPLETED` or `REQUIRES_REVIEW`). This means `findCompletedJobs` may return
fewer results over time. The reconciliation pass handles this by falling back to
`capture_sessions.promoted_lead_id` when the queue row has been auto-deleted.

---

## 4. Queue 3 — Lead Queue (Aggregation)

**Source:** `src/capture/leadQueueStorage.ts`
**IndexedDB stores read:** `drafts`, `completed_leads`

### 4.1 Purpose

The lead queue is not a separate store — it is a read-only aggregation layer
that unifies three data sources into a single `QueueItem[]` list for the
`LeadQueuePage` UI:

1. **Saved drafts** — explicitly saved by the user (multiple, keys
   `saved_draft:*` in the `drafts` store)
2. **Active recovery draft** — the single in-progress capture draft (key
   `active_capture_draft` in the `drafts` store)
3. **Completed leads** — every lead saved via "Save & Next", card completion, or
   QR scan (in the `completed_leads` store)

### 4.2 QueueItem

```typescript
interface QueueItem {
  id:               string;
  status:           QueueItemStatus;
  captureMethod:    CaptureMethod | null;
  draftData:        DraftData;
  backendSessionId: string | null;
  eventId:          string | null;
  eventName:        string | null;
  createdAt:        string;
  updatedAt:        string;
  syncedAt:         string | null;
  retries:          number;
  lastError:        string | null;
  source:           'draft' | 'saved_draft' | 'completed';
  isSavedDraft?:    boolean;
  failedStage:      string | null;
  lastAttemptAt:   string | null;
  failedAt:        string | null;
  isExhausted:     boolean;
}
```

### 4.3 QueueItemStatus

```
draft → local_only → pending_sync → syncing → synced
                    → failed
                    → needs_review
```

- `draft` — active capture draft, not yet submitted
- `local_only` — saved locally, sync not yet attempted
- `pending_sync` — sync ops queued or in-flight
- `syncing` — explicitly marked syncing
- `synced` — confirmed on backend
- `failed` — sync failed
- `needs_review` — missing key fields (no client name or company)

### 4.4 Loading

`loadQueueItems(ownerId?)` runs three reads in parallel:

- `dbGet('drafts', 'active_capture_draft')` — the recovery draft
- `loadCompletedLeads(ownerId)` — all completed leads for this owner
- `loadAllSavedDrafts(ownerId)` — all explicitly saved drafts for this owner

Results are merged, deduplicated by ID (a draft and a completed lead can share
the same `backendSessionId`), and sorted newest-first by `updatedAt`.

### 4.5 Ownership Filtering

All three data sources support owner-scoped reads. The `ownerId` parameter (the
authenticated user's auth UID) ensures a rep only sees their own drafts and
completed leads. The `by_owner` index on `completed_leads` enables efficient
filtering without loading all records.

### 4.6 Delete

`deleteQueueItem(id, ownerId?)` handles deletion from the correct store:
- If `id` starts with `saved_draft:`, calls `deleteSavedDraft`.
- Otherwise, deletes from `completed_leads` (with ownership check).
- Also clears the active recovery draft if its `backendSessionId` matches.

### 4.7 Counts

`getQueueCounts(ownerId?)` loads all queue items and returns a count per status,
used by the dashboard to display queue status tiles.

---

## 5. How the Queues Interact

```
Rep captures a lead (offline)
  │
  ├── sync calls → enqueueOp() → pending_ops (IndexedDB)
  │                                        │
  │                                        └── on reconnect → flushQueue()
  │                                              │
  │                                              ├── upsert_session → Supabase
  │                                              ├── upsert_asset → Supabase
  │                                              ├── upload_business_card → Storage
  │                                              ├── promote_session → Supabase
  │                                              └── enqueue_processing_job → processing_queue
  │                                                                         │
  │                                                                         └── scheduler claims
  │                                                                              │
  │                                                                              ├── pipeline stages
  │                                                                              │
  │                                                                              └── decision engine
  │                                                                                   │
  │                                                                                   ├── COMPLETED
  │                                                                                   │     → completed_leads.status = 'synced'
  │                                                                                   ├── REQUIRES_REVIEW
  │                                                                                   │     → completed_leads.status = 'synced'
  │                                                                                   ├── RETRYING
  │                                                                                   │     → completed_leads.status = 'failed'
  │                                                                                   │     → requeueJob() → QUEUED (next tick)
  │                                                                                   └── FAILED
  │                                                                                         → completed_leads.status = 'failed'
  │
  └── Save & Next → buildCompletedLead() → completed_leads (IndexedDB)
                                              │
                                              └── LeadQueuePage reads via loadQueueItems()
```

### Offline capture with ALPE enabled

1. Rep captures a lead offline. All sync ops go to `pending_ops`.
2. Rep taps "Save & Next". A `completed_leads` record is written with
   `status: 'local_only'` or `pending_sync`.
3. On reconnect, `flushQueue()` replays all ops in order:
   - Session/asset/extraction upserts fire first (they were enqueued first).
   - `enqueue_processing_job` fires, inserting a row into `processing_queue`.
4. The ALPE scheduler picks up the job on its next tick, processes it through
   the pipeline, and updates `completed_leads` with the terminal outcome.

### Online capture with ALPE enabled

1. Rep captures a lead online. Sync ops fire immediately (fire-and-forget).
2. Rep taps "Save & Next". `produceProcessingJob()` enqueues to
   `processing_queue` directly. A `completed_leads` record is written with
   `status: 'pending_sync'`.
3. The scheduler claims the job, processes it, and updates `completed_leads`.

---

## 6. Concurrency and Locking

### Offline Sync Queue — Per-Owner Flush Locks

`flushQueue` uses a `Map<string, boolean>` of per-owner locks:

- Same owner's flushes are serialized (prevents duplicate replay).
- Different owners can flush concurrently.
- The unscoped path (no `ownerId`) uses a `__unscoped__` key.
- If a flush is already in progress for the same owner, the call returns
  `{ flushed: 0, remaining: 0 }` immediately.

### Processing Queue — Optimistic Locking

`claimNextJob` uses an optimistic-lock pattern:

1. Fetch eligible candidates (QUEUED + non-exhausted RETRYING).
2. Select the first candidate.
3. Update with `.eq('id', job.id).in('state', ['QUEUED', 'RETRYING'])`.
4. If the row's state changed between fetch and update (another scheduler
   claimed it), the update matches zero rows and `null` is returned.

This ensures two scheduler instances (e.g., two open tabs) cannot claim the
same job.

---

## 7. Error Handling and Retry Semantics

### Offline Sync Queue

| Error type | Behavior |
|------------|----------|
| Success | Op deleted from queue |
| Auth error (message contains "Not authenticated" or "JWT") | Op deleted (non-retryable) |
| Network/server error | `op.retries` incremented, op written back to queue |
| `navigator.onLine` becomes false | Flush stops; remaining ops stay in queue |
| Unknown op type | Op deleted silently |

The queue does **not** implement exponential backoff. Retries are attempted on
the next flush cycle (next reconnect or manual flush trigger). The `retries`
counter is informational — it does not gate execution.

### Processing Queue

| Error type | Behavior |
|------------|----------|
| Retryable (network, transient server error) | `markRetrying()` → state = `RETRYING`, `retry_count` incremented via RPC |
| Non-retryable (auth, validation, permanent failure) | `updateJobState()` → state = `FAILED` |
| Retry exhausted (`retry_count >= MAX_RETRY_COUNT`) | Decision engine returns `FAILED` |

**`requeueJob`** resets state to `QUEUED` and clears `processing_started_at`
but does **not** increment `retry_count`. Retry count is incremented only by
`markRetrying` (via the `increment_retry_count` Postgres RPC).

---

## 8. Data Flow Diagrams

### Offline Capture → Sync → ALPE

```
[Rep captures offline]
       │
       ▼
 ┌─────────────┐
 │ pending_ops  │  (IndexedDB)
 │  (11 types)  │
 └──────┬──────┘
        │ on reconnect
        ▼
 ┌─────────────┐
 │  flushQueue  │  (replay in createdAt order)
 └──────┬──────┘
        │
        ├── upsert_session ──────→ capture_sessions (Supabase)
        ├── upsert_asset ────────→ capture_assets (Supabase)
        ├── upsert_*_extraction ─→ extraction_results (Supabase)
        ├── upload_business_card → Supabase Storage
        ├── upload_voice_note ───→ Supabase Storage + transcription
        ├── upload_notes_image ──→ Supabase Storage
        ├── promote_session ─────→ lead_entries (Supabase)
        └── enqueue_processing_job
                 │
                 ▼
         ┌──────────────────┐
         │ processing_queue  │  (Supabase)
         │     (QUEUED)      │
         └────────┬─────────┘
                  │ scheduler tick
                  ▼
         ┌──────────────────┐
         │   ALPE Pipeline   │
         │ (evidence →       │
         │  extraction →     │
         │  validation →     │
         │  review →         │
         │  promotion)       │
         └────────┬─────────┘
                  │
                  ▼
         ┌──────────────────┐
         │  Decision Engine  │
         └────────┬─────────┘
                  │
        ┌─────────┼──────────┐
        ▼         ▼          ▼
   COMPLETED  REQUIRES_  RETRYING/FAILED
        │      REVIEW         │
        │        │            │
        ▼        ▼            ▼
   completed_leads (IndexedDB)
   status = 'synced' / 'failed'
```

### Lead Queue Page Read Path

```
LeadQueuePage
       │
       ▼
 loadQueueItems(ownerId)
       │
       ├── dbGet('drafts', 'active_capture_draft')  → active draft
       ├── loadCompletedLeads(ownerId)              → completed leads
       └── loadAllSavedDrafts(ownerId)              → saved drafts
       │
       ▼
 merge + deduplicate + sort by updatedAt DESC
       │
       ▼
 QueueItem[] → rendered as list
```

---

## 9. Database Objects

### IndexedDB: `capture_app` (version 8)

| Store | Key | Indexes | Purpose |
|-------|-----|---------|---------|
| `pending_ops` | `id` | `by_session`, `by_created`, `by_owner` | Offline sync queue |
| `completed_leads` | `id` | `by_status`, `by_created`, `by_owner` | Local mirror of processed leads |
| `drafts` | `id` | (none) | Active capture draft + saved drafts |
| `assets` | `id` | `by_session`, `by_owner` | Business card image data URLs |
| `lead_queue` | `id` | `by_session`, `by_created` | (Legacy — populated by aggregation, not direct writes) |

### Supabase: `processing_queue`

| Column | Type | Description |
|--------|------|-------------|
| `id` | uuid PK | Job ID |
| `capture_session_id` | uuid FK | References `capture_sessions.id` |
| `user_id` | text | Auth UID |
| `event_id` | uuid FK | References `events.id` |
| `state` | text | Processing state (8 values) |
| `priority` | integer | Higher = claimed first |
| `processing_version` | integer | Pipeline version |
| `enqueued_at` | timestamptz | When enqueued |
| `scheduled_at` | timestamptz | Optional scheduled time |
| `processing_started_at` | timestamptz | Last claim time |
| `processing_completed_at` | timestamptz | Terminal state time |
| `last_attempt_at` | timestamptz | Most recent attempt |
| `failed_at` | timestamptz | When marked FAILED |
| `failure_reason` | text | Human-readable reason |
| `failed_stage` | text | Pipeline stage of failure |
| `error_code` | text | Machine-readable error code |
| `error_message` | text | Detailed error message |
| `retry_count` | integer | Number of retries |
| `recovery_count` | integer | Number of recoveries |
| `metadata` | jsonb | Arbitrary metadata |
| `updated_at` | timestamptz | Last update |

---

## 10. Module Reference

| Module | Role |
|--------|------|
| `src/capture/captureOfflineQueue.ts` | Offline sync queue: enqueue, flush, execute ops |
| `src/capture/useOnlineStatus.ts` | Browser online/offline detection with reconnect callback |
| `src/alpe/processingQueueRepository.ts` | Processing queue CRUD: enqueue, claim, state transitions, recovery queries |
| `src/alpe/scheduler.ts` | ALPE scheduler: tick loop, claim, process, decide, reconcile, cleanup |
| `src/alpe/decisionEngine.ts` | Determines next state from pipeline outcome |
| `src/alpe/recoveryService.ts` | Recovery: requeue interrupted jobs, reconcile completed leads |
| `src/alpe/jobProducer.ts` | Creates processing jobs from capture sessions |
| `src/capture/leadQueueStorage.ts` | Lead queue aggregation: load, delete, counts |
| `src/capture/completedLeadsStorage.ts` | Completed leads store: save, load, update status, cleanup |
| `src/capture/captureDraftStorage.ts` | Drafts store: save, load, clear, saved drafts |
| `src/capture/db.ts` | Raw IndexedDB abstraction: openDB, get, put, delete, getAll |
