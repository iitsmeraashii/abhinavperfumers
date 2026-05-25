import { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from './supabaseClient';

// ─── Types ────────────────────────────────────────────────────────────────────
// Shape is kept identical to the old AuthContext so all consumers (LeadsPage,
// DashboardPage, EventsPage, etc.) continue to work without changes.

interface User {
  rep_code:    string;
  name:        string;
  role:        string;
  // New fields available to consumers that want them
  authUserId?: string;
  email?:      string;
}

interface AuthContextType {
  user:      User | null;
  session:   Session | null;
  loading:   boolean;
  login:     (rep_code: string, password: string) => Promise<string | null>;
  logout:    () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | null>(null);

// ─── Provider ─────────────────────────────────────────────────────────────────

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user,    setUser]    = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  // ── Bootstrap: restore session from Supabase's own storage ────────────────
  // supabase-js v2 persists the session in localStorage automatically.
  // onAuthStateChange fires synchronously on mount with the restored session.
  useEffect(() => {
    // Get the current session immediately (avoids a blank flash on reload)
    supabase.auth.getSession().then(({ data: { session: s } }) => {
      if (s) {
        setSession(s);
        loadRepProfile(s);
      } else {
        // Fall back: clear any stale legacy token
        localStorage.removeItem('session_token');
        setLoading(false);
      }
    });

    // Subscribe to future auth changes (login, logout, token refresh)
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s);
      if (s) {
        // Use async block to avoid deadlock with supabase-js internals
        (async () => { await loadRepProfile(s); })();
      } else {
        setUser(null);
        setLoading(false);
      }
    });

    return () => subscription.unsubscribe();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Load the rep's profile row after auth ──────────────────────────────────
  async function loadRepProfile(s: Session): Promise<void> {
    try {
      // Ensure the auth_user_id column is linked for this rep (idempotent)
      await supabase.rpc('link_auth_user_to_rep');

      // Read rep profile via the view (filtered to auth.uid())
      const { data, error } = await supabase
        .from('my_rep_profile')
        .select('rep_code, name, role, auth_user_id, email')
        .maybeSingle();

      if (error || !data) {
        // Auth user exists but has no matching sales_rep row — treat as unauthorized
        console.warn('[AuthContext] No matching sales_rep for auth user', s.user.email, error);
        await supabase.auth.signOut();
        setUser(null);
      } else {
        setUser({
          rep_code:   data.rep_code,
          name:       data.name,
          role:       data.role,
          authUserId: data.auth_user_id ?? s.user.id,
          email:      data.email ?? s.user.email,
        });
      }
    } catch (err) {
      console.error('[AuthContext] loadRepProfile failed', err);
      setUser(null);
    } finally {
      setLoading(false);
    }
  }

  // ── Login ──────────────────────────────────────────────────────────────────
  // NEW flow:
  //   STEP 1 — look up email by rep_code via RPC (no password exposed)
  //   STEP 2 — signInWithPassword(email, password)
  //   STEP 3 — onAuthStateChange fires → loadRepProfile fills user state
  async function login(rep_code: string, password: string): Promise<string | null> {
    // Step 1: Resolve rep_code → email
    const { data: emailData, error: lookupError } = await supabase
      .rpc('get_rep_email_by_code', { p_rep_code: rep_code.trim().toUpperCase() });

    if (lookupError) {
      console.error('[login] rep lookup failed', lookupError);
      return 'Invalid credentials';
    }

    const email = emailData as string | null;
    if (!email) {
      // rep_code not found or login disabled — same message as before
      return 'Invalid credentials';
    }

    // Step 2: Authenticate via Supabase Auth
    const { error: authError } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (authError) {
      console.warn('[login] signInWithPassword failed', authError.message);
      // Supabase returns "Invalid login credentials" for wrong password —
      // normalise to the same message the old system used
      return 'Invalid credentials';
    }

    // Step 3: onAuthStateChange handles the rest (loadRepProfile → setUser)
    return null;
  }

  // ── Logout ─────────────────────────────────────────────────────────────────
  async function logout(): Promise<void> {
    await supabase.auth.signOut();
    // onAuthStateChange will set user → null and session → null
  }

  return (
    <AuthContext.Provider value={{ user, session, loading, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useAuth(): AuthContextType {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
