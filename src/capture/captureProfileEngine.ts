// Capture Profile Engine — the orchestration layer that sits between the
// Capture Session and the shared domain services.
//
// Responsibility: resolve the active profile once and expose its strategy
// bundle. The processing pipeline stages read strategies from the engine
// instead of hardcoding behavior. Shared services remain profile-agnostic.
//
// The engine does NOT contain business logic. It coordinates by routing
// decisions to the appropriate strategy, which in turn delegates to the
// shared service that knows HOW to execute.

import type { CaptureProfile } from './captureProfile';
import {
  getProfileStrategies,
  type CaptureProfileStrategies,
} from './profileStrategies';

class CaptureProfileEngine {
  private _strategies: CaptureProfileStrategies | null = null;
  private _profile:    CaptureProfile | null = null;

  /**
   * Resolve and lock the strategy bundle for the given profile.
   * Called once when a capture session begins (or is restored).
   * All downstream orchestration reads from the resolved bundle.
   */
  resolve(profile: CaptureProfile): CaptureProfileStrategies {
    this._profile    = profile;
    this._strategies = getProfileStrategies(profile);
    return this._strategies;
  }

  /**
   * Get the currently resolved strategies. Throws if resolve() was never called.
   * Pipeline stages call this to read their strategy.
   */
  getStrategies(): CaptureProfileStrategies {
    if (!this._strategies) {
      throw new Error('CaptureProfileEngine: no profile resolved. Call resolve() first.');
    }
    return this._strategies;
  }

  /**
   * Get the resolved profile identifier, or null if not yet resolved.
   */
  getProfile(): CaptureProfile | null {
    return this._profile;
  }

  /**
   * Clear the resolved profile. Called on session reset so the next capture
   * resolves fresh.
   */
  reset(): void {
    this._strategies = null;
    this._profile    = null;
  }
}

// Module singleton — one engine instance for the app lifetime.
// The capture session resolves it once; stages read from it without re-resolving.
export const profileEngine = new CaptureProfileEngine();
