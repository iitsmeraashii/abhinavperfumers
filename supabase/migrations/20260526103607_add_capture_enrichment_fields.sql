/*
  # Add Enrichment Fields to capture_sessions

  ## Summary
  Adds new columns for enriched lead capture data: price range, previous rep reference,
  notes image storage, quick keywords, and voice note metadata.

  ## Changes

  ### 1. capture_sessions — new columns
  - `price_range` (text, nullable) — free text for pricing info
  - `previous_rep_code` (text, nullable) — rep code if EXISTING lead type
  - `notes_image_url` (text, nullable) — dataURL or storage path for notes image
  - `quick_keywords` (text[], nullable) — quick tags for search/filtering
  - `voice_note_duration_ms` (integer, nullable) — duration of voice note in ms
  - `voice_note_transcript` (text, nullable) — transcript text of voice note

  ### 2. No RLS changes needed
  - Existing capture_sessions RLS policies cover these columns via the existing
    user_id check on SELECT/INSERT/UPDATE.
*/

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'capture_sessions' AND column_name = 'price_range'
  ) THEN
    ALTER TABLE capture_sessions ADD COLUMN price_range text;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'capture_sessions' AND column_name = 'previous_rep_code'
  ) THEN
    ALTER TABLE capture_sessions ADD COLUMN previous_rep_code text;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'capture_sessions' AND column_name = 'notes_image_url'
  ) THEN
    ALTER TABLE capture_sessions ADD COLUMN notes_image_url text;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'capture_sessions' AND column_name = 'quick_keywords'
  ) THEN
    ALTER TABLE capture_sessions ADD COLUMN quick_keywords text[];
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'capture_sessions' AND column_name = 'voice_note_duration_ms'
  ) THEN
    ALTER TABLE capture_sessions ADD COLUMN voice_note_duration_ms integer;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'capture_sessions' AND column_name = 'voice_note_transcript'
  ) THEN
    ALTER TABLE capture_sessions ADD COLUMN voice_note_transcript text;
  END IF;
END $$;
