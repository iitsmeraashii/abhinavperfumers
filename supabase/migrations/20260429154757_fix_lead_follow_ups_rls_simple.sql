/*
  # Simplify lead_follow_ups RLS to match lead_notes pattern

  Replace the complex EXISTS-based INSERT policy with a simple
  WITH CHECK (true) to match how lead_notes works in this app.
*/

DROP POLICY IF EXISTS "follow_ups_insert" ON lead_follow_ups;
DROP POLICY IF EXISTS "follow_ups_update" ON lead_follow_ups;

CREATE POLICY "follow_ups_insert"
  ON lead_follow_ups FOR INSERT
  WITH CHECK (true);

CREATE POLICY "follow_ups_update"
  ON lead_follow_ups FOR UPDATE
  USING (true)
  WITH CHECK (true);
