/*
  # Add index on lead_notes.lead_id

  lead_notes is queried by lead_id on every lead detail page load.
  Without an index this becomes a full table scan as notes grow.
*/

CREATE INDEX IF NOT EXISTS idx_lead_notes_lead_id ON lead_notes (lead_id);
