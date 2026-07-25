import { createContext, useCallback, useContext, useEffect, useRef, useState, ReactNode } from 'react';
import type { Session, User as SupabaseUser } from '@supabase/supabase-js';
import { supabase } from './supabaseClient';
import type { CaptureProfile } from './capture/captureProfile';

// ─── Types ────────────────────────────────────────────────────────────────────

// Business profile from sales_representatives — separate from the auth identity.
export interface SalesRep {
  id:               string;
  rep_code:         string;
  name:             string;
  role:             string;
  email:            string;
  phone:            string | null;
  auth_user_id:            string;
  login_enabled:           boolean;
  is_active:               boolean;
  default_event_id:        string | null;
  default_capture_profile: CaptureProfile;
}

// Legacy shape kept identical so all consumers (LeadsPage, DashboardPage, etc.)
// continue to work without changes.
export interface AuthUser {
  rep_code:    string;
  name:        string;
  role:        string;
  authUserId?: string;
  email?:      string;
}

interface AuthContextType {
  // Legacy field — identical shape to old User, safe for all existing consumers
  user:     AuthUser | null;
  // New structured fields for consumers that want the full picture
  salesRep: SalesRep | null;
  authUser: SupabaseUser | null;
  session:  Session | null;
  loading:  boolean;
  login:    (rep_code: string, password: string) => Promise<string | null>;
  logout:   () => Promise<void>;
  /** Patch the cached rep profile in-place after a successful DB update. */
  updateSalesRep: (patch: Partial<SalesRep>) => void;
}

const AuthContext = createContext<AuthContextType | null>(null);

// ─── Provider ─────────────────────────────────────────────────────────────────

export function AuthProvider({ children }: { children: ReactNode }) {
  const [salesRep, setSalesRep] = useState<SalesRep | null>(null);
  const [authUser, setAuthUser] = useState<SupabaseUser | null>(null);
  const [session,  setSession]  = useState<Session | null>(null);
  const [loading,  setLoading]  = useState(true);

  // Guard: prevents loadRepProfile from running concurrently when both
  // getSession() and onAuthStateChange fire on mount with the same session.
  const profileLoadingRef = useRef(false);

  // ── Bootstrap ──────────────────────────────────────────────────────────────
  useEffect(() => {
    // onAuthStateChange fires immediately with the current session state,
    // which handles both "already logged in" and "not logged in" cases.
    // We do NOT call getSession() separately to avoid the double-load race.
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, s) => {
      setSession(s);
      setAuthUser(s?.user ?? null);

      if (s?.user) {
        // Async block avoids deadlock: never await supabase calls directly
        // inside onAuthStateChange per the Supabase JS docs.
        (async () => {
          await loadRepProfile(s);
        })();
      } else {
        // Signed out or no session
        setSalesRep(null);
        setLoading(false);
        // Clear stale legacy token if present
        localStorage.removeItem('session_token');
      }
    });

    return () => subscription.unsubscribe();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Load rep profile ───────────────────────────────────────────────────────
  // Reads the authenticated rep's row via my_rep_profile view (RLS-filtered
  // to auth.uid()). Calls link_auth_user_to_rep() first in case this is a
  // first login before the linking migration ran for this specific user.
  async function loadRepProfile(s: Session): Promise<void> {
    // Deduplicate concurrent calls (mount fires getSession + onAuthStateChange)
    if (profileLoadingRef.current) return;
    profileLoadingRef.current = true;

    try {
      // Link auth_user_id if not yet done (idempotent — safe to call every time)
      await supabase.rpc('link_auth_user_to_rep');

      const { data, error } = await supabase
        .from('my_rep_profile')
        .select('id, rep_code, name, role, email, phone, auth_user_id, login_enabled, is_active, default_event_id, default_capture_profile')
        .maybeSingle();

      if (error) {
        console.error('[AuthContext] loadRepProfile query failed', error);
        await supabase.auth.signOut();
        setSalesRep(null);
        return;
      }

      if (!data) {
        // Valid Supabase auth user but no matching sales_rep row — unauthorized
        console.warn('[AuthContext] No sales_rep row for auth user', s.user.email);
        await supabase.auth.signOut();
        setSalesRep(null);
        return;
      }

      if (!data.login_enabled || !data.is_active) {
        console.warn('[AuthContext] Rep account disabled/inactive', data.rep_code);
        await supabase.auth.signOut();
        setSalesRep(null);
        return;
      }

      setSalesRep({
        id:                      data.id,
        rep_code:                data.rep_code,
        name:                    data.name,
        role:                    data.role,
        email:                   data.email ?? s.user.email ?? '',
        phone:                   data.phone ?? null,
        auth_user_id:            data.auth_user_id ?? s.user.id,
        login_enabled:           data.login_enabled,
        is_active:               data.is_active,
        default_event_id:        data.default_event_id ?? null,
        default_capture_profile: (data.default_capture_profile as CaptureProfile) ?? 'CRM',
      });
    } catch (err) {
      console.error('[AuthContext] loadRepProfile threw', err);
      setSalesRep(null);
    } finally {
      profileLoadingRef.current = false;
      setLoading(false);
    }
  }

  // ── Login ──────────────────────────────────────────────────────────────────
  // STEP 1: get_rep_login_status(rep_code) — returns structured status with email
  // STEP 2: signInWithPassword(email, password)
  // STEP 3: onAuthStateChange fires → loadRepProfile → setSalesRep
  async function login(rep_code: string, password: string): Promise<string | null> {
    const normalised = rep_code.trim().toUpperCase();

    // Step 1: Check rep status and retrieve email
    const { data: statusData, error: statusError } = await supabase
      .rpc('get_rep_login_status', { p_rep_code: normalised });

    if (statusError) {
      console.error('[login] get_rep_login_status failed', statusError);
      return 'Login failed — please try again';
    }

    const status = (statusData as { status: string; email?: string }) ?? { status: 'not_found' };

    switch (status.status) {
      case 'not_found':
        return 'Rep code not recognised';
      case 'inactive':
        return 'This account is no longer active';
      case 'disabled':
        return 'Login is disabled for this account';
      case 'no_auth_account':
        return 'Account not set up for login — contact your administrator';
      case 'no_email':
        return 'No email address on file — contact your administrator';
      case 'ok':
        break;
      default:
        return 'Invalid credentials';
    }

    const email = status.email!;

    // Step 2: Authenticate via Supabase Auth (validates the password)
    const { error: authError } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (authError) {
      // Supabase returns "Invalid login credentials" for wrong password
      console.warn('[login] signInWithPassword failed', authError.message);
      if (authError.message.toLowerCase().includes('email not confirmed')) {
        return 'Email not confirmed — contact your administrator';
      }
      return 'Incorrect password';
    }

    // Step 3: onAuthStateChange fires automatically → loadRepProfile → setSalesRep
    return null;
  }

  // ── Logout ─────────────────────────────────────────────────────────────────
  // Clears Supabase session and local state.
  // Does NOT touch IndexedDB — offline drafts are preserved.
  async function logout(): Promise<void> {
    await supabase.auth.signOut();
    // onAuthStateChange sets everything to null via the subscriber above
  }

  // ── Legacy user shape (backward-compat for all existing consumers) ─────────
  const user: AuthUser | null = salesRep
    ? {
        rep_code:   salesRep.rep_code,
        name:       salesRep.name,
        role:       salesRep.role,
        authUserId: salesRep.auth_user_id,
        email:      salesRep.email,
      }
    : null;

  // Patch the cached rep profile after a successful DB update so consumers
  // (e.g. Capture page's default profile init) see the new value immediately,
  // without requiring a logout/login cycle.
  const updateSalesRep = useCallback((patch: Partial<SalesRep>) => {
    setSalesRep(prev => (prev ? { ...prev, ...patch } : prev));
  }, []);

  return (
    <AuthContext.Provider value={{ user, salesRep, authUser, session, loading, login, logout, updateSalesRep }}>
      {children}
    </AuthContext.Provider>
  );
}

// ─── Hooks ────────────────────────────────────────────────────────────────────

export function useAuth(): AuthContextType {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
