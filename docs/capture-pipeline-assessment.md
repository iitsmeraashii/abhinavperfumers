# Capture Processing Pipeline Assessment

> **Type:** Architecture assessment — read-only analysis
> **Date:** 2026-07-03
> **Scope:** Complete execution path from "Save & Next Lead" to `lead_entries` row
> **Purpose:** Identify orchestration responsibilities to inform the future Capture Processing Engine extraction

---

## 1. Reading Order

This document traces two parallel concerns:

- **Processing steps** — what happens, in what order, with what inputs/outputs
- **Responsibility mapping** — which component owns each step today, and where it should live tomorrow

The final section (Section 4) summarises the full responsibility map.

---

## 2. Complete Processing Pipeline — Execution Order

Each step lists: responsible file, responsible function, inputs, outputs, side effects, and future ownership.

---

### PHASE 0 — Session Establishment (before Save & Next)

These steps execute earlier in the lifecycle but are part of the pipeline that Save & Next depends on.

---

#### Step 0.1 — Create Capture Session

| | |
|---|---|
| **File** | `CaptureLeadPage.tsx` |
| **Function** | `handleMethodSelect` → `actions.startCapture(method)` |
| **Input** | Capture method: `'BUSINESS_CARD' \| 'QR' \| 'MANUAL'` |
| **Output** | Stable `backendSessionId` (UUID, generated on frontend) |
| **Side effects** | React state updated to `CAPTURING`; autosave begins |
| **Also triggers** | `syncSessionOp` → `captureBackendSync.syncUpsertSession` |
| **Current responsibility** | `CaptureLeadPage.tsx` (UI orchestration) |
| **Future responsibility** | Remains in UI layer — session start is a user action response |

---

#### Step 0.2 — Sync Session to Backend

| | |
|---|---|
| **File** | `CaptureLeadPage.tsx`, `captureBackendSync.ts` |
| **Function** | `syncSessionOp` wrapper → `syncUpsertSession(payload, cbs)` |
| **Input** | `backendSessionId`, `captureMethod`, `draftData`, `eventCode`, `captureProfile` |
| **Output** | Confirmed `backendSessionId` returned via `onSynced` callback |
| **Side effects** | `capture_sessions` row created or updated in Supabase; `BackendSyncState.status` updated in React state |
| **Offline** | Enqueued as `upsert_session` op to `pending_ops` IndexedDB store |
| **Current responsibility** | `CaptureLeadPage.tsx` (orchestration) + `captureBackendSync.ts` (transport) |
| **Future responsibility** | Transport remains in `captureBackendSync`; orchestration could move to Processing Engine for non-interactive re-syncs |

---

#### Step 0.3 — Capture Business Card Image (Business Card path only)

| | |
|---|---|
| **File** | `CaptureLeadPage.tsx`, `captureAssetStorage.ts` |
| **Function** | `handleCardAssetsChanged` → `captureAssetStorage.saveAsset` |
| **Input** | Raw image dataURL from camera |
| **Output** | `BusinessCardAsset` object: `{ id, sessionId, side, dataUrl, mimeType, dimensions, sizeBytes }` |
| **Side effects** | Compressed JPEG data URL written to IndexedDB `assets` store (max 1200 px, quality 0.82) |
| **Current responsibility** | `captureAssetStorage.ts` (storage service) — correctly placed |
| **Future responsibility** | Remains in storage service |

---

#### Step 0.4 — Register Asset Metadata

| | |
|---|---|
| **File** | `CaptureLeadPage.tsx`, `captureBackendSync.ts` |
| **Function** | `syncAssetOp` wrapper → `syncUpsertAsset(payload, cbs)` |
| **Input** | `BusinessCardAsset` (id, sessionId, side, dimensions, mimeType, sizeBytes) |
| **Output** | Backend `capture_assets` row confirmed via `onSynced`; `backendAssetId` in `BackendSyncState` |
| **Side effects** | `capture_assets` row upserted in Supabase |
| **Offline** | Enqueued as `upsert_asset` op |
| **Note** | Only the first asset (front ?? back) is synced if both are present — back card gap documented in v2 arch doc |
| **Current responsibility** | `CaptureLeadPage.tsx` (orchestration) + `captureBackendSync.ts` (transport) |
| **Future responsibility** | Asset Manager service (planned) |

---

#### Step 0.5 — Upload Asset Bytes to Supabase Storage

| | |
|---|---|
| **File** | `CaptureLeadPage.tsx`, `assetStorageUpload.ts` |
| **Function** | `handleCardAssetsChanged` → `uploadBusinessCardAsset(asset)` |
| **Input** | `BusinessCardAsset` including `dataUrl` |
| **Output** | `capture_assets.storage_path` set, `storage_upload_status: 'uploaded'` |
| **Side effects** | Image bytes written to `lead-evidence/{userId}/{assetId}.jpg`; `capture_assets` row updated |
| **Online only** | No-op if offline; no retry queued |
| **Current responsibility** | `CaptureLeadPage.tsx` (orchestration) + `assetStorageUpload.ts` (transport) |
| **Future responsibility** | Upload Queue / Asset Manager (planned) — should be retried on reconnect |

---

#### Step 0.6 — Run Extraction (Business Card path only)

| | |
|---|---|
| **File** | `CaptureLeadPage.tsx`, `useVisionExtraction.ts`, `ocrFallback.ts`, `parseBusinessCard.ts` |
| **Function** | `useVisionExtraction.runExtraction(assetId, dataUrl)` |
| **Input** | `assetId` (UUID), image data URL |
| **Output** | `VisionResult { fields, source, durationMs, fieldConfidence, attempt }` |
| **Attempt 1** | POST to `extract-business-card` edge function → OpenAI GPT-4o structured output |
| **Attempt 2 (fallback)** | Tesseract.js Web Worker → `parseBusinessCard.parseBusinessCardText` → heuristic field classification |
| **Side effects** | None — extraction is pure computation returning a `VisionResult` |
| **Current responsibility** | `useVisionExtraction.ts` (extraction hook) — correctly placed |
| **Future responsibility** | Processing Engine — extraction is the canonical example of deferred background work |

---

#### Step 0.7 — Apply Extraction to Session Draft

| | |
|---|---|
| **File** | `CaptureLeadPage.tsx` |
| **Function** | `handleVisionResult(result)` or `applyVisionResult(result)` |
| **Input** | `VisionResult` |
| **Output** | `draftData` patched with extracted fields (clientName, company, phone, email, designation, website, address, etc.) |
| **Side effects** | `actions.patchDraft(fields)` → React state update → autosave triggered (600ms debounce) |
| **Current responsibility** | `CaptureLeadPage.tsx` (UI orchestration) |
| **Future responsibility** | Partially Processing Engine (field merging logic); UI retains rendering of results |

---

#### Step 0.8 — Sync Vision Extraction Result

| | |
|---|---|
| **File** | `CaptureLeadPage.tsx`, `captureBackendSync.ts` |
| **Function** | `syncVisionExtractionOp` wrapper → `syncUpsertVisionExtraction(payload, cbs)` |
| **Input** | `VisionResult`, `backendSessionId`, `backendAssetId` (from `BackendSyncState`) |
| **Output** | `extraction_results` row with `engine: 'openai_vision'` |
| **Side effects** | Supabase `extraction_results` upsert; `backendExtractionIds` updated in `BackendSyncState` |
| **Dedup guard** | `syncedVisionAssetsRef.add(assetId)` — prevents duplicate `tesseract_ocr` row for the same asset when OCR fires after Vision succeeds |
| **Offline** | Enqueued as `upsert_vision_extraction` op |
| **Current responsibility** | `CaptureLeadPage.tsx` (orchestration) + `captureBackendSync.ts` (transport) |
| **Future responsibility** | Processing Engine owns extraction result persistence |

---

#### Step 0.9 — Sync OCR Extraction Result (Tesseract fallback path only)

| | |
|---|---|
| **File** | `CaptureLeadPage.tsx`, `captureBackendSync.ts` |
| **Function** | `handleOcrResult` → `syncOcrOp` wrapper → `syncUpsertOcrExtraction(payload, cbs)` |
| **Input** | `OcrResult { assetId, rawText, fields, confidence, inferredFields, ignoredLines }` |
| **Dedup guard** | Skips if `syncedVisionAssetsRef.has(assetId)` — Vision already wrote the row |
| **Output** | `extraction_results` row with `engine: 'tesseract_ocr'` |
| **Side effects** | Supabase `extraction_results` upsert; `backendExtractionIds` updated |
| **Offline** | Enqueued as `upsert_ocr_extraction` op |
| **Current responsibility** | `CaptureLeadPage.tsx` (orchestration) + `captureBackendSync.ts` (transport) |
| **Future responsibility** | Processing Engine |

---

#### Step 0.10 — QR Parse and Apply (QR path only)

| | |
|---|---|
| **File** | `CaptureLeadPage.tsx`, `parseQrPayload.ts` |
| **Function** | `handleQrScanned(parsed)` |
| **Input** | `ParsedContact { fields, raw, qrType, confidence }` — already parsed by `useQrScanner` |
| **Output** | Draft seeded with QR-extracted fields; session transitioned to `'MANUAL'` |
| **Side effects** | `actions.startCaptureWithDraft('MANUAL', draft)`; `completed_leads` saved with `pending_sync` |
| **Current responsibility** | `CaptureLeadPage.tsx` |
| **Future responsibility** | Remains in UI (QR is synchronous; no async processing needed) |

---

#### Step 0.11 — Sync QR Extraction Result (QR path only)

| | |
|---|---|
| **File** | `CaptureLeadPage.tsx`, `captureBackendSync.ts` |
| **Function** | `syncQrOp` wrapper → `syncUpsertQrExtraction(payload, cbs)` |
| **Input** | `ParsedContact`, `backendSessionId` |
| **Output** | `extraction_results` row with `engine: 'qr_parser'` |
| **Side effects** | Supabase `extraction_results` upsert |
| **Offline** | Enqueued as `upsert_qr_extraction` op |
| **Current responsibility** | `CaptureLeadPage.tsx` + `captureBackendSync.ts` |
| **Future responsibility** | Processing Engine (consistent with other extraction result writes) |

---

#### Step 0.12 — Sync Session Field Updates (all paths, debounced)

| | |
|---|---|
| **File** | `CaptureLeadPage.tsx`, `captureBackendSync.ts` |
| **Function** | `syncFieldsOp` (debounced 1500ms) → `syncUpdateSessionFields(sessionId, draftData, cbs)` |
| **Input** | `backendSessionId`, current `draftData` snapshot |
| **Output** | `capture_sessions` row updated with latest field values |
| **Side effects** | Supabase `capture_sessions` UPDATE |
| **Offline** | Enqueued as `update_session_fields` op |
| **Current responsibility** | `CaptureLeadPage.tsx` (orchestration) + `captureBackendSync.ts` (transport) |
| **Future responsibility** | Remains split — UI debounce trigger is appropriate; transport in `captureBackendSync` |

---

### PHASE 1 — Save & Next Triggered

The rep taps "Save & Next Lead" or "Save Lead". `CaptureLeadPage.handleSaveAndNext` runs.

---

#### Step 1.1 — Guard: Validate Session Has Data

| | |
|---|---|
| **File** | `CaptureLeadPage.tsx` |
| **Function** | `handleSaveAndNext` |
| **Input** | Current `CaptureSession` via `sessionRef.current` |
| **Output** | Early exit if `sessionStatus === 'IDLE'` or `backendSessionId === null` |
| **Side effects** | Calls `form.handleReset()` and `actions.resetSession()` on early exit |
| **Current responsibility** | `CaptureLeadPage.tsx` (UI guard) |
| **Future responsibility** | Remains in UI layer |

---

#### Step 1.2 — Upload Notes Image (if present, online only)

| | |
|---|---|
| **File** | `CaptureLeadPage.tsx`, `assetStorageUpload.ts` |
| **Function** | `handleSaveAndNext` → `uploadNotesImage(bsid, dataUrl)` |
| **Input** | `backendSessionId`, `draftData.notesImageDataUrl` (must start with `'data:'`) |
| **Output** | Notes image bytes written to `lead-evidence/{userId}/{sessionId}/notes.jpg` |
| **Side effects** | `capture_assets` row upserted with `asset_type: 'notes_image'`; `capture_sessions.notes_image_url` updated to storage path (replacing raw data URL) |
| **Online only** | Skipped entirely if offline; not queued; raw data URL remains unreplaced |
| **Current responsibility** | `CaptureLeadPage.tsx` (orchestration) + `assetStorageUpload.ts` (transport) |
| **Future responsibility** | Upload Queue / Processing Engine — this should be queued and retried offline |

---

#### Step 1.3 — Build Promotion Options

| | |
|---|---|
| **File** | `CaptureLeadPage.tsx` |
| **Function** | `handleSaveAndNext` — inline object construction |
| **Input** | `backendSessionId`, `draftData`, `selectedEvent`, `captureMethod` from session state |
| **Output** | `PromoteSessionOptions` object: `{ backendSessionId, draftData, eventCode, completedLeadId, captureMethod, eventId, eventName }` |
| **Side effects** | None |
| **Current responsibility** | `CaptureLeadPage.tsx` |
| **Future responsibility** | Processing Engine builds promotion payload from its own context |

---

### PHASE 1A — Offline Path

Executed when `isOnline === false` at the moment of Save & Next.

---

#### Step 1A.1 — Save CompletedLead Locally (pending_sync)

| | |
|---|---|
| **File** | `CaptureLeadPage.tsx`, `completedLeadsStorage.ts` |
| **Function** | `handleSaveAndNext` → `buildCompletedLead(...)` + `saveCompletedLead(lead)` |
| **Input** | `sessionId`, `captureMethod`, `draftData`, `backendSessionId`, `eventId`, `eventName` |
| **Output** | `CompletedLead { status: 'pending_sync' }` persisted to IndexedDB `completed_leads` store |
| **Side effects** | IndexedDB write; lead visible on Queue page immediately |
| **Status logic** | `buildCompletedLead` returns `status: 'needs_review'` if clientName and company are both absent; otherwise `'local_only'` — caller overrides to `'pending_sync'` |
| **Current responsibility** | `CaptureLeadPage.tsx` (orchestration) + `completedLeadsStorage.ts` (storage) |
| **Future responsibility** | Processing Engine owns status transitions; storage service remains |

---

#### Step 1A.2 — Enqueue promote_session Op

| | |
|---|---|
| **File** | `CaptureLeadPage.tsx`, `captureOfflineQueue.ts` |
| **Function** | `handleSaveAndNext` → `enqueueOp('promote_session', bsid, promotionOptions)` |
| **Input** | `promotionOptions` (full `PromoteSessionOptions` including captureMethod, eventId, eventName) |
| **Output** | `PendingOp { id, type: 'promote_session', sessionId, createdAt, retries: 0, payload }` written to IndexedDB `pending_ops` store |
| **Side effects** | IndexedDB write; `pendingSyncCount` state incremented; `BackendSyncState.status` set to `'offline'` |
| **Current responsibility** | `CaptureLeadPage.tsx` (orchestration) + `captureOfflineQueue.ts` (queue) |
| **Future responsibility** | Processing Engine manages promotion queue entries |

#### Step 1A.3 — Reset UI

| | |
|---|---|
| **File** | `CaptureLeadPage.tsx` |
| **Function** | `handleSaveAndNext` |
| **Actions** | `form.handleReset()`, `actions.resetSession()`, `setQrScanning(false)`, `setCardSessionId('')`, `setCardAssets({ front: null, back: null })`, `setLastOcrResult(null)` |
| **Side effects** | React state reset; toast shown: "Lead saved — will sync when back online" |
| **Current responsibility** | UI layer — correctly placed |
| **Future responsibility** | Remains in UI layer |

---

### PHASE 1B — Online Path

Executed when `isOnline === true` at the moment of Save & Next.

---

#### Step 1B.1 — Call executePromotion

| | |
|---|---|
| **File** | `CaptureLeadPage.tsx`, `capturePromotionService.ts` |
| **Function** | `handleSaveAndNext` → `executePromotion(promotionOptions)` |
| **Input** | `PromoteSessionOptions { backendSessionId, draftData, eventCode, completedLeadId, captureMethod, eventId, eventName }` |
| **Output** | `PromoteSessionResult { leadId, error, alreadyPromoted }` |
| **Side effects** | See Steps 1B.2 through 1B.5 |
| **Current responsibility** | `CaptureLeadPage.tsx` (call site) + `capturePromotionService.ts` (execution) |
| **Future responsibility** | `capturePromotionService.executePromotion` is the Processing Engine's terminal step |

---

#### Step 1B.2 — Idempotency Check

| | |
|---|---|
| **File** | `capturePromotionService.ts` |
| **Function** | `executePromotion` — inline query |
| **Input** | `backendSessionId`, authenticated `userId` |
| **Output** | `promoted_lead_id` from `capture_sessions` row, if set |
| **Side effects** | None — read-only query |
| **If already promoted** | Calls `_updateCompletedLead` to mark local record `'synced'`, returns `{ alreadyPromoted: true }` |
| **Current responsibility** | `capturePromotionService.ts` (correctly placed) |
| **Future responsibility** | Remains in Promotion Service |

---

#### Step 1B.3 — Authenticate and Resolve Rep

| | |
|---|---|
| **File** | `capturePromotionService.ts` |
| **Function** | `getAuthIdentity()` |
| **Input** | Supabase auth session (cookie/JWT) |
| **Output** | `{ userId, repCode }` |
| **Side effects** | Two Supabase reads: `auth.getUser()` + `my_rep_profile` view |
| **Failure** | Returns `{ error: 'Not authenticated or rep profile unavailable' }` — non-retryable |
| **Current responsibility** | `capturePromotionService.ts` |
| **Future responsibility** | Remains in Promotion Service; or shared auth helper |

---

#### Step 1B.4 — Merge and Deduplicate Contact Arrays

| | |
|---|---|
| **File** | `capturePromotionService.ts` |
| **Function** | `executePromotion` — inline array construction |
| **Input** | `draftData.phone`, `draftData.phoneNumbers[]`, `draftData.email`, `draftData.emails[]` |
| **Output** | Deduplicated `phones[]` and `emails[]` |
| **Algorithm** | Primary field first; extras appended if not already present (case-sensitive string equality) |
| **Side effects** | None |
| **Current responsibility** | `capturePromotionService.ts` |
| **Future responsibility** | Remains in Promotion Service (field normalisation is a promotion concern) |

---

#### Step 1B.5 — Derive Indian State from Address

| | |
|---|---|
| **File** | `capturePromotionService.ts`, `deriveState.ts` |
| **Function** | `executePromotion` → `deriveState(address)` |
| **Input** | `draftData.address` string |
| **Output** | State name string (e.g. `"Maharashtra"`) or empty string |
| **Algorithm** | Heuristic keyword matching against a hardcoded list of Indian states |
| **Side effects** | None |
| **Current responsibility** | `capturePromotionService.ts` + `deriveState.ts` |
| **Future responsibility** | Remains in Promotion Service |

---

#### Step 1B.6 — Insert lead_entries Row

| | |
|---|---|
| **File** | `capturePromotionService.ts` |
| **Function** | `executePromotion` — Supabase insert |
| **Input** | All mapped fields from `draftData`, plus `repCode`, `eventCode`, generated `leadId` UUID |
| **Output** | New `lead_entries` row with `lead_status: 'NEW'`, `system_status: 'CREATED'` |
| **Field mappings** | `application[]` joined to comma-separated string; array fields (`quick_keywords`, `target_market`, `certification`, `benchmark`) passed as `text[]` |
| **Side effects** | Supabase INSERT into `lead_entries` |
| **On failure** | Returns `{ error: insertError.message }` — no row inserted, no partial state |
| **Current responsibility** | `capturePromotionService.ts` (correctly placed) |
| **Future responsibility** | Remains in Promotion Service |

---

#### Step 1B.7 — Update Capture Session Status

| | |
|---|---|
| **File** | `capturePromotionService.ts` |
| **Function** | `executePromotion` — Supabase update |
| **Input** | `backendSessionId`, `userId`, `leadId` |
| **Output** | `capture_sessions` row updated: `promoted_lead_id = leadId`, `session_status = 'promoted'` |
| **Side effects** | Supabase UPDATE |
| **Note** | This step executes unconditionally after a successful `lead_entries` INSERT — there is no rollback if this UPDATE fails |
| **Current responsibility** | `capturePromotionService.ts` (correctly placed) |
| **Future responsibility** | Remains in Promotion Service |

---

#### Step 1B.8 — Update completed_leads IndexedDB Record

| | |
|---|---|
| **File** | `capturePromotionService.ts`, `completedLeadsStorage.ts` |
| **Function** | `executePromotion` → `_updateCompletedLead(...)` → `buildCompletedLead` + `saveCompletedLead` |
| **Input** | `completedLeadId`, `captureMethod`, `draftData`, `backendSessionId`, `eventId`, `eventName`, `leadId` |
| **Output** | `CompletedLead { status: 'synced', syncedAt: now }` upserted to IndexedDB `completed_leads` store |
| **Side effects** | IndexedDB write; lead status visible on Queue page updates to "synced" |
| **Error handling** | IndexedDB errors are silently swallowed — failure here does not fail promotion |
| **Current responsibility** | `capturePromotionService.ts` (orchestration) + `completedLeadsStorage.ts` (storage) |
| **Future responsibility** | Processing Engine owns status transitions |

---

### PHASE 1C — Online Error Handling in handleSaveAndNext

---

#### Step 1C.1 — Classify Error

| | |
|---|---|
| **File** | `CaptureLeadPage.tsx` |
| **Function** | `handleSaveAndNext` — inline classification |
| **Input** | `result.error` string from `executePromotion` |
| **Output** | Boolean flags: `isAuthError`, `isPermError`, `isRetryable` |
| **Logic** | Auth errors and permission errors are non-retryable; all others are retryable |
| **Current responsibility** | `CaptureLeadPage.tsx` |
| **Future responsibility** | Error classification belongs in the Processing Engine; UI only reacts to the classified outcome |

---

#### Step 1C.2 — Retryable Error: Enqueue and Reset

| | |
|---|---|
| **File** | `CaptureLeadPage.tsx`, `completedLeadsStorage.ts`, `captureOfflineQueue.ts` |
| **Function** | `handleSaveAndNext` |
| **Actions** | `buildCompletedLead` + `saveCompletedLead({ status: 'pending_sync' })` + `enqueueOp('promote_session', ...)` |
| **Side effects** | IndexedDB writes; `pendingSyncCount` incremented; UI reset |
| **Current responsibility** | `CaptureLeadPage.tsx` (orchestration) |
| **Future responsibility** | Processing Engine handles retry decisions |

---

#### Step 1C.3 — Non-Retryable Error: Surface to Rep

| | |
|---|---|
| **File** | `CaptureLeadPage.tsx` |
| **Function** | `handleSaveAndNext` |
| **Actions** | `setPromotionToast({ isError: true, message: ... })` — form stays visible |
| **Side effects** | Toast shown for 8 seconds; session not reset |
| **Current responsibility** | UI layer — correctly placed |
| **Future responsibility** | Remains in UI layer |

---

### PHASE 2 — UI Reset (online success path)

---

#### Step 2.1 — Reset Session State

| | |
|---|---|
| **File** | `CaptureLeadPage.tsx` |
| **Function** | `handleSaveAndNext` |
| **Actions** | `form.handleReset()`, `actions.resetSession()`, `setQrScanning(false)`, `setCardSessionId('')`, `setCardAssets({ front: null, back: null })`, `setLastOcrResult(null)` |
| **Side effects** | React state reset to IDLE; toast shown: "Lead saved to your list!" |
| **Known gap** | `clearDraft()` is not called — draft persists in IndexedDB until autosave writes IDLE state. May trigger DraftRecoveryBanner on next hard reload for a successfully promoted session. |
| **Current responsibility** | UI layer — correctly placed |
| **Future responsibility** | Remains in UI layer |

---

### PHASE 3 — Queue Replay (when offline ops are flushed)

Executed when `window.online` fires and `handleReconnect` calls `flushQueue()`.

---

#### Step 3.1 — Online Event Detection

| | |
|---|---|
| **File** | `CaptureLeadPage.tsx`, `useOnlineStatus.ts` |
| **Function** | `useOnlineStatus({ onReconnect: handleReconnect })` |
| **Input** | `window` `online` event |
| **Output** | `isOnline` state set to `true`; `handleReconnect` called |
| **Current responsibility** | `useOnlineStatus.ts` (correctly placed) |
| **Future responsibility** | Remains as connectivity utility |

---

#### Step 3.2 — Load and Sort Queue

| | |
|---|---|
| **File** | `captureOfflineQueue.ts` |
| **Function** | `flushQueue()` |
| **Input** | All `PendingOp` records from IndexedDB `pending_ops` store |
| **Output** | Ops sorted by `createdAt` ascending |
| **Side effects** | `flushInProgress` guard set to prevent concurrent runs |
| **Current responsibility** | `captureOfflineQueue.ts` (correctly placed) |
| **Future responsibility** | Processing Engine manages its own queue |

---

#### Step 3.3 — Execute Each Op

For each op in creation order:

| | |
|---|---|
| **File** | `captureOfflineQueue.ts` |
| **Function** | `executeOp(op)` |
| **Dispatch** | Switch on `op.type` → calls corresponding `captureBackendSync` function |
| **Side effects (success)** | Op deleted from IndexedDB; `flushed` counter incremented |
| **Side effects (retryable error)** | Op `retries` incremented; op kept in queue |
| **Side effects (auth error)** | Op deleted permanently (non-retryable) |
| **Stops early** | If `!navigator.onLine` during flush |

**Op type → function mapping during replay:**

| Op type | Function called | Terminal result |
|---|---|---|
| `upsert_session` | `syncUpsertSession` | `capture_sessions` row upserted |
| `upsert_asset` | `syncUpsertAsset` | `capture_assets` row upserted |
| `upsert_ocr_extraction` | `syncUpsertOcrExtraction` | `extraction_results` row (`tesseract_ocr`) |
| `upsert_qr_extraction` | `syncUpsertQrExtraction` | `extraction_results` row (`qr_parser`) |
| `upsert_vision_extraction` | `syncUpsertVisionExtraction` | `extraction_results` row (`openai_vision`) |
| `update_session_fields` | `syncUpdateSessionFields` | `capture_sessions` field update |
| `promote_session` | `syncPromoteSession` → `executePromotion` | `lead_entries` INSERT + all of Phase 1B |

---

#### Step 3.4 — promote_session Op Replay

When `op.type === 'promote_session'` is reached during flush:

| | |
|---|---|
| **File** | `captureOfflineQueue.ts`, `captureBackendSync.ts`, `capturePromotionService.ts` |
| **Function** | `executeOp` → `syncPromoteSession(payload, cbs)` → `executePromotion(payload)` |
| **Input** | Full `PromoteSessionOptions` payload (including `captureMethod`, `eventId`, `eventName`) |
| **Output** | Same as Steps 1B.2 through 1B.8 |
| **Idempotency** | Step 1B.2 (idempotency check) prevents duplicate `lead_entries` row |
| **Side effects** | `lead_entries` INSERT; `capture_sessions` UPDATE; IndexedDB `completed_leads` updated to `'synced'`; op deleted from queue |
| **Current responsibility** | `captureOfflineQueue.ts` (dispatch) + `captureBackendSync.ts` (adapter) + `capturePromotionService.ts` (execution) |
| **Future responsibility** | Processing Engine owns the full replay execution |

---

## 3. Orchestration Location Map

The following table shows where orchestration for each concern currently lives.

| Concern | Currently orchestrated in | Problem |
|---|---|---|
| Session creation | `CaptureLeadPage.tsx` | Correct — user action response |
| Session sync to backend | `CaptureLeadPage.tsx` | Mixed — wiring is in UI; transport in `captureBackendSync` |
| Asset registration | `CaptureLeadPage.tsx` | Should be in Asset Manager |
| Asset bytes upload | `CaptureLeadPage.tsx` + `assetStorageUpload.ts` | Not queued; online-only; no retry |
| Vision extraction trigger | `CaptureLeadPage.tsx` | Should be in Processing Engine |
| Vision extraction execution | `useVisionExtraction.ts` | Correctly isolated |
| OCR extraction trigger | `CaptureLeadPage.tsx` | Should be in Processing Engine |
| OCR extraction execution | `useOcr.ts` + `ocrFallback.ts` | Correctly isolated |
| Extraction result sync | `CaptureLeadPage.tsx` | Should be in Processing Engine |
| Extraction dedup guard | `CaptureLeadPage.tsx` (`syncedVisionAssetsRef`) | Belongs in Processing Engine |
| Draft patching with extracted fields | `CaptureLeadPage.tsx` | UI concern — showing results to rep |
| Field sync to backend | `CaptureLeadPage.tsx` | Debounce wiring is UI; transport is correct |
| Notes image upload | `CaptureLeadPage.tsx` + `assetStorageUpload.ts` | Not queued; skipped offline |
| Error classification (retryable vs not) | `CaptureLeadPage.tsx` | Should be in Processing Engine |
| Promotion options assembly | `CaptureLeadPage.tsx` | Should be in Processing Engine |
| Promotion execution (idempotency + insert + update) | `capturePromotionService.ts` | Correctly isolated |
| completed_leads status tracking | `CaptureLeadPage.tsx` + `capturePromotionService.ts` | Mixed |
| Queue enqueue | `CaptureLeadPage.tsx` | Processing Engine should own enqueue decisions |
| Queue flush | `captureOfflineQueue.ts` | Correctly isolated |
| Queue replay dispatch | `captureOfflineQueue.ts` | Correctly isolated |
| UI reset after save | `CaptureLeadPage.tsx` | Correctly in UI |

---

## 4. Responsibility Map — Current vs Future

### Responsibilities that should move into the future Capture Processing Engine

These are the processing steps that are currently scattered through `CaptureLeadPage.tsx` but have no business being in a UI component:

1. **Extraction trigger and orchestration** — deciding when to run Vision vs OCR, passing the result between extraction and sync, managing the dedup guard (`syncedVisionAssetsRef`). Currently in `CaptureLeadPage.tsx` directly.

2. **Extraction result persistence** — `syncOcrOp`, `syncVisionExtractionOp`, `syncQrOp` calls and their offline enqueue decisions. Currently in `CaptureLeadPage.tsx`.

3. **Asset upload scheduling** — `uploadBusinessCardAsset` and `uploadNotesImage` calls. Currently fire-and-forget from `CaptureLeadPage.tsx` with no retry.

4. **Error classification** — retryable vs non-retryable promotion error logic. Currently inline in `handleSaveAndNext`.

5. **Promotion enqueue decision** — whether to call `executePromotion` immediately or enqueue `promote_session`. Currently in `handleSaveAndNext`.

6. **completed_leads status transitions** — `pending_sync → synced` updates on promotion. Currently split between `CaptureLeadPage.tsx` and `capturePromotionService.ts`.

7. **Queue replay dispatch for processing ops** — `upsert_ocr_extraction`, `upsert_vision_extraction`, `upsert_asset`, `promote_session`. Currently in `captureOfflineQueue.executeOp`.

### Responsibilities that should remain inside UI components

1. **Capture method selection** — `handleMethodSelect` responds to a user action.
2. **Camera/QR scanner UI lifecycle** — opening/closing scanner, capturing images.
3. **Draft field display** — rendering extracted fields in `ManualEntryForm`.
4. **Save & Next button handler** — the entry point into the pipeline; validates session, triggers the engine, handles non-retryable errors.
5. **Toast notifications** — success/failure feedback to rep.
6. **Session reset after save** — clearing form state, card assets, QR scanner.
7. **Draft recovery banner** — prompting rep to continue or discard on reload.
8. **Pending sync count badge** — reading queue depth for the UI indicator.
9. **Reconnect handler wiring** — `useOnlineStatus({ onReconnect: handleReconnect })`.

### Responsibilities that should remain inside dedicated services (as today)

| Service | Responsibilities |
|---|---|
| `captureBackendSync.ts` | All Supabase transport: upsert functions, SyncCallbacks adaptation, `getAuthIdentity` |
| `capturePromotionService.ts` | Idempotency check, `lead_entries` INSERT, `capture_sessions` UPDATE — the terminal promotion step |
| `captureOfflineQueue.ts` | Queue read/write, flush guard, op retry logic, error classification at flush time |
| `completedLeadsStorage.ts` | IndexedDB CRUD for `completed_leads` store |
| `captureAssetStorage.ts` | IndexedDB CRUD for `assets` store, canvas compression |
| `assetStorageUpload.ts` | Supabase Storage upload transport (already isolated; needs a queue caller) |
| `captureDraftStorage.ts` | IndexedDB CRUD for `drafts` store |
| `useVisionExtraction.ts` | Vision and OCR extraction execution (already isolated) |
| `useOnlineStatus.ts` | Connectivity detection and reconnect callback wiring |
| `deriveState.ts` | Indian state heuristic (pure function, no changes needed) |

---

## 5. Summary: What the Future Capture Processing Engine Must Own

The Processing Engine is the missing orchestration layer between the UI (capture screen) and the services (transport, storage, extraction). It does not need to exist as a React component. It is a pure TypeScript module that the UI calls once and which drives the full pipeline to completion.

**Minimum scope for the initial Processing Engine:**

1. Accept a `CaptureSession` snapshot as input
2. Decide whether to run immediately or enqueue (online/offline check)
3. Orchestrate asset upload → extraction result sync → field update → promotion in the correct order
4. Own all `pending_ops` enqueue decisions
5. Own all `completed_leads` status transitions
6. Own error classification and retry policy
7. Return a `ProcessingResult` to the UI (success, queued, failed) so the UI can reset and show feedback

**The UI's only job after Save & Next:**
- Call the Processing Engine with the current session
- On `success` or `queued` — reset form and show toast
- On `failed` (non-retryable) — keep form visible and show error

Everything in between is the engine's responsibility.
