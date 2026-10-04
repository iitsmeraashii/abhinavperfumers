import { dbGet, dbPutStrict } from './db';
import type { AppEvent } from '../EventContext';

export function isActiveEvent(event: AppEvent): boolean {
  return event.is_active === true && event.status === 'ACTIVE';
}
function validEvent(value: unknown): value is AppEvent {
  if (!value || typeof value !== 'object') return false;
  const e = value as Record<string, unknown>;
  return ['id', 'event_code', 'name', 'status'].every(k => typeof e[k] === 'string' && e[k] !== '') &&
    ['description', 'location', 'start_date', 'end_date'].every(k => e[k] === null || typeof e[k] === 'string') &&
    typeof e.is_active === 'boolean' && typeof e.is_default === 'boolean';
}
export function activeEventSnapshot(value: unknown): AppEvent[] {
  if (!Array.isArray(value) || !value.every(validEvent)) throw new Error('Invalid event snapshot');
  return value.filter(isActiveEvent);
}
export async function loadEventCache(ownerId: string): Promise<AppEvent[] | null> {
  const row = await dbGet<{ ownerId: string; schemaVersion: number; events: unknown }>('event_cache', ownerId);
  if (!row || row.ownerId !== ownerId || row.schemaVersion !== 1) return null;
  try { return activeEventSnapshot(row.events); } catch { return null; }
}
// Serialize commits so an older write cannot finish after a newer authoritative [].
let writes: Promise<void> = Promise.resolve();
export function saveEventCache(ownerId: string, events: AppEvent[], current: () => boolean): Promise<void> {
  const snapshot = activeEventSnapshot(events);
  const next = writes.then(async () => {
    if (current()) await dbPutStrict('event_cache', { ownerId, schemaVersion: 1, fetchedAt: Date.now(), events: snapshot });
  });
  writes = next.catch(() => {});
  return next;
}
export function resolveCaptureEvent(events: AppEvent[], overrideId?: string | null, defaultId?: string | null, historicalId?: string | null) {
  const active = events.filter(isActiveEvent);
  const event = historicalId ? events.find(e => e.id === historicalId) :
    active.find(e => e.id === overrideId) ?? active.find(e => e.id === defaultId);
  return { id: historicalId ?? event?.id ?? null, eventCode: event?.event_code ?? null, eventName: event?.name ?? null };
}
