/** Transport availability only. This module never grants cloud authorization. */
export interface ConnectivityProvider {
  readStatus(): boolean | Promise<boolean>;
  subscribe(onChange: (online: boolean) => void, reconcile: () => void): () => void;
}

export function createConnectivityStore(provider: ConnectivityProvider, initial = true) {
  let online = initial;
  let activated = false;
  let revision = 0;
  let generation = 0;
  let stop: (() => void) | undefined;
  let running = false;
  const listeners = new Set<() => void>();
  const publish = (value: boolean) => {
    if (online === value) return;
    online = value;
    // A consumer failure must not starve auth or other UI subscribers.
    listeners.forEach(listener => {
      try { listener(); } catch { /* The transport transition still reaches other consumers. */ }
    });
  };
  const reconcile = () => {
    const token = ++revision;
    const lifecycle = generation;
    try {
      const result = provider.readStatus();
      if (typeof result === 'boolean') {
        if (token === revision && lifecycle === generation) publish(result);
      }
      else void result.then(value => {
        if (token === revision && lifecycle === generation) publish(value);
      }).catch(() => { /* Preserve the last known state on provider failure. */ });
    } catch { /* Preserve the last known state. */ }
  };
  return {
    // Pure reads, including before activation and after cleanup.
    getSnapshot: () => online,
    configureProvider(nextProvider: ConnectivityProvider, seed: boolean) {
      if (activated) throw new Error('Connectivity provider must be configured before first activation');
      provider = nextProvider;
      online = seed;
      initial = seed;
    },
    getServerSnapshot: () => initial,
    subscribe(listener: () => void) {
      listeners.add(listener);
      if (!running) {
        activated = true;
        running = true;
        const lifecycle = ++generation;
        try {
          stop = provider.subscribe(value => {
            if (lifecycle !== generation) return;
            ++revision; // An event supersedes any outstanding status lookup.
            publish(value);
          }, () => { if (lifecycle === generation) reconcile(); });
        } catch { /* Initial snapshot remains usable if subscription fails. */ }
        reconcile();
      }
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        listeners.delete(listener);
        if (!listeners.size) {
          ++generation;
          ++revision;
          running = false;
          stop?.();
          stop = undefined;
        }
      };
    },
  };
}

export function readBrowserConnectivity(): boolean {
  return typeof navigator === 'undefined' || navigator.onLine !== false;
}

export function createBrowserConnectivityProvider(): ConnectivityProvider {
  return {
    readStatus: readBrowserConnectivity,
    subscribe(_onChange, reconcile) {
      if (typeof window === 'undefined') return () => {};
      // Events are hints to read the current browser state, just like foreground
      // reconciliation. A delayed event must not publish a stale boolean.
      const onOnline = () => reconcile();
      const onOffline = () => reconcile();
      const onVisible = () => {
        if (typeof document === 'undefined' || document.visibilityState === 'visible') reconcile();
      };
      window.addEventListener('online', onOnline);
      window.addEventListener('offline', onOffline);
      window.addEventListener('focus', onVisible);
      if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible);
      return () => {
        window.removeEventListener('online', onOnline);
        window.removeEventListener('offline', onOffline);
        window.removeEventListener('focus', onVisible);
        if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible);
      };
    },
  };
}

// Platform bootstrap may configureProvider before activation; store identity stays fixed.
export const connectivityStore = createConnectivityStore(createBrowserConnectivityProvider(), readBrowserConnectivity());
export const isTransportOnline = connectivityStore.getSnapshot;
