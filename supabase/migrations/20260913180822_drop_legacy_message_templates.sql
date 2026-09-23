/*
# Drop legacy Message Templates system

## Summary
Removes the old local message_templates table and its foreign key from events.
The new Meta WhatsApp template system (events.whatsapp_template_id, events.whatsapp_template_name,
events.whatsapp_image_url, fetch-whatsapp-templates edge function, event-whatsapp-images bucket)
is completely separate and is NOT touched by this migration.

## Changes
1. Drop foreign key constraints on events.message_template_id:
   - events_template_id_fkey
   - fk_event_template
2. Drop column events.message_template_id
3. Drop table message_templates (including its RLS policies)
4. Drop storage policies for the template-images bucket

## Data loss
- 2 rows in message_templates ("Simple Follow-up", "CMPL Follow-up") — legacy, no longer used
- 2 non-null values in events.message_template_id (CMPL2026, DEFAULT) — no longer read by any UI

## Important
- The Meta Graph API endpoint /message_templates used by the fetch-whatsapp-templates
  edge function is part of the NEW system and is unaffected.
- The template-images storage bucket objects must be deleted via the Storage API,
  not via direct SQL DELETE. The bucket itself and its policies are cleaned up here
  at the policy level. The bucket row deletion is handled separately.
*/

-- 1. Drop foreign key constraints on events.message_template_id
ALTER TABLE IF EXISTS public.events
  DROP CONSTRAINT IF EXISTS events_template_id_fkey;

ALTER TABLE IF EXISTS public.events
  DROP CONSTRAINT IF EXISTS fk_event_template;

-- 2. Drop the message_template_id column from events
ALTER TABLE IF EXISTS public.events
  DROP COLUMN IF EXISTS message_template_id;

-- 3. Drop RLS policies on message_templates (must drop before table)
DROP POLICY IF EXISTS "template_select" ON public.message_templates;
DROP POLICY IF EXISTS "template_insert" ON public.message_templates;
DROP POLICY IF EXISTS "template_update" ON public.message_templates;
DROP POLICY IF EXISTS "template_delete" ON public.message_templates;

-- 4. Drop the message_templates table
DROP TABLE IF EXISTS public.message_templates;

-- 5. Drop storage policies for the template-images bucket
DROP POLICY IF EXISTS "Public read template images" ON storage.objects;
DROP POLICY IF EXISTS "Allow upload template images" ON storage.objects;
DROP POLICY IF EXISTS "Allow delete template images" ON storage.objects;
DROP POLICY IF EXISTS "Allow update template images" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated read template images" ON storage.objects;
