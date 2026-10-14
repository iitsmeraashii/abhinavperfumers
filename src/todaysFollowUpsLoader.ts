// Follow-up count loader for the dashboard "Today's Follow-Ups" attention tile.
//
// Mirrors the FollowUpsPage query semantics exactly:
//   status = 'PENDING'
//   reminder_date >= localStartOfToday().toISOString()
//   reminder_date <  localStartOfTomorrow().toISOString()
//
// Admin: no rep filter — RLS grants access to all follow-ups.
// Sales rep: filters by lead_entries.sales_rep_code = rep_code — same as the list page.
//
// Uses head:true with count:'exact' so only the count is returned, no rows.
// Generation-guarded so stale responses after logout/user-change/transport-flip
// are discarded.

import { supabase } from './supabaseClient';
import { isCloudSyncAllowed } from './authModeState';
import { isTransportOnline } from './connectivity/connectivityStore';

export interface FollowUpCountUser {
  rep_code: string;
  role: string;
  authUserId?: string;
}

export type FollowUpCountResult =
  | { kind: 'success'; count: number }
  | { kind: 'error'; message: string }
  | { kind: 'stale' };

export const ERR_FOLLOWUP_SIGN_IN = 'Follow-up count unavailable: sign-in required.';
export const ERR_FOLLOWUP_WAITING = 'Follow-up count unavailable: waiting for connection.';
export const ERR_FOLLOWUP_UNAVAILABLE = 'Follow-up count unavailable. Tap to retry.';

function localStartOfToday(): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
}

function localStartOfTomorrow(): Date {
  return new Date(localStartOfToday().getTime() + 24 * 60 * 60 * 1000);
}

export class TodaysFollowUpsLoader {
  private generation = 0;
  private currentIdentity: string | null = null;
  private mounted = true;

  invalidate(): void {
    this.generation++;
    this.currentIdentity = null;
  }

  unmount(): void {
    this.mounted = false;
    this.generation++;
  }

  async load(identity: string | null, user: FollowUpCountUser | null): Promise<FollowUpCountResult> {
    if (!this.mounted) return { kind: 'stale' };

    if (!identity || !user) {
      return { kind: 'error', message: ERR_FOLLOWUP_SIGN_IN };
    }

    if (!isTransportOnline() || !isCloudSyncAllowed()) {
      return { kind: 'error', message: ERR_FOLLOWUP_WAITING };
    }

    const gen = ++this.generation;
    this.currentIdentity = identity;

    const startStr = localStartOfToday().toISOString();
    const endStr = localStartOfTomorrow().toISOString();

    let countVal: number | null = null;
    let queryErr: unknown = null;

    try {
      const q = supabase
        .from('lead_follow_ups')
        .select('id, lead_entries!inner(sales_rep_code)', {
          count: 'exact',
          head: true,
        })
        .eq('status', 'PENDING')
        .gte('reminder_date', startStr)
        .lt('reminder_date', endStr);

      if (user.role !== 'admin' && user.rep_code) {
        q.eq('lead_entries.sales_rep_code', user.rep_code);
      }

      const { count, error } = await q;

      countVal = count;
      queryErr = error;
    } catch {
      queryErr = { message: 'Network error' };
    }

    if (gen !== this.generation) return { kind: 'stale' };
    if (this.currentIdentity !== identity) return { kind: 'stale' };
    if (!this.mounted) return { kind: 'stale' };

    if (!isTransportOnline() || !isCloudSyncAllowed()) {
      return { kind: 'error', message: ERR_FOLLOWUP_WAITING };
    }

    if (queryErr) {
      return { kind: 'error', message: ERR_FOLLOWUP_UNAVAILABLE };
    }

    if (countVal === null || countVal === undefined) {
      return { kind: 'error', message: ERR_FOLLOWUP_UNAVAILABLE };
    }

    if (gen !== this.generation || !this.mounted) return { kind: 'stale' };

    return { kind: 'success', count: countVal };
  }
}
