/*
  # Drop foreign key on lead_follow_ups.created_by

  created_by stores a rep_code (text) but was auto-constrained
  to sales_representatives, blocking inserts for any rep_code
  not present in that table. Remove the constraint.
*/

ALTER TABLE lead_follow_ups DROP CONSTRAINT IF EXISTS lead_follow_ups_created_by_fkey;
