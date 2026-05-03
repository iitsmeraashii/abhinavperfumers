/*
  # Fix lead_follow_ups RLS policies

  The app uses custom session auth with current_setting('app.current_user')
  (not Supabase auth.uid()). Replace all policies to match the pattern
  used by lead_notes and lead_entries in this project.
*/

DROP POLICY IF EXISTS "Authenticated users can view follow-ups" ON lead_follow_ups;
DROP POLICY IF EXISTS "Authenticated users can insert follow-ups" ON lead_follow_ups;
DROP POLICY IF EXISTS "Authenticated users can update follow-ups" ON lead_follow_ups;

-- SELECT: open to all (matches lead_notes pattern)
CREATE POLICY "follow_ups_select"
  ON lead_follow_ups FOR SELECT
  USING (true);

-- INSERT: allow if the lead belongs to current user (or admin sees all leads)
CREATE POLICY "follow_ups_insert"
  ON lead_follow_ups FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM lead_entries le
      WHERE le.id = lead_follow_ups.lead_id::text
        AND (
          le.sales_rep_code = current_setting('app.current_user', true)
          OR current_setting('app.current_user', true) IS NULL
        )
    )
  );

-- UPDATE: allow if the lead belongs to current user
CREATE POLICY "follow_ups_update"
  ON lead_follow_ups FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM lead_entries le
      WHERE le.id = lead_follow_ups.lead_id::text
        AND (
          le.sales_rep_code = current_setting('app.current_user', true)
          OR current_setting('app.current_user', true) IS NULL
        )
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM lead_entries le
      WHERE le.id = lead_follow_ups.lead_id::text
        AND (
          le.sales_rep_code = current_setting('app.current_user', true)
          OR current_setting('app.current_user', true) IS NULL
        )
    )
  );
