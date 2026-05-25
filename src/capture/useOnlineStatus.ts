import { useState, useEffect, useCallback, useRef } from 'react';

interface UseOnlineStatusOptions {
  onReconnect?: () => void;
}

export function useOnlineStatus(options?: UseOnlineStatusOptions): boolean {
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const onReconnectRef = useRef(options?.onReconnect);
  onReconnectRef.current = options?.onReconnect;

  const handleOnline = useCallback(() => {
    setIsOnline(true);
    onReconnectRef.current?.();
  }, []);

  const handleOffline = useCallback(() => {
    setIsOnline(false);
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
