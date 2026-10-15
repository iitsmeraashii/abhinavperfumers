-- UNEXECUTED — REVIEW ONLY
--
-- Purpose:
-- Append whatsapp_status to public.leads_list_view.
--
-- Scope:
-- No application-data changes, grants, ownership changes, RLS changes,
-- or changes to capture, queue, ALPE, promotion, or sending workflows.
--
-- Execute the entire transaction together.
-- If execution fails or is interrupted, issue ROLLBACK in the SAME
-- database session, or confirm that the connection has terminated.
--
-- Preconditions deliberately reject an already-updated view.
--
-- A frontend build does not validate this SQL.

BEGIN;

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '10s';
SET LOCAL idle_in_transaction_session_timeout = '30s';

DO $migration$
DECLARE
  v_view_oid         oid;
  v_source_oid       oid;
  v_owner_before     oid;
  v_owner_after      oid;
  v_acl_before       aclitem[];
  v_acl_after        aclitem[];
  v_options_before   text[];
  v_options_after    text[];
  v_columns_before   jsonb;
  v_columns_after    jsonb;
  v_names            text[];
  v_types            text[];
  v_security_invoker boolean;
  v_column_count     bigint;

  v_expected_names CONSTANT text[] := ARRAY[
    'id',
    'client_name',
    'company',
    'phone',
    'event_code',
    'sales_rep_code',
    'lead_type',
    'lead_temperature',
    'state',
    'application',
    'lead_status',
    'system_status',
    'created_at',
    'search_text',
    'country'
  ]::text[];

  v_expected_types CONSTANT text[] := ARRAY[
    'text',
    'text',
    'text',
    'text',
    'text',
    'text',
    'text',
    'text',
    'text',
    'text',
    'text',
    'text',
    'timestamp without time zone',
    'text',
    'text'
  ]::text[];
BEGIN
  -- Locate the existing ordinary view.
  SELECT c.oid, c.relowner, c.relacl, c.reloptions
    INTO v_view_oid, v_owner_before, v_acl_before, v_options_before
  FROM pg_catalog.pg_class AS c
  JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relname = 'leads_list_view'
    AND c.relkind = 'v';

  IF v_view_oid IS NULL THEN
    RAISE EXCEPTION
      'Precondition failed: public.leads_list_view is missing or is not an ordinary view';
  END IF;

  IF pg_catalog.pg_get_userbyid(v_owner_before)
       IS DISTINCT FROM 'postgres' THEN
    RAISE EXCEPTION
      'Precondition failed: unexpected view owner';
  END IF;

  SELECT o.option_value::boolean
    INTO v_security_invoker
  FROM pg_catalog.pg_options_to_table(v_options_before) AS o
  WHERE o.option_name = 'security_invoker';

  IF v_security_invoker IS DISTINCT FROM true THEN
    RAISE EXCEPTION
      'Precondition failed: security_invoker must already be true';
  END IF;

  -- Confirm the source column exists and has the expected type.
  v_source_oid := pg_catalog.to_regclass('public.lead_entries');

  IF v_source_oid IS NULL THEN
    RAISE EXCEPTION
      'Precondition failed: public.lead_entries is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS a
    WHERE a.attrelid = v_source_oid
      AND a.attnum > 0
      AND NOT a.attisdropped
      AND a.attname = 'whatsapp_status'
      AND a.atttypid = 'pg_catalog.text'::regtype
      AND a.atttypmod = -1
  ) THEN
    RAISE EXCEPTION
      'Precondition failed: lead_entries.whatsapp_status must exist as text';
  END IF;

  -- Validate the confirmed baseline and snapshot original attributes.
  SELECT
    count(*),
    array_agg(a.attname::text ORDER BY a.attnum),
    array_agg(
      pg_catalog.format_type(a.atttypid, a.atttypmod)
      ORDER BY a.attnum
    ),
    jsonb_agg(
      jsonb_build_object(
        'position', a.attnum,
        'name', a.attname,
        'type_oid', a.atttypid,
        'typmod', a.atttypmod,
        'collation', a.attcollation,
        'not_null', a.attnotnull,
        'column_acl', a.attacl::text,
        'options', a.attoptions
      )
      ORDER BY a.attnum
    )
  INTO
    v_column_count,
    v_names,
    v_types,
    v_columns_before
  FROM pg_catalog.pg_attribute AS a
  WHERE a.attrelid = v_view_oid
    AND a.attnum > 0
    AND NOT a.attisdropped;

  IF v_column_count IS DISTINCT FROM 15::bigint
     OR v_names IS DISTINCT FROM v_expected_names
     OR v_types IS DISTINCT FROM v_expected_types THEN
    RAISE EXCEPTION
      'Precondition failed: view columns do not match the confirmed 15-column baseline';
  END IF;

  -- This definition matches the supplied live baseline.
  -- Existing expressions and order are retained; only the final column
  -- is added. Catalog checks below verify structural preservation.
  EXECUTE $view$
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
    FROM public.lead_entries
  $view$;

  IF pg_catalog.to_regclass('public.leads_list_view')::oid
       IS DISTINCT FROM v_view_oid THEN
    RAISE EXCEPTION
      'Postcondition failed: view identity changed';
  END IF;

  SELECT c.relowner, c.relacl, c.reloptions
    INTO v_owner_after, v_acl_after, v_options_after
  FROM pg_catalog.pg_class AS c
  WHERE c.oid = v_view_oid
    AND c.relkind = 'v';

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'Postcondition failed: view is missing';
  END IF;

  IF v_owner_after IS DISTINCT FROM v_owner_before THEN
    RAISE EXCEPTION
      'Postcondition failed: view owner changed';
  END IF;

  -- Exact comparison covers the complete explicit ACL, including
  -- grantors, grantees, privileges and grant options.
  IF v_acl_after IS DISTINCT FROM v_acl_before THEN
    RAISE EXCEPTION
      'Postcondition failed: view ACL changed';
  END IF;

  -- Compare options independent of array ordering.
  IF (
    SELECT array_agg(x ORDER BY x)
    FROM unnest(v_options_after) AS t(x)
  ) IS DISTINCT FROM (
    SELECT array_agg(x ORDER BY x)
    FROM unnest(v_options_before) AS t(x)
  ) THEN
    RAISE EXCEPTION
      'Postcondition failed: view options changed';
  END IF;

  SELECT o.option_value::boolean
    INTO v_security_invoker
  FROM pg_catalog.pg_options_to_table(v_options_after) AS o
  WHERE o.option_name = 'security_invoker';

  IF v_security_invoker IS DISTINCT FROM true THEN
    RAISE EXCEPTION
      'Postcondition failed: security_invoker is not true';
  END IF;

  SELECT count(*)
    INTO v_column_count
  FROM pg_catalog.pg_attribute AS a
  WHERE a.attrelid = v_view_oid
    AND a.attnum > 0
    AND NOT a.attisdropped;

  IF v_column_count IS DISTINCT FROM 16::bigint THEN
    RAISE EXCEPTION
      'Postcondition failed: expected exactly 16 columns';
  END IF;

  SELECT jsonb_agg(
    jsonb_build_object(
      'position', a.attnum,
      'name', a.attname,
      'type_oid', a.atttypid,
      'typmod', a.atttypmod,
      'collation', a.attcollation,
      'not_null', a.attnotnull,
      'column_acl', a.attacl::text,
      'options', a.attoptions
    )
    ORDER BY a.attnum
  )
  INTO v_columns_after
  FROM pg_catalog.pg_attribute AS a
  WHERE a.attrelid = v_view_oid
    AND a.attnum BETWEEN 1 AND 15
    AND NOT a.attisdropped;

  IF v_columns_after IS DISTINCT FROM v_columns_before THEN
    RAISE EXCEPTION
      'Postcondition failed: original column attributes changed';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS a
    WHERE a.attrelid = v_view_oid
      AND a.attnum = 16
      AND NOT a.attisdropped
      AND a.attname = 'whatsapp_status'
      AND a.atttypid = 'pg_catalog.text'::regtype
      AND a.atttypmod = -1
  ) THEN
    RAISE EXCEPTION
      'Postcondition failed: column 16 must be whatsapp_status text';
  END IF;
END;
$migration$;

COMMIT;

-- READ-ONLY VERIFICATION
-- These queries run after COMMIT. A failure here does not roll back
-- the committed change. Required preservation checks ran above.

-- 1. Column order and types.
SELECT
  a.attnum AS ordinal_position,
  a.attname AS column_name,
  pg_catalog.format_type(a.atttypid, a.atttypmod) AS column_type
FROM pg_catalog.pg_attribute AS a
WHERE a.attrelid = 'public.leads_list_view'::regclass
  AND a.attnum > 0
  AND NOT a.attisdropped
ORDER BY a.attnum;

-- 2. Owner and security settings.
SELECT
  pg_catalog.pg_get_userbyid(c.relowner) AS owner_name,
  c.reloptions,
  (
    SELECT o.option_value::boolean
    FROM pg_catalog.pg_options_to_table(c.reloptions) AS o
    WHERE o.option_name = 'security_invoker'
  ) AS security_invoker
FROM pg_catalog.pg_class AS c
WHERE c.oid = 'public.leads_list_view'::regclass;

-- 3. Complete effective ACL representation.
SELECT
  pg_catalog.pg_get_userbyid(a.grantor) AS grantor,
  CASE
    WHEN a.grantee = 0 THEN 'PUBLIC'
    ELSE pg_catalog.pg_get_userbyid(a.grantee)
  END AS grantee,
  a.privilege_type,
  a.is_grantable
FROM pg_catalog.pg_class AS c
CROSS JOIN LATERAL pg_catalog.aclexplode(
  COALESCE(
    c.relacl,
    pg_catalog.acldefault('r', c.relowner)
  )
) AS a
WHERE c.oid = 'public.leads_list_view'::regclass
ORDER BY grantee, privilege_type, grantor;

-- 4. Confirm the new column resolves without returning lead data.
SELECT whatsapp_status
FROM public.leads_list_view
LIMIT 0;

-- ROLLBACK / COMPATIBILITY NOTES
--
-- Before COMMIT:
-- ROLLBACK in the same session reverses this transaction.
--
-- After COMMIT:
-- CREATE OR REPLACE VIEW cannot remove an existing trailing column.
-- If the UI change is reverted, leave this additive column in place.
-- Do not automatically drop/recreate the view.
--
-- Existing inspected frontend consumers read named object properties.
-- An added response property does not change those property reads.
-- TypeScript interfaces do not remove extra fields at runtime.
--
-- Repository inspection is not a complete live-database dependency
-- audit. Compatibility of unknown external consumers, particularly
-- positional or whole-row consumers, has not been established.
--
-- Preconditions validate structure, owner and security settings.
-- They do not prove that an independently modified live view still has
-- the same SQL expressions. The replacement definition above relies on
-- the live definition supplied for this review; if that definition has
-- changed since then, review the new definition before execution.