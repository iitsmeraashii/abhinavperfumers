import { useCallback, useEffect, useState } from 'react';
import { supabase } from './supabaseClient';
import { useAuth } from './AuthContext';
import { formatDateTime } from './utils/dateFormat';
import {
  Bell, CalendarClock, CheckCircle2, ChevronLeft, ChevronRight,
  Loader2, AlertCircle, Building2,
} from 'lucide-react';

// ─── Types ────────────────────────────────────────────────────────────────────

interface LeadEntryRef {
  id: string;
  client_name: string | null;
  company: string | null;
  sales_rep_code: string | null;
  lead_status: string | null;
}

interface FollowUpRow {
  id: string;
  lead_id: string;
  reminder_date: string;
  note: string;
  status: 'PENDING' | 'COMPLETED';
  created_by: string;
  created_at: string;
  lead_entries: LeadEntryRef | null;
}

type DueState = 'overdue' | 'today' | 'upcoming';
type DateFilter = 'all' | 'today' | 'next7';

// ─── Constants ────────────────────────────────────────────────────────────────

const PAGE_SIZE = 25;

const FILTER_OPTIONS: { label: string; value: DateFilter }[] = [
  { label: 'All',         value: 'all' },
  { label: 'Today',       value: 'today' },
  { label: 'Next 7 Days', value: 'next7' },
];

// ─── Date boundary helpers (local timezone) ──────────────────────────────────

function localStartOfToday(): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
}

function localStartOfTomorrow(): Date {
  const start = localStartOfToday();
  return new Date(start.getTime() + 24 * 60 * 60 * 1000);
}

function nowPlus7Days(): Date {
  return new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
}

// ─── Due-state classification (client-side display only) ─────────────────────

function classifyDueState(reminderDate: string): DueState {
  const reminder = new Date(reminderDate);
  const startToday = localStartOfToday();
  const startTomorrow = localStartOfTomorrow();

  if (reminder.getTime() < startToday.getTime()) return 'overdue';
  if (reminder.getTime() >= startToday.getTime() && reminder.getTime() < startTomorrow.getTime()) return 'today';
  return 'upcoming';
}

// ─── Component ────────────────────────────────────────────────────────────────

interface FollowUpsPageProps {
  onSelectLead: (leadId: string) => void;
  onOpenFollowUpComplete: (followUpId: string) => void;
}

export default function FollowUpsPage({ onSelectLead, onOpenFollowUpComplete }: FollowUpsPageProps) {
  const { user } = useAuth();
  const [rows, setRows] = useState<FollowUpRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [page, setPage] = useState(0);
  const [total, setTotal] = useState(0);
  const [dateFilter, setDateFilter] = useState<DateFilter>('all');
  const [completingId, setCompletingId] = useState<string | null>(null);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const fetchPage = useCallback(async (p: number, filter: DateFilter) => {
    setLoading(true);
    setError('');

    const from = p * PAGE_SIZE;
    const to = from + PAGE_SIZE - 1;

    let q = supabase
      .from('lead_follow_ups')
      .select(
        'id, lead_id, reminder_date, note, status, created_by, created_at, lead_entries!inner(id, client_name, company, sales_rep_code, lead_status)',
        { count: 'exact' },
      )
      .eq('status', 'PENDING')
      .order('reminder_date', { ascending: true })
      .order('created_at', { ascending: true })
      .range(from, to);

    if (filter === 'today') {
      const startStr = localStartOfToday().toISOString();
      const endStr = localStartOfTomorrow().toISOString();
      q = q.gte('reminder_date', startStr).lt('reminder_date', endStr);
    } else if (filter === 'next7') {
      const cutoffStr = nowPlus7Days().toISOString();
      q = q.lt('reminder_date', cutoffStr);
    }

    if (user?.role !== 'admin' && user?.rep_code) {
      q = q.eq('lead_entries.sales_rep_code', user.rep_code);
    }

    const { data, count, error: err } = await q;

    if (err) {
      console.error('[FollowUpsPage] load failed', err);
      setError('We couldn\u2019t load follow-ups right now. Please try again.');
      setRows([]);
      setTotal(0);
      setLoading(false);
      return;
    }

    setRows((data ?? []) as unknown as FollowUpRow[]);
    setTotal(count ?? 0);
    setLoading(false);
  }, [user?.role, user?.rep_code]);

  useEffect(() => {
    fetchPage(page, dateFilter);
  }, [page, dateFilter, fetchPage]);

  function handleFilterChange(f: DateFilter) {
    if (f === dateFilter) return;
    setDateFilter(f);
    setPage(0);
  }

  function handleComplete(followUpId: string) {
    onOpenFollowUpComplete(followUpId);
    setCompletingId(followUpId);
  }

  // Detect modal closure via URL param removal, then refresh
  useEffect(() => {
    if (!completingId) return;

    function check() {
      const params = new URLSearchParams(window.location.search);
      if (!params.get('followup')) {
        setCompletingId(null);
        fetchPage(page, dateFilter);
      }
    }

    function onPopState() {
      check();
    }

    window.addEventListener('popstate', onPopState);
    const interval = setInterval(check, 800);

    return () => {
      window.removeEventListener('popstate', onPopState);
      clearInterval(interval);
    };
  }, [completingId, page, dateFilter, fetchPage]);

  function goToPage(p: number) {
    if (p < 0 || p >= totalPages) return;
    setPage(p);
  }

  const filterLabel = FILTER_OPTIONS.find(f => f.value === dateFilter)?.label ?? 'All';

  // ─── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="max-w-4xl mx-auto px-4 lg:px-6 py-6">
      {/* Header */}
      <div className="flex items-center gap-3 mb-5">
        <div className="flex items-center justify-center w-10 h-10 rounded-xl bg-amber-100">
          <Bell className="w-5 h-5 text-amber-600" />
        </div>
        <div>
          <h1 className="text-xl font-semibold text-stone-800">Follow-Ups</h1>
          <p className="text-sm text-stone-500">
            {loading ? 'Loading…' : `${total} pending · ${filterLabel}`}
          </p>
        </div>
      </div>

      {/* Filter tabs */}
      <div className="flex items-center gap-1.5 mb-5 p-1 bg-stone-100 rounded-xl w-fit">
        {FILTER_OPTIONS.map(opt => {
          const active = dateFilter === opt.value;
          return (
            <button
              key={opt.value}
              onClick={() => handleFilterChange(opt.value)}
              className={`px-3.5 py-1.5 text-sm font-medium rounded-lg transition-colors
                ${active
                  ? 'bg-white text-stone-900 shadow-sm'
                  : 'text-stone-500 hover:text-stone-700'}`}
            >
              {opt.label}
            </button>
          );
        })}
      </div>

      {/* Loading */}
      {loading && (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="w-6 h-6 text-amber-600 animate-spin" />
        </div>
      )}

      {/* Error */}
      {!loading && error && (
        <div className="flex items-center gap-2 px-4 py-3 bg-red-50 border border-red-200 text-red-700 text-sm rounded-xl">
          <AlertCircle className="w-4 h-4 shrink-0" />
          {error}
        </div>
      )}

      {/* Empty */}
      {!loading && !error && rows.length === 0 && (
        <div className="flex flex-col items-center justify-center py-16 text-center gap-3">
          <div className="w-14 h-14 rounded-full bg-stone-100 flex items-center justify-center">
            <CheckCircle2 className="w-7 h-7 text-stone-300" />
          </div>
          <p className="text-stone-600 font-medium">All caught up</p>
          <p className="text-stone-400 text-sm">
            No pending follow-ups {dateFilter === 'today' ? 'due today' : dateFilter === 'next7' ? 'in the next 7 days' : 'to show'}.
          </p>
        </div>
      )}

      {/* List */}
      {!loading && !error && rows.length > 0 && (
        <div className="flex flex-col gap-3">
          {rows.map((fu) => {
            const dueState = classifyDueState(fu.reminder_date);
            const lead = fu.lead_entries;

            const stateStyles: Record<DueState, { badge: string; dot: string; border: string; label: string }> = {
              overdue: {
                badge: 'bg-red-100 text-red-700',
                dot: 'bg-red-500',
                border: 'border-l-red-400',
                label: 'Overdue',
              },
              today: {
                badge: 'bg-amber-100 text-amber-700',
                dot: 'bg-amber-500',
                border: 'border-l-amber-400',
                label: 'Due Today',
              },
              upcoming: {
                badge: 'bg-sky-100 text-sky-700',
                dot: 'bg-sky-400',
                border: 'border-l-sky-300',
                label: 'Upcoming',
              },
            };
            const st = stateStyles[dueState];

            return (
              <div
                key={fu.id}
                className={`bg-white border border-stone-200 border-l-4 ${st.border} rounded-xl overflow-hidden transition-shadow hover:shadow-md`}
              >
                <button
                  onClick={() => onSelectLead(fu.lead_id)}
                  className="w-full text-left px-4 py-3.5 flex items-start gap-3"
                >
                  <div className="flex flex-col items-center gap-1 pt-0.5 shrink-0">
                    <span className={`w-2 h-2 rounded-full ${st.dot}`} />
                  </div>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap mb-1">
                      <span className="text-sm font-semibold text-stone-800 truncate">
                        {lead?.client_name || 'Unknown lead'}
                      </span>
                      <span className={`text-[11px] font-medium px-2 py-0.5 rounded-full ${st.badge}`}>
                        {st.label}
                      </span>
                      {lead?.lead_status && (
                        <span className="text-[11px] font-medium px-2 py-0.5 rounded-full bg-stone-100 text-stone-500">
                          {lead.lead_status}
                        </span>
                      )}
                    </div>

                    {lead?.company && (
                      <div className="flex items-center gap-1.5 text-xs text-stone-500 mb-1.5">
                        <Building2 className="w-3.5 h-3.5 shrink-0" />
                        <span className="truncate">{lead.company}</span>
                      </div>
                    )}

                    {fu.note && (
                      <p className="text-sm text-stone-600 leading-relaxed mb-2 line-clamp-2">{fu.note}</p>
                    )}

                    <div className="flex items-center gap-1.5 text-xs text-stone-400">
                      <CalendarClock className="w-3.5 h-3.5 shrink-0" />
                      <span>{formatDateTime(fu.reminder_date)}</span>
                    </div>
                  </div>
                </button>

                <div className="px-4 py-2.5 border-t border-stone-100 bg-stone-50/50 flex justify-end">
                  <button
                    onClick={() => handleComplete(fu.id)}
                    disabled={completingId === fu.id}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-white border border-stone-200 text-stone-600 hover:bg-green-50 hover:text-green-700 hover:border-green-200 transition disabled:opacity-50"
                  >
                    {completingId === fu.id ? (
                      <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Opening…</>
                    ) : (
                      <><CheckCircle2 className="w-3.5 h-3.5" /> Mark Complete</>
                    )}
                  </button>
                </div>
              </div>
            );
          })}

          {totalPages > 1 && (
            <div className="flex items-center justify-between pt-4">
              <p className="text-xs text-stone-400">
                Page {page + 1} of {totalPages} · {total} total
              </p>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => goToPage(page - 1)}
                  disabled={page === 0}
                  className="p-2 rounded-lg border border-stone-200 text-stone-600 hover:bg-stone-50 transition disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  <ChevronLeft className="w-4 h-4" />
                </button>
                <button
                  onClick={() => goToPage(page + 1)}
                  disabled={page >= totalPages - 1}
                  className="p-2 rounded-lg border border-stone-200 text-stone-600 hover:bg-stone-50 transition disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  <ChevronRight className="w-4 h-4" />
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
