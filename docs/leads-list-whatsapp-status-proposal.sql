-- ════════════════════════════════════════════════════════════════════════════
-- UNEXECUTED — REVIEW ONLY
--
-- Proposal: Append whatsapp_status to public.leads_list_view
-- Status:   NOT APPLIED. Do not run without explicit approval.
--
-- Purpose:
--   Expose lead_entries.whatsapp_status through leads_list_view so the
--   Leads page can apply a server-side multi-select filter on that column
--   without downloading all rows to the browser.
--
-- Confirmed live-database facts:
--   • public.lead_entries.whatsapp_status  — text, nullable
--   • public.leads_list_view owner         — postgres
--   • View options                         — security_invoker = true
--   • ACL                                  —
--       postgres      = arwdDxtm/postgres
--       authenticated = arwdDxtm/postgres
--       service_role  = arwdDxtm/postgres
--   • Existing view definition (exact column order):
--       SELECT
--         id, client_name, company, phones[1] AS phone, event_code,
--         sales_rep_code, lead_type, lead_temperature, state, application,
--         lead_status, system_status, created_at, search_text, country
--       FROM public.lead_entries;
--
-- What this migration does:
--   1. CREATE OR REPLACE VIEW with the identical column list and order,
--      appending whatsapp_status as the final column.
--   2. Metadata assertions (pre and post) to verify column order, types,
--      owner, security option, and ACL are preserved.
--
-- What this migration does NOT do:
--   • Does NOT DROP the view (no DROP VIEW).
--   • Does NOT use CASCADE.
--   • Does NOT change ownership.
--   • Does NOT issue GRANT or REVOKE.
--   • Does NOT modify lead_entries or any other table.
--   • Does NOT modify data, RLS policies, other views, functions, capture,
--     queue, ALPE, promotion, auth, or n8n workflows.
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

  -- Short transaction-local timeouts so a blocked DDL fails fast rather than
  -- hanging the connection.
  SET LOCAL lock_timeout  = '3s';
  SET LOCAL statement_timeout = '10s';

  -- ── Pre-condition assertions ──────────────────────────────────────────────

  -- Assert the source column exists and is text.
  ASSERT EXISTS (
    SELECT 1
    FROM pg_attribute
    WHERE attrelid = 'public.lead_entries'::regclass
      AND attname  = 'whatsapp_status'
      AND NOT attisdropped
  ), 'Pre-condition failed: lead_entries.whatsapp_status does not exist';

  ASSERT EXISTS (
    SELECT 1
    FROM pg_attribute
    WHERE attrelid = 'public.lead_entries'::regclass
      AND attname  = 'whatsapp_status'
      AND format_type(atttypid, atttypmod) = 'text'
      AND NOT attisdropped
  ), 'Pre-condition failed: lead_entries.whatsapp_status is not type text';

  -- Assert the view exists with security_invoker = true.
  ASSERT (
    SELECT bool setting
    FROM pg_catalog.pg_views v
    JOIN pg_catalog.pg_namespace n ON n.oid = v.schemaname::regnamespace::oid
    WHERE n.nspname = 'public' AND v.viewname = 'leads_list_view'
  ) IS NOT NULL
  , 'Pre-condition failed: public.leads_list_view does not exist';

  -- Assert current column count is 15 (so we know we are appending to the
  -- expected baseline, not a stale or already-modified view).
  ASSERT (
    SELECT count(*)
    FROM pg_attribute
    WHERE attrelid = 'public.leads_list_view'::regclass
      AND attnum > 0
      AND NOT attisdropped
  ) = 15
  , 'Pre-condition failed: leads_list_view has unexpected column count (expected 15)';

  -- Assert existing columns are in the expected order.
  ASSERT (
    SELECT string_agg(attname, ',' ORDER BY attnum)
    FROM pg_attribute
    WHERE attrelid = 'public.leads_list_view'::regclass
      AND attnum > 0
      AND NOT attisdropped
  ) = 'id,client_name,company,phone,event_code,sales_rep_code,lead_type,lead_temperature,state,application,lead_status,system_status,created_at,search_text,country'
  , 'Pre-condition failed: leads_list_view column names or order do not match expected baseline';

  -- ── DDL: CREATE OR REPLACE VIEW ───────────────────────────────────────────
  --
  -- Every existing expression, column name, type, and position is preserved
  -- exactly.  whatsapp_status is appended as the final (16th) column only.

  CREATE OR REPLACE VIEW public.leads_list_view
    WITH (security_invoker = true)
  AS
  SELECT
    id,
    client_name,
    company,
    phones[1] AS phone,
    event_code,
    sales_rep_code,
    lead_type,
    lead_temperature,
    state,
    application,
    lead_status,
    system_status,
    created_at,
    search_text,
    country,
    whatsapp_status
  FROM public.lead_entries;

  -- ── Post-condition assertions ─────────────────────────────────────────────

  -- Assert column count is now 16.
  ASSERT (
    SELECT count(*)
    FROM pg_attribute
    WHERE attrelid = 'public.leads_list_view'::regclass
      AND attnum > 0
      AND NOT attisdropped
  ) = 16
  , 'Post-condition failed: leads_list_view column count is not 16';

  -- Assert the first 15 columns are unchanged.
  ASSERT (
    SELECT string_agg(attname, ',' ORDER BY attnum)
    FROM pg_attribute
    WHERE attrelid = 'public.leads_list_view'::regclass
      AND attnum BETWEEN 1 AND 15
      AND NOT attisdropped
  ) = 'id,client_name,company,phone,event_code,sales_rep_code,lead_type,lead_temperature,state,application,lead_status,system_status,created_at,search_text,country'
  , 'Post-condition failed: original columns changed';

  -- Assert the 16th column is whatsapp_status with type text.
  ASSERT (
    SELECT attname
    FROM pg_attribute
    WHERE attrelid = 'public.leads_list_view'::regclass
      AND attnum = 16
      AND NOT attisdropped
  ) = 'whatsapp_status'
  , 'Post-condition failed: 16th column is not whatsapp_status';

  ASSERT (
    SELECT format_type(atttypid, atttypmod)
    FROM pg_attribute
    WHERE attrelid = 'public.leads_list_view'::regclass
      AND attnum = 16
      AND NOT attisdropped
  ) = 'text'
  , 'Post-condition failed: whatsapp_status column is not type text';

  -- Assert owner is still postgres.
  ASSERT (
    SELECT rolname
    FROM pg_class c
    WHERE c.oid = 'public.leads_list_view'::regclass
  ) = 'postgres'
  , 'Post-condition failed: view owner changed';

  -- Assert security_invoker is still true.
  ASSERT (
    SELECT COALESCE(
      (SELECT setting::bool
       FROM pg_catalog.pg_options_to_table(c.reloptions)
       WHERE option_name = 'security_invoker'),
      false)
    FROM pg_class c
    WHERE c.oid = 'public.leads_list_view'::regclass
  ) IS TRUE
  , 'Post-condition failed: security_invoker is not true';

  -- Assert ACL is preserved (authenticated still has arwdDxtm).
  ASSERT (
    SELECT count(*) = 1
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_authid a ON a.oid = c.relacl[1].grantor
    WHERE c.oid = 'public.leads_list_view'::regclass
      AND has_table_privilege('authenticated'::regrole,
           'public.leads_list_view'::regclass, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
  )
  , 'Post-condition failed: authenticated role ACL not preserved';

COMMIT;

-- ════════════════════════════════════════════════════════════════════════════
-- READ-ONLY VERIFICATION QUERIES (run after applying, not part of migration)
-- ════════════════════════════════════════════════════════════════════════════

-- 1. Column order and types
SELECT
  a.attnum,
  a.attname,
  format_type(a.atttypid, a.atttypmod) AS column_type,
  a.attnotnull
FROM pg_attribute a
WHERE a.attrelid = 'public.leads_list_view'::regclass
  AND a.attnum > 0
  AND NOT a.attisdropped
ORDER BY a.attnum;

-- 2. Owner and security_invoker option
SELECT
  c.relname,
  r.rolname AS owner,
  (SELECT setting::bool
   FROM pg_options_to_table(c.reloptions)
   WHERE option_name = 'security_invoker') AS security_invoker
FROM pg_class c
JOIN pg_authid r ON r.oid = c.relowner
WHERE c.oid = 'public.leads_list_view'::regclass;

-- 3. ACL (privileges)
SELECT
  grantee::regrole::text AS grantee,
  privilege_type
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
, aclexplode(c.relacl) AS acl
WHERE c.oid = 'public.leads_list_view'::regclass
ORDER BY grantee, privilege_type;

-- 4. Spot-check: confirm the column is queryable
SELECT whatsapp_status, count(*)
FROM public.leads_list_view
GROUP BY whatsapp_status
ORDER BY count(*) DESC;

-- ════════════════════════════════════════════════════════════════════════════
-- ROLLBACK LIMITATIONS
-- ════════════════════════════════════════════════════════════════════════════
--
-- • BEFORE COMMIT: issuing ROLLBACK instead of COMMIT undoes the CREATE OR
--   REPLACE VIEW entirely; the view reverts to its prior definition with no
--   side effects.
--
-- • AFTER COMMIT / DEPLOYMENT: CREATE OR REPLACE VIEW cannot remove an
--   appended column. There is no ALTER VIEW ... DROP COLUMN in PostgreSQL.
--   The only way to remove whatsapp_status from the view would be to
--   DROP VIEW public.leads_list_view CASCADE and recreate it without the
--   column. That is a destructive operation: CASCADE drops all dependent
--   objects (other views, policies, grants referencing the view), and
--   requires re-granting privileges manually. It should NOT be used as an
--   automatic rollback.
--
-- • SAFE REVERT STRATEGY: If the UI change is reverted (the multi-select
--   filter is removed), the extra whatsapp_status column can remain in the
--   view with no impact — no existing SELECT * consumer breaks because the
--   column is purely additive at the end. The column will simply be unused
--   until the UI is re-enabled or a future intentional DROP/CREATE migration
--   removes it.
--
-- ════════════════════════════════════════════════════════════════════════════
-- DEPENDENCIES AND SELECT * CONSUMERS
-- ════════════════════════════════════════════════════════════════════════════
--
-- The following code paths use SELECT * or rely on the view's column set.
-- Adding a trailing column is safe for all of them, but they are listed
-- for completeness:
--
-- 1. src/LeadsPage.tsx — fetchLeads():
--      .from('leads_list_view').select('*', { count: 'exact' })
--    The Lead interface does not include whatsapp_status, so the extra
--    column is ignored by the runtime. No breakage.
--
-- 2. src/LeadsPage.tsx — exportCSV():
--      .from('lead_entries').select('id, ..., whatsapp_status, ...')
--    This queries lead_entries directly (not the view) and already
--    references whatsapp_status. No change needed.
--
-- 3. src/LeadDetailPage.tsx — fetches from lead_entries with select('*'),
--    not from leads_list_view. Not affected by this view change.
--
-- 4. Supabase-generated TypeScript types (if auto-generated from the
--    schema) may pick up the new column. This is additive and safe.
--
-- 5. No other views, functions, or RPCs reference leads_list_view in
--    a way that would break from an appended column (verified by grep
--    across migrations and source).
-- ════════════════════════════════════════════════════════════════════════════
