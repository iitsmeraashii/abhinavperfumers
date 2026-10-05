/*
# Create mark_samples_processed RPC

1. Purpose
   Allows a sales rep or admin to mark an OPEN samples_requested row as PROCESSED.
   The RPC enforces access control via has_whatsapp_conversation_access and
   sets processed_by server-side to auth.uid() — the client never controls this field.

2. RPC: mark_samples_processed
   - Parameters:
     - p_conversation_id uuid — the conversation whose samples request to process
     - p_note text — optional processing note (blank becomes NULL)
   - Security: SECURITY DEFINER, search_path = 'public'
   - Access check: has_whatsapp_conversation_access(p_conversation_id)
   - Business rules:
     - No samples_requested row → error 'No samples request found for this conversation'
     - Row already PROCESSED → error 'Samples request has already been processed'
     - Only OPEN rows can be transitioned to PROCESSED
   - On success updates:
     - status = 'PROCESSED'
     - processed_at = now()
     - processed_by = auth.uid()
     - processed_note = NULLIF(TRIM(p_note), '')
   - Returns jsonb with success flag, id, status, processed_at, processed_by

3. Security
   - No RLS policy changes.
   - No schema changes to samples_requested.
   - processed_by is always set to auth.uid() server-side.
*/

CREATE OR REPLACE FUNCTION public.mark_samples_processed(
  p_conversation_id uuid,
  p_note text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_row      public.samples_requested%ROWTYPE;
  v_exists   boolean;
BEGIN
  -- ── Access check ──
  IF NOT public.has_whatsapp_conversation_access(p_conversation_id) THEN
    RAISE EXCEPTION 'Conversation not found';
  END IF;

  -- ── Find the samples_requested row ──
  SELECT * INTO v_row
  FROM public.samples_requested
  WHERE conversation_id = p_conversation_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'No samples request found for this conversation'
    );
  END IF;

  -- ── Guard: only OPEN can be processed ──
  IF v_row.status = 'PROCESSED' THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Samples request has already been processed'
    );
  END IF;

  IF v_row.status <> 'OPEN' THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Samples request is not in a processable state'
    );
  END IF;

  -- ── Update ──
  UPDATE public.samples_requested
  SET
    status         = 'PROCESSED',
    processed_at   = now(),
    processed_by   = auth.uid(),
    processed_note = NULLIF(TRIM(p_note), ''),
    updated_at     = now()
  WHERE conversation_id = p_conversation_id
    AND status = 'OPEN';

  RETURN jsonb_build_object(
    'success', true,
    'id', v_row.id,
    'conversation_id', p_conversation_id,
    'status', 'PROCESSED',
    'processed_at', now(),
    'processed_by', auth.uid()
  );
END;
$function$;
