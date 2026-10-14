-- Migration: 20261014120000_create_dashboard_metrics_rpc.sql
-- Status: PREPARED but NOT APPLIED (Supabase MCP apply_migration denied permission)
--
-- This file contains the full SQL for review. Once the MCP permission
-- issue is resolved, apply via mcp__supabase__apply_migration with
-- filename "20261014120000_create_dashboard_metrics_rpc".

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
2. Admins: aggregates all lead_entries.
3. Sales reps: aggregates only lead_entries where sales_rep_code
   matches their own rep_code.
4. Missing identity, unsupported role, or inactive rep: raises an
   explicit exception so the caller receives a clear error rather
   than zero counts masquerading as a successful result.
5. Returns a single row with 16 count columns matching the existing
   DashboardData interface.

## Security
- SECURITY INVOKER: runs as the calling user, so existing RLS on
  lead_entries and sales_representatives is fully preserved. The
  function cannot bypass RLS.
- EXECUTE revoked from PUBLIC and anon; granted to authenticated only.
- No tables modified, no policies changed, no indexes added.
- Role/rep_code derived server-side from auth.uid() — the frontend
  cannot inject a different scope.

## Today's boundary — browser-local-day preservation
The original client-side code computed `todayStart` in the browser:
  new Date(year, month, day).toISOString()
which is midnight in the browser's local timezone, converted to UTC.
For example, if the browser is in IST (UTC+5:30), "today" starts at
18:30 UTC of the previous day.

The RPC uses `CURRENT_DATE` which is midnight in the database server's
timezone. The Supabase database is configured in UTC, so CURRENT_DATE
is midnight UTC. This means "today" in the RPC starts at midnight UTC,
not midnight browser-local.

To preserve the original browser-local-day behavior exactly, the
frontend passes a `p_today_iso` parameter — an ISO 8601 timestamp
representing midnight in the browser's local timezone, converted to
UTC (exactly what the old client-side code computed). The RPC compares
created_at >= p_today_iso::timestamptz instead of using CURRENT_DATE.

The 7-day and 30-day boundaries are relative to now (not to midnight),
so they are computed as `now() - interval '7 days'` and
`now() - interval '30 days'` in the database, matching the old
client-side `Date.getTime() - N * 24 * 60 * 60 * 1000` computation.

## Important notes
1. The function reads sales_representatives directly. Because it is
   SECURITY INVOKER, the RLS policy "Auth users can read own rep row"
   ensures the caller can only see their own profile row. An admin
   also only sees their own row (role='admin'), which is sufficient
   to determine that they should get unscoped counts.
2. The lead_entries aggregation runs under the caller's RLS policies,
   so a sales rep automatically only sees their own leads even before
   the explicit rep_code filter. The explicit filter is defense-in-depth.
3. The function accepts a single optional parameter p_today_iso (text,
   default NULL). When NULL, falls back to CURRENT_DATE for backward
   compatibility. When provided (normal case), uses the browser-local
   midnight boundary.
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
BEGIN
  -- Derive role and rep_code from the authoritative profile.
  -- RLS on sales_representatives ensures only the caller's own row is visible.
  SELECT sr.rep_code, sr.role
    INTO v_rep_code, v_role
  FROM sales_representatives sr
  WHERE sr.auth_user_id = auth.uid()
    AND sr.is_active = true
  LIMIT 1;

  -- Reject missing or unsupported identity explicitly.
  -- The caller receives a PostgREST error, not zero counts.
  IF v_role IS NULL THEN
    RAISE EXCEPTION 'Dashboard metrics unavailable: no active sales representative profile for the authenticated user';
  END IF;

  IF v_role NOT IN ('admin', 'sales_rep') THEN
    RAISE EXCEPTION 'Dashboard metrics unavailable: unsupported role "%" for user %', v_role, auth.uid();
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
  RETURN QUERY
  SELECT
    count(*),
    count(*) FILTER (WHERE created_at >= v_today_date),
    count(*) FILTER (WHERE created_at >= now() - interval '7 days'),
    count(*) FILTER (WHERE created_at >= now() - interval '30 days'),
    count(*) FILTER (WHERE system_status = 'WHATSAPP_SENT'),
    count(*) FILTER (WHERE system_status = 'WHATSAPP_FAILED'),
    count(*) FILTER (WHERE system_status = 'INVALID_LEAD'),
    count(*) FILTER (WHERE lead_status = 'NEW'),
    count(*) FILTER (WHERE lead_status = 'CONTACTED'),
    count(*) FILTER (WHERE lead_status = 'QUALIFIED'),
    count(*) FILTER (WHERE lead_status = 'CONVERTED'),
    count(*) FILTER (WHERE lead_status = 'LOST'),
    count(*) FILTER (WHERE lead_temperature = 'Hot'),
    count(*) FILTER (WHERE lead_temperature = 'Warm'),
    count(*) FILTER (WHERE lead_temperature = 'Cold'),
    count(*) FILTER (WHERE lead_temperature IS NULL OR lead_temperature NOT IN ('Hot','Warm','Cold'))
  FROM lead_entries
  WHERE v_role = 'admin' OR sales_rep_code = v_rep_code;
END;
$$;

-- Restrict execution: revoke from PUBLIC and anon, grant to authenticated only.
REVOKE EXECUTE ON FUNCTION public.get_dashboard_metrics(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_dashboard_metrics(text) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_dashboard_metrics(text) TO authenticated;
