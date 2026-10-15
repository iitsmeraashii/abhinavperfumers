-- UNEXECUTED. Apply separately in Supabase SQL Editor.
-- Additive, read-only aggregate. No existing RPC, data, RLS or workflow changes.
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '10s';
SET LOCAL idle_in_transaction_session_timeout = '30s';
CREATE OR REPLACE FUNCTION public.get_dashboard_whatsapp_status_counts()
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
  WHERE v_role = 'admin' OR l.sales_rep_code = v_rep_code;
  RETURN v_result;
END;
$function$;
REVOKE ALL ON FUNCTION public.get_dashboard_whatsapp_status_counts() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_dashboard_whatsapp_status_counts() TO authenticated;
COMMIT;
