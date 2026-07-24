/*
# Add default_capture_profile to sales_representatives

1. New Columns
- `sales_representatives.default_capture_profile` (text, NOT NULL, default 'CRM')
  Stores the rep's preferred Capture Profile for new lead capture sessions.
  Constrained to the existing CaptureProfile union values ('CRM', 'EXHIBITION')
  via a CHECK constraint — no new enum type is introduced.

2. Modified Views
- `my_rep_profile`: recreated to also expose `default_capture_profile` so the
  authenticated rep's frontend can read their current preference after login.
  The view is dropped and recreated (not OR REPLACE) because CREATE OR REPLACE
  VIEW cannot change the column list/order of an existing view.

3. Security
- No new tables. RLS is already enabled on `sales_representatives`.
- The existing "Auth users can update own rep row" UPDATE policy already
  covers `auth.uid() = auth_user_id` and permits updates to any column,
  so reps can update their own `default_capture_profile` without a new policy.
- The view is SECURITY INVOKER (default) and re-granted SELECT TO authenticated.

4. Important Notes
1. The column is added with IF NOT EXISTS so the migration is idempotent.
2. Existing rows backfill to 'CRM' via the column DEFAULT, so all current
   users immediately default to CRM with no data migration step.
3. The CHECK constraint is added only if it does not already exist.
4. The view is dropped and recreated to expose the new column.
*/

ALTER TABLE sales_representatives
  ADD COLUMN IF NOT EXISTS default_capture_profile text NOT NULL DEFAULT 'CRM';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'sales_reps_default_capture_profile_check'
      AND conrelid = 'sales_representatives'::regclass
  ) THEN
    ALTER TABLE sales_representatives
      ADD CONSTRAINT sales_reps_default_capture_profile_check
      CHECK (default_capture_profile IN ('CRM', 'EXHIBITION'));
  END IF;
END $$;

DROP VIEW IF EXISTS public.my_rep_profile;

CREATE VIEW public.my_rep_profile AS
  SELECT id, rep_code, name, email, role, login_enabled, is_active,
         auth_user_id, default_event_id, phone, default_capture_profile
  FROM sales_representatives
  WHERE auth_user_id = auth.uid();

GRANT SELECT ON public.my_rep_profile TO authenticated;
