/*
  # Seed Supabase Auth users for all sales representatives

  Creates auth.users entries for every sales_representative row that does not
  yet have an auth_user_id, using their existing email and bcrypt-hashed password.
  Sets email_confirmed_at so reps can log in immediately without a confirmation step.

  After each insert the auth_user_id column on sales_representatives is updated
  to link the two rows permanently.

  Idempotent: skips reps that already have auth_user_id set, and skips reps whose
  email already exists in auth.users (linking them instead of creating a duplicate).
*/

DO $$
DECLARE
  rec        RECORD;
  v_auth_id  uuid;
  v_new_id   uuid;
BEGIN
  FOR rec IN
    SELECT id, rep_code, email, password
    FROM public.sales_representatives
    WHERE auth_user_id IS NULL
      AND email IS NOT NULL
      AND password IS NOT NULL
    ORDER BY rep_code
  LOOP
    -- Check if an auth user already exists for this email
    SELECT id INTO v_auth_id
    FROM auth.users
    WHERE email = rec.email
      AND is_sso_user = false
    LIMIT 1;

    IF v_auth_id IS NULL THEN
      -- No existing auth user — create one
      v_new_id := gen_random_uuid();

      INSERT INTO auth.users (
        instance_id,
        id,
        aud,
        role,
        email,
        encrypted_password,
        email_confirmed_at,
        raw_app_meta_data,
        raw_user_meta_data,
        is_super_admin,
        is_sso_user,
        is_anonymous,
        created_at,
        updated_at,
        confirmation_token,
        recovery_token,
        email_change,
        email_change_token_new,
        email_change_token_current,
        phone_change,
        phone_change_token,
        reauthentication_token
      )
      VALUES (
        '00000000-0000-0000-0000-000000000000',
        v_new_id,
        'authenticated',
        'authenticated',
        rec.email,
        crypt(rec.password, gen_salt('bf')),
        now(),
        '{"provider":"email","providers":["email"]}'::jsonb,
        jsonb_build_object('rep_code', rec.rep_code),
        false,
        false,
        false,
        now(),
        now(),
        '', '', '', '', '', '', '', ''
      );

      v_auth_id := v_new_id;
      RAISE NOTICE '[%] Created auth user % for %', rec.rep_code, v_auth_id, rec.email;
    ELSE
      RAISE NOTICE '[%] Auth user already exists (%) — linking', rec.rep_code, v_auth_id;
    END IF;

    -- Link auth_user_id back to the sales_representatives row
    UPDATE public.sales_representatives
    SET auth_user_id = v_auth_id
    WHERE id = rec.id;

  END LOOP;

  RAISE NOTICE 'Migration complete.';
END $$;
