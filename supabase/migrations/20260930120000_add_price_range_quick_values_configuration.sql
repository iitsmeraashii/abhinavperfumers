/*
# Add Price Range Quick Values global configuration

1. Purpose
   - Adds a new price_range_quick_values column (text[]) to the existing
     runtime_configuration singleton table.
   - Stores additional quick-input values for the Capture Form Price Range
     field (e.g. AED, GBP, %). INR and USD are built-in defaults that are
     always rendered and are NEVER stored in this column.
   - The column defaults to an empty array so existing behavior (INR + USD
     only) is preserved until an admin configures values.

2. Security - runtime_configuration RLS tightened
   - Replaces permissive SELECT/UPDATE policies with admin-only policies.
   - Two SECURITY DEFINER RPCs expose only the price_range_quick_values field:
     a) get_price_range_quick_values() - any authenticated user, returns text[]
     b) set_price_range_quick_values(p_values) - admin-only, sanitizes and saves

3. Schema change
   - ALTER TABLE runtime_configuration ADD COLUMN price_range_quick_values text[] NOT NULL DEFAULT '{}'

4. RPCs
   - get_price_range_quick_values() -> text[]  (SECURITY DEFINER, any authenticated)
   - set_price_range_quick_values(p_values text[]) -> jsonb  (SECURITY DEFINER, admin-only)

5. Notes
   - INR, USD, <, >, =, and - are hardcoded in the frontend as built-in defaults.
   - The write RPC strips those built-in values, blanks, and case-insensitive duplicates.
*/

ALTER TABLE runtime_configuration
  ADD COLUMN IF NOT EXISTS price_range_quick_values text[] NOT NULL DEFAULT '{}';

-- Tighten RLS: replace permissive policies with admin-only

DROP POLICY IF EXISTS "read_runtime_configuration" ON runtime_configuration;
CREATE POLICY "read_runtime_configuration"
  ON runtime_configuration FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM sales_representatives sr
      WHERE sr.auth_user_id = auth.uid()
        AND sr.role = 'admin'
    )
  );

DROP POLICY IF EXISTS "update_runtime_configuration" ON runtime_configuration;
CREATE POLICY "update_runtime_configuration"
  ON runtime_configuration FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM sales_representatives sr
      WHERE sr.auth_user_id = auth.uid()
        AND sr.role = 'admin'
    )
  ) WITH CHECK (
    EXISTS (
      SELECT 1 FROM sales_representatives sr
      WHERE sr.auth_user_id = auth.uid()
        AND sr.role = 'admin'
    )
  );

-- Public read RPC (any authenticated user, exposes only the one column)

CREATE OR REPLACE FUNCTION public.get_price_range_quick_values()
RETURNS text[]
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_values text[];
BEGIN
  SELECT price_range_quick_values INTO v_values
  FROM runtime_configuration
  WHERE id = 1;

  RETURN COALESCE(v_values, ARRAY[]::text[]);
END;
$$;

-- Admin-only write RPC (sanitizes input)

CREATE OR REPLACE FUNCTION public.set_price_range_quick_values(p_values text[])
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_is_admin boolean;
  v_cleaned text[] := ARRAY[]::text[];
  v_upper text;
  v_val text;
  v_trimmed text;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM sales_representatives sr
    WHERE sr.auth_user_id = auth.uid()
      AND sr.role = 'admin'
  ) INTO v_is_admin;

  IF NOT v_is_admin THEN
    RETURN jsonb_build_object('success', false, 'error', 'Not authorized');
  END IF;

  IF p_values IS NOT NULL THEN
    FOREACH v_val IN ARRAY p_values LOOP
      v_trimmed := btrim(v_val);
      IF v_trimmed IS NULL OR v_trimmed = '' THEN
        CONTINUE;
      END IF;
      v_upper := upper(v_trimmed);
      IF v_upper = 'INR' OR v_upper = 'USD'
         OR v_trimmed = '<' OR v_trimmed = '>' OR v_trimmed = '=' OR v_trimmed = '-' THEN
        CONTINUE;
      END IF;
      IF EXISTS (
        SELECT 1 FROM unnest(v_cleaned) AS c
        WHERE upper(c) = v_upper
      ) THEN
        CONTINUE;
      END IF;
      v_cleaned := array_append(v_cleaned, v_trimmed);
    END LOOP;
  END IF;

  UPDATE runtime_configuration
  SET price_range_quick_values = v_cleaned,
      updated_at = now()
  WHERE id = 1;

  RETURN jsonb_build_object('success', true, 'values', v_cleaned);
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_price_range_quick_values() TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_price_range_quick_values(text[]) TO authenticated;
