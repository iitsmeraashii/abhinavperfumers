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

// The Supabase JS client derives its auth storage key as:
//   sb-<project-ref>-auth-token
// where <project-ref> is the first subdomain segment of the project URL.
// We derive it the same way rather than accessing the protected
// `supabase.storageKey` property.
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const AUTH_STORAGE_KEY = `sb-${new URL(SUPABASE_URL).hostname.split('.')[0]}-auth-token`;
const AUTH_STORAGE_KEYS: string[] = [
  AUTH_STORAGE_KEY,
  `${AUTH_STORAGE_KEY}-code-verifier`,
  `${AUTH_STORAGE_KEY}-user`,
];

/**
 * Deterministically removes this Supabase client's persisted auth session
 * from browser localStorage. This is a LOCAL-ONLY operation — it does not
 * contact the Supabase server and does not depend on network availability.
 *
 * Use after supabase.auth.signOut() fails or may fail due to network
 * unavailability, to guarantee the user is logged out locally.
 *
 * Removes only this project's auth keys. Does NOT clear all localStorage,
 * IndexedDB, or any unrelated application storage.
 */
export function clearLocalSupabaseAuthSession(): void {
  for (const key of AUTH_STORAGE_KEYS) {
    try {
      localStorage.removeItem(key);
    } catch {
      // Storage may be unavailable in rare browser modes — best-effort.
    }
  }
}
