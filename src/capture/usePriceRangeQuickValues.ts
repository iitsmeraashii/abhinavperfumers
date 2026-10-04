import { useEffect, useSyncExternalStore } from 'react';
import { useAuth } from '../AuthContext';
import { activatePriceRange, getPriceRangeSnapshot, subscribePriceRange } from '../runtime/priceRangeConfiguration';

export function usePriceRangeQuickValues() {
  const { user, authMode } = useAuth();
  const owner = user?.authUserId;
  const snapshot = useSyncExternalStore(subscribePriceRange, getPriceRangeSnapshot, getPriceRangeSnapshot);
  useEffect(() => {
    if (!owner || authMode === 'unauthenticated') return;
    return activatePriceRange(owner, authMode);
  }, [owner, authMode]);
  return snapshot;
}
