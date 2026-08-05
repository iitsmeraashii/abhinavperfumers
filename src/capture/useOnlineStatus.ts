import { useState, useEffect, useCallback, useRef } from 'react';

interface UseOnlineStatusOptions {
  onReconnect?: () => void;
  onOffline?:   () => void;
}

export function useOnlineStatus(options?: UseOnlineStatusOptions): boolean {
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const onReconnectRef = useRef(options?.onReconnect);
  const onOfflineRef = useRef(options?.onOffline);
  onReconnectRef.current = options?.onReconnect;
  onOfflineRef.current = options?.onOffline;

  const handleOnline = useCallback(() => {
    setIsOnline(true);
    onReconnectRef.current?.();
  }, []);

  const handleOffline = useCallback(() => {
    setIsOnline(false);
    onOfflineRef.current?.();
  }, []);

  useEffect(() => {
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, [handleOnline, handleOffline]);

  return isOnline;
}
