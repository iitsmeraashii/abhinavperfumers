// RuntimeConfiguration — loads, caches, and exposes diagnostics configuration.
//
// The configuration lives in a single-row Supabase table (`runtime_configuration`,
// id = 1). On first access the row is fetched once and cached in memory. All
// subsequent reads are O(1) lookups against the cache — no database calls.
//
// Realtime: a Supabase realtime channel can be attached via `subscribe()`. When
// a row update arrives, the cache is refreshed in the background. This is
// infrastructure only — no existing code wires into it yet.

import { supabase } from '../supabaseClient';

// ─── Configuration model ─────────────────────────────────────────────────────

export interface DiagnosticsConfig {
  enabled:       boolean;
  console:       boolean;
  runtimeDumps:  boolean;
  database:      boolean;
  timers:        boolean;
}

const ALL_FALSE: DiagnosticsConfig = {
  enabled:      false,
  console:      false,
  runtimeDumps: false,
  database:     false,
  timers:       false,
};

// ─── Database row shape ──────────────────────────────────────────────────────

interface ConfigRow {
  diagnostics_enabled:       boolean | null;
  diagnostics_console:       boolean | null;
  diagnostics_runtime_dumps: boolean | null;
  diagnostics_database:      boolean | null;
  diagnostics_timers:        boolean | null;
}

// ─── Cache state ─────────────────────────────────────────────────────────────

let _cache: DiagnosticsConfig | null = null;
let _loadPromise: Promise<DiagnosticsConfig> | null = null;
let _realtimeChannel: ReturnType<typeof supabase.channel> | null = null;

// ─── Internal helpers ────────────────────────────────────────────────────────

function mapRow(row: ConfigRow | null): DiagnosticsConfig {
  if (!row) return { ...ALL_FALSE };
  return {
    enabled:      row.diagnostics_enabled       ?? false,
    console:      row.diagnostics_console       ?? false,
    runtimeDumps: row.diagnostics_runtime_dumps ?? false,
    database:     row.diagnostics_database      ?? false,
    timers:       row.diagnostics_timers        ?? false,
  };
}

async function fetchConfig(): Promise<DiagnosticsConfig> {
  const { data, error } = await supabase
    .from('runtime_configuration')
    .select(
      'diagnostics_enabled, diagnostics_console, diagnostics_runtime_dumps, diagnostics_database, diagnostics_timers',
    )
    .eq('id', 1)
    .maybeSingle();

  if (error) return { ...ALL_FALSE };
  return mapRow(data as ConfigRow | null);
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Load configuration from the database and cache it.
 * Subsequent calls return the cached value unless `reload()` is called.
 * Safe to call concurrently — deduplicates to a single fetch.
 */
export async function load(): Promise<DiagnosticsConfig> {
  if (_cache) return _cache;
  if (_loadPromise) return _loadPromise;

  _loadPromise = fetchConfig()
    .then(config => {
      _cache = config;
      return config;
    })
    .finally(() => {
      _loadPromise = null;
    });

  return _loadPromise;
}

/**
 * Re-fetch configuration from the database and update the cache.
 * Returns the new configuration.
 */
export async function reload(): Promise<DiagnosticsConfig> {
  _loadPromise = null;
  _cache = await fetchConfig();
  return _cache;
}

/**
 * Synchronously return the cached configuration.
 * Returns all-false if the cache has not been loaded yet.
 * This is the O(1) path — never hits the database.
 */
export function getCached(): DiagnosticsConfig {
  return _cache ?? { ...ALL_FALSE };
}

/**
 * Returns true if `load()` has completed at least once and the cache is populated.
 */
export function isLoaded(): boolean {
  return _cache !== null;
}

/**
 * Subscribe to Supabase realtime updates on the configuration row.
 * When a row change arrives, the cache is refreshed in the background.
 *
 * This is infrastructure for future use — no existing code calls it.
 * Returns an unsubscribe function. Calling it tears down the channel.
 */
export function subscribe(): () => void {
  if (_realtimeChannel) return () => unsubscribe();

  _realtimeChannel = supabase
    .channel('runtime_configuration_changes')
    .on(
      'postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'runtime_configuration' },
      () => { void reload(); },
    )
    .subscribe();

  return unsubscribe;
}

/**
 * Remove the realtime subscription if one is active.
 */
export function unsubscribe(): void {
  if (!_realtimeChannel) return;
  void supabase.removeChannel(_realtimeChannel);
  _realtimeChannel = null;
}
