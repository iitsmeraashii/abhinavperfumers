-- UNEXECUTED — review and apply manually in Supabase SQL Editor.
-- Additive endpoint; existing event views and all data/writing workflows remain unchanged.
-- Admin-only, SECURITY INVOKER: RLS still applies. No client-provided owner scope.
-- All-time, current event association. Cumulative stages use the approved progression assumption.
-- Geography preserves raw values; only NULL/empty are merged, matching Leads filtering.
-- Grouped outputs are bounded: 100 geographic/rep rows and 90 most recent capture days (UTC).
-- No index changes: inspect production indexes/query plans before adding indexes.
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '15s';
SET LOCAL idle_in_transaction_session_timeout = '30s';
CREATE OR REPLACE FUNCTION public.get_event_overview(p_event_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_matches bigint;
  v_role text;
  v_event_code text;
  v_template_configured boolean;
  v_result jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;
  SELECT count(*), min(sr.role) INTO v_matches, v_role
  FROM public.sales_representatives sr
  WHERE sr.auth_user_id = auth.uid() AND sr.is_active = true AND sr.login_enabled = true;
  IF v_matches <> 1 OR v_role IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'Active admin profile required' USING ERRCODE = '42501';
  END IF;
  SELECT e.event_code,
         NULLIF(btrim(e.whatsapp_template_id::text), '') IS NOT NULL
         AND NULLIF(btrim(e.whatsapp_template_name), '') IS NOT NULL
  INTO v_event_code, v_template_configured
  FROM public.events e WHERE e.id = p_event_id;
  IF NOT FOUND OR v_event_code IS NULL THEN
    RAISE EXCEPTION 'Event unavailable' USING ERRCODE = 'P0002';
  END IF;

  WITH scoped AS MATERIALIZED (
    SELECT l.lead_status, l.system_status, l.whatsapp_status, l.lead_temperature,
           l.country, l.state, l.sales_rep_code, l.created_at
    FROM public.lead_entries l WHERE l.event_code = v_event_code
  ), metrics AS (
    SELECT count(*) AS total,
      count(*) FILTER (WHERE lead_status = 'CONTACTED') AS contacted,
      count(*) FILTER (WHERE lead_status = 'QUALIFIED') AS samples,
      count(*) FILTER (WHERE lead_status = 'CONVERTED') AS converted,
      count(*) FILTER (WHERE lead_status = 'LOST') AS lost,
      count(*) FILTER (WHERE system_status = 'INVALID_LEAD') AS invalid,
      count(*) FILTER (WHERE lead_status = 'REQUIRES_REVIEW') AS review,
      count(*) FILTER (WHERE whatsapp_status IN ('READ', 'DELIVERED')) AS connected,
      count(*) FILTER (WHERE lead_status IN ('CONTACTED', 'QUALIFIED', 'CONVERTED', 'LOST')) AS engaged,
      count(*) FILTER (WHERE lead_status IN ('QUALIFIED', 'CONVERTED', 'LOST')) AS sampled,
      count(*) FILTER (WHERE lead_temperature = 'Hot') AS hot,
      count(*) FILTER (WHERE lead_temperature = 'Warm') AS warm,
      count(*) FILTER (WHERE lead_temperature = 'Cold') AS cold,
      count(*) FILTER (WHERE lead_temperature IS NULL OR lead_temperature = '') AS unassigned,
      count(*) FILTER (WHERE lead_temperature IS NOT NULL AND lead_temperature NOT IN ('', 'Hot', 'Warm', 'Cold')) AS other_temperature
    FROM scoped
  ), country_groups AS (
    SELECT NULLIF(country, '') AS value, count(*) AS count FROM scoped GROUP BY NULLIF(country, '')
  ), state_groups AS (
    SELECT NULLIF(state, '') AS value, count(*) AS count FROM scoped GROUP BY NULLIF(state, '')
  ), rep_groups AS (
    SELECT NULLIF(sales_rep_code, '') AS code, count(*) AS total,
      count(*) FILTER (WHERE lead_status = 'CONTACTED') AS contacted,
      count(*) FILTER (WHERE lead_status = 'QUALIFIED') AS samples,
      count(*) FILTER (WHERE lead_status = 'CONVERTED') AS converted,
      count(*) FILTER (WHERE lead_status = 'LOST') AS lost
    FROM scoped GROUP BY NULLIF(sales_rep_code, '')
  ), day_groups AS (
    -- created_at is the existing timestamp-without-time-zone UTC value.
    SELECT created_at::date::text AS day, count(*) AS count
    FROM scoped WHERE created_at IS NOT NULL GROUP BY created_at::date
  )
  SELECT jsonb_build_object(
    'eventId', p_event_id, 'eventCode', v_event_code,
    'templateConfigured', v_template_configured,
    'metrics', (SELECT to_jsonb(m) FROM metrics m),
    'countries', COALESCE((SELECT jsonb_agg(to_jsonb(g) ORDER BY g.count DESC, g.value NULLS LAST)
      FROM (SELECT * FROM country_groups ORDER BY count DESC, value NULLS LAST LIMIT 100) g), '[]'::jsonb),
    'countriesMore', (SELECT count(*) > 100 FROM country_groups),
    'states', COALESCE((SELECT jsonb_agg(to_jsonb(g) ORDER BY g.count DESC, g.value NULLS LAST)
      FROM (SELECT * FROM state_groups ORDER BY count DESC, value NULLS LAST LIMIT 100) g), '[]'::jsonb),
    'statesMore', (SELECT count(*) > 100 FROM state_groups),
    'reps', COALESCE((SELECT jsonb_agg(to_jsonb(g) ORDER BY g.total DESC, g.code NULLS LAST)
      FROM (SELECT r.*, (SELECT min(sr.name) FROM public.sales_representatives sr WHERE sr.rep_code = r.code) AS name
        FROM rep_groups r ORDER BY r.total DESC, r.code NULLS LAST LIMIT 100) g), '[]'::jsonb),
    'repsMore', (SELECT count(*) > 100 FROM rep_groups),
    'days', COALESCE((SELECT jsonb_agg(to_jsonb(g) ORDER BY g.day)
      FROM (SELECT * FROM day_groups ORDER BY day DESC LIMIT 90) g), '[]'::jsonb),
    'daysMore', (SELECT count(*) > 90 FROM day_groups)
  ) INTO v_result;
  RETURN v_result;
END;
$function$;
REVOKE ALL ON FUNCTION public.get_event_overview(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_event_overview(uuid) TO authenticated;
COMMIT;
