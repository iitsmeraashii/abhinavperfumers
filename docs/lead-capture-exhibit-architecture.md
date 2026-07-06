# Lead Capture Exhibit Architecture

## Overview

The Lead Capture module is an **offline-first capture pipeline** built for field sales
representatives at trade exhibitions. Its primary constraint is that network connectivity
at exhibition venues is unreliable: reps capture leads continuously regardless of signal,
and all data must survive a page reload, a device reboot, or an extended period of no
connectivity.

The module supports three capture methods:

- **Business Card** — rep photographs the card; OpenAI Vision extracts contact fields via
  an edge function, with Tesseract OCR as an automatic fallback.
- **QR Code** — rep scans a QR code (vCard, MeCard, URL, or plain text); the payload is
  parsed entirely in-browser.
- **Manual Entry** — rep types contact details directly into a form.

All three methods funnel into the same **capture session → extraction results →
promotion** pipeline regardless of how the data was acquired.

---

## Architectural Principles

The following principles govern every design decision in this module. They were established
by the existing implementation and must be respected by all future work.

### 1. Capture First. Process Later.

Capture is never blocked by extraction or promotion. The rep can photograph a card, tap
"Save & Next", and begin the next capture before the OCR pipeline has even started. All
processing — OCR, vision extraction, sync, promotion — happens asynchronously behind the
capture screen.

### 2. Capture Session Is the Source of Truth Until Promotion

A `capture_sessions` row is the authoritative record of a capture attempt from the moment
it is created until the moment `promoteSessionToLead` inserts a `lead_entries` row. During
that window, the local `drafts` IndexedDB store mirrors the session's current state via
autosave. The local state is always preferred over the backend for rendering; the backend
is a downstream sink.

### 3. `lead_entries` Is the CRM Representation

Once a capture session is promoted, the resulting `lead_entries` row is the canonical CRM
record. It enters the standard lead lifecycle (`NEW → CONTACTED → QUALIFIED →
CONVERTED / LOST`) and is visible to all roles in the Leads screen. The capture session is
marked `session_status = 'promoted'` and linked via `promoted_lead_id`. The capture
infrastructure (capture session, assets, extractions) is evidence — the lead entry is the
outcome.

### 4. `capture_assets` Stores Binary Evidence

Every business card photograph is represented as a `capture_assets` row. The row records
dimensions, MIME type, byte size, and a FK to its parent `capture_sessions` row. The
actual image bytes are stored locally in the `assets` IndexedDB object store as compressed
JPEG data URLs. `capture_assets` is the audit trail; IndexedDB is the device cache.

### 5. `extraction_results` Stores AI/OCR Outputs

Every extraction attempt — whether Tesseract OCR, QR parsing, or OpenAI Vision — produces
an `extraction_results` row. Each row is independent, identified by a stable
frontend-generated UUID, and linked to a `capture_session_id` and optionally an
`asset_id`. Multiple extraction rows can exist for the same session (e.g., front-card OCR
and back-card OCR). Extraction rows are evidence of how fields were derived; they are never
the source of truth for the lead.

### 6. CRM and Exhibition Share the Same Backend Pipeline

There is one capture pipeline, one set of Supabase tables, and one promotion function. The
distinction between CRM mode and Exhibition mode is entirely in **timing**, not in
structure.

### 7. CRM Differs Only by Processing Immediately

In CRM mode the rep is connected. Sync calls fire as fire-and-forget operations
immediately after each capture action. Promotion to `lead_entries` happens inline when the
rep taps "Save & Next". From the rep's perspective the workflow is seamless.

### 8. Exhibition Differs Only by Processing Later

In Exhibition mode the rep is offline or intermittently connected. Every sync operation
that cannot reach the backend is enqueued in the `pending_ops` IndexedDB store. On
reconnect, `flushQueue()` replays all queued operations in creation order using the same
idempotent upsert functions that online mode uses directly.

### 9. Offline CRM Automatically Falls Back to Background Processing

When a rep who normally operates in CRM mode loses connectivity, the system does not ask
for intervention. The same `syncSessionOp` / `syncAssetOp` / `syncOcrOp` / `syncQrOp`
wrappers in `CaptureLeadPage` check `isOnline` before every call: if online, fire
immediately; if offline, enqueue to `pending_ops`. The rep experience is unchanged.

---

## CRM Mode

CRM mode is the default operating mode when connectivity is available.

**Trigger:** `navigator.onLine === true` at the time of each sync operation.

**Behaviour:**

1. Rep selects a capture method. `CaptureLeadPage` calls `syncSessionOp` → `syncUpsertSession`
   immediately (fire-and-forget, never awaited by the UI).
2. As OCR completes or QR is parsed, extraction results are synced immediately via
   `syncOcrOp` / `syncQrOp`.
3. As the rep edits manual fields, `syncFieldsOp` fires on each significant change.
4. When the rep taps "Save & Next", `promoteSessionToLead` is called directly — a live
   `INSERT` into `lead_entries` and a subsequent `UPDATE` to mark the session promoted.
5. Autosave writes the draft to IndexedDB throughout for crash recovery.

**Failed promotion in CRM mode:** If the `lead_entries` INSERT fails (network error or
validation), the rep sees an error toast. The capture session data remains in `completed_leads`
IndexedDB with `status: 'local_only'`. Re-promotion is not automatically retried.

---

## Exhibition Mode

Exhibition mode is the operating state when connectivity is absent or unreliable.

**Trigger:** `navigator.onLine === false` at the time of any sync operation.

**Behaviour:**

1. Rep selects a capture method. `syncSessionOp` detects offline → calls `enqueueOp('upsert_session', …)`.
2. All subsequent sync calls (assets, extractions, field updates) are also enqueued.
3. The `OfflineBanner` shows with a count of pending ops.
4. The `LeadQueuePage` shows all captured leads with their local sync status.
5. On reconnect, `window.online` fires → `handleReconnect` → `flushQueue()` replays all
   `pending_ops` in creation order using the same sync functions as CRM mode.
6. **Promotion remains a live network call.** If the rep taps "Save & Next" while
   offline, promotion is attempted immediately, fails, and the record is saved locally as
   `'local_only'`. There is currently no queued promotion path.

---

## Capture Session Responsibilities

**Table:** `capture_sessions`  
**Local store:** `drafts` (IndexedDB, single record, key `'active_capture_draft'`)  
**Module:** `src/capture/useCaptureSession.ts`, `src/capture/captureDraftStorage.ts`,
`src/capture/captureBackendSync.ts`

The capture session is the envelope for one capture attempt from method selection to
promotion.

**What it holds:**

- `capture_method` — `BUSINESS_CARD | QR | MANUAL`
- `session_status` — `capturing | promoted | abandoned`
- `extracted_fields` (jsonb) — the current best-known contact fields at any point
- `phones`, `emails` — denormalised contact arrays
- Enrichment fields: `lead_temperature`, `lead_type`, `previous_rep_code`, `application`,
  `price_range`, `quick_keywords`, `target_market`, `certification`, `benchmark`
- Media fields: `notes_image_url`, `voice_note_duration_ms`, `voice_note_transcript`
- `local_draft_key` — always `'active_capture_draft'`; allows backend to identify which
  local draft this session corresponds to
- `promoted_lead_id` — FK to `lead_entries.id`, set on promotion
- `event_id` — FK to the active event, set at session creation

**Local state machine:**

```
IDLE
  └─ (method selected) ──→ CAPTURING
                              └─ (fields edited) ──→ DRAFT
                                   └─ (Save & Next) ──→ IDLE (session cleared locally)
```

Sync state (`BackendSyncState`) runs in parallel and is never awaited by the UI:
`idle → syncing → synced | error | offline`.

**Autosave:** `useAutosave` debounces writes to the `drafts` store at 600 ms after any
`draftData`, `sessionStatus`, or `captureMethod` change. Flushes immediately on
`visibilitychange`, `beforeunload`, and `pagehide` to survive iOS Safari suspension.

**Draft recovery:** On mount, `CaptureLeadPage` loads the `drafts` store. If a non-IDLE
draft is found, it is held in `pendingDraft` state and presented to the rep as a
`DraftRecoveryBanner` with "Continue" and "Discard" options. Continuing restores the
session and re-syncs to the backend if online.

---

## Capture Assets Responsibilities

**Table:** `capture_assets`  
**Local store:** `assets` (IndexedDB, keyed by `asset.id`, indexed by `sessionId`)  
**Module:** `src/capture/captureAssetStorage.ts`, `src/capture/captureBackendSync.ts`

A capture asset represents one binary image associated with a capture session — typically
the front or back face of a business card.

**What it holds:**

- `asset_type` — always `'business_card'` in current implementation
- `side` — `'front' | 'back'`
- `local_asset_id` — the frontend-generated UUID used as the `assets` IDB key
- `original_width`, `original_height` — dimensions before compression
- `stored_width`, `stored_height` — dimensions after canvas resize (≤1200 px longest edge)
- `size_bytes` — compressed JPEG byte count
- `processing_state` — always `'done'` in current implementation (compression is
  synchronous on the frontend before saving)

**What it does not hold:** Image bytes. The actual JPEG data URL lives only in the
`assets` IndexedDB store. `capture_assets` rows are metadata only. `storage_path` exists
as a column but is not populated — there is no Supabase Storage upload in the current
implementation.

**Lifecycle:** Asset is compressed and saved to IDB by `saveAsset()`. A sync call
(`syncUpsertAsset`) writes the metadata row to Supabase. The local `asset.id` is reused
as the Supabase primary key, so the upsert is idempotent. The `backendAssetId` is stored
in `BackendSyncState.backendAssetIds[localAssetId]` and is subsequently passed to
extraction result writes as `asset_id`.

---

## Extraction Results Responsibilities

**Table:** `extraction_results`  
**Local store:** none — extraction results are not persisted to IndexedDB  
**Module:** `src/capture/captureBackendSync.ts`

An extraction result row records the output of one automated extraction pass against a
capture session. Multiple rows can exist for a single session.

**What it holds:**

| Field | Purpose |
|---|---|
| `engine` | Which engine produced this row: `tesseract_ocr`, `qr_parser`, `openai_vision` (planned) |
| `raw_text` | Unprocessed text: Tesseract raw output, or raw QR string |
| `extracted_json` | Structured contact fields as parsed by the relevant engine |
| `confidence` | `'high' | 'medium' | 'low'` — engine-specific |
| `overall_confidence` | Numeric 0–1 derived from text confidence |
| `duration_ms` | Wall time from extraction start to result |
| `status` | Always `'done'` for successful extractions; errors are not currently written |
| `metadata` | Engine-specific detail: `inferredFields`, `ignoredLines`, `qrType`, etc. |
| `asset_id` | FK to `capture_assets.id` for image-linked extractions; null for QR |
| `capture_session_id` | FK to parent session |

**What it does not hold:** The image bytes (those are in IDB); field-level confidence
breakdowns (derived by `useVisionExtraction` but not synced to this table for the vision
path); or any reference to which `lead_entries` row resulted from this extraction.

**Current extraction coverage:**

- Tesseract OCR → written to `extraction_results` with `engine: 'tesseract_ocr'`
- QR parsing → written to `extraction_results` with `engine: 'qr_parser'`
- OpenAI Vision → **not yet written to `extraction_results`**; currently synced only to
  `capture_sessions.extracted_fields` / `capture_sessions.extracted_data`

---

## Lead Promotion Responsibilities

**Function:** `promoteSessionToLead` in `src/capture/captureBackendSync.ts`  
**Trigger:** Rep taps "Save & Next" in `CaptureLeadPage`

Promotion is the single step that converts a capture session into a CRM lead.

**What promotion does:**

1. Reads `auth.uid()` and `rep_code` from `my_rep_profile`.
2. Merges `draftData.phone` + `draftData.phoneNumbers` into a deduplicated `phones[]`.
3. Merges `draftData.email` + `draftData.emails` into a deduplicated `emails[]`.
4. Derives an Indian state name from `draftData.address` using `deriveState()`.
5. Generates a new `lead_entries.id` UUID on the frontend.
6. INSERTs the `lead_entries` row with `lead_status: 'NEW'` and `system_status: 'CREATED'`.
7. On INSERT success, UPDATEs `capture_sessions` to set `promoted_lead_id` and
   `session_status: 'promoted'`.
8. Returns `{ leadId, error }` — never throws.

**Field mappings from `DraftData` to `lead_entries`:**

| DraftData field | lead_entries column | Notes |
|---|---|---|
| `clientName` | `client_name` | trimmed |
| `company` | `company` | trimmed |
| `designation` | `designation` | trimmed |
| `phone` + `phoneNumbers` | `phones` | merged array, deduplicated |
| `email` + `emails` | `emails` | merged array, deduplicated |
| `address` | `address` | trimmed |
| `website` | `website` | trimmed |
| `address` (derived) | `state` | via `deriveState()` |
| `notes` | `notes` | trimmed |
| `leadTemperature` | `lead_temperature` | `Hot | Warm | Cold` |
| `leadType` | `lead_type` | `NEW | EXISTING`, defaults to `NEW` |
| `previousRepCode` | `previous_associated_rep` | trimmed |
| `application` (array) | `application` | joined to comma-separated string |
| `priceRange` | `price_range` | trimmed |
| `quickKeywords` | `quick_keywords` | text[] |
| `targetMarket` | `target_market` | text[] |
| `certification` | `certification` | text[] |
| `benchmark` | `benchmark` | text[] |

**What promotion does not do:**

- Does not enqueue to `pending_ops` — promotion requires a live network call.
- Does not update the `completed_leads` IDB record status after success.
- Does not write an `extraction_results` row for the final promoted field state.
- Does not upload the business card image bytes to Supabase Storage.

---

## Offline Queue Responsibilities

**Table:** `pending_ops` (IndexedDB store, version 3)  
**Module:** `src/capture/captureOfflineQueue.ts`

The offline queue is a write-ahead log for backend sync operations. It bridges the gap
between what the rep captured on-device and what has been confirmed by the backend.

**Queued operation types:**

| Op type | Sync function | Trigger |
|---|---|---|
| `upsert_session` | `syncUpsertSession` | Method selected, session started |
| `upsert_asset` | `syncUpsertAsset` | Business card photo captured |
| `upsert_ocr_extraction` | `syncUpsertOcrExtraction` | Tesseract OCR completed |
| `upsert_qr_extraction` | `syncUpsertQrExtraction` | QR code scanned |
| `update_session_fields` | `syncUpdateSessionFields` | Rep edits manual fields |

**What is not queued:**

- `promoteSessionToLead` — promotion is always a live call; there is no `'promote_session'`
  op type.
- `syncAbandonSession` — abandonment only fires online when the rep discards a draft.

**Flush behaviour:**

- `flushQueue()` is guarded by `flushInProgress` to prevent concurrent runs.
- All ops are sorted by `createdAt` before execution — creation order is preserved.
- Network/server errors increment `retries` on the op and leave it in the queue.
- Auth errors (`Not authenticated`, `JWT`) drop the op permanently as non-retryable.
- `flushQueue()` is called from both `CaptureLeadPage.handleReconnect` and
  `LeadQueuePage.handleReconnect`, both wired to the `window.online` event independently.

**Idempotency guarantee:** Every queued op carries the same stable frontend-generated UUID
that the online path would use. Replaying an op that already succeeded is harmless — the
upsert overwrites with identical data.

---

## Processing Queue Responsibilities (Planned)

The processing queue is a planned addition to the architecture. It is not yet implemented.

**Purpose:** Decouple heavy processing tasks (vision extraction, notes image OCR, audio
transcription, AI field summarisation) from the capture flow. These tasks can take seconds
to minutes and must not block the rep from capturing the next lead.

**Intended design:**

A second IndexedDB store (or a dedicated `processing_queue` table in Supabase) holds
processing jobs, each referencing a `capture_session_id` and an `asset_id`. A background
worker processes jobs in priority order when the device is connected and idle. Results are
written to `extraction_results` and merged back into the session's `extracted_fields`.

**Why the current structure accommodates this:**

- `extraction_results` already accepts multiple rows per session, keyed by stable
  frontend UUIDs — versioned extractions are already supported at the schema level.
- `capture_sessions.extraction_status` (`'pending' | 'running' | 'done' | 'failed' |
  'skipped'`) is already defined in the schema (migration `20260525111647`) and is
  intended to track background processing state.
- `capture_assets` already has `processing_state` to track per-asset processing progress.
- `DraftData` already holds `notesImageDataUrl`, `voiceNoteDurationMs`, and
  `voiceNoteTranscript` — the fields these processors would write.

---

## Asset Lifecycle

```
Rep photographs card
        │
        ▼
captureAssetStorage.saveAsset()
  └─ Resize canvas to ≤1200px, JPEG quality 0.82
  └─ Save dataUrl + dimensions + sizeBytes to IndexedDB `assets` store
        │
        ▼
CaptureLeadPage.handleAssetCaptured()
  └─ syncAssetOp() ──→ online? ──→ syncUpsertAsset() ──→ capture_assets row
                          └──────→ offline? → enqueueOp('upsert_asset', …)
        │
        ▼
extraction pipeline reads dataUrl from IndexedDB for OCR/Vision
        │
        ▼
On session abandon:
  deleteSessionAssets(cardSessionId) — removes from IndexedDB `assets` store
  capture_assets row is NOT deleted (only removed by CASCADE if session is deleted)
        │
        ▼
On promotion:
  Image bytes remain in IndexedDB until the user clears browser storage.
  No Supabase Storage upload occurs in the current implementation.
  capture_assets row remains with storage_path = null.
```

---

## OCR Lifecycle

Tesseract OCR is the fallback extraction engine. It runs entirely in-browser using a
dedicated Web Worker (`tesseract.worker.min.js` in `/public`).

```
Business card photo saved to IndexedDB
        │
        ▼
useVisionExtraction.runExtraction(assetId, dataUrl)
  └─ Attempts OpenAI Vision via extract-business-card edge function
  └─ On success: returns VisionResult — OCR is not involved
  └─ On failure (503 / network error / timeout):
        │
        ▼
runTesseractFallback(assetId, dataUrl)
  └─ Dynamic import: ocrFallback.ts → Tesseract worker
  └─ Worker returns raw text string
  └─ parseBusinessCard.parseBusinessCardText(rawText)
        └─ Heuristic line classifier → fields: clientName, company,
           phone, email, designation
        └─ Confidence: 'high' | 'medium' | 'low' based on field count
        │
        ▼
VisionResult returned to CaptureLeadPage with source: 'tesseract_fallback'
        │
        ▼
CaptureLeadPage.handleVisionResult()
  └─ patchDraft() with extracted fields
  └─ syncOcrOp() ──→ online? ──→ syncUpsertOcrExtraction()
                        │              └─ extraction_results row, engine: 'tesseract_ocr'
                        └──────→ offline? → enqueueOp('upsert_ocr_extraction', …)
```

**Note on Tesseract initialisation:** The Tesseract worker is instantiated as a module-level
singleton in `ocrFallback.ts` and cached across calls. The `eng` language data is loaded
once from `/tesseract.esm.min.js` (served from `/public`).

---

## QR Lifecycle

QR parsing runs entirely in-browser via `html5-qrcode`. No network call is required.

```
Rep taps "QR Code" capture method
        │
        ▼
CaptureLeadPage starts 'QR' capture session, syncSessionOp fires
        │
        ▼
QrScannerView activates camera via html5-qrcode
        │
        ▼
QR code decoded to raw string
  └─ parseQrPayload.parseQrPayload(rawString)
        └─ Tries vCard 3.0/4.0 parser
        └─ Tries MeCard parser
        └─ Tries name=value line parser
        └─ Falls back to plain text / URL
        └─ Returns ParsedContact { fields, raw, qrType, confidence, … }
        │
        ▼
CaptureLeadPage.handleQrScan()
  └─ startCaptureWithDraft('MANUAL', parsed.fields)
     (session transitions to MANUAL — QR sessions continue as manual entry)
  └─ syncQrOp() ──→ online? ──→ syncUpsertQrExtraction()
                       │              └─ extraction_results row, engine: 'qr_parser'
                       └──────→ offline? → enqueueOp('upsert_qr_extraction', …)
        │
        ▼
ManualEntryForm populated with parsed fields
Rep reviews and edits, then saves via standard Save & Next flow
```

---

## Audio Lifecycle (Planned)

Audio transcription is not yet implemented. The data model has reserved the necessary
fields.

**Intended flow:**

```
Rep records a voice note during capture (planned UI)
        │
        ▼
Audio recorded as a Blob in-browser
  └─ Saved to IndexedDB (new `audio` store, or extended `assets` store)
  └─ draftData.voiceNoteDurationMs set
        │
        ▼
Background: audio Blob sent to a transcription service
  (Whisper via a new edge function, or similar)
        │
        ▼
Transcript returned
  └─ draftData.voiceNoteTranscript set via patchDraft()
  └─ extraction_results row written with engine: 'whisper' (or equivalent),
     raw_text: transcript, metadata: { duration_ms, language }
        │
        ▼
Transcript available in ManualEntryForm notes field
```

**Existing schema support:**
`capture_sessions.voice_note_duration_ms` and `capture_sessions.voice_note_transcript`
are already synced by `syncUpdateSessionFields` and `syncUpsertSession`.
`extraction_results` can hold the transcript row without schema changes.
A `capture_assets` row for the audio file would require `asset_type: 'voice_note'`.

---

## Notes Image Lifecycle (Planned)

Notes image OCR is not yet implemented. The data model has reserved the necessary fields.

**Intended flow:**

```
Rep photographs a handwritten note or whiteboard (planned UI)
        │
        ▼
Image saved to IndexedDB `assets` store with asset_type: 'notes_image'
  └─ capture_assets row written (as for business card)
  └─ draftData.notesImageDataUrl set
        │
        ▼
OCR pipeline runs (Tesseract or Vision)
  └─ extraction_results row written with engine: 'tesseract_ocr' or 'openai_vision',
     asset_id: notes image asset UUID
        │
        ▼
Extracted text merged into draftData.notes via patchDraft()
```

**Existing schema support:**
`capture_sessions.notes_image_url` is already synced by `syncUpdateSessionFields`.
`draftData.notesImageDataUrl` is already defined in the `DraftData` interface.
`extraction_results.asset_id` can reference the notes image asset row.
No schema changes are required to support this lifecycle.

---

## Review Workflow

The review workflow describes what happens between extraction completing and the rep
confirming the captured data.

**Current implementation:**

After OCR or Vision extraction completes, `CaptureLeadPage` calls
`actions.startCaptureWithDraft('BUSINESS_CARD', extractedFields)` which patches `draftData`
with the extraction result. This immediately populates the `ManualEntryForm`. The rep sees
the extracted fields pre-filled and can correct any errors before saving.

**Session statuses involved:**

| Status | Meaning |
|---|---|
| `CAPTURING` | Active capture in progress (scanning, photographing, form entry) |
| `DRAFT` | Data captured, session exists but not yet saved — used in `captureDraftStorage` |
| `READY_FOR_REVIEW` | Defined in `SessionStatus` type but not yet assigned by any code path |

`READY_FOR_REVIEW` is available as a status for a planned explicit review step — for
example, a dedicated review screen that shows the extracted card fields alongside the
original card photo before the rep commits the data.

**Fields that inform review confidence:**

`VisionResult.fieldConfidence` carries per-field confidence grades (`'high' | 'medium' |
'low' | 'unknown'`) derived from the overall extraction confidence and field presence. These
are available to the UI but are not currently rendered in the review form. They are
available to support future field-level confidence highlights.

---

## Promotion Workflow

The promotion workflow is the final step of the capture pipeline.

```
Rep reviews data in ManualEntryForm
        │
        ▼
Rep taps "Save & Next"
        │
        ▼
CaptureLeadPage.handleSaveAndNext()
  │
  ├─ 1. promoteSessionToLead(backendSessionId, draftData, eventCode)
  │       └─ GET auth identity from my_rep_profile (rep_code required)
  │       └─ Merge phones/emails arrays
  │       └─ deriveState(address) → state
  │       └─ Generate lead_entries.id UUID on frontend
  │       └─ INSERT into lead_entries (lead_status: 'NEW', system_status: 'CREATED')
  │       └─ UPDATE capture_sessions SET promoted_lead_id, session_status = 'promoted'
  │       └─ Return { leadId, error }
  │
  ├─ 2. On success:
  │       └─ buildCompletedLead(sessionId, method, draftData, bsid, eventId, eventName)
  │       └─ saveCompletedLead({ …lead, status: 'synced' })
  │              → completed_leads IDB store
  │       └─ clearDraft() → removes from drafts IDB store
  │       └─ deleteSessionAssets(cardSessionId) → removes images from assets IDB store
  │       └─ Show success toast
  │       └─ Reset capture session to IDLE
  │
  └─ 3. On failure:
          └─ buildCompletedLead(…)
          └─ saveCompletedLead({ …lead, status: 'local_only' })
          └─ clearDraft()
          └─ Show error toast with message
          └─ Reset capture session to IDLE
          (lead is locally preserved but NOT automatically retried for promotion)
```

**After promotion**, the `lead_entries` row enters the standard CRM pipeline:

- Visible in `LeadsPage` via `leads_list_view`
- Subject to the WhatsApp delivery system (`system_status: CREATED → WHATSAPP_SENT`)
- Editable via `LeadDetailPage`
- Available for follow-up tasks via `lead_follow_ups`

**The `LeadQueuePage`** shows the local `completed_leads` record after promotion with
`status: 'synced'`. The "View Lead" button on a synced card is wired in the component but
the navigation is not implemented in `App.tsx` (`onViewLead={undefined}`). The intended
behaviour is navigation to `LeadDetailPage` using the `lead_entries.id`, which is not
currently stored in the `CompletedLead` record.
