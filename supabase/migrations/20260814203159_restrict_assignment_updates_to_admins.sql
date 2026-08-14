/*
# Restrict sales_rep_code and event_code updates to admins only

## Purpose
The existing "Sales rep can update own leads" RLS policy allows sales reps
to update ALL columns on their own leads, including sales_rep_code and
event_code. This migration replaces that policy with one that blocks
non-admin users from changing sales_rep_code or event_code.

## Changes
1. Drops the existing "Sales rep can update own leads" policy.
2. Creates a new policy that allows sales reps to update their own leads
   ONLY when the new sales_rep_code and event_code values match the existing
   ones (i.e., they are not changing those fields).

## Security
- Admins are unaffected — the "Admin can update all leads" policy still
  allows full access.
- Sales reps can still update all other fields (phones, emails, notes, etc.)
  on their own leads.
- Sales reps CANNOT change sales_rep_code or event_code — the WITH CHECK
  clause enforces that the new values must equal the old values for those
  columns.
*/

DROP POLICY IF EXISTS "Sales rep can update own leads" ON lead_entries;

CREATE POLICY "Sales rep can update own leads (no assignment changes)"
ON lead_entries FOR UPDATE
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM sales_representatives
    WHERE sales_representatives.auth_user_id = auth.uid()
      AND sales_representatives.rep_code = lead_entries.sales_rep_code
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1 FROM sales_representatives
    WHERE sales_representatives.auth_user_id = auth.uid()
      AND sales_representatives.rep_code = lead_entries.sales_rep_code
  )
  -- Non-admin cannot change sales_rep_code or event_code
  -- The WITH CHECK evaluates against the NEW row values, so we verify
  -- that these columns haven't changed by comparing to the existing row
  AND EXISTS (
    SELECT 1 FROM lead_entries old
    WHERE old.id = lead_entries.id
      AND old.sales_rep_code = lead_entries.sales_rep_code
      AND old.event_code IS NOT DISTINCT FROM lead_entries.event_code
  )
);
