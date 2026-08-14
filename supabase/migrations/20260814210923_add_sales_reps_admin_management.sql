/*
# Sales Reps admin management: RLS + bulk default-event update

1. Purpose
   - Adds an admin-only SELECT policy on `sales_representatives` so admins can see
     ALL reps (including inactive ones) on the new Sales Reps management page.
   - Adds a SECURITY DEFINER function `set_reps_default_event` that lets an admin
     bulk-update the `default_event_id` for one or more sales reps.
   - The function validates that the caller is an admin and that the target event
     has status = 'ACTIVE'. It does NOT weaken existing rep self-update RLS.

2. Security
   - New SELECT policy: "Admin can read all sales reps" — scoped to authenticated
     users whose own rep row has role = 'admin'. This is additive to existing
     policies (self-read, active-rep-read).
   - `set_reps_default_event` is SECURITY DEFINER, search_path = public. It checks
     admin role via auth.uid() and event status before performing the UPDATE.
     Non-admins receive an error and no rows are changed.
   - No existing policies are dropped or weakened.

3. Notes
   - The function accepts an array of rep_codes and a single event UUID.
   - It returns a JSONB object: { success, updated_count } or { success, error }.
   - Only the `default_event_id` column is modified — no other fields.
*/

-- ── Admin SELECT policy on sales_representatives ──────────────────────────────
-- Allows admins to read ALL reps (including inactive) for the management page.
-- Existing policies (self-read, active-rep-read) remain in place.

DROP POLICY IF EXISTS "Admin can read all sales reps" ON sales_representatives;

CREATE POLICY "Admin can read all sales reps"
  ON sales_representatives FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM sales_representatives sr
      WHERE sr.auth_user_id = auth.uid()
        AND sr.role = 'admin'
    )
  );

-- ── Bulk default-event update function ────────────────────────────────────────

CREATE OR REPLACE FUNCTION set_reps_default_event(p_rep_codes text[], p_event_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_is_admin      boolean;
  v_event_status event_status_enum;
  v_updated_count integer;
BEGIN
  -- Verify caller is an admin
  SELECT EXISTS (
    SELECT 1 FROM sales_representatives
    WHERE auth_user_id = auth.uid()
      AND role = 'admin'
  ) INTO v_is_admin;

  IF NOT v_is_admin THEN
    RETURN jsonb_build_object('success', false, 'error', 'Not authorized: admin role required');
  END IF;

  -- Verify event exists and is ACTIVE
  SELECT status INTO v_event_status FROM events WHERE id = p_event_id;

  IF v_event_status IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Event not found');
  END IF;

  IF v_event_status <> 'ACTIVE' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Event must be ACTIVE');
  END IF;

  -- Update default_event_id for all specified reps
  UPDATE sales_representatives
  SET default_event_id = p_event_id
  WHERE rep_code = ANY(p_rep_codes);

  GET DIAGNOSTICS v_updated_count = ROW_COUNT;

  RETURN jsonb_build_object('success', true, 'updated_count', v_updated_count);
END;
$$;

-- Grant execute to authenticated (admin check is inside the function)
GRANT EXECUTE ON FUNCTION set_reps_default_event(text[], uuid) TO authenticated;
