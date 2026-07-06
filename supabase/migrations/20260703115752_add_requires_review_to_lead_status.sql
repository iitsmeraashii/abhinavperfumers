-- Extend lead_status allowed values to include REQUIRES_REVIEW.
-- Leads with low Vision extraction confidence are initially set to this status
-- by the Promotion Stage when the Review Stage requires review.

ALTER TABLE lead_entries
  DROP CONSTRAINT IF EXISTS lead_status_check;

ALTER TABLE lead_entries
  ADD CONSTRAINT lead_status_check
  CHECK (lead_status = ANY (ARRAY[
    'NEW'::text,
    'CONTACTED'::text,
    'QUALIFIED'::text,
    'CONVERTED'::text,
    'LOST'::text,
    'REQUIRES_REVIEW'::text
  ]));
