// Dashboard metrics loading controller — extracted from DashboardPage for
// testability. Encapsulates the async fetch lifecycle: generation guards,
// identity invalidation, try/catch, strict validation, and authorization
// re-checks. DashboardPage uses this via a ref-held instance.
//
// This is the "small production-used loading controller" exercised by tests.

import { supabase } from './supabaseClient';
import { isCloudSyncAllowed } from './authModeState';
import { isTransportOnline } from './connectivity/connectivityStore';

export interface DashboardData {
  total_leads: number;
  leads_today: number;
  leads_last_7_days: number;
  leads_last_30_days: number;
  whatsapp_sent: number;
  whatsapp_failed: number;
  invalid_leads: number;
  new_leads: number;
  contacted_leads: number;
  qualified_leads: number;
  converted_leads: number;
  lost_leads: number;
  hot_leads: number;
  warm_leads: number;
  cold_leads: number;
  unassigned_temperature_leads: number;
}

export const EMPTY_DASHBOARD: DashboardData = {
  total_leads: 0, leads_today: 0, leads_last_7_days: 0, leads_last_30_days: 0,
  whatsapp_sent: 0, whatsapp_failed: 0, invalid_leads: 0,
  new_leads: 0, contacted_leads: 0, qualified_leads: 0, converted_leads: 0, lost_leads: 0,
  hot_leads: 0, warm_leads: 0, cold_leads: 0, unassigned_temperature_leads: 0,
};

const METRIC_FIELDS = [
  'total_leads', 'leads_today', 'leads_last_7_days', 'leads_last_30_days',
  'whatsapp_sent', 'whatsapp_failed', 'invalid_leads',
  'new_leads', 'contacted_leads', 'qualified_leads', 'converted_leads', 'lost_leads',
  'hot_leads', 'warm_leads', 'cold_leads', 'unassigned_temperature_leads',
] as const;

export function isValidCount(value: unknown): value is number {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return false;
    const n = Number(trimmed);
    if (typeof n !== 'number' || !Number.isFinite(n)) return false;
    if (n < 0 || !Number.isInteger(n) || n > Number.MAX_SAFE_INTEGER) return false;
    return true;
  }
  const n = value;
  if (typeof n !== 'number') return false;
  if (!Number.isFinite(n)) return false;
  if (n < 0) return false;
  if (!Number.isInteger(n)) return false;
  if (n > Number.MAX_SAFE_INTEGER) return false;
  return true;
}

export function parseMetricsResponse(rpcData: unknown): DashboardData | null {
  if (!rpcData) return null;
  const row = Array.isArray(rpcData) ? rpcData[0] : rpcData;
  if (!row || typeof row !== 'object') return null;
  const obj = row as Record<string, unknown>;

  for (const field of METRIC_FIELDS) {
    if (!isValidCount(obj[field])) return null;
  }

  return {
    total_leads:                  Number(obj.total_leads),
    leads_today:                  Number(obj.leads_today),
    leads_last_7_days:            Number(obj.leads_last_7_days),
    leads_last_30_days:           Number(obj.leads_last_30_days),
    whatsapp_sent:                Number(obj.whatsapp_sent),
    whatsapp_failed:              Number(obj.whatsapp_failed),
    invalid_leads:                Number(obj.invalid_leads),
    new_leads:                    Number(obj.new_leads),
    contacted_leads:              Number(obj.contacted_leads),
    qualified_leads:              Number(obj.qualified_leads),
    converted_leads:              Number(obj.converted_leads),
    lost_leads:                   Number(obj.lost_leads),
    hot_leads:                    Number(obj.hot_leads),
    warm_leads:                   Number(obj.warm_leads),
    cold_leads:                   Number(obj.cold_leads),
    unassigned_temperature_leads: Number(obj.unassigned_temperature_leads),
  };
}

export function getTodayIso(now: Date = new Date()): string {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
}

const SUPPORTED_ROLES = new Set(['admin', 'sales_rep']);

export function identityKey(user: { authUserId?: string; rep_code: string; role: string } | null): string | null {
  if (!user?.authUserId || !user?.role) return null;
  if (!SUPPORTED_ROLES.has(user.role)) return null;
  if (user.role === 'sales_rep' && !user.rep_code) return null;
  return `${user.authUserId}|${user.role}|${user.rep_code}`;
}

export function isAuthorized(): boolean {
  return isTransportOnline() && isCloudSyncAllowed();
}

export type LoadResult =
  | { kind: 'success'; data: DashboardData }
  | { kind: 'error'; message: string }
  | { kind: 'stale' };

// Error messages matching DashboardPage's UI text.
export const ERR_SIGN_IN = 'Dashboard metrics unavailable: sign-in required.';
export const ERR_WAITING = 'Dashboard metrics unavailable: waiting for connection.';
export const ERR_UNAVAILABLE = 'Dashboard metrics unavailable. Tap Retry to try again.';

export class DashboardMetricsLoader {
  private generation = 0;
  private currentIdentity: string | null = null;
  private mounted = true;

  /** Increment generation to invalidate any in-flight request. */
  invalidate(): void {
    this.generation++;
    this.currentIdentity = null;
  }

  /** Mark as unmounted — all future results are stale. */
  unmount(): void {
    this.mounted = false;
    this.generation++;
  }

  /**
   * Fetch dashboard metrics for the given identity.
   * Returns a discriminated result: success, error, or stale (discarded).
   *
   * The caller MUST check `kind === 'stale'` and NOT update state.
   */
  async load(identity: string | null): Promise<LoadResult> {
    if (!this.mounted) return { kind: 'stale' };

    if (!identity) {
      return { kind: 'error', message: ERR_SIGN_IN };
    }

    if (!isAuthorized()) {
      return { kind: 'error', message: ERR_WAITING };
    }

    const gen = ++this.generation;
    this.currentIdentity = identity;

    let rpcData: unknown = null;
    let rpcErr: unknown = null;

    try {
      const result = await supabase.rpc('get_dashboard_metrics', { p_today_iso: getTodayIso() });
      rpcData = result.data;
      rpcErr = result.error;
    } catch {
      rpcErr = { message: 'Network error' };
    }

    // Re-check authorization, generation, identity, and mount BEFORE publishing.
    if (gen !== this.generation) return { kind: 'stale' };
    if (this.currentIdentity !== identity) return { kind: 'stale' };
    if (!this.mounted) return { kind: 'stale' };
    if (!isAuthorized()) {
      return { kind: 'error', message: ERR_WAITING };
    }

    if (rpcErr) {
      return { kind: 'error', message: ERR_UNAVAILABLE };
    }

    const parsed = parseMetricsResponse(rpcData);
    if (!parsed) {
      return { kind: 'error', message: ERR_UNAVAILABLE };
    }

    if (gen !== this.generation || !this.mounted) return { kind: 'stale' };

    return { kind: 'success', data: parsed };
  }
}
