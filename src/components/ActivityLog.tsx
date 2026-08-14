import { useEffect, useState, useCallback } from 'react';
import { Loader2, History, ChevronDown } from 'lucide-react';
import { fetchLeadActivities, type LeadActivity } from '../leadActivityService';
import { formatDateTime } from '../utils/dateFormat';

const ACTION_ICONS: Record<string, string> = {
  STATUS_CHANGED: 'bg-blue-50 text-blue-600',
  FIELD_UPDATED: 'bg-stone-50 text-stone-500',
  SALES_REP_CHANGED: 'bg-purple-50 text-purple-600',
  EVENT_CHANGED: 'bg-amber-50 text-amber-600',
  LEAD_TEMPERATURE_CHANGED: 'bg-orange-50 text-orange-600',
  REVIEWED: 'bg-green-50 text-green-600',
  CREATED: 'bg-emerald-50 text-emerald-600',
};

function ActivityIcon({ actionType }: { actionType: string }) {
  const colorClass = ACTION_ICONS[actionType] ?? 'bg-stone-50 text-stone-500';
  return (
    <div className={`w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 ${colorClass}`}>
      <History className="w-3.5 h-3.5" />
    </div>
  );
}

function ActivityItem({ activity }: { activity: LeadActivity }) {
  const actorName = activity.actor_name ?? activity.actor_rep_code ?? 'System';
  return (
    <div className="flex gap-3 py-3 border-b border-stone-100 last:border-0">
      <ActivityIcon actionType={activity.action_type} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <p className="text-sm font-medium text-stone-800 truncate">{actorName}</p>
          <p className="text-xs text-stone-400 flex-shrink-0">{formatDateTime(activity.created_at) ?? '—'}</p>
        </div>
        <p className="text-sm text-stone-600 mt-0.5">{activity.note}</p>
      </div>
    </div>
  );
}

export function ActivityLog({ leadId }: { leadId: string }) {
  const [activities, setActivities] = useState<LeadActivity[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  const load = useCallback(async (p: number) => {
    const { activities: rows, hasMore: more } = await fetchLeadActivities(leadId, p);
    if (p === 0) {
      setActivities(rows);
      setLoading(false);
    } else {
      setActivities(prev => [...prev, ...rows]);
      setLoadingMore(false);
    }
    setHasMore(more);
    setPage(p);
  }, [leadId]);

  useEffect(() => {
    setLoading(true);
    load(0);
  }, [leadId, load]);

  if (loading) {
    return (
      <div className="bg-white border border-stone-200 rounded-xl overflow-hidden">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-stone-100 bg-stone-50">
          <span className="text-stone-500"><History className="w-4 h-4" /></span>
          <h3 className="text-sm font-semibold text-stone-700">Activity</h3>
        </div>
        <div className="flex items-center justify-center py-8">
          <Loader2 className="w-5 h-5 text-stone-300 animate-spin" />
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white border border-stone-200 rounded-xl overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-stone-100 bg-stone-50">
        <span className="text-stone-500"><History className="w-4 h-4" /></span>
        <h3 className="text-sm font-semibold text-stone-700">Activity</h3>
      </div>
      <div className="px-4">
        {activities.length === 0 ? (
          <p className="text-sm text-stone-400 py-6 text-center">No activity recorded yet.</p>
        ) : (
          activities.map(a => <ActivityItem key={a.id} activity={a} />)
        )}
        {hasMore && (
          <button
            onClick={() => { setLoadingMore(true); load(page + 1); }}
            disabled={loadingMore}
            className="flex items-center justify-center gap-1.5 w-full py-3 text-sm text-stone-500 hover:text-stone-700 transition"
          >
            {loadingMore ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ChevronDown className="w-3.5 h-3.5" />}
            {loadingMore ? 'Loading…' : 'Load more'}
          </button>
        )}
      </div>
    </div>
  );
}
