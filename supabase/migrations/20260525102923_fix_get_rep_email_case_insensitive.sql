/*
  # Fix get_rep_email_by_code — case-insensitive rep_code lookup

  The original function did an exact-match on rep_code. This migration makes
  the DB match case-insensitively so it works regardless of caller normalisation.

  Adds get_rep_login_status to return structured status info for specific
  error messages (disabled account, inactive rep, no auth account).
*/

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
  WHERE upper(rep_code) = upper(p_rep_code)
    AND login_enabled = true
    AND is_active = true
  LIMIT 1;

  RETURN v_email;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_rep_email_by_code(text) TO anon;
GRANT EXECUTE ON FUNCTION public.get_rep_email_by_code(text) TO authenticated;

-- Returns structured login status without exposing passwords.
-- Used by AuthContext to show specific error messages.
CREATE OR REPLACE FUNCTION public.get_rep_login_status(p_rep_code text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row RECORD;
BEGIN
  SELECT rep_code, email, login_enabled, is_active, auth_user_id
  INTO v_row
  FROM sales_representatives
  WHERE upper(rep_code) = upper(p_rep_code)
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;

  IF NOT v_row.is_active THEN
    RETURN jsonb_build_object('status', 'inactive');
  END IF;

  IF NOT v_row.login_enabled THEN
    RETURN jsonb_build_object('status', 'disabled');
  END IF;

  IF v_row.auth_user_id IS NULL THEN
    RETURN jsonb_build_object('status', 'no_auth_account');
  END IF;

  IF v_row.email IS NULL THEN
    RETURN jsonb_build_object('status', 'no_email');
  END IF;

  RETURN jsonb_build_object(
    'status',   'ok',
    'email',    v_row.email,
    'rep_code', v_row.rep_code
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_rep_login_status(text) TO anon;
GRANT EXECUTE ON FUNCTION public.get_rep_login_status(text) TO authenticated;
