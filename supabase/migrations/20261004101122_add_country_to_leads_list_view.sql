/*
# Add country column to leads_list_view

1. Modified Views
- `leads_list_view`: adds `country` (text) column, sourced from `lead_entries.country`
2. Security
- No RLS changes — the view retains SECURITY INVOKER and existing grants.
3. Important Notes
- `lead_entries.country` already exists (added by migration 20260925212402).
- No data migration, no backfill.
- Existing columns and their order are preserved; `country` is appended.
*/

DROP VIEW IF EXISTS leads_list_view;

CREATE VIEW public.leads_list_view
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
  country
FROM lead_entries;

GRANT SELECT ON public.leads_list_view TO authenticated;
REVOKE ALL ON public.leads_list_view FROM anon;
