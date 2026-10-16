import { CloudOff, ShieldCheck } from 'lucide-react';

export default function OnlinePageUnavailable({ online, onCapture, onQueue }: {
  online: boolean;
  onCapture: () => void;
  onQueue: () => void;
}) {
  const Icon = online ? ShieldCheck : CloudOff;
  return (
    <section role="status" className="mx-auto max-w-xl px-5 py-12 sm:py-20">
      <div className="rounded-2xl border border-amber-200 bg-amber-50/60 p-6 sm:p-8">
        <Icon aria-hidden="true" className="mb-4 h-8 w-8 text-amber-700" />
        <h1 className="text-xl font-semibold text-stone-900">
          {online ? 'Waiting for secure connection' : 'This page needs an internet connection'}
        </h1>
        <p className="mt-3 text-sm leading-6 text-stone-600">
          {online
            ? 'Internet is available, but your session has not been verified for online access yet.'
            : 'You’re offline. This page uses live data and is temporarily unavailable.'}
          {' '}You can still capture leads and view your local queue. This page will reopen automatically when online access is ready.
        </p>
        <div className="mt-6 flex flex-wrap gap-3">
          <button type="button" onClick={onCapture} className="rounded-lg bg-stone-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-stone-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-700">Capture Lead</button>
          <button type="button" onClick={onQueue} className="rounded-lg border border-stone-300 bg-white px-4 py-2.5 text-sm font-medium text-stone-700 hover:bg-stone-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-700">View Queue</button>
        </div>
      </div>
    </section>
  );
}
