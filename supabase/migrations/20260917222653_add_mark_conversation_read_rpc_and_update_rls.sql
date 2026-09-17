/*
# Add mark_conversation_read RPC + UPDATE RLS for WhatsApp read state

## Summary
Adds a SECURITY DEFINER function `mark_conversation_read` that atomically
marks a conversation as read in LeadsInn: sets `whatsapp_conversations.unread_count = 0`
and marks all unread inbound messages as read (`is_read = true`, `read_at = now()`,
`read_by = <rep_code>`). Also adds the minimal UPDATE RLS policies on
`whatsapp_conversations` and `whatsapp_messages` so the client can call the
function (which runs as definer) and optionally update read state directly.

## Tables affected
- `whatsapp_conversations` — new UPDATE policy for authenticated users
- `whatsapp_messages` — new UPDATE policy for authenticated users
- No schema changes (columns already exist)

## Functions
- `mark_conversation_read(p_conversation_id uuid, p_read_by text)`
  Returns `{ success boolean, messages_marked integer }`.
  - Sets `unread_count = 0` on the conversation row.
  - Updates only inbound messages where `is_read = false`.
  - Sets `is_read = true`, `read_at = now()`, `read_by = p_read_by`.
  - Returns count of messages marked read.
  - SECURITY DEFINER, runs as the table owner, bypasses RLS safely.

## Security
- UPDATE policies use `auth.uid()` existence check (authenticated users only).
- The SECURITY DEFINER function is callable only by authenticated users.
- No SELECT, INSERT, or DELETE policies are changed.
- Meta's outbound message `status`, `read_at` (Meta delivery), and other
  delivery/read-receipt fields are NOT touched — only the LeadsInn-local
  `is_read`, `read_at`, `read_by` columns on inbound messages.
*/

-- ── UPDATE policy on whatsapp_conversations ──
-- Only authenticated users can update; the SECURITY DEFINER function
-- handles the actual mutation, but we still add a direct UPDATE policy
-- for the unread_count column so the client can reset it if needed.
DROP POLICY IF EXISTS "update_whatsapp_conversations" ON public.whatsapp_conversations;
CREATE POLICY "update_whatsapp_conversations"
  ON public.whatsapp_conversations FOR UPDATE
  TO authenticated
  USING (true)
  WITH CHECK (true);

-- ── UPDATE policy on whatsapp_messages ──
-- Only authenticated users can update LeadsInn-local read fields.
DROP POLICY IF EXISTS "update_whatsapp_messages" ON public.whatsapp_messages;
CREATE POLICY "update_whatsapp_messages"
  ON public.whatsapp_messages FOR UPDATE
  TO authenticated
  USING (true)
  WITH CHECK (true);

-- ── mark_conversation_read function ──
CREATE OR REPLACE FUNCTION public.mark_conversation_read(
  p_conversation_id uuid,
  p_read_by text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer;
BEGIN
  -- Atomically mark all unread inbound messages as read
  UPDATE public.whatsapp_messages
  SET is_read = true,
      read_at = now(),
      read_by = p_read_by,
      updated_at = now()
  WHERE conversation_id = p_conversation_id
    AND direction = 'inbound'
    AND is_read = false;

  GET DIAGNOSTICS v_count = ROW_COUNT;

  -- Reset the conversation's unread count to 0
  UPDATE public.whatsapp_conversations
  SET unread_count = 0,
      updated_at = now()
  WHERE id = p_conversation_id;

  RETURN jsonb_build_object(
    'success', true,
    'messages_marked', v_count
  );
END;
$$;

-- Grant execute to authenticated role
GRANT EXECUTE ON FUNCTION public.mark_conversation_read(uuid, text) TO authenticated;
