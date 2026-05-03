/*
  # Add updated_at to lead_follow_ups

  The markComplete update was failing because updated_at column was missing.
*/

ALTER TABLE lead_follow_ups ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();
