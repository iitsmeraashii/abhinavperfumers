/*
# Fix WhatsApp conversation policy recursion and protect read-state updates

## Purpose
Replace recursive row-level policy expressions with a SECURITY DEFINER access
helper. The previous policies queried `whatsapp_conversation_leads` while
Postgres was evaluating that table's own policy, which caused the application
to show an "infinite recursion" database error.

## Security model
- Admins can access all conversations, messages, and bridge rows.
- Sales reps can access a conversation when at least one linked lead is
  assigned to their `sales_rep_code`.
- A conversation with no linked leads is hidden from sales reps.
- A conversation linked to multiple reps is visible to each assigned rep.
- Lead reassignment changes access automatically because the helper evaluates
  the current lead assignment at request time.
- Messages inherit access from their conversation.

## Modified database objects
1. `has_whatsapp_conversation_access(uuid)`
   - New SECURITY DEFINER helper that safely checks admin access or an
     assigned linked lead without invoking RLS recursively.
2. `whatsapp_conversations`
   - SELECT and UPDATE policies call the helper.
3. `whatsapp_messages`
   - SELECT and UPDATE policies call the helper using `conversation_id`.
4. `whatsapp_conversation_leads`
   - SELECT, INSERT, and DELETE policies call the helper.
5. `mark_conversation_read(uuid, text)`
   - Adds the same authorization check before changing messages or unread
     counts. The caller identity comes from `auth.uid()`, not the supplied
     display name.

## Important notes
- No user data is deleted or changed by this migration.
- The SECURITY DEFINER helper has a fixed `search_path` and is only used for
  authorization decisions.
- Existing service-role webhook and sending flows remain unaffected.
*/

CREATE OR REPLACE FUNCTION public.has_whatsapp_conversation_access(p_conversation_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT public.is_admin_user()
  OR EXISTS (
    SELECT 1
    FROM public.whatsapp_conversation_leads wcl
    JOIN public.lead_entries le ON le.id = wcl.lead_entry_id
    JOIN public.sales_representatives sr ON sr.rep_code = le.sales_rep_code
    WHERE wcl.conversation_id = p_conversation_id
      AND sr.auth_user_id = auth.uid()
      AND sr.role = 'sales_rep'
  );
$function$;

DROP POLICY IF EXISTS "select_whatsapp_conversations" ON public.whatsapp_conversations;
DROP POLICY IF EXISTS "update_whatsapp_conversations" ON public.whatsapp_conversations;

CREATE POLICY "select_whatsapp_conversations"
ON public.whatsapp_conversations FOR SELECT
TO authenticated
USING (public.has_whatsapp_conversation_access(id));

CREATE POLICY "update_whatsapp_conversations"
ON public.whatsapp_conversations FOR UPDATE
TO authenticated
USING (public.has_whatsapp_conversation_access(id))
WITH CHECK (public.has_whatsapp_conversation_access(id));

DROP POLICY IF EXISTS "select_whatsapp_messages" ON public.whatsapp_messages;
DROP POLICY IF EXISTS "update_whatsapp_messages" ON public.whatsapp_messages;

CREATE POLICY "select_whatsapp_messages"
ON public.whatsapp_messages FOR SELECT
TO authenticated
USING (public.has_whatsapp_conversation_access(conversation_id));

CREATE POLICY "update_whatsapp_messages"
ON public.whatsapp_messages FOR UPDATE
TO authenticated
USING (public.has_whatsapp_conversation_access(conversation_id))
WITH CHECK (public.has_whatsapp_conversation_access(conversation_id));

DROP POLICY IF EXISTS "select_whatsapp_conversation_leads" ON public.whatsapp_conversation_leads;
DROP POLICY IF EXISTS "insert_whatsapp_conversation_leads" ON public.whatsapp_conversation_leads;
DROP POLICY IF EXISTS "delete_whatsapp_conversation_leads" ON public.whatsapp_conversation_leads;

CREATE POLICY "select_whatsapp_conversation_leads"
ON public.whatsapp_conversation_leads FOR SELECT
TO authenticated
USING (public.has_whatsapp_conversation_access(conversation_id));

CREATE POLICY "insert_whatsapp_conversation_leads"
ON public.whatsapp_conversation_leads FOR INSERT
TO authenticated
WITH CHECK (public.has_whatsapp_conversation_access(conversation_id));

CREATE POLICY "delete_whatsapp_conversation_leads"
ON public.whatsapp_conversation_leads FOR DELETE
TO authenticated
USING (public.has_whatsapp_conversation_access(conversation_id));

CREATE OR REPLACE FUNCTION public.mark_conversation_read(p_conversation_id uuid, p_read_by text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_count integer;
BEGIN
  IF NOT public.has_whatsapp_conversation_access(p_conversation_id) THEN
    RAISE EXCEPTION 'Conversation not found';
  END IF;

  UPDATE public.whatsapp_messages
  SET is_read = true,
      read_at = now(),
      read_by = p_read_by,
      updated_at = now()
  WHERE conversation_id = p_conversation_id
    AND direction = 'inbound'
    AND is_read = false;

  GET DIAGNOSTICS v_count = ROW_COUNT;

  UPDATE public.whatsapp_conversations
  SET unread_count = 0,
      updated_at = now()
  WHERE id = p_conversation_id;

  RETURN jsonb_build_object(
    'success', true,
    'messages_marked', v_count
  );
END;
$function$;
