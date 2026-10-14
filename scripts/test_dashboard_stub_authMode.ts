// Test stub for authModeState — allows tests to control isCloudSyncAllowed.
import type { AuthMode } from '../../src/authModeState';

let mode: AuthMode = 'unauthenticated';

export function getAuthMode(): AuthMode { return mode; }
export function setAuthModeState(m: AuthMode): void { mode = m; }
export function isCloudSyncAllowed(): boolean { return mode === 'online'; }

// Re-export the type so imports resolve.
export type { AuthMode };
