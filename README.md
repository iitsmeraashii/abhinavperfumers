# Abhinav Perfumers — Sales Portal

[![Open in Bolt](https://bolt.new/static/open-in-bolt.svg)](https://bolt.new/~/sb1-qi8athxr)

An offline-first web application for sales reps to capture and manage leads at trade events. Supports business card scanning (AI-powered), QR code scanning, and manual entry — all work without an internet connection.

## Stack

- **Frontend:** React 18 + TypeScript + Vite + Tailwind CSS
- **Backend:** Supabase (PostgreSQL + Auth + Edge Functions + Storage)
- **AI Extraction:** OpenAI GPT-4o via Supabase Edge Function
- **Local OCR Fallback:** Tesseract.js (runs in-browser)
- **QR Parsing:** html5-qrcode (lazy-loaded)
- **Offline Storage:** IndexedDB (drafts, images, sync queue)

## Features

### Lead Capture (all methods work offline)
- **Business Card** — photograph a card, AI extracts contact fields automatically; when offline, fields are captured manually and images sync later
- **QR Code** — scan vCard/MeCard QR codes, parsed entirely in-browser
- **Manual Entry** — direct form input

### Offline-First Sync
- All captures save immediately to IndexedDB
- Pending backend operations queue in IndexedDB when offline
- Queue flushes automatically on reconnect, replaying ops in order
- Page reloads restore the active draft session

### Admin Dashboard
- Lead volume metrics (today / 7 days / 30 days)
- System status breakdown (WhatsApp sent/failed, invalid leads)
- Lead status funnel (New → Contacted → Qualified → Converted)
- Clicking any tile navigates to the leads list with that filter pre-applied

### Leads Management
- Paginated list with search, date, status, and advanced filters
- Lead status lifecycle: NEW → CONTACTED → QUALIFIED → CONVERTED / LOST
- Per-rep and per-event filtering (admin only)
- CSV export with applied filters preserved
- Notes and follow-up task tracking per lead

## Setup

### Prerequisites
- Node.js 18+
- A Supabase project with the migrations applied

### Environment Variables

Create a `.env` file:

```env
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-key
VITE_APP_NAME=Your App Name
```

### Install and Run

```bash
npm install
npm run dev
```

### Build

```bash
npm run build      # production build
npm run typecheck  # type-check only (faster)
```

### Deploy Edge Function

The `extract-business-card` edge function requires an OpenAI API key. Deploy it via the Supabase dashboard or CLI, then set the `OPENAI_API_KEY` secret. If the key is absent the function returns a 503 and the app falls back to Tesseract.js OCR automatically.

### Database Migrations

Apply migrations in chronological order using the Supabase dashboard SQL editor or MCP tools. All migrations use `IF EXISTS` / `IF NOT EXISTS` guards and are safe to re-run.

## Authentication

Sales reps log in with their **rep code** (e.g. `JAY_KAMDAR`) and password — not an email address. The app maps the rep code to an email internally via the `get_rep_login_status` database function, then authenticates against Supabase Auth.

Accounts must be created by an admin: add a row to `sales_representatives` with a valid `email`, `login_enabled = true`, `is_active = true`, and create a matching Supabase Auth user with the same email. The `auth_user_id` link is written automatically on first login.

Two roles exist:
- **`admin`** — full access: dashboard, all leads, events, templates, notifications
- **`sales_rep`** — capture screen and their own leads only

## Project Structure

```
src/
  App.tsx                    # Root layout, tab-based routing, all navigation state
  AuthContext.tsx            # Supabase auth + rep profile, exposes useAuth()
  DashboardPage.tsx          # Admin KPI tiles + sales funnel
  LeadsPage.tsx              # Paginated leads list + filters
  LeadDetailPage.tsx         # Lead detail, notes, follow-ups
  CaptureLeadPage.tsx        # Capture flow coordinator
  capture/
    types.ts                 # All shared capture types
    useCaptureSession.ts     # Session state machine
    db.ts                    # Raw IndexedDB primitives
    captureDraftStorage.ts   # Draft read/write
    captureAssetStorage.ts   # Image compress + store
    captureBackendSync.ts    # Fire-and-forget Supabase sync
    captureOfflineQueue.ts   # Offline op queue + flush
    useOnlineStatus.ts       # Online/offline detection + reconnect callback
    BusinessCardCapture.tsx  # Camera + extraction UI
    QrScannerView.tsx        # QR scanner (lazy-loaded)
    ManualEntryForm.tsx      # Manual contact form
    useVisionExtraction.ts   # OpenAI Vision + Tesseract fallback

supabase/
  migrations/                # 21 ordered SQL migrations
  functions/
    extract-business-card/   # OpenAI GPT-4o vision edge function
```
