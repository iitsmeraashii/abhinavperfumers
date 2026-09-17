/*
# Add RLS read policies for whatsapp_messages and whatsapp_conversation_leads

## Summary
Both tables already have RLS enabled but no policies, so the authenticated
frontend cannot read them. This migration adds SELECT-only policies for
authenticated users on both tables. No write policies are added — writes
are handled by the WhatsApp webhook / sending pipeline, not the frontend.

## Tables affected
- whatsapp_messages (existing, no schema changes)
- whatsapp_conversation_leads (existing, no schema changes)

## Security
- SELECT-only policies scoped to `authenticated` role on both tables.
- No INSERT/UPDATE/DELETE policies.
*/

-- whatsapp_messages: allow authenticated reads
ALTER TABLE public.whatsapp_messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_whatsapp_messages" ON public.whatsapp_messages;
CREATE POLICY "select_whatsapp_messages"
  ON public.whatsapp_messages FOR SELECT
  TO authenticated
  USING (true);

-- whatsapp_conversation_leads: allow authenticated reads
ALTER TABLE public.whatsapp_conversation_leads ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_whatsapp_conversation_leads" ON public.whatsapp_conversation_leads;
CREATE POLICY "select_whatsapp_conversation_leads"
  ON public.whatsapp_conversation_leads FOR SELECT
  TO authenticated
  USING (true);
