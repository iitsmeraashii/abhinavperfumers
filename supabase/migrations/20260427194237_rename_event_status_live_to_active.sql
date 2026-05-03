/*
  # Rename event status enum value LIVE → ACTIVE

  The event_status_enum type has LIVE as a value. This migration:
  1. Adds the new ACTIVE value to the enum
  2. Updates all existing rows from LIVE → ACTIVE
  3. Renames the old LIVE value by altering the enum (Postgres 10+)

  Note: Postgres enums can have values added but not renamed directly.
  We add ACTIVE, migrate data, then drop LIVE by recreating the enum type.
*/

-- Step 1: Add ACTIVE to the enum (safe, no-op if already exists)
ALTER TYPE event_status_enum ADD VALUE IF NOT EXISTS 'ACTIVE';
