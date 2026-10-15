// Samples-Open count loader for the dashboard "Samples: Open" attention tile.
//
// Mirrors the ConversationsPage "Samples: Open" filter semantics exactly:
//   samples_requested.status = 'OPEN'
//
// Because samples_requested has a UNIQUE constraint on conversation_id,
// each row corresponds to exactly one conversation — no duplicates even when
// a conversation links to multiple leads.
//
// Admin: no extra filter — RLS grants access via has_whatsapp_conversation_access.
// Sales rep: RLS automatically scopes to conversations they can access
//   (at least one linked lead assigned to their rep_code).
//
// Uses head:true with count:'exact' so only the count is returned, no rows.
// Generation-guarded so stale responses after logout/user-change/transport-flip
// are discarded.

import { supabase } from './supabaseClient';
import { isCloudSyncAllowed } from './authModeState';
import { isTransportOnline } from './connectivity/connectivityStore';

export interface SamplesOpenCountUser {
  rep_code: string;
  role: string;
  authUserId?: string;
}

export type SamplesOpenCountResult =
  | { kind: 'success'; count: number }
  | { kind: 'error'; message: string }
  | { kind: 'stale' };

export const ERR_SAMPLES_SIGN_IN = 'Samples count unavailable: sign-in required.';
export const ERR_SAMPLES_WAITING = 'Samples count unavailable: waiting for connection.';
export const ERR_SAMPLES_UNAVAILABLE = 'Samples count unavailable. Tap to retry.';

// ─── Tile display derivation (pure, testable) ───────────────────────────────
//
// Same pattern as deriveFollowUpTileState.
// Returns null when the section should not render at all (no valid identity).

export type SamplesOpenTilePhase = 'loading' | 'success' | 'error' | 'unavailable';

export interface SamplesOpenTileDisplay {
  phase: SamplesOpenTilePhase;
  count: number;
  canNavigate: boolean;
  canRetry: boolean;
}

export function deriveSamplesOpenTileState(
  loading: boolean,
  error: boolean,
  unavailable: boolean,
  count: number | null,
  soIdentity: string | null,
  currentIdentity: string | null,
): SamplesOpenTileDisplay | null {
  if (!currentIdentity) return null;

  if (soIdentity !== currentIdentity || loading) {
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

export class SamplesOpenLoader {
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

  async load(identity: string | null, user: SamplesOpenCountUser | null): Promise<SamplesOpenCountResult> {
    if (!this.mounted) return { kind: 'stale' };

    if (!identity || !user) {
      return { kind: 'error', message: ERR_SAMPLES_SIGN_IN };
    }

    if (!isTransportOnline() || !isCloudSyncAllowed()) {
      return { kind: 'error', message: ERR_SAMPLES_WAITING };
    }

    const gen = ++this.generation;
    this.currentIdentity = identity;

    let countVal: number | null = null;
    let queryErr: unknown = null;

    try {
      const { count, error } = await supabase
        .from('samples_requested')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'OPEN');

      countVal = count;
      queryErr = error;
    } catch {
      queryErr = { message: 'Network error' };
    }

    if (gen !== this.generation) return { kind: 'stale' };
    if (this.currentIdentity !== identity) return { kind: 'stale' };
    if (!this.mounted) return { kind: 'stale' };

    if (!isTransportOnline() || !isCloudSyncAllowed()) {
      return { kind: 'error', message: ERR_SAMPLES_WAITING };
    }

    if (queryErr) {
      return { kind: 'error', message: ERR_SAMPLES_UNAVAILABLE };
    }

    if (countVal === null || countVal === undefined) {
      return { kind: 'error', message: ERR_SAMPLES_UNAVAILABLE };
    }

    if (gen !== this.generation || !this.mounted) return { kind: 'stale' };

    return { kind: 'success', count: countVal };
  }
}
