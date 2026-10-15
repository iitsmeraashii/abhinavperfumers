export const DASHBOARD_RANGES = [
  { value: 'today', label: 'Today', days: 1 },
  { value: '7days', label: 'Last 7 days', days: 7 },
  { value: '30days', label: 'Last 30 days', days: 30 },
  { value: '90days', label: 'Last 90 days', days: 90 },
] as const;
export type DashboardRange = typeof DASHBOARD_RANGES[number]['value'];
export interface DashboardDateBounds {
  from: string;
  before: string;
  dateFrom: string;
  dateTo: string;
}
function localDateString(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
export function localDateBoundary(value: string, nextDay = false): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  if (localDateString(date) !== value) return null;
  if (nextDay) date.setDate(date.getDate() + 1);
  return date.toISOString();
}
export function getDashboardDateBounds(range: DashboardRange, now = new Date()): DashboardDateBounds {
  const days = DASHBOARD_RANGES.find(option => option.value === range)!.days;
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dateTo = localDateString(start);
  start.setDate(start.getDate() - days + 1);
  const dateFrom = localDateString(start);
  return { from: start.toISOString(), before: localDateBoundary(dateTo, true)!, dateFrom, dateTo };
}
