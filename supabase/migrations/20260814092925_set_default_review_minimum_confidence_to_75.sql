/*
# Set default review.minimumConfidence to 75

1. Purpose
   - Updates the seeded default value of review_minimum_confidence from 50
     (the original backward-compatible placeholder) to 75, the new policy
     threshold.
   - Existing rows are updated so the change takes effect immediately.

2. Schema change
   - ALTER COLUMN default changed from 50 to 75.
   - UPDATE existing singleton row to 75 (only if still at the old default).

3. Security
   - No policy changes.
*/

ALTER TABLE runtime_configuration
  ALTER COLUMN review_minimum_confidence SET DEFAULT 75;

UPDATE runtime_configuration
  SET review_minimum_confidence = 75
  WHERE id = 1 AND review_minimum_confidence = 50;
