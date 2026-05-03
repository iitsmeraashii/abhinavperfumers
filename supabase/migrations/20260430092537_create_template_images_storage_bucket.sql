/*
  # Create storage bucket for template images

  1. New bucket: template-images (public read)
  2. Storage policies:
     - Anyone can read (public bucket)
     - Anyone can upload/delete (matches the app's custom auth pattern)
*/

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'template-images',
  'template-images',
  true,
  5242880,
  ARRAY['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp']
)
ON CONFLICT (id) DO NOTHING;

CREATE POLICY "Public read template images"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'template-images');

CREATE POLICY "Allow upload template images"
  ON storage.objects FOR INSERT
  WITH CHECK (bucket_id = 'template-images');

CREATE POLICY "Allow delete template images"
  ON storage.objects FOR DELETE
  USING (bucket_id = 'template-images');

CREATE POLICY "Allow update template images"
  ON storage.objects FOR UPDATE
  USING (bucket_id = 'template-images')
  WITH CHECK (bucket_id = 'template-images');
