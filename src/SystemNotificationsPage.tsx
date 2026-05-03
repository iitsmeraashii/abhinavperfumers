import { useEffect, useState, useCallback, useRef } from 'react';
import { supabase } from './supabaseClient';
import {
  AlertCircle, AlertTriangle, Info, Search, X,
  ChevronDown, ChevronUp, Loader2, BellOff, RefreshCw,
} from 'lucide-react';

interface SystemNotification {
  id: string;
  created_at: string;
  type: string;
  source: string;
  message: string;
  metadata: Record<string, unknown> | null;
}

type TypeFilter = 'ALL' | 'ERROR' | 'WARNING' | 'INFO';
type TimeRange = '1h' | '24h' | '7d' | 'all';

const PAGE_SIZE = 30;

const TYPE_CONFIG: Record<string, {
  icon: React.ReactNode;
  cardBorder: string;
  badge: string;
  tabActive: string;
}> = {
  ERROR: {
    icon: <AlertCircle className="w-3.5 h-3.5" />,
    cardBorder: 'border-l-red-500 bg-red-50/40',
    badge: 'bg-red-100 text-red-700 border-red-200',
    tabActive: 'border-red-500 text-red-700',
  },
  WARNING: {
    icon: <AlertTriangle className="w-3.5 h-3.5" />,
    cardBorder: 'border-l-amber-400 bg-amber-50/40',
    badge: 'bg-amber-100 text-amber-700 border-amber-200',
    tabActive: 'border-amber-400 text-amber-700',
  },
  INFO: {
    icon: <Info className="w-3.5 h-3.5" />,
    cardBorder: 'border-l-sky-400 bg-sky-50/20',
    badge: 'bg-sky-100 text-sky-700 border-sky-200',
    tabActive: 'border-sky-400 text-sky-700',
  },
};

function getConfig(type: string) {
  return TYPE_CONFIG[type?.toUpperCase()] ?? TYPE_CONFIG['INFO'];
}

function formatTimestamp(iso: string) {
  return new Date(iso).toLocaleString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true,
  });
}

function getTimeRangeStart(range: TimeRange): string | null {
  if (range === 'all') return null;
  const now = new Date();
  if (range === '1h') return new Date(now.getTime() - 60 * 60 * 1000).toISOString();
  if (range === '24h') return new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  if (range === '7d') return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
  return null;
}

const TIME_RANGE_LABELS: Record<TimeRange, string> = {
  '1h': 'Last 1 hour',
  '24h': 'Last 24 hours',
  '7d': 'Last 7 days',
  'all': 'All time',
};

const SOURCE_OPTIONS = ['All', 'n8n', 'system'];

function NotificationCard({ n }: { n: SystemNotification }) {
  const [expanded, setExpanded] = useState(false);
  const cfg = getConfig(n.type);

  return (
    <div className={`border border-stone-200 border-l-4 rounded-xl overflow-hidden transition-shadow hover:shadow-sm ${cfg.cardBorder}`}>
      <div className="px-4 py-3.5">
        <div className="flex items-start justify-between gap-3 mb-2">
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-semibold border ${cfg.badge}`}>
              {cfg.icon}
              {n.type?.toUpperCase()}
            </span>
            {n.source && (
              <span className="inline-block px-2 py-0.5 rounded-md text-xs font-medium bg-stone-100 text-stone-600 border border-stone-200">
                {n.source}
              </span>
            )}
          </div>
          <span className="text-xs text-stone-400 whitespace-nowrap flex-shrink-0 mt-0.5">
            {formatTimestamp(n.created_at)}
          </span>
        </div>

        <p className={`text-sm leading-relaxed ${n.type?.toUpperCase() === 'ERROR' ? 'text-red-900 font-medium' : 'text-stone-700'}`}>
          {n.message}
        </p>

        {n.metadata && Object.keys(n.metadata).length > 0 && (
          <button
            onClick={() => setExpanded(e => !e)}
            className="mt-2.5 flex items-center gap-1 text-xs text-stone-400 hover:text-stone-600 transition"
          >
            {expanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
            {expanded ? 'Hide details' : 'View details'}
          </button>
        )}
      </div>

      {expanded && n.metadata && (
        <div className="border-t border-stone-200 bg-stone-950 px-4 py-3 overflow-x-auto">
          <pre className="text-xs text-stone-300 leading-relaxed whitespace-pre-wrap font-mono">
            {JSON.stringify(n.metadata, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}

export default function SystemNotificationsPage() {
  const [notifications, setNotifications] = useState<SystemNotification[]>([]);
  const [loading, setLoading] = useState(true);
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('ALL');
  const [sourceFilter, setSourceFilter] = useState('All');
  const [timeRange, setTimeRange] = useState<TimeRange>('24h');
  const [searchInput, setSearchInput] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  const [page, setPage] = useState(0);
  const [total, setTotal] = useState(0);
  const [counts, setCounts] = useState<Record<string, number>>({ ERROR: 0, WARNING: 0, INFO: 0 });

  const [sourceOpen, setSourceOpen] = useState(false);
  const [timeOpen, setTimeOpen] = useState(false);
  const sourceRef = useRef<HTMLDivElement>(null);
  const timeRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const totalPages = Math.ceil(total / PAGE_SIZE);

  // Close dropdowns on outside click
  useEffect(() => {
    function handler(e: MouseEvent) {
      if (sourceRef.current && !sourceRef.current.contains(e.target as Node)) setSourceOpen(false);
      if (timeRef.current && !timeRef.current.contains(e.target as Node)) setTimeOpen(false);
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const fetchCounts = useCallback(async () => {
    const { data } = await supabase.from('system_notifications').select('type');
    if (data) {
      const c = { ERROR: 0, WARNING: 0, INFO: 0 } as Record<string, number>;
      data.forEach(r => { const t = r.type?.toUpperCase(); if (t in c) c[t]++; });
      setCounts(c);
    }
  }, []);

  const fetchNotifications = useCallback(async (
    p: number,
    tf: TypeFilter,
    sf: string,
    tr: TimeRange,
    term: string,
  ) => {
    setLoading(true);
    const from = p * PAGE_SIZE;
    const to = from + PAGE_SIZE - 1;

    let q = supabase
      .from('system_notifications')
      .select('*', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(from, to);

    if (tf !== 'ALL') q = q.eq('type', tf);
    if (sf !== 'All') q = q.eq('source', sf);
    const rangeStart = getTimeRangeStart(tr);
    if (rangeStart) q = q.gte('created_at', rangeStart);
    if (term.trim()) q = q.ilike('message', `%${term.trim()}%`);

    const { data, count, error } = await q;
    if (!error) {
      setNotifications((data as SystemNotification[]) ?? []);
      setTotal(count ?? 0);
    }
    setLoading(false);
  }, []);

  useEffect(() => { fetchCounts(); }, [fetchCounts]);

  // Reset page and refetch when any filter changes
  useEffect(() => {
    setPage(0);
    fetchNotifications(0, typeFilter, sourceFilter, timeRange, searchTerm);
  }, [typeFilter, sourceFilter, timeRange, searchTerm, fetchNotifications]);

  // Fetch on page change
  useEffect(() => {
    fetchNotifications(page, typeFilter, sourceFilter, timeRange, searchTerm);
  }, [page]); // eslint-disable-line react-hooks/exhaustive-deps

  function handleSearchChange(v: string) {
    setSearchInput(v);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => { setSearchTerm(v); setPage(0); }, 300);
  }

  function resetFilters() {
    setTypeFilter('ALL');
    setSourceFilter('All');
    setTimeRange('24h');
    setSearchInput('');
    setSearchTerm('');
    setPage(0);
  }

  function handleRefresh() {
    fetchNotifications(page, typeFilter, sourceFilter, timeRange, searchTerm);
    fetchCounts();
  }

  const hasActiveFilters = typeFilter !== 'ALL' || sourceFilter !== 'All' || timeRange !== '24h' || searchTerm !== '';

  const tabs: { label: string; value: TypeFilter }[] = [
    { label: 'All', value: 'ALL' },
    { label: 'Errors', value: 'ERROR' },
    { label: 'Warnings', value: 'WARNING' },
    { label: 'Info', value: 'INFO' },
  ];

  const rangeStart = total === 0 ? 0 : page * PAGE_SIZE + 1;
  const rangeEnd = Math.min((page + 1) * PAGE_SIZE, total);

  return (
    <div className="p-6 max-w-4xl mx-auto">
      {/* Header */}
      <div className="flex items-start justify-between mb-5 gap-4">
        <div>
          <h2 className="text-xl font-semibold text-stone-800">System Notifications</h2>
          <p className="text-sm text-stone-500 mt-0.5">Monitor system events, errors, and warnings</p>
        </div>
        <button
          onClick={handleRefresh}
          className="p-1.5 rounded-lg border border-stone-200 bg-white text-stone-500 hover:text-stone-700 hover:bg-stone-50 transition mt-0.5"
          title="Refresh"
        >
          <RefreshCw className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Summary badges */}
      <div className="flex items-center gap-3 mb-5">
        {(['ERROR', 'WARNING', 'INFO'] as const).map(t => {
          const cfg = getConfig(t);
          return (
            <div key={t} className={`flex items-center gap-1.5 px-3 py-2 rounded-xl border text-xs font-medium ${cfg.badge}`}>
              {cfg.icon}
              <span className="font-bold">{counts[t]}</span>
              <span className="opacity-70">{t === 'ERROR' ? 'Errors' : t === 'WARNING' ? 'Warnings' : 'Info'}</span>
            </div>
          );
        })}
      </div>

      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-2 mb-4 p-3 bg-white border border-stone-200 rounded-xl">
        {/* Source dropdown */}
        <div className="relative" ref={sourceRef}>
          <button
            onClick={() => { setSourceOpen(o => !o); setTimeOpen(false); }}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border transition ${
              sourceFilter !== 'All'
                ? 'bg-stone-800 border-stone-800 text-white'
                : 'border-stone-200 bg-stone-50 text-stone-600 hover:border-stone-300'
            }`}
          >
            <span>Source: {sourceFilter}</span>
            {sourceFilter !== 'All'
              ? <X className="w-3 h-3" onClick={e => { e.stopPropagation(); setSourceFilter('All'); }} />
              : <ChevronDown className="w-3 h-3" />
            }
          </button>
          {sourceOpen && (
            <div className="absolute z-20 mt-1 left-0 bg-white border border-stone-200 rounded-xl shadow-lg min-w-[140px] py-1">
              {SOURCE_OPTIONS.map(s => (
                <button
                  key={s}
                  onClick={() => { setSourceFilter(s); setSourceOpen(false); setPage(0); }}
                  className={`w-full text-left px-3 py-2 text-xs transition ${
                    sourceFilter === s ? 'bg-stone-100 text-stone-800 font-medium' : 'text-stone-600 hover:bg-stone-50'
                  }`}
                >
                  {s}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Time range dropdown */}
        <div className="relative" ref={timeRef}>
          <button
            onClick={() => { setTimeOpen(o => !o); setSourceOpen(false); }}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border transition ${
              timeRange !== '24h'
                ? 'bg-stone-800 border-stone-800 text-white'
                : 'border-stone-200 bg-stone-50 text-stone-600 hover:border-stone-300'
            }`}
          >
            <span>{TIME_RANGE_LABELS[timeRange]}</span>
            <ChevronDown className="w-3 h-3" />
          </button>
          {timeOpen && (
            <div className="absolute z-20 mt-1 left-0 bg-white border border-stone-200 rounded-xl shadow-lg min-w-[160px] py-1">
              {(Object.entries(TIME_RANGE_LABELS) as [TimeRange, string][]).map(([val, label]) => (
                <button
                  key={val}
                  onClick={() => { setTimeRange(val); setTimeOpen(false); setPage(0); }}
                  className={`w-full text-left px-3 py-2 text-xs transition ${
                    timeRange === val ? 'bg-stone-100 text-stone-800 font-medium' : 'text-stone-600 hover:bg-stone-50'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Search */}
        <div className="relative flex-1 min-w-[180px]">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-stone-400 pointer-events-none" />
          <input
            type="text"
            value={searchInput}
            onChange={e => handleSearchChange(e.target.value)}
            placeholder="Search messages…"
            className="w-full pl-8 pr-7 py-1.5 text-xs border border-stone-200 rounded-lg bg-stone-50 text-stone-800 placeholder-stone-400 focus:outline-none focus:ring-2 focus:ring-stone-300 focus:bg-white transition"
          />
          {searchInput && (
            <button
              onClick={() => { setSearchInput(''); setSearchTerm(''); }}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-stone-400 hover:text-stone-600"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        {/* Reset */}
        {hasActiveFilters && (
          <button
            onClick={resetFilters}
            className="flex items-center gap-1 px-2.5 py-1.5 text-xs text-stone-400 hover:text-red-500 transition"
          >
            <X className="w-3 h-3" /> Reset
          </button>
        )}
      </div>

      {/* Type filter tabs */}
      <div className="flex items-center gap-1 border-b border-stone-200 mb-5">
        {tabs.map(tab => {
          const isActive = typeFilter === tab.value;
          const cfg = tab.value !== 'ALL' ? getConfig(tab.value) : null;
          return (
            <button
              key={tab.value}
              onClick={() => { setTypeFilter(tab.value); setPage(0); }}
              className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
                isActive
                  ? cfg ? `${cfg.tabActive} border-b-2` : 'border-stone-800 text-stone-900'
                  : 'border-transparent text-stone-500 hover:text-stone-700'
              }`}
            >
              {tab.label}
              {tab.value !== 'ALL' && counts[tab.value] > 0 && (
                <span className={`ml-1.5 px-1.5 py-0.5 rounded-full text-[10px] font-bold ${
                  isActive ? 'opacity-60' : 'bg-stone-100 text-stone-500'
                }`}>
                  {counts[tab.value]}
                </span>
              )}
            </button>
          );
        })}

        {!loading && total > 0 && (
          <span className="ml-auto text-xs text-stone-400 pb-2">
            {rangeStart}–{rangeEnd} of {total}
          </span>
        )}
      </div>

      {/* List */}
      {loading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="w-6 h-6 text-stone-400 animate-spin" />
        </div>
      ) : notifications.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <BellOff className="w-10 h-10 text-stone-200 mb-3" />
          <p className="text-sm font-medium text-stone-400">No notifications match your filters</p>
          {hasActiveFilters && (
            <button
              onClick={resetFilters}
              className="mt-2 text-xs text-stone-400 hover:text-stone-600 underline transition"
            >
              Reset filters
            </button>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {notifications.map(n => <NotificationCard key={n.id} n={n} />)}
        </div>
      )}

      {/* Pagination */}
      {!loading && totalPages > 1 && (
        <div className="flex items-center justify-between mt-5 pt-4 border-t border-stone-100">
          <span className="text-xs text-stone-400">Page {page + 1} of {totalPages}</span>
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => setPage(p => p - 1)}
              disabled={page === 0}
              className="px-3 py-1.5 text-xs font-medium rounded-lg border border-stone-200 text-stone-600 hover:bg-stone-50 disabled:opacity-40 disabled:cursor-not-allowed transition"
            >
              Previous
            </button>
            <button
              onClick={() => setPage(p => p + 1)}
              disabled={page >= totalPages - 1}
              className="px-3 py-1.5 text-xs font-medium rounded-lg border border-stone-200 text-stone-600 hover:bg-stone-50 disabled:opacity-40 disabled:cursor-not-allowed transition"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
