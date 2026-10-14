-- ============================================================================
-- EMERGENCY ROLLBACK — DO NOT APPLY UNLESS THE FORWARD MIGRATION CAUSES
-- A PRODUCTION OUTAGE.
--
-- *** WARNING ***
-- This script restores the original SELECT policies that allowed ANY
-- unauthenticated client (anon) and ANY authenticated user to read ALL
-- rows in lead_entries.  Applying this script re-opens public exposure
-- of every lead record.  Use only as a last resort.
-- *** WARNING ***
-- ============================================================================

BEGIN;

DROP POLICY IF EXISTS "Admin can see all" ON public.lead_entries;
DROP POLICY IF EXISTS "Sales rep can see own leads" ON public.lead_entries;

-- Restore original policy 1: everyone sees all rows.
CREATE POLICY "Admin can see all"
  ON public.lead_entries
  FOR SELECT
  TO public
  USING (true);

-- Restore original policy 2: legacy current_setting match
-- (effectively dead under Supabase Auth, restored as-is for fidelity).
CREATE POLICY "Sales rep can see own leads"
  ON public.lead_entries
  FOR SELECT
  TO public
  USING (sales_rep_code = current_setting('app.current_user'));

-- Restore anon SELECT table privilege.
GRANT SELECT ON public.lead_entries TO anon;

COMMIT;
