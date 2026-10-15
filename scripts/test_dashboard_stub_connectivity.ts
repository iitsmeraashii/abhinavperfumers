// Test stub for connectivityStore — allows tests to control transport state.
let online = true;

export const isTransportOnline = () => online;

// Test control: set the transport state.
export function __setTransportOnline(value: boolean): void {
  online = value;
}

// Minimal connectivityStore shape so useOnlineStatus doesn't crash.
export const connectivityStore = {
  subscribe: (listener: () => void) => {
    // In tests, no real subscription — just return a no-op cleanup.
    return () => {};
  },
  getSnapshot: () => online,
  getServerSnapshot: () => true,
};
