/*
# Allow admins to update sales_representatives records

## What this does
Currently, only a rep can update their own row (`auth.uid() = auth_user_id`).
Admins need to edit other reps' profiles (email, phone, is_active, default_event_id)
from the Sales Reps detail page.

## Changes
1. Adds a new UPDATE policy allowing admin users to update any sales_representatives row.
2. The existing "Auth users can update own rep row" policy remains unchanged.

## Security
- The new policy uses `is_admin_user()` (existing helper function) to restrict to admins only.
- Non-admin users can still only update their own row via the existing policy.
- No new columns or tables are created.
*/

DROP POLICY IF EXISTS "Admins can update any sales rep" ON sales_representatives;

CREATE POLICY "Admins can update any sales rep"
ON sales_representatives FOR UPDATE
TO authenticated
USING (is_admin_user())
WITH CHECK (is_admin_user());
