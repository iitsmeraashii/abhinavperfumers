/*
# Add INSERT and DELETE RLS policies for whatsapp_conversation_leads

## Summary
The bridge table already has RLS enabled with a SELECT policy for
authenticated users. This migration adds INSERT and DELETE policies so
authenticated users can link and unlink leads from conversations.

## Tables affected
- whatsapp_conversation_leads (existing, no schema changes)

## Security
- INSERT policy: authenticated users can insert bridge rows.
- DELETE policy: authenticated users can delete bridge rows.
- No UPDATE policy — bridge rows are immutable once created (link/unlink
  is insert/delete, not update).
- These policies do not weaken any existing policy. The underlying
  lead_entries and whatsapp_conversations tables retain their own RLS.
*/

-- INSERT: allow authenticated users to link leads to conversations
DROP POLICY IF EXISTS "insert_whatsapp_conversation_leads" ON public.whatsapp_conversation_leads;
CREATE POLICY "insert_whatsapp_conversation_leads"
  ON public.whatsapp_conversation_leads FOR INSERT
  TO authenticated
  WITH CHECK (true);

-- DELETE: allow authenticated users to unlink leads from conversations
DROP POLICY IF EXISTS "delete_whatsapp_conversation_leads" ON public.whatsapp_conversation_leads;
CREATE POLICY "delete_whatsapp_conversation_leads"
  ON public.whatsapp_conversation_leads FOR DELETE
  TO authenticated
  USING (true);
