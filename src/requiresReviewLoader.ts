// Requires-review count loader for the dashboard "Requires Review" attention tile.
//
// Mirrors the LeadsPage lead-status filter exactly:
//   lead_entries.lead_status = 'REQUIRES_REVIEW'
//
// Admin: no rep filter — RLS grants access to all leads, including unassigned.
// Sales rep: filters by sales_rep_code = rep_code — same as the leads list page.
//
// Counts current actionable records independently of analytics date ranges.
// Uses head:true with count:'exact' so only the count is returned, no rows.
// Generation-guarded so stale responses after logout/user-change/transport-flip
// are discarded.

import { supabase } from './supabaseClient';
import { isCloudSyncAllowed } from './authModeState';
import { isTransportOnline } from './connectivity/connectivityStore';

export interface RequiresReviewCountUser {
  rep_code: string;
  role: string;
  authUserId?: string;
}

export type RequiresReviewCountResult =
  | { kind: 'success'; count: number }
  | { kind: 'error'; message: string }
  | { kind: 'stale' };

export const ERR_REVIEW_SIGN_IN = 'Requires review count unavailable: sign-in required.';
export const ERR_REVIEW_WAITING = 'Requires review count unavailable: waiting for connection.';
export const ERR_REVIEW_UNAVAILABLE = 'Requires review count unavailable. Tap to retry.';

export type RequiresReviewTilePhase = 'loading' | 'success' | 'error' | 'unavailable';

export interface RequiresReviewTileDisplay {
  phase: RequiresReviewTilePhase;
  count: number;
  canNavigate: boolean;
  canRetry: boolean;
}

export function deriveRequiresReviewTileState(
  loading: boolean,
  error: boolean,
  unavailable: boolean,
  count: number | null,
  rrIdentity: string | null,
  currentIdentity: string | null,
): RequiresReviewTileDisplay | null {
  if (!currentIdentity) return null;

  if (rrIdentity !== currentIdentity || loading) {
    return { phase: 'loading', count: 0, canNavigate: false, canRetry: false };
  }

  if (unavailable) {
    return { phase: 'unavailable', count: 0, canNavigate: false, canRetry: false };
  }

  if (error) {
    return { phase: 'error', count: 0, canNavigate: false, canRetry: true };
  }

  if (count === null) {
    return { phase: 'error', count: 0, canNavigate: false, canRetry: true };
  }

  return { phase: 'success', count, canNavigate: true, canRetry: false };
}

export class RequiresReviewLoader {
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

  async load(identity: string | null, user: RequiresReviewCountUser | null): Promise<RequiresReviewCountResult> {
    if (!this.mounted) return { kind: 'stale' };

    if (!identity || !user) {
      return { kind: 'error', message: ERR_REVIEW_SIGN_IN };
    }

    if (!isTransportOnline() || !isCloudSyncAllowed()) {
      return { kind: 'error', message: ERR_REVIEW_WAITING };
    }

    const gen = ++this.generation;
    this.currentIdentity = identity;

    let countVal: number | null = null;
    let queryErr: unknown = null;

    try {
      const q = supabase
        .from('lead_entries')
        .select('id', { count: 'exact', head: true })
        .eq('lead_status', 'REQUIRES_REVIEW');

      if (user.role !== 'admin' && user.rep_code) {
        q.eq('sales_rep_code', user.rep_code);
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
      return { kind: 'error', message: ERR_REVIEW_WAITING };
    }

    if (queryErr) {
      return { kind: 'error', message: ERR_REVIEW_UNAVAILABLE };
    }

    if (countVal === null || countVal === undefined) {
      return { kind: 'error', message: ERR_REVIEW_UNAVAILABLE };
    }

    if (gen !== this.generation || !this.mounted) return { kind: 'stale' };

    return { kind: 'success', count: countVal };
  }
}
