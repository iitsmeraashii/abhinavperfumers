/*
# Add RLS SELECT policy for whatsapp_conversations

## Summary
The whatsapp_conversations table already exists with RLS enabled but has
no policies, so authenticated frontend requests return zero rows. This
migration adds a SELECT policy allowing authenticated users to read
conversation rows. No INSERT/UPDATE/DELETE policies are added — those will
be handled by the WhatsApp webhook / sending pipeline, not the frontend.

## Table affected
- whatsapp_conversations (existing, no schema changes)

## Security
- Adds a SELECT policy scoped to `authenticated` role.
- No write policies — frontend is read-only for conversations in this step.
*/

-- Ensure RLS is enabled
ALTER TABLE public.whatsapp_conversations ENABLE ROW LEVEL SECURITY;

-- Allow authenticated users to read conversations
DROP POLICY IF EXISTS "select_whatsapp_conversations" ON public.whatsapp_conversations;
CREATE POLICY "select_whatsapp_conversations"
  ON public.whatsapp_conversations FOR SELECT
  TO authenticated
  USING (true);
