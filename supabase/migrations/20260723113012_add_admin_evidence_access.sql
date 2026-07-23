/*
# Allow Admin Users to View All Capture Evidence

## Problem
Evidence (voice notes, business card images, notes images) attached to a lead
is stored in three tables — capture_sessions, capture_assets, extraction_results —
and in the lead-evidence Storage bucket. All of these only have RLS policies
that check `auth.uid() = user_id`, so only the rep who created the evidence can
see it. Admin users can see every lead (lead_entries has an "Admin can see all"
SELECT policy) but cannot see any of that lead's evidence, because the capture
tables and storage bucket have no admin policy.

## Changes
1. capture_sessions — add admin SELECT policy (admins can read all rows).
2. capture_assets — add admin SELECT policy (admins can read all rows).
3. extraction_results — add admin SELECT policy (admins can read all rows).
4. lead-evidence Storage bucket — add admin SELECT policy so admins can generate
   signed URLs for evidence files owned by any rep.

Admin detection reuses the same pattern as lead_entries:
  EXISTS (SELECT 1 FROM sales_representatives
          WHERE auth_user_id = auth.uid() AND role = 'admin')

No INSERT/UPDATE/DELETE changes — admins only need to VIEW evidence, not modify it.
The existing ownership policies remain untouched.
*/

-- ─── 1. capture_sessions: admin SELECT ─────────────────────────────────────────

DROP POLICY IF EXISTS "Admins can view all capture sessions" ON capture_sessions;
CREATE POLICY "Admins can view all capture sessions"
  ON capture_sessions FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM sales_representatives
      WHERE auth_user_id = auth.uid()
        AND role = 'admin'
    )
  );

-- ─── 2. capture_assets: admin SELECT ───────────────────────────────────────────

DROP POLICY IF EXISTS "Admins can view all capture assets" ON capture_assets;
CREATE POLICY "Admins can view all capture assets"
  ON capture_assets FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM sales_representatives
      WHERE auth_user_id = auth.uid()
        AND role = 'admin'
    )
  );

-- ─── 3. extraction_results: admin SELECT ───────────────────────────────────────

DROP POLICY IF EXISTS "Admins can view all extraction results" ON extraction_results;
CREATE POLICY "Admins can view all extraction results"
  ON extraction_results FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM sales_representatives
      WHERE auth_user_id = auth.uid()
        AND role = 'admin'
    )
  );

-- ─── 4. lead-evidence Storage bucket: admin SELECT ─────────────────────────────
-- Allows admin users to read (and generate signed URLs for) any file in the
-- lead-evidence bucket, regardless of which rep's folder it lives in.

DROP POLICY IF EXISTS "lead_evidence_select_admin" ON storage.objects;
CREATE POLICY "lead_evidence_select_admin"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'lead-evidence'
    AND EXISTS (
      SELECT 1 FROM public.sales_representatives
      WHERE auth_user_id = auth.uid()
        AND role = 'admin'
    )
  );
