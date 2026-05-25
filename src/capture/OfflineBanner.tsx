import { WifiOff, Wifi, Loader2, CheckCircle2 } from 'lucide-react';
import { useState, useEffect } from 'react';

interface Props {
  visible: boolean;          // true = offline
  pendingCount?: number;     // queued ops not yet synced
  isFlushing?: boolean;      // queue flush in progress
}

export function OfflineBanner({ visible, pendingCount = 0, isFlushing = false }: Props) {
  const [showSynced, setShowSynced] = useState(false);

  // Show "all synced" confirmation briefly after flush completes
  useEffect(() => {
    if (!visible && !isFlushing && pendingCount === 0) {
      setShowSynced(true);
      const t = setTimeout(() => setShowSynced(false), 2500);
      return () => clearTimeout(t);
    }
  }, [visible, isFlushing, pendingCount]);

  if (visible) {
    return (
      <div className="sticky top-0 z-30 flex items-start gap-3 px-4 py-3 bg-amber-50 border-b border-amber-200">
        <div className="flex-shrink-0 mt-0.5 w-7 h-7 rounded-full bg-amber-100 flex items-center justify-center">
          <WifiOff className="w-3.5 h-3.5 text-amber-700" />
        </div>
        <div className="flex-1">
          <p className="text-sm font-semibold text-amber-900 leading-tight">Offline Mode</p>
          <p className="text-xs text-amber-700 mt-0.5 leading-snug">
            All captures are saved locally and will sync when you reconnect.
            {pendingCount > 0 && (
              <span className="font-semibold"> {pendingCount} item{pendingCount !== 1 ? 's' : ''} pending.</span>
            )}
          </p>
        </div>
      </div>
    );
  }

  if (isFlushing) {
    return (
      <div className="sticky top-0 z-30 flex items-center gap-3 px-4 py-2.5 bg-blue-50 border-b border-blue-200">
        <Loader2 className="w-4 h-4 text-blue-600 animate-spin flex-shrink-0" />
        <p className="text-sm font-medium text-blue-800">
          Syncing {pendingCount} item{pendingCount !== 1 ? 's' : ''}…
        </p>
      </div>
    );
  }

  if (showSynced) {
    return (
      <div className="sticky top-0 z-30 flex items-center gap-3 px-4 py-2.5 bg-green-50 border-b border-green-200">
        <CheckCircle2 className="w-4 h-4 text-green-600 flex-shrink-0" />
        <p className="text-sm font-medium text-green-800">All captures synced</p>
        <Wifi className="w-4 h-4 text-green-500 ml-auto flex-shrink-0" />
      </div>
    );
  }

  if (pendingCount > 0) {
    return (
      <div className="sticky top-0 z-30 flex items-center gap-3 px-4 py-2.5 bg-stone-50 border-b border-stone-200">
        <Loader2 className="w-4 h-4 text-stone-400 animate-spin flex-shrink-0" />
        <p className="text-sm text-stone-500">
          {pendingCount} item{pendingCount !== 1 ? 's' : ''} waiting to sync…
        </p>
      </div>
    );
  }

  return null;
}
