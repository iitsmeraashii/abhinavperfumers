/*
# Clean up temporary template-images policies

## Summary
Removes the temporary SELECT and DELETE policies created on storage.objects
to allow deletion of template-images bucket files via the Storage API.
The files have been successfully deleted. The bucket row remains in
storage.buckets but is empty (0 objects) and has no policies — it is
effectively dead and inaccessible. Full bucket row deletion requires
the service role key which is not available in this environment.
*/

DROP POLICY IF EXISTS "temp_delete_template_images" ON storage.objects;
DROP POLICY IF EXISTS "temp_select_template_images" ON storage.objects;
