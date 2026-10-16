export const EVENT_METRICS = ['total', 'contacted', 'samples', 'converted', 'lost', 'invalid', 'review', 'connected', 'engaged', 'sampled', 'hot', 'warm', 'cold', 'unassigned', 'other_temperature'] as const;
export type EventMetrics = Record<typeof EVENT_METRICS[number], number>;
export interface GeographyRow { value: string | null; count: number }
export interface EventRepRow { code: string | null; name: string | null; total: number; contacted: number; samples: number; converted: number; lost: number }
export interface EventOverviewData {
  eventId: string; eventCode: string; templateConfigured: boolean; metrics: EventMetrics;
  countries: GeographyRow[]; states: GeographyRow[]; reps: EventRepRow[];
  days: { day: string; count: number }[];
  countriesMore: boolean; statesMore: boolean; repsMore: boolean; daysMore: boolean;
}
const isCount = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
const isNullableText = (s: unknown) => s === null || typeof s === 'string';
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
export function parseEventOverview(value: unknown, eventId: string): EventOverviewData | null {
  if (!isRecord(value) || value.eventId !== eventId || typeof value.eventCode !== 'string' || !value.eventCode || typeof value.templateConfigured !== 'boolean') return null;
  const metrics = value.metrics;
  if (!isRecord(metrics) || !EVENT_METRICS.every(key => isCount(metrics[key]))) return null;
  const m = metrics as EventMetrics;
  if (EVENT_METRICS.some(key => m[key] > m.total) || m.engaged !== m.contacted + m.samples + m.converted + m.lost || m.sampled !== m.samples + m.converted + m.lost) return null;
  if (m.hot + m.warm + m.cold + m.unassigned + m.other_temperature !== m.total) return null;
  for (const key of ['countries', 'states'] as const) {
    const rows = value[key];
    if (!Array.isArray(rows) || rows.length > 100 || !rows.every(r => isRecord(r) && isNullableText(r.value) && isCount(r.count))) return null;
    if (new Set(rows.map(r => r.value)).size !== rows.length) return null;
    const sum = rows.reduce((total, row) => total + row.count, 0);
    if (sum > m.total || (value[`${key}More`] === false && sum !== m.total)) return null;
  }
  if (!Array.isArray(value.reps) || value.reps.length > 100 || !value.reps.every(r => isRecord(r) && isNullableText(r.code) && isNullableText(r.name) && ['total', 'contacted', 'samples', 'converted', 'lost'].every(key => isCount(r[key])))) return null;
  if (!Array.isArray(value.days) || value.days.length > 90 || !value.days.every(r => isRecord(r) && typeof r.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.day) && isCount(r.count))) return null;
  if (!['countriesMore', 'statesMore', 'repsMore', 'daysMore'].every(key => typeof value[key] === 'boolean')) return null;
  return value as unknown as EventOverviewData;
}

// Isolates request ownership; invalidation is safe for cleanup and StrictMode replay.
export class EventRequestGate {
  private generation = 0;
  begin() { return ++this.generation; }
  invalidate() { ++this.generation; }
  current(ticket: number) { return ticket === this.generation; }
}

export function geographyLabel(value: string | null): string {
  if (value === null || value === '') return 'Unassigned';
  if (!value.trim()) return 'Whitespace only';
  return value.trim() === value ? value : `${value.trim()} (surrounding spaces)`;
}
export function eventFunnel(data: EventOverviewData) {
  const m = data.metrics;
  return [
    { label: 'Total leads', count: m.total },
    ...(data.templateConfigured ? [{ label: 'Connected', count: m.connected }] : []),
    { label: 'Sales Rep Engaged', count: m.engaged },
    { label: 'Samples Sent', count: m.sampled },
  ];
}
