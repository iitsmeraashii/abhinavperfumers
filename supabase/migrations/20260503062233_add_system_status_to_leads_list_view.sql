/*
  # Add system_status to leads_list_view

  Drops and recreates leads_list_view to include the system_status column
  so the frontend can apply row-level color coding based on WhatsApp
  delivery state (CREATED, WHATSAPP_SENT, WHATSAPP_FAILED, INVALID_LEAD).
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
  system_status,
  created_at,
  search_text
FROM lead_entries;
