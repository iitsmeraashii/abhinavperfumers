/*
# Add whatsapp_template_name to events table

## Purpose
Adds a single new column `whatsapp_template_name` (text, nullable) to the `events` table.
This stores the Meta WhatsApp template name alongside the existing `whatsapp_template_id`,
so that future n8n WhatsApp sending workflows have both the ID and name without
needing a second API lookup.

## New Columns
- `events.whatsapp_template_name` (text, nullable, default NULL)
  Stores the Meta template name (e.g. "event_follow_up") that corresponds to
  `events.whatsapp_template_id`. Both fields must always refer to the same
  Meta template object.

## Existing Columns (NOT modified)
- `events.whatsapp_template_id` — already exists (uuid, nullable), unused until now
- `events.whatsapp_image_url` — already exists (text, nullable), unused until now
- `events.message_template_id` — existing FK to message_templates, NOT touched

## Security
- No RLS policy changes. Existing `events` RLS policies remain as-is.
- No new tables, no new constraints, no new indexes.

## Important Notes
1. This migration is purely additive — one new nullable column.
2. All existing events remain valid (column defaults to NULL).
3. No existing columns are modified, renamed, or removed.
4. No foreign keys are added or changed.
5. The existing `message_template_id` FK constraints are NOT touched.
*/
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'events'
      AND column_name = 'whatsapp_template_name'
  ) THEN
    ALTER TABLE public.events
      ADD COLUMN whatsapp_template_name text DEFAULT NULL;
  END IF;
END $$;
