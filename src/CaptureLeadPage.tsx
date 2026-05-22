import { useOnlineStatus } from './capture/useOnlineStatus';
import { useCaptureSession } from './capture/useCaptureSession';
import { OfflineBanner } from './capture/OfflineBanner';
import { CaptureMethodPicker } from './capture/CaptureMethodPicker';
import { CapturePlaceholder } from './capture/CapturePlaceholder';
import type { CaptureMethod } from './capture/types';

export default function CaptureLeadPage() {
  const isOnline = useOnlineStatus();
  const [session, actions] = useCaptureSession();

  function handleMethodSelect(method: CaptureMethod) {
    actions.startCapture(method);
  }

  function handleBackToOptions() {
    actions.resetSession();
  }

  const isCapturing = session.sessionStatus !== 'IDLE';

  return (
    <div className="min-h-[calc(100vh-57px)] bg-stone-50 flex flex-col">
      <OfflineBanner visible={!isOnline} />

      <div className="flex-1 w-full max-w-lg mx-auto px-5 pt-10 pb-10 flex flex-col">
        {/* Header — hide when a capture mode is active on mobile */}
        <div className={`mb-10 transition-all duration-200 ${isCapturing ? 'opacity-60' : ''}`}>
          <h1 className="text-2xl font-bold text-stone-900 tracking-tight">Capture New Lead</h1>
          <p className="mt-1.5 text-base text-stone-500 leading-relaxed">
            {isCapturing
              ? 'Session active — choose an action below'
              : 'Choose how you want to capture lead details'}
          </p>
        </div>

        {/* Method picker — always visible so user can switch */}
        <CaptureMethodPicker onSelect={handleMethodSelect} />

        {/* Placeholder screen slides in below picker after selection */}
        {isCapturing && (
          <CapturePlaceholder
            session={session}
            isOnline={isOnline}
            onBack={handleBackToOptions}
          />
        )}

        {!isCapturing && (
          <p className="mt-8 text-center text-xs text-stone-400 md:hidden">
            Features coming soon — tap to preview
          </p>
        )}
      </div>
    </div>
  );
}
