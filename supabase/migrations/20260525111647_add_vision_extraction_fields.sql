/*
  # Add Vision Extraction Fields to capture_sessions

  ## Summary
  Augments capture_sessions to store structured extraction results from OpenAI Vision.

  ## New Columns
  - `extracted_data` (jsonb) — full structured extraction result from vision/OCR
  - `extraction_source` (text) — which engine produced the result: 'openai_vision', 'tesseract_fallback', 'manual'
  - `extraction_status` (text) — lifecycle: 'pending', 'running', 'done', 'failed', 'skipped'
  - `extraction_duration_ms` (integer) — how long extraction took end-to-end

  Note: extraction_confidence already exists as a text column in the original schema.
  We add it only if absent to avoid errors on re-run.
*/

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'capture_sessions' AND column_name = 'extracted_data'
  ) THEN
    ALTER TABLE capture_sessions ADD COLUMN extracted_data jsonb;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'capture_sessions' AND column_name = 'extraction_source'
  ) THEN
    ALTER TABLE capture_sessions ADD COLUMN extraction_source text DEFAULT 'manual';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'capture_sessions' AND column_name = 'extraction_status'
  ) THEN
    ALTER TABLE capture_sessions ADD COLUMN extraction_status text DEFAULT 'pending';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'capture_sessions' AND column_name = 'extraction_duration_ms'
  ) THEN
    ALTER TABLE capture_sessions ADD COLUMN extraction_duration_ms integer;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'capture_sessions' AND column_name = 'extraction_confidence'
  ) THEN
    ALTER TABLE capture_sessions ADD COLUMN extraction_confidence numeric;
  END IF;
END $$;
