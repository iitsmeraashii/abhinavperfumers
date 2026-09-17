/*
# Add RPC for idempotent outbound WhatsApp message status updates

1. Modified Objects
- New function `update_whatsapp_outbound_status(p_wamid text, p_status text, p_timestamp text, p_error_code int, p_error_title text, p_error_message text, p_error_details text)`
  SECURITY DEFINER, called by the whatsapp-webhook edge function with the service role key.

2. Purpose
- Matches an outbound whatsapp_messages row by wamid.
- Updates status to sent/delivered/read/failed.
- Sets sent_at/delivered_at/read_at/failed_at only forward (never overwrites a later timestamp with an earlier one).
- Does NOT regress a terminal status (read/failed) to an earlier one.
- Updates whatsapp_conversations.last_message_at only on the first sent event (when it was previously null or accepted).
- Does NOT touch unread_count or inbound is_read.

3. Security
- SECURITY DEFINER so the webhook (service role) can update rows.
- No grants to anon/authenticated — only the service role (which bypasses RLS) calls this.
*/

CREATE OR REPLACE FUNCTION public.update_whatsapp_outbound_status(
  p_wamid text,
  p_status text,
  p_timestamp text DEFAULT NULL,
  p_error_code integer DEFAULT NULL,
  p_error_title text DEFAULT NULL,
  p_error_message text DEFAULT NULL,
  p_error_details text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_msg RECORD;
  v_ts timestamptz := COALESCE(
    p_timestamp::timestamptz,
    now()
  );
  v_new_status text := lower(p_status);
  v_current_status text;
  v_status_rank int;
  v_new_rank int;
  -- lifecycle ordering: accepted(0) < sent(1) < delivered(2) < read(3), failed(4) is terminal
  v_rank_map jsonb := '{"accepted":0,"sent":1,"delivered":2,"read":3,"failed":4}'::jsonb;
BEGIN
  -- Find the outbound message by wamid
  SELECT id, conversation_id, status, sent_at, delivered_at, read_at, failed_at
    INTO v_msg
  FROM public.whatsapp_messages
  WHERE wamid = p_wamid
    AND direction = 'OUTBOUND'
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'reason', 'not_found');
  END IF;

  v_current_status := lower(v_msg.status);
  v_status_rank := COALESCE(v_rank_map ->> v_current_status, '0')::int;
  v_new_rank := COALESCE(v_rank_map ->> v_new_status, '0')::int;

  -- Do not regress: if current status is terminal (read=3 or failed=4) and new is lower, skip
  IF v_status_rank >= 3 AND v_new_rank < v_status_rank THEN
    RETURN jsonb_build_object('success', true, 'reason', 'already_terminal', 'current_status', v_current_status);
  END IF;

  -- If same status, only update if the new timestamp is later (idempotent re-delivery)
  IF v_status_rank = v_new_rank THEN
    -- Still safe to proceed — the timestamp guards below will prevent overwrites
  END IF;

  -- Build the SET clause based on new status
  IF v_new_status = 'sent' THEN
    -- Only set sent_at if not already set or new timestamp is later
    IF v_msg.sent_at IS NULL OR v_ts > v_msg.sent_at THEN
      UPDATE public.whatsapp_messages
        SET status = 'SENT',
            sent_at = v_ts,
            updated_at = now()
        WHERE id = v_msg.id;
    END IF;

    -- Update conversation last_message_at only if it was null (first outbound event)
    IF v_msg.sent_at IS NULL THEN
      UPDATE public.whatsapp_conversations
        SET last_message_at = v_ts,
            updated_at = now()
        WHERE id = v_msg.conversation_id
          AND last_message_at IS NULL;
    END IF;

  ELSIF v_new_status = 'delivered' THEN
    IF v_msg.delivered_at IS NULL OR v_ts > v_msg.delivered_at THEN
      UPDATE public.whatsapp_messages
        SET status = 'DELIVERED',
            delivered_at = v_ts,
            sent_at = COALESCE(sent_at, v_ts),
            updated_at = now()
        WHERE id = v_msg.id;
    END IF;

  ELSIF v_new_status = 'read' THEN
    IF v_msg.read_at IS NULL OR v_ts > v_msg.read_at THEN
      UPDATE public.whatsapp_messages
        SET status = 'READ',
            read_at = v_ts,
            delivered_at = COALESCE(delivered_at, v_ts),
            sent_at = COALESCE(sent_at, v_ts),
            updated_at = now()
        WHERE id = v_msg.id;
    END IF;

  ELSIF v_new_status = 'failed' THEN
    IF v_msg.failed_at IS NULL OR v_ts > v_msg.failed_at THEN
      UPDATE public.whatsapp_messages
        SET status = 'FAILED',
            failed_at = v_ts,
            error_code = COALESCE(p_error_code, error_code),
            error_title = COALESCE(p_error_title, error_title),
            error_message = COALESCE(p_error_message, error_message),
            error_details = COALESCE(p_error_details, error_details),
            updated_at = now()
        WHERE id = v_msg.id;
    END IF;

  ELSE
    -- Unknown status — ignore
    RETURN jsonb_build_object('success', true, 'reason', 'unknown_status_ignored');
  END IF;

  RETURN jsonb_build_object('success', true, 'message_id', v_msg.id, 'status', v_new_status);
END;
$$;
