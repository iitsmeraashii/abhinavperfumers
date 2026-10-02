// React hook that manages the ALPE scheduler lifecycle within the app.
//
// When ALPE processing is enabled and a user is authenticated, the scheduler
// starts (recovery first, then polling). On logout or unmount, it shuts down
// gracefully.
//
// Usage:
//   const { status } = useAlpeScheduler(user?.authUserId);
//
// The hook is a no-op when USE_ALPE_PROCESSING is disabled or no user is signed in.

import { useEffect, useState, useRef } from 'react';
import { useAlpeProcessing } from './featureFlag';
import { startScheduler, stopScheduler, getSchedulerState } from './scheduler';
import type { SchedulerState } from './scheduler';
import type { AuthMode } from '../authModeState';

export function useAlpeScheduler(
  userId: string | null | undefined,
  authMode: AuthMode,
): SchedulerState {
  const alpeEnabled = useAlpeProcessing();
  const [state, setState] = useState<SchedulerState>(getSchedulerState());
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    // Only start the scheduler when ALPE is enabled, a user is signed in,
    // AND AuthContext has completed authoritative profile validation.
    // This prevents recovery/polling during offline-restored mode.
    if (!alpeEnabled || !userId || authMode !== 'online') return;

    let cancelled = false;

    async function boot() {
      await startScheduler(userId as string);
      if (!cancelled) {
        setState(getSchedulerState());
      }
    }

    boot();

    intervalRef.current = setInterval(() => {
      if (!cancelled) {
        setState(getSchedulerState());
      }
    }, 3000);

    return () => {
      cancelled = true;
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      stopScheduler();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [alpeEnabled, userId, authMode]);

  return state;
}
