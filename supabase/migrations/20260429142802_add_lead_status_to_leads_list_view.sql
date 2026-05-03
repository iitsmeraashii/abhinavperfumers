/*
  # Add lead_status to leads_list_view

  Drops and recreates the view to include lead_status from lead_entries.
*/

DROP VIEW IF EXISTS leads_list_view;

CREATE VIEW leads_list_view AS
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
  created_at,
  search_text
FROM lead_entries;
