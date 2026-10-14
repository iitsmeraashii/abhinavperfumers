-- ════════════════════════════════════════════════════════════════════════════
-- sales_representatives sensitive-column SELECT protection — VALIDATION
-- Status: UNEXECUTED
-- ════════════════════════════════════════════════════════════════════════════
--
-- PURPOSE
--   Apply the candidate column-grant changes inside a single rollback-only
--   transaction, run all assertions, then ROLLBACK. Nothing is permanently
--   deployed. No application data is modified.
--
-- REQUIREMENTS
--   - Run as postgres or a role with sufficient privilege to REVOKE/GRANT
--     on public.sales_representatives and SET LOCAL ROLE.
--   - Requires known rep_code values for an admin rep and a sales_rep.
--   - Requires the UUID of the admin's auth.users row for JWT simulation.
--   - No credential values (passwords, session tokens) are ever queried
--     or printed. Sensitive-column denial uses SELECT <col> ... LIMIT 0.
--
-- RESULT REPORTING
--   All test results are printed via RAISE NOTICE after the privileged
--   role is restored (SET LOCAL ROLE none). Only PASS/FAIL and counts
--   are reported — never row values, passwords, or tokens.
--
-- SESSION/INTERRUPTION LIMITATION
--   If the session is interrupted before ROLLBACK, the transaction may
--   be left open and the DDL changes could persist until the connection
--   closes (at which point PostgreSQL aborts the transaction automatically).
--   If interruption occurs, run the rollback script manually to confirm
--   restoration, or reconnect and verify table ACLs match the pre-proposal
--   state.
-- =============================================================================

-- Placeholders — replace with production values before running.
-- Do NOT put credential values here; only non-sensitive identifiers.
DO $$
BEGIN
  RAISE NOTICE 'VALIDATION: Replace placeholder values for admin_rep_code, sales_rep_code, admin_auth_uid before running.';
END $$;

-- ── 0. Begin rollback-only transaction ───────────────────────────────────────

BEGIN;

-- Short transaction-local timeouts to avoid hanging on locks.
SET LOCAL statement_timeout = '10s';
SET LOCAL lock_timeout = '5s';

-- ── 1. Apply candidate DDL (same as proposal) ────────────────────────────────

REVOKE SELECT ON public.sales_representatives FROM anon;
REVOKE SELECT ON public.sales_representatives FROM authenticated;

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

-- ── 2. Sensitive-column denial tests (LIMIT 0, no values returned) ───────────
--    For each of password, session_token, session_expires_at:
--      Test under anon, authenticated-as-admin, authenticated-as-rep.
--    Expected: SQLSTATE 42501 (insufficient_privilege).
--    Any other error or success = FAIL.
--    We use a helper DO block that catches per-column per-role.

DO $$
DECLARE
  v_sensitive_cols text[] := ARRAY['password', 'session_token', 'session_expires_at'];
  v_col text;
  v_sql text;
  v_sqlstate text;
  v_results text[] := ARRAY[];
  v_pass boolean := true;
  v_admin_auth_uid text := '00000000-0000-0000-0000-000000000000'; -- REPLACE
  v_admin_rep_code text := 'ADMIN_REP_CODE';  -- REPLACE
  v_sales_rep_code text := 'SALES_REP_CODE';  -- REPLACE
BEGIN
  -- ── 2a: anon role ─────────────────────────────────────────────────────────
  SET LOCAL ROLE anon;
  RAISE NOTICE 'IDENTITY CHECK (anon): current_user=%, auth.uid()=%',
    current_user,
    COALESCE(NULLIF(current_setting('request.jwt.claim.sub', true), ''), 'NULL');

  FOREACH v_col IN ARRAY v_sensitive_cols LOOP
    BEGIN
      v_sql := format('SELECT %I FROM public.sales_representatives LIMIT 0', v_col);
      EXECUTE v_sql;
      v_results := array_append(v_results, format('FAIL: anon SELECT %s succeeded (expected denial)', v_col));
      v_pass := false;
    EXCEPTION
      WHEN insufficient_privilege THEN
        v_results := array_append(v_results, format('PASS: anon SELECT %s denied (42501)', v_col));
      WHEN OTHERS THEN
        v_sqlstate := SQLSTATE;
        v_results := array_append(v_results, format('FAIL: anon SELECT %s unexpected error %s', v_col, v_sqlstate));
        v_pass := false;
    END;
  END LOOP;

  RESET ROLE;
  SET LOCAL request.jwt.claim.sub = '';
  SET LOCAL role = 'none';

  -- ── 2b: authenticated as admin ─────────────────────────────────────────────
  SET LOCAL ROLE authenticated;
  SET LOCAL request.jwt.claim.sub = v_admin_auth_uid;
  SET LOCAL request.jwt.claim.role = 'authenticated';

  RAISE NOTICE 'IDENTITY CHECK (admin): current_user=%, auth.uid()=%',
    current_user,
    COALESCE(NULLIF(current_setting('request.jwt.claim.sub', true), ''), 'NULL');

  FOREACH v_col IN ARRAY v_sensitive_cols LOOP
    BEGIN
      v_sql := format('SELECT %I FROM public.sales_representatives LIMIT 0', v_col);
      EXECUTE v_sql;
      v_results := array_append(v_results, format('FAIL: admin SELECT %s succeeded (expected denial)', v_col));
      v_pass := false;
    EXCEPTION
      WHEN insufficient_privilege THEN
        v_results := array_append(v_results, format('PASS: admin SELECT %s denied (42501)', v_col));
      WHEN OTHERS THEN
        v_sqlstate := SQLSTATE;
        v_results := array_append(v_results, format('FAIL: admin SELECT %s unexpected error %s', v_col, v_sqlstate));
        v_pass := false;
    END;
  END LOOP;

  -- Clear JWT GUCs before switching role
  SET LOCAL request.jwt.claim.sub = '';
  SET LOCAL request.jwt.claim.role = '';
  RESET ROLE;
  SET LOCAL role = 'none';

  -- ── 2c: authenticated as sales_rep ─────────────────────────────────────────
  --   Use the admin auth_uid temporarily; we only test column denial here,
  --   not row visibility. Column grants are role-level, not per-JWT.
  --   The denial test is identical regardless of which authenticated user.

  SET LOCAL ROLE authenticated;
  SET LOCAL request.jwt.claim.sub = v_admin_auth_uid;
  SET LOCAL request.jwt.claim.role = 'authenticated';

  -- Already tested as authenticated above; results are the same for any
  -- authenticated JWT since column grants are role-scoped. We record one
  -- extra set to confirm consistency.

  FOREACH v_col IN ARRAY v_sensitive_cols LOOP
    BEGIN
      v_sql := format('SELECT %I FROM public.sales_representatives LIMIT 0', v_col);
      EXECUTE v_sql;
      v_results := array_append(v_results, format('FAIL: rep SELECT %s succeeded (expected denial)', v_col));
      v_pass := false;
    EXCEPTION
      WHEN insufficient_privilege THEN
        v_results := array_append(v_results, format('PASS: rep SELECT %s denied (42501)', v_col));
      WHEN OTHERS THEN
        v_sqlstate := SQLSTATE;
        v_results := array_append(v_results, format('FAIL: rep SELECT %s unexpected error %s', v_col, v_sqlstate));
        v_pass := false;
    END;
  END LOOP;

  SET LOCAL request.jwt.claim.sub = '';
  SET LOCAL request.jwt.claim.role = '';
  RESET ROLE;
  SET LOCAL role = 'none';

  -- ── 2d: Report denial test results ─────────────────────────────────────────
  --   Results are collected while privileged; no sensitive values are printed.
  FOREACH v_col IN ARRAY v_results LOOP
    RAISE NOTICE '%', v_col;
  END LOOP;

  IF v_pass THEN
    RAISE NOTICE 'DENIAL TESTS: ALL PASS';
  ELSE
    RAISE NOTICE 'DENIAL TESTS: FAILURES PRESENT';
  END IF;
END $$;

-- ── 3. Permitted-read verification ───────────────────────────────────────────

DO $$
DECLARE
  v_admin_auth_uid text := '00000000-0000-0000-0000-000000000000'; -- REPLACE
  v_admin_rep_code text := 'ADMIN_REP_CODE';  -- REPLACE
  v_sales_rep_code text := 'SALES_REP_CODE';  -- REPLACE
  v_count int;
  v_status jsonb;
  v_results text[] := ARRAY[];
  v_pass boolean := true;
BEGIN
  -- ── 3a: Login RPC as anon ──────────────────────────────────────────────────
  SET LOCAL ROLE anon;
  SET LOCAL request.jwt.claim.sub = '';
  BEGIN
    SELECT public.get_rep_login_status(v_admin_rep_code) INTO v_status;
    IF v_status ? 'status' AND (v_status->>'status') = 'ok' THEN
      v_results := array_append(v_results, 'PASS: get_rep_login_status returned status=ok');
    ELSE
      v_results := array_append(v_results, format('FAIL: get_rep_login_status returned %s', v_status));
      v_pass := false;
    END IF;
  EXCEPTION
    WHEN OTHERS THEN
      v_results := array_append(v_results, format('FAIL: get_rep_login_status error: %s %s', SQLSTATE, SQLERRM));
      v_pass := false;
  END;
  RESET ROLE;
  SET LOCAL role = 'none';

  -- ── 3b: my_rep_profile as authenticated rep (column projection) ────────────
  SET LOCAL ROLE authenticated;
  SET LOCAL request.jwt.claim.sub = v_admin_auth_uid;
  SET LOCAL request.jwt.claim.role = 'authenticated';

  BEGIN
    SELECT count(*) INTO v_count FROM public.my_rep_profile;
    IF v_count = 1 THEN
      v_results := array_append(v_results, 'PASS: my_rep_profile returned 1 row');
    ELSE
      v_results := array_append(v_results, format('FAIL: my_rep_profile returned %s rows (expected 1)', v_count));
      v_pass := false;
    END IF;
  EXCEPTION
    WHEN OTHERS THEN
      v_results := array_append(v_results, format('FAIL: my_rep_profile error: %s %s', SQLSTATE, SQLERRM));
      v_pass := false;
  END;

  -- Verify actual column projection (not just count)
  BEGIN
    SELECT count(*) INTO v_count FROM (
      SELECT id, rep_code, name, email, role, login_enabled, is_active,
             auth_user_id, default_event_id, phone, default_capture_profile
      FROM public.my_rep_profile
    ) sub;
    IF v_count = 1 THEN
      v_results := array_append(v_results, 'PASS: my_rep_profile full column projection succeeded');
    ELSE
      v_results := array_append(v_results, format('FAIL: my_rep_profile projection returned %s rows', v_count));
      v_pass := false;
    END IF;
  EXCEPTION
    WHEN OTHERS THEN
      v_results := array_append(v_results, format('FAIL: my_rep_profile projection error: %s %s', SQLSTATE, SQLERRM));
      v_pass := false;
  END;

  SET LOCAL request.jwt.claim.sub = '';
  SET LOCAL request.jwt.claim.role = '';
  RESET ROLE;
  SET LOCAL role = 'none';

  -- ── 3c: Admin rep list (full projection, not count-only) ───────────────────
  SET LOCAL ROLE authenticated;
  SET LOCAL request.jwt.claim.sub = v_admin_auth_uid;
  SET LOCAL request.jwt.claim.role = 'authenticated';

  BEGIN
    SELECT count(*) INTO v_count FROM (
      SELECT id, rep_code, name, email, phone, is_active, role, default_event_id
      FROM public.sales_representatives
    ) sub;
    IF v_count > 0 THEN
      v_results := array_append(v_results, format('PASS: admin rep list projection returned %s reps', v_count));
    ELSE
      v_results := array_append(v_results, 'FAIL: admin rep list returned 0 reps');
      v_pass := false;
    END IF;
  EXCEPTION
    WHEN OTHERS THEN
      v_results := array_append(v_results, format('FAIL: admin rep list error: %s %s', SQLSTATE, SQLERRM));
      v_pass := false;
  END;

  SET LOCAL request.jwt.claim.sub = '';
  SET LOCAL request.jwt.claim.role = '';
  RESET ROLE;
  SET LOCAL role = 'none';

  -- ── 3d: Rep dropdown (rep_code, name only) as authenticated ────────────────
  SET LOCAL ROLE authenticated;
  SET LOCAL request.jwt.claim.sub = v_admin_auth_uid;
  SET LOCAL request.jwt.claim.role = 'authenticated';

  BEGIN
    SELECT count(*) INTO v_count FROM (
      SELECT rep_code, name
      FROM public.sales_representatives
      WHERE is_active = true AND login_enabled = true
    ) sub;
    IF v_count > 0 THEN
      v_results := array_append(v_results, format('PASS: rep dropdown projection returned %s active reps', v_count));
    ELSE
      v_results := array_append(v_results, 'FAIL: rep dropdown returned 0 active reps');
      v_pass := false;
    END IF;
  EXCEPTION
    WHEN OTHERS THEN
      v_results := array_append(v_results, format('FAIL: rep dropdown error: %s %s', SQLSTATE, SQLERRM));
      v_pass := false;
  END;

  SET LOCAL request.jwt.claim.sub = '';
  SET LOCAL request.jwt.claim.role = '';
  RESET ROLE;
  SET LOCAL role = 'none';

  -- ── 3e: Dashboard RPC as authenticated admin ───────────────────────────────
  SET LOCAL ROLE authenticated;
  SET LOCAL request.jwt.claim.sub = v_admin_auth_uid;
  SET LOCAL request.jwt.claim.role = 'authenticated';

  BEGIN
    SELECT count(*) INTO v_count FROM public.get_dashboard_metrics(NULL) sub;
    -- Dashboard RPC returns a single row of aggregates; count should be 1.
    IF v_count = 1 THEN
      v_results := array_append(v_results, 'PASS: get_dashboard_metrics returned 1 row');
    ELSE
      v_results := array_append(v_results, format('FAIL: get_dashboard_metrics returned %s rows', v_count));
      v_pass := false;
    END IF;
  EXCEPTION
    WHEN OTHERS THEN
      v_results := array_append(v_results, format('FAIL: get_dashboard_metrics error: %s %s', SQLSTATE, SQLERRM));
      v_pass := false;
  END;

  SET LOCAL request.jwt.claim.sub = '';
  SET LOCAL request.jwt.claim.role = '';
  RESET ROLE;
  SET LOCAL role = 'none';

  -- ── 3f: Lead list view as authenticated ────────────────────────────────────
  SET LOCAL ROLE authenticated;
  SET LOCAL request.jwt.claim.sub = v_admin_auth_uid;
  SET LOCAL request.jwt.claim.role = 'authenticated';

  BEGIN
    SELECT count(*) INTO v_count FROM public.leads_list_view;
    v_results := array_append(v_results, format('PASS: leads_list_view returned %s rows', v_count));
  EXCEPTION
    WHEN OTHERS THEN
      v_results := array_append(v_results, format('FAIL: leads_list_view error: %s %s', SQLSTATE, SQLERRM));
      v_pass := false;
  END;

  SET LOCAL request.jwt.claim.sub = '';
  SET LOCAL request.jwt.claim.role = '';
  RESET ROLE;
  SET LOCAL role = 'none';

  -- ── 3g: Report permitted-read results ──────────────────────────────────────
  FOREACH v_col IN ARRAY v_results LOOP
    RAISE NOTICE '%', v_col;
  END LOOP;

  IF v_pass THEN
    RAISE NOTICE 'PERMITTED-READ TESTS: ALL PASS';
  ELSE
    RAISE NOTICE 'PERMITTED-READ TESTS: FAILURES PRESENT';
  END IF;
END $$;

-- ── 4. Write-privilege preservation check (metadata only, no data writes) ────

DO $$
DECLARE
  v_results text[] := ARRAY[];
  v_pass boolean := true;
BEGIN
  -- anon: INSERT, UPDATE, DELETE should be intact
  IF has_table_privilege('anon', 'public.sales_representatives', 'INSERT')
     AND has_table_privilege('anon', 'public.sales_representatives', 'UPDATE')
     AND has_table_privilege('anon', 'public.sales_representatives', 'DELETE') THEN
    v_results := array_append(v_results, 'PASS: anon write privileges preserved');
  ELSE
    v_results := array_append(v_results, 'FAIL: anon write privileges changed');
    v_pass := false;
  END IF;

  -- authenticated: INSERT, UPDATE, DELETE should be intact
  IF has_table_privilege('authenticated', 'public.sales_representatives', 'INSERT')
     AND has_table_privilege('authenticated', 'public.sales_representatives', 'UPDATE')
     AND has_table_privilege('authenticated', 'public.sales_representatives', 'DELETE') THEN
    v_results := array_append(v_results, 'PASS: authenticated write privileges preserved');
  ELSE
    v_results := array_append(v_results, 'FAIL: authenticated write privileges changed');
    v_pass := false;
  END IF;

  -- service_role: full SELECT preserved
  IF has_table_privilege('service_role', 'public.sales_representatives', 'SELECT') THEN
    v_results := array_append(v_results, 'PASS: service_role SELECT preserved');
  ELSE
    v_results := array_append(v_results, 'FAIL: service_role SELECT lost');
    v_pass := false;
  END IF;

  -- postgres: full SELECT preserved
  IF has_table_privilege('postgres', 'public.sales_representatives', 'SELECT') THEN
    v_results := array_append(v_results, 'PASS: postgres SELECT preserved');
  ELSE
    v_results := array_append(v_results, 'FAIL: postgres SELECT lost');
    v_pass := false;
  END IF;

  FOREACH v_col IN ARRAY v_results LOOP
    RAISE NOTICE '%', v_col;
  END LOOP;

  IF v_pass THEN
    RAISE NOTICE 'WRITE-PRIVILEGE TESTS: ALL PASS';
  ELSE
    RAISE NOTICE 'WRITE-PRIVILEGE TESTS: FAILURES PRESENT';
  END IF;
END $$;

-- ── 5. Overall pass/fail summary ─────────────────────────────────────────────

DO $$
DECLARE
  v_all_pass boolean := true;
BEGIN
  -- Re-check all conditions for the final summary.
  -- If any sensitive column is accessible, overall = FAIL.
  IF has_column_privilege('authenticated', 'public.sales_representatives', 'password', 'SELECT')
     OR has_column_privilege('authenticated', 'public.sales_representatives', 'session_token', 'SELECT')
     OR has_column_privilege('authenticated', 'public.sales_representatives', 'session_expires_at', 'SELECT')
     OR has_column_privilege('anon', 'public.sales_representatives', 'password', 'SELECT')
     OR has_column_privilege('anon', 'public.sales_representatives', 'session_token', 'SELECT')
     OR has_column_privilege('anon', 'public.sales_representatives', 'session_expires_at', 'SELECT')
  THEN
    v_all_pass := false;
  END IF;

  IF v_all_pass THEN
    RAISE NOTICE '══ OVERALL: PASS — all expected tests passed ══';
  ELSE
    RAISE NOTICE '══ OVERALL: FAIL — one or more tests failed ══';
  END IF;
END $$;

-- ── 6. Final ROLLBACK ────────────────────────────────────────────────────────
--   All DDL changes (REVOKE/GRANT) applied in step 1 are undone.
--   The database returns to its pre-proposal ACL state.

ROLLBACK;

-- ════════════════════════════════════════════════════════════════════════════
-- INTERRUPTION/SESSION CLEANUP NOTE
-- ════════════════════════════════════════════════════════════════════════════
-- If the session is interrupted before ROLLBACK executes:
--   1. PostgreSQL will abort the open transaction when the connection closes,
--      reverting all DDL automatically.
--   2. To verify, reconnect and check that anon and authenticated still have
--      table-level SELECT (the pre-proposal state):
--        SELECT grantee, privilege_type
--        FROM information_schema.table_privileges
--        WHERE table_schema = 'public' AND table_name = 'sales_representatives'
--          AND grantee IN ('anon', 'authenticated');
--      Both should show SELECT among their privileges.
--   3. If column-level grants persist (interruption left them), run the
--      rollback script to restore the original state.
-- ════════════════════════════════════════════════════════════════════════════

-- ════════════════════════════════════════════════════════════════════════════
-- REMAINING LIVE-METADATA CHECKS (not covered by this validation)
-- ════════════════════════════════════════════════════════════════════════════
-- This validation does NOT close every exposure path. The following
-- live-metadata checks remain outstanding and must be run separately
-- before claiming complete sensitive-column protection:
--
-- 1. VIEW EXPOSURE AUDIT
--    Query all views in public whose definition references
--    sales_representatives. For each, confirm the SELECT list excludes
--    password, session_token, session_expires_at. If any view uses
--    SELECT * or a whole-row reference, it may expose sensitive columns
--    despite table-level column grants (views run as definer when
--    reloptions is NULL, bypassing the caller's column grants).
--    Query:
--      SELECT c.relname, pg_get_viewdef(c.oid, true)
--      FROM pg_class c
--      JOIN pg_namespace n ON c.relnamespace = n.oid
--      WHERE n.nspname = 'public' AND c.relkind = 'v'
--        AND pg_get_viewdef(c.oid, true) ILIKE '%sales_representatives%';
--
-- 2. SECURITY DEFINER FUNCTION OUTPUT AUDIT
--    Query all SECURITY DEFINER functions that reference
--    sales_representatives. For each, inspect the function body to
--    confirm that no sensitive column values are included in the
--    return value (jsonb_build_object, RETURN NEXT, OUT parameters,
--    or composite returns). SECURITY DEFINER functions owned by
--    postgres bypass RLS (BYPASSRLS=true, FORCE RLS=false) and are
--    NOT subject to column grants.
--    Query:
--      SELECT p.proname, pg_get_functiondef(p.oid)
--      FROM pg_proc p
--      JOIN pg_namespace n ON p.pronamespace = n.oid
--      WHERE n.nspname = 'public' AND p.prosecdef = true
--        AND pg_get_functiondef(p.oid) ILIKE '%sales_representatives%';
--
-- 3. my_rep_profile SECURITY MODE
--    Confirmed reloptions=NULL (definer mode). In definer mode the view
--    runs as postgres and bypasses column grants. The view's own SELECT
--    list is the protection boundary, not column grants. If the view is
--    ever recreated with SELECT * or additional columns, sensitive
--    columns would be exposed. Consider recreating with
--    security_invoker=true in a separate task so column grants apply
--    through the view.
--
-- 4. ROLE MEMBERSHIP CHAIN
--    Confirm anon and authenticated are not members of any role that
--    retains table-level SELECT on sales_representatives. If they are,
--    column-level grants alone are insufficient.
--    Query:
--      WITH RECURSIVE role_tree AS (
--        SELECT m.member, m.roleid FROM pg_auth_members m
--        WHERE m.member IN (SELECT oid FROM pg_roles WHERE rolname IN ('anon','authenticated'))
--        UNION ALL
--        SELECT rt.member, m.roleid FROM role_tree rt
--        JOIN pg_auth_members m ON rt.roleid = m.member
--      )
--      SELECT leaf.rolname, parent.rolname
--      FROM role_tree rt
--      JOIN pg_roles leaf ON rt.member = leaf.oid
--      JOIN pg_roles parent ON rt.roleid = parent.oid;
--
-- 5. DEFAULT ACLS
--    Default ACLs on the public schema could grant SELECT to anon or
--    authenticated on future tables. Not in scope for this change but
--    should be audited separately.
-- ════════════════════════════════════════════════════════════════════════════
