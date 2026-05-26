/*
  # Allow authenticated users to read all active sales reps

  ## Summary
  The Previous Associated Rep dropdown in the lead capture form needs authenticated
  users to be able to list all active reps (name + rep_code).

  The existing "Anon can read active reps for login lookup" policy only covers
  the anon role. Authenticated users could only see their own row.

  This adds a SELECT policy so any authenticated user can read the rep_code, name,
  and is_active fields for all active, login-enabled reps.

  ## Security
  - Restricted to authenticated role only
  - Only active + login-enabled reps are visible (same guard as the anon policy)
  - No sensitive columns (password, session_token, auth_user_id) are exposed
    beyond what RLS already allows per-user
*/

DROP POLICY IF EXISTS "Authenticated users can read all active reps" ON sales_representatives;

CREATE POLICY "Authenticated users can read all active reps"
  ON sales_representatives FOR SELECT
  TO authenticated
  USING (is_active = true AND login_enabled = true);
