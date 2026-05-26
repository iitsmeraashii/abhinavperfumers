import { useEffect, useRef, useCallback } from 'react';
import type { CaptureSession } from './types';
import { saveDraft } from './captureDraftStorage';

export type SaveState = 'idle' | 'saving' | 'saved' | 'offline_saved' | 'unsaved';

const DEBOUNCE_MS = 600;

interface UseAutosaveOptions {
  isOnline: boolean;
  onSaveStateChange?: (state: SaveState) => void;
}

export function useAutosave(
  session: CaptureSession,
  { isOnline, onSaveStateChange }: UseAutosaveOptions,
): void {
  const timer       = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Stable key of last successfully persisted draft — avoids redundant writes.
  const savedKeyRef = useRef<string>('');
  const sessionRef  = useRef(session);
  sessionRef.current = session;
  const isOnlineRef = useRef(isOnline);
  isOnlineRef.current = isOnline;

  const notify = useCallback((s: SaveState) => {
    onSaveStateChange?.(s);
  }, [onSaveStateChange]);

  // Core persist — never throws, never blocks.
  const doSave = useCallback(async () => {
    const s = sessionRef.current;
    if (s.sessionStatus === 'IDLE') return;

    notify('saving');
    try {
      await saveDraft(s);
      savedKeyRef.current = draftKey(s);
      notify(isOnlineRef.current ? 'saved' : 'offline_saved');
    } catch {
      notify('unsaved');
    }
  }, [notify]);

  // Debounced save — scheduled after every meaningful draftData change.
  const scheduleDebounced = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    notify('unsaved');
    timer.current = setTimeout(doSave, DEBOUNCE_MS);
  }, [doSave, notify]);

  // Flush immediately — used by visibility/unload handlers.
  const flushNow = useCallback(() => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    doSave();
  }, [doSave]);

  // React to draftData + status + method changes.
  // JSON key comparison means sync-only state updates (pendingOps, syncStatus)
  // never trigger redundant IndexedDB writes.
  useEffect(() => {
    if (session.sessionStatus === 'IDLE') {
      notify('idle');
      return;
    }

    const key = draftKey(session);
    if (key === savedKeyRef.current) return;

    scheduleDebounced();

    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  // draftData object identity changes on every patchDraft call — that's the signal.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.draftData, session.sessionStatus, session.captureMethod]);

  // Flush on page hide (app background / tab close / Capacitor suspend).
  // This is the last-resort save before the process is suspended or killed.
  useEffect(() => {
    function onHide() {
      if (document.visibilityState === 'hidden') flushNow();
    }
    function onUnload() { flushNow(); }

    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('beforeunload', onUnload);
    // pagehide fires reliably on iOS Safari / Capacitor where beforeunload does not
    window.addEventListener('pagehide', onUnload);
    return () => {
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('beforeunload', onUnload);
      window.removeEventListener('pagehide', onUnload);
    };
  }, [flushNow]);
}

// Compact key over the parts of session that matter for persistence.
// Deliberately excludes sync state so sync-only updates are invisible to autosave.
function draftKey(s: CaptureSession): string {
  return JSON.stringify({ m: s.captureMethod, st: s.sessionStatus, d: s.draftData });
}
