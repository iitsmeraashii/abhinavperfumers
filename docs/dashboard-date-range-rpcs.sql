-- UNEXECUTED: apply this complete file in Supabase SQL Editor.
-- Adds ranged endpoints; existing get_dashboard_metrics(text) and
-- get_dashboard_whatsapp_status_counts() remain unchanged.
-- Bounds are browser-local calendar midnights sent as UTC instants.
-- lead_entries.created_at is timestamp WITHOUT time zone storing UTC;
-- explicit UTC conversion matches the Leads API's ISO-Z date filtering.
-- No data, table, index, policy, capture or sending-workflow changes.
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '10s';
SET LOCAL idle_in_transaction_session_timeout = '30s';

CREATE OR REPLACE FUNCTION public.get_dashboard_metrics_range(p_from timestamptz, p_before timestamptz)
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
LANGUAGE plpgsql STABLE SECURITY INVOKER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_role text;
  v_rep_code text;
  v_matches bigint;
BEGIN
  IF p_from IS NULL OR p_before IS NULL OR p_before <= p_from
     OR p_before - p_from > interval '92 days' THEN
    RAISE EXCEPTION 'Invalid analytics date range' USING ERRCODE = '22023';
  END IF;
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;
  SELECT count(*), min(sr.role), min(sr.rep_code)
    INTO v_matches, v_role, v_rep_code
  FROM public.sales_representatives sr
  WHERE sr.auth_user_id = auth.uid()
    AND sr.is_active = true AND sr.login_enabled = true;
  IF v_matches <> 1 OR v_role IS NULL OR v_role NOT IN ('admin', 'sales_rep') THEN
    RAISE EXCEPTION 'Eligible profile required' USING ERRCODE = '42501';
  END IF;
  IF v_role = 'sales_rep' AND (v_rep_code IS NULL OR btrim(v_rep_code) = '') THEN
    RAISE EXCEPTION 'Assigned rep code required' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT
    count(*),
    -- Reserved legacy response fields, unused by ranged analytics.
    -- Do not present these as measured time-window or delivery counts.
    0::bigint, -- leads_today
    0::bigint, -- leads_last_7_days
    0::bigint, -- leads_last_30_days
    0::bigint, -- whatsapp_sent (obsolete system_status metric)
    0::bigint, -- whatsapp_failed (obsolete system_status metric)
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
  WHERE (v_role = 'admin' OR sales_rep_code = v_rep_code)
    AND created_at >= (p_from AT TIME ZONE 'UTC')
    AND created_at < (p_before AT TIME ZONE 'UTC');
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_dashboard_whatsapp_status_counts_range(p_from timestamptz, p_before timestamptz)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_role text;
  v_rep_code text;
  v_matches bigint;
  v_result jsonb;
BEGIN
  IF p_from IS NULL OR p_before IS NULL OR p_before <= p_from
     OR p_before - p_from > interval '92 days' THEN
    RAISE EXCEPTION 'Invalid analytics date range' USING ERRCODE = '22023';
  END IF;
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;
  SELECT count(*), min(sr.role), min(sr.rep_code)
    INTO v_matches, v_role, v_rep_code
  FROM public.sales_representatives sr
  WHERE sr.auth_user_id = auth.uid()
    AND sr.is_active = true AND sr.login_enabled = true;
  IF v_matches <> 1 OR v_role IS NULL OR v_role NOT IN ('admin', 'sales_rep') THEN
    RAISE EXCEPTION 'Eligible profile required' USING ERRCODE = '42501';
  END IF;
  IF v_role = 'sales_rep' AND (v_rep_code IS NULL OR btrim(v_rep_code) = '') THEN
    RAISE EXCEPTION 'Assigned rep code required' USING ERRCODE = '42501';
  END IF;
  SELECT jsonb_build_object(
    'READ', count(*) FILTER (WHERE l.whatsapp_status = 'READ'),
    'DELIVERED', count(*) FILTER (WHERE l.whatsapp_status = 'DELIVERED'),
    'SENT', count(*) FILTER (WHERE l.whatsapp_status = 'SENT'),
    'ACCEPTED', count(*) FILTER (WHERE l.whatsapp_status = 'ACCEPTED'),
    'processing', count(*) FILTER (WHERE l.whatsapp_status = 'processing'),
    'RETRY', count(*) FILTER (WHERE l.whatsapp_status = 'RETRY'),
    'FAILED', count(*) FILTER (WHERE l.whatsapp_status = 'FAILED'),
    '__not_set__', count(*) FILTER (WHERE l.whatsapp_status IS NULL)
  ) INTO v_result
  FROM public.lead_entries l
  WHERE (v_role = 'admin' OR l.sales_rep_code = v_rep_code)
    AND l.created_at >= (p_from AT TIME ZONE 'UTC')
    AND l.created_at < (p_before AT TIME ZONE 'UTC');
  RETURN v_result;
END;
$function$;
REVOKE ALL ON FUNCTION public.get_dashboard_metrics_range(timestamptz, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_dashboard_metrics_range(timestamptz, timestamptz) TO authenticated;
REVOKE ALL ON FUNCTION public.get_dashboard_whatsapp_status_counts_range(timestamptz, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_dashboard_whatsapp_status_counts_range(timestamptz, timestamptz) TO authenticated;
COMMIT;
