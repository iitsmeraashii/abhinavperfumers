# Verified capture architecture context

This note records implementation facts checked against the repository on 1 October 2026. It supplements the architecture documents listed below. It does not establish the configuration or behavior of a deployed environment, or replace a live database inspection. Verification was by source inspection; no runtime tests were performed for this review.

## Documents reviewed

- `CAPTURE_ALPE_ARCHITECTURE.md`
- `EXTRACTION_REVIEW_ARCHITECTURE.md`
- `INDEXED_DB_USE_CASE.md`
- `QUEUE_IMPLEMENTATION.md`
- `QUEUE_LIFECYCLE_HANDOFF.md`
- `alpe-architecture.md`
- `capture-domain-architecture-review.md`
- `capture-pipeline-assessment.md`
- `lead-capture-architecture-v2.md`
- `lead-capture-exhibit-architecture.md`

These documents contain historical assessments and proposed designs alongside descriptions of implemented behavior. Use the source references below when preparing current documentation.

## Processing paths and profiles

ALPE selection depends on `VITE_USE_ALPE_PROCESSING` being exactly the string `true`. The deployed value is not established by this review. On Save & Next, the ALPE branch submits processing in the background and resets the capture UI, including clearing its active draft. The other branch awaits the adapter result. The ALPE worker's `resolveProfile()` currently returns `CRM`.

Sources: [featureFlag.ts](../src/alpe/featureFlag.ts), [CaptureLeadPage.tsx](../src/CaptureLeadPage.tsx), [worker.ts](../src/alpe/worker.ts).

## Queue responsibilities

The offline operation queue uses IndexedDB `pending_ops`. ALPE jobs use Supabase `processing_queue` and are consumed by the browser scheduler. The queue page uses local draft and completed-lead records; `saveQueueItem()` is a compatibility no-op. These are distinct mechanisms, rather than one shared queue.

The scheduler skips polling while offline. It reconciles local records, claims an eligible job, runs the worker, and updates the job state. It writes failure diagnostics to local `completed_leads` for `RETRYING` and `FAILED`, and reconciles completion to local `synced` status.

Sources: [captureOfflineQueue.ts](../src/capture/captureOfflineQueue.ts), [leadQueueStorage.ts](../src/capture/leadQueueStorage.ts), [LeadQueuePage.tsx](../src/LeadQueuePage.tsx), [scheduler.ts](../src/alpe/scheduler.ts).

Job selection considers `QUEUED` and eligible `RETRYING` records, ordered by priority and enqueue time. The claim update includes a state predicate. The selection does not filter by `scheduled_at`. A state predicate alone is not evidence of an end-to-end exactly-once processing guarantee.

The queue page's Retry handler flushes offline operations and reloads local records. That handler does not directly reset a failed ALPE job in `processing_queue`. View Lead resolves the lead ID by querying `lead_entries.capture_session_id` before navigating.

Sources: [processingQueueRepository.ts](../src/alpe/processingQueueRepository.ts), [LeadQueuePage.tsx](../src/LeadQueuePage.tsx), [App.tsx](../src/App.tsx).

## Review workflow

The worker maps successful pipeline output to `completed`; its pipeline result mapping does not emit `requires_review`. A promoted lead can require review while its processing job completes. Queue state and lead review status must therefore be documented separately.

The lead detail page implements a review banner and Mark as Reviewed action. The action calls `updateLeadWithAudit()` with `lead_status: 'NEW'`, `is_reviewed: true`, a review timestamp, and the current user's representative code as `reviewed_by`.

Sources: [worker.ts](../src/alpe/worker.ts), [LeadDetailPage.tsx](../src/LeadDetailPage.tsx), [reviewMetadata.ts](../src/reviewMetadata.ts).

## Extraction and review persistence

The ALPE extraction persistence function updates `extraction_source`, `extraction_status`, `extraction_confidence`, `extracted_fields`, and `extraction_metadata` on `capture_sessions`. Field confidence and field status are nested in `extraction_metadata`; this function does not write them to separate top-level columns. Review persistence updates `review_metadata`.

Both persistence functions await their Supabase calls but log errors and allow processing to continue. Their implementation does not establish immutable or guaranteed-success historical writes.

Source: [extractionMetadataPersistence.ts](../src/alpe/extractionMetadataPersistence.ts).

## IndexedDB

The database name is `capture_app`, with schema version 8. Its stores are `drafts`, `assets`, `pending_ops`, `lead_queue`, and `completed_leads`, each created with key path `id`.

Fresh creation of `pending_ops` adds the `by_owner` index. The upgrade handler does not add that index to an already existing `pending_ops` store. It does have separate upgrade handling for owner indexes on `assets` and `completed_leads`. Documentation must not describe the existing-store owner-index migration as universal.

Raw `dbPut()` and `dbDelete()` resolve on transaction completion. Database-opening failures are caught by the wrappers, with fallback return values. Errors from the subsequently returned request/transaction promises can propagate; the outer catch does not swallow all asynchronous IndexedDB failures. Avoid documenting either guaranteed persistence or universally silent storage failures.

Source: [db.ts](../src/capture/db.ts).

## Cleanup

The scheduler polls at a configured interval of five seconds. Its local cleanup is throttled to five minutes and uses a three-day retention duration. Cleanup removes owner-scoped local completed-lead records with status `synced` and a valid `syncedAt` older than the cutoff. It does not constitute backend lead or evidence-asset cleanup.

The repository's automatic queue-deletion migration defines an update trigger for a transition into `COMPLETED`. It does not define automatic deletion for `REQUIRES_REVIEW`. The migration also includes a one-time deletion of existing completed queue rows. Migration presence is not, by itself, proof that a particular deployment has applied it.

Sources: [scheduler.ts](../src/alpe/scheduler.ts), [completedLeadsStorage.ts](../src/capture/completedLeadsStorage.ts), [queue deletion migration](../supabase/migrations/20260807212855_auto_delete_completed_queue_entries.sql).

## Offline operations and evidence

Offline flush locking is maintained in a JavaScript map; it is not a shared cross-tab lock. Operations are attempted in creation order. Ordinary failures retain an operation and increase its retry count, while the loop continues. The implementation does not impose a retry cap or backoff delay on these offline operations. Authentication-error handling is separate and deletes operations matching its error-message checks.

Manual capture includes voice recording and notes-image controls, with evidence registration and offline upload operations. Business-card storage uses `{userId}/{assetId}.jpg`; notes images use `{userId}/{sessionId}/notes.jpg`; voice upload paths use an extension selected from the MIME type.

Sources: [captureOfflineQueue.ts](../src/capture/captureOfflineQueue.ts), [ManualEntryForm.tsx](../src/capture/ManualEntryForm.tsx), [captureEvidenceManager.ts](../src/capture/captureEvidenceManager.ts), [assetStorageUpload.ts](../src/capture/assetStorageUpload.ts).

## Boundaries for future documentation

Do not present draft checkpoint/resume designs, measured performance or quota figures, complete cross-tab deduplication, or guaranteed browser-storage durability as established implementation facts. Database objects in an extract establish their presence in that extract; application use needs a corresponding code path. The deployed ALPE flag and actual production execution remain outside the verification performed here.
