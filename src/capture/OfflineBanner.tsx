import { WifiOff } from 'lucide-react';

interface Props {
  visible: boolean;
}

export function OfflineBanner({ visible }: Props) {
  if (!visible) return null;
  return (
    <div className="sticky top-0 z-30 flex items-start gap-3 px-4 py-3 bg-amber-50 border-b border-amber-200">
      <div className="flex-shrink-0 mt-0.5 w-7 h-7 rounded-full bg-amber-100 flex items-center justify-center">
        <WifiOff className="w-3.5 h-3.5 text-amber-700" />
      </div>
      <div>
        <p className="text-sm font-semibold text-amber-900 leading-tight">Offline Mode Active</p>
        <p className="text-xs text-amber-700 mt-0.5 leading-snug">
          Your leads will be safely stored and synced later.
        </p>
      </div>
    </div>
  );
}
