import { useEffect, useRef } from 'react';
import type { CaptureSession } from './types';
import { saveDraft } from './captureDraftStorage';

const DEBOUNCE_MS = 700;

// Debounced autosave — fires ~700ms after the last session change.
// Skips IDLE sessions. Never blocks the UI.
export function useAutosave(session: CaptureSession): void {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Track updatedAt as the change signal — avoids deep equality on the whole object
  const updatedAtRef = useRef<Date | null>(null);

  useEffect(() => {
    if (session.sessionStatus === 'IDLE') return;

    // Only schedule a save when something actually changed
    if (session.updatedAt === updatedAtRef.current) return;
    updatedAtRef.current = session.updatedAt;

    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      saveDraft(session);
    }, DEBOUNCE_MS);

    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [session]);
}
