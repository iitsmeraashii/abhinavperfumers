/*
# Add WhatsApp phone number ID to runtime configuration

1. Modified Tables
- `runtime_configuration` — new column `whatsapp_phone_number_id` (text, nullable)
  Stores the Meta WhatsApp Cloud API phone-number-scoped ID used as the sender
  for outbound messages. This is separate from META_WABA_ID (the WhatsApp Business
  Account ID) and META_PHONE_NUMBER_ID (which may be misconfigured with the WABA ID).

2. Data
- Sets the value to '1241930012343065' for the existing single row.

3. Security
- No RLS changes — the table already has RLS enabled and only admins can read it.
*/

ALTER TABLE public.runtime_configuration
  ADD COLUMN IF NOT EXISTS whatsapp_phone_number_id text;

UPDATE public.runtime_configuration
  SET whatsapp_phone_number_id = '1241930012343065'
  WHERE id = 1;
