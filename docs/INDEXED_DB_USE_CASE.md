# IndexedDB Use Case

> **Current implementation reference.** This document describes how IndexedDB
> is used throughout the application for offline-first persistence. All details
> are verified against the source code in `src/capture/` and `src/alpe/`.

---

## Table of Contents

1. [Why IndexedDB](#1-why-indexeddb)
2. [Database Configuration](#2-database-configuration)
3. [Object Stores](#3-object-stores)
4. [Raw Abstraction Layer](#4-raw-abstraction-layer)
5. [Store 1 — Drafts](#5-store-1--drafts)
6. [Store 2 — Assets](#6-store-2--assets)
7. [Store 3 — Pending Ops](#7-store-3--pending-ops)
8. [Store 4 — Completed Leads](#8-store-4--completed-leads)
9. [Store 5 — Lead Queue](#9-store-5--lead-queue)
10. [Ownership and Multi-User Isolation](#10-ownership-and-multi-user-isolation)
11. [Schema Evolution and Upgrades](#11-schema-evolution-and-upgrades)
12. [Autosave Architecture](#12-autosave-architecture)
13. [Draft Recovery Flow](#13-draft-recovery-flow)
14. [Image Compression and Storage](#14-image-compression-and-storage)
15. [Change Notification Pattern](#15-change-notification-pattern)
16. [Cleanup and Retention](#16-cleanup-and-retention)
17. [Error Handling Philosophy](#17-error-handling-philosophy)
18. [Performance Characteristics](#18-performance-characteristics)
19. [Limitations and Future Considerations](#19-limitations-and-future-considerations)

---

## 1. Why IndexedDB

This application is an offline-first sales portal for field sales reps at
perfume trade events. Network connectivity at exhibition venues is unreliable.
Reps must capture leads continuously regardless of signal, and all data must
survive page reloads, device reboots, and extended periods of no connectivity.

IndexedDB was chosen over alternatives for these reasons:

| Requirement | IndexedDB | localStorage | sessionStorage |
|-------------|-----------|--------------|----------------|
| Survives page reload | Yes | Yes | No |
| Survives device reboot | Yes | Yes | No |
| Storage capacity | 50%+ of disk (browser-managed) | ~5–10 MB | ~5–10 MB |
| Binary/structured data | Objects, Blobs, typed arrays | Strings only | Strings only |
| Asynchronous API | Yes (non-blocking) | No (synchronous) | No (synchronous) |
| Indexing / queries | Yes (indexes, key ranges) | No (key-value only) | No |
| Transaction support | Yes | No | No |

The application stores compressed business card images (JPEG data URLs),
structured capture session drafts, offline sync queues, and processed lead
records. The combined data can exceed several megabytes per rep, making
localStorage's ~5 MB limit inadequate. IndexedDB's asynchronous API also
ensures that storage operations never block the UI thread.

---

## 2. Database Configuration

**Source:** `src/capture/db.ts`

```typescript
const DB_NAME   = 'capture_app';
const DB_VERSION = 8;
```

The application uses a **single IndexedDB database** (`capture_app`) at
**version 8**. All five object stores live in this one database. There is no
per-store versioning — the `DB_VERSION` constant is centralized in `db.ts` and
bumped whenever any store's schema changes.

The database is opened via `indexedDB.open(DB_NAME, DB_VERSION)`. The
`onupgradeneeded` callback handles both initial creation and incremental
upgrades (see [Schema Evolution](#11-schema-evolution-and-upgrades)).

---

## 3. Object Stores

| Store | Key Path | Indexes | Version Added | Purpose |
|-------|----------|---------|---------------|---------|
| `drafts` | `id` | (none) | v1 | Active capture draft + explicitly saved drafts |
| `assets` | `id` | `by_session` (sessionId), `by_owner` (ownerId) | v1 (indexes added v7) | Compressed business card images as JPEG data URLs |
| `pending_ops` | `id` | `by_session` (sessionId), `by_created` (createdAt), `by_owner` (ownerId) | v2 | Offline sync queue |
| `lead_queue` | `id` | `by_session` (sessionId), `by_created` (createdAt) | v3 | Legacy store (used by aggregation, not direct writes) |
| `completed_leads` | `id` | `by_status` (status), `by_created` (createdAt), `by_owner` (ownerId) | v4 (by_owner added later) | Local mirror of processed leads with sync/processing status |

All stores use `keyPath: 'id'` — the key is a property of the stored object,
not an out-of-line key. All keys are frontend-generated strings (UUIDs or
prefixed identifiers).

---

## 4. Raw Abstraction Layer

**Source:** `src/capture/db.ts`

The `db.ts` module is a thin, domain-agnostic wrapper around the raw IndexedDB
API. It exposes six functions:

| Function | Description |
|----------|-------------|
| `openDB()` | Opens the database (or triggers upgrade). Returns `Promise<IDBDatabase>`. |
| `dbGetAllInStore<T>(store)` | Returns all records in a store. |
| `dbGetAll<T>(store, indexName, indexValue)` | Returns all records matching an index query. |
| `dbGet<T>(store, key)` | Returns a single record by primary key. |
| `dbPut(store, value)` | Inserts or updates a record (put is upsert). |
| `dbDelete(store, key)` | Deletes a record by primary key. |

### Design Principles

1. **All methods return Promises.** The raw IndexedDB API is event-based
   (`onsuccess` / `onerror`). Each function wraps the events in a Promise.

2. **All methods fail gracefully.** `dbGet`, `dbPut`, and `dbDelete` catch
   exceptions and return `null` / `void` / `[]` instead of throwing. The
   comment on `dbPut` reads: "Storage errors must never crash the UI." This
   means a full disk or corrupted database will not crash the app — data may
   be lost, but the UI remains responsive.

3. **No domain knowledge.** The module knows nothing about drafts, assets, or
   leads. It is a pure key-value abstraction. Domain logic lives in the
   storage service modules that call it.

4. **Replaceable.** The module header states: "Replace this module (e.g. with
   Capacitor SQLite) without touching callers." All five storage services
   import only from `db.ts`, so swapping the persistence layer is a
   single-file change.

---

## 5. Store 1 — Drafts

**Source:** `src/capture/captureDraftStorage.ts`
**Store:** `drafts` | **Key:** `id` | **Indexes:** none

### Purpose

The drafts store holds two types of records in a single object store:

1. **Active recovery draft** — a single record keyed `'active_capture_draft'`.
   This is the in-progress capture session that autosave continuously updates.
   On page reload, it is offered to the rep as a recoverable draft.

2. **Saved drafts** — explicitly saved by the user, each keyed
   `'saved_draft:<uuid>'`. These are named snapshots that the rep can restore
   later from the Queue page.

Both record types share the same `PersistedDraft` interface. The `id` field
distinguishes them (`'active_capture_draft'` vs `'saved_draft:...'`).

### PersistedDraft Structure

```typescript
interface PersistedDraft {
  id:                    string;           // 'active_capture_draft' or 'saved_draft:<uuid>'
  ownerId:               string | null;    // auth UID of the rep
  captureMethod:         CaptureMethod;    // 'BUSINESS_CARD' | 'QR' | 'MANUAL'
  originalCaptureMethod: CaptureMethod;    // method originally selected (before switching)
  sessionStatus:         SessionStatus;    // 'IDLE' | 'CAPTURING' | 'DRAFT' | 'READY_FOR_REVIEW'
  captureProfile:        CaptureProfile;   // 'CRM' | 'EXHIBITION'
  draftData:             DraftData;        // all captured fields (name, phone, company, etc.)
  hasUnsavedChanges:     boolean;
  createdAt:             string | null;    // ISO
  updatedAt:             string | null;    // ISO
  // Backend sync state (for session continuity across refreshes)
  backendSessionId:      string | null;    // Supabase capture_sessions.id
  backendAssetIds:       Record<string, string>;  // localAssetId → Supabase assetId
  backendExtractionIds:  Record<string, string>;  // extractionKey → Supabase extractionId
  lastSyncedAt:          string | null;    // ISO
}
```

### Public API

| Function | Description |
|----------|-------------|
| `saveDraft(session, ownerId?)` | Serializes the capture session and writes it as the active draft. Skips if `IDLE` or empty. |
| `loadDraft(ownerId?)` | Loads the active draft, validates it, and deserializes it back into a `CaptureSession`. Returns `null` if missing, invalid, or owned by a different user. |
| `clearDraft(ownerId?)` | Deletes the active draft. Checks ownership before deleting. |
| `saveSavedDraft(session, ownerId?)` | Creates a new saved draft with a `'saved_draft:<uuid>'` key. Notifies subscribers. |
| `loadSavedDraft(draftId, ownerId?)` | Loads a specific saved draft by ID. |
| `loadAllSavedDrafts(ownerId?)` | Returns all saved drafts for the owner, sorted newest-first. |
| `deleteSavedDraft(draftId, ownerId?)` | Deletes a saved draft. Checks ownership. Notifies subscribers. |

### Validation

Two validation guards ensure corrupted data does not reach the UI:

- `isValidDraft(record)` — checks for `id === 'active_capture_draft'`, non-null
  `captureMethod`, non-null `sessionStatus`, and `draftData` being an object.
- `isValidSavedDraft(record)` — checks for `id.startsWith('saved_draft:')` plus
  the same field requirements.

Invalid records are silently ignored (treated as missing).

### Save Guard

`saveDraft` refuses to write in two cases:
1. `sessionStatus === 'IDLE'` — an idle session has no meaningful data.
2. `isDraftEmpty(draftData)` — the draft has no text, arrays, card assets, QR
   data, or voice notes (checked by `captureDraftEligibility.ts`).

This prevents the drafts store from filling with empty records on every
session reset.

---

## 6. Store 2 — Assets

**Source:** `src/capture/captureAssetStorage.ts`
**Store:** `assets` | **Key:** `id` | **Indexes:** `by_session`, `by_owner`

### Purpose

The assets store holds compressed business card images as JPEG data URLs.
Each asset represents one face (front or back) of a business card photograph
associated with a capture session. The images are compressed on a canvas
before being written — the maximum stored dimension is 1200px on the longest
edge, at 82% JPEG quality.

### BusinessCardAsset Structure

```typescript
interface BusinessCardAsset {
  id:             string;    // 'asset_{timestamp}_{random}'
  sessionId:      string;    // FK to the capture session
  side:           CardSide;  // 'front' | 'back'
  dataUrl:        string;    // compressed JPEG as data URL
  mimeType:       string;    // 'image/jpeg'
  originalWidth:  number;    // dimensions before compression
  originalHeight: number;
  storedWidth:    number;    // dimensions after compression (≤1200px)
  storedHeight:   number;
  sizeBytes:      number;    // estimated compressed size
  createdAt:      string;    // ISO
  ownerId:        string | null;  // auth UID
}
```

### Image Compression

`compressImage(source, maxWidth=1200, maxHeight=1200, quality=0.82)`:

1. Loads the source image into an `Image` element.
2. Calculates the scaling ratio to fit within `maxWidth × maxHeight`.
3. Draws the scaled image onto a `<canvas>`.
4. Exports the canvas as a JPEG data URL via `canvas.toDataURL()`.
5. Estimates the byte size as `(dataUrl.length * 3) / 4` (base64 overhead).

Compression is synchronous on the main thread but fast for business card
images (typically under 50ms for a 1200×800 image).

### Public API

| Function | Description |
|----------|-------------|
| `saveAsset(sessionId, side, rawDataUrl, ownerId?)` | Compresses the image, creates the asset record, writes to IDB. |
| `getAsset(id, ownerId?)` | Retrieves one asset. Enforces ownership. |
| `getSessionAssets(sessionId, ownerId?)` | Retrieves all assets for a session. Enforces ownership. |
| `deleteAsset(id, ownerId?)` | Deletes one asset. Enforces ownership. |
| `deleteSessionAssets(sessionId, ownerId?)` | Deletes all assets for a session. |

### Relationship to Supabase

The `assets` IDB store is the **device cache**. The `capture_assets` Supabase
table stores **metadata only** (dimensions, MIME type, byte size, FKs). The
actual image bytes live in IDB and in Supabase Storage (uploaded by
`assetStorageUpload.ts`). The `assets` store is the offline copy that ensures
the image is available even when the network is down.

---

## 7. Store 3 — Pending Ops

**Source:** `src/capture/captureOfflineQueue.ts`
**Store:** `pending_ops` | **Key:** `id` | **Indexes:** `by_session`, `by_created`, `by_owner`

### Purpose

The pending ops store is the offline sync queue. When a rep captures a lead
while offline, every backend write operation is enqueued here. On reconnect,
all ops are replayed in creation order. Each op is idempotent (upserts with
stable frontend UUIDs), so replay is safe.

### PendingOp Structure

```typescript
interface PendingOp {
  id:        string;         // 'op_{timestamp}_{random}'
  ownerId:   string | null;  // auth UID
  type:      PendingOpType;  // 11 op types (see Queue Implementation doc)
  sessionId: string;         // for grouping by capture session
  createdAt: string;         // ISO — determines flush order
  retries:   number;         // incremented on network errors
  payload:   unknown;        // op-specific data
}
```

### Indexes

- **`by_session`** — enables querying all ops for a specific capture session
  (used for diagnostics and targeted cleanup).
- **`by_created`** — enables ordering ops by creation time (the flush loop
  sorts by `createdAt` to replay in order).
- **`by_owner`** — enables owner-scoped flushing (a rep's ops are flushed
  independently of another rep's ops on the same device).

### Lifecycle

1. **Enqueue:** `enqueueOp(type, sessionId, payload, ownerId?)` writes a new
   `PendingOp` to the store.
2. **Flush:** `flushQueue(ownerId?)` loads all ops, filters by owner, sorts by
   `createdAt`, and executes each in order. Successful ops are deleted. Failed
   ops have `retries` incremented and are kept.
3. **Deletion:** Ops are deleted on success or on non-retryable auth errors.

See `docs/QUEUE_IMPLEMENTATION.md` for full details on op types, flush logic,
and retry semantics.

---

## 8. Store 4 — Completed Leads

**Source:** `src/capture/completedLeadsStorage.ts`
**Store:** `completed_leads` | **Key:** `id` | **Indexes:** `by_status`, `by_created`, `by_owner`

### Purpose

The completed leads store is the local mirror of every lead that has been
submitted via "Save & Next", card completion, or QR scan. It tracks the
sync/processing status of each lead and serves as the data source for the
Queue page UI.

### CompletedLead Structure

```typescript
interface CompletedLead {
  id:               string;                  // stable UUID (= sessionId)
  ownerId:          string | null;           // auth UID
  status:           CompletedLeadStatus;     // see below
  captureMethod:    CaptureMethod | null;
  draftData:        DraftData;               // all captured fields
  backendSessionId: string | null;           // Supabase capture_sessions.id
  eventId:          string | null;
  eventName:        string | null;
  createdAt:        string;                  // ISO
  updatedAt:        string;                  // ISO
  syncedAt:         string | null;           // when confirmed on backend
  retries:          number;
  lastError:        string | null;
  // Processing failure diagnostics (from processing_queue)
  failedStage:      string | null;
  lastAttemptAt:   string | null;
  failedAt:        string | null;
  isExhausted:     boolean;                  // retry_count >= MAX_RETRY_COUNT
}
```

### CompletedLeadStatus

```
local_only → pending_sync → syncing → synced
                          → failed
                          → needs_review
```

| Status | Meaning |
|--------|---------|
| `local_only` | Captured, sync not yet attempted |
| `pending_sync` | Sync ops queued, waiting to flush |
| `syncing` | Flush in-flight |
| `synced` | Confirmed on backend (lead_entries row exists) |
| `failed` | Sync or processing failed |
| `needs_review` | Missing key fields (no client name or company) |

### Public API

| Function | Description |
|----------|-------------|
| `saveCompletedLead(lead)` | Writes a new or updated record. Notifies subscribers. |
| `loadCompletedLeads(ownerId?)` | Returns all records, sorted newest-first. |
| `getCompletedLead(id)` | Returns one record by ID. |
| `updateCompletedLeadStatus(id, status, extra?, ownerId?)` | Updates status and optional fields (syncedAt, retries, lastError, etc.). Notifies subscribers. |
| `deleteCompletedLead(id, ownerId?)` | Deletes one record. Checks ownership. Notifies subscribers. |
| `buildCompletedLead(...)` | Factory function: creates a `CompletedLead` from capture session data. Sets `local_only` or `needs_review` based on whether key fields are present. |

### Change Notification

The completed leads store implements a lightweight pub/sub pattern (see
[Change Notification Pattern](#15-change-notification-pattern)) so the
`LeadQueuePage` can react to status changes without polling.

### Cleanup

Two cleanup functions manage storage growth:

1. `cleanupOldSyncedCompletedLeads(ownerId, maxAgeMs)` — deletes `synced`
   records older than `maxAgeMs` (based on `syncedAt`). Used by the ALPE
   scheduler with a 5-minute throttle and 3-day retention. Only `synced`
   records are deleted — never `failed`, `pending_sync`, or `local_only`.

2. `deleteAllSyncedCompletedLeads(ownerId?)` — deletes all `synced` records
   at once. Used by the "Delete all synced" button on the Queue page.

Both are local-only operations — they never touch Supabase, `processing_queue`,
`pending_ops`, `drafts`, or `assets`.

---

## 9. Store 5 — Lead Queue

**Source:** `src/capture/leadQueueStorage.ts` (reads from this store)
**Store:** `lead_queue` | **Key:** `id` | **Indexes:** `by_session`, `by_created`

### Purpose

The `lead_queue` store is a legacy store created in database version 3. It is
**not written to directly** by any current code path. The `saveQueueItem`
function in `leadQueueStorage.ts` is an explicit no-op stub:

```typescript
export async function saveQueueItem(_item: QueueItem): Promise<void> {
  // Queue is populated by saveCompletedLead, not this function.
}
```

The `loadQueueItems` function reads from `drafts` and `completed_leads`
instead, not from `lead_queue`. The store exists for backward compatibility
with older database versions but is functionally unused.

---

## 10. Ownership and Multi-User Isolation

A critical requirement: multiple sales reps may share the same device (e.g.,
a shared booth tablet). Each rep's data must be isolated.

### How It Works

Every record in every store carries an `ownerId` field (the authenticated
user's Supabase auth UID). The `by_owner` index on `assets`, `pending_ops`,
and `completed_leads` enables efficient owner-scoped queries.

### Enforcement Points

| Operation | How ownership is enforced |
|-----------|--------------------------|
| `loadDraft(ownerId)` | Returns `null` if `record.ownerId !== ownerId` |
| `clearDraft(ownerId)` | Refuses to delete if `record.ownerId !== ownerId` |
| `loadCompletedLeads(ownerId)` | Queries `by_owner` index — only this owner's records |
| `updateCompletedLeadStatus(id, _, _, ownerId)` | Checks `existing.ownerId !== ownerId` before updating |
| `deleteCompletedLead(id, ownerId)` | Checks `existing.ownerId !== ownerId` before deleting |
| `getAsset(id, ownerId)` | Returns `null` if `asset.ownerId !== ownerId` |
| `getSessionAssets(sessionId, ownerId)` | Filters results by `asset.ownerId === ownerId` |
| `deleteAsset(id, ownerId)` | Silent no-op if `asset.ownerId !== ownerId` |
| `flushQueue(ownerId)` | Filters ops by `op.ownerId === ownerId` |
| `enqueueOp(..., ownerId)` | Stamps `ownerId` at enqueue time |
| `getPendingCount(ownerId)` | Filters by `op.ownerId === ownerId` |

### Legacy Records

Records with `ownerId === null` (written before the ownership system was
introduced) are **excluded** from all owner-scoped reads. They can only be
accessed via the unscoped path (no `ownerId` parameter), which is reserved for
diagnostic and recovery tooling. This prevents a legacy record from leaking
into another rep's view.

### Ownership Is Captured at Write Time

`ownerId` is stamped when the record is created and **never resolved later**
from current auth state. This means if a rep logs out and another logs in, the
first rep's data remains isolated — the new rep's `ownerId` will not match.

---

## 11. Schema Evolution and Upgrades

**Source:** `src/capture/db.ts`, `onupgradeneeded` handler

The `onupgradeneeded` callback handles both initial creation and incremental
upgrades. Every statement uses existence guards (`IF NOT EXISTS` equivalents)
to be safe regardless of the starting version.

### Upgrade History

| Version | Changes |
|---------|---------|
| 1 | Created `drafts` and `assets` stores. `assets` had `by_session` index. |
| 2 | Created `pending_ops` store with `by_session`, `by_created` indexes. |
| 3 | Created `lead_queue` store with `by_session`, `by_created` indexes. |
| 4 | Created `completed_leads` store with `by_status`, `by_created` indexes. |
| 5–6 | (No schema changes documented in code — likely data migrations or index tweaks) |
| 7 | Added `by_owner` index to `assets` store (non-destructive — only if the index doesn't already exist). |
| 8 | Added `by_owner` index to `completed_leads` store (non-destructive). Also added `by_owner` index to `pending_ops` (if not already present). |

### Upgrade Safety Pattern

The upgrade handler uses two patterns:

1. **Initial creation:** `if (!db.objectStoreNames.contains('store_name'))`
   before creating a new store. This is safe on first open and on upgrades
   from a version before the store existed.

2. **Index addition to existing store:**
   ```typescript
   } else if (event.oldVersion < 7) {
     const store = (event.target as IDBOpenDBRequest).transaction!.objectStore('assets');
     if (!store.indexNames.contains('by_owner')) {
       store.createIndex('by_owner', 'ownerId', { unique: false });
     }
   }
   ```
   This adds an index only if the store already exists and the index is
   missing. The `oldVersion < N` guard ensures the code runs only for
   databases upgrading from a version before the index was introduced.

### Centralized Version

`DB_VERSION` is a single constant in `db.ts`. All stores share the same
database and version. There is no per-store versioning. When any store's
schema changes, `DB_VERSION` is bumped and the `onupgradeneeded` handler is
extended.

---

## 12. Autosave Architecture

**Source:** `src/capture/useAutosave.ts`

### Debounced Autosave

The `useAutosave` hook debounces writes to the `drafts` store at **600ms**
after any `draftData`, `sessionStatus`, or `captureMethod` change.

```
User edits a field
  │
  ├── (within 600ms) → timer reset, no write
  │
  └── (600ms of inactivity) → saveDraft() → IndexedDB write
```

### Save Key Deduplication

Before scheduling a save, the hook computes a compact JSON key from the
session's method, status, and draft data:

```typescript
function draftKey(s: CaptureSession): string {
  return JSON.stringify({ m: s.captureMethod, st: s.sessionStatus, d: s.draftData });
}
```

If this key matches the last successfully persisted key, no save is
scheduled. This means sync-only state updates (e.g., `pendingOps` counter
changes, `syncStatus` transitions) never trigger redundant IndexedDB writes.

### Emergency Flush

Three browser events trigger an immediate, non-debounced flush:

| Event | When | Why |
|-------|------|-----|
| `visibilitychange` (hidden) | App backgrounded, tab switched | Process may be suspended |
| `beforeunload` | Page closing (desktop Chrome/Firefox) | Process will be killed |
| `pagehide` | Page closing (iOS Safari, Capacitor) | `beforeunload` is unreliable on iOS |

The `flushNow` function clears any pending debounce timer and calls `doSave`
immediately. This is the last-resort save before the process is suspended or
killed.

### Save State Feedback

The hook reports save state to the UI via `onSaveStateChange`:

| State | Meaning |
|-------|---------|
| `idle` | Session is IDLE, nothing to save |
| `saving` | Write in progress |
| `saved` | Write succeeded, device is online |
| `offline_saved` | Write succeeded, device is offline |
| `unsaved` | Changes detected, debounce timer running |

---

## 13. Draft Recovery Flow

When the app loads, `CaptureLeadPage` checks for a recoverable draft:

```
On mount
  │
  ├── loadDraft(ownerId)
  │     │
  │     ├── null → no draft, start fresh
  │     │
  │     └── valid draft
  │           │
  │           ├── sessionStatus === 'IDLE' → ignore (empty session)
  │           │
  │           └── sessionStatus !== 'IDLE'
  │                 │
  │                 ├── Store in pendingDraft state
  │                 ├── Show DraftRecoveryBanner
  │                 │
  │                 ├── User taps "Continue"
  │                 │     ├── restoreSession(saved)
  │                 │     └── Re-sync to backend if online
  │                 │
  │                 └── User taps "Discard"
  │                       └── clearDraft(ownerId)
  │
  └── If online, re-sync the restored session to the backend
```

This flow ensures that a rep who accidentally closes the tab or whose browser
crashes mid-capture does not lose their in-progress work.

---

## 14. Image Compression and Storage

**Source:** `src/capture/captureAssetStorage.ts`

Business card images are the largest data type stored in IndexedDB. The
compression pipeline ensures they remain small enough for offline storage
while preserving readability:

1. **Capture:** The rep photographs a business card (via file input or camera).
   The raw image is a data URL (possibly several MB).
2. **Dimension reading:** `new Image()` loads the data URL to read
   `naturalWidth` and `naturalHeight`.
3. **Compression:** `compressImage()` scales the image to fit within
   1200×1200px (maintaining aspect ratio) and exports as JPEG at 82% quality
   via `canvas.toDataURL('image/jpeg', 0.82)`.
4. **Storage:** The compressed data URL is written to the `assets` IDB store
   with metadata (original/stored dimensions, estimated byte size).
5. **Upload:** The same compressed data URL is uploaded to Supabase Storage
   by `assetStorageUpload.ts` when online, or enqueued as an
   `upload_business_card` op when offline.

### Size Estimate

A typical business card photo:
- Raw (phone camera, 4000×3000): ~5–8 MB as data URL
- Compressed (1200×900, JPEG 82%): ~150–300 KB as data URL
- Estimated byte count: `(dataUrl.length * 3) / 4`

This keeps the `assets` store well within IndexedDB's storage quotas even for
reps who capture hundreds of cards.

---

## 15. Change Notification Pattern

**Sources:** `src/capture/completedLeadsStorage.ts`, `src/capture/captureDraftStorage.ts`

Two stores implement a lightweight pub/sub pattern so React components can
react to data changes without polling.

### Pattern

```typescript
type Listener = () => void;
const listeners = new Set<Listener>();
let version = 0;

function notify(): void {
  version++;
  listeners.forEach(l => l());
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function getVersion(): number {
  return version;
}
```

### Stores Using This Pattern

| Store | Subscribe function | Version function | Notified on |
|-------|-------------------|-----------------|-------------|
| `completed_leads` | `subscribeCompletedLeads` | `getCompletedLeadsVersion` | save, update status, delete, cleanup |
| `drafts` (saved drafts) | `subscribeSavedDrafts` | `getSavedDraftsVersion` | save saved draft, delete saved draft |

### Usage

React components use `useSyncExternalStore` (or a similar hook) with the
subscribe and version functions. When `notify()` fires, the component
re-reads the data and re-renders. This avoids setInterval-based polling and
ensures the UI is always in sync with IndexedDB state.

### What Does NOT Use This Pattern

- The `drafts` active draft (`active_capture_draft`) — autosave writes are
  driven by React state changes, so the component already knows when data
  changes.
- The `pending_ops` store — flush progress is communicated via the
  `onProgress` callback, not pub/sub.
- The `assets` store — assets are read on demand, not reactively.

---

## 16. Cleanup and Retention

### Completed Leads Cleanup

**Source:** `src/capture/completedLeadsStorage.ts`

The ALPE scheduler runs `cleanupOldSyncedCompletedLeads` on a throttled basis
(5-minute interval, 3-day retention):

- **Conditions for deletion:** `status === 'synced'` AND `syncedAt` is a
  non-null, parseable timestamp AND `Date.parse(syncedAt) <= cutoff`.
- **Records with missing/invalid `syncedAt` are NEVER deleted** — there is no
  fallback to `updatedAt`.
- **Only local IDB records are removed** — Supabase data is never touched.

### Manual Cleanup

The Queue page offers a "Delete all synced" button that calls
`deleteAllSyncedCompletedLeads(ownerId?)`. This removes all `synced` records
in one operation. Records in any other status (`failed`, `pending_sync`,
`local_only`, `needs_review`) are preserved.

### What Is NOT Cleaned Up Automatically

- `pending_ops` — ops are deleted only on successful flush or auth error.
  Stuck ops (e.g., permanently failing server endpoint) remain indefinitely.
- `assets` — business card images are never automatically cleaned up. They
  accumulate until the capture session is explicitly discarded.
- `drafts` — the active draft is cleared on session reset. Saved drafts
  persist until manually deleted.
- `lead_queue` — legacy store, not actively written to or cleaned up.

---

## 17. Error Handling Philosophy

The IndexedDB layer follows a strict "never crash the UI" principle:

### db.ts (raw layer)

- `dbGet` catches all errors and returns `null`.
- `dbPut` catches all errors and returns `void` (silently fails).
- `dbDelete` catches all errors and returns `void` (silently fails).
- `dbGetAll` and `dbGetAllInStore` catch all errors and return `[]`.

### Domain storage services

- `completedLeadsStorage.put()` catches errors and returns `false`.
- `completedLeadsStorage.getAll()` catches errors and returns `[]`.
- `completedLeadsStorage.remove()` catches errors and returns `void`.
- `captureDraftStorage.saveDraft()` does not catch — but `useAutosave.doSave()`
  wraps it in try/catch and reports `'unsaved'` state.
- `captureAssetStorage.saveAsset()` does not catch — but callers handle errors
  at the capture UI level.

### Implications

- A full disk will cause silent data loss. The UI will continue to work, but
  new records will not be persisted. The autosave hook will report `'unsaved'`
  state, which is shown in the UI.
- A corrupted database will cause all reads to return empty results. The app
  will appear as if it has no data, but it will not crash.
- There is no retry mechanism at the IDB layer. If a write fails, it fails
  silently. The caller is responsible for detecting the failure (via return
  value) and deciding whether to retry.

---

## 18. Performance Characteristics

### Read Performance

- `dbGet(store, key)` — single key lookup. O(1) via IndexedDB primary key.
  Typically <1ms for any store size.
- `dbGetAllInStore(store)` — full table scan. Returns all records. For
  `pending_ops` with hundreds of ops, this is typically <10ms.
- `dbGetAll(store, index, value)` — index query. O(log n) for the index
  lookup, then O(k) for fetching k matching records. Fast for session-scoped
  or owner-scoped queries.

### Write Performance

- `dbPut(store, value)` — upsert. O(1) for primary key. For `assets` with
  large JPEG data URLs (~200 KB), the write takes 5–20ms depending on the
  browser's serialization overhead.
- `dbDelete(store, key)` — O(1) via primary key.

### Transaction Model

Each operation opens its own transaction. There is no multi-record
transaction batching. This means:

- **No atomic multi-write guarantees.** If two writes are issued in sequence
  and the first succeeds but the second fails, the first is committed. This
  is acceptable because all operations are idempotent upserts.
- **No read-your-writes consistency across calls.** A write followed by a read
  in a separate transaction may not see the write if the write transaction
  hasn't committed yet. In practice, IndexedDB commits are fast enough that
  this is not a problem.

### Data Volume Estimates

| Data type | Per-rep volume | Notes |
|-----------|---------------|-------|
| Active draft | ~2–5 KB | Single JSON record |
| Saved drafts | ~2–5 KB each | Typically <10 per rep |
| Business card assets | ~200 KB each | 2 per capture (front + back) |
| Pending ops | ~1–2 KB each | Flushed on reconnect, rarely accumulates |
| Completed leads | ~3–8 KB each | Cleaned up after 3 days (synced) |

A rep capturing 100 leads per day with 2 card photos each generates ~40 MB of
assets per day. The 3-day cleanup on synced completed leads helps, but assets
are not automatically cleaned. For high-volume events, manual cleanup or a
future asset retention policy may be needed.

---

## 19. Limitations and Future Considerations

### No Cross-Tab Synchronization

IndexedDB changes are visible across tabs (via the `storage` event for
`localStorage`, but IndexedDB does not have a native change event). The
application uses its own pub/sub pattern for `completed_leads` and saved
drafts, but this only works within the same tab. If two tabs are open and one
writes to IndexedDB, the other tab will not see the change until it re-reads.

The `processing_queue` flush lock (per-owner `Map<string, boolean>`) is also
in-memory and per-tab — it does not prevent two tabs from flushing
simultaneously. The optimistic lock on `processing_queue` claim prevents
double-processing, but the offline queue has no such protection. In practice,
double-flushing is harmless because all ops are idempotent.

### No Storage Quota Monitoring

The application does not call `navigator.storage.estimate()` to check
available quota. If the device runs out of IndexedDB storage, writes will
silently fail. A future enhancement could check quota before large writes
and warn the rep.

### No Encrypted-at-Rest

IndexedDB data is stored in the browser's profile directory without
encryption. On a shared device, a user with file system access could read
another rep's data. The `ownerId` isolation prevents cross-rep access within
the app, but not at the file system level. If this is a concern, the app
would need to encrypt sensitive fields before writing to IDB or use a
platform-level secure storage API.

### Replaceability

The `db.ts` module is designed to be replaceable with Capacitor SQLite or
another persistence layer. All five storage services import only from `db.ts`,
so swapping the backend is a single-file change. The API contract is:

- `openDB(): Promise<IDBDatabase>` → would become `openDB(): Promise<Database>`
- `dbGet / dbPut / dbDelete / dbGetAll / dbGetAllInStore` → same signatures,
  different internal implementation

The `IDBDatabase` type would need to be abstracted away for a clean swap, but
the function signatures are already storage-agnostic.
