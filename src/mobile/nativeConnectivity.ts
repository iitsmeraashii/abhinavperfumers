import { Capacitor, type PluginListenerHandle } from '@capacitor/core';
import { Network } from '@capacitor/network';
import { App } from '@capacitor/app';
import { connectivityStore, type ConnectivityProvider } from '../connectivity/connectivityStore';

/** Native transport adapter. Authorization remains owned by the application. */
export function createNativeConnectivityProvider(): ConnectivityProvider {
  return {
    // Rejections are handled by the shared store, preserving its last-known state.
    async readStatus() {
      return (await Network.getStatus()).connected;
    },
    subscribe(onChange, reconcile) {
      let disposed = false;
      const handles: PluginListenerHandle[] = [];
      const remove = async (handle: PluginListenerHandle) => {
        try { await handle.remove(); } catch { /* Native teardown is best-effort. */ }
      };
      const register = async (add: () => Promise<PluginListenerHandle>) => {
        try {
          const handle = await add();
          if (disposed) await remove(handle);
          else handles.push(handle);
        } catch { /* A failed listener must not prevent startup or other listeners. */ }
      };
      void register(() => Network.addListener('networkStatusChange', status => {
        if (!disposed) onChange(status.connected);
      }));
      void register(() => App.addListener('appStateChange', state => {
        if (!disposed && state.isActive) reconcile();
      }));
      return () => {
        if (disposed) return;
        disposed = true;
        for (const handle of handles.splice(0)) void remove(handle);
      };
    },
  };
}

let configured = false;

/** Called synchronously by the entry point, before React is mounted. */
export function bootstrapNativeConnectivity(): void {
  if (configured || !Capacitor.isNativePlatform()) return;
  connectivityStore.configureProvider(createNativeConnectivityProvider(), connectivityStore.getSnapshot());
  configured = true;
}
