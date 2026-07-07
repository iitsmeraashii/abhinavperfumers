-- Add transcription_status to capture_assets.
-- Only populated for asset_type = 'voice_note' rows.
-- Lifecycle: pending_upload → uploading → uploaded → transcribing → ready | failed
ALTER TABLE capture_assets
  ADD COLUMN IF NOT EXISTS transcription_status TEXT DEFAULT NULL;
