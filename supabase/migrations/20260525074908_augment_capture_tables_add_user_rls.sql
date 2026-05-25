/*
  # Augment Capture Tables — Add user_id, RLS, and missing columns

  The capture_sessions, capture_assets, and extraction_results tables were
  created with a sales_rep_code / event_code FK model. This migration adds:

  1. user_id column to all three tables (auth.users FK, nullable initially
     so existing rows aren't rejected, then backfilled to a sentinel value)
  2. Missing columns on capture_sessions:
     - extracted_fields (jsonb) — merged contact field map
     - review_state (jsonb) — field-level confirmation tracking
     - local_draft_key (text) — IndexedDB key for local draft recovery
     - promoted_lead_id (uuid) — set when promoted to lead_entries
     - synced_at (timestamptz) — last client-confirmed sync timestamp
  3. Missing columns on capture_assets:
     - user_id (uuid)
     - side (text) alias alongside asset_side for code compatibility
     - original_width / original_height — pre-compression dims
     - stored_width / stored_height — post-compression dims
     - size_bytes — compressed size
  4. Missing columns on extraction_results:
     - user_id (uuid)
     - asset_id (uuid) FK to capture_assets
     - engine (text) — tesseract_ocr | qr_parser | ai_vision | manual
     - extracted_json (jsonb) — parsed field map
     - confidence (text) — high | medium | low | none
     - duration_ms (int) — processing time
     - status (text) — done | failed | pending
     - metadata (jsonb) — engine-specific details
  5. RLS enabled on all three tables with ownership policies

  Security: all policies use auth.uid() = user_id ownership check.
*/

-- ─── capture_sessions — add missing columns ───────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'capture_sessions' AND column_name = 'user_id'
  ) THEN
    ALTER TABLE capture_sessions ADD COLUMN user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'capture_sessions' AND column_name = 'extracted_fields'
  ) THEN
    ALTER TABLE capture_sessions ADD COLUMN extracted_fields jsonb NOT NULL DEFAULT '{}';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'capture_sessions' AND column_name = 'review_state'
  ) THEN
    ALTER TABLE capture_sessions ADD COLUMN review_state jsonb NOT NULL DEFAULT '{}';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'capture_sessions' AND column_name = 'local_draft_key'
  ) THEN
    ALTER TABLE capture_sessions ADD COLUMN local_draft_key text;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'capture_sessions' AND column_name = 'promoted_lead_id'
  ) THEN
    ALTER TABLE capture_sessions ADD COLUMN promoted_lead_id uuid;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'capture_sessions' AND column_name = 'synced_at'
  ) THEN
    ALTER TABLE capture_sessions ADD COLUMN synced_at timestamptz;
  END IF;
END $$;

-- ─── capture_assets — add missing columns ────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'capture_assets' AND column_name = 'user_id'
  ) THEN
    ALTER TABLE capture_assets ADD COLUMN user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'capture_assets' AND column_name = 'side'
  ) THEN
    ALTER TABLE capture_assets ADD COLUMN side text;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'capture_assets' AND column_name = 'original_width'
  ) THEN
    ALTER TABLE capture_assets ADD COLUMN original_width integer NOT NULL DEFAULT 0;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'capture_assets' AND column_name = 'original_height'
  ) THEN
    ALTER TABLE capture_assets ADD COLUMN original_height integer NOT NULL DEFAULT 0;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'capture_assets' AND column_name = 'stored_width'
  ) THEN
    ALTER TABLE capture_assets ADD COLUMN stored_width integer NOT NULL DEFAULT 0;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'capture_assets' AND column_name = 'stored_height'
  ) THEN
    ALTER TABLE capture_assets ADD COLUMN stored_height integer NOT NULL DEFAULT 0;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'capture_assets' AND column_name = 'size_bytes'
  ) THEN
    ALTER TABLE capture_assets ADD COLUMN size_bytes integer NOT NULL DEFAULT 0;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'capture_assets' AND column_name = 'updated_at'
  ) THEN
    ALTER TABLE capture_assets ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
  END IF;
END $$;

-- ─── extraction_results — add missing columns ─────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'extraction_results' AND column_name = 'user_id'
  ) THEN
    ALTER TABLE extraction_results ADD COLUMN user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'extraction_results' AND column_name = 'asset_id'
  ) THEN
    ALTER TABLE extraction_results ADD COLUMN asset_id uuid REFERENCES capture_assets(id) ON DELETE SET NULL;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'extraction_results' AND column_name = 'engine'
  ) THEN
    ALTER TABLE extraction_results ADD COLUMN engine text NOT NULL DEFAULT 'manual';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'extraction_results' AND column_name = 'extracted_json'
  ) THEN
    ALTER TABLE extraction_results ADD COLUMN extracted_json jsonb NOT NULL DEFAULT '{}';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'extraction_results' AND column_name = 'confidence'
  ) THEN
    ALTER TABLE extraction_results ADD COLUMN confidence text NOT NULL DEFAULT 'none';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'extraction_results' AND column_name = 'duration_ms'
  ) THEN
    ALTER TABLE extraction_results ADD COLUMN duration_ms integer;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'extraction_results' AND column_name = 'status'
  ) THEN
    ALTER TABLE extraction_results ADD COLUMN status text NOT NULL DEFAULT 'done';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'extraction_results' AND column_name = 'metadata'
  ) THEN
    ALTER TABLE extraction_results ADD COLUMN metadata jsonb NOT NULL DEFAULT '{}';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'extraction_results' AND column_name = 'updated_at'
  ) THEN
    ALTER TABLE extraction_results ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
  END IF;
END $$;

-- ─── Indexes ──────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS capture_sessions_user_id_idx ON capture_sessions(user_id);
CREATE INDEX IF NOT EXISTS capture_sessions_status_idx  ON capture_sessions(user_id, session_status);
CREATE INDEX IF NOT EXISTS capture_assets_user_id_idx   ON capture_assets(user_id);
CREATE INDEX IF NOT EXISTS extraction_results_user_id_idx ON extraction_results(user_id);
CREATE INDEX IF NOT EXISTS extraction_results_asset_id_idx ON extraction_results(asset_id) WHERE asset_id IS NOT NULL;

-- ─── RLS ─────────────────────────────────────────────────────────────────────

ALTER TABLE capture_sessions   ENABLE ROW LEVEL SECURITY;
ALTER TABLE capture_assets     ENABLE ROW LEVEL SECURITY;
ALTER TABLE extraction_results ENABLE ROW LEVEL SECURITY;

-- capture_sessions policies
CREATE POLICY "Users can view own capture sessions"
  ON capture_sessions FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own capture sessions"
  ON capture_sessions FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own capture sessions"
  ON capture_sessions FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own capture sessions"
  ON capture_sessions FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);

-- capture_assets policies
CREATE POLICY "Users can view own capture assets"
  ON capture_assets FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own capture assets"
  ON capture_assets FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own capture assets"
  ON capture_assets FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own capture assets"
  ON capture_assets FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);

-- extraction_results policies
CREATE POLICY "Users can view own extraction results"
  ON extraction_results FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own extraction results"
  ON extraction_results FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own extraction results"
  ON extraction_results FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own extraction results"
  ON extraction_results FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);
