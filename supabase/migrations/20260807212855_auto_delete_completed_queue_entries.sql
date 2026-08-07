/*
# Auto-delete completed processing queue entries

## Problem
The ALPE worker marks processing_queue rows as `COMPLETED` (setting
`processing_completed_at` and `state = 'COMPLETED'`) after successfully
promoting a lead, but never deletes the row from the queue. This causes
completed jobs to accumulate indefinitely, appearing as stale "pending
sync" entries in the UI even though the lead was already created and the
capture session was already marked as `promoted`.

## Fix
1. Add a trigger that deletes processing_queue rows immediately after
   their state is set to `COMPLETED`. The deletion is safe because:
   - The lead has already been created in lead_entries
   - The capture session's `promoted_lead_id` is already set
   - The row's `processing_completed_at` is set, confirming completion
2. Clean up the 13 existing stuck COMPLETED rows.

## Security
- No RLS policy changes.
- The trigger runs with SECURITY DEFINER (the table owner) so it can
  delete rows regardless of the caller's RLS context, but only fires
  on UPDATE — the caller still needs UPDATE permission to set the
  state to COMPLETED, so this doesn't widen access.

## Important notes
1. The trigger fires AFTER UPDATE, only when `state` transitions TO
   `'COMPLETED'`. It uses a WHEN clause comparing OLD.state !=
   NEW.state to avoid firing on no-op updates.
2. The function is marked SECURITY DEFINER so the DELETE inside the
   trigger succeeds even though RLS would otherwise block a client
   from deleting rows owned by another user (though in practice the
   worker is the same user).
3. Existing COMPLETED rows are deleted in a one-time cleanup DELETE
   at the end of this migration.
*/

-- ── 1. Trigger function: delete queue row on completion ──

CREATE OR REPLACE FUNCTION delete_completed_queue_entry()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  DELETE FROM processing_queue WHERE id = NEW.id;
  RETURN NEW;
END;
$$;

-- ── 2. Trigger: fire after state transitions to COMPLETED ──

DROP TRIGGER IF EXISTS trg_delete_completed_queue ON processing_queue;

CREATE TRIGGER trg_delete_completed_queue
  AFTER UPDATE OF state ON processing_queue
  FOR EACH ROW
  WHEN (OLD.state <> 'COMPLETED' AND NEW.state = 'COMPLETED')
  EXECUTE FUNCTION delete_completed_queue_entry();

-- ── 3. Cleanup: delete existing stuck COMPLETED rows ──

DELETE FROM processing_queue WHERE state = 'COMPLETED';