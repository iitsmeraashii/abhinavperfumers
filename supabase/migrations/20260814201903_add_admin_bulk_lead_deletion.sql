/*
# Add admin-only bulk lead deletion

## Purpose
Provides database-side admin-only authorization for permanent (hard) deletion
of lead_entries rows. This supports the bulk-delete feature on the Leads page.

## Changes
1. Adds a DELETE RLS policy on lead_entries restricted to admin users.
2. Creates a `delete_leads_bulk` SECURITY DEFINER function that:
   - Verifies the caller is an admin (via sales_representatives.role = 'admin')
   - Nullifies any capture_sessions.finalized_lead_id references (NO ACTION FK)
   - Deletes the specified lead_entries rows (hard delete)
   - lead_follow_ups and lead_notes cascade-delete automatically (CASCADE FK)
   - Returns the count of deleted rows

## Security
- The RLS DELETE policy ensures only admin users can delete leads via the
  Supabase client. Non-admin sales reps are blocked at the database level.
- The SECURITY DEFINER function provides an additional authorization check
  and handles the capture_sessions FK dependency safely.
- A non-admin calling the RPC gets a permission error — no rows are deleted.

## Foreign Key Behavior
- lead_follow_ups.lead_id → CASCADE (auto-deleted with the lead)
- lead_notes.lead_id → CASCADE (auto-deleted with the lead)
- capture_sessions.finalized_lead_id → NO ACTION (must be nullified first)
- processing_queue — no FK to lead_entries (references capture_sessions)
- capture_assets/extraction_results — no FK to lead_entries (reference capture_sessions)

## What happens to related data
- lead_follow_ups: deleted (CASCADE)
- lead_notes: deleted (CASCADE)
- capture_sessions: preserved — finalized_lead_id is set to NULL so the
  capture/extraction/review history remains intact, just unlinked from the
  deleted lead. This preserves historical capture data.
- processing_queue: unaffected (no FK to lead_entries)
- extraction_results: unaffected (no FK to lead_entries)
- capture_assets: unaffected (no FK to lead_entries)
*/

-- 1. DELETE RLS policy: admin-only
DROP POLICY IF EXISTS "Admin can delete leads" ON lead_entries;
CREATE POLICY "Admin can delete leads"
ON lead_entries FOR DELETE
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM sales_representatives
    WHERE sales_representatives.auth_user_id = auth.uid()
      AND sales_representatives.role = 'admin'
  )
);

-- 2. SECURITY DEFINER function for bulk delete
CREATE OR REPLACE FUNCTION delete_leads_bulk(lead_ids text[])
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  deleted_count integer;
  is_admin boolean;
BEGIN
  -- Verify the caller is an admin
  SELECT EXISTS (
    SELECT 1 FROM sales_representatives
    WHERE auth_user_id = auth.uid()
      AND role = 'admin'
  ) INTO is_admin;

  IF NOT is_admin THEN
    RAISE EXCEPTION 'Permission denied: only admins can delete leads';
  END IF;

  -- Nullify capture_sessions.finalized_lead_id references (NO ACTION FK)
  UPDATE capture_sessions
  SET finalized_lead_id = NULL
  WHERE finalized_lead_id = ANY(lead_ids);

  -- Hard delete the lead_entries rows
  -- lead_follow_ups and lead_notes cascade-delete automatically
  DELETE FROM lead_entries
  WHERE id = ANY(lead_ids);

  GET DIAGNOSTICS deleted_count = ROW_COUNT;

  RETURN deleted_count;
END;
$$;
