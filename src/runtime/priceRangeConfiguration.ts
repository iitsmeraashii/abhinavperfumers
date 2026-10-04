import { supabase } from '../supabaseClient';
import { isCloudSyncAllowed, type AuthMode } from '../authModeState';
import { isTransportOnline } from '../connectivity/connectivityStore';
import { BUILTIN_PRICE_RANGE_VALUES, loadPriceRangeCache, savePriceRangeCache, validatePriceRangeValues } from '../capture/priceRangeCacheStorage';

const listeners = new Set<() => void>();
let snapshot = { values: [] as string[], quickValues: [...BUILTIN_PRICE_RANGE_VALUES], loading: false, error: null as string | null };
let generation = 0;
let revision = 0;
let lifecycle: { owner: string; mode: AuthMode; leases: Set<symbol> } | null = null;
let pending: { generation: number; revision: number; promise: Promise<void> } | null = null;
let saving: { generation: number; revision: number } | null = null;
function publish(patch: Partial<typeof snapshot>) {
  snapshot = { ...snapshot, ...patch };
  if (patch.values) snapshot.quickValues = [...BUILTIN_PRICE_RANGE_VALUES, ...patch.values];
  listeners.forEach(listener => listener());
}
export const getPriceRangeSnapshot = () => snapshot;
export function subscribePriceRange(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
function authorized() { return lifecycle?.mode === 'online' && isCloudSyncAllowed() && isTransportOnline(); }
function current(g: number, r: number) { return !!lifecycle && generation === g && revision === r && authorized(); }

/** Restore/refresh through authenticated consumers, never from React rendering. */
export function activatePriceRange(owner: string, mode: AuthMode): () => void {
  const lease = Symbol();
  if (!lifecycle || lifecycle.owner !== owner || lifecycle.mode !== mode) {
    lifecycle = { owner, mode, leases: new Set() };
    const g = ++generation;
    const r = revision;
    publish({ loading: true, error: null });
    void (async () => {
      try {
        const cached = await loadPriceRangeCache();
        if (g !== generation || r !== revision || !lifecycle) return;
        if (cached !== null) publish({ values: cached });
      } catch { /* Local storage failure must not prevent an authorized refresh. */ }
      if (g !== generation || r !== revision || !lifecycle) return;
      publish({ loading: false });
      if (authorized()) await refreshPriceRange();
    })();
  }
  lifecycle.leases.add(lease);
  return () => {
    if (!lifecycle?.leases.delete(lease)) return;
    if (!lifecycle.leases.size) {
      lifecycle = null;
      ++generation;
      publish({ loading: false });
    }
  };
}

export function refreshPriceRange(): Promise<void> {
  if (!authorized() || saving?.generation === generation) return Promise.resolve();
  if (pending?.generation === generation && pending.revision === revision) return pending.promise;
  const g = generation, r = ++revision;
  publish({ loading: true, error: null });
  const attempt = { generation: g, revision: r, promise: Promise.resolve() };
  attempt.promise = (async () => {
    try {
      const { data, error } = await supabase.rpc('get_price_range_quick_values');
      if (!current(g, r)) return;
      if (error) throw error;
      const values = validatePriceRangeValues(data);
      await savePriceRangeCache(values, () => current(g, r));
      if (current(g, r)) publish({ values });
    } catch {
      if (current(g, r)) publish({ error: 'Price range refresh failed; keeping the last confirmed values.' });
    } finally {
      if (pending === attempt) pending = null;
      if (g === generation && r === revision) publish({ loading: false });
    }
  })();
  pending = attempt;
  return attempt.promise;
}

/** Only a successful server save can replace the confirmed snapshot. */
export async function saveConfirmedPriceRange(values: string[]): Promise<void> {
  if (!authorized()) throw new Error('An authenticated online session is required to save quick values.');
  if (saving?.generation === generation) throw new Error('A price range save is already running.');
  const normalized = validatePriceRangeValues(values);
  const g = generation, r = ++revision;
  const attempt = { generation: g, revision: r };
  saving = attempt;
  try {
    const { data, error } = await supabase.rpc('set_price_range_quick_values', { p_values: normalized });
    if (!current(g, r)) throw new Error('Session changed while saving; refresh to confirm the server values.');
    if (error || data?.success !== true) throw new Error('Server save failed. Your edits remain in this form.');
    const confirmed = validatePriceRangeValues(data.values);
    try { await savePriceRangeCache(confirmed, () => current(g, r)); }
    catch { throw new Error('Saved on server, but offline cache could not be updated. Refresh to retry.'); }
    if (!current(g, r)) throw new Error('Session changed while saving; refresh to confirm the server values.');
    publish({ values: confirmed, error: null });
  } finally {
    if (saving === attempt) saving = null;
    if (g === generation && r === revision) publish({ loading: false });
  }
}
