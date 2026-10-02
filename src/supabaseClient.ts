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

/**
 * Check whether this app has a persisted Supabase auth session belonging to
 * the given authUserId. Reads the Supabase-owned localStorage session record
 * and parses it ONLY to compare stored user.id with the expected value.
 *
 * Returns true if the persisted session's user.id matches. Returns false if
 * the record is missing, malformed, or belongs to a different user.
 *
 * This function NEVER returns or exposes tokens, session objects, or raw JSON.
 */
export function hasPersistedSupabaseSessionForUser(authUserId: string): boolean {
  try {
    const raw = localStorage.getItem(AUTH_STORAGE_KEY);
    if (!raw) return false;
    const parsed = JSON.parse(raw) as { user?: { id?: string } };
    return parsed?.user?.id === authUserId;
  } catch {
    return false;
  }
}
