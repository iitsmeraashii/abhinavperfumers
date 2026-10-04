import { dbGet, dbPutStrict } from './db';

export interface PreviousRep { rep_code: string; name: string }

export function previousRepSnapshot(value: unknown): PreviousRep[] {
  if (!Array.isArray(value) || !value.every(r => r && typeof r === 'object' &&
    typeof r.rep_code === 'string' && r.rep_code.trim() !== '' && typeof r.name === 'string')) {
    throw new Error('Invalid previous-rep snapshot');
  }
  return value.map(({ rep_code, name }) => ({ rep_code, name }));
}

export async function loadPreviousRepCache(ownerId: string): Promise<PreviousRep[] | null> {
  const row = await dbGet<{ ownerId: string; schemaVersion: number; reps: unknown }>('previous_rep_cache', ownerId);
  if (!row || row.ownerId !== ownerId || row.schemaVersion !== 1) return null;
  try { return previousRepSnapshot(row.reps); } catch { return null; }
}

let writes: Promise<void> = Promise.resolve();
export function savePreviousRepCache(ownerId: string, reps: PreviousRep[], current: () => boolean): Promise<void> {
  const snapshot = previousRepSnapshot(reps);
  const next = writes.then(async () => {
    if (current()) await dbPutStrict('previous_rep_cache', { ownerId, schemaVersion: 1, fetchedAt: Date.now(), reps: snapshot });
  });
  writes = next.catch(() => {});
  return next;
}

export function filterPreviousReps(reps: PreviousRep[], search: string): PreviousRep[] {
  const query = search.toLowerCase();
  return reps.filter(r => r.name.toLowerCase().includes(query) || r.rep_code.toLowerCase().includes(query));
}

export function previousRepLabel(reps: PreviousRep[], code: string): string {
  const rep = reps.find(r => r.rep_code === code);
  return rep ? `${rep.name} (${rep.rep_code})` : code ? `${code} (stored selection — unavailable in active list)` : 'Select rep…';
}
