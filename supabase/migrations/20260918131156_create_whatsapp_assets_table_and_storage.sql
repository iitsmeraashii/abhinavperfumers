/*
# Create whatsapp_assets table and whatsapp-assets storage bucket

## Purpose
Foundation for reusable WhatsApp business assets (price lists, brochures,
catalogues, product images, and other business documents/images). Postgres
stores metadata; Supabase Storage stores the actual files. Each asset may
optionally have a configurable `share_message` that accompanies the asset
when it is shared — this message is independent of Meta templates.

## New Table: public.whatsapp_assets
- `id` (uuid, primary key, default gen_random_uuid())
- `name` (text, not null) — human-friendly asset name
- `description` (text, nullable) — optional longer description
- `asset_type` (text, not null) — DOCUMENT or IMAGE (CHECK constraint)
- `file_name` (text, not null) — original/uploaded file name
- `storage_path` (text, not null) — path within the whatsapp-assets bucket
- `mime_type` (text, not null) — MIME type of the file
- `file_size` (bigint, nullable) — file size in bytes if known
- `share_message` (text, nullable) — optional configurable message to
  accompany the asset when shared. NULL means no message configured. This
  is NOT tied to Meta templates.
- `active` (boolean, not null, default true) — soft-disable an asset
- `created_at` (timestamptz, not null, default now())
- `updated_at` (timestamptz, not null, default now()) — kept current by trigger

## Storage
- New bucket: `whatsapp-assets` (private — not public)
- Files stored at: `{asset-id}/{file-name}` (collision-safe, predictable)
- Binary file contents are NEVER stored in Postgres.

## Security / RLS
- RLS enabled on whatsapp_assets.
- SELECT: authenticated users can read active assets.
- INSERT / UPDATE / DELETE: only admins (via sales_representatives.role =
  'admin' where auth_user_id = auth.uid()).
- Storage policies follow the same model:
  - SELECT (read): authenticated users can read whatsapp-assets objects.
  - INSERT / UPDATE / DELETE: only admins.

## updated_at Trigger
- A dedicated trigger function `set_whatsapp_assets_updated_at()` sets
  `updated_at = now()` on every UPDATE. No shared trigger function exists
  in this project, so this is the minimum required.

## Important Notes
1. This is a foundation-only migration — no UI, no sending, no Meta upload.
2. No existing tables, policies, or buckets are modified.
3. `share_message` is optional (nullable) and not named `template_message`.
4. `mime_type` is not restricted to specific values at the DB level —
   upload validation will be handled by the application in a later step.
*/

-- ── 1. Create whatsapp_assets table ──────────────────────────────────────────

CREATE TABLE IF NOT EXISTS whatsapp_assets (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text        NOT NULL,
  description  text,
  asset_type   text        NOT NULL CHECK (asset_type IN ('DOCUMENT', 'IMAGE')),
  file_name    text        NOT NULL,
  storage_path text        NOT NULL,
  mime_type    text        NOT NULL,
  file_size    bigint,
  share_message text,
  active       boolean     NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- ── 2. Enable RLS ────────────────────────────────────────────────────────────

ALTER TABLE whatsapp_assets ENABLE ROW LEVEL SECURITY;

-- ── 3. RLS Policies ─────────────────────────────────────────────────────────

-- Authenticated users can SELECT active assets
DROP POLICY IF EXISTS "select_whatsapp_assets" ON whatsapp_assets;
CREATE POLICY "select_whatsapp_assets"
  ON whatsapp_assets FOR SELECT
  TO authenticated
  USING (active = true);

-- Only admins can INSERT
DROP POLICY IF EXISTS "insert_whatsapp_assets" ON whatsapp_assets;
CREATE POLICY "insert_whatsapp_assets"
  ON whatsapp_assets FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM sales_representatives
      WHERE sales_representatives.auth_user_id = auth.uid()
        AND sales_representatives.role = 'admin'
    )
  );

-- Only admins can UPDATE
DROP POLICY IF EXISTS "update_whatsapp_assets" ON whatsapp_assets;
CREATE POLICY "update_whatsapp_assets"
  ON whatsapp_assets FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM sales_representatives
      WHERE sales_representatives.auth_user_id = auth.uid()
        AND sales_representatives.role = 'admin'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM sales_representatives
      WHERE sales_representatives.auth_user_id = auth.uid()
        AND sales_representatives.role = 'admin'
    )
  );

-- Only admins can DELETE
DROP POLICY IF EXISTS "delete_whatsapp_assets" ON whatsapp_assets;
CREATE POLICY "delete_whatsapp_assets"
  ON whatsapp_assets FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM sales_representatives
      WHERE sales_representatives.auth_user_id = auth.uid()
        AND sales_representatives.role = 'admin'
    )
  );

-- ── 4. updated_at trigger ────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION set_whatsapp_assets_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public;

DROP TRIGGER IF EXISTS trg_whatsapp_assets_updated_at ON whatsapp_assets;
CREATE TRIGGER trg_whatsapp_assets_updated_at
  BEFORE UPDATE ON whatsapp_assets
  FOR EACH ROW
  EXECUTE FUNCTION set_whatsapp_assets_updated_at();

-- ── 5. Storage bucket: whatsapp-assets ───────────────────────────────────────

INSERT INTO storage.buckets (id, name, public)
SELECT 'whatsapp-assets', 'whatsapp-assets', false
WHERE NOT EXISTS (
  SELECT 1 FROM storage.buckets WHERE id = 'whatsapp-assets'
);

-- Storage policies for whatsapp-assets bucket

-- Authenticated users can read (download) asset files
DROP POLICY IF EXISTS "whatsapp_assets_storage_read" ON storage.objects;
CREATE POLICY "whatsapp_assets_storage_read"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (bucket_id = 'whatsapp-assets');

-- Only admins can upload (INSERT)
DROP POLICY IF EXISTS "whatsapp_assets_storage_upload" ON storage.objects;
CREATE POLICY "whatsapp_assets_storage_upload"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'whatsapp-assets'
    AND EXISTS (
      SELECT 1 FROM sales_representatives
      WHERE sales_representatives.auth_user_id = auth.uid()
        AND sales_representatives.role = 'admin'
    )
  );

-- Only admins can update (replace) files
DROP POLICY IF EXISTS "whatsapp_assets_storage_update" ON storage.objects;
CREATE POLICY "whatsapp_assets_storage_update"
  ON storage.objects FOR UPDATE
  TO authenticated
  USING (
    bucket_id = 'whatsapp-assets'
    AND EXISTS (
      SELECT 1 FROM sales_representatives
      WHERE sales_representatives.auth_user_id = auth.uid()
        AND sales_representatives.role = 'admin'
    )
  )
  WITH CHECK (
    bucket_id = 'whatsapp-assets'
    AND EXISTS (
      SELECT 1 FROM sales_representatives
      WHERE sales_representatives.auth_user_id = auth.uid()
        AND sales_representatives.role = 'admin'
    )
  );

-- Only admins can delete files
DROP POLICY IF EXISTS "whatsapp_assets_storage_delete" ON storage.objects;
CREATE POLICY "whatsapp_assets_storage_delete"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'whatsapp-assets'
    AND EXISTS (
      SELECT 1 FROM sales_representatives
      WHERE sales_representatives.auth_user_id = auth.uid()
        AND sales_representatives.role = 'admin'
    )
  );
