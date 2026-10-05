/*
# Create samples_requested table

## Purpose
Creates a conversation-level "Samples Requested" action item / notification table.
This is a work item that tells a sales rep: "Something related to samples was
requested in this WhatsApp conversation. Open the conversation and follow up."
It is NOT a lead-level entity and NOT a detailed sample-order record.

## Relationship
  whatsapp_conversations (1) ──< (0..1) samples_requested

  conversation_id is UNIQUE and NOT NULL, enforcing at most one row per
  conversation. No lead_id column — the samples-requested item belongs only
  to the conversation, not to any individual lead linked via
  whatsapp_conversation_leads.

## New Table: samples_requested

  id              — uuid, PK, auto-generated (gen_random_uuid)
  conversation_id — uuid, NOT NULL, FK → whatsapp_conversations.id ON DELETE CASCADE, UNIQUE
  requested_at    — timestamptz, NOT NULL — when the sample request was received
  status          — text, NOT NULL, CHECK (OPEN|PROCESSED), default 'OPEN'
  processed_at    — timestamptz, nullable — populated when marked PROCESSED
  processed_by    — uuid, nullable — auth user id of the rep who processed it
  created_at      — timestamptz, NOT NULL, default now()
  updated_at      — timestamptz, NOT NULL, default now()

## Repeated-request behavior
  Because the relationship is 1:0..1, a PROCESSED row can be reopened by
  setting status back to OPEN, updating requested_at, and clearing
  processed_at / processed_by. This is handled at the application layer;
  the database schema permits the transition via the CHECK constraint.

## Security / RLS
  RLS is enabled. All four CRUD policies (SELECT, INSERT, UPDATE, DELETE)
  are scoped to authenticated users who pass the existing
  has_whatsapp_conversation_access(conversation_id) SECURITY DEFINER
  function. This function returns true for admins or for sales reps who
  own at least one lead linked to the conversation via
  whatsapp_conversation_leads. No broad "authenticated can do everything"
  policies are created.

## Conventions followed
  - UUID PK with gen_random_uuid() (matches whatsapp_conversations, lead_activities)
  - timestamptz with DEFAULT now() (matches whatsapp_conversations)
  - text status + CHECK constraint (matches lead_entries.lead_status, lead_follow_ups.status)
  - processed_by as uuid referencing auth uid (matches lead_activities.actor_user_id)
  - ON DELETE CASCADE on conversation FK (matches whatsapp_conversation_leads)
  - updated_at trigger to auto-maintain the column
  - RLS via existing has_whatsapp_conversation_access helper (matches whatsapp_conversations policies)
*/

-- ── Table ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.samples_requested (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid        NOT NULL,
  requested_at    timestamptz NOT NULL,
  status          text        NOT NULL DEFAULT 'OPEN'::text,
  processed_at    timestamptz,
  processed_by    uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT samples_requested_conversation_id_fkey
    FOREIGN KEY (conversation_id)
    REFERENCES public.whatsapp_conversations(id)
    ON DELETE CASCADE,
  CONSTRAINT samples_requested_conversation_id_key
    UNIQUE (conversation_id),
  CONSTRAINT samples_requested_status_check
    CHECK (status IN ('OPEN', 'PROCESSED'))
);

-- ── Indexes ────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_samples_requested_status
  ON public.samples_requested (status);

CREATE INDEX IF NOT EXISTS idx_samples_requested_requested_at
  ON public.samples_requested (requested_at DESC);

-- ── updated_at trigger ─────────────────────────────────────────────────
-- Matches the pattern used by whatsapp_conversations (set_whatsapp_assets_updated_at
-- and set_processing_queue_updated_at follow this same convention).

CREATE OR REPLACE FUNCTION public.set_samples_requested_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_samples_requested_updated_at ON public.samples_requested;

CREATE TRIGGER trg_samples_requested_updated_at
  BEFORE UPDATE ON public.samples_requested
  FOR EACH ROW
  EXECUTE FUNCTION public.set_samples_requested_updated_at();

-- ── RLS ────────────────────────────────────────────────────────────────
ALTER TABLE public.samples_requested ENABLE ROW LEVEL SECURITY;

-- SELECT: authenticated users with conversation access
DROP POLICY IF EXISTS "select_samples_requested" ON public.samples_requested;
CREATE POLICY "select_samples_requested"
  ON public.samples_requested FOR SELECT
  TO authenticated
  USING (public.has_whatsapp_conversation_access(conversation_id));

-- INSERT: authenticated users with conversation access
DROP POLICY IF EXISTS "insert_samples_requested" ON public.samples_requested;
CREATE POLICY "insert_samples_requested"
  ON public.samples_requested FOR INSERT
  TO authenticated
  WITH CHECK (public.has_whatsapp_conversation_access(conversation_id));

-- UPDATE: authenticated users with conversation access
DROP POLICY IF EXISTS "update_samples_requested" ON public.samples_requested;
CREATE POLICY "update_samples_requested"
  ON public.samples_requested FOR UPDATE
  TO authenticated
  USING (public.has_whatsapp_conversation_access(conversation_id))
  WITH CHECK (public.has_whatsapp_conversation_access(conversation_id));

-- DELETE: authenticated users with conversation access
DROP POLICY IF EXISTS "delete_samples_requested" ON public.samples_requested;
CREATE POLICY "delete_samples_requested"
  ON public.samples_requested FOR DELETE
  TO authenticated
  USING (public.has_whatsapp_conversation_access(conversation_id));
