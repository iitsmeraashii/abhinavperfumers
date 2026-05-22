import { Camera, QrCode, ClipboardList, ArrowLeft, Wifi, WifiOff, Clock } from 'lucide-react';
import type { CaptureMethod, CaptureSession } from './types';

const METHOD_META: Record<CaptureMethod, {
  icon: React.ReactNode;
  label: string;
  message: string;
  iconBg: string;
  accent: string;
}> = {
  BUSINESS_CARD: {
    icon: <Camera className="w-7 h-7" />,
    label: 'Business Card Capture',
    message: 'Business Card Capture Coming Next',
    iconBg: 'bg-amber-50 text-amber-600',
    accent: 'border-amber-200 bg-amber-50',
  },
  QR: {
    icon: <QrCode className="w-7 h-7" />,
    label: 'QR Capture',
    message: 'QR Capture Coming Next',
    iconBg: 'bg-teal-50 text-teal-600',
    accent: 'border-teal-200 bg-teal-50',
  },
  MANUAL: {
    icon: <ClipboardList className="w-7 h-7" />,
    label: 'Manual Entry',
    message: 'Manual Entry Coming Next',
    iconBg: 'bg-blue-50 text-blue-600',
    accent: 'border-blue-200 bg-blue-50',
  },
};

const STATUS_LABELS: Record<string, string> = {
  IDLE: 'Idle',
  CAPTURING: 'Capturing',
  DRAFT: 'Draft',
  READY_FOR_REVIEW: 'Ready for Review',
};

interface Props {
  session: CaptureSession;
  isOnline: boolean;
  onBack: () => void;
}

export function CapturePlaceholder({ session, isOnline, onBack }: Props) {
  if (!session.captureMethod) return null;
  const meta = METHOD_META[session.captureMethod];

  return (
    <div className="mt-6 animate-in fade-in slide-in-from-bottom-3 duration-300">
      {/* Back button */}
      <button
        onClick={onBack}
        className="flex items-center gap-1.5 text-sm font-medium text-stone-500 hover:text-stone-800 transition-colors mb-5"
      >
        <ArrowLeft className="w-4 h-4" />
        Back to options
      </button>

      {/* Placeholder card */}
      <div className={`rounded-2xl border-2 border-dashed ${meta.accent} p-8 flex flex-col items-center text-center gap-4`}>
        <div className={`w-16 h-16 rounded-2xl flex items-center justify-center ${meta.iconBg}`}>
          {meta.icon}
        </div>
        <div>
          <h3 className="text-lg font-semibold text-stone-800">{meta.message}</h3>
          <p className="mt-1.5 text-sm text-stone-500 leading-relaxed max-w-xs mx-auto">
            This capture mode is being built. Check back soon.
          </p>
        </div>
      </div>

      {/* Session debug panel */}
      <div className="mt-5 rounded-xl border border-stone-200 bg-white divide-y divide-stone-100 overflow-hidden">
        <div className="px-4 py-3">
          <p className="text-[11px] font-semibold text-stone-400 uppercase tracking-wider mb-2">Session Info</p>
          <div className="flex flex-col gap-2">

            <div className="flex items-center justify-between">
              <span className="text-xs text-stone-500">Capture Method</span>
              <span className="text-xs font-mono font-medium text-stone-700 bg-stone-100 px-2 py-0.5 rounded">
                {session.captureMethod}
              </span>
            </div>

            <div className="flex items-center justify-between">
              <span className="text-xs text-stone-500">Session Status</span>
              <span className="text-xs font-mono font-medium text-stone-700 bg-stone-100 px-2 py-0.5 rounded">
                {STATUS_LABELS[session.sessionStatus] ?? session.sessionStatus}
              </span>
            </div>

            <div className="flex items-center justify-between">
              <span className="text-xs text-stone-500">Started</span>
              <span className="flex items-center gap-1 text-xs text-stone-500">
                <Clock className="w-3 h-3" />
                {session.createdAt
                  ? session.createdAt.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
                  : '—'}
              </span>
            </div>

            <div className="flex items-center justify-between">
              <span className="text-xs text-stone-500">Connectivity</span>
              <span className={`flex items-center gap-1 text-xs font-medium ${isOnline ? 'text-green-600' : 'text-amber-600'}`}>
                {isOnline
                  ? <><Wifi className="w-3 h-3" /> Online</>
                  : <><WifiOff className="w-3 h-3" /> Offline</>
                }
              </span>
            </div>

          </div>
        </div>
      </div>
    </div>
  );
}
