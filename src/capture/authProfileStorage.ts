// Persistence infrastructure for a server-validated auth profile.
// This module ONLY reads/writes the auth_profile IndexedDB store.
// It does NOT perform authentication and is NOT yet wired into
// AuthContext for offline restoration.

import { dbGet, dbPut, dbDelete } from './db';
import type { CaptureProfile } from './captureProfile';
import type { SalesRep } from '../AuthContext';

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
export async function saveCachedAuthProfile(rep: SalesRep): Promise<void> {
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
  await dbPut('auth_profile', record);
}

/**
 * Load the persisted validated profile. Returns null if none exists.
 * NOT yet used for authentication/restoration — available for future use.
 */
export async function loadCachedAuthProfile(): Promise<CachedAuthProfile | null> {
  const record = await dbGet<CachedAuthProfile>('auth_profile', AUTH_PROFILE_KEY);
  if (!record) return null;
  if (record.schemaVersion !== AUTH_PROFILE_SCHEMA_VERSION) return null;
  return record;
}

/**
 * Remove the persisted profile. Infrastructure only — not yet wired into logout.
 */
export async function clearCachedAuthProfile(): Promise<void> {
  await dbDelete('auth_profile', AUTH_PROFILE_KEY);
}
