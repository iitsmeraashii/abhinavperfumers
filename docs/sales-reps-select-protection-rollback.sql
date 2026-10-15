-- ════════════════════════════════════════════════════════════════════════════
-- sales_representatives sensitive-column SELECT protection — ROLLBACK
-- Status: UNEXECUTED
-- ════════════════════════════════════════════════════════════════════════════
--
-- WARNING: This rollback RESTORES the original broad table-level SELECT
-- grants to anon and authenticated. After rollback, both browser roles
-- can again read password, session_token, and session_expires_at on any
-- row visible through RLS. Only run this if the proposal caused a
-- regression that cannot be fixed by adjusting column grants.
--
-- WHAT THIS DOES
--   1. Removes only the column-level SELECT grants introduced by the proposal.
--   2. Restores the exact prior table-level SELECT grants (arwdDxtm).
--   3. Does not touch write privileges, RLS policies, views, functions,
--      service_role/postgres privileges, or default privileges.
--
-- WHAT THIS DOES NOT DO
--   - Does not modify RLS policies or views.
--   - Does not drop columns or change column definitions.
-- =============================================================================

BEGIN;

-- ── Step 1: Remove column-level SELECT grants introduced by the proposal ─────

REVOKE SELECT (
  id,
  rep_code,
  name,
  email,
  phone,
  created_at,
  is_active,
  role,
  login_enabled,
  auth_user_id,
  default_event_id,
  default_capture_profile
) ON public.sales_representatives FROM authenticated;

-- ── Step 2: Restore original table-level SELECT grants ───────────────────────
--   Prior ACL was anon=arwdDxtm, authenticated=arwdDxtm.
--   The proposal revoked only SELECT (r) from both. Restore it.

GRANT SELECT ON public.sales_representatives TO anon;
GRANT SELECT ON public.sales_representatives TO authenticated;

-- ── Step 3: Verify restoration matches the original ACL ─────────────────────
--   Both roles should now have full table-level SELECT again.
--   This is the state that RE-EXPOSES password, session_token, session_expires_at.

DO $$
BEGIN
  IF NOT has_table_privilege('anon', 'public.sales_representatives', 'SELECT') THEN
    RAISE EXCEPTION 'ROLLBACK VERIFICATION FAILED: anon lacks SELECT'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT has_table_privilege('authenticated', 'public.sales_representatives', 'SELECT') THEN
    RAISE EXCEPTION 'ROLLBACK VERIFICATION FAILED: authenticated lacks SELECT'
      USING ERRCODE = 'check_violation';
  END IF;
  -- Confirm the proposal's column-level SELECT grants on the 12 allowed
  -- columns were fully removed.  Inspect pg_attribute.attacl directly with
  -- aclexplode, scoped to authenticated SELECT on exactly those 12 columns.
  -- information_schema.column_privileges may show grants implied by the
  -- restored table-level SELECT, producing false positives.  Other column
  -- privileges (other grantees, other columns, other privilege types) are
  -- not rejected.
  IF EXISTS (
    SELECT 1
    FROM pg_attribute a
    WHERE a.attrelid = 'public.sales_representatives'::regclass
      AND a.attisdropped = false
      AND a.attname IN (
        'id', 'rep_code', 'name', 'email', 'phone', 'created_at',
        'is_active', 'role', 'login_enabled', 'auth_user_id',
        'default_event_id', 'default_capture_profile'
      )
      AND a.attacl IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM aclexplode(a.attacl) acl
        JOIN pg_roles r ON acl.grantee = r.oid
        WHERE r.rolname = 'authenticated'
          AND acl.privilege_type = 'SELECT'
      )
  ) THEN
    RAISE EXCEPTION 'ROLLBACK VERIFICATION FAILED: authenticated SELECT column-level grants from the proposal still exist in pg_attribute.attacl'
      USING ERRCODE = 'check_violation';
  END IF;
END $$;

COMMIT;
