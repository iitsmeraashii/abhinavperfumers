/*
# Auto-link leads to WhatsApp conversations by phone number

## Purpose
When a lead is created via the capture flow (capturePromotionService), it is inserted
into `lead_entries` but NOT linked to any existing WhatsApp conversation in the
`whatsapp_conversation_leads` bridge table. This means the conversation detail
page's "Linked Leads" list only shows leads that were created from within a
conversation or manually linked. Leads with the same phone number created via
capture are invisible in the conversation's linked leads list.

This migration adds:
1. A `normalize_whatsapp_phone(text)` function that normalizes Indian and
   international phone numbers to the format used in
   `whatsapp_conversations.wa_phone_number` (digits only, with country code).
2. A SECURITY DEFINER RPC `link_lead_to_conversation_by_phone(p_lead_id uuid)`
   that normalizes the lead's phone, finds a matching conversation, and
   idempotently inserts a bridge row. SECURITY DEFINER is required because the
   bridge table's INSERT RLS policy checks `has_whatsapp_conversation_access`
   which requires an existing link — a chicken-and-egg problem for new leads.
3. A backfill that links all existing unlinked leads to conversations by phone.

## Normalization rules (normalize_whatsapp_phone)
- Strip spaces, hyphens, parentheses, dots.
- If starts with `+`: keep all digits after `+` (international, already has country code).
- If 10 digits starting with `0`: strip leading `0`, prepend `91` (Indian local).
- If 10 digits (no leading zero): prepend `91` (Indian local).
- If 12 digits starting with `91`: keep as-is (already Indian international).
- If 11 digits starting with `0`: strip leading `0`, prepend `91`.
- Otherwise: return digits as-is (assume already normalized or international).

## Security
- `link_lead_to_conversation_by_phone` is SECURITY DEFINER, executable by
  `authenticated` only. It verifies the caller owns the lead (via
  sales_representatives.auth_user_id) before linking. Admins can link any lead.
- No changes to existing RLS policies on whatsapp_conversation_leads.
*/

-- ── 1. normalize_whatsapp_phone function ────────────────────────────────────

CREATE OR REPLACE FUNCTION public.normalize_whatsapp_phone(p_raw text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_cleaned text;
  v_digits text;
BEGIN
  IF p_raw IS NULL OR btrim(p_raw) = '' THEN
    RETURN NULL;
  END IF;

  -- Remove spaces, hyphens, parentheses, dots, and the + prefix
  v_cleaned := regexp_replace(p_raw, '[\s\-\(\)\.]', '', 'g');

  IF v_cleaned LIKE '+%' THEN
    -- International format: strip the + and keep all digits
    v_digits := regexp_replace(v_cleaned, '[^0-9]', '', 'g');
    IF length(v_digits) >= 7 THEN
      RETURN v_digits;
    END IF;
    RETURN NULL;
  END IF;

  -- Extract all digits
  v_digits := regexp_replace(v_cleaned, '[^0-9]', '', 'g');

  IF length(v_digits) < 7 THEN
    RETURN NULL;
  END IF;

  -- Indian local: 10 digits starting with 0 → strip 0, prepend 91
  IF length(v_digits) = 11 AND v_digits LIKE '0%' THEN
    RETURN '91' || substring(v_digits, 2);
  END IF;

  -- Indian local: 10 digits, no leading zero → prepend 91
  IF length(v_digits) = 10 AND v_digits NOT LIKE '0%' THEN
    RETURN '91' || v_digits;
  END IF;

  -- Already has 91 prefix (12 digits starting with 91)
  IF length(v_digits) = 12 AND v_digits LIKE '91%' THEN
    RETURN v_digits;
  END IF;

  -- Anything else: return as-is (already has country code, or international)
  RETURN v_digits;
END;
$$;

-- ── 2. link_lead_to_conversation_by_phone RPC ────────────────────────────────

CREATE OR REPLACE FUNCTION public.link_lead_to_conversation_by_phone(p_lead_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_lead record;
  v_normalized_phone text;
  v_conversation_id uuid;
  v_is_admin boolean;
  v_is_owner boolean;
BEGIN
  -- Load the lead's phone numbers
  SELECT phones, sales_rep_code
  INTO v_lead
  FROM lead_entries
  WHERE id = p_lead_id;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  -- Authorization: caller must be admin or own the lead
  SELECT is_admin_user() INTO v_is_admin;

  IF NOT v_is_admin THEN
    SELECT EXISTS(
      SELECT 1 FROM sales_representatives sr
      WHERE sr.rep_code = v_lead.sales_rep_code
      AND sr.auth_user_id = auth.uid()
    ) INTO v_is_owner;

    IF NOT v_is_owner THEN
      RETURN false;
    END IF;
  END IF;

  -- Normalize the first non-null phone number
  IF v_lead.phones IS NULL OR array_length(v_lead.phones, 1) IS NULL THEN
    RETURN false;
  END IF;

  SELECT normalize_whatsapp_phone(phones[1])
  INTO v_normalized_phone
  FROM lead_entries
  WHERE id = p_lead_id;

  IF v_normalized_phone IS NULL THEN
    RETURN false;
  END IF;

  -- Find a conversation matching this phone number
  SELECT id
  INTO v_conversation_id
  FROM whatsapp_conversations
  WHERE wa_phone_number = v_normalized_phone
  ORDER BY last_message_at DESC NULLS LAST
  LIMIT 1;

  IF v_conversation_id IS NULL THEN
    RETURN false;
  END IF;

  -- Idempotent insert: ignore if already linked
  INSERT INTO whatsapp_conversation_leads (conversation_id, lead_entry_id, linked_at)
  VALUES (v_conversation_id, p_lead_id::text, now())
  ON CONFLICT (conversation_id, lead_entry_id) DO NOTHING;

  RETURN true;
END;
$$;

-- Grant execute to authenticated
GRANT EXECUTE ON FUNCTION public.link_lead_to_conversation_by_phone(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.normalize_whatsapp_phone(text) TO authenticated;

-- ── 3. Backfill: link existing unlinked leads ────────────────────────────────

DO $$
DECLARE
  v_lead record;
  v_normalized_phone text;
  v_conversation_id uuid;
  v_linked_count int := 0;
BEGIN
  FOR v_lead IN
    SELECT le.id, le.phones
    FROM lead_entries le
    WHERE le.phones IS NOT NULL
    AND array_length(le.phones, 1) > 0
    AND NOT EXISTS (
      SELECT 1 FROM whatsapp_conversation_leads wcl
      WHERE wcl.lead_entry_id = le.id::text
    )
  LOOP
    v_normalized_phone := normalize_whatsapp_phone(v_lead.phones[1]);
    IF v_normalized_phone IS NULL THEN
      CONTINUE;
    END IF;

    SELECT id INTO v_conversation_id
    FROM whatsapp_conversations
    WHERE wa_phone_number = v_normalized_phone
    ORDER BY last_message_at DESC NULLS LAST
    LIMIT 1;

    IF v_conversation_id IS NOT NULL THEN
      INSERT INTO whatsapp_conversation_leads (conversation_id, lead_entry_id, linked_at)
      VALUES (v_conversation_id, v_lead.id::text, now())
      ON CONFLICT (conversation_id, lead_entry_id) DO NOTHING;

      v_linked_count := v_linked_count + 1;
    END IF;
  END LOOP;

  RAISE NOTICE 'Backfill linked % leads to conversations', v_linked_count;
END;
$$;
