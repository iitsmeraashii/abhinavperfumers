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
  -- Confirm no lingering column-level grants
  IF EXISTS (
    SELECT 1 FROM information_schema.column_privileges
    WHERE table_schema = 'public' AND table_name = 'sales_representatives'
      AND grantee IN ('anon', 'authenticated')
  ) THEN
    RAISE EXCEPTION 'ROLLBACK VERIFICATION FAILED: column-level grants still exist'
      USING ERRCODE = 'check_violation';
  END IF;
END $$;

COMMIT;
