/*
# Add country column to lead_entries

1. New Columns
- `lead_entries.country` (text, nullable, no default)
  Stores the lead-level country value. No value is derived or inferred
  in this migration — the column starts empty for all existing rows.

2. No changes to existing columns, constraints, indexes, defaults, or policies.
3. No backfill — existing records keep NULL.
*/

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'lead_entries' AND column_name = 'country'
  ) THEN
    ALTER TABLE lead_entries ADD COLUMN country text;
  END IF;
END $$;
