/*
# Add review.minimumConfidence to runtime_configuration

1. Purpose
   - Makes the extraction-confidence review threshold configurable at runtime
     instead of hardcoded in the frontend.
   - The value is a percentage on the existing 0–100 scale (e.g. 50 = require
     review when AI extraction confidence is below 50%).
   - Read by RuntimeConfiguration (in-memory cache); never queried per-lead.

2. Schema change
   - ALTER TABLE runtime_configuration
     ADD COLUMN review_minimum_confidence int2 NOT NULL DEFAULT 50
   - The default (50) preserves the current effective threshold so existing
     review behavior is unchanged.

3. Security
   - No new policies needed — the existing SELECT/UPDATE policies on
     runtime_configuration already cover the new column.
*/

ALTER TABLE runtime_configuration
  ADD COLUMN IF NOT EXISTS review_minimum_confidence int2 NOT NULL DEFAULT 50;
