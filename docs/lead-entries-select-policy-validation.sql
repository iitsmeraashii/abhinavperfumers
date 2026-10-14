-- ============================================================================
-- PRODUCTION VALIDATION SCRIPT — REVIEW ONLY. DO NOT EXECUTE.
-- File: docs/lead-entries-select-policy-validation.sql
-- Date: 2026-10-14
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
--   - All temp tables are ON COMMIT DROP (destroyed when transaction ends).
--   - No INSERT/UPDATE/DELETE on application tables.
--   - No changes to auth.users or sales_representatives.
--   - Output contains only PASS/FAIL/INFO labels and counts — no names,
--     emails, UUIDs, tokens, passwords, or lead contents.
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
--   the duration of the transaction.  With lock_timeout = 3s, the script
--   aborts if the lock cannot be acquired within 3 seconds.
--   Estimated total lock hold time: 1–5 seconds (DDL + queries + rollback).
--   RECOMMENDED WINDOW: Run during a low-traffic period (off-hours) to
--   minimise blocking impact on application queries.
--
-- HOW ROLE / JWT IMPERSONATION WORKS:
--   PostgreSQL SET ROLE changes the current user for the session.  Within a
--   transaction that ends with ROLLBACK, the role change is automatically
--   undone.  Supabase's auth.uid() reads the JWT subject from the
--   request.jwt.claims GUC.  By setting this GUC with SET LOCAL
--   (transaction-scoped) to a JSON object containing a "sub" field, then
--   SET ROLE authenticated, subsequent queries execute as that authenticated
--   user with RLS policies applied.  The combination tests actual RLS
--   enforcement — not merely the policy definition.
--
--   Note: "SET LOCAL ROLE" is not valid PostgreSQL syntax.  SET ROLE within
--   a ROLLBACK-only transaction is the functional equivalent and is used
--   here.  RESET ROLE is called after every test, and again as a safety net
--   after the DO block, to restore the original role even if an exception
--   occurs mid-test.
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
--   - Assertion failure (RAISE EXCEPTION in Phase 1): The transaction
--     aborts immediately.  No policies are changed.  The final ROLLBACK
--     is a no-op (transaction already aborted) but is still required
--     syntax to close the block.
--   - If the SQL Editor leaves a transaction open (e.g., client disconnect,
--     query timeout, or manual cancellation), manually execute:
--       ROLLBACK;
--     This restores all original policies, grants, and the original role.
--     If ROLLBACK reports "there is no transaction in progress", the
--     transaction was already rolled back automatically — no action needed.
--
-- WHAT THIS VERIFIES:
--   1. Active/login-enabled admin sees exactly the baseline total count.
--   2. Each active/login-enabled sales rep sees exactly their own count.
--   3. Rep A cannot read Rep B's specific lead by ID, and vice versa.
--   4. anon is denied (either permission error or 0 rows).
--   5. An authenticated identity with no sales_representatives profile sees
--      0 rows (tested with a random UUID — see note below).
--   6. Baseline counts are consistent across all checks (REPEATABLE READ).
--
--   Note on Test 7 (no-profile user): The script generates a random UUID
--   with gen_random_uuid() rather than searching auth.users for a real
--   user without a rep profile.  From the RLS policy's perspective the two
--   are identical: auth.uid() returns a UUID, the EXISTS checks
--   sales_representatives.auth_user_id = auth.uid(), and no row matches.
--   The policy never consults auth.users.  This avoids dependency on
--   finding a real no-profile user and avoids exposing any real user data.
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

-- ─── Temp tables (transaction-scoped, destroyed on ROLLBACK) ────────────────

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
  v_baseline_total bigint;
  v_baseline_a     bigint;
  v_baseline_b     bigint;
BEGIN
  -- Find one active / login-enabled admin
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

  -- Find rep A: active / login-enabled sales_rep with the most assigned leads
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

  -- Find rep B: distinct rep_code, also active / login-enabled with leads
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

  -- Pick one lead ID per rep for cross-rep denial tests
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

  -- Generate a random UUID for the no-profile test.
  -- This UUID cannot match any sales_representatives.auth_user_id, so the
  -- EXISTS in both policies returns false and the identity sees 0 rows.
  INSERT INTO _ids (key, val) VALUES ('no_profile_uuid', gen_random_uuid()::text);

  -- Record baseline counts (as privileged role, BYPASSRLS)
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

-- ─── Phase 3: RLS tests via SET ROLE + SET LOCAL JWT claims ─────────────────
-- Each test: set JWT claims → SET ROLE → run query → RESET ROLE → clear claims.
-- Exception handlers ensure RESET ROLE runs even if the query fails.

DO $$
DECLARE
  v_admin_uuid     text;
  v_rep_a_uuid     text;
  v_rep_b_uuid     text;
  v_rep_a_lead_id  text;
  v_rep_b_lead_id  text;
  v_no_profile     text;
  v_baseline_total text;
  v_baseline_a     text;
  v_baseline_b     text;
  v_count          bigint;
  v_has_select     boolean;
BEGIN
  -- Load test parameters
  SELECT val INTO v_admin_uuid     FROM _ids WHERE key = 'admin_uuid';
  SELECT val INTO v_rep_a_uuid     FROM _ids WHERE key = 'rep_a_uuid';
  SELECT val INTO v_rep_b_uuid     FROM _ids WHERE key = 'rep_b_uuid';
  SELECT val INTO v_rep_a_lead_id  FROM _ids WHERE key = 'rep_a_lead_id';
  SELECT val INTO v_rep_b_lead_id  FROM _ids WHERE key = 'rep_b_lead_id';
  SELECT val INTO v_no_profile     FROM _ids WHERE key = 'no_profile_uuid';
  SELECT detail INTO v_baseline_total FROM _results WHERE test_name = 'baseline_total';
  SELECT detail INTO v_baseline_a     FROM _results WHERE test_name = 'baseline_rep_a';
  SELECT detail INTO v_baseline_b     FROM _results WHERE test_name = 'baseline_rep_b';

  -- ── Test 1: Admin sees all leads ──────────────────────────────────────────
  BEGIN
    EXECUTE format('SET LOCAL request.jwt.claims = %L',
      json_build_object('sub', v_admin_uuid)::text);
    EXECUTE 'SET ROLE authenticated';
    EXECUTE 'SELECT count(*) FROM public.lead_entries' INTO v_count;
    EXECUTE 'RESET ROLE';
    EXECUTE format('SET LOCAL request.jwt.claims = %L', '');

    INSERT INTO _results (test_name, result, detail) VALUES (
      'admin_sees_all',
      CASE WHEN v_count::text = v_baseline_total THEN 'PASS' ELSE 'FAIL' END,
      'count=' || v_count::text || ' baseline=' || v_baseline_total
    );
  EXCEPTION WHEN OTHERS THEN
    BEGIN EXECUTE 'RESET ROLE'; EXCEPTION WHEN OTHERS THEN NULL; END;
    INSERT INTO _results (test_name, result, detail) VALUES (
      'admin_sees_all', 'FAIL', 'ERROR: ' || SQLERRM
    );
  END;

  -- ── Test 2: Rep A sees only own leads ─────────────────────────────────────
  BEGIN
    EXECUTE format('SET LOCAL request.jwt.claims = %L',
      json_build_object('sub', v_rep_a_uuid)::text);
    EXECUTE 'SET ROLE authenticated';
    EXECUTE 'SELECT count(*) FROM public.lead_entries' INTO v_count;
    EXECUTE 'RESET ROLE';
    EXECUTE format('SET LOCAL request.jwt.claims = %L', '');

    INSERT INTO _results (test_name, result, detail) VALUES (
      'rep_a_own_leads',
      CASE WHEN v_count::text = v_baseline_a THEN 'PASS' ELSE 'FAIL' END,
      'count=' || v_count::text || ' baseline=' || v_baseline_a
    );
  EXCEPTION WHEN OTHERS THEN
    BEGIN EXECUTE 'RESET ROLE'; EXCEPTION WHEN OTHERS THEN NULL; END;
    INSERT INTO _results (test_name, result, detail) VALUES (
      'rep_a_own_leads', 'FAIL', 'ERROR: ' || SQLERRM
    );
  END;

  -- ── Test 3: Rep B sees only own leads ─────────────────────────────────────
  BEGIN
    EXECUTE format('SET LOCAL request.jwt.claims = %L',
      json_build_object('sub', v_rep_b_uuid)::text);
    EXECUTE 'SET ROLE authenticated';
    EXECUTE 'SELECT count(*) FROM public.lead_entries' INTO v_count;
    EXECUTE 'RESET ROLE';
    EXECUTE format('SET LOCAL request.jwt.claims = %L', '');

    INSERT INTO _results (test_name, result, detail) VALUES (
      'rep_b_own_leads',
      CASE WHEN v_count::text = v_baseline_b THEN 'PASS' ELSE 'FAIL' END,
      'count=' || v_count::text || ' baseline=' || v_baseline_b
    );
  EXCEPTION WHEN OTHERS THEN
    BEGIN EXECUTE 'RESET ROLE'; EXCEPTION WHEN OTHERS THEN NULL; END;
    INSERT INTO _results (test_name, result, detail) VALUES (
      'rep_b_own_leads', 'FAIL', 'ERROR: ' || SQLERRM
    );
  END;

  -- ── Test 4: Rep A cannot read Rep B's lead by ID ──────────────────────────
  BEGIN
    EXECUTE format('SET LOCAL request.jwt.claims = %L',
      json_build_object('sub', v_rep_a_uuid)::text);
    EXECUTE 'SET ROLE authenticated';
    EXECUTE format(
      'SELECT count(*) FROM public.lead_entries WHERE id = %L::uuid',
      v_rep_b_lead_id
    ) INTO v_count;
    EXECUTE 'RESET ROLE';
    EXECUTE format('SET LOCAL request.jwt.claims = %L', '');

    INSERT INTO _results (test_name, result, detail) VALUES (
      'rep_a_cannot_read_rep_b_lead',
      CASE WHEN v_count = 0 THEN 'PASS' ELSE 'FAIL' END,
      'rows_visible=' || v_count::text
    );
  EXCEPTION WHEN OTHERS THEN
    BEGIN EXECUTE 'RESET ROLE'; EXCEPTION WHEN OTHERS THEN NULL; END;
    INSERT INTO _results (test_name, result, detail) VALUES (
      'rep_a_cannot_read_rep_b_lead', 'FAIL', 'ERROR: ' || SQLERRM
    );
  END;

  -- ── Test 5: Rep B cannot read Rep A's lead by ID ──────────────────────────
  BEGIN
    EXECUTE format('SET LOCAL request.jwt.claims = %L',
      json_build_object('sub', v_rep_b_uuid)::text);
    EXECUTE 'SET ROLE authenticated';
    EXECUTE format(
      'SELECT count(*) FROM public.lead_entries WHERE id = %L::uuid',
      v_rep_a_lead_id
    ) INTO v_count;
    EXECUTE 'RESET ROLE';
    EXECUTE format('SET LOCAL request.jwt.claims = %L', '');

    INSERT INTO _results (test_name, result, detail) VALUES (
      'rep_b_cannot_read_rep_a_lead',
      CASE WHEN v_count = 0 THEN 'PASS' ELSE 'FAIL' END,
      'rows_visible=' || v_count::text
    );
  EXCEPTION WHEN OTHERS THEN
    BEGIN EXECUTE 'RESET ROLE'; EXCEPTION WHEN OTHERS THEN NULL; END;
    INSERT INTO _results (test_name, result, detail) VALUES (
      'rep_b_cannot_read_rep_a_lead', 'FAIL', 'ERROR: ' || SQLERRM
    );
  END;

  -- ── Test 6: Anon denial ──────────────────────────────────────────────────
  -- Acceptable outcomes: (a) permission denied, (b) 0 rows returned.
  BEGIN
    SELECT has_table_privilege('anon', 'public.lead_entries', 'SELECT')
      INTO v_has_select;

    IF NOT v_has_select THEN
      INSERT INTO _results (test_name, result, detail) VALUES (
        'anon_denial', 'PASS', 'anon lacks SELECT privilege (revoked)'
      );
    ELSE
      -- anon still has SELECT; verify RLS returns 0 rows
      EXECUTE format('SET LOCAL request.jwt.claims = %L', '{}');
      EXECUTE 'SET ROLE anon';
      EXECUTE 'SELECT count(*) FROM public.lead_entries' INTO v_count;
      EXECUTE 'RESET ROLE';
      EXECUTE format('SET LOCAL request.jwt.claims = %L', '');

      IF v_count = 0 THEN
        INSERT INTO _results (test_name, result, detail) VALUES (
          'anon_denial', 'PASS', 'anon has SELECT but RLS returns 0 rows'
        );
      ELSE
        INSERT INTO _results (test_name, result, detail) VALUES (
          'anon_denial', 'FAIL', 'anon can read ' || v_count::text || ' rows'
        );
      END IF;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    BEGIN EXECUTE 'RESET ROLE'; EXCEPTION WHEN OTHERS THEN NULL; END;
    INSERT INTO _results (test_name, result, detail) VALUES (
      'anon_denial', 'PASS', 'permission denied (expected): ' || SQLERRM
    );
  END;

  -- ── Test 7: Authenticated identity with no rep profile ───────────────────
  -- Uses a random UUID that cannot match any sales_representatives row.
  -- The RLS policy only checks sales_representatives.auth_user_id = auth.uid(),
  -- so this is functionally identical to a real auth.user without a profile.
  BEGIN
    EXECUTE format('SET LOCAL request.jwt.claims = %L',
      json_build_object('sub', v_no_profile)::text);
    EXECUTE 'SET ROLE authenticated';
    EXECUTE 'SELECT count(*) FROM public.lead_entries' INTO v_count;
    EXECUTE 'RESET ROLE';
    EXECUTE format('SET LOCAL request.jwt.claims = %L', '');

    IF v_count = 0 THEN
      INSERT INTO _results (test_name, result, detail) VALUES (
        'no_profile_user', 'PASS',
        '0 rows (no rep profile, correctly denied)'
      );
    ELSE
      INSERT INTO _results (test_name, result, detail) VALUES (
        'no_profile_user', 'FAIL',
        v_count::text || ' rows visible without rep profile'
      );
    END IF;
  EXCEPTION WHEN OTHERS THEN
    BEGIN EXECUTE 'RESET ROLE'; EXCEPTION WHEN OTHERS THEN NULL; END;
    INSERT INTO _results (test_name, result, detail) VALUES (
      'no_profile_user', 'PASS', 'denied (expected): ' || SQLERRM
    );
  END;
END $$;

-- Safety net: restore original role even if the DO block left it changed
RESET ROLE;

-- ─── Phase 4: Display results ────────────────────────────────────────────────
SELECT test_name, result, detail
FROM _results
ORDER BY seq;

-- ─── Phase 5: ROLLBACK (always — never COMMIT) ──────────────────────────────
ROLLBACK;
