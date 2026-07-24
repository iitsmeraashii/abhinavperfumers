// Capture Connectivity — a strongly typed model for network state that is
// independent of Capture Profile.
//
// Connectivity is NOT a profile concern. It is a runtime environment condition
// that the Execution Engine combines with the active profile to produce an
// Execution Plan. Modelling it separately avoids boolean explosion (e.g.
// `isOnline` + `isReconnecting` + `isDegrading` scattered across the codebase)
// and makes future states easy to add without touching profile code.
//
// Currently only ONLINE and OFFLINE are observed. RECONNECTING is declared so
// that the flush/replay path can distinguish "queue is flushing" from "steady
// online" in the execution plan without introducing a second boolean flag.

export enum ConnectivityState {
  ONLINE       = 'ONLINE',
  OFFLINE      = 'OFFLINE',
  RECONNECTING = 'RECONNECTING',
}

/**
 * Immutable snapshot of the device's connectivity at a point in time.
 * The Execution Engine reads this to decide which strategy paths are
 * executable.
 */
export interface ConnectivitySnapshot {
  state:      ConnectivityState;
  /** Raw navigator.onLine value at the time the snapshot was taken. */
  isOnline:   boolean;
}

/**
 * Build a connectivity snapshot from the current browser state.
 * Callers pass their existing `isOnline` boolean; the snapshot wraps it
 * in the typed model so downstream code never touches raw booleans.
 */
export function createConnectivitySnapshot(isOnline: boolean): ConnectivitySnapshot {
  return {
    state:    isOnline ? ConnectivityState.ONLINE : ConnectivityState.OFFLINE,
    isOnline,
  };
}
