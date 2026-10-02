// Shared auth-mode state — runtime process state only.
//
// AuthContext remains the sole authority for deciding WHICH AuthMode applies.
// This module only holds the last-published value so non-React services can
// synchronously check whether cloud operations are permitted.
//
// No subscriptions, no React imports, no persistence, no async behavior.

export type AuthMode =
  | 'unauthenticated'
  | 'online'
  | 'offline-restored';

let currentAuthMode: AuthMode = 'unauthenticated';

export function getAuthMode(): AuthMode {
  return currentAuthMode;
}

export function setAuthModeState(mode: AuthMode): void {
  currentAuthMode = mode;
}

export function isCloudSyncAllowed(): boolean {
  return currentAuthMode === 'online';
}
