# Offline Authentication Audit

> **AUDIT ONLY — no code was modified.** This document is the source of truth
> for the offline-authentication problem, root causes, and recommended fix.

---

## Table of Contents

1. [Current Authentication Lifecycle Diagram](#1-current-authentication-lifecycle-diagram)
2. [Exact Root Cause Locations](#2-exact-root-cause-locations)
3. [Current Logout/Error Behavior](#3-current-logouterror-behavior)
4. [Recommended Persisted Profile Shape](#4-recommended-persisted-profile-shape)
5. [Recommended Storage Location](#5-recommended-storage-location)
6. [Recommended Authentication State Model](#6-recommended-authentication-state-model)
7. [Startup/Reconnection/Logout State Transitions](#7-startupreconnectionlogout-state-transitions)
8. [Exact Files That Would Need Modification](#8-exact-files-that-would-need-modification)
9. [Security Risks and Mitigations](#9-security-risks-and-mitigations)
10. [Recommended Implementation — Small Testable Steps](#10-recommended-implementation--small-testable-steps)

---

## 1. Current Authentication Lifecycle Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                        APP STARTUP                              │
└─────────────────────────────────────────────────────────────────┘

  App mounts
    │
    ▼
  AuthProvider useEffect()
    │
    ├── supabase.auth.onAuthStateChange()  ← fires immediately
    │     with current session state
    │
    ├── Session exists (JWT in localStorage)?
    │     │
    │     ├── YES → setSession(s), setAuthUser(s.user)
    │     │          │
    │     │          └── (async) loadRepProfile(s)
    │     │                │
    │     │                ├── RPC: link_auth_user_to_rep()
    │     │                │     (SECURITY DEFINER, idempotent)
    │     │                │
    │     │                ├── Query: my_rep_profile
    │     │                │     (RLS view: WHERE auth_user_id = auth.uid())
    │     │                │
    │     │                ├── Result?
    │     │                │   ├── error → signOut() + setSalesRep(null)  ◄── ROOT CAUSE #1
    │     │                │   ├── no data → signOut() + setSalesRep(null) ◄── ROOT CAUSE #2
    │     │                │   ├── login_enabled=false → signOut()         ◄── ROOT CAUSE #3
    │     │                │   ├── is_active=false → signOut()              ◄── ROOT CAUSE #4
    │     │                │   └── valid → setSalesRep(data)
    │     │                │
    │     │                └── finally: setLoading(false)
    │     │
    │     └── NO → setSalesRep(null), setLoading(false)
    │               localStorage.removeItem('session_token')
    │
    ▼
  loading === false
    │
    ├── salesRep !== null → render Layout (app)
    └── salesRep === null → render LoginPage


┌─────────────────────────────────────────────────────────────────┐
│                        LOGIN FLOW                               │
└─────────────────────────────────────────────────────────────────┘

  User enters rep_code + password
    │
    ▼
  login(rep_code, password)
    │
    ├── RPC: get_rep_login_status(rep_code)
    │     returns { status, email }
    │     ├── not_found / inactive / disabled / no_auth_account / no_email
    │     │     → return error string (stays on LoginPage)
    │     └── ok → continue
    │
    ├── supabase.auth.signInWithPassword(email, password)
    │     ├── error → return "Incorrect password"
    │     └── success → return null
    │
    ▼
  onAuthStateChange fires → loadRepProfile (see above)


┌─────────────────────────────────────────────────────────────────┐
│                        LOGOUT FLOW                              │
└─────────────────────────────────────────────────────────────────┘

  User taps "Log Out"
    │
    ▼
  handleLogout() in App.tsx
    ├── clearEvent()  (EventContext)
    └── logout() in AuthContext
          └── supabase.auth.signOut()
                │
                ▼
          onAuthStateChange fires (event=SIGNED_OUT, session=null)
                │
                ▼
          setSalesRep(null), setLoading(false)
          localStorage.removeItem('session_token')
                │
                ▼
          App renders LoginPage


┌─────────────────────────────────────────────────────────────────┐
│                   WHILE APP IS RUNNING                          │
└─────────────────────────────────────────────────────────────────┘

  salesRep lives ONLY in React useState (memory)
  No persistence to IndexedDB or localStorage

  If network drops:
    ├── salesRep stays in memory → app continues working
    ├── Supabase autoRefreshToken may fail → session eventually expires
    └── No revalidation triggered (no visibility/focus listeners in AuthContext)

  If app is killed/reopened offline:
    ├── Supabase restores JWT from localStorage (persistSession: true)
    ├── onAuthStateChange fires with restored session
    ├── loadRepProfile() attempts network calls:
    │     ├── link_auth_user_to_rep() RPC → network error
    │     └── my_rep_profile query → network error
    ├── error path → signOut() + setSalesRep(null)
    └── App renders LoginPage (user locked out offline)  ◄── ROOT CAUSE #5
```

---

## 2. Exact Root Cause Locations

### Root Cause #1: Network error during profile load triggers signOut

**File:** `src/AuthContext.tsx`, lines 107–111

```typescript
if (error) {
  console.error('[AuthContext] loadRepProfile query failed', error);
  await supabase.auth.signOut();   // ← destroys a valid session on network error
  setSalesRep(null);
  return;
}
```

A network error (Supabase unreachable) produces a PostgREST error object. The
code does not distinguish "network unreachable" from "permission denied" or
"row not found". It calls `signOut()` unconditionally, destroying the locally
persisted JWT.

### Root Cause #2: Missing profile row triggers signOut

**File:** `src/AuthContext.tsx`, lines 114–119

```typescript
if (!data) {
  console.warn('[AuthContext] No sales_rep row for auth user', s.user.email);
  await supabase.auth.signOut();
  setSalesRep(null);
  return;
}
```

When offline, the `my_rep_profile` query may return `{ data: null, error: null }`
if the request fails silently or the local PostgREST cache has no entry. This
is treated as "unauthorized" and triggers signOut.

### Root Cause #3 & #4: Disabled/inactive rep triggers signOut

**File:** `src/AuthContext.tsx`, lines 122–127

```typescript
if (!data.login_enabled || !data.is_active) {
  console.warn('[AuthContext] Rep account disabled/inactive', data.rep_code);
  await supabase.auth.signOut();
  setSalesRep(null);
  return;
}
```

This is correct behavior when the data is genuinely from the server. The
problem is that this code also runs when the "data" is stale or cached from
a previous session, which is indistinguishable from a fresh server response.

### Root Cause #5: No offline profile persistence

**File:** `src/AuthContext.tsx` — entire file

`salesRep` is stored only in `useState<SalesRep | null>`. There is no write
to IndexedDB, localStorage, or any other persistent store. When the app is
killed and reopened, `salesRep` starts as `null` and can only be repopulated
by a successful network round-trip to `my_rep_profile`.

### Root Cause #6: No network-error / offline-state detection in loadRepProfile

**File:** `src/AuthContext.tsx`, `loadRepProfile` function (lines 93–149)

The function does not check `navigator.onLine` before attempting network
calls, nor does it inspect the error object to determine whether the failure
is network-related vs. authorization-related. The catch block (line 142–144)
also unconditionally clears `salesRep`:

```typescript
} catch (err) {
  console.error('[AuthContext] loadRepProfile threw', err);
  setSalesRep(null);  // ← clears profile on any thrown error
}
```

### Root Cause #7: signOut destroys the JWT that would enable offline session restore

**File:** `src/AuthContext.tsx`, lines 109, 117, 124

`supabase.auth.signOut()` clears the JWT from localStorage. Even if the
network comes back moments later, the user must re-enter their password.
If the user is offline, they cannot re-authenticate because
`signInWithPassword` requires network access.

---

## 3. Current Logout/Error Behavior

### All paths that clear salesRep

| # | Location | Trigger | Also calls signOut? |
|---|----------|---------|---------------------|
| 1 | `AuthContext.tsx:78` | `onAuthStateChange` with no session | N/A (already signed out) |
| 2 | `AuthContext.tsx:109` | `loadRepProfile` query error | **Yes** |
| 3 | `AuthContext.tsx:117` | `loadRepProfile` returns no data | **Yes** |
| 4 | `AuthContext.tsx:124` | `loadRepProfile` returns disabled/inactive rep | **Yes** |
| 5 | `AuthContext.tsx:144` | `loadRepProfile` throws (catch block) | No |
| 6 | `AuthContext.tsx:211` | Explicit `logout()` call | **Yes** |

### Which errors currently cause logout

| Error scenario | Triggers signOut? | Correct behavior? |
|----------------|-------------------|-------------------|
| Network unreachable (Supabase down) | **Yes** (paths 2, 5) | **No** — should preserve session and use cached profile |
| JWT expired + refresh fails | Yes (path 1 via onAuthStateChange) | Yes — session is genuinely invalid |
| Valid JWT but no sales_rep row | Yes (path 3) | Yes — user is unauthorized |
| Valid JWT but rep disabled | Yes (path 4) | Yes — but only if data is fresh from server |
| `link_auth_user_to_rep` RPC fails (network) | No (ignored, proceeds to query) | N/A — but the subsequent query also fails |
| Explicit user logout | Yes (path 6) | Yes |

### Can a failed network request be distinguished from an invalid session?

**No.** Currently there is no logic that inspects the error type, message, or
`navigator.onLine` to differentiate:

- **Network error** (fetch failed, timeout, DNS failure) → should NOT sign out
- **Auth error** (401, JWT invalid) → should sign out
- **Authorization error** (403, no sales_rep row) → should sign out

The Supabase JS client does surface different error shapes for these cases
(e.g., `FetchError` vs. `PostgrestError` with status codes), but the current
code does not inspect them.

---

## 4. Recommended Persisted Profile Shape

```typescript
interface PersistedAuthProfile {
  // ── Identity ──
  authUserId:    string;         // Supabase auth.uid()
  repId:         string;         // sales_representatives.id
  repCode:       string;         // sales_representatives.rep_code
  email:         string;         // for re-auth if needed

  // ── Application state ──
  name:          string;
  role:          'admin' | 'sales_rep';
  phone:         string | null;
  defaultEventId:        string | null;
  defaultCaptureProfile: CaptureProfile;

  // ── Authorization snapshot ──
  loginEnabled:  boolean;        // last known value from server
  isActive:      boolean;        // last known value from server

  // ── Offline eligibility ──
  cachedAt:      string;         // ISO — when this profile was cached
  sessionValidAt: string;        // ISO — when the Supabase session was last valid

  // ── Revocation guard ──
  // Not a secret — a monotonic token cleared by explicit logout.
  // Its presence means "user explicitly logged out; do not restore offline."
  logoutStamp:   string | null;  // set on explicit logout, cleared on successful online auth
}
```

### Why these fields

- `authUserId` is the `ownerId` used by the entire IndexedDB offline queue
  system. It must be available without a network round-trip.
- `repCode`, `name`, `role`, `phone`, `defaultEventId`,
  `defaultCaptureProfile` are the fields consumed by `AuthUser` and
  `SalesRep` in the React tree. All are needed to render the app shell.
- `loginEnabled` and `isActive` are the server-side authorization flags.
  They are cached so the app can make a best-effort check offline, but must
  be revalidated on reconnect.
- `cachedAt` and `sessionValidAt` enable staleness checks.
- `logoutStamp` prevents offline restoration after an explicit logout.

---

## 5. Recommended Storage Location

**IndexedDB — a new `auth_profile` object store in the existing `capture_app`
database.**

### Why IndexedDB (not localStorage)

| Criterion | localStorage | IndexedDB |
|-----------|-------------|-----------|
| Current auth storage | JWT is already here (Supabase managed) | All app data is here |
| Capacity | ~5 MB (sufficient for a small profile) | Unlimited (overkill but fine) |
| Asynchronous | No (blocking) | Yes (non-blocking) |
| Structured data | Strings only | Objects |
| Existing patterns | Only Supabase JWT | All 5 stores already use `db.ts` |
| Cross-tab visibility | `storage` event fires | No native event (not needed here) |

The profile is tiny (~500 bytes), so capacity is not the deciding factor.
The deciding factor is **consistency with the existing architecture**: all
offline data lives in the `capture_app` IndexedDB database, accessed through
the `db.ts` abstraction. Adding a sixth store (`auth_profile`) follows the
existing pattern and can be swapped to Capacitor SQLite alongside the rest.

### Proposed store

```
Store: auth_profile
Key path: id
Indexes: (none needed — single-record store)
Record: { id: 'current', ...PersistedAuthProfile }
```

A single record with a fixed key (`'current'`). This mirrors the
`active_capture_draft` pattern in the `drafts` store.

### Why not a separate database

A separate IndexedDB database would require a second `openDB()` call and
duplicate the upgrade logic. Since `db.ts` is already shared infrastructure,
adding the store to `capture_app` is simpler and follows the established
convention.

### Relationship to Supabase localStorage JWT

The Supabase JWT remains in localStorage (managed by `@supabase/supabase-js`).
The `auth_profile` record in IndexedDB is a **profile cache**, not a session
token. The JWT proves identity (to Supabase when online). The cached profile
provides application-level user data (to the UI when offline). They are
independent: the JWT can be valid while the profile cache is stale, and vice
versa.

---

## 6. Recommended Authentication State Model

```
                    ┌───────────┐
                    │  BOOTING  │
                    │ loading=  │
                    │  true     │
                    └─────┬─────┘
                          │
          ┌───────────────┼───────────────┐
          │               │               │
          ▼               ▼               ▼
   ┌─────────────┐ ┌─────────────┐ ┌─────────────┐
   │   ONLINE    │ │   OFFLINE   │ │  NO CACHE   │
   │ Session +   │ │ Session +   │ │             │
   │ network OK  │ │ no network  │ │             │
   └──────┬──────┘ └──────┬──────┘ └──────┬──────┘
          │               │               │
          ▼               ▼               ▼
   loadRepProfile   loadCachedProfile   render LoginPage
   from server      from IndexedDB      (no offline eligibility)
          │               │
          │               │
          ▼               ▼
   ┌─────────────────────────────────────┐
   │        AUTHENTICATED                │
   │  salesRep populated                 │
   │  loading=false                      │
   │  authMode = 'online' | 'offline'    │
   └─────────────────────────────────────┘
          │
          │ on reconnect
          ▼
   revalidateProfile()
   ├── server confirms → update cache, authMode='online'
   ├── server says disabled/inactive → signOut + clearCache
   └── network still failing → keep offline mode, retry later
```

### New state fields in AuthContext

```typescript
type AuthMode = 'online' | 'offline' | 'booting';

interface AuthContextType {
  // existing fields...
  user:       AuthUser | null;
  salesRep:   SalesRep | null;
  authUser:   SupabaseUser | null;
  session:    Session | null;
  loading:    boolean;

  // new fields
  authMode:   AuthMode;        // distinguishes online-validated vs offline-cached
  // ...
}
```

### Key invariant

`salesRep` is non-null if EITHER:
1. `loadRepProfile()` succeeded from the server (online mode), OR
2. A cached profile exists in IndexedDB AND there is a valid Supabase JWT in
   localStorage AND `logoutStamp` is null (offline mode).

---

## 7. Startup/Reconnection/Logout State Transitions

### K. Startup behavior matrix

| Scenario | Supabase JWT | Cached profile | Network | Behavior |
|----------|-------------|----------------|---------|----------|
| **Returning user, online** | Valid (localStorage) | Exists | Available | `loadRepProfile()` from server. Update cache. `authMode='online'`. |
| **Returning user, offline** | Valid (localStorage) | Exists | Unavailable | Load profile from `auth_profile` IDB store. Verify JWT exists (not expired locally). `authMode='offline'`. Render app. |
| **No previous user, offline** | None | None | Unavailable | Render LoginPage. User cannot log in (no network). Show "Connect to the internet to sign in." |
| **Invalid/expired JWT** | Expired/missing | Exists | Available | Supabase `onAuthStateChange` fires with `null` session. Clear `salesRep`. Render LoginPage. Clear cached profile. |
| **Disabled/unauthorized rep** | Valid | Exists (stale) | Available | `loadRepProfile()` returns `login_enabled=false` or `is_active=false`. Sign out. Clear cached profile. Render LoginPage. |
| **Returning user, offline, JWT expired** | Expired | Exists | Unavailable | Supabase may fire `TOKEN_REFRESHED` failure → `SIGNED_OUT`. `onAuthStateChange` fires with null. Cannot restore offline. Render LoginPage. Show "Your session expired. Connect to the internet to sign in again." |

### L. Explicit logout — invalidation

```
logout()
  ├── supabase.auth.signOut()           // clears JWT from localStorage
  ├── setLogoutStamp() in auth_profile  // sets logoutStamp = now()
  ├── setSalesRep(null)
  └── onAuthStateChange fires → confirms null session
```

The `logoutStamp` ensures that even if the JWT is still in localStorage
(signOut is async), the next startup sees the logout stamp and does not
restore the offline profile. The stamp is cleared only on the next
**successful online authentication**.

### M. Reconnection revalidation

```
  navigator.onLine fires 'online' event
    │
    ▼
  revalidateProfile()
    ├── loadRepProfile() from server
    │     ├── success + login_enabled + is_active
    │     │     → update auth_profile cache
    │     │     → clear logoutStamp
    │     │     → authMode = 'online'
    │     │
    │     ├── success + disabled/inactive
    │     │     → signOut()
    │     │     → clear auth_profile cache
    │     │     → render LoginPage
    │     │
    │     ├── error (network still flaky)
    │     │     → keep offline mode, schedule retry
    │     │
    │     └── no data (rep row deleted)
    │           → signOut()
    │           → clear auth_profile cache
    │           → render LoginPage
    │
    └── also flushQueue() (existing offline sync behavior)
```

---

## 8. Exact Files That Would Need Modification

| File | Change | Scope |
|------|--------|-------|
| `src/capture/db.ts` | Add `auth_profile` object store to `onupgradeneeded`. Bump `DB_VERSION` from 8 to 9. | Small: ~10 lines in the upgrade handler |
| `src/capture/authProfileStorage.ts` | **New file.** CRUD for the `auth_profile` store: `saveCachedProfile()`, `loadCachedProfile()`, `clearCachedProfile()`, `setLogoutStamp()`, `clearLogoutStamp()`. Mirrors the pattern in `completedLeadsStorage.ts`. | New: ~80 lines |
| `src/AuthContext.tsx` | The core change. (1) On startup, if `loadRepProfile` fails due to network, fall back to cached profile. (2) On successful profile load, write to cache. (3) Add `authMode` state. (4) On explicit logout, set logout stamp. (5) Add reconnect listener that revalidates. (6) Distinguish network errors from auth errors. | Medium: ~60–80 lines of changes across `loadRepProfile`, `logout`, and a new `revalidateProfile` function, plus the startup effect |
| `src/App.tsx` | Pass `authMode` to `Layout` if the UI needs to show an "Offline mode" indicator in the header. Optionally show a banner. | Small: ~5–10 lines |

**Files that should NOT be modified:**
- `src/capture/captureOfflineQueue.ts` — the queue uses `ownerId` which will come from the cached profile
- `src/capture/captureBackendSync.ts` — uses `getAuthIdentity()` which calls Supabase; this is fine because sync only runs when online
- `src/capture/captureDraftStorage.ts` — already has `ownerId` support
- `src/capture/completedLeadsStorage.ts` — already has `ownerId` support
- `src/capture/captureAuth.ts` — `getAuthIdentity()` is used by sync ops that only fire when online
- `src/supabaseClient.ts` — no changes needed; `persistSession: true` is already correct
- All migration files — no schema changes needed (this is a client-side-only change)
- All ALPE files — the scheduler already takes `userId` as a parameter

---

## 9. Security Risks and Mitigations

### Risk 1: Offline access after account revocation

**Scenario:** Admin disables a rep's account. The rep opens the app offline.
The cached profile has `loginEnabled: true` and `isActive: true` (stale).

**Mitigation:** The cached profile includes `cachedAt` timestamp. On
reconnect, `revalidateProfile()` immediately checks `login_enabled` and
`is_active` from the server. If either is false, the app signs out and
clears the cache. The rep gets offline access only until the next
connectivity window — which is the best achievable without a network.

**Residual risk:** A rep who stays permanently offline retains access
indefinitely. This is an inherent limitation of offline-first architecture.
The mitigation is that any data they capture will be synced (and can be
rejected) when connectivity returns. The rep's `ownerId` is stamped on all
records, so a disabled rep's data can be audited and removed server-side.

### Risk 2: Stale JWT used after server-side session revocation

**Scenario:** Admin revokes a user's session server-side (via Supabase
dashboard). The rep's device still has the JWT in localStorage.

**Mitigation:** Supabase's `autoRefreshToken: true` will attempt to refresh
the JWT. If the session is revoked, the refresh fails and
`onAuthStateChange` fires with `SIGNED_OUT`. This already works correctly in
the current code. The cached profile does not change this — the JWT is the
source of truth for session validity, and the cached profile is only a
profile data cache, not a session token.

### Risk 3: logoutStamp bypass

**Scenario:** An attacker clears IndexedDB to remove the `logoutStamp`,
then reopens the app offline with the JWT still in localStorage.

**Mitigation:** The JWT in localStorage is the primary gate. If the user
signed out, `supabase.auth.signOut()` already cleared the JWT. Without the
JWT, the cached profile is useless — `onAuthStateChange` fires with `null`
session and the app renders LoginPage. The `logoutStamp` is a secondary
defense for the edge case where signOut is async and the app is killed
before it completes.

### Risk 4: Network error misclassified as auth error (current bug)

**Scenario:** `loadRepProfile` fails due to network. Current code calls
`signOut()`, destroying the JWT. The user is locked out even when online
connectivity returns moments later.

**Mitigation:** The fix must inspect the error to distinguish:
- `FetchError` / `TypeError: Failed to fetch` → network error, do NOT sign out
- `PostgrestError` with status 401 → auth error, sign out
- `PostgrestError` with status 403 → authorization error, sign out
- No data returned (data=null, error=null) → ambiguous; check `navigator.onLine`
  before deciding

### Risk 5: Cached profile used across users on a shared device

**Scenario:** Rep A logs in, caches profile. Rep A signs out. Rep B logs in
on the same device. Could Rep B see Rep A's cached profile?

**Mitigation:** On explicit logout, the cache is cleared (or stamped). On
successful login by Rep B, the cache is overwritten with Rep B's profile.
The `ownerId` on all IndexedDB records (drafts, assets, completed_leads,
pending_ops) ensures Rep B cannot see Rep A's capture data. The `auth_profile`
store uses a fixed key (`'current'`), so there is only ever one cached
profile — it is overwritten on each login.

---

## 10. Recommended Implementation — Small Testable Steps

Each step is independently testable. Do not proceed to the next step until
the current one passes its verification.

### Step 1: Add `auth_profile` store to IndexedDB

**Files:** `src/capture/db.ts`

**Changes:**
- Bump `DB_VERSION` from 8 to 9.
- In `onupgradeneeded`, add:
  ```typescript
  if (!db.objectStoreNames.contains('auth_profile')) {
    db.createObjectStore('auth_profile', { keyPath: 'id' });
  }
  ```

**Test:** Open the app. Verify in DevTools → Application → IndexedDB that
the `capture_app` database is at version 9 and has an `auth_profile` store.
Verify existing stores and data are intact (non-destructive upgrade).

### Step 2: Create `authProfileStorage.ts` service

**Files:** New file `src/capture/authProfileStorage.ts`

**Functions:**
- `saveCachedProfile(profile: PersistedAuthProfile): Promise<void>`
- `loadCachedProfile(): Promise<PersistedAuthProfile | null>`
- `clearCachedProfile(): Promise<void>`
- `setLogoutStamp(): Promise<void>` — sets `logoutStamp = new Date().toISOString()`
- `clearLogoutStamp(): Promise<void>` — sets `logoutStamp = null`

**Pattern:** Follow `completedLeadsStorage.ts` — use `dbPut`, `dbGet`, `dbDelete`
from `db.ts`. Single record, key = `'current'`.

**Test:** Write a profile, read it back, verify all fields round-trip. Clear
it, verify `loadCachedProfile()` returns null. Set logout stamp, verify it
persists. This can be tested from the browser console.

### Step 3: Cache profile on successful online auth

**Files:** `src/AuthContext.tsx`

**Changes:**
- Import `saveCachedProfile` from `authProfileStorage.ts`.
- In `loadRepProfile()`, after `setSalesRep(data)` (line 129), call
  `saveCachedProfile(...)` with the profile data plus `cachedAt` and
  `sessionValidAt` timestamps and `logoutStamp: null`.

**No behavior change yet** — this only writes the cache. The startup path
does not read it yet.

**Test:** Log in online. Verify the `auth_profile` record appears in
IndexedDB with correct fields. Log out. Verify the record still exists (it
will be cleared/stamped in a later step). Log in again. Verify the record
is updated with fresh timestamps.

### Step 4: Distinguish network errors from auth errors

**Files:** `src/AuthContext.tsx`, `loadRepProfile` function

**Changes:**
- Before calling `signOut()` on error (line 109), inspect the error:
  - If the error is a `FetchError` / network error (message contains "Failed
    to fetch" or error type is `TypeError`), do NOT call `signOut()`.
    Instead, set `salesRep` to null and set a new state flag
    `profileLoadFailed: true`.
  - If the error is a PostgREST error with a status code (401, 403), call
    `signOut()` as before.
- In the catch block (line 142), apply the same logic.

**Test:** Log in online. Disconnect network. Refresh the page. Verify the
JWT is NOT cleared from localStorage (no signOut). Verify the app shows
LoginPage (because the cache is not yet being read — that's Step 5).
Reconnect. Refresh. Verify the app loads normally.

### Step 5: Fall back to cached profile on network failure

**Files:** `src/AuthContext.tsx`

**Changes:**
- In `loadRepProfile()`, when a network error is detected (from Step 4):
  - Call `loadCachedProfile()`.
  - If a cached profile exists AND `logoutStamp` is null:
    - Set `salesRep` from the cached profile.
    - Set `authMode = 'offline'`.
    - Set `loading = false`.
  - If no cached profile OR `logoutStamp` is not null:
    - Set `salesRep = null`, `loading = false` (render LoginPage).
- Also handle the `data === null` case (line 114): if `navigator.onLine` is
  false, treat as network error (fall back to cache). If online, treat as
  unauthorized (sign out).

**Test:**
1. Log in online. Verify cache is written.
2. Disconnect network. Kill the app. Reopen.
3. Verify the app loads with `authMode='offline'`, showing the rep's name
   in the header.
4. Verify the Capture page works (can create drafts offline).
5. Verify the Queue page shows existing completed leads.

### Step 6: Add reconnect revalidation

**Files:** `src/AuthContext.tsx`

**Changes:**
- Add a `useEffect` that listens for the `online` window event (or reuse
  `useOnlineStatus` from `src/capture/useOnlineStatus.ts`).
- On reconnect, if `authMode === 'offline'`:
  - Call `loadRepProfile()` from the server.
  - On success: update cache, set `authMode = 'online'`.
  - On disabled/inactive: sign out, clear cache, render LoginPage.
  - On network error: stay in offline mode, schedule retry on next
    reconnect.

**Test:**
1. Log in online. Disconnect. Kill. Reopen (offline mode).
2. Reconnect network.
3. Verify the app transitions to online mode (can see fresh data in Leads
   page, sync queue flushes).
4. Repeat, but this time have an admin disable the rep account before
   reconnecting.
5. Verify the app signs out and renders LoginPage on reconnect.

### Step 7: Invalidate cache on explicit logout

**Files:** `src/AuthContext.tsx`, `logout` function

**Changes:**
- In `logout()`, before calling `supabase.auth.signOut()`:
  - Call `setLogoutStamp()` to write `logoutStamp = now()` to the cached
    profile.
- After `signOut()` completes (in the `onAuthStateChange` handler):
  - Optionally call `clearCachedProfile()` to remove the record entirely.
  - Keeping the `logoutStamp` approach is safer (survives even if
    `clearCachedProfile` fails).

**Test:**
1. Log in online. Verify cache exists.
2. Tap "Log Out".
3. Disconnect network. Reopen the app.
4. Verify the app shows LoginPage (does NOT restore offline profile).
5. Verify the `auth_profile` record has `logoutStamp` set (or is deleted).

### Step 8: Clear logoutStamp on successful online login

**Files:** `src/AuthContext.tsx`, `loadRepProfile` function

**Changes:**
- When `loadRepProfile()` succeeds from the server and writes the cache
  (Step 3), ensure `logoutStamp: null` is included in the written record.
  This is already covered in Step 3's `saveCachedProfile` call, but verify
  it explicitly.

**Test:**
1. Log in. Log out. (logoutStamp set)
2. Log in again online.
3. Verify `logoutStamp` is null in the cached profile.
4. Disconnect. Kill. Reopen.
5. Verify offline mode works (logoutStamp was cleared by successful login).

### Step 9 (optional): Surface offline auth mode in the UI

**Files:** `src/App.tsx`

**Changes:**
- Read `authMode` from `useAuth()`.
- When `authMode === 'offline'`, show a subtle banner or indicator in the
  header (e.g., "Offline — cached session" with a small cloud-off icon).
- This is purely informational and helps the rep understand why some data
  may be stale.

**Test:** Verify the banner appears in offline mode and disappears on
reconnect.

---

## Appendix: Module Reference for Audit

| Module | Role in auth | Relevant to offline auth? |
|--------|-------------|--------------------------|
| `src/AuthContext.tsx` | Auth provider: session, salesRep, login, logout | **Core** — all changes here |
| `src/supabaseClient.ts` | Supabase client config: `persistSession: true`, `autoRefreshToken: true` | No changes needed |
| `src/capture/captureAuth.ts` | `getAuthIdentity()` — resolves userId + repCode from Supabase | Used by sync ops (online only) — no changes |
| `src/capture/db.ts` | Raw IndexedDB abstraction | Add `auth_profile` store |
| `src/capture/captureOfflineQueue.ts` | Offline sync queue | Uses `ownerId` — will receive it from cached profile via AuthContext |
| `src/capture/completedLeadsStorage.ts` | Completed leads store | Already has `by_owner` index — no changes |
| `src/capture/captureDraftStorage.ts` | Drafts store | Already has `ownerId` — no changes |
| `src/capture/useOnlineStatus.ts` | Browser online/offline detection | Reuse for reconnect listener |
| `src/alpe/useAlpeScheduler.ts` | Scheduler lifecycle hook | Takes `userId` from `user?.authUserId` — no changes needed |
| `src/App.tsx` | Root: auth gate (`user ? Layout : LoginPage`) | Optionally surface `authMode` |
| `src/LoginPage.tsx` | Login form | No changes needed |
| Migration `20260525092030` | `link_auth_user_to_rep`, `my_rep_profile`, `get_rep_email_by_code` | Server-side — no changes |
| Migration `20260525102923` | `get_rep_login_status` (case-insensitive) | Server-side — no changes |
