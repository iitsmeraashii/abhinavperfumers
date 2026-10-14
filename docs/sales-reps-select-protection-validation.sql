-- ════════════════════════════════════════════════════════════════════════════
-- sales_representatives sensitive-column SELECT protection — VALIDATION
-- Status: UNEXECUTED
-- ════════════════════════════════════════════════════════════════════════════
--
-- PURPOSE
--   Apply the candidate column-grant changes inside a single rollback-only
--   transaction, run all assertions, then ROLLBACK.  Nothing is permanently
--   deployed.  No application data is modified.
--
-- REQUIREMENTS
--   - Run as postgres or a role with sufficient privilege to REVOKE/GRANT
--     on public.sales_representatives and SET LOCAL ROLE.
--   - One active/login-enabled admin with non-null auth_user_id and one
--     distinct active/login-enabled sales_rep with non-null auth_user_id
--     must exist in the database.  They are selected automatically.
--   - No credential values (passwords, session tokens) are ever queried
--     or printed.  Sensitive-column denial uses SELECT <col> ... LIMIT 0.
--
-- RESULT REPORTING
--   Results are stored in a temporary table while privileged (after
--   RESET ROLE and clearing JWT claims) and returned as a final SELECT.
--   Only PASS/FAIL, counts, and SQLSTATE codes are reported — never row
--   values, passwords, tokens, or raw JSON.
--
-- OVERALL PASS CRITERIA
--   Every expected test name must appear exactly once with result = PASS.
--   Any missing, duplicate, or failed test causes overall FAIL.
--
-- INTERRUPTION/SESSION CLEANUP
--   If the session is interrupted before the final ROLLBACK, the
--   transaction is left open.  DDL changes remain in effect only within
--   that transaction and its locks persist until the transaction is
--   resolved.  To clean up:
--     - If the same session is still connected, execute ROLLBACK.
--     - If the connection was terminated, PostgreSQL automatically aborts
--       the transaction and releases all locks; no further action is needed.
--   Do NOT run the permanent rollback script to clean up an uncommitted
--   validation transaction — it is unnecessary and would itself begin a
--   separate transaction.
-- ════════════════════════════════════════════════════════════════════════════

-- ── 0. Begin rollback-only transaction ───────────────────────────────────────

BEGIN;

SET LOCAL statement_timeout = '15s';
SET LOCAL lock_timeout = '5s';
SET LOCAL idle_in_transaction_session_timeout = '60s';

-- ── 1. Create results table (privileged) ─────────────────────────────────────

CREATE TEMP TABLE _validation_results (
  test_name  text NOT NULL UNIQUE,
  result     text NOT NULL,  -- 'PASS' or 'FAIL'
  detail     text
);

-- ── 2. Auto-select real admin and sales_rep identities ───────────────────────

DO $$
DECLARE
  v_admin_uid text;
  v_admin_code text;
  v_rep_uid text;
  v_rep_code text;
BEGIN
  -- Select one active/login-enabled admin with non-null auth_user_id
  SELECT auth_user_id::text, rep_code
    INTO v_admin_uid, v_admin_code
  FROM public.sales_representatives
  WHERE is_active = true
    AND login_enabled = true
    AND auth_user_id IS NOT NULL
    AND role = 'admin'
  ORDER BY rep_code
  LIMIT 1;

  IF v_admin_uid IS NULL THEN
    RAISE EXCEPTION 'ABORT: No active/login-enabled admin rep with non-null auth_user_id found. Cannot run validation.'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Select one distinct active/login-enabled sales_rep with non-null auth_user_id
  SELECT auth_user_id::text, rep_code
    INTO v_rep_uid, v_rep_code
  FROM public.sales_representatives
  WHERE is_active = true
    AND login_enabled = true
    AND auth_user_id IS NOT NULL
    AND role = 'sales_rep'
    AND auth_user_id::text <> v_admin_uid
  ORDER BY rep_code
  LIMIT 1;

  IF v_rep_uid IS NULL THEN
    RAISE EXCEPTION 'ABORT: No distinct active/login-enabled sales_rep with non-null auth_user_id found. Cannot run validation.'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Store identities in session GUCs for later blocks
  PERFORM set_config('tmp.admin_uid', v_admin_uid, true);
  PERFORM set_config('tmp.admin_code', v_admin_code, true);
  PERFORM set_config('tmp.rep_uid', v_rep_uid, true);
  PERFORM set_config('tmp.rep_code', v_rep_code, true);

  RAISE NOTICE 'Selected admin: rep_code=%, uid=%', v_admin_code, v_admin_uid;
  RAISE NOTICE 'Selected rep:   rep_code=%, uid=%', v_rep_code, v_rep_uid;
END $$;

-- ── 3. Capture baseline non-SELECT privileges (before DDL) ───────────────────

CREATE TEMP TABLE _baseline_privs AS
SELECT
  grantee,
  privilege_type,
  is_grantable
FROM information_schema.table_privileges
WHERE table_schema = 'public'
  AND table_name = 'sales_representatives'
  AND grantee IN ('anon', 'authenticated')
  AND privilege_type <> 'SELECT'
ORDER BY grantee, privilege_type;

-- ── 4. Apply candidate DDL ───────────────────────────────────────────────────

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

-- ── 5. Effective privilege assertions (from proposal) ────────────────────────

DO $$
DECLARE
  v_col text;
  v_has boolean;
BEGIN
  -- 5a: anon has no SELECT on any column
  FOR v_col IN
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'sales_representatives'
    ORDER BY ordinal_position
  LOOP
    v_has := has_column_privilege('anon', 'public.sales_representatives', v_col, 'SELECT');
    IF v_has THEN
      INSERT INTO _validation_results VALUES ('assert_anon_no_select_' || v_col, 'FAIL', 'anon still has SELECT');
    ELSE
      INSERT INTO _validation_results VALUES ('assert_anon_no_select_' || v_col, 'PASS', null);
    END IF;
  END LOOP;

  -- 5b: authenticated denied on sensitive columns
  FOR v_col IN SELECT unnest(ARRAY['password', 'session_token', 'session_expires_at'])
  LOOP
    v_has := has_column_privilege('authenticated', 'public.sales_representatives', v_col, 'SELECT');
    IF v_has THEN
      INSERT INTO _validation_results VALUES ('assert_auth_denied_' || v_col, 'FAIL', 'authenticated still has SELECT');
    ELSE
      INSERT INTO _validation_results VALUES ('assert_auth_denied_' || v_col, 'PASS', null);
    END IF;
  END LOOP;

  -- 5c: authenticated retains SELECT on allowed columns
  FOR v_col IN SELECT unnest(ARRAY[
    'id', 'rep_code', 'name', 'email', 'phone', 'created_at',
    'is_active', 'role', 'login_enabled', 'auth_user_id',
    'default_event_id', 'default_capture_profile'
  ])
  LOOP
    v_has := has_column_privilege('authenticated', 'public.sales_representatives', v_col, 'SELECT');
    IF NOT v_has THEN
      INSERT INTO _validation_results VALUES ('assert_auth_allowed_' || v_col, 'FAIL', 'lost SELECT');
    ELSE
      INSERT INTO _validation_results VALUES ('assert_auth_allowed_' || v_col, 'PASS', null);
    END IF;
  END LOOP;

  -- 5d: service_role and postgres retain SELECT
  IF has_table_privilege('service_role', 'public.sales_representatives', 'SELECT') THEN
    INSERT INTO _validation_results VALUES ('assert_service_role_select', 'PASS', null);
  ELSE
    INSERT INTO _validation_results VALUES ('assert_service_role_select', 'FAIL', 'lost SELECT');
  END IF;

  IF has_table_privilege('postgres', 'public.sales_representatives', 'SELECT') THEN
    INSERT INTO _validation_results VALUES ('assert_postgres_select', 'PASS', null);
  ELSE
    INSERT INTO _validation_results VALUES ('assert_postgres_select', 'FAIL', 'lost SELECT');
  END IF;
END $$;

-- ── 6. Sensitive-column denial tests (LIMIT 0) ───────────────────────────────

DO $$
DECLARE
  v_sensitive_cols text[] := ARRAY['password', 'session_token', 'session_expires_at'];
  v_col text;
  v_sql text;
  v_sqlstate text;
  v_admin_uid text := current_setting('tmp.admin_uid', true);
  v_rep_uid   text := current_setting('tmp.rep_uid', true);
  v_cur_user  text;
  v_cur_uid   text;
BEGIN
  -- ── 6a: anon ───────────────────────────────────────────────────────────────
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', '', true);
  SET LOCAL ROLE anon;

  v_cur_user := current_user;
  v_cur_uid  := COALESCE(current_setting('request.jwt.claim.sub', true), '');
  IF v_cur_user <> 'anon' OR v_cur_uid <> '' THEN
    INSERT INTO _validation_results VALUES
      ('identity_anon', 'FAIL', format('current_user=%s auth.uid=%s', v_cur_user, v_cur_uid));
  ELSE
    INSERT INTO _validation_results VALUES ('identity_anon', 'PASS', null);

    FOREACH v_col IN ARRAY v_sensitive_cols LOOP
      BEGIN
        v_sql := format('SELECT %I FROM public.sales_representatives LIMIT 0', v_col);
        EXECUTE v_sql;
        INSERT INTO _validation_results VALUES
          ('deny_anon_' || v_col, 'FAIL', 'SELECT succeeded (expected 42501)');
      EXCEPTION
        WHEN insufficient_privilege THEN
          INSERT INTO _validation_results VALUES
            ('deny_anon_' || v_col, 'PASS', '42501');
        WHEN OTHERS THEN
          v_sqlstate := SQLSTATE;
          INSERT INTO _validation_results VALUES
            ('deny_anon_' || v_col, 'FAIL', format('unexpected SQLSTATE %s', v_sqlstate));
      END;
    END LOOP;
  END IF;

  RESET ROLE;
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', '', true);

  -- ── 6b: authenticated as admin ─────────────────────────────────────────────
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claim.sub', v_admin_uid, true);
  PERFORM set_config('request.jwt.claims',
    jsonb_build_object('sub', v_admin_uid, 'role', 'authenticated')::text, true);

  v_cur_user := current_user;
  v_cur_uid  := COALESCE(current_setting('request.jwt.claim.sub', true), '');
  IF v_cur_user <> 'authenticated' OR v_cur_uid <> v_admin_uid THEN
    INSERT INTO _validation_results VALUES
      ('identity_admin', 'FAIL', format('current_user=%s auth.uid=%s (expected %s)', v_cur_user, v_cur_uid, v_admin_uid));
  ELSE
    INSERT INTO _validation_results VALUES ('identity_admin', 'PASS', null);

    FOREACH v_col IN ARRAY v_sensitive_cols LOOP
      BEGIN
        v_sql := format('SELECT %I FROM public.sales_representatives LIMIT 0', v_col);
        EXECUTE v_sql;
        INSERT INTO _validation_results VALUES
          ('deny_admin_' || v_col, 'FAIL', 'SELECT succeeded (expected 42501)');
      EXCEPTION
        WHEN insufficient_privilege THEN
          INSERT INTO _validation_results VALUES
            ('deny_admin_' || v_col, 'PASS', '42501');
        WHEN OTHERS THEN
          v_sqlstate := SQLSTATE;
          INSERT INTO _validation_results VALUES
            ('deny_admin_' || v_col, 'FAIL', format('unexpected SQLSTATE %s', v_sqlstate));
      END;
    END LOOP;
  END IF;

  RESET ROLE;
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', '', true);

  -- ── 6c: authenticated as sales_rep ─────────────────────────────────────────
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claim.sub', v_rep_uid, true);
  PERFORM set_config('request.jwt.claims',
    jsonb_build_object('sub', v_rep_uid, 'role', 'authenticated')::text, true);

  v_cur_user := current_user;
  v_cur_uid  := COALESCE(current_setting('request.jwt.claim.sub', true), '');
  IF v_cur_user <> 'authenticated' OR v_cur_uid <> v_rep_uid THEN
    INSERT INTO _validation_results VALUES
      ('identity_rep', 'FAIL', format('current_user=%s auth.uid=%s (expected %s)', v_cur_user, v_cur_uid, v_rep_uid));
  ELSE
    INSERT INTO _validation_results VALUES ('identity_rep', 'PASS', null);

    FOREACH v_col IN ARRAY v_sensitive_cols LOOP
      BEGIN
        v_sql := format('SELECT %I FROM public.sales_representatives LIMIT 0', v_col);
        EXECUTE v_sql;
        INSERT INTO _validation_results VALUES
          ('deny_rep_' || v_col, 'FAIL', 'SELECT succeeded (expected 42501)');
      EXCEPTION
        WHEN insufficient_privilege THEN
          INSERT INTO _validation_results VALUES
            ('deny_rep_' || v_col, 'PASS', '42501');
        WHEN OTHERS THEN
          v_sqlstate := SQLSTATE;
          INSERT INTO _validation_results VALUES
            ('deny_rep_' || v_col, 'FAIL', format('unexpected SQLSTATE %s', v_sqlstate));
      END;
    END LOOP;
  END IF;

  RESET ROLE;
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', '', true);
END $$;

-- ── 7. Permitted-read verification ───────────────────────────────────────────

DO $$
DECLARE
  v_admin_uid  text := current_setting('tmp.admin_uid', true);
  v_admin_code text := current_setting('tmp.admin_code', true);
  v_rep_uid    text := current_setting('tmp.rep_uid', true);
  v_count      int;
  v_status     jsonb;
  v_cur_user   text;
  v_cur_uid    text;
BEGIN
  -- ── 7a: Login RPC as anon ──────────────────────────────────────────────────
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', '', true);
  SET LOCAL ROLE anon;

  v_cur_user := current_user;
  v_cur_uid  := COALESCE(current_setting('request.jwt.claim.sub', true), '');
  IF v_cur_user <> 'anon' OR v_cur_uid <> '' THEN
    INSERT INTO _validation_results VALUES
      ('login_rpc_anon', 'FAIL', format('identity mismatch: user=%s uid=%s', v_cur_user, v_cur_uid));
  ELSE
    BEGIN
      SELECT public.get_rep_login_status(v_admin_code) INTO v_status;
      IF v_status ? 'status' AND (v_status->>'status') = 'ok' THEN
        INSERT INTO _validation_results VALUES ('login_rpc_anon', 'PASS', 'status=ok');
      ELSE
        INSERT INTO _validation_results VALUES ('login_rpc_anon', 'FAIL', 'status not ok');
      END IF;
    EXCEPTION
      WHEN OTHERS THEN
        INSERT INTO _validation_results VALUES ('login_rpc_anon', 'FAIL', format('SQLSTATE %s', SQLSTATE));
    END;
  END IF;

  RESET ROLE;
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', '', true);

  -- ── 7b: my_rep_profile as admin (full column projection) ───────────────────
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claim.sub', v_admin_uid, true);
  PERFORM set_config('request.jwt.claims',
    jsonb_build_object('sub', v_admin_uid, 'role', 'authenticated')::text, true);

  v_cur_user := current_user;
  v_cur_uid  := COALESCE(current_setting('request.jwt.claim.sub', true), '');
  IF v_cur_user <> 'authenticated' OR v_cur_uid <> v_admin_uid THEN
    INSERT INTO _validation_results VALUES
      ('profile_admin', 'FAIL', format('identity mismatch: user=%s uid=%s', v_cur_user, v_cur_uid));
  ELSE
    BEGIN
      SELECT count(*) INTO v_count FROM (
        SELECT id, rep_code, name, email, role, login_enabled, is_active,
               auth_user_id, default_event_id, phone, default_capture_profile
        FROM public.my_rep_profile
      ) sub;
      IF v_count = 1 THEN
        INSERT INTO _validation_results VALUES ('profile_admin', 'PASS', format('%s row', v_count));
      ELSE
        INSERT INTO _validation_results VALUES ('profile_admin', 'FAIL', format('%s rows (expected 1)', v_count));
      END IF;
    EXCEPTION
      WHEN OTHERS THEN
        INSERT INTO _validation_results VALUES ('profile_admin', 'FAIL', format('SQLSTATE %s', SQLSTATE));
    END;
  END IF;

  RESET ROLE;
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', '', true);

  -- ── 7c: my_rep_profile as sales_rep (full column projection) ───────────────
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claim.sub', v_rep_uid, true);
  PERFORM set_config('request.jwt.claims',
    jsonb_build_object('sub', v_rep_uid, 'role', 'authenticated')::text, true);

  v_cur_user := current_user;
  v_cur_uid  := COALESCE(current_setting('request.jwt.claim.sub', true), '');
  IF v_cur_user <> 'authenticated' OR v_cur_uid <> v_rep_uid THEN
    INSERT INTO _validation_results VALUES
      ('profile_rep', 'FAIL', format('identity mismatch: user=%s uid=%s', v_cur_user, v_cur_uid));
  ELSE
    BEGIN
      SELECT count(*) INTO v_count FROM (
        SELECT id, rep_code, name, email, role, login_enabled, is_active,
               auth_user_id, default_event_id, phone, default_capture_profile
        FROM public.my_rep_profile
      ) sub;
      IF v_count = 1 THEN
        INSERT INTO _validation_results VALUES ('profile_rep', 'PASS', format('%s row', v_count));
      ELSE
        INSERT INTO _validation_results VALUES ('profile_rep', 'FAIL', format('%s rows (expected 1)', v_count));
      END IF;
    EXCEPTION
      WHEN OTHERS THEN
        INSERT INTO _validation_results VALUES ('profile_rep', 'FAIL', format('SQLSTATE %s', SQLSTATE));
    END;
  END IF;

  RESET ROLE;
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', '', true);

  -- ── 7d: Admin rep list (full projection) as admin ──────────────────────────
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claim.sub', v_admin_uid, true);
  PERFORM set_config('request.jwt.claims',
    jsonb_build_object('sub', v_admin_uid, 'role', 'authenticated')::text, true);

  v_cur_user := current_user;
  v_cur_uid  := COALESCE(current_setting('request.jwt.claim.sub', true), '');
  IF v_cur_user <> 'authenticated' OR v_cur_uid <> v_admin_uid THEN
    INSERT INTO _validation_results VALUES
      ('admin_rep_list', 'FAIL', format('identity mismatch: user=%s uid=%s', v_cur_user, v_cur_uid));
  ELSE
    BEGIN
      SELECT count(*) INTO v_count FROM (
        SELECT id, rep_code, name, email, phone, is_active, role, default_event_id
        FROM public.sales_representatives
      ) sub;
      IF v_count > 0 THEN
        INSERT INTO _validation_results VALUES ('admin_rep_list', 'PASS', format('%s reps', v_count));
      ELSE
        INSERT INTO _validation_results VALUES ('admin_rep_list', 'FAIL', '0 reps');
      END IF;
    EXCEPTION
      WHEN OTHERS THEN
        INSERT INTO _validation_results VALUES ('admin_rep_list', 'FAIL', format('SQLSTATE %s', SQLSTATE));
    END;
  END IF;

  RESET ROLE;
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', '', true);

  -- ── 7e: Rep dropdown (rep_code, name) as admin ─────────────────────────────
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claim.sub', v_admin_uid, true);
  PERFORM set_config('request.jwt.claims',
    jsonb_build_object('sub', v_admin_uid, 'role', 'authenticated')::text, true);

  v_cur_user := current_user;
  v_cur_uid  := COALESCE(current_setting('request.jwt.claim.sub', true), '');
  IF v_cur_user <> 'authenticated' OR v_cur_uid <> v_admin_uid THEN
    INSERT INTO _validation_results VALUES
      ('rep_dropdown', 'FAIL', format('identity mismatch: user=%s uid=%s', v_cur_user, v_cur_uid));
  ELSE
    BEGIN
      SELECT count(*) INTO v_count FROM (
        SELECT rep_code, name
        FROM public.sales_representatives
        WHERE is_active = true AND login_enabled = true
      ) sub;
      IF v_count > 0 THEN
        INSERT INTO _validation_results VALUES ('rep_dropdown', 'PASS', format('%s active reps', v_count));
      ELSE
        INSERT INTO _validation_results VALUES ('rep_dropdown', 'FAIL', '0 active reps');
      END IF;
    EXCEPTION
      WHEN OTHERS THEN
        INSERT INTO _validation_results VALUES ('rep_dropdown', 'FAIL', format('SQLSTATE %s', SQLSTATE));
    END;
  END IF;

  RESET ROLE;
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', '', true);

  -- ── 7f: Dashboard RPC as admin ─────────────────────────────────────────────
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claim.sub', v_admin_uid, true);
  PERFORM set_config('request.jwt.claims',
    jsonb_build_object('sub', v_admin_uid, 'role', 'authenticated')::text, true);

  v_cur_user := current_user;
  v_cur_uid  := COALESCE(current_setting('request.jwt.claim.sub', true), '');
  IF v_cur_user <> 'authenticated' OR v_cur_uid <> v_admin_uid THEN
    INSERT INTO _validation_results VALUES
      ('dashboard_admin', 'FAIL', format('identity mismatch: user=%s uid=%s', v_cur_user, v_cur_uid));
  ELSE
    BEGIN
      SELECT count(*) INTO v_count FROM public.get_dashboard_metrics(NULL) sub;
      IF v_count = 1 THEN
        INSERT INTO _validation_results VALUES ('dashboard_admin', 'PASS', '1 row');
      ELSE
        INSERT INTO _validation_results VALUES ('dashboard_admin', 'FAIL', format('%s rows', v_count));
      END IF;
    EXCEPTION
      WHEN OTHERS THEN
        INSERT INTO _validation_results VALUES ('dashboard_admin', 'FAIL', format('SQLSTATE %s', SQLSTATE));
    END;
  END IF;

  RESET ROLE;
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', '', true);

  -- ── 7g: Dashboard RPC as sales_rep ─────────────────────────────────────────
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claim.sub', v_rep_uid, true);
  PERFORM set_config('request.jwt.claims',
    jsonb_build_object('sub', v_rep_uid, 'role', 'authenticated')::text, true);

  v_cur_user := current_user;
  v_cur_uid  := COALESCE(current_setting('request.jwt.claim.sub', true), '');
  IF v_cur_user <> 'authenticated' OR v_cur_uid <> v_rep_uid THEN
    INSERT INTO _validation_results VALUES
      ('dashboard_rep', 'FAIL', format('identity mismatch: user=%s uid=%s', v_cur_user, v_cur_uid));
  ELSE
    BEGIN
      SELECT count(*) INTO v_count FROM public.get_dashboard_metrics(NULL) sub;
      IF v_count = 1 THEN
        INSERT INTO _validation_results VALUES ('dashboard_rep', 'PASS', '1 row');
      ELSE
        INSERT INTO _validation_results VALUES ('dashboard_rep', 'FAIL', format('%s rows', v_count));
      END IF;
    EXCEPTION
      WHEN OTHERS THEN
        INSERT INTO _validation_results VALUES ('dashboard_rep', 'FAIL', format('SQLSTATE %s', SQLSTATE));
    END;
  END IF;

  RESET ROLE;
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', '', true);

  -- ── 7h: Lead list view as admin ────────────────────────────────────────────
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claim.sub', v_admin_uid, true);
  PERFORM set_config('request.jwt.claims',
    jsonb_build_object('sub', v_admin_uid, 'role', 'authenticated')::text, true);

  v_cur_user := current_user;
  v_cur_uid  := COALESCE(current_setting('request.jwt.claim.sub', true), '');
  IF v_cur_user <> 'authenticated' OR v_cur_uid <> v_admin_uid THEN
    INSERT INTO _validation_results VALUES
      ('leads_list_admin', 'FAIL', format('identity mismatch: user=%s uid=%s', v_cur_user, v_cur_uid));
  ELSE
    BEGIN
      SELECT count(*) INTO v_count FROM public.leads_list_view;
      INSERT INTO _validation_results VALUES ('leads_list_admin', 'PASS', format('%s rows', v_count));
    EXCEPTION
      WHEN OTHERS THEN
        INSERT INTO _validation_results VALUES ('leads_list_admin', 'FAIL', format('SQLSTATE %s', SQLSTATE));
    END;
  END IF;

  RESET ROLE;
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', '', true);
END $$;

-- ── 8. Write-privilege preservation (metadata only) ──────────────────────────

DO $$
DECLARE
  v_mismatch boolean;
BEGIN
  -- Compare current non-SELECT privileges against baseline snapshot.
  SELECT EXISTS (
    SELECT grantee, privilege_type, is_grantable
    FROM information_schema.table_privileges
    WHERE table_schema = 'public'
      AND table_name = 'sales_representatives'
      AND grantee IN ('anon', 'authenticated')
      AND privilege_type <> 'SELECT'
    EXCEPT
    SELECT grantee, privilege_type, is_grantable
    FROM _baseline_privs
  ) OR EXISTS (
    SELECT grantee, privilege_type, is_grantable
    FROM _baseline_privs
    EXCEPT
    SELECT grantee, privilege_type, is_grantable
    FROM information_schema.table_privileges
    WHERE table_schema = 'public'
      AND table_name = 'sales_representatives'
      AND grantee IN ('anon', 'authenticated')
      AND privilege_type <> 'SELECT'
  ) INTO v_mismatch;

  IF v_mismatch THEN
    INSERT INTO _validation_results VALUES ('write_priv_preserved', 'FAIL', 'non-SELECT privileges changed');
  ELSE
    INSERT INTO _validation_results VALUES ('write_priv_preserved', 'PASS', null);
  END IF;
END $$;

-- ── 9. Overall pass/fail check ───────────────────────────────────────────────

DO $$
DECLARE
  v_expected text[];
  v_actual   text[];
  v_missing  text[];
  v_dup      text[];
  v_failed   text[];
  v_all_pass boolean;
BEGIN
  -- Build the exact set of expected test names.
  v_expected := ARRAY[
    -- Effective privilege assertions
    'assert_anon_no_select_id',
    'assert_anon_no_select_rep_code',
    'assert_anon_no_select_name',
    'assert_anon_no_select_email',
    'assert_anon_no_select_phone',
    'assert_anon_no_select_created_at',
    'assert_anon_no_select_is_active',
    'assert_anon_no_select_role',
    'assert_anon_no_select_login_enabled',
    'assert_anon_no_select_auth_user_id',
    'assert_anon_no_select_default_event_id',
    'assert_anon_no_select_default_capture_profile',
    'assert_anon_no_select_password',
    'assert_anon_no_select_session_token',
    'assert_anon_no_select_session_expires_at',
    'assert_auth_denied_password',
    'assert_auth_denied_session_token',
    'assert_auth_denied_session_expires_at',
    'assert_auth_allowed_id',
    'assert_auth_allowed_rep_code',
    'assert_auth_allowed_name',
    'assert_auth_allowed_email',
    'assert_auth_allowed_phone',
    'assert_auth_allowed_created_at',
    'assert_auth_allowed_is_active',
    'assert_auth_allowed_role',
    'assert_auth_allowed_login_enabled',
    'assert_auth_allowed_auth_user_id',
    'assert_auth_allowed_default_event_id',
    'assert_auth_allowed_default_capture_profile',
    'assert_service_role_select',
    'assert_postgres_select',
    -- Identity checks
    'identity_anon',
    'identity_admin',
    'identity_rep',
    -- Sensitive-column denial tests
    'deny_anon_password',
    'deny_anon_session_token',
    'deny_anon_session_expires_at',
    'deny_admin_password',
    'deny_admin_session_token',
    'deny_admin_session_expires_at',
    'deny_rep_password',
    'deny_rep_session_token',
    'deny_rep_session_expires_at',
    -- Permitted-read tests
    'login_rpc_anon',
    'profile_admin',
    'profile_rep',
    'admin_rep_list',
    'rep_dropdown',
    'dashboard_admin',
    'dashboard_rep',
    'leads_list_admin',
    -- Write-privilege preservation
    'write_priv_preserved'
  ];

  -- Actual test names that were inserted
  SELECT array_agg(test_name ORDER BY test_name) INTO v_actual
  FROM _validation_results;

  -- Missing: expected but not in results
  SELECT array_agg(x ORDER BY x) INTO v_missing
  FROM unnest(v_expected) x
  WHERE x <> ALL(v_actual);

  -- Duplicates: test names appearing more than once (caught by UNIQUE constraint,
  -- but check anyway for completeness)
  SELECT array_agg(test_name) INTO v_dup
  FROM (SELECT test_name FROM _validation_results GROUP BY test_name HAVING count(*) > 1) d;

  -- Failed: any result = FAIL
  SELECT array_agg(test_name ORDER BY test_name) INTO v_failed
  FROM _validation_results WHERE result = 'FAIL';

  v_all_pass := (v_missing IS NULL) AND (v_dup IS NULL) AND (v_failed IS NULL);

  INSERT INTO _validation_results VALUES
    ('overall', CASE WHEN v_all_pass THEN 'PASS' ELSE 'FAIL' END,
     CASE
       WHEN v_missing IS NOT NULL THEN 'missing: ' || array_to_string(v_missing, ', ')
       WHEN v_dup    IS NOT NULL THEN 'duplicates: ' || array_to_string(v_dup, ', ')
       WHEN v_failed IS NOT NULL THEN 'failed: ' || array_to_string(v_failed, ', ')
       ELSE null
     END);
END $$;

-- ── 10. Return final result table ────────────────────────────────────────────

SELECT test_name, result, detail
FROM _validation_results
ORDER BY test_name;

-- ── 11. Final ROLLBACK ───────────────────────────────────────────────────────
--   All DDL (REVOKE/GRANT) and temp objects are undone.
--   The database returns to its pre-proposal ACL state.

ROLLBACK;

-- ════════════════════════════════════════════════════════════════════════════
-- INTERRUPTION/SESSION CLEANUP NOTE
-- ════════════════════════════════════════════════════════════════════════════
-- If the session is interrupted before the final ROLLBACK:
--   1. The transaction remains open and its locks persist until resolved.
--   2. If the same session is still connected, execute ROLLBACK to undo
--      all DDL and release locks.
--   3. If the connection was terminated, PostgreSQL automatically aborts
--      the transaction and releases all locks.  No further action is needed.
--   4. Do NOT run the permanent rollback script
--      (sales-reps-select-protection-rollback.sql) to clean up an
--      uncommitted validation transaction — that script begins its own
--      separate transaction and is intended for permanent deployment
--      rollback, not session cleanup.
-- ════════════════════════════════════════════════════════════════════════════

-- ════════════════════════════════════════════════════════════════════════════
-- REMAINING LIVE-METADATA CHECKS (not covered by this validation)
-- ════════════════════════════════════════════════════════════════════════════
-- This validation does NOT close every exposure path.  The following
-- live-metadata checks remain outstanding and must be run separately
-- before claiming complete sensitive-column protection:
--
-- 1. VIEW EXPOSURE AUDIT
--    Query all views in public whose definition references
--    sales_representatives.  For each, confirm the SELECT list excludes
--    password, session_token, session_expires_at.  If any view uses
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
--    sales_representatives.  For each, inspect the function body to
--    confirm that no sensitive column values are included in the
--    return value (jsonb_build_object, RETURN NEXT, OUT parameters,
--    or composite returns).  SECURITY DEFINER functions owned by
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
--    Confirmed reloptions=NULL (definer mode).  In definer mode the view
--    runs as postgres and bypasses column grants.  The view's own SELECT
--    list is the protection boundary, not column grants.  If the view is
--    ever recreated with SELECT * or additional columns, sensitive
--    columns would be exposed.  Consider recreating with
--    security_invoker=true in a separate task so column grants apply
--    through the view.
--
-- 4. ROLE MEMBERSHIP CHAIN
--    Confirm anon and authenticated are not members of any role that
--    retains table-level SELECT on sales_representatives.  If they are,
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
--    authenticated on future tables.  Not in scope for this change but
--    should be audited separately.
-- ════════════════════════════════════════════════════════════════════════════
