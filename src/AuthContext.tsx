import { createContext, useCallback, useContext, useEffect, useRef, useState, ReactNode } from 'react';
import type { Session, User as SupabaseUser } from '@supabase/supabase-js';
import { supabase, clearLocalSupabaseAuthSession } from './supabaseClient';
import type { CaptureProfile } from './capture/captureProfile';
import {
  saveCachedAuthProfile,
  loadCachedAuthProfile,
  clearCachedAuthProfile,
  checkOfflineEligibility,
  cachedProfileToSalesRep,
} from './capture/authProfileStorage';

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

type AuthMode =
  | 'unauthenticated'
  | 'online'
  | 'offline-restored';

interface AuthContextType {
  // Legacy field — identical shape to old User, safe for all existing consumers
  user:     AuthUser | null;
  // New structured fields for consumers that want the full picture
  salesRep: SalesRep | null;
  authUser: SupabaseUser | null;
  session:  Session | null;
  authMode: AuthMode;
  loading:  boolean;
  login:    (rep_code: string, password: string) => Promise<string | null>;
  logout:   () => Promise<void>;
  /** Patch the cached rep profile in-place after a successful DB update. */
  updateSalesRep: (patch: Partial<SalesRep>) => void;
}

const AuthContext = createContext<AuthContextType | null>(null);

// ─── Response classification ─────────────────────────────────────────────────
// The PostgREST client (postgrest-js) returns a flat object:
//
//   { data, error, count, status, statusText }
//
// On a transport failure (fetch never reaches the server — DNS failure,
// connection refused, request blocked, etc.) the catch handler in
// PostgrestBuilder.then() returns:
//
//   { data: null, error: { message, details, hint, code }, status: 0, ... }
//
// The `status: 0` is on the TOP-LEVEL response, NOT on `error`. The error
// object has no `status` property. This is why the previous implementation
// failed: it passed only `error` to the classifier and checked `error.status`,
// which was always `undefined`.
//
// We do NOT rely on navigator.onLine because the Supabase domain can be
// unreachable while general internet is available.
type ErrorClass = 'transient' | 'authoritative' | 'none';

function classifyResponseError(status: number, error: unknown): ErrorClass {
  if (!error) return 'none';
  // status === 0: no HTTP response received (transport failure).
  if (status === 0) return 'transient';
  // 5xx: server is broken/overloaded — not an authoritative auth rejection.
  if (status >= 500) return 'transient';
  // 401/403/404 etc.: server responded and authoritatively rejected the request.
  return 'authoritative';
}

// ─── Provider ─────────────────────────────────────────────────────────────────

export function AuthProvider({ children }: { children: ReactNode }) {
  const [salesRep, setSalesRep] = useState<SalesRep | null>(null);
  const [authUser, setAuthUser] = useState<SupabaseUser | null>(null);
  const [session,  setSession]  = useState<Session | null>(null);
  const [authMode, setAuthMode] = useState<AuthMode>('unauthenticated');
  const [loading,  setLoading]  = useState(true);

  // Mirror of salesRep readable inside loadRepProfile without re-creating the
  // onAuthStateChange subscription. Used to decide whether a transient failure
  // should preserve the existing in-memory profile.
  const salesRepRef = useRef<SalesRep | null>(null);
  const setSalesRepSafe = useCallback((rep: SalesRep | null) => {
    salesRepRef.current = rep;
    setSalesRep(rep);
    if (rep === null) setAuthMode('unauthenticated');
  }, []);

  // Guard: prevents loadRepProfile from running concurrently when both
  // getSession() and onAuthStateChange fire on mount with the same session.
  const profileLoadingRef = useRef(false);

  // Generation guard: incremented on explicit logout. loadRepProfile captures
  // the value at start; if it changes mid-flight, the invocation is stale and
  // must perform no side effects. This prevents an in-flight profile load from
  // restoring salesRep or rewriting auth_profile after the user logs out.
  const authGenerationRef = useRef(0);

  // Track whether we have already attempted offline restoration for the current
  // bootstrap. Prevents repeated restoration attempts during a single cold start
  // when multiple auth events fire.
  const offlineRestoreAttemptedRef = useRef(false);

  // ── Offline restoration ──────────────────────────────────────────────────
  // Attempts to restore app access from a previously server-validated cached
  // profile. Called when:
  //   (A) loadRepProfile hits a transient failure on a cold start with a real
  //       Supabase session, OR
  //   (B) INITIAL_SESSION is null but persisted Supabase identity evidence
  //       suggests the user was previously authenticated.
  //
  // Returns true if access was restored, false otherwise.
  async function tryOfflineRestore(generation: number): Promise<boolean> {
    const cached = await loadCachedAuthProfile();
    if (generation !== authGenerationRef.current) return false;

    const result = checkOfflineEligibility(cached);
    if (!result.eligible || !result.profile) {
      console.warn('[AuthContext] offline profile rejected:', result.reason);
      return false;
    }

    const restoredRep = cachedProfileToSalesRep(result.profile);
    if (generation !== authGenerationRef.current) return false;

    setSalesRepSafe(restoredRep);
    setAuthMode('offline-restored');
    console.log('[AuthContext] offline profile restored', {
      repCode: restoredRep.rep_code,
      validatedAt: result.profile.validatedAt,
    });
    // Do NOT update validatedAt. Do NOT rewrite auth_profile.
    // Only successful server validation may refresh the 15-day window.
    return true;
  }

  // ── Bootstrap ──────────────────────────────────────────────────────────────
  useEffect(() => {
    // onAuthStateChange fires immediately with the current session state,
    // which handles both "already logged in" and "not logged in" cases.
    // We do NOT call getSession() separately to avoid the double-load race.
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, s) => {
      console.log('[AuthContext] auth event:', event, 'session:', !!s, 'salesRep:', !!salesRepRef.current);

      setSession(s);
      setAuthUser(s?.user ?? null);

      if (s?.user) {
        // Async block avoids deadlock: never await supabase calls directly
        // inside onAuthStateChange per the Supabase JS docs.
        (async () => {
          await loadRepProfile(s);
        })();
      } else {
        // No session in the event. Could be:
        //  - INITIAL_SESSION with no stored session (genuinely unauthenticated)
        //  - INITIAL_SESSION null because token refresh failed offline
        //  - SIGNED_OUT from explicit logout or server-side revocation
        //
        // If salesRep already exists (warm session preserved), keep it.
        if (salesRepRef.current) {
          setLoading(false);
          return;
        }

        // Case B: INITIAL_SESSION null due to offline refresh failure.
        // Attempt offline restoration before falling through to LoginPage.
        if (event === 'INITIAL_SESSION' && !offlineRestoreAttemptedRef.current) {
          offlineRestoreAttemptedRef.current = true;
          const generation = authGenerationRef.current;
          (async () => {
            const restored = await tryOfflineRestore(generation);
            if (generation !== authGenerationRef.current) return;
            if (!restored) {
              setSalesRepSafe(null);
              setLoading(false);
              localStorage.removeItem('session_token');
            }
          })();
          return;
        }

        // SIGNED_OUT or other null-session event — genuinely unauthenticated.
        setSalesRepSafe(null);
        setLoading(false);
        // Clear stale legacy token if present
        localStorage.removeItem('session_token');
      }
    });

    return () => subscription.unsubscribe();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Cache identity guard ──────────────────────────────────────────────────
  // When a genuine Supabase session arrives, ensure any cached profile
  // belonging to a DIFFERENT authUserId is invalidated. This prevents
  // a future offline restoration from restoring Rep A's profile for Rep B.
  // Returns true if the session user matches the cache (or no cache exists).
  async function ensureCacheMatchesUser(authUserId: string): Promise<void> {
    const cached = await loadCachedAuthProfile();
    if (cached && cached.authUserId !== authUserId) {
      console.warn('[AuthContext] cached profile belongs to different user — clearing', {
        cachedAuthUserId: cached.authUserId,
        newAuthUserId: authUserId,
      });
      await clearCachedAuthProfile();
    }
  }

  // ── Load rep profile ───────────────────────────────────────────────────────
  // Reads the authenticated rep's row via my_rep_profile view (RLS-filtered
  // to auth.uid()). Calls link_auth_user_to_rep() first in case this is a
  // first login before the linking migration ran for this specific user.
  async function loadRepProfile(s: Session): Promise<void> {
    // Deduplicate concurrent calls (mount fires getSession + onAuthStateChange)
    if (profileLoadingRef.current) return;
    profileLoadingRef.current = true;

    // Capture the generation at start. If logout() increments it while this
    // invocation is awaiting an async operation, the invocation is stale.
    const generation = authGenerationRef.current;

    // Invalidate any cached profile belonging to a different auth user before
    // proceeding. This runs before any network profile query so that even if
    // the profile query fails transiently, a stale cross-user cache is gone.
    await ensureCacheMatchesUser(s.user.id);
    if (generation !== authGenerationRef.current) return;

    try {
      // Link auth_user_id if not yet done (idempotent — safe to call every time)
      // A failure here is non-fatal — the profile query below is the
      // authoritative check. We continue regardless of the error type.
      const linkResult = await supabase.rpc('link_auth_user_to_rep');
      if (generation !== authGenerationRef.current) return;
      if (linkResult.error) {
        const linkClass = classifyResponseError(linkResult.status, linkResult.error);
        console.warn('[AuthContext] link_auth_user_to_rep failed', {
          status: linkResult.status,
          class: linkClass,
          code: (linkResult.error as unknown as Record<string, unknown>)?.code ?? null,
        });
      }

      const profileResult = await supabase
        .from('my_rep_profile')
        .select('id, rep_code, name, role, email, phone, auth_user_id, login_enabled, is_active, default_event_id, default_capture_profile')
        .maybeSingle();

      if (generation !== authGenerationRef.current) return;

      const { data, error, status } = profileResult;
      const errorClass = classifyResponseError(status, error);

      if (error) {
        if (errorClass === 'transient') {
          // Transient network/backend failure — Supabase unreachable or 5xx.
          if (salesRepRef.current) {
            // Warm session: preserve existing profile, do not sign out.
            console.warn('[AuthContext] Profile revalidation failed (transient) — preserving existing salesRep', {
              status,
              code: (error as unknown as Record<string, unknown>)?.code ?? null,
            });
          } else {
            // Case A: cold start with real Supabase session but profile server
            // is unreachable. Try offline restoration from cached profile.
            console.warn('[AuthContext] Profile load failed (transient) — attempting offline restore', {
              status,
              code: (error as unknown as Record<string, unknown>)?.code ?? null,
            });
            const restored = await tryOfflineRestore(generation);
            if (generation !== authGenerationRef.current) return;
            if (!restored) {
              console.warn('[AuthContext] offline restore failed — staying unauthenticated');
            }
          }
          return;
        }
        // Authoritative server error (e.g. 401, 403) — session is genuinely invalid.
        console.error('[AuthContext] loadRepProfile query rejected by server', {
          status,
          code: (error as unknown as Record<string, unknown>)?.code ?? null,
        });
        console.log('[AuthContext] signOut reason: profile_http_' + status);
        await clearCachedAuthProfile();
        await supabase.auth.signOut();
        setSalesRepSafe(null);
        return;
      }

      if (!data) {
        // Server confirmed: valid auth user but no matching sales_rep row.
        console.warn('[AuthContext] No sales_rep row for auth user', s.user.email);
        console.log('[AuthContext] signOut reason: profile_missing');
        await clearCachedAuthProfile();
        await supabase.auth.signOut();
        setSalesRepSafe(null);
        return;
      }

      if (!data.login_enabled) {
        // Server confirmed: representative login is disabled.
        console.warn('[AuthContext] Rep account login disabled', data.rep_code);
        console.log('[AuthContext] signOut reason: profile_disabled');
        await clearCachedAuthProfile();
        await supabase.auth.signOut();
        setSalesRepSafe(null);
        return;
      }

      if (!data.is_active) {
        // Server confirmed: representative is inactive.
        console.warn('[AuthContext] Rep account inactive', data.rep_code);
        console.log('[AuthContext] signOut reason: profile_inactive');
        await clearCachedAuthProfile();
        await supabase.auth.signOut();
        setSalesRepSafe(null);
        return;
      }

      if (generation !== authGenerationRef.current) return;

      const validatedRep: SalesRep = {
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
      };
      setSalesRepSafe(validatedRep);
      setAuthMode('online');

      // Persist the server-validated profile to IndexedDB for future offline
      // restoration. Fire-and-forget: a cache-write failure must not break the
      // online session. This runs ONLY after a confirmed authoritative success
      // — never on transient failures, missing profiles, or disabled accounts.
      saveCachedAuthProfile(validatedRep)
        .then(() => console.log('[AuthContext] validated auth profile cached', { repCode: validatedRep.rep_code, validatedAt: Date.now() }))
        .catch((cacheErr) => console.warn('[AuthContext] auth profile cache write failed (non-fatal)', cacheErr));
    } catch (err) {
      // A thrown error from the Supabase client itself is a transport failure.
      if (salesRepRef.current) {
        // Warm session: preserve existing profile.
        console.warn('[AuthContext] loadRepProfile threw (transient) — preserving existing salesRep', err);
      } else {
        // Cold start: try offline restoration.
        console.warn('[AuthContext] loadRepProfile threw (transient) — attempting offline restore', err);
        const restored = await tryOfflineRestore(generation);
        if (generation !== authGenerationRef.current) return;
        if (!restored) {
          console.warn('[AuthContext] offline restore failed — staying unauthenticated');
        }
      }
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
  // Offline drafts in IndexedDB are preserved, but the auth_profile cache and
  // the Supabase persisted session are invalidated so a future offline reload
  // cannot restore the signed-out user.
  //
  // Local invalidation is DETERMINISTIC — it does not depend on the Supabase
  // server being reachable. The remote signOut is best-effort.
  async function logout(): Promise<void> {
    console.log('[AuthContext] signOut reason: explicit_user_logout');
    // 0. Invalidate any in-flight loadRepProfile / offline restoration so they
    //    cannot restore salesRep or rewrite auth_profile after logout completes.
    authGenerationRef.current++;
    // 1. Clear in-memory app access immediately.
    setSalesRepSafe(null);
    setAuthMode('unauthenticated');
    // 2. Await IndexedDB auth profile removal — not fire-and-forget.
    try {
      await clearCachedAuthProfile();
    } catch (err) {
      console.warn('[AuthContext] auth profile cache clear failed (non-fatal)', err);
    }
    // 3. Attempt Supabase signOut (best-effort, may fail offline).
    //    Use scope:'local' so it does not revoke sessions on other devices.
    try {
      await supabase.auth.signOut({ scope: 'local' });
    } catch {
      // Network failure — handled by deterministic local cleanup below.
    }
    // 4. GUARANTEE local Supabase session removal regardless of signOut result.
    //    When Supabase is unreachable, signOut's network call fails before
    //    _removeSession runs, leaving the session in localStorage. This
    //    ensures it is gone.
    clearLocalSupabaseAuthSession();
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
    setSalesRep(prev => {
      const next = prev ? { ...prev, ...patch } : prev;
      salesRepRef.current = next;
      return next;
    });
  }, []);

  return (
    <AuthContext.Provider value={{ user, salesRep, authUser, session, authMode, loading, login, logout, updateSalesRep }}>
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
