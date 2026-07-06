-- Storage RLS policies for the lead-evidence bucket.
-- Path convention: {userId}/{assetId}.jpg  OR  {userId}/{sessionId}/notes.jpg
-- All paths start with the uploading user's auth.uid(), so foldername()[1] is the owner check.

CREATE POLICY "lead_evidence_insert_own"
ON storage.objects FOR INSERT
TO authenticated
WITH CHECK (
  bucket_id = 'lead-evidence'
  AND (storage.foldername(name))[1] = auth.uid()::text
);

CREATE POLICY "lead_evidence_select_own"
ON storage.objects FOR SELECT
TO authenticated
USING (
  bucket_id = 'lead-evidence'
  AND (storage.foldername(name))[1] = auth.uid()::text
);

CREATE POLICY "lead_evidence_update_own"
ON storage.objects FOR UPDATE
TO authenticated
USING (
  bucket_id = 'lead-evidence'
  AND (storage.foldername(name))[1] = auth.uid()::text
)
WITH CHECK (
  bucket_id = 'lead-evidence'
  AND (storage.foldername(name))[1] = auth.uid()::text
);

CREATE POLICY "lead_evidence_delete_own"
ON storage.objects FOR DELETE
TO authenticated
USING (
  bucket_id = 'lead-evidence'
  AND (storage.foldername(name))[1] = auth.uid()::text
);
