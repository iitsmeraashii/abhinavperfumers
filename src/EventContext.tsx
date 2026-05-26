import {
  createContext,
  useContext,
  useState,
  useCallback,
  useRef,
  type ReactNode,
} from 'react';
import { supabase } from './supabaseClient';

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

// ─── ensureValidDefaultEvent ──────────────────────────────────────────────────
// Validates the rep's stored default_event_id is still active.
// Falls back to is_default=true, then any active event.
// Persists fix to DB if the stored value was stale.

async function ensureValidDefaultEvent(repId: string): Promise<AppEvent | null> {
  // 1. Read rep's current default_event_id
  const { data: repRow } = await supabase
    .from('sales_representatives')
    .select('default_event_id')
    .eq('id', repId)
    .maybeSingle();

  const currentEventId: string | null = repRow?.default_event_id ?? null;

  // 2. Validate currently stored event is still active
  if (currentEventId) {
    const { data: ev } = await supabase
      .from('events')
      .select('id, event_code, name, description, location, start_date, end_date, status, is_active, is_default')
      .eq('id', currentEventId)
      .maybeSingle();

    if (ev && ev.is_active) {
      return ev as AppEvent;
    }
    // Event found but inactive — fall through to pick a valid one
  }

  // 3. Try the system default event
  const { data: defaultEv } = await supabase
    .from('events')
    .select('id, event_code, name, description, location, start_date, end_date, status, is_active, is_default')
    .eq('is_default', true)
    .eq('is_active', true)
    .maybeSingle();

  const fallback = defaultEv ?? await (async () => {
    // 4. Last resort: any active event
    const { data: anyActive } = await supabase
      .from('events')
      .select('id, event_code, name, description, location, start_date, end_date, status, is_active, is_default')
      .eq('is_active', true)
      .order('start_date', { ascending: false })
      .limit(1)
      .maybeSingle();
    return anyActive;
  })();

  if (!fallback) return null;

  // 5. Persist the resolved event to the rep's row if it changed
  if (currentEventId !== fallback.id) {
    await supabase
      .from('sales_representatives')
      .update({ default_event_id: fallback.id })
      .eq('id', repId);
  }

  return fallback as AppEvent;
}

// ─── Provider ─────────────────────────────────────────────────────────────────

export function EventProvider({ children }: { children: ReactNode }) {
  const [selectedEvent, setSelectedEventState] = useState<AppEvent | null>(null);
  const [activeEvents, setActiveEvents]        = useState<AppEvent[]>([]);
  const [loadingEvent, setLoadingEvent]        = useState(false);

  // Guard against concurrent refresh calls
  const refreshingRef = useRef(false);

  const loadActiveEvents = useCallback(async () => {
    const { data } = await supabase
      .from('events')
      .select('id, event_code, name, description, location, start_date, end_date, status, is_active, is_default')
      .eq('is_active', true)
      .order('start_date', { ascending: false });

    if (data) setActiveEvents(data as AppEvent[]);
  }, []);

  // Resolve and cache the rep's valid default event.
  // repId = sales_representatives.id (UUID PK, not auth.uid()).
  // If omitted, fetched from my_rep_profile view.
  const refreshSelectedEvent = useCallback(async (repId?: string) => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    setLoadingEvent(true);

    try {
      let resolvedRepId = repId;
      if (!resolvedRepId) {
        const { data: profile } = await supabase
          .from('my_rep_profile')
          .select('id')
          .maybeSingle();
        resolvedRepId = profile?.id ?? undefined;
      }
      if (!resolvedRepId) return;

      const [event] = await Promise.all([
        ensureValidDefaultEvent(resolvedRepId),
        loadActiveEvents(),
      ]);

      setSelectedEventState(event);
    } catch (err) {
      console.warn('[EventContext] refreshSelectedEvent error:', err);
    } finally {
      refreshingRef.current = false;
      setLoadingEvent(false);
    }
  }, [loadActiveEvents]);

  // Optimistically update and persist the rep's chosen event.
  // Never allows inactive events through.
  const setSelectedEvent = useCallback(async (event: AppEvent) => {
    if (!event.is_active) return;

    setSelectedEventState(event); // optimistic

    const { data: profile } = await supabase
      .from('my_rep_profile')
      .select('id')
      .maybeSingle();

    if (!profile?.id) return;

    const { error } = await supabase
      .from('sales_representatives')
      .update({ default_event_id: event.id })
      .eq('id', profile.id);

    if (error) {
      console.warn('[EventContext] setSelectedEvent DB update failed:', error.message);
      // Revert optimistic update
      refreshSelectedEvent(profile.id);
    }
  }, [refreshSelectedEvent]);

  const clearEvent = useCallback(() => {
    setSelectedEventState(null);
    setActiveEvents([]);
  }, []);

  return (
    <EventContext.Provider value={{
      selectedEvent,
      activeEvents,
      loadingEvent,
      setSelectedEvent,
      refreshSelectedEvent,
      loadActiveEvents,
      clearEvent,
    }}>
      {children}
    </EventContext.Provider>
  );
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useEvent(): EventContextState {
  const ctx = useContext(EventContext);
  if (!ctx) throw new Error('useEvent must be used within EventProvider');
  return ctx;
}
