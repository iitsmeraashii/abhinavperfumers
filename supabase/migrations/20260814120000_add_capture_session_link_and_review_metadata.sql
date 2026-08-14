/*
  # Link lead_entries to capture_sessions + persist review/extraction metadata

  ## Summary
  Three changes that together make the ALPE processing pipeline reliably link
  a promoted lead back to its capture session and preserve the extraction +
  review decision data on the capture session row.

  1. lead_entries.capture_session_id
     New nullable FK column referencing capture_sessions.id.
     Populated at promotion time so every promoted lead is traceable to its
     source capture session. Nullable because existing lead_entries rows
     predate this column.

  2. capture_sessions.extraction_metadata
     New jsonb column (default '{}') that stores the full extraction metadata
     object: source, confidence, fieldConfidence, fieldStatus, and extracted
     fields. This is the authoritative home for field-level extraction data
     and is written by the ALPE extraction-metadata persistence step.

  3. capture_sessions.review_metadata
     New jsonb column (default '{}') that stores the final review decision
     produced by the review engine: required, reason, reasons,
     fieldConfidenceViolations, fieldStatusViolations, and contactViolations.
     Written once during the pipeline's review stage, never reconstructed.

  ## Security
  No RLS changes — both tables already have RLS enabled with existing
  ownership-scoped policies. The new columns inherit the table's RLS.
*/

-- 1. lead_entries.capture_session_id
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'lead_entries' AND column_name = 'capture_session_id'
  ) THEN
    ALTER TABLE lead_entries
      ADD COLUMN capture_session_id uuid REFERENCES capture_sessions(id) ON DELETE SET NULL;

    CREATE INDEX idx_lead_entries_capture_session_id
      ON lead_entries(capture_session_id);
  END IF;
END $$;

-- 2. capture_sessions.extraction_metadata
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'capture_sessions' AND column_name = 'extraction_metadata'
  ) THEN
    ALTER TABLE capture_sessions
      ADD COLUMN extraction_metadata jsonb NOT NULL DEFAULT '{}';
  END IF;
END $$;

-- 3. capture_sessions.review_metadata
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'capture_sessions' AND column_name = 'review_metadata'
  ) THEN
    ALTER TABLE capture_sessions
      ADD COLUMN review_metadata jsonb NOT NULL DEFAULT '{}';
  END IF;
END $$;
