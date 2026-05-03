/*
  # Fix search_text column on lead_entries

  The search_text column exists but is null for all rows because the trigger
  that was supposed to populate it is missing.

  This migration:
  1. Creates a trigger function that builds search_text from client_name,
     company, phones, emails, and event_code
  2. Creates the trigger on lead_entries for INSERT and UPDATE
  3. Backfills all existing rows
*/

-- Trigger function
CREATE OR REPLACE FUNCTION set_lead_search_text()
RETURNS trigger AS $$
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
$$ LANGUAGE plpgsql;

-- Trigger
DROP TRIGGER IF EXISTS trg_lead_search_text ON lead_entries;
CREATE TRIGGER trg_lead_search_text
  BEFORE INSERT OR UPDATE ON lead_entries
  FOR EACH ROW EXECUTE FUNCTION set_lead_search_text();

-- Backfill existing rows
UPDATE lead_entries
SET search_text = lower(
  coalesce(client_name, '') || ' ' ||
  coalesce(company, '') || ' ' ||
  coalesce(array_to_string(phones, ' '), '') || ' ' ||
  coalesce(array_to_string(emails, ' '), '') || ' ' ||
  coalesce(event_code, '')
);
