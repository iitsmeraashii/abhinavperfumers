/*
# Add whatsapp_opt_out column to lead_entries

1. Modified Tables
- `lead_entries` — new column `whatsapp_opt_out` (boolean, NOT NULL, default false)
  Indicates whether the customer has opted out of WhatsApp communication.
  When true, the Lead Detail WhatsApp card suppresses send/reply actions
  and shows an opt-out state instead of the normal conversation actions.

2. Security
- No RLS changes — the table already has RLS enabled and existing policies.
  The column is readable by the same roles that can already SELECT lead_entries.
  Updates go through the existing update_lead_with_audit RPC (admin-only via RLS),
  so no new write path is opened.
*/

ALTER TABLE public.lead_entries
  ADD COLUMN IF NOT EXISTS whatsapp_opt_out boolean NOT NULL DEFAULT false;
