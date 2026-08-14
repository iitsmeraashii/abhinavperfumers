/*
# Fix Sales Reps admin policy recursion

1. Purpose
   - Fixes the PostgreSQL infinite-recursion error that prevents the Sales Reps
     page from loading.
   - The previous admin SELECT policy queried `sales_representatives` from inside
     a policy on `sales_representatives`, which PostgreSQL rejects as recursive.

2. Security changes
   - Adds `is_admin_user()` as a SECURITY DEFINER helper with a fixed
     `search_path = public`. It checks the authenticated user's own
     `sales_representatives` row while bypassing that table's RLS only inside the
     helper.
   - Revokes execute access from `PUBLIC` and `anon`; grants execute only to
     `authenticated` because the helper is used by authenticated RLS policies.
   - Replaces the recursive `Admin can read all sales reps` policy condition with
     `is_admin_user()`.
   - Existing self-read, active-rep-read, self-update, and admin bulk-update
     authorization behavior is unchanged.

3. Important notes
   - No tables, columns, lead lifecycle values, or existing permissions are
     removed or changed.
   - The helper returns only a boolean and exposes no representative data.
   - `set_reps_default_event` remains the narrow SECURITY DEFINER path for
     admin-only cross-representative default-event updates.
*/

CREATE OR REPLACE FUNCTION public.is_admin_user()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.sales_representatives
    WHERE auth_user_id = auth.uid()
      AND role = 'admin'
  );
$$;

REVOKE ALL ON FUNCTION public.is_admin_user() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.is_admin_user() FROM anon;
GRANT EXECUTE ON FUNCTION public.is_admin_user() TO authenticated;

DROP POLICY IF EXISTS "Admin can read all sales reps" ON public.sales_representatives;

CREATE POLICY "Admin can read all sales reps"
  ON public.sales_representatives FOR SELECT
  TO authenticated
  USING (public.is_admin_user());
