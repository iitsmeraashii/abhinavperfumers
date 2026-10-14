-- ============================================================================
-- PRODUCTION VALIDATION SCRIPT — REVIEW ONLY. DO NOT EXECUTE.
-- File: docs/lead-entries-select-policy-validation.sql
-- Date: 2026-10-14 (revised — temp-table privilege fix)
--
-- PURPOSE:
--   Validates the proposed lead_entries SELECT policies (from
--   docs/lead-entries-select-policy-proposal.sql) by temporarily
--   installing them inside a REPEATABLE READ transaction that ALWAYS
--   ends with ROLLBACK.  No data is persisted, no users are changed,
--   no application tables are modified.
--
-- SAFETY:
--   - Transaction ends with ROLLBACK — always, unconditionally.
--   - lock_timeout = 3s: aborts if DDL cannot acquire table lock quickly.
--   - statement_timeout = 15s: aborts any single query that hangs.
--   - idle_in_transaction_session_timeout = 30s: if the session sits idle
--     mid-transaction (e.g., the SQL Editor pauses after an error), the
--     transaction is automatically rolled back after 30 seconds.
--   - All temp tables are ON COMMIT DROP (destroyed when transaction ends).
--   - No INSERT/UPDATE/DELETE on application tables.
--   - No changes to auth.users or sales_representatives.
--   - Output contains only PASS/FAIL/INFO labels, counts, and SQLSTATEs —
--     no names, emails, UUIDs, tokens, passwords, or lead contents.
--
-- CRITICAL DESIGN NOTE (temp-table privilege isolation):
--   The _results and _ids temp tables are owned by the postgres / SQL Editor
--   role that creates them.  The authenticated and anon roles do NOT have
--   any privileges on these tables.  Therefore, every INSERT into _results
--   MUST occur while the session has been restored to the privileged role
--   (after RESET ROLE).  Each test follows this strict sequence:
--     1. Load parameters while privileged.
--     2. Set transaction-local JWT identity settings and SET ROLE.
--     3. Verify effective role and auth.uid() match the intended identity
--        (anon must have NULL auth.uid()).
--     4. Run ONLY the lead_entries access checks under the impersonated role.
--     5. Store outcomes in PL/pgSQL local variables.
--     6. Restore the privileged role (RESET ROLE) and clear identity settings.
--     7. Only then INSERT the result into _results.
--   No INSERT into _results ever occurs while impersonating authenticated
--   or anon.  No grants on temp tables are issued to those roles.
--
-- PREREQUISITES:
--   - Run as the postgres / SQL Editor role (BYPASSRLS, can SET ROLE).
--   - Database must have at least:
--       1 active/login-enabled admin with auth_user_id
--       2 distinct active/login-enabled sales_reps, each with >= 1 assigned lead
--     If any are missing, the script aborts with a clear error before
--     touching any policies.
--
-- EXPECTED LOCK IMPACT:
--   DROP POLICY, CREATE POLICY, and REVOKE each require an ACCESS EXCLUSIVE
--   lock on lead_entries.  This blocks ALL concurrent reads and writes for
--   as long as the transaction remains open.  With lock_timeout = 3s, the
--   script aborts if the lock cannot be acquired within 3 seconds.
--   RECOMMENDED WINDOW: Run during a low-traffic period (off-hours) to
--   minimise blocking impact on application queries.  The total lock hold
--   time depends on query latency and database load; no fixed duration is
--   guaranteed.
--
--   INTERRUPTED SCRIPT WARNING:
--   If the script is interrupted (client disconnect, manual cancellation,
--   or an unhandled error), the transaction may remain open with ACCESS
--   EXCLUSIVE locks held on lead_entries.  The idle_in_transaction_session_timeout
--   will eventually roll back the transaction, but until then the locks
--   persist and block application queries.  Manual rollback must target
--   the SAME session that ran the script (use pg_terminate_backend on the
--   stuck PID only as a last resort).  If the SQL Editor leaves a
--   transaction open, manually execute:
--       ROLLBACK;
--   in that same session.  If ROLLBACK reports "there is no transaction
--   in progress", the transaction was already rolled back automatically
--   (by timeout, disconnect, or prior rollback) — no action needed.
--
-- HOW ROLE / JWT IMPERSONATION AND VERIFICATION WORK:
--   PostgreSQL SET ROLE changes the current user for the session.  Within a
--   transaction that ends with ROLLBACK, the role change is automatically
--   undone.  Supabase's auth.uid() reads the JWT subject from both the
--   request.jwt.claim.sub GUC (single value) and the request.jwt.claims
--   GUC (JSON object with a "sub" key).  Both are set with SET LOCAL
--   (transaction-scoped) before each test and explicitly cleared after.
--
--   Before each access test, the script verifies the impersonation by
--   checking current_user and auth.uid() against the expected identity.
--   For anon, auth.uid() must be NULL.  If verification fails, the test
--   records FAIL and the access query is not executed.  Impersonation
--   failure details use generic labels — no UUIDs or user values are
--   disclosed.
--
-- HOW BASELINE COMPARISONS WORK:
--   Before installing the new policies, the script records the total lead
--   count and per-rep lead counts as the privileged SQL Editor role
--   (BYPASSRLS).  After installing the policies, it re-runs the same counts
--   as each impersonated identity.  REPEATABLE READ isolation ensures the
--   data snapshot is consistent across all counts — concurrent application
--   writes cannot change the rows seen by any query in this transaction.
--
-- WHAT HAPPENS ON ERROR OR TIMEOUT:
--   - lock_timeout / statement_timeout: The offending statement aborts,
--     the transaction enters an aborted state, and all subsequent
--     statements fail until ROLLBACK is executed.  The ROLLBACK at the end
--     restores the original policies, grants, and role.
--   - idle_in_transaction_session_timeout: The transaction is automatically
--     rolled back if the session sits idle for 30 seconds mid-transaction.
--   - Assertion failure (RAISE EXCEPTION in Phase 1): The transaction
--     aborts immediately.  No policies are changed.  The final ROLLBACK
--     is a no-op (transaction already aborted) but is still required
--     syntax to close the block.
--   - If the outer exception handler of any test fires (role-switch failure,
--     identity-verification failure, etc.), the result is ALWAYS FAIL.
--     Only the inner nested exception block for the anon lead_entries read
--     can produce a PASS from insufficient_privilege (42501).
--
-- WHAT THIS VERIFIES:
--   1. Active/login-enabled admin sees exactly the baseline total count.
--   2. Each active/login-enabled sales rep sees exactly their own count,
--      AND zero rows whose sales_rep_code IS DISTINCT FROM their own code.
--   3. Rep A cannot read Rep B's specific lead by ID, and vice versa.
--   4. anon is denied: the actual read either raises insufficient_privilege
--      (SQLSTATE 42501) or returns 0 rows.  Any other error is FAIL.
--   5. An authenticated identity with no sales_representatives profile sees
--      exactly 0 rows.  Any exception for this test is FAIL.
--   6. The generated no-profile UUID is verified to have no matching
--      sales_representatives profile before the test runs.
--   7. Baseline counts are consistent across all checks (REPEATABLE READ).
--   8. An explicit overall PASS is returned only when exactly one result
--      exists for each of the seven expected test names and all are PASS.
--
-- WHAT STILL REQUIRES POST-APPLICATION WORKFLOW TESTING:
--   This script tests ONLY the SELECT path under RLS.  The following
--   flows depend on INSERT/UPDATE/DELETE policies, joins to other tables,
--   or user-state changes that cannot be safely tested in a rolled-back
--   production transaction:
--     - Capture promotion (INSERT path)
--     - Create-from-conversation (INSERT path)
--     - Own-lead edit / status update (UPDATE path)
--     - Admin reassignment (UPDATE path)
--     - Follow-ups page (lead_follow_ups RLS + join to lead_entries)
--     - WhatsApp-linked leads (conversations RLS + join to lead_entries)
--     - Disabled / inactive user denial (requires changing user state —
--       use staging accounts after applying the migration)
--     - n8n / service-role BYPASSRLS (requires n8n's own credential)
--   These must be validated after the migration is applied, using the
--   application UI with real or staging accounts.
-- ============================================================================

BEGIN ISOLATION LEVEL REPEATABLE READ;

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '15s';
SET LOCAL idle_in_transaction_session_timeout = '30s';

-- ─── Temp tables (transaction-scoped, destroyed on ROLLBACK) ────────────────
-- Owned by the privileged SQL Editor role.  No grants to authenticated/anon.

CREATE TEMP TABLE _results (
  seq serial PRIMARY KEY,
  test_name text NOT NULL,
  result text NOT NULL,
  detail text
) ON COMMIT DROP;

CREATE TEMP TABLE _ids (
  key text PRIMARY KEY,
  val text
) ON COMMIT DROP;

-- ─── Phase 1: Select test identities and record baselines ───────────────────
-- Runs as the privileged SQL Editor role (BYPASSRLS).  No SET ROLE here.

DO $$
DECLARE
  v_admin_uuid     text;
  v_rep_a_uuid     text;
  v_rep_a_code     text;
  v_rep_b_uuid     text;
  v_rep_b_code     text;
  v_rep_a_lead_id  text;
  v_rep_b_lead_id  text;
  v_no_profile     uuid;
  v_baseline_total bigint;
  v_baseline_a     bigint;
  v_baseline_b     bigint;
  v_profile_check  bigint;
BEGIN
  SELECT sr.auth_user_id::text
    INTO v_admin_uuid
  FROM public.sales_representatives sr
  WHERE sr.role = 'admin'
    AND sr.is_active = true
    AND sr.login_enabled = true
    AND sr.auth_user_id IS NOT NULL
  LIMIT 1;

  IF v_admin_uuid IS NULL THEN
    RAISE EXCEPTION 'ABORT: No active/login-enabled admin with auth_user_id found';
  END IF;

  INSERT INTO _ids (key, val) VALUES ('admin_uuid', v_admin_uuid);

  SELECT sr.auth_user_id::text, sr.rep_code
    INTO v_rep_a_uuid, v_rep_a_code
  FROM public.sales_representatives sr
  WHERE sr.role = 'sales_rep'
    AND sr.is_active = true
    AND sr.login_enabled = true
    AND sr.auth_user_id IS NOT NULL
    AND NULLIF(btrim(sr.rep_code), '') IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM public.lead_entries le
      WHERE le.sales_rep_code = sr.rep_code
    )
  ORDER BY (
    SELECT count(*) FROM public.lead_entries le
    WHERE le.sales_rep_code = sr.rep_code
  ) DESC
  LIMIT 1;

  IF v_rep_a_uuid IS NULL THEN
    RAISE EXCEPTION 'ABORT: No suitable rep A found (active, login-enabled, with assigned leads)';
  END IF;

  INSERT INTO _ids (key, val) VALUES ('rep_a_uuid', v_rep_a_uuid);
  INSERT INTO _ids (key, val) VALUES ('rep_a_code', v_rep_a_code);

  SELECT sr.auth_user_id::text, sr.rep_code
    INTO v_rep_b_uuid, v_rep_b_code
  FROM public.sales_representatives sr
  WHERE sr.role = 'sales_rep'
    AND sr.is_active = true
    AND sr.login_enabled = true
    AND sr.auth_user_id IS NOT NULL
    AND NULLIF(btrim(sr.rep_code), '') IS NOT NULL
    AND sr.rep_code <> v_rep_a_code
    AND EXISTS (
      SELECT 1 FROM public.lead_entries le
      WHERE le.sales_rep_code = sr.rep_code
    )
  ORDER BY (
    SELECT count(*) FROM public.lead_entries le
    WHERE le.sales_rep_code = sr.rep_code
  ) DESC
  LIMIT 1;

  IF v_rep_b_uuid IS NULL THEN
    RAISE EXCEPTION 'ABORT: No suitable rep B found (distinct rep_code, active, login-enabled, with assigned leads)';
  END IF;

  INSERT INTO _ids (key, val) VALUES ('rep_b_uuid', v_rep_b_uuid);
  INSERT INTO _ids (key, val) VALUES ('rep_b_code', v_rep_b_code);

  SELECT le.id::text
    INTO v_rep_a_lead_id
  FROM public.lead_entries le
  WHERE le.sales_rep_code = v_rep_a_code
  LIMIT 1;

  SELECT le.id::text
    INTO v_rep_b_lead_id
  FROM public.lead_entries le
  WHERE le.sales_rep_code = v_rep_b_code
  LIMIT 1;

  IF v_rep_a_lead_id IS NULL OR v_rep_b_lead_id IS NULL THEN
    RAISE EXCEPTION 'ABORT: Could not find a lead ID for each rep (cross-rep denial test requires >= 1 lead per rep)';
  END IF;

  INSERT INTO _ids (key, val) VALUES ('rep_a_lead_id', v_rep_a_lead_id);
  INSERT INTO _ids (key, val) VALUES ('rep_b_lead_id', v_rep_b_lead_id);

  v_no_profile := gen_random_uuid();

  SELECT count(*) INTO v_profile_check
  FROM public.sales_representatives sr
  WHERE sr.auth_user_id = v_no_profile;

  IF v_profile_check > 0 THEN
    RAISE EXCEPTION 'ABORT: Generated no-profile UUID unexpectedly matches a sales_representatives row';
  END IF;

  INSERT INTO _ids (key, val) VALUES ('no_profile_uuid', v_no_profile::text);

  SELECT count(*) INTO v_baseline_total FROM public.lead_entries;
  SELECT count(*) INTO v_baseline_a
    FROM public.lead_entries WHERE sales_rep_code = v_rep_a_code;
  SELECT count(*) INTO v_baseline_b
    FROM public.lead_entries WHERE sales_rep_code = v_rep_b_code;

  INSERT INTO _results (test_name, result, detail)
    VALUES ('baseline_total',  'INFO', v_baseline_total::text);
  INSERT INTO _results (test_name, result, detail)
    VALUES ('baseline_rep_a',  'INFO', v_baseline_a::text);
  INSERT INTO _results (test_name, result, detail)
    VALUES ('baseline_rep_b',  'INFO', v_baseline_b::text);
END $$;

-- ─── Phase 2: Install proposed policies (transaction-scoped) ────────────────

DROP POLICY IF EXISTS "Admin can see all" ON public.lead_entries;
DROP POLICY IF EXISTS "Sales rep can see own leads" ON public.lead_entries;

CREATE POLICY "Admin can see all"
  ON public.lead_entries
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.sales_representatives sr
      WHERE sr.auth_user_id = auth.uid()
        AND sr.role = 'admin'
        AND sr.is_active = true
        AND sr.login_enabled = true
    )
  );

CREATE POLICY "Sales rep can see own leads"
  ON public.lead_entries
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.sales_representatives sr
      WHERE sr.auth_user_id = auth.uid()
        AND sr.role = 'sales_rep'
        AND sr.is_active = true
        AND sr.login_enabled = true
        AND NULLIF(btrim(sr.rep_code), '') IS NOT NULL
        AND sr.rep_code = lead_entries.sales_rep_code
    )
  );

REVOKE SELECT ON public.lead_entries FROM anon;

-- ─── Phase 3: RLS tests ─────────────────────────────────────────────────────
-- Strict sequence per test:
--   1. Set JWT identity (request.jwt.claim.sub + request.jwt.claims) and SET ROLE
--   2. Verify current_user and auth.uid()
--   3. Run ONLY lead_entries access checks; store results in local variables
--   4. RESET ROLE and clear JWT identity
--   5. INSERT into _results (privileged — never while impersonating)
-- Outer EXCEPTION: always FAIL (role-switch/verification/restore errors).

DO $$
DECLARE
  -- Parameters (loaded while privileged)
  v_admin_uuid     text;
  v_rep_a_uuid     text;
  v_rep_b_uuid     text;
  v_rep_a_code     text;
  v_rep_b_code     text;
  v_rep_a_lead_id  text;
  v_rep_b_lead_id  text;
  v_no_profile     text;
  v_baseline_total text;
  v_baseline_a     text;
  v_baseline_b     text;

  -- Per-test working variables
  v_result         text;
  v_detail         text;
  v_count          bigint;
  v_foreign_count  bigint;
  v_verify_user    text;
  v_verify_uid     text;
  v_sqlstate       text;
  v_all_passed      boolean;
  v_expected_count  bigint;
  v_distinct_count  bigint;
BEGIN
  -- Load parameters (privileged)
  SELECT val INTO v_admin_uuid     FROM _ids WHERE key = 'admin_uuid';
  SELECT val INTO v_rep_a_uuid     FROM _ids WHERE key = 'rep_a_uuid';
  SELECT val INTO v_rep_b_uuid     FROM _ids WHERE key = 'rep_b_uuid';
  SELECT val INTO v_rep_a_code     FROM _ids WHERE key = 'rep_a_code';
  SELECT val INTO v_rep_b_code     FROM _ids WHERE key = 'rep_b_code';
  SELECT val INTO v_rep_a_lead_id  FROM _ids WHERE key = 'rep_a_lead_id';
  SELECT val INTO v_rep_b_lead_id  FROM _ids WHERE key = 'rep_b_lead_id';
  SELECT val INTO v_no_profile     FROM _ids WHERE key = 'no_profile_uuid';
  SELECT detail INTO v_baseline_total FROM _results WHERE test_name = 'baseline_total';
  SELECT detail INTO v_baseline_a     FROM _results WHERE test_name = 'baseline_rep_a';
  SELECT detail INTO v_baseline_b     FROM _results WHERE test_name = 'baseline_rep_b';

  -- ── Test 1: Admin sees all leads ──────────────────────────────────────────
  BEGIN
    EXECUTE format('SET LOCAL request.jwt.claim.sub = %L', v_admin_uuid);
    EXECUTE format('SET LOCAL request.jwt.claims = %L',
      json_build_object('sub', v_admin_uuid)::text);
    SET LOCAL ROLE authenticated;

    SELECT current_user INTO v_verify_user;
    EXECUTE 'SELECT auth.uid()::text' INTO v_verify_uid;

    IF v_verify_user <> 'authenticated' OR v_verify_uid IS DISTINCT FROM v_admin_uuid THEN
      v_result := 'FAIL';
      v_detail := 'impersonation_failed';
    ELSE
      EXECUTE 'SELECT count(*) FROM public.lead_entries' INTO v_count;
      v_result := CASE WHEN v_count::text = v_baseline_total THEN 'PASS' ELSE 'FAIL' END;
      v_detail := 'count=' || v_count::text || ' baseline=' || v_baseline_total;
    END IF;

    RESET ROLE;
    EXECUTE format('SET LOCAL request.jwt.claim.sub = %L', '');
    EXECUTE format('SET LOCAL request.jwt.claims = %L', '');

    INSERT INTO _results (test_name, result, detail)
      VALUES ('admin_sees_all', v_result, v_detail);
  EXCEPTION WHEN OTHERS THEN
    BEGIN RESET ROLE; EXCEPTION WHEN OTHERS THEN NULL; END;
    BEGIN EXECUTE format('SET LOCAL request.jwt.claim.sub = %L', ''); EXCEPTION WHEN OTHERS THEN NULL; END;
    BEGIN EXECUTE format('SET LOCAL request.jwt.claims = %L', ''); EXCEPTION WHEN OTHERS THEN NULL; END;
    v_sqlstate := SQLSTATE;
    INSERT INTO _results (test_name, result, detail)
      VALUES ('admin_sees_all', 'FAIL', 'SQLSTATE=' || v_sqlstate);
  END;

  -- ── Test 2: Rep A sees only own leads ─────────────────────────────────────
  BEGIN
    EXECUTE format('SET LOCAL request.jwt.claim.sub = %L', v_rep_a_uuid);
    EXECUTE format('SET LOCAL request.jwt.claims = %L',
      json_build_object('sub', v_rep_a_uuid)::text);
    SET LOCAL ROLE authenticated;

    SELECT current_user INTO v_verify_user;
    EXECUTE 'SELECT auth.uid()::text' INTO v_verify_uid;

    IF v_verify_user <> 'authenticated' OR v_verify_uid IS DISTINCT FROM v_rep_a_uuid THEN
      v_result := 'FAIL';
      v_detail := 'impersonation_failed';
    ELSE
      EXECUTE 'SELECT count(*) FROM public.lead_entries' INTO v_count;
      EXECUTE format(
        'SELECT count(*) FROM public.lead_entries WHERE sales_rep_code IS DISTINCT FROM %L',
        v_rep_a_code
      ) INTO v_foreign_count;
      v_result := CASE WHEN v_count::text = v_baseline_a AND v_foreign_count = 0
                       THEN 'PASS' ELSE 'FAIL' END;
      v_detail := 'count=' || v_count::text || ' baseline=' || v_baseline_a ||
                  ' foreign_rows=' || v_foreign_count::text;
    END IF;

    RESET ROLE;
    EXECUTE format('SET LOCAL request.jwt.claim.sub = %L', '');
    EXECUTE format('SET LOCAL request.jwt.claims = %L', '');

    INSERT INTO _results (test_name, result, detail)
      VALUES ('rep_a_own_leads', v_result, v_detail);
  EXCEPTION WHEN OTHERS THEN
    BEGIN RESET ROLE; EXCEPTION WHEN OTHERS THEN NULL; END;
    BEGIN EXECUTE format('SET LOCAL request.jwt.claim.sub = %L', ''); EXCEPTION WHEN OTHERS THEN NULL; END;
    BEGIN EXECUTE format('SET LOCAL request.jwt.claims = %L', ''); EXCEPTION WHEN OTHERS THEN NULL; END;
    v_sqlstate := SQLSTATE;
    INSERT INTO _results (test_name, result, detail)
      VALUES ('rep_a_own_leads', 'FAIL', 'SQLSTATE=' || v_sqlstate);
  END;

  -- ── Test 3: Rep B sees only own leads ─────────────────────────────────────
  BEGIN
    EXECUTE format('SET LOCAL request.jwt.claim.sub = %L', v_rep_b_uuid);
    EXECUTE format('SET LOCAL request.jwt.claims = %L',
      json_build_object('sub', v_rep_b_uuid)::text);
    SET LOCAL ROLE authenticated;

    SELECT current_user INTO v_verify_user;
    EXECUTE 'SELECT auth.uid()::text' INTO v_verify_uid;

    IF v_verify_user <> 'authenticated' OR v_verify_uid IS DISTINCT FROM v_rep_b_uuid THEN
      v_result := 'FAIL';
      v_detail := 'impersonation_failed';
    ELSE
      EXECUTE 'SELECT count(*) FROM public.lead_entries' INTO v_count;
      EXECUTE format(
        'SELECT count(*) FROM public.lead_entries WHERE sales_rep_code IS DISTINCT FROM %L',
        v_rep_b_code
      ) INTO v_foreign_count;
      v_result := CASE WHEN v_count::text = v_baseline_b AND v_foreign_count = 0
                       THEN 'PASS' ELSE 'FAIL' END;
      v_detail := 'count=' || v_count::text || ' baseline=' || v_baseline_b ||
                  ' foreign_rows=' || v_foreign_count::text;
    END IF;

    RESET ROLE;
    EXECUTE format('SET LOCAL request.jwt.claim.sub = %L', '');
    EXECUTE format('SET LOCAL request.jwt.claims = %L', '');

    INSERT INTO _results (test_name, result, detail)
      VALUES ('rep_b_own_leads', v_result, v_detail);
  EXCEPTION WHEN OTHERS THEN
    BEGIN RESET ROLE; EXCEPTION WHEN OTHERS THEN NULL; END;
    BEGIN EXECUTE format('SET LOCAL request.jwt.claim.sub = %L', ''); EXCEPTION WHEN OTHERS THEN NULL; END;
    BEGIN EXECUTE format('SET LOCAL request.jwt.claims = %L', ''); EXCEPTION WHEN OTHERS THEN NULL; END;
    v_sqlstate := SQLSTATE;
    INSERT INTO _results (test_name, result, detail)
      VALUES ('rep_b_own_leads', 'FAIL', 'SQLSTATE=' || v_sqlstate);
  END;

  -- ── Test 4: Rep A cannot read Rep B's lead by ID ──────────────────────────
  BEGIN
    EXECUTE format('SET LOCAL request.jwt.claim.sub = %L', v_rep_a_uuid);
    EXECUTE format('SET LOCAL request.jwt.claims = %L',
      json_build_object('sub', v_rep_a_uuid)::text);
    SET LOCAL ROLE authenticated;

    SELECT current_user INTO v_verify_user;
    EXECUTE 'SELECT auth.uid()::text' INTO v_verify_uid;

    IF v_verify_user <> 'authenticated' OR v_verify_uid IS DISTINCT FROM v_rep_a_uuid THEN
      v_result := 'FAIL';
      v_detail := 'impersonation_failed';
    ELSE
      EXECUTE format(
        'SELECT count(*) FROM public.lead_entries WHERE id = %L::uuid',
        v_rep_b_lead_id
      ) INTO v_count;
      v_result := CASE WHEN v_count = 0 THEN 'PASS' ELSE 'FAIL' END;
      v_detail := 'rows_visible=' || v_count::text;
    END IF;

    RESET ROLE;
    EXECUTE format('SET LOCAL request.jwt.claim.sub = %L', '');
    EXECUTE format('SET LOCAL request.jwt.claims = %L', '');

    INSERT INTO _results (test_name, result, detail)
      VALUES ('rep_a_cannot_read_rep_b_lead', v_result, v_detail);
  EXCEPTION WHEN OTHERS THEN
    BEGIN RESET ROLE; EXCEPTION WHEN OTHERS THEN NULL; END;
    BEGIN EXECUTE format('SET LOCAL request.jwt.claim.sub = %L', ''); EXCEPTION WHEN OTHERS THEN NULL; END;
    BEGIN EXECUTE format('SET LOCAL request.jwt.claims = %L', ''); EXCEPTION WHEN OTHERS THEN NULL; END;
    v_sqlstate := SQLSTATE;
    INSERT INTO _results (test_name, result, detail)
      VALUES ('rep_a_cannot_read_rep_b_lead', 'FAIL', 'SQLSTATE=' || v_sqlstate);
  END;

  -- ── Test 5: Rep B cannot read Rep A's lead by ID ──────────────────────────
  BEGIN
    EXECUTE format('SET LOCAL request.jwt.claim.sub = %L', v_rep_b_uuid);
    EXECUTE format('SET LOCAL request.jwt.claims = %L',
      json_build_object('sub', v_rep_b_uuid)::text);
    SET LOCAL ROLE authenticated;

    SELECT current_user INTO v_verify_user;
    EXECUTE 'SELECT auth.uid()::text' INTO v_verify_uid;

    IF v_verify_user <> 'authenticated' OR v_verify_uid IS DISTINCT FROM v_rep_b_uuid THEN
      v_result := 'FAIL';
      v_detail := 'impersonation_failed';
    ELSE
      EXECUTE format(
        'SELECT count(*) FROM public.lead_entries WHERE id = %L::uuid',
        v_rep_a_lead_id
      ) INTO v_count;
      v_result := CASE WHEN v_count = 0 THEN 'PASS' ELSE 'FAIL' END;
      v_detail := 'rows_visible=' || v_count::text;
    END IF;

    RESET ROLE;
    EXECUTE format('SET LOCAL request.jwt.claim.sub = %L', '');
    EXECUTE format('SET LOCAL request.jwt.claims = %L', '');

    INSERT INTO _results (test_name, result, detail)
      VALUES ('rep_b_cannot_read_rep_a_lead', v_result, v_detail);
  EXCEPTION WHEN OTHERS THEN
    BEGIN RESET ROLE; EXCEPTION WHEN OTHERS THEN NULL; END;
    BEGIN EXECUTE format('SET LOCAL request.jwt.claim.sub = %L', ''); EXCEPTION WHEN OTHERS THEN NULL; END;
    BEGIN EXECUTE format('SET LOCAL request.jwt.claims = %L', ''); EXCEPTION WHEN OTHERS THEN NULL; END;
    v_sqlstate := SQLSTATE;
    INSERT INTO _results (test_name, result, detail)
      VALUES ('rep_b_cannot_read_rep_a_lead', 'FAIL', 'SQLSTATE=' || v_sqlstate);
  END;

  -- ── Test 6: Anon denial ──────────────────────────────────────────────────
  -- Only the actual lead_entries SELECT is in a nested exception block.
  -- insufficient_privilege (42501) from that read is the only acceptable
  -- exception.  All other errors (role-switch, verification, restore, etc.)
  -- are caught by the outer handler and are always FAIL.
  BEGIN
    EXECUTE format('SET LOCAL request.jwt.claim.sub = %L', '');
    EXECUTE format('SET LOCAL request.jwt.claims = %L', '{}');
    SET LOCAL ROLE anon;

    SELECT current_user INTO v_verify_user;
    EXECUTE 'SELECT auth.uid()::text' INTO v_verify_uid;

    IF v_verify_user <> 'anon' OR v_verify_uid IS NOT NULL THEN
      v_result := 'FAIL';
      v_detail := 'impersonation_failed';
    ELSE
      -- Nested block: ONLY the lead_entries read is here.
      -- 42501 is acceptable (PASS).  Any other error is FAIL.
      BEGIN
        EXECUTE 'SELECT count(*) FROM public.lead_entries' INTO v_count;
        v_result := CASE WHEN v_count = 0 THEN 'PASS' ELSE 'FAIL' END;
        v_detail := 'rows_visible=' || v_count::text;
      EXCEPTION
        WHEN insufficient_privilege THEN
          v_result := 'PASS';
          v_detail := 'insufficient_privilege (42501)';
        WHEN OTHERS THEN
          v_result := 'FAIL';
          v_detail := 'SQLSTATE=' || SQLSTATE;
      END;
    END IF;

    RESET ROLE;
    EXECUTE format('SET LOCAL request.jwt.claim.sub = %L', '');
    EXECUTE format('SET LOCAL request.jwt.claims = %L', '');

    INSERT INTO _results (test_name, result, detail)
      VALUES ('anon_denial', v_result, v_detail);
  EXCEPTION WHEN OTHERS THEN
    -- Role-switch, identity-verification, or restore errors.
    -- These must NEVER be PASS.
    BEGIN RESET ROLE; EXCEPTION WHEN OTHERS THEN NULL; END;
    BEGIN EXECUTE format('SET LOCAL request.jwt.claim.sub = %L', ''); EXCEPTION WHEN OTHERS THEN NULL; END;
    BEGIN EXECUTE format('SET LOCAL request.jwt.claims = %L', ''); EXCEPTION WHEN OTHERS THEN NULL; END;
    v_sqlstate := SQLSTATE;
    INSERT INTO _results (test_name, result, detail)
      VALUES ('anon_denial', 'FAIL', 'SQLSTATE=' || v_sqlstate);
  END;

  -- ── Test 7: Authenticated identity with no rep profile ───────────────────
  -- Requires a successful query returning zero rows.  Any exception is FAIL.
  BEGIN
    EXECUTE format('SET LOCAL request.jwt.claim.sub = %L', v_no_profile);
    EXECUTE format('SET LOCAL request.jwt.claims = %L',
      json_build_object('sub', v_no_profile)::text);
    SET LOCAL ROLE authenticated;

    SELECT current_user INTO v_verify_user;
    EXECUTE 'SELECT auth.uid()::text' INTO v_verify_uid;

    IF v_verify_user <> 'authenticated' OR v_verify_uid IS DISTINCT FROM v_no_profile THEN
      v_result := 'FAIL';
      v_detail := 'impersonation_failed';
    ELSE
      EXECUTE 'SELECT count(*) FROM public.lead_entries' INTO v_count;
      v_result := CASE WHEN v_count = 0 THEN 'PASS' ELSE 'FAIL' END;
      v_detail := 'rows_visible=' || v_count::text;
    END IF;

    RESET ROLE;
    EXECUTE format('SET LOCAL request.jwt.claim.sub = %L', '');
    EXECUTE format('SET LOCAL request.jwt.claims = %L', '');

    INSERT INTO _results (test_name, result, detail)
      VALUES ('no_profile_user', v_result, v_detail);
  EXCEPTION WHEN OTHERS THEN
    BEGIN RESET ROLE; EXCEPTION WHEN OTHERS THEN NULL; END;
    BEGIN EXECUTE format('SET LOCAL request.jwt.claim.sub = %L', ''); EXCEPTION WHEN OTHERS THEN NULL; END;
    BEGIN EXECUTE format('SET LOCAL request.jwt.claims = %L', ''); EXCEPTION WHEN OTHERS THEN NULL; END;
    v_sqlstate := SQLSTATE;
    INSERT INTO _results (test_name, result, detail)
      VALUES ('no_profile_user', 'FAIL', 'SQLSTATE=' || v_sqlstate);
  END;

  -- ── Overall verdict ───────────────────────────────────────────────────────
  -- PASS only when exactly one result exists for each of the seven expected
  -- test names and every one is PASS.
  SELECT count(*), count(DISTINCT test_name), bool_and(result = 'PASS')
    INTO v_expected_count, v_distinct_count, v_all_passed
  FROM _results
  WHERE test_name IN (
    'admin_sees_all',
    'rep_a_own_leads',
    'rep_b_own_leads',
    'rep_a_cannot_read_rep_b_lead',
    'rep_b_cannot_read_rep_a_lead',
    'anon_denial',
    'no_profile_user'
  );

  IF v_expected_count <> 7
     OR v_distinct_count <> 7
     OR COALESCE(v_all_passed, false) <> true THEN
    v_all_passed := false;
  END IF;

  INSERT INTO _results (test_name, result, detail) VALUES (
    'overall',
    CASE WHEN v_all_passed THEN 'PASS' ELSE 'FAIL' END,
    CASE WHEN v_all_passed
         THEN 'all 7 tests passed'
         ELSE 'tests_run=' || coalesce(v_expected_count::text, '0') || ' expected=7'
    END
  );
END $$;

-- Safety net: restore original role even if the DO block left it changed
RESET ROLE;

-- ─── Phase 4: Display results ────────────────────────────────────────────────
SELECT test_name, result, detail
FROM _results
ORDER BY seq;

-- ─── Phase 5: ROLLBACK (always — never COMMIT) ──────────────────────────────
ROLLBACK;
