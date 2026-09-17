/*
# Create event-whatsapp-images storage bucket

## Purpose
Creates a new public storage bucket for Event-level WhatsApp template images.
This is separate from the existing `template-images` bucket (used by TemplatesPage)
to avoid any interference with existing behavior.

## Storage
- Bucket name: `event-whatsapp-images`
- Public: true (publicly readable via public URL — required for Meta/n8n access)
- Upload path convention: `{event-id}/{unique-file-name}`

## Security
- The bucket is public for reads (Meta and n8n need unauthenticated access to the image URL).
- Upload/Write policies are restricted to authenticated users only.
- Delete policies are restricted to authenticated users only.
- This does NOT modify the existing `template-images` bucket or its policies.

## Important Notes
1. This is a new, isolated bucket — no existing bucket is modified.
2. The `template-images` bucket used by TemplatesPage remains untouched.
3. Public read access is required because Meta's WhatsApp API fetches the image URL
   server-side, and n8n will reference the URL without Supabase auth headers.
*/
INSERT INTO storage.buckets (id, name, public)
SELECT 'event-whatsapp-images', 'event-whatsapp-images', true
WHERE NOT EXISTS (
  SELECT 1 FROM storage.buckets WHERE id = 'event-whatsapp-images'
);

-- Storage policies for event-whatsapp-images bucket
-- Authenticated users can upload (Event editors are authenticated)
DROP POLICY IF EXISTS "event_whatsapp_images_upload" ON storage.objects;
CREATE POLICY "event_whatsapp_images_upload"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (bucket_id = 'event-whatsapp-images');

-- Public read access (Meta API and n8n need unauthenticated access)
DROP POLICY IF EXISTS "event_whatsapp_images_public_read" ON storage.objects;
CREATE POLICY "event_whatsapp_images_public_read"
  ON storage.objects FOR SELECT
  TO anon, authenticated
  USING (bucket_id = 'event-whatsapp-images');

-- Authenticated users can update (replace images)
DROP POLICY IF EXISTS "event_whatsapp_images_update" ON storage.objects;
CREATE POLICY "event_whatsapp_images_update"
  ON storage.objects FOR UPDATE
  TO authenticated
  USING (bucket_id = 'event-whatsapp-images')
  WITH CHECK (bucket_id = 'event-whatsapp-images');

-- Authenticated users can delete (remove images)
DROP POLICY IF EXISTS "event_whatsapp_images_delete" ON storage.objects;
CREATE POLICY "event_whatsapp_images_delete"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (bucket_id = 'event-whatsapp-images');
