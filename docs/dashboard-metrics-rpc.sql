-- Migration: 20261014120000_create_dashboard_metrics_rpc.sql
-- Status: PREPARED but NOT APPLIED
--
-- This file contains the full SQL for review. Once approved, apply via
-- mcp__supabase__apply_migration with filename
-- "20261014120000_create_dashboard_metrics_rpc".

/*
# Create get_dashboard_metrics RPC

## Summary
Adds a read-only, SECURITY INVOKER function that returns all dashboard
lead counts in a single database round-trip. Replaces the previous
client-side approach of downloading every lead row and aggregating
in JavaScript.

## What the function does
1. Derives the caller's role and rep_code from auth.uid() via the
   authoritative sales_representatives table — never trusts
   caller-supplied scope parameters.
2. Requires an active, login-enabled sales-representative profile.
3. Rejects missing/ambiguous profiles and unsupported roles explicitly
   via RAISE EXCEPTION.
4. Rejects missing/blank rep_code for sales_rep explicitly.
5. Admins: aggregates all lead_entries visible under RLS.
   Sales reps: explicitly filters to their own rep_code
   (defense-in-depth alongside RLS).
6. Returns a single row with 16 count columns matching the existing
   DashboardData interface.

## Security
- SECURITY INVOKER: runs as the calling user, so existing RLS on
  lead_entries and sales_representatives is fully preserved. The
  function cannot bypass RLS.
- EXECUTE revoked from PUBLIC and anon; granted to authenticated only.
- No tables modified, no policies changed, no indexes added.
- Role/rep_code derived server-side from auth.uid() — the frontend
  cannot inject a different scope.

## Metric semantics preserved
- system_status and lead_status are uppercased before comparison to
  tolerate mixed-case values in the database.
- lead_temperature is trimmed before classification into Hot/Warm/Cold.
- The unassigned bucket catches NULL, empty, and any value not in
  (Hot, Warm, Cold) after trimming.

## Today's boundary — browser-local-day preservation
The original client-side code computed `todayStart` in the browser:
  new Date(year, month, day).toISOString()
which is midnight in the browser's local timezone, converted to UTC.
For example, if the browser is in IST (UTC+5:30), "today" starts at
18:30 UTC of the previous day.

The frontend passes a `p_today_iso` parameter — an ISO 8601 timestamp
representing midnight in the browser's local timezone, converted to
UTC (exactly what the old client-side code computed). The RPC compares
created_at >= p_today_iso::timestamptz instead of using CURRENT_DATE.

The 7-day and 30-day boundaries are relative to now (not to midnight),
so they are computed as `now() - interval '7 days'` and
`now() - interval '30 days'` in the database, matching the old
client-side `Date.getTime() - N * 24 * 60 * 60 * 1000` computation.

## Contract
  get_dashboard_metrics(p_today_iso text DEFAULT NULL)
  RETURNS TABLE (16 bigint columns)
  SECURITY INVOKER, LANGUAGE plpgsql, SET search_path = public, pg_temp
*/

CREATE OR REPLACE FUNCTION public.get_dashboard_metrics(p_today_iso text DEFAULT NULL)
RETURNS TABLE (
  total_leads                   bigint,
  leads_today                   bigint,
  leads_last_7_days             bigint,
  leads_last_30_days            bigint,
  whatsapp_sent                 bigint,
  whatsapp_failed               bigint,
  invalid_leads                 bigint,
  new_leads                     bigint,
  contacted_leads               bigint,
  qualified_leads               bigint,
  converted_leads               bigint,
  lost_leads                    bigint,
  hot_leads                     bigint,
  warm_leads                    bigint,
  cold_leads                    bigint,
  unassigned_temperature_leads  bigint
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_rep_code   text;
  v_role       text;
  v_today_date timestamptz;
  v_match_count integer;
BEGIN
  -- Derive role and rep_code from the authoritative profile.
  -- RLS on sales_representatives ensures only the caller's own row is visible
  -- (auth.uid() = auth_user_id policy), plus active reps visible to all
  -- authenticated users.
  -- We require both is_active = true AND login_enabled = true so that
  -- disabled or deactivated reps cannot retrieve metrics.
  SELECT sr.rep_code, sr.role
    INTO v_rep_code, v_role
  FROM sales_representatives sr
  WHERE sr.auth_user_id = auth.uid()
    AND sr.is_active = true
    AND sr.login_enabled = true
  LIMIT 1;

  -- Get the match count to detect ambiguous profiles.
  SELECT count(*)
    INTO v_match_count
  FROM sales_representatives sr
  WHERE sr.auth_user_id = auth.uid()
    AND sr.is_active = true
    AND sr.login_enabled = true;

  -- Reject missing identity explicitly.
  -- The caller receives a PostgREST error, not zero counts.
  IF v_role IS NULL THEN
    RAISE EXCEPTION 'Dashboard metrics unavailable: no active, login-enabled sales representative profile for the authenticated user';
  END IF;

  -- Reject ambiguous profiles (more than one row matching).
  IF v_match_count > 1 THEN
    RAISE EXCEPTION 'Dashboard metrics unavailable: ambiguous sales representative profile for user %', auth.uid();
  END IF;

  -- Reject unsupported roles explicitly.
  IF v_role NOT IN ('admin', 'sales_rep') THEN
    RAISE EXCEPTION 'Dashboard metrics unavailable: unsupported role "%" for user %', v_role, auth.uid();
  END IF;

  -- Reject missing/blank rep_code for sales_rep.
  IF v_role = 'sales_rep' AND (v_rep_code IS NULL OR btrim(v_rep_code) = '') THEN
    RAISE EXCEPTION 'Dashboard metrics unavailable: sales_rep profile has no rep_code for user %', auth.uid();
  END IF;

  -- Determine the "today" boundary.
  -- When the frontend supplies p_today_iso (browser-local midnight as UTC),
  -- use it to preserve the original browser-local-day behavior.
  -- When NULL, fall back to the database server's CURRENT_DATE.
  IF p_today_iso IS NOT NULL THEN
    v_today_date := p_today_iso::timestamptz;
  ELSE
    v_today_date := CURRENT_DATE;
  END IF;

  -- Single aggregation query with conditional scope.
  -- For admins: no rep_code filter (all leads visible under RLS).
  -- For sales reps: explicit rep_code filter (defense-in-depth alongside RLS).
  --
  -- system_status and lead_status are uppercased before comparison to
  -- tolerate mixed-case values.
  -- lead_temperature is trimmed (btrim) before classification.
  RETURN QUERY
  SELECT
    count(*),
    count(*) FILTER (WHERE created_at >= v_today_date),
    count(*) FILTER (WHERE created_at >= now() - interval '7 days'),
    count(*) FILTER (WHERE created_at >= now() - interval '30 days'),
    count(*) FILTER (WHERE upper(system_status) = 'WHATSAPP_SENT'),
    count(*) FILTER (WHERE upper(system_status) = 'WHATSAPP_FAILED'),
    count(*) FILTER (WHERE upper(system_status) = 'INVALID_LEAD'),
    count(*) FILTER (WHERE upper(lead_status) = 'NEW'),
    count(*) FILTER (WHERE upper(lead_status) = 'CONTACTED'),
    count(*) FILTER (WHERE upper(lead_status) = 'QUALIFIED'),
    count(*) FILTER (WHERE upper(lead_status) = 'CONVERTED'),
    count(*) FILTER (WHERE upper(lead_status) = 'LOST'),
    count(*) FILTER (WHERE btrim(lead_temperature) = 'Hot'),
    count(*) FILTER (WHERE btrim(lead_temperature) = 'Warm'),
    count(*) FILTER (WHERE btrim(lead_temperature) = 'Cold'),
    count(*) FILTER (WHERE lead_temperature IS NULL OR btrim(lead_temperature) NOT IN ('Hot','Warm','Cold'))
  FROM lead_entries
  WHERE v_role = 'admin' OR sales_rep_code = v_rep_code;
END;
$$;

-- Restrict execution: revoke from PUBLIC and anon, grant to authenticated only.
REVOKE EXECUTE ON FUNCTION public.get_dashboard_metrics(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_dashboard_metrics(text) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_dashboard_metrics(text) TO authenticated;
