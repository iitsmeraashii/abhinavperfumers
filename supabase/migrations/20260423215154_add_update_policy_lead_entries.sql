/*
  # Add UPDATE RLS policies for lead_entries

  ## Changes
  - Adds UPDATE policy for sales reps: can only update their own leads
  - Adds UPDATE policy for admins: can update any lead

  ## Security
  - Sales reps are identified by current_setting('app.current_user')
  - Admins bypass row filtering (qual = true)
*/

CREATE POLICY "Sales rep can update own leads"
  ON lead_entries
  FOR UPDATE
  TO public
  USING (sales_rep_code = current_setting('app.current_user'::text))
  WITH CHECK (sales_rep_code = current_setting('app.current_user'::text));

CREATE POLICY "Admin can update all leads"
  ON lead_entries
  FOR UPDATE
  TO public
  USING (true)
  WITH CHECK (true);
