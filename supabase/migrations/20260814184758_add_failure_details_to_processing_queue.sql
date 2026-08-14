/*
# Add failure detail columns to processing_queue and update retry RPC

## Summary
Adds columns for persisting processing failure diagnostics on the queue
record, and updates the increment_retry_count RPC to write them.

## Schema changes
- processing_queue.last_attempt_at  — timestamptz, nullable
- processing_queue.failed_at        — timestamptz, nullable
- processing_queue.failed_stage     — text, nullable (e.g. AI_EXTRACTION, PROMOTION)
- processing_queue.error_code       — text, nullable
- processing_queue.error_message    — text, nullable (user-safe error text)

## RPC update
Replaces increment_retry_count with a version that accepts the new
failure detail parameters and enforces the retry limit (retry_count < 3
required for the update to apply).

## Security
No RLS changes — the table's existing policies apply to the new columns.
The RPC is SECURITY DEFINER with auth.uid() check, same as before.
*/

ALTER TABLE processing_queue
  ADD COLUMN IF NOT EXISTS last_attempt_at  timestamptz,
  ADD COLUMN IF NOT EXISTS failed_at        timestamptz,
  ADD COLUMN IF NOT EXISTS failed_stage     text,
  ADD COLUMN IF NOT EXISTS error_code       text,
  ADD COLUMN IF NOT EXISTS error_message    text;

-- ── Replace increment_retry_count ───────────────────────────────────────────
-- The new signature accepts failure detail fields and enforces retry_count < 3.
-- Drops and recreates the function (idempotent via DROP FUNCTION IF EXISTS).

DROP FUNCTION IF EXISTS public.increment_retry_count(uuid, text, timestamptz);
DROP FUNCTION IF EXISTS public.increment_retry_count(uuid, text);

CREATE OR REPLACE FUNCTION public.increment_retry_count(
  p_job_id          uuid,
  p_failure_reason  text DEFAULT NULL,
  p_failed_stage    text DEFAULT NULL,
  p_error_code      text DEFAULT NULL,
  p_error_message   text DEFAULT NULL,
  p_scheduled_at    timestamptz DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_new_count integer;
BEGIN
  UPDATE public.processing_queue
  SET state                 = 'RETRYING',
      retry_count           = retry_count + 1,
      last_attempt_at       = now(),
      failed_at             = now(),
      failure_reason        = p_failure_reason,
      failed_stage          = p_failed_stage,
      error_code            = p_error_code,
      error_message         = p_error_message,
      scheduled_at          = p_scheduled_at,
      processing_started_at = null,
      updated_at            = now()
  WHERE id      = p_job_id
    AND user_id = auth.uid()
    AND state  IN ('PROCESSING', 'FAILED')
    AND retry_count < 3
  RETURNING retry_count INTO v_new_count;

  RETURN v_new_count;
END;
$$;

-- ── mark_failed: terminal failure for exhausted retries ──────────────────────
-- Sets state = FAILED with full failure detail. Used when retry_count >= 3
-- or when the error is non-retryable.

CREATE OR REPLACE FUNCTION public.mark_job_failed(
  p_job_id          uuid,
  p_failure_reason  text DEFAULT NULL,
  p_failed_stage    text DEFAULT NULL,
  p_error_code      text DEFAULT NULL,
  p_error_message   text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.processing_queue
  SET state               = 'FAILED',
      failed_at           = now(),
      processing_completed_at = now(),
      failure_reason      = p_failure_reason,
      failed_stage        = p_failed_stage,
      error_code          = p_error_code,
      error_message       = p_error_message,
      updated_at          = now()
  WHERE id      = p_job_id
    AND user_id = auth.uid();
END;
$$;
