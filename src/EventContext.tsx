import {
  createContext,
  useContext,
  useState,
  useCallback,
  useRef,
  useEffect,
  type ReactNode,
} from 'react';
import { supabase } from './supabaseClient';
import { useAuth } from './AuthContext';
import { isCloudSyncAllowed } from './authModeState';
import { isTransportOnline } from './connectivity/connectivityStore';
import { activeEventSnapshot, isActiveEvent, loadEventCache, saveEventCache } from './capture/eventCacheStorage';
import { updateCachedDefaultEvent } from './capture/authProfileStorage';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AppEvent {
  id:          string;
  event_code:  string;
  name:        string;
  description: string | null;
  location:    string | null;
  start_date:  string | null;
  end_date:    string | null;
  status:      string;
  is_active:   boolean;
  is_default:  boolean;
}

export interface EventContextState {
  selectedEvent:        AppEvent | null;
  activeEvents:         AppEvent[];
  loadingEvent:         boolean;
  setSelectedEvent:     (event: AppEvent) => Promise<void>;
  refreshSelectedEvent: (repId?: string) => Promise<void>;
  loadActiveEvents:     () => Promise<void>;
  clearEvent:           () => void;
}

// ─── Context ──────────────────────────────────────────────────────────────────

const EventContext = createContext<EventContextState | null>(null);

const EVENT_FIELDS = 'id, event_code, name, description, location, start_date, end_date, status, is_active, is_default';

export function EventProvider({ children }: { children: ReactNode }) {
  const { user, salesRep, authMode, updateSalesRep } = useAuth();
  const owner = user?.authUserId ?? null;
  const [state, setState] = useState<{ owner: string | null; events: AppEvent[] }>({ owner: null, events: [] });
  const [loadingEvent, setLoadingEvent] = useState(false);
  const epoch = useRef(0);
  const live = useRef({ owner, authMode, salesRep, updateSalesRep });
  live.current = { owner, authMode, salesRep, updateSalesRep };
  const pending = useRef<{ owner: string; epoch: number; promise: Promise<void> } | null>(null);
  const activeEvents = state.owner === owner && authMode !== 'unauthenticated' ? state.events : [];
  const selectedEvent = activeEvents.find(e => e.id === salesRep?.default_event_id) ?? null;

  const refreshSelectedEvent = useCallback((_repId?: string): Promise<void> => {
    const identity = live.current.owner;
    if (!identity || !isCloudSyncAllowed() || !isTransportOnline()) return Promise.resolve();
    if (pending.current?.owner === identity && pending.current.epoch === epoch.current) return pending.current.promise;
    const token = ++epoch.current;
    const current = () => token === epoch.current && live.current.owner === identity &&
      live.current.authMode === 'online' && isCloudSyncAllowed() && isTransportOnline();
    setLoadingEvent(true);
    const attempt = { owner: identity, epoch: token, promise: Promise.resolve() };
    attempt.promise = (async () => {
      try {
        const { data, error } = await supabase.from('events').select(EVENT_FIELDS)
          .eq('is_active', true).eq('status', 'ACTIVE').order('start_date', { ascending: false });
        if (!current() || error) return;
        const events = activeEventSnapshot(data);
        setState({ owner: identity, events });
        await saveEventCache(identity, events, current);
        // Only a fully successful read may repair the server's default.
        if (!current()) return;
        const repId = live.current.salesRep?.id;
        if (!repId) return;
        const result = await supabase.from('sales_representatives').select('default_event_id').eq('id', repId).maybeSingle();
        if (!current() || result.error || !result.data) return;
        const defaultId = result.data.default_event_id;
        const existing = events.find(e => e.id === defaultId);
        const resolved = existing ?? events.find(e => e.is_default) ?? events[0];
        if (!resolved) return;
        if (!existing) {
          const updated = await supabase.from('sales_representatives').update({ default_event_id: resolved.id }).eq('id', repId);
          if (!current() || updated.error) return;
        }
        live.current.updateSalesRep({ default_event_id: resolved.id });
        await updateCachedDefaultEvent(identity, resolved.id, current);
      } catch {
        // Failed reads/commits preserve the last valid state; a later refresh retries.
      } finally {
        if (pending.current === attempt) pending.current = null;
        if (token === epoch.current) setLoadingEvent(false);
      }
    })();
    pending.current = attempt;
    return attempt.promise;
  }, []);

  useEffect(() => {
    const token = ++epoch.current;
    setLoadingEvent(false);
    if (!owner || authMode === 'unauthenticated') {
      setState({ owner: null, events: [] });
      return;
    }
    // Restore first, then refresh: no late local read can overwrite server data.
    void (async () => {
      try {
        const cached = await loadEventCache(owner);
        if (token !== epoch.current || live.current.owner !== owner) return;
        if (cached !== null) setState(previous => previous.owner === owner ? previous : { owner, events: cached });
      } catch { /* Storage unavailable must not prevent an online fetch. */ }
      if (token === epoch.current && live.current.owner === owner && authMode === 'online') await refreshSelectedEvent();
    })();
    return () => { ++epoch.current; };
  }, [owner, authMode, refreshSelectedEvent]);

  const setSelectedEvent = useCallback(async (event: AppEvent) => {
    const identity = live.current.owner;
    const repId = live.current.salesRep?.id;
    if (!identity || !repId || !isActiveEvent(event) || !isCloudSyncAllowed() || !isTransportOnline()) {
      throw new Error('Changing the account default requires an active event and an online session');
    }
    const token = ++epoch.current;
    setLoadingEvent(false);
    const current = () => token === epoch.current && live.current.owner === identity && isCloudSyncAllowed() && isTransportOnline();
    const { error } = await supabase.from('sales_representatives').update({ default_event_id: event.id }).eq('id', repId);
    if (!current() || error) throw new Error('Default event could not be confirmed');
    live.current.updateSalesRep({ default_event_id: event.id });
    await updateCachedDefaultEvent(identity, event.id, current);
  }, []);

  const clearEvent = useCallback(() => {
    ++epoch.current;
    setState({ owner: null, events: [] });
    setLoadingEvent(false);
  }, []);

  return <EventContext.Provider value={{ selectedEvent, activeEvents, loadingEvent,
    setSelectedEvent, refreshSelectedEvent, loadActiveEvents: refreshSelectedEvent, clearEvent }}>
    {children}
  </EventContext.Provider>;
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useEvent(): EventContextState {
  const ctx = useContext(EventContext);
  if (!ctx) throw new Error('useEvent must be used within EventProvider');
  return ctx;
}
