/*
# Change events.whatsapp_template_id from uuid to text

## Purpose
Meta WhatsApp template IDs are numeric strings (e.g. "3304832433029012"),
not UUIDs. The existing column type `uuid` cannot store these values.
This migration changes the column type to `text` so it can hold Meta template IDs.

## Safety
- All existing rows have `whatsapp_template_id = NULL` (verified before migration).
- No data is lost — the column is nullable and all values are NULL.
- No foreign keys exist on this column (confirmed in audit).
- No indexes exist on this column.
- No code currently reads or writes this column.

## Changes
- `events.whatsapp_template_id`: type changed from `uuid` to `text`
- Column remains nullable, default remains NULL

## Important Notes
1. This does NOT touch `events.message_template_id` (uuid, with FK constraints).
2. This does NOT touch `events.whatsapp_template_name` (text, added in prior migration).
3. This does NOT touch `events.whatsapp_image_url` (text).
4. No RLS policy changes.
5. No constraint changes.
*/
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'events'
      AND column_name = 'whatsapp_template_id'
      AND data_type = 'uuid'
  ) THEN
    ALTER TABLE public.events
      ALTER COLUMN whatsapp_template_id TYPE text
      USING whatsapp_template_id::text;
  END IF;
END $$;
