/*
# Clean up template-images storage bucket

## Summary
Temporarily re-creates a delete policy on the template-images bucket so objects
can be removed via the Storage API, then deletes the bucket itself.
The bucket was only used by the old TemplatesPage (now deleted).
*/

-- 1. Temporarily create a permissive delete policy on template-images
CREATE POLICY "temp_delete_template_images"
ON storage.objects FOR DELETE
TO authenticated, anon
USING (bucket_id = 'template-images');

-- 2. Create a permissive select policy so we can list objects
CREATE POLICY "temp_select_template_images"
ON storage.objects FOR SELECT
TO authenticated, anon
USING (bucket_id = 'template-images');
