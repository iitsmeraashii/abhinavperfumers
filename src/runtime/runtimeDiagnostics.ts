// RuntimeDiagnostics — the single source of truth for runtime diagnostics.
//
// Consumes RuntimeConfiguration (in-memory cache only — never hits the database).
// Every check is an O(1) synchronous boolean lookup.
//
// This is infrastructure only. Nothing in the app consumes it yet. Existing
// console logs and ALPE diagnostics are untouched.

import {
  getCached,
  isLoaded,
  load,
  reload,
  subscribe,
  unsubscribe,
} from './runtimeConfiguration';
import type { DiagnosticsConfig } from './runtimeConfiguration';

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Ensure the configuration cache is populated. Call once at app startup.
 * All `isEnabled*` checks work (returning false) even before this completes.
 */
export async function init(): Promise<void> {
  await load();
}

/**
 * Force a re-fetch of configuration from the database.
 */
export async function refresh(): Promise<void> {
  await reload();
}

/**
 * Begin listening for realtime configuration updates.
 * Returns an unsubscribe function.
 */
export function startRealtime(): () => void {
  return subscribe();
}

/**
 * Stop listening for realtime configuration updates.
 */
export function stopRealtime(): void {
  unsubscribe();
}

/**
 * Returns the full configuration snapshot (all five flags).
 * O(1) — reads from the in-memory cache.
 */
export function getConfig(): DiagnosticsConfig {
  return getCached();
}

/**
 * Master switch — if false, all subsystems are off regardless of their
 * individual flags.
 * O(1).
 */
export function isEnabled(): boolean {
  return getCached().enabled;
}

/**
 * Console output subsystem.
 * O(1).
 */
export function isConsoleEnabled(): boolean {
  const c = getCached();
  return c.enabled && c.console;
}

/**
 * Runtime dump capture subsystem.
 * O(1).
 */
export function isRuntimeDumpsEnabled(): boolean {
  const c = getCached();
  return c.enabled && c.runtimeDumps;
}

/**
 * Database diagnostics subsystem.
 * O(1).
 */
export function isDatabaseEnabled(): boolean {
  const c = getCached();
  return c.enabled && c.database;
}

/**
 * Timer / performance tracking subsystem.
 * O(1).
 */
export function isTimersEnabled(): boolean {
  const c = getCached();
  return c.enabled && c.timers;
}

/**
 * Returns true if the configuration cache has been loaded at least once.
 */
export function isReady(): boolean {
  return isLoaded();
}
