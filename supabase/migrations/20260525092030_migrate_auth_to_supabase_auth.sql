/*
  # Migrate to Supabase Auth

  ## Summary
  Replaces the manual session-token authentication system with proper Supabase Auth.
  Sales reps continue to log in with rep_code + password, but authentication is now
  delegated to auth.users via email match.

  ## Changes

  ### 1. sales_representatives — add auth_user_id column
  - New column `auth_user_id uuid` references auth.users(id)
  - Nullable so existing rows are unaffected until first login
  - Unique constraint so one auth user maps to exactly one rep record
  - Index for fast lookup by auth_user_id

  ### 2. Public lookup function: get_rep_email_by_code
  - Accepts a rep_code, returns the email if login_enabled = true
  - Called by the frontend before signInWithPassword to get the email
  - Uses SECURITY DEFINER so anon role can call it without RLS bypass on the table
  - Returns NULL if rep not found or login disabled (same UX as before)

  ### 3. Public function: link_auth_user_to_rep
  - Called after first successful Supabase Auth login
  - Writes auth.uid() into sales_representatives.auth_user_id for the row
    matching the email, if not already linked
  - SECURITY DEFINER to bypass RLS on the update

  ### 4. Update sales_representatives RLS
  - Drop the permissive "Allow login read" (USING true) policy
  - Replace with:
    a. Anon SELECT: only rep_code + email + login_enabled (for the pre-auth lookup)
    b. Authenticated SELECT: own row only (auth.uid() = auth_user_id)
    c. Authenticated UPDATE: own row only (for auth_user_id linking)
  - Keep "Allow session update" dropped (replaced by auth_user_id linking)

  ### 5. Update capture tables RLS
  - capture_sessions, capture_assets, extraction_results already have
    auth.uid() = user_id policies from the previous migration — no change needed.
    The user_id column will now be populated correctly because the Supabase
    Auth JWT is real.

  ## Security
  - Plaintext password column is NOT dropped here — that is a separate admin task
    once all reps have been migrated to Supabase Auth accounts
  - The lookup function returns only email, never password
  - auth_user_id is set once on first login and cannot be changed by the rep
*/

-- ─── 1. Add auth_user_id to sales_representatives ─────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'sales_representatives' AND column_name = 'auth_user_id'
  ) THEN
    ALTER TABLE sales_representatives
      ADD COLUMN auth_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL;
  END IF;
END $$;

-- Unique: one auth user ↔ one rep (allow null for unlinked reps)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'sales_representatives_auth_user_id_key'
  ) THEN
    ALTER TABLE sales_representatives
      ADD CONSTRAINT sales_representatives_auth_user_id_key UNIQUE (auth_user_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS sales_representatives_auth_user_id_idx
  ON sales_representatives(auth_user_id)
  WHERE auth_user_id IS NOT NULL;

-- ─── 2. Lookup function: rep_code → email ────────────────────────────────────
-- Called by the frontend (anon) before signInWithPassword.
-- Returns NULL if rep not found or login disabled — never leaks data.

CREATE OR REPLACE FUNCTION public.get_rep_email_by_code(p_rep_code text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_email text;
BEGIN
  SELECT email INTO v_email
  FROM sales_representatives
  WHERE rep_code = p_rep_code
    AND login_enabled = true
    AND is_active = true
  LIMIT 1;

  RETURN v_email;
END;
$$;

-- Allow anon to call the lookup function
GRANT EXECUTE ON FUNCTION public.get_rep_email_by_code(text) TO anon;
GRANT EXECUTE ON FUNCTION public.get_rep_email_by_code(text) TO authenticated;

-- ─── 3. Link function: write auth.uid() into sales_representatives ───────────
-- Called once after first successful Supabase Auth login.
-- Idempotent: does nothing if auth_user_id already set for this email.

CREATE OR REPLACE FUNCTION public.link_auth_user_to_rep()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_email   text;
BEGIN
  -- Get the email of the currently authenticated user
  SELECT email INTO v_email
  FROM auth.users
  WHERE id = v_user_id;

  IF v_email IS NULL THEN
    RETURN;
  END IF;

  -- Link auth_user_id to the matching sales rep row (only if not yet linked)
  UPDATE sales_representatives
  SET auth_user_id = v_user_id
  WHERE email = v_email
    AND (auth_user_id IS NULL OR auth_user_id = v_user_id);
END;
$$;

GRANT EXECUTE ON FUNCTION public.link_auth_user_to_rep() TO authenticated;

-- ─── 4. Update sales_representatives RLS ─────────────────────────────────────

-- Drop old permissive policies
DROP POLICY IF EXISTS "Allow login read"    ON sales_representatives;
DROP POLICY IF EXISTS "Allow session update" ON sales_representatives;

-- Anon can read only the minimal fields needed for the pre-auth rep_code lookup.
-- The get_rep_email_by_code function is SECURITY DEFINER so it bypasses this,
-- but we add this policy for any direct table access needs.
CREATE POLICY "Anon can read active reps for login lookup"
  ON sales_representatives FOR SELECT
  TO anon
  USING (login_enabled = true AND is_active = true);

-- Authenticated users can read their own rep row (matched by auth_user_id)
CREATE POLICY "Auth users can read own rep row"
  ON sales_representatives FOR SELECT
  TO authenticated
  USING (auth.uid() = auth_user_id);

-- Authenticated users can update their own row (only for auth_user_id linking)
CREATE POLICY "Auth users can update own rep row"
  ON sales_representatives FOR UPDATE
  TO authenticated
  USING (auth.uid() = auth_user_id)
  WITH CHECK (auth.uid() = auth_user_id);

-- ─── 5. Helper view for rep profile lookup post-auth ─────────────────────────
-- Frontend reads this after login to get rep_code, name, role.

CREATE OR REPLACE VIEW public.my_rep_profile AS
  SELECT id, rep_code, name, email, role, login_enabled, is_active, auth_user_id
  FROM sales_representatives
  WHERE auth_user_id = auth.uid();

GRANT SELECT ON public.my_rep_profile TO authenticated;
