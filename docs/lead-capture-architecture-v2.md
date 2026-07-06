# Lead Capture Architecture v2

> **Supersedes:** `lead-capture-exhibit-architecture.md`
> **Status:** Current implementation as of 2026-07-03

---

## 1. Architecture Overview

The Lead Capture module is an **offline-first capture pipeline** built for field sales representatives at trade exhibitions. Its primary constraint is that network connectivity at exhibition venues is unreliable: reps capture leads continuously regardless of signal, and all data must survive a page reload, a device reboot, or an extended period of no connectivity.

The module supports three capture methods:

- **Business Card** — rep photographs the card; OpenAI Vision extracts contact fields via a Supabase Edge Function (`extract-business-card`), with Tesseract.js OCR as an automatic in-browser fallback.
- **QR Code** — rep scans a QR code (vCard, MeCard, URL, or plain text); the payload is parsed entirely in-browser with no network call.
- **Manual Entry** — rep types contact details directly into a form.

All three methods funnel into the same **capture session → extraction results → promotion → lead entry** pipeline regardless of how data was acquired.

### Architectural Principles

1. **Capture First. Process Later.** The platform is evolving toward a fully asynchronous processing pipeline. Today, CRM performs extraction synchronously, while the long-term architecture moves processing into a shared background pipeline used by both CRM and Exhibition profiles.
2. **Capture Session Is the Source of Truth Until Promotion.** The `capture_sessions` Supabase row and the local `drafts` IndexedDB store are authoritative during the capture window.
3. **`lead_entries` Is the CRM Representation.** Once promoted, the `lead_entries` row is the canonical CRM record and enters the standard lead lifecycle.
4. **CRM and Exhibition Share the Same Backend Pipeline.** One pipeline, one set of Supabase tables, one promotion service. Profile determines timing, not structure.
5. **Connectivity Is Not a Profile.** Connectivity only determines whether background processing runs immediately or waits in the queue.
6. **All sync IDs are frontend-generated.** Every upsert uses a stable `crypto.randomUUID()` generated before any network call, making every sync operation safely idempotent and replayable.
7. **No sync operation blocks the UI.** All backend sync functions are fire-and-forget.

---

## 2. Capture Session Architecture

**Supabase table:** `capture_sessions`
**Local store:** `drafts` (IndexedDB, single active record, key `'active_capture_draft'`)
**Primary modules:** `useCaptureSession.ts`, `captureDraftStorage.ts`, `captureBackendSync.ts`

### What a capture session holds

| Field | Description |
|---|---|
| `capture_method` | `BUSINESS_CARD \| QR \| MANUAL` |
| `session_status` | `capturing \| promoted \| abandoned` |
| `extracted_fields` | jsonb — current best-known contact fields |
| `phones`, `emails` | Denormalised contact arrays |
| `lead_temperature`, `lead_type`, `previous_rep_code` | Enrichment fields |
| `application`, `price_range`, `quick_keywords`, `target_market`, `certification`, `benchmark` | Business detail arrays |
| `notes_image_url` | Storage path after upload; raw data URL before |
| `voice_note_duration_ms`, `voice_note_transcript` | Audio fields (schema reserved) |
| `local_draft_key` | Always `'active_capture_draft'` |
| `promoted_lead_id` | FK to `lead_entries.id`, set on promotion |
| `event_id` | FK to the active event |

### Local session state machine

```
IDLE
  └─ (method selected) ──→ CAPTURING
                              └─ (fields edited) ──→ DRAFT
                                   └─ (Save & Next) ──→ IDLE (session cleared locally)
```

`READY_FOR_REVIEW` is defined in the `SessionStatus` type but is not yet assigned by any code path.

Sync state (`BackendSyncState`) runs in parallel to local session state and is never awaited by the UI: `idle → syncing → synced | error | offline`.

### Autosave — `useAutosave`

- Debounces writes to the `drafts` IndexedDB store at **600 ms** after any `draftData`, `sessionStatus`, or `captureMethod` change.
- Sync-only state changes (pending op counter, sync status) are deliberately excluded from the debounce key — they never trigger unnecessary IndexedDB writes.
- Flushes immediately on `visibilitychange` (hidden), `beforeunload`, and `pagehide` to survive iOS Safari suspension.
- The save state (`idle | saving | saved | offline_saved | unsaved`) is reported to the caller via `onSaveStateChange`.

### Draft recovery

On mount, `CaptureLeadPage` loads the `drafts` store. If a non-IDLE draft is found, it is held in `pendingDraft` state and presented to the rep as a `DraftRecoveryBanner` with **Continue** and **Discard** options.

- **Continue** — restores the session and re-syncs to the backend if online.
- **Discard** — calls `syncAbandonSession` if online, clears IndexedDB assets and draft.

Restored drafts deserialize `captureProfile` from the persisted record; drafts written before the profile field existed fall back to `'CRM'`.

### `CaptureSession` shape (React state)

```typescript
interface CaptureSession {
  captureMethod:     CaptureMethod | null;
  sessionStatus:     SessionStatus;
  captureProfile:    CaptureProfile;         // 'CRM' | 'EXHIBITION'
  createdAt:         Date | null;
  updatedAt:         Date | null;
  draftData:         DraftData;
  hasUnsavedChanges: boolean;
  sync:              BackendSyncState;
}
```

### `PersistedDraft` shape (IndexedDB)

`captureProfile` is persisted alongside all other session fields so it survives page reloads. Drafts that predate the field fall back to `'CRM'`.

---

## 3. Capture Assets Architecture

**Supabase table:** `capture_assets`
**Local store:** `assets` (IndexedDB, keyed by `asset.id`, indexed by `sessionId`)
**Primary modules:** `captureAssetStorage.ts`, `captureBackendSync.ts`, `assetStorageUpload.ts`

### What a capture asset holds

| Field | Description |
|---|---|
| `asset_type` | `'business_card'` or `'notes_image'` |
| `side` | `'front' \| 'back'` (business card only) |
| `local_asset_id` | Frontend-generated UUID; used as Supabase PK |
| `original_width/height` | Dimensions before canvas compression |
| `stored_width/height` | Dimensions after resize (≤1200 px longest edge) |
| `size_bytes` | Compressed JPEG byte count |
| `processing_state` | `'done'` — compression is synchronous |
| `storage_bucket` | `'lead-evidence'` (set after Storage upload) |
| `storage_path` | Supabase Storage path (set after Storage upload) |
| `storage_upload_status` | `'pending' \| 'uploaded'` |
| `storage_uploaded_at` | ISO timestamp of successful upload |

### Local image storage

Business card images are stored in IndexedDB as compressed JPEG data URLs (max 1200 px longest edge, quality 0.82). Only metadata goes to the `capture_assets` Supabase table. Image bytes live in the `assets` IDB store until the user clears browser storage.

### Supabase Storage uploads — CURRENT IMPLEMENTATION

**Module:** `assetStorageUpload.ts`
**Bucket:** `lead-evidence` (private)
**Design:** fire-and-forget; never blocks the capture flow; fails silently when offline.

#### Path conventions

| Asset type | Storage path |
|---|---|
| Business card (front or back) | `{userId}/{assetId}.jpg` |
| Notes image | `{userId}/{sessionId}/notes.jpg` |
| Voice note *(path reserved, not yet uploaded)* | `{userId}/{sessionId}/voice.webm` |

#### Upload triggers

| Asset | When | Trigger location |
|---|---|---|
| Business card (front) | Immediately after asset is captured, if online | `CaptureLeadPage.handleCardAssetsChanged` |
| Business card (back) | Immediately after asset is captured, if online | `CaptureLeadPage.handleCardAssetsChanged` |
| Notes image | On Save & Next, before promotion, if online | `CaptureLeadPage.handleSaveAndNext` |

#### Upload behaviour

- `uploadBusinessCardAsset`: uploads the JPEG blob, then updates the `capture_assets` row with `storage_path` and `storage_upload_status: 'uploaded'`.
- `uploadNotesImage`: uploads the JPEG blob, upserts a `capture_assets` row for the notes image with full metadata, then updates `capture_sessions.notes_image_url` to replace the raw data URL with the storage path.
- Both are no-ops when offline or unauthenticated.
- Re-uploading the same path is harmless (`upsert: true`).

#### Migration dependency

Storage columns (`storage_bucket`, `storage_path`, `storage_upload_status`, `storage_uploaded_at`) require migration `20260703120000_add_evidence_storage_to_capture_assets.sql`. Before that migration runs, the `capture_assets` DB update step fails silently; Storage uploads still succeed.

#### Voice note upload

`uploadVoiceNote` is defined as an exported stub — the function signature exists but contains no implementation. It is a placeholder for when voice recording UI is added.

---

## 4. Extraction Results Architecture

**Supabase table:** `extraction_results`
**Local store:** none — extraction results are not persisted to IndexedDB
**Primary module:** `captureBackendSync.ts`

### Extraction engines — CURRENT IMPLEMENTATION

| Engine key | Source | Written by |
|---|---|---|
| `tesseract_ocr` | Tesseract.js in-browser OCR fallback | `syncUpsertOcrExtraction` |
| `qr_parser` | `html5-qrcode` + `parseQrPayload.ts` | `syncUpsertQrExtraction` |
| `openai_vision` | OpenAI GPT-4o via edge function | `syncUpsertVisionExtraction` |

All three engines write to the same `extraction_results` table with a stable frontend-generated `extractionId` UUID as the primary key (idempotent upsert on `id`).

### Duplicate row prevention

When OpenAI Vision extraction succeeds, `CaptureLeadPage` tracks the `assetId` in a `syncedVisionAssetsRef` (`useRef(new Set<string>())`). When Tesseract OCR subsequently fires for the same asset (via the `applyVisionResult` fallback path), `handleOcrResult` checks this set and skips writing a duplicate `tesseract_ocr` row.

### Common fields across all engines

| Field | Description |
|---|---|
| `engine` | `'tesseract_ocr' \| 'qr_parser' \| 'openai_vision'` |
| `raw_text` | Unprocessed output string |
| `extracted_json` | Structured contact fields |
| `confidence` | `'high' \| 'medium' \| 'low'` |
| `overall_confidence` | Numeric 0–1 |
| `duration_ms` | Wall time from start to result |
| `status` | `'done'` for all successful extractions |
| `metadata` | Engine-specific detail |
| `asset_id` | FK to `capture_assets.id`; null for QR |
| `capture_session_id` | FK to parent session |

### Engine-specific metadata

- **`tesseract_ocr`:** `inferredFields`, `ignoredLines`, `completedAt`, `assetId`
- **`qr_parser`:** `qrType`, `extractionStrategy`, `hasData`, `ignoredLines`
- **`openai_vision`:** `source` (`'openai_vision'`), `attempt`, `fieldConfidence` (per-field confidence map), `completedAt`

---

## 5. Promotion Service Architecture

**Module:** `capturePromotionService.ts`
**Function:** `executePromotion(options: PromoteSessionOptions)`
**Trigger:** Rep taps "Save & Next" in `CaptureLeadPage`, or queued `promote_session` op replays via `flushQueue`.

### Design

`executePromotion` is the **single canonical execution path** for lead promotion. It is called by both the online flow in `CaptureLeadPage` and the offline queue replay in `captureOfflineQueue`. Both paths use identical logic.

`captureBackendSync.syncPromoteSession` is a thin adapter that wraps `executePromotion` in the `SyncCallbacks` pattern used by the queue layer.

`promoteSessionToLead` (also in `captureBackendSync`) is a **deprecated shim** kept for backward compatibility. It delegates to `executePromotion` with `captureMethod: null, eventId: null, eventName: null`.

### `PromoteSessionOptions`

```typescript
interface PromoteSessionOptions {
  backendSessionId: string;
  draftData:        DraftData;
  eventCode:        string | null;
  completedLeadId:  string;       // IndexedDB key for completed_leads upsert
  captureMethod:    CaptureMethod | null;
  eventId:          string | null;
  eventName:        string | null;
}
```

### `PromoteSessionResult`

```typescript
interface PromoteSessionResult {
  leadId:          string | null;
  error:           string | null;
  alreadyPromoted: boolean;
}
```

`executePromotion` never throws — it always returns a result object.

### Execution sequence

```
executePromotion(options)
  │
  ├─ 1. getAuthIdentity() — requires both userId and repCode
  │
  ├─ 2. Idempotency check
  │       SELECT promoted_lead_id FROM capture_sessions
  │       WHERE id = backendSessionId AND user_id = userId
  │       └─ If already set: update completed_leads → 'synced', return { alreadyPromoted: true }
  │
  ├─ 3. Build phones[] and emails[]
  │       Primary: draftData.phone / draftData.email
  │       Extras:  draftData.phoneNumbers[] / draftData.emails[] (from Vision extraction)
  │       Deduplicated in insertion order
  │
  ├─ 4. Generate leadId = crypto.randomUUID()
  │
  ├─ 5. INSERT into lead_entries
  │       lead_status:   'NEW'
  │       system_status: 'CREATED'
  │       state:         deriveState(address) — Indian state heuristic
  │       application:   text[] joined to comma-separated string
  │       └─ On error: return { error: insertError.message }
  │
  ├─ 6. UPDATE capture_sessions
  │       SET promoted_lead_id = leadId, session_status = 'promoted'
  │       WHERE id = backendSessionId AND user_id = userId
  │
  └─ 7. _updateCompletedLead()
          buildCompletedLead(completedLeadId, captureMethod, draftData, …)
          lead.status   = 'synced'
          lead.syncedAt = now
          saveCompletedLead(lead)  ← IndexedDB upsert
```

### Idempotency guarantee

If the same `promote_session` op is replayed (network error on first attempt, op stays in queue, connectivity returns), step 2 detects `promoted_lead_id` already set and returns immediately without creating a duplicate `lead_entries` row.

### Error classification in `CaptureLeadPage`

| Error type | Detection | Behaviour |
|---|---|---|
| Retryable (network/server) | Not auth error, not permission error | Enqueue `promote_session` op, reset session, show "will sync" toast |
| Auth error | Contains `'Not authenticated'` or `'JWT'` | Keep form visible, show error toast |
| Permission error | Contains `'row-level security'` or `'policy'` | Keep form visible, show specific error toast |

---

## 6. Evidence Storage

The capture module uses **three distinct storage layers** for different purposes.

### Local storage (browser session)

Transient in-memory React state only. Not persisted. Lost on page reload. Used only for rendering the current capture screen (OCR status, card assets in view, form values before first autosave).

### IndexedDB stores

Managed by `db.ts`. All stores use the same database (`capture_app`, version 5).

| Store | Key | Content | Persists |
|---|---|---|---|
| `drafts` | `'active_capture_draft'` | Single active `PersistedDraft` object | Until cleared or promoted |
| `assets` | `asset.id` (UUID) | `BusinessCardAsset` including compressed JPEG data URL | Until `deleteSessionAssets()` called on abandon |
| `pending_ops` | op ID | `PendingOp` objects for offline queue | Until flushed successfully |
| `completed_leads` | session UUID | `CompletedLead` records for the Queue page | Until user deletes |

### Supabase Storage

**Bucket:** `lead-evidence` (private — RLS scoped by `{userId}/` path prefix)

| Asset | Storage path | Upload trigger |
|---|---|---|
| Business card image | `{userId}/{assetId}.jpg` | Immediately on asset capture (online only) |
| Notes image | `{userId}/{sessionId}/notes.jpg` | On Save & Next before promotion (online only) |
| Voice note | `{userId}/{sessionId}/voice.webm` | **Not yet implemented** |

Upload calls are fire-and-forget. Failure (offline, auth missing, bucket missing) is logged via `console.warn` and silently ignored. The `capture_assets` row `storage_upload_status` column remains `'pending'` until a successful upload sets it to `'uploaded'`.

### Storage path for the image bytes

Image bytes from business card photos live in the IndexedDB `assets` store as compressed JPEG data URLs. They are not automatically deleted on successful upload — they remain until the session is abandoned (`deleteSessionAssets`) or the user clears browser storage. Supabase Storage and IndexedDB hold independent copies after upload.

---

## 7. Queue Architecture

**Module:** `captureOfflineQueue.ts`
**IndexedDB store:** `pending_ops`

### Design

The offline queue is a write-ahead log for backend sync operations. Each `PendingOp` carries a stable frontend-generated payload that is idempotent on replay. Ops survive page reloads.

### `PendingOp` shape

```typescript
interface PendingOp {
  id:        string;        // 'op_{timestamp}_{random}'
  type:      PendingOpType;
  sessionId: string;        // for grouping/filtering
  createdAt: string;        // ISO — flush order
  retries:   number;
  payload:   unknown;
}
```

### Queued operation types — CURRENT IMPLEMENTATION

| Op type | Sync function called | Trigger |
|---|---|---|
| `upsert_session` | `syncUpsertSession` | Method selected, session started |
| `upsert_asset` | `syncUpsertAsset` | Business card photo captured |
| `upsert_ocr_extraction` | `syncUpsertOcrExtraction` | Tesseract OCR completed |
| `upsert_qr_extraction` | `syncUpsertQrExtraction` | QR code scanned |
| `upsert_vision_extraction` | `syncUpsertVisionExtraction` | OpenAI Vision extraction completed |
| `update_session_fields` | `syncUpdateSessionFields` | Rep edits manual form fields (debounced 1.5s) |
| `promote_session` | `syncPromoteSession` → `executePromotion` | Save & Next offline, or Save & Next with retryable network error |

### Queue replay mechanism

`flushQueue()` is the sole replay function. It is called from:
- `CaptureLeadPage.handleReconnect` — wired to the `window.online` event via `useOnlineStatus`
- `LeadQueuePage.handleReconnect` — wired independently via `useOnlineStatus`

**Flush algorithm:**

```
flushQueue()
  │
  ├─ Guard: if flushInProgress → return immediately (no concurrent runs)
  ├─ Guard: if !navigator.onLine → return immediately
  │
  ├─ Load all ops from IndexedDB pending_ops store
  ├─ Sort by createdAt (creation order preserved)
  │
  └─ For each op:
       ├─ If !navigator.onLine → stop processing remaining ops
       ├─ executeOp(op)
       │    └─ On success: dbDelete(op.id), flushed++
       │    └─ On error:
       │         ├─ Auth error ('Not authenticated' / 'JWT'): drop op permanently
       │         └─ Network/server error: increment retries, keep in queue
       │
       └─ Return { flushed, remaining }
```

**`makesSilentCbs()`** is used internally during flush. `onSyncError` throws so errors propagate to the retry counter. `onOffline` throws so the outer loop stops.

### `promote_session` op payload

When enqueued, the `promote_session` payload carries the complete `PromoteSessionOptions` including `captureMethod`, `eventId`, and `eventName`. This allows `executePromotion` during replay to correctly update the `completed_leads` IndexedDB record without additional lookups.

### What is not queued

- `syncAbandonSession` — only fires online when the rep explicitly discards a draft.
- Supabase Storage uploads — these are handled by `assetStorageUpload.ts` independently and have no queue entry.

---

## 8. Capture Profile

**Module:** `captureProfile.ts`

A Capture Profile defines the **operating behaviour** of the Lead Capture module. It is not network connectivity. Connectivity is a separate runtime capability that only determines whether background operations execute immediately or wait in the queue.

### Type definition

```typescript
type CaptureProfile = 'CRM' | 'EXHIBITION';

const DEFAULT_CAPTURE_PROFILE: CaptureProfile = 'CRM';
```

### Profile descriptors

```typescript
interface CaptureProfileDescriptor {
  label:             string;
  purpose:           string;
  waitForExtraction: boolean;  // UI waits for AI/OCR before showing review form
  skipReview:        boolean;  // capture journey skips the review form
}
```

| Profile | `waitForExtraction` | `skipReview` | Purpose |
|---|---|---|---|
| `CRM` | `true` | `false` | Accuracy first — rep reviews extracted data before saving |
| `EXHIBITION` | `false` | `true` | Speed first — capture is non-blocking; processing happens later |

### Current implementation status

**CRM is the only active profile.** `DEFAULT_CAPTURE_PROFILE = 'CRM'`.

Exhibition mode descriptors are defined in `CAPTURE_PROFILE_DESCRIPTORS` but no Exhibition-specific journey logic exists. The abstraction is a foundation for future implementation.

### Where `captureProfile` lives in state

`captureProfile` is a field on `CaptureSession` (React state) and on `PersistedDraft` (IndexedDB). It is:

- Initialized to `DEFAULT_CAPTURE_PROFILE` (`'CRM'`) in `IDLE_SESSION`.
- Carried forward when `startCapture` or `startCaptureWithDraft` transitions to a new method — it is never reset by a method change.
- Switchable via `actions.setCaptureProfile(profile)` (no UI exposes this yet).
- Persisted to IndexedDB via `captureDraftStorage` so it survives page reloads.
- Backward-compatible: drafts written before this field existed deserialize with `'CRM'` as the default.

### Network and profile are independent

```
CRM + Online     → immediate sync and promotion
CRM + Offline    → queue all ops, promote when connectivity returns
EXHIBITION + *   → (not yet implemented)
```

---

## 9. Current Processing Pipeline

The following is the end-to-end pipeline for a Business Card capture in CRM mode (online).

```
1. Rep selects "Business Card"
   └─ actions.startCaptureWithDraft('BUSINESS_CARD', { cardSessionId })
   └─ syncSessionOp → syncUpsertSession → capture_sessions row (upsert)

2. Rep photographs front card
   └─ captureAssetStorage.saveAsset() → compress JPEG, save to IDB assets store
   └─ handleCardAssetsChanged
        ├─ syncAssetOp → syncUpsertAsset → capture_assets row (upsert)
        └─ uploadBusinessCardAsset → Supabase Storage lead-evidence/{userId}/{assetId}.jpg

3. Extraction pipeline starts (BusinessCardCapture → useVisionExtraction)
   ├─ Attempt: Edge function extract-business-card (OpenAI GPT-4o)
   │    └─ On success: VisionResult { source: 'openai_vision' }
   │         └─ handleVisionResult
   │              ├─ syncedVisionAssetsRef.add(assetId)  ← guard against duplicate
   │              └─ syncVisionExtractionOp → syncUpsertVisionExtraction
   │                   └─ extraction_results row, engine: 'openai_vision'
   │
   └─ On failure (503 / timeout): Tesseract fallback
        └─ ocrFallback.ts → Tesseract worker → parseBusinessCard.ts
             └─ VisionResult { source: 'tesseract_fallback' }
                  └─ applyVisionResult calls both onVisionResult + onOcrResult
                  └─ handleVisionResult: source !== 'openai_vision', skipped
                  └─ handleOcrResult:
                       ├─ syncedVisionAssetsRef check → not in set, proceed
                       └─ syncOcrOp → syncUpsertOcrExtraction
                            └─ extraction_results row, engine: 'tesseract_ocr'

4. Rep reviews extracted fields in ManualEntryForm
   └─ Field edits → patchDraft → autosave to IDB drafts store
   └─ syncFieldsOp (debounced 1.5s) → syncUpdateSessionFields → capture_sessions update

5. Rep enters Quick Details (temperature, notes, notes image)
   └─ Further patchDraft calls, autosave continues

6. Rep taps "Save & Next"
   └─ handleSaveAndNext
        ├─ uploadNotesImage (if notesImageDataUrl present, online) → Storage + capture_assets row
        │
        └─ executePromotion(promotionOptions)
             ├─ Idempotency check: capture_sessions.promoted_lead_id
             ├─ Build phones[] / emails[]
             ├─ INSERT lead_entries (lead_status: 'NEW', system_status: 'CREATED')
             ├─ UPDATE capture_sessions SET promoted_lead_id, session_status: 'promoted'
             └─ saveCompletedLead({ status: 'synced' }) → IDB completed_leads store

7. Session reset
   └─ actions.resetSession() → IDLE_SESSION
   └─ Form reset, card assets state cleared
   └─ (Draft remains in IDB until next autosave cycle writes IDLE — or explicit clearDraft)
```

### QR Code pipeline (abbreviated)

```
1. Rep selects "QR Code" → QR session created, synced
2. QrScannerView → html5-qrcode decodes raw string
3. parseQrPayload → ParsedContact { fields, qrType, confidence }
4. handleQrScanned
   ├─ startCaptureWithDraft('MANUAL', parsed.fields)
   ├─ syncQrOp → extraction_results row, engine: 'qr_parser'
   ├─ syncFieldsOp → capture_sessions field update
   └─ saveCompletedLead({ status: 'pending_sync' | 'local_only' })
5. ManualEntryForm → rep reviews → Save & Next → executePromotion
```

### Manual Entry pipeline (abbreviated)

```
1. Rep selects "Manual" → session created, synced
2. ManualEntryForm → field edits debounced to syncFieldsOp
3. Save & Next → executePromotion
```

---

## 10. Current Data Flow

```
Capture action (photo / QR scan / manual input)
        │
        ▼
CaptureLeadPage — React state via useCaptureSession
        │
        ├──────────────────────────────────────────────────────┐
        ▼                                                      ▼
IndexedDB                                              Supabase (online)
  drafts store (autosave, 600ms debounce)              capture_sessions (upsert)
  assets store (business card JPEG data URLs)
        │
        ▼
Extraction pipeline
  OpenAI Vision edge function → VisionResult
  OR Tesseract.js fallback → VisionResult (source: 'tesseract_fallback')
  OR QR parser (in-browser) → ParsedContact
        │
        ├──────────────────────────────────────────────────────┐
        ▼                                                      ▼
IndexedDB                                              Supabase (online)
  (no extraction storage locally)                     extraction_results (upsert)
                                                       engine: openai_vision | tesseract_ocr | qr_parser
        │
        ▼
Supabase Storage (online, fire-and-forget)
  lead-evidence bucket
  business card bytes: {userId}/{assetId}.jpg
  notes image bytes:   {userId}/{sessionId}/notes.jpg
        │
        ▼
executePromotion (capturePromotionService.ts)
  Idempotency check → INSERT lead_entries → UPDATE capture_sessions
        │
        ├──────────────────────────────────────────────────────┐
        ▼                                                      ▼
IndexedDB                                              Supabase
  completed_leads store (status: 'synced')             lead_entries (inserted)
  drafts store (cleared on next IDLE autosave)         capture_sessions.promoted_lead_id set
        │
        ▼
Lead enters CRM pipeline
  leads_list_view → LeadsPage
  lead_status: NEW → CONTACTED → QUALIFIED → CONVERTED | LOST
  system_status: CREATED → WHATSAPP_SENT | WHATSAPP_FAILED
```

---

## 11. Repository Status

### Implemented

| Feature | Module | Notes |
|---|---|---|
| Business card capture (camera) | `BusinessCardCapture.tsx`, `captureAssetStorage.ts` | Full |
| QR code scanning | `QrScannerView.tsx`, `useQrScanner.ts`, `parseQrPayload.ts` | Full |
| Manual entry form | `ManualEntryForm.tsx`, `useManualEntryForm.ts` | Full |
| OpenAI Vision extraction | `useVisionExtraction.ts`, edge function | Full |
| Tesseract OCR fallback | `useOcr.ts`, `ocrFallback.ts`, `parseBusinessCard.ts` | Full |
| OCR extraction results sync | `captureBackendSync.syncUpsertOcrExtraction` | Full |
| QR extraction results sync | `captureBackendSync.syncUpsertQrExtraction` | Full |
| Vision extraction results sync | `captureBackendSync.syncUpsertVisionExtraction` | Full |
| Offline sync queue | `captureOfflineQueue.ts` | Full |
| Queue replay on reconnect | `useOnlineStatus.ts`, `flushQueue()` | Full |
| Draft autosave | `useAutosave.ts`, `captureDraftStorage.ts` | Full |
| Draft recovery on reload | `CaptureLeadPage` mount effect | Full |
| Lead promotion | `capturePromotionService.executePromotion` | Full |
| Offline-safe promotion queue | `captureOfflineQueue 'promote_session'` | Full |
| Business card Storage upload | `assetStorageUpload.uploadBusinessCardAsset` | Full |
| Notes image Storage upload | `assetStorageUpload.uploadNotesImage` | Full |
| `CaptureProfile` abstraction | `captureProfile.ts` | Foundation only — CRM active |
| Lead queue page | `LeadQueuePage.tsx`, `leadQueueStorage.ts` | Full |
| Completed leads local mirror | `completedLeadsStorage.ts` | Full |

### Partially Implemented

| Feature | Module | Current State | Gap |
|---|---|---|---|
| Voice note capture | `DraftData.voiceNoteDurationMs/Transcript` | Schema columns and data fields defined | No recording UI; no upload |
| Notes image capture | `DraftData.notesImageDataUrl` | Data URL stored and uploaded | No dedicated capture UI; data URL comes from an undocumented source |
| `READY_FOR_REVIEW` status | `SessionStatus` type | Type defined | Not assigned by any code path |
| Draft clearing after promotion | `CaptureLeadPage.handleSaveAndNext` | Session reset via `actions.resetSession()` | `clearDraft()` not called; draft persists until next IDLE autosave |
| Back card asset metadata sync | `handleCardAssetsChanged` | `const asset = front ?? back` | Back card metadata never synced to `capture_assets` if front is also present |
| `promoteSessionToLead` | `captureBackendSync.ts` | Retained as deprecated shim | Delegates to `executePromotion` with null capture context; does not update `completed_leads` correctly |

### Planned

| Feature | Description |
|---|---|
| Exhibition Mode | Speed-first capture profile; non-blocking AI/OCR; no review screen. Types and descriptors defined; no journey implementation. |
| Processing Engine | Background worker for vision extraction, notes OCR, audio transcription — independent of capture flow |
| Asset Manager | Dedicated service for managing the full lifecycle of binary assets in Storage and IDB |
| Background Upload Queue | Queued upload operations for offline-captured assets (currently Storage uploads are online-only; missed uploads are not retried) |
| Review Queue | Explicit review screen showing extracted fields alongside original card photo with per-field confidence indicators |
| Voice Note Recording UI | Microphone capture, duration tracking, Whisper transcription |
| Processing Queue | IndexedDB or Supabase store for deferred heavy processing jobs |

---

## 12. Known Technical Debt

### Incomplete draft cleanup after promotion

`handleSaveAndNext` calls `actions.resetSession()` which sets React state to `IDLE_SESSION`, but does not call `clearDraft()`. The draft persists in IndexedDB and will trigger the `DraftRecoveryBanner` on the next page load for a successfully promoted session. The autosave debounce will eventually overwrite the draft with an IDLE state on the next render cycle, but this is not guaranteed before a hard reload.

**Planned fix:** Call `clearDraft()` explicitly after successful promotion in `handleSaveAndNext`.

### Back card asset metadata not synced

`handleCardAssetsChanged` uses `const asset = front ?? back` when calling `syncAssetOp`. If both front and back are present, only the front card's metadata is written to `capture_assets`. The back card's image bytes are uploaded to Supabase Storage correctly (both `front` and `back` are passed to `uploadBusinessCardAsset`), but no `capture_assets` row is created for the back.

**Planned fix:** Sync both assets independently in `syncAssetOp`.

### `promoteSessionToLead` deprecated shim

The shim in `captureBackendSync.ts` calls `executePromotion` with `captureMethod: null, eventId: null, eventName: null`. This means if the shim path is used, `_updateCompletedLead` in the promotion service writes a `CompletedLead` with `captureMethod: null` and no event association. The shim exists only for backward compatibility and should be removed once all callers are confirmed to use `executePromotion` directly.

### Storage upload not queued

Business card Storage uploads are fire-and-forget and online-only. If the rep is offline when a card is captured, `uploadBusinessCardAsset` returns immediately without scheduling a retry. The `capture_assets.storage_upload_status` column will remain `'pending'` indefinitely. There is no mechanism to retry missed uploads when connectivity returns.

**Planned fix:** Add a `upload_asset` op type to the offline queue, or introduce a dedicated upload queue backed by the `pending` status column.

### Notes image upload not offline-safe

`uploadNotesImage` is called from `handleSaveAndNext` only when `isOnline` is true. If promotion is enqueued for offline replay, the notes image upload is skipped entirely (the promotion path only uploads online, immediately before calling `executePromotion`). The `promote_session` payload does not carry the notes image data URL.

**Planned fix:** Include notes image upload as part of the promotion service or as a separate queued op.

### `extraction_results` not written for queue-replayed vision extractions

`upsert_vision_extraction` ops enqueued offline are replayed correctly. However, when promotion is also queued offline for the same session, there is no ordering guarantee that extraction ops will flush before the `promote_session` op — they all flush in `createdAt` order, which should be correct in practice but is not explicitly enforced.

### `completed_leads` store not cleaned up after promotion

There is no mechanism to delete stale `completed_leads` records for sessions that were promoted in a previous app session. Records accumulate until the user manually deletes them from the Queue page.


13. Target Product Architecture (Future State)

This section documents the intended long-term architecture of the Lead Capture platform. It represents the agreed architectural direction and may not yet be fully implemented.

13.1 Capture Profiles

The Lead Capture platform supports two Capture Profiles.

A Capture Profile defines the operating behaviour presented to the user.

A Capture Profile does not represent network connectivity.

Network connectivity only affects background processing.

CRM Profile

Purpose:

Accuracy First

Workflow

Capture

↓

AI Extraction

↓

Review Extracted Information

↓

Quick Details

↓

Business Details (Optional)

↓

Save Lead

Characteristics

Waits for AI extraction
User verifies extracted information before saving
Intended for office use and normal CRM operations
Produces immediately usable leads when processing succeeds
Exhibition Profile

Purpose:

Speed First

Workflow

Capture

↓

Quick Details

↓

Save & Next Lead

OR

Continue

↓

Business Details

↓

Save & Next Lead

Characteristics

Never waits for AI
Never waits for OCR
User immediately continues to the next lead
Processing happens after capture
13.2 Network Connectivity

Network connectivity is not an operating mode.

Connectivity only determines whether the Background Worker executes immediately or waits.

CRM + Online
Capture

↓

Immediate Processing

↓

Lead Available
CRM + Offline
Capture

↓

Capture Session Saved

↓

Background Worker WAITING

↓

Automatic Processing

↓

Lead Available

The user should see a non-blocking notification similar to:

You're currently offline. This lead has been safely saved and will automatically upload and process once you're back online.

Exhibition + Online
Capture

↓

Capture Session Saved

↓

User continues immediately

↓

Background Worker RUNNING

↓

Automatic Processing

↓

Lead Available
Exhibition + Offline
Capture

↓

Capture Session Saved

↓

User continues immediately

↓

Background Worker WAITING

↓

Automatic Processing

↓

Lead Available

The user experience remains identical.

Only processing timing changes.

13.3 Core Architectural Principle

Every lead follows exactly the same backend pipeline.

Capture Profiles only determine whether the user waits for this pipeline.

Capture Session

↓

Pending Operations Queue

↓

Asset Upload

↓

Extraction

↓

Review Evaluation

↓

Promotion

↓

Lead Entry

There must never be separate backend implementations for CRM and Exhibition.

13.4 Background Worker

The Background Worker is responsible for executing queued operations.

It has only two runtime states:

RUNNING

The worker processes queued operations immediately.

or

WAITING

The worker pauses because required conditions (typically internet connectivity) are unavailable.

When conditions become available, processing automatically resumes.

The Background Worker never changes business logic.

It only changes when processing executes.

13.5 Planned Processing Pipeline

Future processing will become orchestrated through a single reusable processing engine.

Conceptually:

processCaptureSession(sessionId)

The processing engine will coordinate:

Capture Session

↓

Asset Upload

↓

OCR / Vision / QR Processing

↓

Extraction Results

↓

Review Evaluation

↓

Promotion Service

↓

Lead Entry

This processing engine will become the single execution path used by:

CRM Profile
Exhibition Profile
Offline Replay
Future Admin Reprocessing
Future AI Reprocessing
13.6 Planned Asset Manager

The Asset Manager will own the lifecycle of all evidence files.

Responsibilities:

Asset registration
Local persistence
Upload decisions
Upload retries
Storage status
Future asset re-upload
Future asset archival

UI components should never directly interact with Storage providers.

13.7 Architectural Principles

The Lead Capture platform follows these principles.

1. Capture First. Process Later.
2. Capture Session is the source of truth until Promotion.
3. Promotion is the only mechanism that creates CRM Leads.
4. Evidence must never be lost.
5. Every operation must be replayable.
6. Connectivity never changes business logic.
7. One backend pipeline supports every Capture Profile.
8. User experience should never be blocked by background processing.
9. Every processing step should be independently retryable.
10. Reliability is always preferred over immediate completeness.


