/*
  # Add event_id FK to capture_sessions

  ## Summary
  Adds event_id column to capture_sessions so each captured lead can be linked
  to the event it was captured at.

  ## Changes
  - `event_id` (uuid, nullable FK to events.id) — the event during which this capture occurred
*/

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'capture_sessions' AND column_name = 'event_id'
  ) THEN
    ALTER TABLE capture_sessions
      ADD COLUMN event_id uuid REFERENCES events(id) ON DELETE SET NULL;
  END IF;
END $$;
