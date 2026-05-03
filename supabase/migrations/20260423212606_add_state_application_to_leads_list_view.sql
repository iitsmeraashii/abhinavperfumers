/*
  # Add state and application columns to leads_list_view

  ## Changes
  - Drops and recreates `leads_list_view` to include `state` and `application`
    columns from `lead_entries`, needed for advanced filtering on the Leads Page.

  ## Modified Views
  - `leads_list_view`: adds `state` (text) and `application` (text)

  ## Notes
  - DROP + CREATE required because PostgreSQL does not allow inserting columns
    in the middle of an existing view definition via CREATE OR REPLACE.
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
  created_at,
  search_text
FROM lead_entries;
