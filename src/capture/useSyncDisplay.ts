import { useEffect, useState } from 'react';
import { dbGetAllByIndexStrict, subscribePendingOps } from './db';
import { loadCompletedLeads, subscribeCompletedLeads, type CompletedLead } from './completedLeadsStorage';
import { deriveLeadSyncDisplayState, deriveQueueSyncSummary, type SyncDisplayOp } from './syncDisplayState';

/** Read-only local projection. Owner changes and superseded reads cannot publish. */
export function useSyncDisplay(ownerId: string | null | undefined, online: boolean, authMode: string) {
  const [snapshot, setSnapshot] = useState<{ ownerId: string; leads: CompletedLead[]; ops: SyncDisplayOp[] } | null>(null);
  useEffect(() => {
    if (!ownerId) return;
    let active = true;
    let generation = 0;
    let scheduled = false;
    const read = async (current: number) => {
      try {
        const [leads, ops] = await Promise.all([
          loadCompletedLeads(ownerId), dbGetAllByIndexStrict<SyncDisplayOp>('pending_ops', 'by_owner', ownerId),
        ]);
        if (active && current === generation) setSnapshot({ ownerId, leads, ops: ops.filter(op => op.ownerId === ownerId) });
      } catch { /* retain the last known snapshot, never infer a drained queue from a failed read */ }
    };
    // Invalidate old reads immediately; collapse a burst into one microtask.
    // Transaction observers only schedule work, never start reads synchronously.
    const refresh = () => {
      ++generation;
      if (scheduled) return;
      scheduled = true;
      queueMicrotask(() => {
        scheduled = false;
        if (active) void read(generation);
      });
    };
    const offLeads = subscribeCompletedLeads(refresh);
    const offOps = subscribePendingOps(refresh);
    window.addEventListener('focus', refresh);
    const visible = () => { if (document.visibilityState === 'visible') void refresh(); };
    document.addEventListener('visibilitychange', visible);
    void refresh();
    return () => {
      active = false;
      offLeads(); offOps();
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [ownerId, online, authMode]);
  const current = snapshot?.ownerId === ownerId ? snapshot : null;
  const states = new Map((current?.leads ?? []).map(lead => [lead.id,
    deriveLeadSyncDisplayState(lead, current!.ops, ownerId, online, authMode)]));
  return { states, summary: deriveQueueSyncSummary([...states.values()]), pendingCount: current?.ops.length ?? 0 };
}
