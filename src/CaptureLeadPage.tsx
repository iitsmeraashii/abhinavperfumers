import { useOnlineStatus } from './capture/useOnlineStatus';
import { useCaptureSession } from './capture/useCaptureSession';
import { useManualEntryForm } from './capture/useManualEntryForm';
import { OfflineBanner } from './capture/OfflineBanner';
import { CaptureMethodPicker } from './capture/CaptureMethodPicker';
import { CapturePlaceholder } from './capture/CapturePlaceholder';
import { ManualEntryForm } from './capture/ManualEntryForm';
import type { CaptureMethod } from './capture/types';

export default function CaptureLeadPage() {
  const isOnline = useOnlineStatus();
  const [session, actions] = useCaptureSession();
  const form = useManualEntryForm(actions);

  function handleMethodSelect(method: CaptureMethod) {
    // Reset form state when switching capture methods
    form.handleReset();
    actions.startCapture(method);
  }

  function handleBackToOptions() {
    form.handleReset();
    actions.resetSession();
  }

  const isCapturing = session.sessionStatus !== 'IDLE';

  return (
    <div className="min-h-[calc(100vh-57px)] bg-stone-50 flex flex-col">
      <OfflineBanner visible={!isOnline} />

      <div className="flex-1 w-full max-w-lg mx-auto px-5 pt-10 pb-10 flex flex-col">

        {/* Header */}
        <div className={`mb-10 transition-opacity duration-200 ${isCapturing ? 'opacity-50' : ''}`}>
          <h1 className="text-2xl font-bold text-stone-900 tracking-tight">Capture New Lead</h1>
          <p className="mt-1.5 text-base text-stone-500 leading-relaxed">
            {isCapturing
              ? 'Session active — fill in details below'
              : 'Choose how you want to capture lead details'}
          </p>
        </div>

        {/* Method picker — always visible so user can switch modes */}
        <CaptureMethodPicker
          onSelect={handleMethodSelect}
          activeMethod={session.captureMethod}
        />

        {/* Active capture view — slides in below picker */}
        {isCapturing && session.captureMethod === 'MANUAL' && (
          <ManualEntryForm
            session={session}
            isOnline={isOnline}
            form={form}
            onBack={handleBackToOptions}
          />
        )}

        {isCapturing && session.captureMethod !== 'MANUAL' && (
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
