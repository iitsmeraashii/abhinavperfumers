-- Fix: update_lead_with_audit function — correct jsonb array to text[] casting
--
-- The original function used (p_updates->'phones')::text[] which fails because
-- PostgreSQL cannot cast jsonb directly to text[]. This migration recreates the
-- function using ARRAY(SELECT jsonb_array_elements_text(...)) for array fields,
-- with a NULL guard for non-array jsonb values.

CREATE OR REPLACE FUNCTION update_lead_with_audit(
  p_lead_id  text,
  p_updates  jsonb
) RETURNS jsonb
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_current         jsonb;
  v_new             jsonb;
  v_actor_user_id   uuid;
  v_actor_rep_code  text;
  v_actor_name      text;
  v_actor_role      text;
  v_old_display     text;
  v_new_display     text;
  v_note            text;
  v_count           int := 0;
  v_field           text;
  v_text_fields     text[] := ARRAY[
    'client_name', 'designation', 'company', 'address', 'state',
    'notes', 'website', 'application', 'price_range',
    'quick_keywords', 'target_market', 'certification', 'benchmark'
  ];
  v_text_labels     text[] := ARRAY[
    'Client Name', 'Designation', 'Company', 'Address', 'State',
    'Notes', 'Website', 'Application', 'Price Range',
    'Quick Keywords', 'Target Market', 'Certification', 'Benchmark'
  ];
  v_array_fields    text[] := ARRAY['phones', 'emails'];
  v_array_labels    text[] := ARRAY['Phone', 'Email'];
  v_i               int;
BEGIN
  -- ── Derive actor from authenticated session (never trust client) ──
  SELECT sr.auth_user_id, sr.rep_code, sr.name, sr.role
  INTO v_actor_user_id, v_actor_rep_code, v_actor_name, v_actor_role
  FROM sales_representatives sr
  WHERE sr.auth_user_id = auth.uid();

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Unauthorized: no sales rep profile found for current user';
  END IF;

  -- ── Lock and read current row ──
  SELECT to_jsonb(le.*) INTO v_current
  FROM lead_entries le
  WHERE le.id = p_lead_id
  FOR UPDATE;

  IF v_current IS NULL THEN
    RAISE EXCEPTION 'Lead not found: %', p_lead_id;
  END IF;

  -- ── Authorization: sales_rep can only update own leads ──
  IF v_actor_role = 'sales_rep' AND v_current->>'sales_rep_code' != v_actor_rep_code THEN
    RAISE EXCEPTION 'Unauthorized: you can only update your own leads';
  END IF;

  -- ── Apply update ──
  UPDATE lead_entries SET
    client_name      = CASE WHEN p_updates ? 'client_name'      THEN NULLIF(p_updates->>'client_name', '')      ELSE client_name END,
    designation      = CASE WHEN p_updates ? 'designation'      THEN NULLIF(p_updates->>'designation', '')      ELSE designation END,
    company          = CASE WHEN p_updates ? 'company'          THEN NULLIF(p_updates->>'company', '')          ELSE company END,
    phones           = CASE WHEN p_updates ? 'phones'           THEN
                       CASE WHEN jsonb_typeof(p_updates->'phones') = 'array'
                         THEN ARRAY(SELECT jsonb_array_elements_text(p_updates->'phones'))
                         ELSE NULL END
                       ELSE phones END,
    emails           = CASE WHEN p_updates ? 'emails'           THEN
                       CASE WHEN jsonb_typeof(p_updates->'emails') = 'array'
                         THEN ARRAY(SELECT jsonb_array_elements_text(p_updates->'emails'))
                         ELSE NULL END
                       ELSE emails END,
    address          = CASE WHEN p_updates ? 'address'          THEN NULLIF(p_updates->>'address', '')          ELSE address END,
    state            = CASE WHEN p_updates ? 'state'            THEN NULLIF(p_updates->>'state', '')            ELSE state END,
    notes            = CASE WHEN p_updates ? 'notes'            THEN NULLIF(p_updates->>'notes', '')            ELSE notes END,
    website          = CASE WHEN p_updates ? 'website'          THEN NULLIF(p_updates->>'website', '')          ELSE website END,
    application      = CASE WHEN p_updates ? 'application'      THEN NULLIF(p_updates->>'application', '')      ELSE application END,
    price_range      = CASE WHEN p_updates ? 'price_range'      THEN NULLIF(p_updates->>'price_range', '')      ELSE price_range END,
    lead_temperature = CASE WHEN p_updates ? 'lead_temperature' THEN NULLIF(p_updates->>'lead_temperature', '') ELSE lead_temperature END,
    quick_keywords   = CASE WHEN p_updates ? 'quick_keywords'   THEN p_updates->>'quick_keywords'               ELSE quick_keywords END,
    target_market    = CASE WHEN p_updates ? 'target_market'    THEN p_updates->>'target_market'                ELSE target_market END,
    certification    = CASE WHEN p_updates ? 'certification'    THEN p_updates->>'certification'                ELSE certification END,
    benchmark        = CASE WHEN p_updates ? 'benchmark'        THEN p_updates->>'benchmark'                    ELSE benchmark END,
    lead_status      = CASE WHEN p_updates ? 'lead_status'      THEN p_updates->>'lead_status'                  ELSE lead_status END,
    sales_rep_code   = CASE WHEN p_updates ? 'sales_rep_code'   THEN NULLIF(p_updates->>'sales_rep_code', '')  ELSE sales_rep_code END,
    event_code       = CASE WHEN p_updates ? 'event_code'       THEN NULLIF(p_updates->>'event_code', '')       ELSE event_code END,
    is_reviewed      = CASE WHEN p_updates ? 'is_reviewed'      THEN (p_updates->>'is_reviewed')::boolean       ELSE is_reviewed END,
    reviewed_at      = CASE WHEN p_updates ? 'reviewed_at'      THEN (p_updates->>'reviewed_at')::timestamptz   ELSE reviewed_at END,
    reviewed_by      = CASE WHEN p_updates ? 'reviewed_by'      THEN NULLIF(p_updates->>'reviewed_by', '')      ELSE reviewed_by END,
    updated_at       = now()
  WHERE id = p_lead_id;

  -- ── Read updated row ──
  SELECT to_jsonb(le.*) INTO v_new
  FROM lead_entries le
  WHERE le.id = p_lead_id;

  -- ═══ Diff special fields ═════════════════════════════════════════════════════

  -- lead_status → STATUS_CHANGED
  IF p_updates ? 'lead_status' AND COALESCE(v_current->>'lead_status', '') <> COALESCE(v_new->>'lead_status', '') THEN
    v_old_display := CASE v_current->>'lead_status'
      WHEN 'NEW' THEN 'New' WHEN 'CONTACTED' THEN 'Contacted'
      WHEN 'QUALIFIED' THEN 'Samples Sent' WHEN 'CONVERTED' THEN 'Converted'
      WHEN 'LOST' THEN 'Lost' WHEN 'REQUIRES_REVIEW' THEN 'Requires Review'
      ELSE COALESCE(v_current->>'lead_status', 'Not set')
    END;
    v_new_display := CASE v_new->>'lead_status'
      WHEN 'NEW' THEN 'New' WHEN 'CONTACTED' THEN 'Contacted'
      WHEN 'QUALIFIED' THEN 'Samples Sent' WHEN 'CONVERTED' THEN 'Converted'
      WHEN 'LOST' THEN 'Lost' WHEN 'REQUIRES_REVIEW' THEN 'Requires Review'
      ELSE COALESCE(v_new->>'lead_status', 'Not set')
    END;
    v_note := format('Status changed from %s to %s', v_old_display, v_new_display);
    INSERT INTO lead_activities (lead_id, actor_user_id, actor_rep_code, actor_name, action_type, field_name, old_value, new_value, note)
    VALUES (p_lead_id, v_actor_user_id, v_actor_rep_code, v_actor_name, 'STATUS_CHANGED', 'lead_status', to_jsonb(v_old_display), to_jsonb(v_new_display), v_note);
    v_count := v_count + 1;
  END IF;

  -- sales_rep_code → SALES_REP_CHANGED
  IF p_updates ? 'sales_rep_code' AND COALESCE(v_current->>'sales_rep_code', '') <> COALESCE(v_new->>'sales_rep_code', '') THEN
    SELECT name INTO v_old_display FROM sales_representatives WHERE rep_code = v_current->>'sales_rep_code';
    v_old_display := COALESCE(v_old_display, v_current->>'sales_rep_code', 'Not set');
    SELECT name INTO v_new_display FROM sales_representatives WHERE rep_code = v_new->>'sales_rep_code';
    v_new_display := COALESCE(v_new_display, v_new->>'sales_rep_code', 'Not set');
    v_note := format('Sales Rep changed from %s to %s', v_old_display, v_new_display);
    INSERT INTO lead_activities (lead_id, actor_user_id, actor_rep_code, actor_name, action_type, field_name, old_value, new_value, note)
    VALUES (p_lead_id, v_actor_user_id, v_actor_rep_code, v_actor_name, 'SALES_REP_CHANGED', 'sales_rep_code', to_jsonb(v_old_display), to_jsonb(v_new_display), v_note);
    v_count := v_count + 1;
  END IF;

  -- event_code → EVENT_CHANGED
  IF p_updates ? 'event_code' AND COALESCE(v_current->>'event_code', '') <> COALESCE(v_new->>'event_code', '') THEN
    SELECT name INTO v_old_display FROM events WHERE event_code = v_current->>'event_code';
    v_old_display := COALESCE(v_old_display, v_current->>'event_code', 'Not set');
    SELECT name INTO v_new_display FROM events WHERE event_code = v_new->>'event_code';
    v_new_display := COALESCE(v_new_display, v_new->>'event_code', 'Not set');
    v_note := format('Event changed from %s to %s', v_old_display, v_new_display);
    INSERT INTO lead_activities (lead_id, actor_user_id, actor_rep_code, actor_name, action_type, field_name, old_value, new_value, note)
    VALUES (p_lead_id, v_actor_user_id, v_actor_rep_code, v_actor_name, 'EVENT_CHANGED', 'event_code', to_jsonb(v_old_display), to_jsonb(v_new_display), v_note);
    v_count := v_count + 1;
  END IF;

  -- lead_temperature → LEAD_TEMPERATURE_CHANGED
  IF p_updates ? 'lead_temperature' AND COALESCE(v_current->>'lead_temperature', '') <> COALESCE(v_new->>'lead_temperature', '') THEN
    v_old_display := COALESCE(NULLIF(v_current->>'lead_temperature', ''), 'Not set');
    v_new_display := COALESCE(NULLIF(v_new->>'lead_temperature', ''), 'Not set');
    v_note := format('Lead temperature changed from %s to %s', v_old_display, v_new_display);
    INSERT INTO lead_activities (lead_id, actor_user_id, actor_rep_code, actor_name, action_type, field_name, old_value, new_value, note)
    VALUES (p_lead_id, v_actor_user_id, v_actor_rep_code, v_actor_name, 'LEAD_TEMPERATURE_CHANGED', 'lead_temperature', to_jsonb(v_old_display), to_jsonb(v_new_display), v_note);
    v_count := v_count + 1;
  END IF;

  -- is_reviewed → REVIEWED (only when false → true)
  IF p_updates ? 'is_reviewed' AND (v_current->>'is_reviewed')::boolean IS DISTINCT FROM (v_new->>'is_reviewed')::boolean AND (v_new->>'is_reviewed')::boolean = true THEN
    v_note := 'Lead marked as reviewed';
    INSERT INTO lead_activities (lead_id, actor_user_id, actor_rep_code, actor_name, action_type, field_name, old_value, new_value, note)
    VALUES (p_lead_id, v_actor_user_id, v_actor_rep_code, v_actor_name, 'REVIEWED', 'is_reviewed', to_jsonb(false), to_jsonb(true), v_note);
    v_count := v_count + 1;
  END IF;

  -- ═══ Diff text fields (loop) ═════════════════════════════════════════════════

  FOR v_i IN 1..array_length(v_text_fields, 1) LOOP
    v_field := v_text_fields[v_i];
    IF p_updates ? v_field AND COALESCE(v_current->>v_field, '') <> COALESCE(v_new->>v_field, '') THEN
      v_old_display := _format_activity_value(v_current->v_field);
      v_new_display := _format_activity_value(v_new->v_field);
      v_note := format('%s changed from %s to %s', v_text_labels[v_i], v_old_display, v_new_display);
      INSERT INTO lead_activities (lead_id, actor_user_id, actor_rep_code, actor_name, action_type, field_name, old_value, new_value, note)
      VALUES (p_lead_id, v_actor_user_id, v_actor_rep_code, v_actor_name, 'FIELD_UPDATED', v_field, v_current->v_field, v_new->v_field, v_note);
      v_count := v_count + 1;
    END IF;
  END LOOP;

  -- ═══ Diff array fields (phones, emails) ═════════════════════════════════════

  FOR v_i IN 1..array_length(v_array_fields, 1) LOOP
    v_field := v_array_fields[v_i];
    IF p_updates ? v_field AND COALESCE(v_current->>v_field, '') <> COALESCE(v_new->>v_field, '') THEN
      v_old_display := _format_activity_value(v_current->v_field);
      v_new_display := _format_activity_value(v_new->v_field);
      v_note := format('%s changed from %s to %s', v_array_labels[v_i], v_old_display, v_new_display);
      INSERT INTO lead_activities (lead_id, actor_user_id, actor_rep_code, actor_name, action_type, field_name, old_value, new_value, note)
      VALUES (p_lead_id, v_actor_user_id, v_actor_rep_code, v_actor_name, 'FIELD_UPDATED', v_field, v_current->v_field, v_new->v_field, v_note);
      v_count := v_count + 1;
    END IF;
  END LOOP;

  RETURN jsonb_build_object('lead', v_new, 'activities_created', v_count);
END;
$$ LANGUAGE plpgsql;
