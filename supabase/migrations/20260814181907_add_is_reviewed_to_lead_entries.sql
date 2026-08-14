/*
# Add is_reviewed column to lead_entries

## Summary
Adds a boolean `is_reviewed` column to `lead_entries` to track whether a
REQUIRES_REVIEW lead has been manually verified by a sales rep. This
complements the existing `reviewed_by` and `reviewed_at` columns (which
track WHO reviewed it and WHEN), with a simple boolean flag for easy
filtering and UI conditionals.

## Schema change
- `lead_entries.is_reviewed` — boolean, NOT NULL, DEFAULT false.
  Existing rows default to false (they were never reviewed).

## Security
No RLS changes — the existing UPDATE policies on `lead_entries` already
allow reps to update their own leads and admins to update all leads.
The new column inherits the table's RLS.
*/

ALTER TABLE lead_entries
  ADD COLUMN IF NOT EXISTS is_reviewed boolean NOT NULL DEFAULT false;
