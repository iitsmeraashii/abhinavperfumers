/*
# Create runtime_configuration table

1. Purpose
   - Single-row configuration store for the Runtime Diagnostics framework.
   - Holds boolean flags that control which diagnostic subsystems are active.
   - Read by RuntimeConfiguration (in-memory cache); never queried per API call.

2. New Tables
   - `runtime_configuration`
     - `id` (int2, primary key, always 1 — enforced by CHECK constraint)
     - `diagnostics_enabled`     (bool, default false) — master switch
     - `diagnostics_console`      (bool, default false) — console output
     - `diagnostics_runtime_dumps` (bool, default false) — runtime dump capture
     - `diagnostics_database`    (bool, default false) — database-level diagnostics
     - `diagnostics_timers`       (bool, default false) — timer/performance tracking
     - `updated_at` (timestamptz, default now()) — last modification time

3. Security
   - RLS enabled.
   - This app has a sign-in screen (sales reps + admin), so policies are scoped
     to `authenticated` with ownership-free read (config is shared app-wide).
   - SELECT: any authenticated user can read (needed for frontend config load).
   - UPDATE: any authenticated user can update (admin-only enforcement is a
     future concern; for now the framework is infrastructure with no UI).
   - No INSERT/DELETE policies — the single row is seeded by this migration.

4. Notes
   - A CHECK constraint locks `id = 1` so the table can only ever hold one row.
   - The migration seeds that row with all flags false (safe defaults).
*/

CREATE TABLE IF NOT EXISTS runtime_configuration (
  id                        int2 PRIMARY KEY DEFAULT 1,
  diagnostics_enabled       boolean NOT NULL DEFAULT false,
  diagnostics_console       boolean NOT NULL DEFAULT false,
  diagnostics_runtime_dumps boolean NOT NULL DEFAULT false,
  diagnostics_database      boolean NOT NULL DEFAULT false,
  diagnostics_timers        boolean NOT NULL DEFAULT false,
  updated_at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT singleton_row CHECK (id = 1)
);

ALTER TABLE runtime_configuration ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "read_runtime_configuration" ON runtime_configuration;
CREATE POLICY "read_runtime_configuration"
  ON runtime_configuration FOR SELECT
  TO authenticated
  USING (true);

DROP POLICY IF EXISTS "update_runtime_configuration" ON runtime_configuration;
CREATE POLICY "update_runtime_configuration"
  ON runtime_configuration FOR UPDATE
  TO authenticated
  USING (true) WITH CHECK (true);

-- Seed the singleton row if it doesn't exist.
INSERT INTO runtime_configuration (id)
VALUES (1)
ON CONFLICT (id) DO NOTHING;
