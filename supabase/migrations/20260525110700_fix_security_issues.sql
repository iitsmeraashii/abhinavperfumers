/*
  # Fix Security Issues

  ## Summary
  Addresses all security advisor findings:

  1. Security Definer Views — recreate all 10 views with SECURITY INVOKER so they
     run as the querying user and respect underlying table RLS, not the definer's role.

  2. RLS Policies Always True — replace open USING(true)/WITH CHECK(true) policies
     with authenticated-only checks. For tables without user ownership columns
     (events, lead_notes, message_templates, system_notifications, lead_follow_ups)
     we restrict to authenticated role only (no anon access).

  3. capture_sessions "temp allow insert" — drop the temporary open policy that
     was left behind during development. The proper authenticated policy already exists.

  4. lead_entries "Admin can update all leads" — drop the open USING(true) admin
     policy. The sales-rep-scoped policy using auth.uid() already handles updates.

  5. Function search_path — add SET search_path = public, pg_temp to
     set_lead_search_text trigger function to fix the mutable search_path warning.

  6. rls_auto_enable — revoke EXECUTE from anon and authenticated (event trigger
     function should not be callable via REST API).

  7. Storage bucket — restrict the template-images SELECT policy to authenticated
     users so anonymous clients cannot list all bucket objects.

  8. Leaked password protection — this is an Auth dashboard setting and cannot be
     set via SQL; noted for manual configuration in the Supabase dashboard.

  ## Important Notes
  - Views are recreated with SECURITY INVOKER (PostgreSQL 15+ feature).
  - my_rep_profile has a WHERE clause that already filters by auth.uid() so RLS
    on the underlying sales_representatives table is respected through the view.
  - Events, lead_notes, message_templates, system_notifications have no per-row
    ownership concept in the current schema — we restrict to authenticated role
    rather than adding per-row checks that don't match existing app logic.
*/

-- ─── 1. Recreate all views with SECURITY INVOKER ──────────────────────────────

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
  search_text
FROM lead_entries;

CREATE OR REPLACE VIEW public.event_lead_count
  WITH (security_invoker = true)
AS
SELECT e.event_code,
       e.name,
       count(l.id) AS lead_count
FROM events e
LEFT JOIN lead_entries l ON e.event_code = l.event_code
GROUP BY e.event_code, e.name;

CREATE OR REPLACE VIEW public.event_daily_trend_view
  WITH (security_invoker = true)
AS
SELECT event_code,
       date(created_at) AS lead_date,
       count(*) AS lead_count
FROM lead_entries
GROUP BY event_code, date(created_at)
ORDER BY date(created_at);

CREATE OR REPLACE VIEW public.event_list_view
  WITH (security_invoker = true)
AS
SELECT e.id,
       e.event_code,
       e.name,
       e.location,
       e.start_date,
       e.end_date,
       e.status,
       count(l.id) AS lead_count
FROM events e
LEFT JOIN lead_entries l ON e.event_code = l.event_code
GROUP BY e.id, e.event_code, e.name, e.location, e.start_date, e.end_date, e.status;

CREATE OR REPLACE VIEW public.funnel_summary
  WITH (security_invoker = true)
AS
SELECT
  count(*) FILTER (WHERE lead_status = 'NEW')       AS new_leads,
  count(*) FILTER (WHERE lead_status = 'CONTACTED') AS contacted,
  count(*) FILTER (WHERE lead_status = 'QUALIFIED') AS qualified,
  count(*) FILTER (WHERE lead_status = 'CONVERTED') AS converted,
  count(*) FILTER (WHERE lead_status = 'LOST')      AS lost
FROM lead_entries;

CREATE OR REPLACE VIEW public.dashboard_summary
  WITH (security_invoker = true)
AS
SELECT
  count(*) AS total_leads,
  count(*) FILTER (WHERE created_at >= CURRENT_DATE) AS leads_today,
  count(*) FILTER (WHERE created_at >= CURRENT_DATE - interval '7 days') AS leads_last_7_days,
  count(*) FILTER (WHERE created_at >= CURRENT_DATE - interval '30 days') AS leads_last_30_days,
  count(*) FILTER (WHERE system_status = 'WHATSAPP_SENT') AS whatsapp_sent,
  count(*) FILTER (WHERE system_status = 'WHATSAPP_FAILED') AS whatsapp_failed,
  count(*) FILTER (WHERE system_status = 'INVALID_LEAD') AS invalid_leads,
  count(*) FILTER (WHERE lead_status = 'CONTACTED') AS contacted_leads,
  count(*) FILTER (WHERE lead_status = 'CONVERTED') AS converted_leads,
  count(*) FILTER (WHERE lead_status = 'LOST') AS lost_leads
FROM lead_entries;

CREATE OR REPLACE VIEW public.event_metrics_view
  WITH (security_invoker = true)
AS
SELECT e.event_code,
       e.name,
       count(l.id) AS total_leads,
       count(*) FILTER (WHERE l.lead_status = 'CONTACTED') AS contacted_leads,
       count(*) FILTER (WHERE l.lead_status = 'CONVERTED') AS converted_leads,
       count(*) FILTER (WHERE l.lead_status = 'LOST')      AS lost_leads,
       count(*) FILTER (WHERE l.system_status = 'INVALID_LEAD') AS invalid_leads,
       count(*) FILTER (WHERE lower(l.lead_temperature) = 'hot')  AS hot_leads,
       count(*) FILTER (WHERE lower(l.lead_temperature) = 'warm') AS warm_leads,
       count(*) FILTER (WHERE lower(l.lead_temperature) = 'cold') AS cold_leads
FROM events e
LEFT JOIN lead_entries l ON e.event_code = l.event_code
GROUP BY e.event_code, e.name;

CREATE OR REPLACE VIEW public.event_state_distribution_view
  WITH (security_invoker = true)
AS
SELECT event_code,
       state,
       count(*) AS lead_count
FROM lead_entries
GROUP BY event_code, state;

CREATE OR REPLACE VIEW public.event_sales_performance_view
  WITH (security_invoker = true)
AS
SELECT l.event_code,
       l.sales_rep_code,
       sr.name AS sales_rep_name,
       count(*) AS total_leads,
       count(*) FILTER (WHERE l.lead_status = 'CONTACTED') AS contacted,
       count(*) FILTER (WHERE l.lead_status = 'CONVERTED') AS converted,
       count(*) FILTER (WHERE l.lead_status = 'LOST')      AS lost
FROM lead_entries l
LEFT JOIN sales_representatives sr ON l.sales_rep_code = sr.rep_code
GROUP BY l.event_code, l.sales_rep_code, sr.name;

-- my_rep_profile uses auth.uid() in WHERE — keep that logic, add SECURITY INVOKER
CREATE OR REPLACE VIEW public.my_rep_profile
  WITH (security_invoker = true)
AS
SELECT id, rep_code, name, email, role, login_enabled, is_active, auth_user_id
FROM sales_representatives
WHERE auth_user_id = auth.uid();

-- Restore grants for views (SECURITY INVOKER views still need explicit grants)
GRANT SELECT ON public.leads_list_view             TO authenticated;
GRANT SELECT ON public.event_lead_count            TO authenticated;
GRANT SELECT ON public.event_daily_trend_view      TO authenticated;
GRANT SELECT ON public.event_list_view             TO authenticated;
GRANT SELECT ON public.funnel_summary              TO authenticated;
GRANT SELECT ON public.dashboard_summary           TO authenticated;
GRANT SELECT ON public.event_metrics_view          TO authenticated;
GRANT SELECT ON public.event_state_distribution_view TO authenticated;
GRANT SELECT ON public.event_sales_performance_view  TO authenticated;
GRANT SELECT ON public.my_rep_profile              TO authenticated;

-- Remove anon access from all views
REVOKE ALL ON public.leads_list_view             FROM anon;
REVOKE ALL ON public.event_lead_count            FROM anon;
REVOKE ALL ON public.event_daily_trend_view      FROM anon;
REVOKE ALL ON public.event_list_view             FROM anon;
REVOKE ALL ON public.funnel_summary              FROM anon;
REVOKE ALL ON public.dashboard_summary           FROM anon;
REVOKE ALL ON public.event_metrics_view          FROM anon;
REVOKE ALL ON public.event_state_distribution_view FROM anon;
REVOKE ALL ON public.event_sales_performance_view  FROM anon;
REVOKE ALL ON public.my_rep_profile              FROM anon;

-- ─── 2. Fix set_lead_search_text search_path ──────────────────────────────────

CREATE OR REPLACE FUNCTION public.set_lead_search_text()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
BEGIN
  NEW.search_text := lower(
    coalesce(NEW.client_name, '') || ' ' ||
    coalesce(NEW.company, '') || ' ' ||
    coalesce(array_to_string(NEW.phones, ' '), '') || ' ' ||
    coalesce(array_to_string(NEW.emails, ' '), '') || ' ' ||
    coalesce(NEW.event_code, '')
  );
  RETURN NEW;
END;
$$;

-- ─── 3. Revoke public execute on rls_auto_enable ─────────────────────────────
-- This is an event trigger function — it should never be callable via REST API

REVOKE EXECUTE ON FUNCTION public.rls_auto_enable() FROM anon;
REVOKE EXECUTE ON FUNCTION public.rls_auto_enable() FROM authenticated;

-- ─── 4. Fix capture_sessions: drop the temporary open INSERT policy ───────────

DROP POLICY IF EXISTS "temp allow insert" ON public.capture_sessions;

-- ─── 5. Fix events RLS: restrict to authenticated users ──────────────────────

DROP POLICY IF EXISTS "events_delete_all" ON public.events;
DROP POLICY IF EXISTS "events_insert_all" ON public.events;
DROP POLICY IF EXISTS "events_update_all" ON public.events;

CREATE POLICY "events_delete_authenticated"
  ON public.events
  FOR DELETE
  TO authenticated
  USING (true);

CREATE POLICY "events_insert_authenticated"
  ON public.events
  FOR INSERT
  TO authenticated
  WITH CHECK (true);

CREATE POLICY "events_update_authenticated"
  ON public.events
  FOR UPDATE
  TO authenticated
  USING (true)
  WITH CHECK (true);

-- ─── 6. Fix lead_entries: drop open admin-all-update policy ──────────────────
-- The app uses current_setting('app.current_user') for legacy scoping plus
-- the new auth.uid()-based capture policies. The open USING(true) admin policy
-- is unnecessary and dangerous.

DROP POLICY IF EXISTS "Admin can update all leads" ON public.lead_entries;

-- ─── 7. Fix lead_follow_ups: restrict to authenticated ───────────────────────

DROP POLICY IF EXISTS "follow_ups_insert" ON public.lead_follow_ups;
DROP POLICY IF EXISTS "follow_ups_update" ON public.lead_follow_ups;
DROP POLICY IF EXISTS "follow_ups_select" ON public.lead_follow_ups;

CREATE POLICY "follow_ups_select"
  ON public.lead_follow_ups
  FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "follow_ups_insert"
  ON public.lead_follow_ups
  FOR INSERT
  TO authenticated
  WITH CHECK (true);

CREATE POLICY "follow_ups_update"
  ON public.lead_follow_ups
  FOR UPDATE
  TO authenticated
  USING (true)
  WITH CHECK (true);

-- ─── 8. Fix lead_notes: restrict to authenticated ────────────────────────────

DROP POLICY IF EXISTS "notes_insert" ON public.lead_notes;
DROP POLICY IF EXISTS "notes_select" ON public.lead_notes;

CREATE POLICY "notes_select"
  ON public.lead_notes
  FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "notes_insert"
  ON public.lead_notes
  FOR INSERT
  TO authenticated
  WITH CHECK (true);

-- ─── 9. Fix message_templates: restrict to authenticated ─────────────────────

DROP POLICY IF EXISTS "template_delete" ON public.message_templates;
DROP POLICY IF EXISTS "template_insert" ON public.message_templates;
DROP POLICY IF EXISTS "template_update" ON public.message_templates;
DROP POLICY IF EXISTS "template_select" ON public.message_templates;

CREATE POLICY "template_select"
  ON public.message_templates
  FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "template_insert"
  ON public.message_templates
  FOR INSERT
  TO authenticated
  WITH CHECK (true);

CREATE POLICY "template_update"
  ON public.message_templates
  FOR UPDATE
  TO authenticated
  USING (true)
  WITH CHECK (true);

CREATE POLICY "template_delete"
  ON public.message_templates
  FOR DELETE
  TO authenticated
  USING (true);

-- ─── 10. Fix system_notifications: split ALL policy, restrict to authenticated ─

DROP POLICY IF EXISTS "notifications_all" ON public.system_notifications;

CREATE POLICY "notifications_select"
  ON public.system_notifications
  FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "notifications_insert"
  ON public.system_notifications
  FOR INSERT
  TO authenticated
  WITH CHECK (true);

CREATE POLICY "notifications_update"
  ON public.system_notifications
  FOR UPDATE
  TO authenticated
  USING (true)
  WITH CHECK (true);

CREATE POLICY "notifications_delete"
  ON public.system_notifications
  FOR DELETE
  TO authenticated
  USING (true);

-- ─── 11. Fix storage: restrict template-images SELECT to authenticated ────────
-- Drop the broad public SELECT policy and replace with authenticated-only.
-- Public bucket URLs still work for direct object access — this only prevents
-- anonymous clients from listing all files in the bucket.

DROP POLICY IF EXISTS "Public read template images" ON storage.objects;

CREATE POLICY "Authenticated read template images"
  ON storage.objects
  FOR SELECT
  TO authenticated
  USING (bucket_id = 'template-images');
