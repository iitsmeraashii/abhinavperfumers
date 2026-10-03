import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '../AuthContext';
import { isCloudSyncAllowed } from '../authModeState';
import { isTransportOnline } from '../connectivity/connectivityStore';
import { supabase } from '../supabaseClient';
import { loadPreviousRepCache, previousRepSnapshot, savePreviousRepCache, type PreviousRep } from './previousRepCacheStorage';

/** Capture-lifetime prefetch; reconnect is driven by authoritative authMode. */
export function usePreviousReps() {
  const { user, authMode } = useAuth();
  const owner = user?.authUserId ?? null;
  const [state, setState] = useState<{ owner: string | null; reps: PreviousRep[] }>({ owner: null, reps: [] });
  const [loading, setLoading] = useState(false);
  const live = useRef({ owner, authMode });
  live.current = { owner, authMode };
  const generation = useRef(0);
  const mounted = useRef(false);
  const pending = useRef<{ token: number; promise: Promise<void> } | null>(null);

  const refresh = useCallback((): Promise<void> => {
    const identity = live.current.owner;
    if (!mounted.current || !identity || live.current.authMode !== 'online' || !isCloudSyncAllowed() || !isTransportOnline()) return Promise.resolve();
    if (pending.current?.token === generation.current) return pending.current.promise;
    const token = ++generation.current;
    const current = () => mounted.current && token === generation.current && live.current.owner === identity &&
      live.current.authMode === 'online' && isCloudSyncAllowed() && isTransportOnline();
    setLoading(true);
    const attempt = { token, promise: Promise.resolve() };
    attempt.promise = (async () => {
      try {
        const { data, error } = await supabase.from('sales_representatives').select('rep_code, name')
          .eq('is_active', true).order('name');
        if (!current() || error) return;
        const reps = previousRepSnapshot(data);
        setState({ owner: identity, reps });
        await savePreviousRepCache(identity, reps, current);
      } catch { /* Keep the last valid list; every later open/activation can retry. */ }
      finally {
        if (pending.current === attempt) pending.current = null;
        if (current()) setLoading(false);
      }
    })();
    pending.current = attempt;
    return attempt.promise;
  }, []);

  useEffect(() => {
    mounted.current = true;
    const token = ++generation.current;
    setLoading(false);
    if (!owner || authMode === 'unauthenticated') setState({ owner: null, reps: [] });
    else void (async () => {
      try {
        const cached = await loadPreviousRepCache(owner);
        if (!mounted.current || token !== generation.current || live.current.owner !== owner) return;
        if (cached !== null) setState(previous => previous.owner === owner ? previous : { owner, reps: cached });
      } catch { /* A local read failure must not prevent an online refresh. */ }
      if (mounted.current && token === generation.current && live.current.owner === owner && authMode === 'online') await refresh();
    })();
    return () => { mounted.current = false; ++generation.current; };
  }, [owner, authMode, refresh]);

  return { reps: state.owner === owner && authMode !== 'unauthenticated' ? state.reps : [], refresh, loading };
}
