-- Add review audit fields to lead_entries.
-- reviewed_by: rep_code of the rep who verified the lead.
-- reviewed_at: timestamp when the verification happened.
-- Both are nullable — only populated when a REQUIRES_REVIEW lead is explicitly verified.

ALTER TABLE lead_entries
  ADD COLUMN IF NOT EXISTS reviewed_by  text,
  ADD COLUMN IF NOT EXISTS reviewed_at  timestamptz;
