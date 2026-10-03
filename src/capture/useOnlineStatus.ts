import { useEffect, useRef, useSyncExternalStore } from 'react';
import { connectivityStore } from '../connectivity/connectivityStore';

interface UseOnlineStatusOptions {
  onReconnect?: () => void;
  onOffline?: () => void;
}

export function useOnlineStatus(options?: UseOnlineStatusOptions): boolean {
  const isOnline = useSyncExternalStore(
    connectivityStore.subscribe, connectivityStore.getSnapshot, connectivityStore.getServerSnapshot,
  );
  const callbacks = useRef(options);
  callbacks.current = options;
  useEffect(() => {
    let previous = connectivityStore.getSnapshot();
    return connectivityStore.subscribe(() => {
      const next = connectivityStore.getSnapshot();
      if (previous === next) return;
      previous = next;
      if (next) callbacks.current?.onReconnect?.();
      else callbacks.current?.onOffline?.();
    });
  }, []);
  return isOnline;
}
