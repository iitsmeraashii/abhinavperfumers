// migrate-sales-reps.js
//
// Creates a Supabase Auth account for every sales_representative row that
// does not yet have one, using the rep's existing email + password.
//
// Usage:
//   SUPABASE_URL=https://xxx.supabase.co \
//   SERVICE_ROLE_KEY=eyJ... \
//   node scripts/migrate-sales-reps.js
//
// Or edit the constants below directly (do NOT commit the key).

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL     = process.env.SUPABASE_URL     || 'YOUR_SUPABASE_URL';
const SERVICE_ROLE_KEY = process.env.SERVICE_ROLE_KEY || 'YOUR_SERVICE_ROLE_KEY';

if (SUPABASE_URL === 'YOUR_SUPABASE_URL' || SERVICE_ROLE_KEY === 'YOUR_SERVICE_ROLE_KEY') {
  console.error('ERROR: Set SUPABASE_URL and SERVICE_ROLE_KEY as environment variables.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: {
    autoRefreshToken: false,
    persistSession:   false,
  },
});

async function migrate() {
  console.log('Fetching sales representatives…');

  const { data: reps, error } = await supabase
    .from('sales_representatives')
    .select('id, rep_code, name, email, password, auth_user_id, login_enabled');

  if (error) {
    console.error('Failed to fetch reps:', error.message);
    process.exit(1);
  }

  console.log(`Found ${reps.length} rep(s). Starting migration…\n`);

  let created = 0;
  let skipped = 0;
  let failed  = 0;

  for (const rep of reps) {
    const label = `[${rep.rep_code}]`;

    if (!rep.email) {
      console.log(`${label} SKIP — no email`);
      skipped++;
      continue;
    }

    if (rep.auth_user_id) {
      console.log(`${label} SKIP — already migrated (auth_user_id: ${rep.auth_user_id})`);
      skipped++;
      continue;
    }

    if (!rep.password) {
      console.log(`${label} SKIP — no password stored, cannot create auth account`);
      skipped++;
      continue;
    }

    console.log(`${label} Creating auth user for ${rep.email}…`);

    try {
      // Create the Supabase Auth user with email_confirm: true so they can
      // log in immediately without needing an email confirmation link.
      const { data: authData, error: authError } = await supabase.auth.admin.createUser({
        email:         rep.email,
        password:      rep.password,
        email_confirm: true,
      });

      if (authError) {
        // "User already registered" means an auth account exists but wasn't
        // linked — try to look it up and link it instead of failing.
        if (authError.message.includes('already registered')) {
          console.warn(`${label} Auth user already exists — attempting to link…`);

          const { data: listData, error: listError } = await supabase.auth.admin.listUsers();
          if (listError) {
            console.error(`${label} FAIL — could not list users: ${listError.message}`);
            failed++;
            continue;
          }

          const existing = listData.users.find(u => u.email === rep.email);
          if (!existing) {
            console.error(`${label} FAIL — existing user not found in list`);
            failed++;
            continue;
          }

          const { error: updateError } = await supabase
            .from('sales_representatives')
            .update({ auth_user_id: existing.id })
            .eq('id', rep.id);

          if (updateError) {
            console.error(`${label} FAIL — could not write auth_user_id: ${updateError.message}`);
            failed++;
          } else {
            console.log(`${label} LINKED existing auth user ${existing.id}`);
            created++;
          }
          continue;
        }

        console.error(`${label} FAIL — ${authError.message}`);
        failed++;
        continue;
      }

      const authUserId = authData.user.id;

      // Write auth_user_id back to the rep row
      const { error: updateError } = await supabase
        .from('sales_representatives')
        .update({ auth_user_id: authUserId })
        .eq('id', rep.id);

      if (updateError) {
        console.error(`${label} Auth user created (${authUserId}) but FAILED to link: ${updateError.message}`);
        failed++;
        continue;
      }

      console.log(`${label} SUCCESS — auth_user_id: ${authUserId}`);
      created++;

    } catch (err) {
      console.error(`${label} UNEXPECTED ERROR —`, err.message ?? err);
      failed++;
    }
  }

  console.log('\n─────────────────────────────────');
  console.log(`DONE. Created/linked: ${created}  Skipped: ${skipped}  Failed: ${failed}`);
  console.log('─────────────────────────────────');

  if (failed > 0) process.exit(1);
}

migrate();
