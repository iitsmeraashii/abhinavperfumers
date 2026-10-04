// Persistence infrastructure for a server-validated auth profile.
// This module ONLY reads/writes the auth_profile IndexedDB store.
// It does NOT perform authentication and is NOT yet wired into
// AuthContext for offline restoration.

import { dbGet, dbPutStrict, dbDeleteStrict } from './db';

// Serialize writes and clears so logout cannot be overtaken by an earlier write.
let mutations: Promise<void> = Promise.resolve();
function mutate(action: () => Promise<void>): Promise<void> {
  const next = mutations.then(action);
  mutations = next.catch(() => {});
  return next;
}
import type { CaptureProfile } from './captureProfile';
import type { SalesRep } from '../AuthContext';
import { hasPersistedSupabaseSessionForUser } from '../supabaseClient';

// Bump this when the persisted shape changes in a breaking way.
// Future restoration logic can reject stale/incompatible records.
const AUTH_PROFILE_SCHEMA_VERSION = 1;

// Fixed key — there is only ever one "current" validated profile.
// The record itself carries authUserId so restoration can verify
// identity before use, preventing Rep-A-as-Rep-B confusion.
const AUTH_PROFILE_KEY = 'current';

export interface CachedAuthProfile {
  key:               string;          // always 'current'
  schemaVersion:     number;
  authUserId:        string;
  repId:             string;
  repCode:           string;
  name:              string;
  role:              string;
  email:             string;
  phone:             string | null;
  loginEnabled:      boolean;
  isActive:          boolean;
  defaultEventId:    string | null;
  defaultCaptureProfile: CaptureProfile;
  // Timestamp (ms since epoch) when the SERVER successfully validated this profile.
  // Only updated after a confirmed authoritative success — never on transient
  // failures or in-memory preservation.
  validatedAt:       number;
}

/**
 * Persist a server-validated profile to IndexedDB.
 * Call this ONLY after my_rep_profile returns a valid, active, enabled profile.
 * Cache-write failures are non-fatal — the caller should keep the online session.
 */
export async function saveCachedAuthProfile(rep: SalesRep, isCurrent: () => boolean = () => true): Promise<void> {
  const record: CachedAuthProfile = {
    key:                   AUTH_PROFILE_KEY,
    schemaVersion:         AUTH_PROFILE_SCHEMA_VERSION,
    authUserId:            rep.auth_user_id,
    repId:                 rep.id,
    repCode:               rep.rep_code,
    name:                  rep.name,
    role:                  rep.role,
    email:                 rep.email,
    phone:                 rep.phone,
    loginEnabled:          rep.login_enabled,
    isActive:              rep.is_active,
    defaultEventId:        rep.default_event_id,
    defaultCaptureProfile: rep.default_capture_profile,
    validatedAt:           Date.now(),
  };
  await mutate(async () => {
    if (isCurrent()) await dbPutStrict('auth_profile', record);
  });
}

/**
 * Load the persisted validated profile. Returns null if none exists.
 * NOT yet used for authentication/restoration — available for future use.
 */
export async function loadCachedAuthProfile(): Promise<CachedAuthProfile | null> {
  await mutations;
  const record = await dbGet<CachedAuthProfile>('auth_profile', AUTH_PROFILE_KEY);
  if (!record) return null;
  if (record.schemaVersion !== AUTH_PROFILE_SCHEMA_VERSION) return null;
  return record;
}

/**
 * Remove the persisted profile. Infrastructure only — not yet wired into logout.
 */
export async function clearCachedAuthProfile(isCurrent: () => boolean = () => true): Promise<void> {
  await mutate(async () => {
    if (isCurrent()) await dbDeleteStrict('auth_profile', AUTH_PROFILE_KEY);
  });
}

// ─── Offline restoration support ────────────────────────────────────────────

/** Maximum age (15 days) for a cached profile to remain eligible for offline access. */
export const OFFLINE_AUTH_MAX_AGE_MS = 15 * 24 * 60 * 60 * 1000;

// Allow a small clock-skew tolerance so a profile validated moments ago is not
// rejected if the client clock is slightly ahead of the server's validation time.
const CLOCK_SKEW_TOLERANCE_MS = 5 * 60 * 1000;

export type OfflineRejectionReason =
  | 'no_cache'
  | 'schema_unsupported'
  | 'missing_identity'
  | 'missing_fields'
  | 'login_disabled'
  | 'inactive'
  | 'invalid_validatedAt'
  | 'expired'
  | 'no_persisted_session'
  | 'identity_mismatch';

export interface OfflineEligibilityResult {
  eligible: boolean;
  reason: OfflineRejectionReason | null;
  profile: CachedAuthProfile | null;
}

/**
 * Determine whether a cached profile is eligible for offline app access.
 *
 * This is a LOCAL offline-access policy based on a previous successful server
 * authorization — it is NOT server authorization itself.
 *
 * Requirements:
 *  - supported schemaVersion
 *  - authUserId / repId / repCode present
 *  - loginEnabled === true
 *  - isActive === true
 *  - validatedAt is finite, positive, not materially in the future, and ≤ 15 days old
 *  - persisted Supabase session user.id === cached.authUserId
 *
 * Does NOT update validatedAt. Does NOT modify any storage.
 */
export function checkOfflineEligibility(cached: CachedAuthProfile | null): OfflineEligibilityResult {
  if (!cached) return { eligible: false, reason: 'no_cache', profile: null };
  if (cached.schemaVersion !== AUTH_PROFILE_SCHEMA_VERSION) {
    return { eligible: false, reason: 'schema_unsupported', profile: cached };
  }
  if (!cached.authUserId || !cached.repId || !cached.repCode) {
    return { eligible: false, reason: 'missing_identity', profile: cached };
  }
  if (!cached.name || !cached.role) {
    return { eligible: false, reason: 'missing_fields', profile: cached };
  }
  if (!cached.loginEnabled) {
    return { eligible: false, reason: 'login_disabled', profile: cached };
  }
  if (!cached.isActive) {
    return { eligible: false, reason: 'inactive', profile: cached };
  }

  const now = Date.now();
  const { validatedAt } = cached;
  if (!Number.isFinite(validatedAt) || validatedAt <= 0) {
    return { eligible: false, reason: 'invalid_validatedAt', profile: cached };
  }
  if (validatedAt > now + CLOCK_SKEW_TOLERANCE_MS) {
    return { eligible: false, reason: 'invalid_validatedAt', profile: cached };
  }
  if (now - validatedAt > OFFLINE_AUTH_MAX_AGE_MS) {
    return { eligible: false, reason: 'expired', profile: cached };
  }

  if (!hasPersistedSupabaseSessionForUser(cached.authUserId)) {
    return { eligible: false, reason: 'no_persisted_session', profile: cached };
  }

  return { eligible: true, reason: null, profile: cached };
}

/**
 * Reconstruct a SalesRep from a cached profile.
 * Uses only data already present in the validated cached record.
 * Does NOT fabricate fields, Supabase User objects, or Session objects.
 */
export function cachedProfileToSalesRep(cached: CachedAuthProfile): SalesRep {
  return {
    id:                      cached.repId,
    rep_code:                cached.repCode,
    name:                    cached.name,
    role:                    cached.role,
    email:                   cached.email,
    phone:                   cached.phone,
    auth_user_id:            cached.authUserId,
    login_enabled:           cached.loginEnabled,
    is_active:               cached.isActive,
    default_event_id:        cached.defaultEventId,
    default_capture_profile: cached.defaultCaptureProfile,
  };
}

/** Confirmed preference update only; never extends offline authentication age. */
export function updateCachedDefaultEvent(ownerId: string, eventId: string, current: () => boolean): Promise<void> {
  return mutate(async () => {
    const cached = await dbGet<CachedAuthProfile>('auth_profile', AUTH_PROFILE_KEY);
    if (current() && cached?.authUserId === ownerId && cached.schemaVersion === AUTH_PROFILE_SCHEMA_VERSION) {
      await dbPutStrict('auth_profile', { ...cached, defaultEventId: eventId });
    }
  });
}
