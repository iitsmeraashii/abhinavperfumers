-- Ensure the (capture_session_id, local_asset_id) pair is unique so that
-- syncUpsertAsset can use it as the ON CONFLICT target instead of id.
-- This lets the DB generate the UUID primary key while keeping upserts idempotent
-- using the frontend-generated local_asset_id as the stable identity key.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'capture_assets_session_local_id_key'
      AND conrelid = 'capture_assets'::regclass
  ) THEN
    ALTER TABLE capture_assets
      ADD CONSTRAINT capture_assets_session_local_id_key
      UNIQUE (capture_session_id, local_asset_id);
  END IF;
END $$;
