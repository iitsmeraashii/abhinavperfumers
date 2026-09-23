/*
# WhatsApp Conversation Access Control (RLS)

## Purpose
Replace the current open-access RLS policies on WhatsApp conversation tables
with lead-assignment-based row-level security. This ensures sales reps can
only see and interact with conversations linked to at least one lead
assigned to them, while admins retain full access.

## Authorization Model
- **admin**: Full access to all conversations, messages, and conversation-lead links.
- **sales_rep**: Can only access conversations where AT LEAST ONE linked lead
  is assigned to them (via `lead_entries.sales_rep_code` matching the rep's
  `rep_code`). Access follows lead reassignment automatically because the
  check joins through `lead_entries.sales_rep_code` at query time.

## Helper Functions
1. `get_current_rep_code()` — SECURITY DEFINER, returns the calling user's
   `rep_code` from `sales_representatives` based on `auth.uid()`. Returns NULL
   for unauthenticated or unlinked users. This avoids recursion issues since
   `sales_representatives` has its own RLS policies.

## Tables Modified (RLS policies replaced)
1. **whatsapp_conversations**
   - SELECT: admin OR (EXISTS linked lead assigned to caller's rep_code)
   - UPDATE: admin OR (EXISTS linked lead assigned to caller's rep_code)

2. **whatsapp_messages**
   - SELECT: admin OR (EXISTS linked lead on the message's conversation
     assigned to caller's rep_code)
   - UPDATE: admin OR (same ownership check)

3. **whatsapp_conversation_leads**
   - SELECT: admin OR (EXISTS another linked lead on the same conversation
     assigned to caller's rep_code — i.e., the rep can see link rows for
     conversations they already have access to)
   - INSERT: admin OR (EXISTS a linked lead on the same conversation assigned
     to caller's rep_code — rep can add more links to conversations they own)
   - DELETE: admin OR (the lead_entry_id being deleted belongs to the caller's
     rep_code, OR the conversation has another linked lead assigned to the
     caller — rep can unlink their own leads or unlink from conversations
     they own)

## Notes
- The `mark_conversation_read` RPC is SECURITY DEFINER and bypasses RLS, so
  it continues to work for both admin and sales_rep. It should be updated
  separately to add an ownership check, but that is a code change, not a
  schema change.
- The `whatsapp-webhook` edge function inserts messages using the service
  role key, which bypasses RLS — this is correct and unchanged.
- The `send-whatsapp-message` edge function also uses the service role key
  and bypasses RLS — it needs a separate code update to add caller
  authorization verification.
*/

-- ── Helper Function: get_current_rep_code ──────────────────────────────────
-- SECURITY DEFINER to avoid RLS recursion on sales_representatives.
-- Returns the rep_code of the authenticated user, or NULL.

CREATE OR REPLACE FUNCTION public.get_current_rep_code()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT rep_code
  FROM public.sales_representatives
  WHERE auth_user_id = auth.uid()
  LIMIT 1;
$function$;

-- ── whatsapp_conversations: Replace open policies ──────────────────────────

DROP POLICY IF EXISTS "select_whatsapp_conversations" ON public.whatsapp_conversations;
DROP POLICY IF EXISTS "update_whatsapp_conversations" ON public.whatsapp_conversations;

-- SELECT: admin sees all; sales_rep sees conversations with at least one linked lead assigned to them
CREATE POLICY "select_whatsapp_conversations"
ON public.whatsapp_conversations FOR SELECT
TO authenticated
USING (
  public.is_admin_user()
  OR (
    public.get_current_rep_code() IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM public.whatsapp_conversation_leads wcl
      JOIN public.lead_entries le ON le.id = wcl.lead_entry_id
      WHERE wcl.conversation_id = whatsapp_conversations.id
        AND le.sales_rep_code = public.get_current_rep_code()
    )
  )
);

-- UPDATE: admin can update any; sales_rep can update conversations they have access to
CREATE POLICY "update_whatsapp_conversations"
ON public.whatsapp_conversations FOR UPDATE
TO authenticated
USING (
  public.is_admin_user()
  OR (
    public.get_current_rep_code() IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM public.whatsapp_conversation_leads wcl
      JOIN public.lead_entries le ON le.id = wcl.lead_entry_id
      WHERE wcl.conversation_id = whatsapp_conversations.id
        AND le.sales_rep_code = public.get_current_rep_code()
    )
  )
)
WITH CHECK (
  public.is_admin_user()
  OR (
    public.get_current_rep_code() IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM public.whatsapp_conversation_leads wcl
      JOIN public.lead_entries le ON le.id = wcl.lead_entry_id
      WHERE wcl.conversation_id = whatsapp_conversations.id
        AND le.sales_rep_code = public.get_current_rep_code()
    )
  )
);

-- ── whatsapp_messages: Replace open policies ───────────────────────────────

DROP POLICY IF EXISTS "select_whatsapp_messages" ON public.whatsapp_messages;
DROP POLICY IF EXISTS "update_whatsapp_messages" ON public.whatsapp_messages;

-- SELECT: admin sees all; sales_rep sees messages in conversations they have access to
CREATE POLICY "select_whatsapp_messages"
ON public.whatsapp_messages FOR SELECT
TO authenticated
USING (
  public.is_admin_user()
  OR (
    public.get_current_rep_code() IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM public.whatsapp_conversation_leads wcl
      JOIN public.lead_entries le ON le.id = wcl.lead_entry_id
      WHERE wcl.conversation_id = whatsapp_messages.conversation_id
        AND le.sales_rep_code = public.get_current_rep_code()
    )
  )
);

-- UPDATE: admin can update any; sales_rep can update messages in conversations they have access to
CREATE POLICY "update_whatsapp_messages"
ON public.whatsapp_messages FOR UPDATE
TO authenticated
USING (
  public.is_admin_user()
  OR (
    public.get_current_rep_code() IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM public.whatsapp_conversation_leads wcl
      JOIN public.lead_entries le ON le.id = wcl.lead_entry_id
      WHERE wcl.conversation_id = whatsapp_messages.conversation_id
        AND le.sales_rep_code = public.get_current_rep_code()
    )
  )
)
WITH CHECK (
  public.is_admin_user()
  OR (
    public.get_current_rep_code() IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM public.whatsapp_conversation_leads wcl
      JOIN public.lead_entries le ON le.id = wcl.lead_entry_id
      WHERE wcl.conversation_id = whatsapp_messages.conversation_id
        AND le.sales_rep_code = public.get_current_rep_code()
    )
  )
);

-- ── whatsapp_conversation_leads: Replace open policies ─────────────────────

DROP POLICY IF EXISTS "select_whatsapp_conversation_leads" ON public.whatsapp_conversation_leads;
DROP POLICY IF EXISTS "insert_whatsapp_conversation_leads" ON public.whatsapp_conversation_leads;
DROP POLICY IF EXISTS "delete_whatsapp_conversation_leads" ON public.whatsapp_conversation_leads;

-- SELECT: admin sees all; sales_rep sees links for conversations they have access to
CREATE POLICY "select_whatsapp_conversation_leads"
ON public.whatsapp_conversation_leads FOR SELECT
TO authenticated
USING (
  public.is_admin_user()
  OR (
    public.get_current_rep_code() IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM public.whatsapp_conversation_leads wcl_inner
      JOIN public.lead_entries le ON le.id = wcl_inner.lead_entry_id
      WHERE wcl_inner.conversation_id = whatsapp_conversation_leads.conversation_id
        AND le.sales_rep_code = public.get_current_rep_code()
    )
  )
);

-- INSERT: admin can insert any; sales_rep can add links to conversations they already have access to
CREATE POLICY "insert_whatsapp_conversation_leads"
ON public.whatsapp_conversation_leads FOR INSERT
TO authenticated
WITH CHECK (
  public.is_admin_user()
  OR (
    public.get_current_rep_code() IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM public.whatsapp_conversation_leads wcl_inner
      JOIN public.lead_entries le ON le.id = wcl_inner.lead_entry_id
      WHERE wcl_inner.conversation_id = whatsapp_conversation_leads.conversation_id
        AND le.sales_rep_code = public.get_current_rep_code()
    )
  )
);

-- DELETE: admin can delete any; sales_rep can delete links if the lead belongs to them
-- OR if the conversation has another linked lead assigned to them
CREATE POLICY "delete_whatsapp_conversation_leads"
ON public.whatsapp_conversation_leads FOR DELETE
TO authenticated
USING (
  public.is_admin_user()
  OR (
    public.get_current_rep_code() IS NOT NULL
    AND (
      -- The lead being unlinked belongs to this rep
      EXISTS (
        SELECT 1
        FROM public.lead_entries le
        WHERE le.id = whatsapp_conversation_leads.lead_entry_id
          AND le.sales_rep_code = public.get_current_rep_code()
      )
      OR
      -- The conversation has another linked lead assigned to this rep
      EXISTS (
        SELECT 1
        FROM public.whatsapp_conversation_leads wcl_inner
        JOIN public.lead_entries le ON le.id = wcl_inner.lead_entry_id
        WHERE wcl_inner.conversation_id = whatsapp_conversation_leads.conversation_id
          AND wcl_inner.lead_entry_id <> whatsapp_conversation_leads.lead_entry_id
          AND le.sales_rep_code = public.get_current_rep_code()
      )
    )
  )
);
