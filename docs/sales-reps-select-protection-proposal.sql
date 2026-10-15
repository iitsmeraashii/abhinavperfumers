-- ════════════════════════════════════════════════════════════════════════════
-- sales_representatives sensitive-column SELECT protection — PROPOSAL
-- Status: UNEXECUTED
-- ════════════════════════════════════════════════════════════════════════════
--
-- CONFIRMED PRODUCTION METADATA
--   Table owner:        postgres (BYPASSRLS=true, superuser=false)
--   RLS enabled:        true
--   FORCE RLS:          false
--   Table ACL:          postgres=arwdDxtm/postgres,
--                       anon=arwdDxtm/postgres,
--                       authenticated=arwdDxtm/postgres,
--                       service_role=arwdDxtm/postgres
--   Column ACLs:        none (no explicit column-level grants)
--   my_rep_profile:     owner=postgres, reloptions=NULL (security definer mode),
--                       SELECT granted to anon, authenticated
--   Sensitive columns:  password, session_token, session_expires_at
--
-- WHAT THIS DOES
--   1. Revokes blanket table-level SELECT from anon and authenticated.
--   2. Grants authenticated column-level SELECT on a non-sensitive allowlist.
--   3. Grants NO direct table SELECT to anon (login uses SECURITY DEFINER RPCs).
--   4. Asserts sensitive columns are denied; allowed columns are preserved.
--   5. Leaves every write privilege, RLS policy, view, function, service_role
--      and postgres privilege, and default privilege untouched.
--
-- WHAT THIS DOES NOT DO
--   - Does not change my_rep_profile security mode (reloptions stay NULL).
--   - Does not modify RLS policies.
--   - Does not drop columns, clear values, or rotate credentials.
--   - Does not change default privileges.
-- =============================================================================

BEGIN;
SET LOCAL statement_timeout = '30s';
SET LOCAL lock_timeout = '10s';
SET LOCAL idle_in_transaction_session_timeout = '60s';

-- ── Step 1: Revoke blanket table-level SELECT from browser roles ─────────────
--   anon currently has arwdDxtm; we remove only SELECT (r).
--   authenticated currently has arwdDxtm; we remove only SELECT (r).
--   WRITE privileges (a, w, d, D, x, t, m) are preserved on both roles.
--   postgres and service_role ACLs are not touched.

REVOKE SELECT ON public.sales_representatives FROM anon;
REVOKE SELECT ON public.sales_representatives FROM authenticated;

-- ── Step 2: Grant column-level SELECT to authenticated ───────────────────────
--   These are the only columns the application reads directly or through
--   the my_rep_profile view (which runs as definer / owner and bypasses
--   underlying column grants, but its definition selects only these columns).
--
--   Column allowlist (12 columns):
--     id, rep_code, name, email, phone, created_at,
--     is_active, role, login_enabled, auth_user_id,
--     default_event_id, default_capture_profile
--
--   Sensitive columns EXCLUDED:
--     password, session_token, session_expires_at

GRANT SELECT (
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
) ON public.sales_representatives TO authenticated;

-- ── Step 3: No direct SELECT grant to anon ───────────────────────────────────
--   Login is handled by get_rep_login_status(p_rep_code) and
--   get_rep_email_by_code(p_rep_code), both SECURITY DEFINER owned by
--   postgres (BYPASSRLS=true). They bypass RLS and column grants entirely,
--   so anon needs no direct table SELECT for login to function.
--   The existing anon RLS policy "Anon can read active reps for login lookup"
--   becomes a no-op for direct table access (no column grant), but is left
--   in place to avoid unnecessary policy churn.

-- ── Step 4: Assertions — deny sensitive columns, allow non-sensitive ─────────

-- 4a: Assert anon has NO SELECT on any column of sales_representatives
DO $$
DECLARE
  v_col text;
  v_has boolean;
BEGIN
  FOR v_col IN
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'sales_representatives'
    ORDER BY ordinal_position
  LOOP
    v_has := has_column_privilege('anon', 'public.sales_representatives', v_col, 'SELECT');
    IF v_has THEN
      RAISE EXCEPTION 'ASSERTION FAILED: anon still has SELECT on column %', v_col
        USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
END $$;

-- 4b: Assert authenticated has NO SELECT on the three sensitive columns
DO $$
DECLARE
  v_col text;
  v_has boolean;
BEGIN
  FOR v_col IN SELECT unnest(ARRAY['password', 'session_token', 'session_expires_at'])
  LOOP
    v_has := has_column_privilege('authenticated', 'public.sales_representatives', v_col, 'SELECT');
    IF v_has THEN
      RAISE EXCEPTION 'ASSERTION FAILED: authenticated still has SELECT on sensitive column %', v_col
        USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
END $$;

-- 4c: Assert authenticated retains SELECT on every allowed column
DO $$
DECLARE
  v_col text;
  v_has boolean;
BEGIN
  FOR v_col IN SELECT unnest(ARRAY[
    'id', 'rep_code', 'name', 'email', 'phone', 'created_at',
    'is_active', 'role', 'login_enabled', 'auth_user_id',
    'default_event_id', 'default_capture_profile'
  ])
  LOOP
    v_has := has_column_privilege('authenticated', 'public.sales_representatives', v_col, 'SELECT');
    IF NOT v_has THEN
      RAISE EXCEPTION 'ASSERTION FAILED: authenticated lost SELECT on allowed column %', v_col
        USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
END $$;

-- 4d: Assert write privileges are unchanged for both browser roles
DO $$
DECLARE
  v_has_a boolean;  -- INSERT
  v_has_w boolean;  -- UPDATE
  v_has_d boolean;  -- DELETE
BEGIN
  -- anon: should still have arwdDxtm minus r  → check a, w, d
  v_has_a := has_table_privilege('anon', 'public.sales_representatives', 'INSERT');
  v_has_w := has_table_privilege('anon', 'public.sales_representatives', 'UPDATE');
  v_has_d := has_table_privilege('anon', 'public.sales_representatives', 'DELETE');
  IF NOT (v_has_a AND v_has_w AND v_has_d) THEN
    RAISE EXCEPTION 'ASSERTION FAILED: anon lost write privileges (insert=%, update=%, delete=%)',
      v_has_a, v_has_w, v_has_d
      USING ERRCODE = 'check_violation';
  END IF;

  -- authenticated: should still have arwdDxtm minus r → check a, w, d
  v_has_a := has_table_privilege('authenticated', 'public.sales_representatives', 'INSERT');
  v_has_w := has_table_privilege('authenticated', 'public.sales_representatives', 'UPDATE');
  v_has_d := has_table_privilege('authenticated', 'public.sales_representatives', 'DELETE');
  IF NOT (v_has_a AND v_has_w AND v_has_d) THEN
    RAISE EXCEPTION 'ASSERTION FAILED: authenticated lost write privileges (insert=%, update=%, delete=%)',
      v_has_a, v_has_w, v_has_d
      USING ERRCODE = 'check_violation';
  END IF;
END $$;

-- 4e: Assert service_role and postgres retain full table SELECT
DO $$
BEGIN
  IF NOT has_table_privilege('service_role', 'public.sales_representatives', 'SELECT') THEN
    RAISE EXCEPTION 'ASSERTION FAILED: service_role lost SELECT'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT has_table_privilege('postgres', 'public.sales_representatives', 'SELECT') THEN
    RAISE EXCEPTION 'ASSERTION FAILED: postgres lost SELECT'
      USING ERRCODE = 'check_violation';
  END IF;
END $$;

COMMIT;
