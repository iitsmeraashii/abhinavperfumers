import { dbGet, dbPutStrict } from './db';

export const BUILTIN_PRICE_RANGE_VALUES: string[] = ['INR', 'USD', '<', '>', '=', '-'];
export function normalizePriceRangeQuickValues(values: string[]): string[] {
  const seen = new Set(BUILTIN_PRICE_RANGE_VALUES.map(v => v.toLowerCase()));
  return values.reduce<string[]>((out, value) => {
    const trimmed = value.trim();
    const key = trimmed.toLowerCase();
    if (trimmed && !seen.has(key)) { seen.add(key); out.push(trimmed); }
    return out;
  }, []);
}
export function validatePriceRangeValues(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every(v => typeof v === 'string')) throw new Error('Invalid price range configuration');
  return normalizePriceRangeQuickValues(value);
}
const KEY = 'price_range_quick_values';
export async function loadPriceRangeCache(): Promise<string[] | null> {
  const row = await dbGet<{ key: string; schemaVersion: number; values: unknown; fetchedAt: number }>('capture_config_cache', KEY);
  if (!row || row.key !== KEY || row.schemaVersion !== 1 || !Number.isFinite(row.fetchedAt)) return null;
  try { return validatePriceRangeValues(row.values); } catch { return null; }
}
let writes: Promise<void> = Promise.resolve();
export function savePriceRangeCache(values: string[], current: () => boolean): Promise<void> {
  const snapshot = validatePriceRangeValues(values);
  const next = writes.then(async () => {
    if (current()) await dbPutStrict('capture_config_cache', { key: KEY, schemaVersion: 1, values: snapshot, fetchedAt: Date.now() });
  });
  writes = next.catch(() => {});
  return next;
}
