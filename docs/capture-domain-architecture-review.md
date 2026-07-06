# Capture Domain Architecture Review

> **Type:** Architecture assessment — read-only analysis
> **Date:** 2026-07-03
> **Scope:** CaptureProfile, CaptureSession (useCaptureSession), CaptureEvidenceManager, PromotionService
> **Purpose:** Pre-Processing Engine design review

---

## 1. Component Reviews

---

### 1.1 CaptureProfile (`captureProfile.ts`)

**Primary responsibility**

Defines the two operating modes for the capture pipeline — CRM (accuracy-first) and EXHIBITION (speed-first) — and centralises all static metadata about each mode.

**Public API**

```typescript
type CaptureProfile = 'CRM' | 'EXHIBITION'
const DEFAULT_CAPTURE_PROFILE: CaptureProfile
interface CaptureProfileDescriptor { label, purpose, waitForExtraction, skipReview }
const CAPTURE_PROFILE_DESCRIPTORS: Record<CaptureProfile, CaptureProfileDescriptor>
```

**Dependencies**

None. This is a pure data module with no imports.

**Who should call it**

- `useCaptureSession` (to seed the default profile into session state)
- The future Processing Engine (to read `waitForExtraction` and `skipReview` to branch pipeline behaviour)
- Future UI components that render a profile-switcher

**Who should NOT call it**

Currently nobody violates this boundary. No upload helpers, sync functions, or extraction hooks import from this module.

**Current coupling**

Minimal and correct. `useCaptureSession.ts` imports `DEFAULT_CAPTURE_PROFILE` to initialise `IDLE_SESSION.captureProfile`. That is the only consumer. `captureProfile` in `CaptureSession` state is read by nothing in the current codebase — it is written but never branched on. The descriptors are defined but never read.

**Future role inside the Processing Engine**

`CaptureProfileDescriptor.waitForExtraction` and `skipReview` become the Processing Engine's primary dispatch flags. The Engine reads the active session's profile, checks the descriptor, and chooses synchronous vs. deferred processing paths accordingly. This module requires no changes.

**Issues**

- `captureProfile` is present in `CaptureSession` state and persisted in IndexedDB but never read by any current code path. It is dead state today. This is not a problem — it is intentionally prepared for the Processing Engine. It simply means there is no CRM-vs-EXHIBITION branching today.

---

### 1.2 CaptureSession (`useCaptureSession.ts`)

**Primary responsibility**

Manages the full in-memory lifecycle of the active capture session as React state: session creation, draft field updates, status transitions, sync state tracking, and session reset.

**Public API**

```typescript
function useCaptureSession(): [CaptureSession, CaptureSessionActions]

interface CaptureSessionActions {
  startCapture(method)           // creates new session, generates backendSessionId
  startCaptureWithDraft(method, draft)
  restoreSession(saved)
  setStatus(status)
  patchDraft(patch)
  resetSession()
  setCaptureProfile(profile)
  patchSync(patch)
  setSyncStatus(status, error?)
  incrementPendingOps()
  decrementPendingOps()
}
```

**Dependencies**

- `./types` — `BackendSyncState`, `CaptureMethod`, `CaptureProfile`, `CaptureSession`, `DraftData`, `SessionStatus`, `SyncStatus`, `INITIAL_SYNC_STATE`
- `./captureProfile` — `DEFAULT_CAPTURE_PROFILE`
- React (`useState`, `useCallback`, `useRef`)

**Who should call it**

`CaptureLeadPage` only. It is a React hook and can only be called at the top of a component tree.

**Who should NOT call it**

- Services (captureBackendSync, capturePromotionService, captureEvidenceManager) — they must not depend on React hooks
- The offline queue — purely non-React
- The future Processing Engine — must be non-React

**Current coupling**

The hook's `sync` sub-state (`pendingOps`, `status`, `backendSessionId`, `backendAssetIds`, `backendExtractionIds`) is managed entirely inside `CaptureLeadPage` via `actions.incrementPendingOps()`, `actions.patchSync()`, etc. This means `CaptureLeadPage` is the only consumer of sync state mutations — which is correct for now, but means the page is still a sync state router.

**Key design observation — sync state coupling**

`BackendSyncState` lives inside `CaptureSession` React state. The `SyncCallbacks` interface (defined in `captureBackendSync`) calls back into React via `actions.patchSync` / `actions.setSyncStatus`. This creates an indirect dependency: `captureBackendSync` → `SyncCallbacks` → `CaptureLeadPage.makeSyncCbs()` → `useCaptureSession` actions. This is the primary coupling between the transport layer and the React layer. It is acceptable today; the Processing Engine will need to break it.

**Future role inside the Processing Engine**

The Processing Engine does not use this hook. Instead, it receives a plain `CaptureSession` snapshot as input (read-only). Sync state tracking moves inside the Engine's own internal state, not inside React. The `setCaptureProfile` action is still called by a future profile-switcher UI component.

**Issues**

- `genStableId()` is duplicated — identical implementation also exists in `CaptureLeadPage.tsx`. Should live in `types.ts` or a `utils.ts` shared utility.
- `incrementPendingOps` / `decrementPendingOps` are sync bookkeeping actions that exist solely for a UI indicator badge. The Processing Engine should own pending-op counting, not React state.
- `startCaptureWithDraft` preserves the existing `backendSessionId` when the capture method transitions (e.g. BUSINESS_CARD → MANUAL). This is correct, but it is session-identity logic living in a React hook. The Processing Engine will need to replicate this invariant non-reactively.

---

### 1.3 CaptureEvidenceManager (`captureEvidenceManager.ts`)

**Primary responsibility**

Single owner of the evidence lifecycle: registration, upload timing decisions, upload execution, and session-scoped state cleanup. CaptureLeadPage registers evidence; the manager decides when and how to upload it.

**Public API**

```typescript
type EvidenceType = 'business_card_front' | 'business_card_back' | 'notes_image'
type CaptureEvidence = BusinessCardEvidence | NotesImageEvidence
const evidenceManager: CaptureEvidenceManager

// Instance methods:
evidenceManager.register(evidence: CaptureEvidence): void
evidenceManager.onSaveAndNext(sessionId: string): void
evidenceManager.onSessionReset(): void
```

**Dependencies**

- `./types` — `BusinessCardAsset`
- `./assetStorageUpload` — `uploadBusinessCardAsset`, `uploadNotesImage`

**Who should call it**

- `CaptureLeadPage` — register evidence when assets are created; notify on Save & Next; notify on session reset
- The future Processing Engine — register evidence when the Engine creates or processes assets; trigger `onSaveAndNext` at the promotion step

**Who should NOT call it**

- `captureBackendSync` — transport layer; should not own upload decisions
- `captureOfflineQueue` — queue replays should not re-register evidence (the upload already happened or should not be retried via this path)
- `capturePromotionService` — promotion is a separate concern; it should not know about evidence uploads

**Current coupling**

The manager is a module singleton (`evidenceManager`), which is appropriate — upload state must survive React re-renders. It has no knowledge of React, Supabase sessions, or the offline queue. Its only runtime dependencies are `navigator.onLine` and the two upload helpers.

**Issues**

- The `uploadImmediately` field on `BusinessCardEvidence` is structurally redundant. It is always `true` for business cards — this is already encoded in the `type` discriminant. The field adds cognitive noise without adding flexibility. The `register()` switch correctly branches on `type`, not on `uploadImmediately`. This is a minor cleanliness issue.
- `onSessionReset()` accepts no argument — it clears all pending evidence regardless of which session it belonged to. With multiple concurrent sessions this would be a bug, but the current architecture is single-active-session so this is safe today. The future multi-session case (Exhibition profile with a rapid-fire queue) should pass a `sessionId` for precision.
- The manager's pending state is module-level (not session-keyed beyond the `_pendingNotes.sessionId` check). If `register` for a notes image is called for session A, then `onSessionReset` is called (clearing it), and a new session B registers a notes image, `onSaveAndNext(sessionB)` will correctly upload B's image. The session-ID guard in `onSaveAndNext` closes the race. This is correct.

**Future role inside the Processing Engine**

The Processing Engine calls `evidenceManager.register(evidence)` when it creates or receives assets during processing. It calls `evidenceManager.onSaveAndNext(sessionId)` when it reaches the promotion step. `onSessionReset()` is called at pipeline completion. The manager's API is stable for this use case with no changes required.

---

### 1.4 PromotionService (`capturePromotionService.ts`)

**Primary responsibility**

Single canonical execution path for promoting a capture session into a `lead_entries` row. Handles idempotency, auth resolution, field mapping, the Supabase INSERT, the session status UPDATE, and the `completed_leads` IndexedDB update — all in one atomic sequence.

**Public API**

```typescript
interface PromoteSessionOptions {
  backendSessionId, draftData, eventCode, completedLeadId,
  captureMethod, eventId, eventName
}
interface PromoteSessionResult { leadId, error, alreadyPromoted }

async function executePromotion(options): Promise<PromoteSessionResult>
```

**Dependencies**

- `../supabaseClient` — Supabase client
- `./deriveState` — Indian state heuristic (pure function)
- `./completedLeadsStorage` — IndexedDB CRUD for `completed_leads`

**Who should call it**

- `CaptureLeadPage.handleSaveAndNext` — online promotion path
- `captureBackendSync.syncPromoteSession` — queue replay adapter (wraps `executePromotion` in `SyncCallbacks`)
- The future Processing Engine — terminal step of the pipeline

**Who should NOT call it**

- `captureEvidenceManager` — evidence and promotion are independent concerns
- UI components other than `CaptureLeadPage`

**Current coupling**

`captureBackendSync.ts` imports `executePromotion` and re-exports `PromoteSessionOptions` as `PromoteSessionPayload`. This creates a thin re-export coupling between the two modules. It exists only to give `captureOfflineQueue` a single import point for type + function. It is harmless but adds a layer of indirection.

`executePromotion` owns the `completed_leads` IndexedDB update via `_updateCompletedLead`. This creates a dependency on `completedLeadsStorage` inside the promotion service. The argument for keeping it here is atomicity — promotion and status tracking are logically co-incident. The argument against is that IndexedDB is a UI-tier concern that does not belong in a backend-facing service. This is the clearest responsibility overlap in the domain today.

**Issues**

- **Duplicated `getAuthIdentity`**: Both `capturePromotionService.ts` and `captureBackendSync.ts` define an identical `getAuthIdentity()` function (same logic: `auth.getUser()` + `my_rep_profile` RLS view). This is a direct code duplication with drift risk.
- **`completed_leads` ownership conflict**: The `PromotionService` updates `completed_leads` status internally. `CaptureLeadPage.handleSaveAndNext` also calls `buildCompletedLead` + `saveCompletedLead` directly for the offline path and retryable error path. This means `completed_leads` status transitions are split across three locations: the promotion service (synced), `handleSaveAndNext` (pending_sync, two paths), and `handleQrScanned` / `handleCardComplete` (local_only / pending_sync). The Processing Engine should own all of these.
- **No rollback between INSERT and UPDATE**: If `lead_entries` INSERT succeeds but the subsequent `capture_sessions` UPDATE fails, the session row is left without `promoted_lead_id`, meaning the next idempotency check will attempt to insert a duplicate lead. The idempotency guard reads `promoted_lead_id` — if that UPDATE never set it, the guard does not trigger. This is a latent bug survivable only by RLS unique constraints on the backend. Worth documenting.
- **`_updateCompletedLead` receives `_leadId` as a named-but-ignored parameter** (prefixed with `_`). The function builds a new `buildCompletedLead` and sets `lead.status = 'synced'` but never writes the `leadId` back into the `CompletedLead` record. Future code that reads `completedLead.backendLeadId` will find it absent.

**Future role inside the Processing Engine**

`executePromotion` is the terminal step of the pipeline. The Processing Engine calls it directly. The SyncCallbacks adapter (`syncPromoteSession`) is a queue-replay concern and stays in `captureBackendSync`. The IndexedDB `completed_leads` update should move out of the promotion service and into the Processing Engine's own completion handler.

---

## 2. Cross-Cutting Findings

---

### 2.1 Duplicated `getAuthIdentity`

Both `captureBackendSync.ts` (line 50) and `capturePromotionService.ts` (line 37) contain identical `getAuthIdentity()` implementations. They both call `supabase.auth.getUser()` and then `supabase.from('my_rep_profile').select('rep_code').maybeSingle()`. They return the same `AuthIdentity` shape.

This is a direct duplication. Any change to the auth lookup pattern (e.g. switching to a different profile view) must be applied in two places. The fix is a shared private module — `captureAuth.ts` — exporting a single `getAuthIdentity()`. This is the smallest pre-Engine cleanup that removes a concrete drift risk.

---

### 2.2 `completed_leads` Status Transitions Are Split Across Three Owners

| Status written | Written by | Location |
|---|---|---|
| `'local_only'` | `handleQrScanned`, `handleCardComplete` | `CaptureLeadPage.tsx` |
| `'pending_sync'` | `handleSaveAndNext` (offline path) | `CaptureLeadPage.tsx` |
| `'pending_sync'` | `handleSaveAndNext` (retryable error path) | `CaptureLeadPage.tsx` |
| `'synced'` | `_updateCompletedLead` | `capturePromotionService.ts` |

The `completed_leads` store is an IndexedDB representation of pipeline progress. Its status transitions are semantically part of the Processing Engine — they describe where a lead is in the pipeline. Today they are scattered because the pipeline has no owner. This is the most architecturally significant gap.

---

### 2.3 `syncedVisionAssetsRef` — Dedup Guard Lives in the UI

`CaptureLeadPage` holds `syncedVisionAssetsRef = useRef(new Set<string>())`. This ref tracks which asset IDs have already had a Vision extraction row written, so `handleOcrResult` skips a duplicate Tesseract row. This is pipeline-level deduplication logic sitting in a React ref inside a UI component. It must move to the Processing Engine.

---

### 2.4 Offline Enqueue Decisions Live in `CaptureLeadPage`

All `enqueueOp(...)` calls are inside `CaptureLeadPage`: in `syncSessionOp`, `syncAssetOp`, `syncOcrOp`, `syncQrOp`, `syncVisionExtractionOp`, `syncFieldsOp`, and `handleSaveAndNext`. The page decides whether to call the backend transport immediately or write to the offline queue. This is a routing/orchestration decision that belongs in the Processing Engine.

---

### 2.5 No Circular References

The dependency graph is clean:

```
CaptureLeadPage
  → useCaptureSession → captureProfile, types
  → captureBackendSync → capturePromotionService → completedLeadsStorage, deriveState
  → captureOfflineQueue → captureBackendSync
  → captureEvidenceManager → assetStorageUpload
  → capturePromotionService (direct)
  → completedLeadsStorage (direct, for offline/error paths)
```

There are no circular imports.

---

### 2.6 Responsibilities Still Living Inside `CaptureLeadPage`

These remain in the UI and should move to the Processing Engine:

| Responsibility | Where | Comment |
|---|---|---|
| Enqueue decisions (all 6 sync ops) | `syncSessionOp` … `syncFieldsOp` | UI decides online/offline routing |
| Extraction trigger (Vision/OCR) | `handleVisionResult`, `handleOcrResult` | Decides when to write extraction_results |
| Extraction dedup guard | `syncedVisionAssetsRef` | React ref holding pipeline logic |
| Error classification (retryable vs not) | `handleSaveAndNext` | Inline string matching on error messages |
| Promotion enqueue decision | `handleSaveAndNext` | Decides to call `executePromotion` vs `enqueueOp` |
| `completed_leads` status for offline/error | `handleSaveAndNext` | Writes `pending_sync` directly |
| Pending op badge counter | `setPendingSyncCount` | Correct in UI — display only |
| Draft field sync debounce timer | `fieldSyncTimerRef` | Timer is UI concern; the sync decision is not |

---

## 3. Processing Engine Readiness Assessment

### Is the current architecture ready?

**Not yet — but it is close.** The four components are individually well-designed. Their public APIs are clean, their internal logic is isolated, and there are no circular dependencies. The gap is that `CaptureLeadPage` still acts as the pipeline orchestrator for everything between session creation and promotion. Before the Processing Engine can be introduced, two things must be true:

1. The Engine must have a stable input contract (a snapshot of `CaptureSession` + event context)
2. The Engine must not need to call back into React state to do its work

Neither is fully achievable today because of the two issues below.

---

### Smallest Remaining Refactoring Required

These are listed in dependency order — each enables the next.

---

#### R1 — Extract shared `getAuthIdentity` (1 file, ~15 lines)

**Current state:** Duplicated in `captureBackendSync.ts` and `capturePromotionService.ts`.

**Required change:** Create `src/capture/captureAuth.ts` exporting a single `getAuthIdentity(): Promise<AuthIdentity | null>`. Both modules import from it.

**Why this is needed first:** The Processing Engine will also need auth identity. A third duplicate would make the drift problem permanent.

---

#### R2 — Move `completed_leads` status ownership to a single coordinator

**Current state:** `pending_sync` is written by `CaptureLeadPage`; `synced` is written by `capturePromotionService` inside `_updateCompletedLead`.

**Required change:** Define a `CompletedLeadsCoordinator` (or add lifecycle methods to `completedLeadsStorage`) that accepts a `sessionId` and a status transition intent, and performs the write. Both `capturePromotionService` and the future Processing Engine call this coordinator. `CaptureLeadPage` calls it only for the offline/error paths until those paths move to the Engine.

**Why this is needed:** Without a single owner, the Engine cannot reliably know the current status of a lead it is processing, and status can be written in conflicting ways.

---

#### R3 — Move extraction dedup guard out of React state

**Current state:** `syncedVisionAssetsRef = useRef(new Set<string>())` in `CaptureLeadPage`.

**Required change:** This set belongs in a non-React location co-located with whichever module triggers extraction result sync — ultimately the Processing Engine. As a minimal pre-step, move it into a module-level variable in a new `captureExtractionCoordinator.ts` (or into the Engine directly when it is built). Do not leave it in a `useRef`.

**Why this is needed:** The Engine must own dedup. If the ref stays in React, the Engine cannot deduplicate without coupling back to the component.

---

#### R4 (Optional pre-step) — Fix the `_leadId` gap in `_updateCompletedLead`

**Current state:** `_updateCompletedLead` receives `leadId` but never persists it to the `CompletedLead` record. The record is saved with `status: 'synced'` but without the `backendLeadId`.

**Required change:** `buildCompletedLead` or `_updateCompletedLead` should set `lead.backendLeadId = leadId` before saving. This is a pre-Engine fix because the Engine will read `backendLeadId` from completed leads to determine whether to re-promote.

---

### What does NOT need to change before introducing the Engine

- `CaptureProfile` — ready as-is
- `captureEvidenceManager` — ready; API is stable for Engine use
- `executePromotion` — ready as the terminal pipeline step (after R1)
- `captureOfflineQueue` — ready; queue dispatch is already isolated
- `captureBackendSync` transport functions — ready; they are already pure transport with callback injection
- `useCaptureSession` — the hook stays in the UI; the Engine receives a plain snapshot, not the hook

---

### Summary Table

| Component | Ready for Engine? | Blocker |
|---|---|---|
| `captureProfile.ts` | Yes | None |
| `useCaptureSession.ts` | Yes (as data source) | Engine receives snapshot, not hook |
| `captureEvidenceManager.ts` | Yes | Minor: `uploadImmediately` field redundancy |
| `capturePromotionService.ts` | Mostly | R1 (shared auth), R2 (completed_leads), R4 (leadId gap) |
| `captureBackendSync.ts` | Yes | R1 (shared auth duplicate) |
| `captureOfflineQueue.ts` | Yes | None |
| `CaptureLeadPage.tsx` | Partial | R3 (dedup ref), enqueue routing, error classification must move to Engine |
