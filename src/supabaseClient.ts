import { createClient } from '@supabase/supabase-js';

// persistSession: true  — stores JWT in localStorage (default, explicit for clarity)
// autoRefreshToken: true — refreshes before expiry so mobile sessions stay alive
// detectSessionInUrl: false — no OAuth redirect flows in this app
export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY,
  {
    auth: {
      persistSession:     true,
      autoRefreshToken:   true,
      detectSessionInUrl: false,
      storage:            localStorage,
    },
  },
);
