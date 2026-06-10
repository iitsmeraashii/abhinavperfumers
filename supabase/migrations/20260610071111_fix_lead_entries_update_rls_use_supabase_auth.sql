-- Fix lead_entries UPDATE policy to use Supabase Auth (auth.uid())
-- instead of the legacy custom-auth current_setting('app.current_user').
--
-- Problems fixed:
--   1. Old UPDATE policy used current_setting() which is always empty under Supabase Auth.
--   2. No UPDATE policy existed for admins at all.

-- Drop the broken legacy policy
DROP POLICY IF EXISTS "Sales rep can update own leads" ON lead_entries;

-- Admin UPDATE: any authenticated user with role='admin' in sales_representatives
CREATE POLICY "Admin can update all leads"
  ON lead_entries
  FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM sales_representatives
      WHERE auth_user_id = auth.uid()
        AND role = 'admin'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM sales_representatives
      WHERE auth_user_id = auth.uid()
        AND role = 'admin'
    )
  );

-- Sales rep UPDATE: only their own leads (matched by rep_code)
CREATE POLICY "Sales rep can update own leads"
  ON lead_entries
  FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM sales_representatives
      WHERE auth_user_id = auth.uid()
        AND rep_code = lead_entries.sales_rep_code
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM sales_representatives
      WHERE auth_user_id = auth.uid()
        AND rep_code = lead_entries.sales_rep_code
    )
  );
