import { WifiOff, Loader2, FileText } from 'lucide-react';

export function OfflineBanner({ visible, summary }: { visible: boolean; summary: string | null }) {
  if (!visible && !summary) return null;
  return (
    <div className={`sticky top-0 z-30 flex items-start gap-3 px-4 py-3 border-b ${visible ? 'bg-amber-50 border-amber-200 text-amber-800' : 'bg-blue-50 border-blue-200 text-blue-800'}`}>
      {visible ? <WifiOff className="w-4 h-4 shrink-0 mt-0.5" /> : summary === 'Syncing saved leads…' ? <Loader2 className="w-4 h-4 shrink-0 mt-0.5 animate-spin" /> : <FileText className="w-4 h-4 shrink-0 mt-0.5" />}
      <div>
        <p className="text-sm font-semibold">{visible ? 'Offline Mode' : summary}</p>
        {visible && <p className="text-xs mt-0.5">Your captures are saved safely and will sync automatically when connected.</p>}
      </div>
    </div>
  );
}
