// Unread-conversations count loader for the dashboard "Unread Conversations"
// attention tile.
//
// Mirrors the ConversationsPage "Unread" filter semantics exactly:
//   whatsapp_conversations.unread_count > 0
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

export interface UnreadConversationsCountUser {
  rep_code: string;
  role: string;
  authUserId?: string;
}

export type UnreadConversationsCountResult =
  | { kind: 'success'; count: number }
  | { kind: 'error'; message: string }
  | { kind: 'stale' };

export const ERR_UNREAD_SIGN_IN = 'Unread count unavailable: sign-in required.';
export const ERR_UNREAD_WAITING = 'Unread count unavailable: waiting for connection.';
export const ERR_UNREAD_UNAVAILABLE = 'Unread count unavailable. Tap to retry.';

// ─── Tile display derivation (pure, testable) ───────────────────────────────
//
// Same pattern as deriveFollowUpTileState / deriveSamplesOpenTileState.
// Returns null when the section should not render at all (no valid identity).
// Returns a special "hidden" phase when the count is zero — the tile is
// hidden after a successful zero count, but loading/error/unavailable remain
// visible so the user can see what's happening.

export type UnreadTilePhase = 'loading' | 'success' | 'hidden' | 'error' | 'unavailable';

export interface UnreadTileDisplay {
  phase: UnreadTilePhase;
  count: number;
  canNavigate: boolean;
  canRetry: boolean;
}

export function deriveUnreadTileState(
  loading: boolean,
  error: boolean,
  unavailable: boolean,
  count: number | null,
  ucIdentity: string | null,
  currentIdentity: string | null,
): UnreadTileDisplay | null {
  if (!currentIdentity) return null;

  if (ucIdentity !== currentIdentity || loading) {
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

  if (count === 0) {
    return { phase: 'hidden', count: 0, canNavigate: false, canRetry: false };
  }

  return { phase: 'success', count, canNavigate: true, canRetry: false };
}

export class UnreadConversationsLoader {
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

  async load(identity: string | null, user: UnreadConversationsCountUser | null): Promise<UnreadConversationsCountResult> {
    if (!this.mounted) return { kind: 'stale' };

    if (!identity || !user) {
      return { kind: 'error', message: ERR_UNREAD_SIGN_IN };
    }

    if (!isTransportOnline() || !isCloudSyncAllowed()) {
      return { kind: 'error', message: ERR_UNREAD_WAITING };
    }

    const gen = ++this.generation;
    this.currentIdentity = identity;

    let countVal: number | null = null;
    let queryErr: unknown = null;

    try {
      const { count, error } = await supabase
        .from('whatsapp_conversations')
        .select('id', { count: 'exact', head: true })
        .gt('unread_count', 0);

      countVal = count;
      queryErr = error;
    } catch {
      queryErr = { message: 'Network error' };
    }

    if (gen !== this.generation) return { kind: 'stale' };
    if (this.currentIdentity !== identity) return { kind: 'stale' };
    if (!this.mounted) return { kind: 'stale' };

    if (!isTransportOnline() || !isCloudSyncAllowed()) {
      return { kind: 'error', message: ERR_UNREAD_WAITING };
    }

    if (queryErr) {
      return { kind: 'error', message: ERR_UNREAD_UNAVAILABLE };
    }

    if (countVal === null || countVal === undefined) {
      return { kind: 'error', message: ERR_UNREAD_UNAVAILABLE };
    }

    if (gen !== this.generation || !this.mounted) return { kind: 'stale' };

    return { kind: 'success', count: countVal };
  }
}
