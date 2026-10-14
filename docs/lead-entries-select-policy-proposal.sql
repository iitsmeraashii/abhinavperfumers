-- ============================================================================
-- PROPOSED MIGRATION — DO NOT APPLY
-- File: 20261014120000_replace_lead_entries_select_policies.sql
-- Date: 2026-10-14
--
-- Purpose:
--   Atomically replace the two existing SELECT policies on lead_entries so
--   that only authenticated, active, login-enabled admins see all leads and
--   authenticated, active, login-enabled sales_rep users see only leads
--   assigned to their rep_code.  anon is revoked.
--
-- Scope:
--   ONLY lead_entries SELECT policies + anon SELECT table privilege.
--   INSERT / UPDATE / DELETE policies, all sales_representatives permissions,
--   helper functions, postgres / service-role privileges, and application
--   code are NOT touched.
--
-- Recursion safety:
--   Direct EXISTS against sales_representatives.  No sales_representatives
--   SELECT policy references lead_entries (verified from migrations), so the
--   sub-query cannot recurse back into this table's RLS.
--
-- Original policy names preserved:
--   "Admin can see all"
--   "Sales rep can see own leads"
-- ============================================================================

BEGIN;

-- ─── Step 1: Drop the two exact existing SELECT policies ─────────────────────

DROP POLICY IF EXISTS "Admin can see all" ON public.lead_entries;
DROP POLICY IF EXISTS "Sales rep can see own leads" ON public.lead_entries;

-- ─── Step 2: Admin SELECT policy ─────────────────────────────────────────────
-- Authenticated user whose sales_representatives row has:
--   auth_user_id = auth.uid()  AND  role = 'admin'
--   AND  is_active = true      AND  login_enabled = true

CREATE POLICY "Admin can see all"
  ON public.lead_entries
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.sales_representatives sr
      WHERE sr.auth_user_id = auth.uid()
        AND sr.role = 'admin'
        AND sr.is_active = true
        AND sr.login_enabled = true
    )
  );

-- ─── Step 3: Sales rep SELECT policy ─────────────────────────────────────────
-- Authenticated user whose sales_representatives row has:
--   auth_user_id = auth.uid()  AND  role = 'sales_rep'
--   AND  is_active = true      AND  login_enabled = true
--   AND  sr.rep_code = lead_entries.sales_rep_code
-- NULLIF(btrim(sr.rep_code), '') IS NOT NULL guards against blank/NULL
-- rep_code values matching a lead whose sales_rep_code is also blank/NULL.
-- Unsupported roles match neither policy and see zero rows.

CREATE POLICY "Sales rep can see own leads"
  ON public.lead_entries
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.sales_representatives sr
      WHERE sr.auth_user_id = auth.uid()
        AND sr.role = 'sales_rep'
        AND sr.is_active = true
        AND sr.login_enabled = true
        AND NULLIF(btrim(sr.rep_code), '') IS NOT NULL
        AND sr.rep_code = lead_entries.sales_rep_code
    )
  );

-- ─── Step 4: Revoke anon SELECT table privilege ──────────────────────────────

REVOKE SELECT ON public.lead_entries FROM anon;

COMMIT;
