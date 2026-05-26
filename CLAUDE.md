# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev          # Vite dev server (HMR overlay disabled — see vite.config.ts)
npm run build        # Production build — always run this to verify before marking work done
npm run typecheck    # tsc --noEmit, faster than build for type errors
npm run lint         # ESLint
```

No test suite exists. Type-check and build are the verification tools.

## What This App Is

An **offline-first sales portal** for field sales reps at perfume trade events. Reps capture leads (contact details) at booths via three methods:

1. **Business card photo** — image sent to an OpenAI Vision edge function (`extract-business-card`), falls back to Tesseract.js OCR locally
2. **QR code scan** — parsed locally, no network needed
3. **Manual entry** — form fields

All captures work fully offline. Data is stored in IndexedDB and synced to Supabase when connectivity returns. The admin sees a dashboard with lead funnels, system status tiles, and per-event metrics. Leads have a lifecycle: `lead_status` (NEW → CONTACTED → QUALIFIED → CONVERTED / LOST) and `system_status` for WhatsApp delivery tracking.

## Architecture

### Routing

There is **no React Router**. Navigation is entirely tab-based state managed in `App.tsx` (`Layout` component):

- `tab` state: `'dashboard' | 'leads' | 'capture' | 'templates' | 'events' | 'notifications'`
- URL params (`?lead=`, `?followup=`) are synced to state via `window.history.pushState` and a `popstate` listener
- The `LeadsPage` component is remounted (via `key` prop) when the active event filter or dashboard tile filter changes

### Auth

Supabase email/password auth, but the user-facing login uses **rep_code + password** (not email). Login flow:

1. Frontend calls `get_rep_login_status(rep_code)` RPC → returns email
2. Frontend calls `supabase.auth.signInWithPassword({ email, password })`
3. `onAuthStateChange` fires → `link_auth_user_to_rep()` RPC (idempotent, links `auth.uid()` to `sales_representatives.auth_user_id` on first login) → loads rep profile from `my_rep_profile` view

`AuthContext` exposes both a `user: AuthUser` (legacy shape used everywhere) and `salesRep: SalesRep` (full row). All page components use the legacy `user` shape via `useAuth()`.

Roles: `admin` sees dashboard, events, templates, all leads; `sales_rep` sees only their own leads and the capture screen.

### Offline Capture Architecture (`src/capture/`)

The capture system is the most complex part of the app. Key flow:

1. `CaptureLeadPage` manages the top-level state machine via `useCaptureSession` hook
2. On any user action, a draft is saved to IndexedDB (`captureDraftStorage.ts` → `db.ts`) every 700ms (debounced autosave)
3. Backend sync (`captureBackendSync.ts`) is **fire-and-forget** — never awaited by UI, uses idempotent upserts with stable frontend-generated UUIDs
4. When **offline**: sync calls are enqueued via `captureOfflineQueue.ts` to the `pending_ops` IndexedDB store instead of being dropped
5. When connectivity returns: `useOnlineStatus` fires `onReconnect` → `flushQueue()` replays all ops in creation order
6. On page reload with an existing draft: `loadDraft()` restores the session, and if online re-syncs the session to the backend

**IndexedDB stores** (version 3, `db.ts`):
- `drafts` — single active draft keyed by `'active_capture_draft'`
- `assets` — business card images (compressed JPEG dataURLs, max 1200px)
- `pending_ops` — offline sync queue

**Sync tables in Supabase**:
- `capture_sessions` — one row per capture attempt, `user_id` scoped
- `capture_assets` — one row per card photo
- `extraction_results` — one row per extraction (engine: `openai_vision`, `tesseract_ocr`, `qr_parser`)

Capture sessions are not yet automatically promoted to `lead_entries` — that step is not yet implemented in the UI.

### Database Schema (Key Tables)

**Core business tables:**
- `sales_representatives` — reps with `rep_code`, `role` (`admin`/`sales_rep`), `auth_user_id` FK to `auth.users`
- `events` — trade events with `event_code`, `status` (`draft`/`active`/`completed`)
- `lead_entries` — submitted leads with `lead_type` (NEW/EXISTING), `lead_temperature` (Hot/Warm/Cold), `lead_status` (NEW/CONTACTED/QUALIFIED/CONVERTED/LOST), `system_status` (CREATED/WHATSAPP_SENT/WHATSAPP_FAILED/INVALID_LEAD)
- `lead_notes` — per-lead notes
- `lead_follow_ups` — follow-up tasks linked to leads

**Views:**
- `leads_list_view` — main list query with `search_text`, `lead_status`, `system_status`, `state`, `application`
- `my_rep_profile` — RLS-filtered view returning only the authenticated rep's own row

**RLS pattern:** All tables use `auth.uid() = user_id` (capture tables) or `auth.uid() = auth_user_id` (sales_representatives). Views use `SECURITY INVOKER`. The `get_rep_email_by_code` and `link_auth_user_to_rep` functions are `SECURITY DEFINER`.

### Edge Function

`supabase/functions/extract-business-card/index.ts` — accepts a business card image (multipart, JSON with base64, or raw), calls `gpt-4o` with a structured system prompt, normalizes the output, retries once on failure. Requires `OPENAI_API_KEY` edge function secret. Returns 503 if key is missing (frontend falls back to Tesseract).

## Environment Variables

```
VITE_SUPABASE_URL        # Supabase project URL
VITE_SUPABASE_ANON_KEY   # Supabase anon/public key
VITE_APP_NAME            # Optional — shown in header (default: "Abhinav Perfumers")
```

Edge function secret (deployed separately, not in `.env`):
```
OPENAI_API_KEY           # Optional — if absent, vision extraction returns 503, Tesseract fallback used
```

## Key Conventions

**Sync IDs are frontend-generated.** All backend upserts use stable UUIDs created on the frontend (`crypto.randomUUID()`). This makes every sync operation safely idempotent and replayable.

**No sync operation blocks the UI.** `captureBackendSync.ts` functions are always called without `await` from UI code. Failures update `syncStatus` state but never throw to the user. The `pendingOps` counter in `BackendSyncState` tracks in-flight ops for UI indicators only.

**Database migrations use `IF EXISTS` / `IF NOT EXISTS` guards** on every DDL statement — never assume a column or table doesn't exist.

**The `Lead` interface in `LeadsPage.tsx`** must stay aligned with `leads_list_view`. If you add columns to the view, add them to the interface and the `countActiveAdvanced` / `buildParams` / `readParams` functions.

**Dashboard tile navigation:** `DashboardPage` accepts `onNavigateToLeads(filter: DashboardFilter)`. `LeadsPage` accepts `initialFilters: LeadsInitialFilters`. `App.tsx` holds `leadsInitialFilters` state and remounts `LeadsPage` with a composite `key` when it changes. System status filters land in `applied.systemStatus` (shown as chips); lead status filters land in `statusFilter` (shown as highlighted pills in the filter bar).

**`lucide-react` and `tesseract.js` are excluded from Vite pre-bundling** (`optimizeDeps.exclude`) because they are too large. `html5-qrcode` is code-split into its own chunk.
