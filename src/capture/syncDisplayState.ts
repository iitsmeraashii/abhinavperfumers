/** UI projections only: never authorize work or persist these states. */
export interface SyncDisplayLead {
  id: string;
  ownerId?: string | null;
  backendSessionId: string | null;
  status: string;
  source?: string;
  isExhausted?: boolean;
}
export interface SyncDisplayOp { ownerId: string | null; sessionId: string }
export type LeadSyncDisplayState = 'Saved offline' | 'Syncing…' | 'Saved' | 'Synced' | 'Needs attention' | 'Draft' | 'Needs Review';
export function deriveLeadSyncDisplayState(
  lead: SyncDisplayLead, ops: readonly SyncDisplayOp[], ownerId: string | null | undefined,
  transportOnline: boolean, authMode: string,
): LeadSyncDisplayState {
  if (lead.status === 'draft' || (lead.source && lead.source !== 'completed')) return 'Draft';
  if (lead.status === 'synced') return 'Synced';
  if (lead.status === 'needs_review') return 'Needs Review';
  if (lead.status === 'failed' && lead.isExhausted) return 'Needs attention';
  if (!transportOnline || authMode !== 'online') return 'Saved offline';
  // buildCompletedLead keys records by frontend session ID. Prefer the explicit
  // backend alias when present; never match arbitrary draft IDs or missing owners.
  const sessionId = lead.backendSessionId || lead.id;
  const matches = !!ownerId && lead.ownerId === ownerId && !!sessionId &&
    ops.some(op => op.ownerId === ownerId && op.sessionId === sessionId);
  return matches ? 'Syncing…' : 'Saved';
}
export function deriveQueueSyncSummary(states: readonly LeadSyncDisplayState[]): string | null {
  if (states.includes('Saved offline')) return 'Saved safely offline. Will sync automatically when connected.';
  if (states.includes('Syncing…')) return 'Syncing saved leads…';
  if (states.includes('Saved')) return 'Saved leads';
  return null;
}

/** Current scheduler retry metadata; a generic/legacy error alone is not proof. */
export function hasAutomaticRetryMetadata(lead: {
  status: string; isExhausted?: boolean; retries?: number;
  lastAttemptAt?: string | null; failedStage?: string | null; failedAt?: string | null;
}): boolean {
  return lead.status === 'failed' && lead.isExhausted === false &&
    (lead.retries ?? 0) > 0 && !!lead.lastAttemptAt && !!lead.failedStage && !lead.failedAt;
}
