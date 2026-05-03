/*
  # Fix event status check constraint and migrate NEW → DRAFT

  The event_status_check constraint lists allowed status values.
  This migration drops the old constraint, migrates NEW rows to DRAFT,
  and recreates the constraint with the correct value list:
  DRAFT, UPCOMING, ACTIVE, COMPLETED, ARCHIVED.
*/

-- Drop old constraint
ALTER TABLE events DROP CONSTRAINT IF EXISTS event_status_check;

-- Migrate NEW → DRAFT
UPDATE events SET status = 'DRAFT' WHERE status = 'NEW';

-- Recreate constraint with correct values
ALTER TABLE events
  ADD CONSTRAINT event_status_check
  CHECK (status::text IN ('DRAFT', 'UPCOMING', 'ACTIVE', 'COMPLETED', 'ARCHIVED'));
