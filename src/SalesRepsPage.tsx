import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  Users, Search, Loader2, AlertCircle, CheckCircle2, X, ChevronDown,
  CalendarDays, TrendingUp, TrendingDown, Filter, ArrowLeft,
  UserCheck, UserX, Phone, Mail, Award, Target, Activity, Clock,
  ChevronRight, Layers, BarChart3,
} from 'lucide-react';
import { supabase } from './supabaseClient';
import { useAuth } from './AuthContext';

// ─── Types ───────────────────────────────────────────────────────────────────

interface SalesRepRow {
  id: string;
  rep_code: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  is_active: boolean;
  role: string | null;
  default_event_id: string | null;
  default_event_name: string | null;
  default_event_code: string | null;
}

interface RepMetrics {
  total: number;
  contacted: number;
  samples_sent: number;
  converted: number;
  lost: number;
  requires_review: number;
  active_leads: number;
  closed_leads: number;
  last_lead_captured: string | null;
  last_lead_activity: string | null;
}

interface EventMetrics {
  event_code: string;
  event_name: string | null;
  total: number;
  contacted: number;
  samples_sent: number;
  converted: number;
  lost: number;
}

interface ActiveEvent {
  id: string;
  event_code: string;
  name: string | null;
  status: string;
}

type DateFilter = 'all' | '7days' | '30days' | '90days' | 'custom';
type StatusFilter = 'all' | 'active' | 'inactive';

const DATE_FILTER_LABELS: Record<DateFilter, string> = {
  all: 'All Time',
  '7days': 'Last 7 Days',
  '30days': 'Last 30 Days',
  '90days': 'Last 90 Days',
  custom: 'Custom Range',
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getDateStart(filter: DateFilter, customStart?: string): string | null {
  const now = new Date();
  if (filter === '7days') { const d = new Date(now); d.setDate(d.getDate() - 7); return d.toISOString(); }
  if (filter === '30days') { const d = new Date(now); d.setDate(d.getDate() - 30); return d.toISOString(); }
  if (filter === '90days') { const d = new Date(now); d.setDate(d.getDate() - 90); return d.toISOString(); }
  if (filter === 'custom' && customStart) return new Date(customStart).toISOString();
  return null;
}

function getDateEnd(filter: DateFilter, customEnd?: string): string | null {
  if (filter === 'custom' && customEnd) {
    const d = new Date(customEnd);
    d.setHours(23, 59, 59, 999);
    return d.toISOString();
  }
  return null;
}

function pct(numerator: number, denominator: number): string {
  if (denominator === 0) return '—';
  return `${Math.round((numerator / denominator) * 100)}%`;
}

function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

// ─── Main Page ───────────────────────────────────────────────────────────────

export default function SalesRepsPage() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';

  const [reps, setReps] = useState<SalesRepRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filters
  const [searchInput, setSearchInput] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [eventFilter, setEventFilter] = useState<string>('all');
  const [dateFilter, setDateFilter] = useState<DateFilter>('all');
  const [customStart, setCustomStart] = useState('');
  const [customEnd, setCustomEnd] = useState('');

  // Active events for bulk assignment
  const [activeEvents, setActiveEvents] = useState<ActiveEvent[]>([]);
  const [allEvents, setAllEvents] = useState<ActiveEvent[]>([]);

  // Selection
  const [selectedReps, setSelectedReps] = useState<Set<string>>(new Set());
  const [showBulkModal, setShowBulkModal] = useState(false);
  const [bulkEventId, setBulkEventId] = useState<string>('');
  const [bulkApplying, setBulkApplying] = useState(false);
  const [bulkError, setBulkError] = useState<string | null>(null);

  // Detail view
  const [selectedRepCode, setSelectedRepCode] = useState<string | null>(null);

  // Toast
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Metrics cache
  const [metricsMap, setMetricsMap] = useState<Record<string, RepMetrics>>({});
  const [metricsLoading, setMetricsLoading] = useState(false);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function showToast(msg: string) {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3500);
  }

  // ── Fetch reps ──────────────────────────────────────────────────────────────

  const fetchReps = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { data, error: err } = await supabase
        .from('sales_representatives')
        .select('id, rep_code, name, email, phone, is_active, role, default_event_id')
        .order('name', { ascending: true });

      if (err) throw err;

      // Fetch event names for default_event_id lookups
      const eventIds = (data ?? []).map(r => r.default_event_id).filter(Boolean) as string[];
      let eventMap: Record<string, { name: string; event_code: string }> = {};
      if (eventIds.length > 0) {
        const { data: events } = await supabase
          .from('events')
          .select('id, event_code, name')
          .in('id', eventIds);
        if (events) {
          eventMap = Object.fromEntries(events.map(e => [e.id, { name: e.name ?? '', event_code: e.event_code }]));
        }
      }

      const rows: SalesRepRow[] = (data ?? []).map(r => ({
        id: r.id,
        rep_code: r.rep_code,
        name: r.name,
        email: r.email,
        phone: r.phone,
        is_active: r.is_active ?? true,
        role: r.role,
        default_event_id: r.default_event_id,
        default_event_name: r.default_event_id ? eventMap[r.default_event_id]?.name ?? null : null,
        default_event_code: r.default_event_id ? eventMap[r.default_event_id]?.event_code ?? null : null,
      }));

      setReps(rows);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load sales reps');
    } finally {
      setLoading(false);
    }
  }, []);

  // ── Fetch events ────────────────────────────────────────────────────────────

  const fetchEvents = useCallback(async () => {
    try {
      const { data, error: err } = await supabase
        .from('events')
        .select('id, event_code, name, status')
        .order('name', { ascending: true });

      if (err) throw err;

      setAllEvents(data ?? []);
      setActiveEvents((data ?? []).filter(e => e.status === 'ACTIVE'));
    } catch {
      // non-critical
    }
  }, []);

  // ── Fetch metrics for all reps ───────────────────────────────────────────────

  const fetchAllMetrics = useCallback(async (repCodes: string[]) => {
    if (repCodes.length === 0) return;
    setMetricsLoading(true);
    try {
      const dateStart = getDateStart(dateFilter, customStart);
      const dateEnd = getDateEnd(dateFilter, customEnd);

      let query = supabase
        .from('lead_entries')
        .select('sales_rep_code, lead_status, created_at, updated_at, event_code');

      if (dateStart) query = query.gte('created_at', dateStart);
      if (dateEnd) query = query.lte('created_at', dateEnd);

      const { data, error: err } = await query;

      if (err) throw err;

      const map: Record<string, RepMetrics> = {};
      for (const rc of repCodes) {
        map[rc] = {
          total: 0, contacted: 0, samples_sent: 0, converted: 0, lost: 0,
          requires_review: 0, active_leads: 0, closed_leads: 0,
          last_lead_captured: null, last_lead_activity: null,
        };
      }

      for (const lead of data ?? []) {
        const rc = lead.sales_rep_code;
        if (!rc || !map[rc]) continue;

        const m = map[rc];
        m.total++;

        const status = (lead.lead_status ?? '').toUpperCase();
        if (status === 'CONTACTED') m.contacted++;
        else if (status === 'QUALIFIED') m.samples_sent++;
        else if (status === 'CONVERTED') { m.converted++; m.closed_leads++; }
        else if (status === 'LOST') { m.lost++; m.closed_leads++; }
        else if (status === 'REQUIRES_REVIEW') m.requires_review++;

        // Active = not converted and not lost
        if (status !== 'CONVERTED' && status !== 'LOST') m.active_leads++;

        // Last lead captured
        if (lead.created_at) {
          if (!m.last_lead_captured || lead.created_at > m.last_lead_captured) {
            m.last_lead_captured = lead.created_at;
          }
        }
        // Last lead activity
        if (lead.updated_at) {
          if (!m.last_lead_activity || lead.updated_at > m.last_lead_activity) {
            m.last_lead_activity = lead.updated_at;
          }
        }
      }

      setMetricsMap(map);
    } catch {
      // non-critical — metrics just show as zeros
    } finally {
      setMetricsLoading(false);
    }
  }, [dateFilter, customStart, customEnd]);

  // ── Initial load ─────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!isAdmin) return;
    fetchReps();
    fetchEvents();
  }, [isAdmin, fetchReps, fetchEvents]);

  // ── Fetch metrics when reps or date filter changes ──────────────────────────

  useEffect(() => {
    if (reps.length === 0) return;
    fetchAllMetrics(reps.map(r => r.rep_code));
  }, [reps, fetchAllMetrics]);

  // ── Debounced search ─────────────────────────────────────────────────────────

  function handleSearchChange(value: string) {
    setSearchInput(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setSearchTerm(value), 300);
  }

  // ── Filtered reps ────────────────────────────────────────────────────────────

  const filteredReps = useMemo(() => {
    let result = reps;

    if (searchTerm.trim()) {
      const term = searchTerm.toLowerCase().trim();
      result = result.filter(r =>
        (r.name?.toLowerCase().includes(term) ?? false) ||
        r.rep_code.toLowerCase().includes(term)
      );
    }

    if (statusFilter === 'active') result = result.filter(r => r.is_active);
    else if (statusFilter === 'inactive') result = result.filter(r => !r.is_active);

    if (eventFilter !== 'all') {
      result = result.filter(r => r.default_event_id === eventFilter);
    }

    return result;
  }, [reps, searchTerm, statusFilter, eventFilter]);

  // ── Selection ────────────────────────────────────────────────────────────────

  function toggleRep(repCode: string) {
    setSelectedReps(prev => {
      const next = new Set(prev);
      if (next.has(repCode)) next.delete(repCode);
      else next.add(repCode);
      return next;
    });
  }

  function toggleSelectAll() {
    if (selectedReps.size === filteredReps.length) {
      setSelectedReps(new Set());
    } else {
      setSelectedReps(new Set(filteredReps.map(r => r.rep_code)));
    }
  }

  function clearSelection() {
    setSelectedReps(new Set());
  }

  // ── Bulk default event assignment ───────────────────────────────────────────

  async function applyBulkDefaultEvent() {
    if (!bulkEventId || selectedReps.size === 0) return;
    setBulkApplying(true);
    setBulkError(null);
    try {
      const { data, error: err } = await supabase
        .rpc('set_reps_default_event', {
          p_rep_codes: Array.from(selectedReps),
          p_event_id: bulkEventId,
        });

      if (err) throw err;

      const result = data as { success: boolean; updated_count?: number; error?: string };
      if (!result.success) {
        throw new Error(result.error ?? 'Failed to update default event');
      }

      showToast(`Default event updated for ${result.updated_count} sales rep${result.updated_count !== 1 ? 's' : ''}`);
      setShowBulkModal(false);
      setBulkEventId('');
      clearSelection();
      fetchReps();
    } catch (e) {
      setBulkError(e instanceof Error ? e.message : 'Failed to update default event');
    } finally {
      setBulkApplying(false);
    }
  }

  // ── Render: detail view ─────────────────────────────────────────────────────

  if (selectedRepCode) {
    return (
      <RepDetailView
        repCode={selectedRepCode}
        onBack={() => setSelectedRepCode(null)}
        dateFilter={dateFilter}
        customStart={customStart}
        customEnd={customEnd}
      />
    );
  }

  // ── Render: list view ────────────────────────────────────────────────────────

  if (!isAdmin) {
    return (
      <div className="p-6 max-w-6xl mx-auto">
        <div className="flex items-center gap-3 text-red-700 bg-red-50 border border-red-200 rounded-xl px-4 py-3">
          <AlertCircle className="w-5 h-5" />
          <span className="text-sm font-medium">You do not have permission to access this page.</span>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-stone-900 flex items-center gap-2">
          <Users className="w-6 h-6 text-amber-700" />
          Sales Reps
        </h1>
        <p className="text-sm text-stone-500 mt-1">Manage sales representatives and review performance</p>
      </div>

      {/* Filters bar */}
      <div className="bg-white border border-stone-200 rounded-xl p-4 mb-4 space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          {/* Search */}
          <div className="relative flex-1 min-w-[200px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-stone-400" />
            <input
              type="text"
              value={searchInput}
              onChange={e => handleSearchChange(e.target.value)}
              placeholder="Search by name or rep code…"
              className="w-full pl-9 pr-3 py-2 text-sm border border-stone-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-amber-700/20 focus:border-amber-700"
            />
          </div>

          {/* Status filter */}
          <div className="relative">
            <Filter className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-stone-400 pointer-events-none" />
            <select
              value={statusFilter}
              onChange={e => setStatusFilter(e.target.value as StatusFilter)}
              className="pl-9 pr-8 py-2 text-sm border border-stone-200 rounded-lg appearance-none bg-white focus:outline-none focus:ring-2 focus:ring-amber-700/20 focus:border-amber-700"
            >
              <option value="all">All Reps</option>
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
            </select>
            <ChevronDown className="absolute right-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-stone-400 pointer-events-none" />
          </div>

          {/* Event filter */}
          <div className="relative">
            <CalendarDays className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-stone-400 pointer-events-none" />
            <select
              value={eventFilter}
              onChange={e => setEventFilter(e.target.value)}
              className="pl-9 pr-8 py-2 text-sm border border-stone-200 rounded-lg appearance-none bg-white focus:outline-none focus:ring-2 focus:ring-amber-700/20 focus:border-amber-700"
            >
              <option value="all">All Events</option>
              {allEvents.map(e => (
                <option key={e.id} value={e.id}>{e.name ?? e.event_code}</option>
              ))}
            </select>
            <ChevronDown className="absolute right-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-stone-400 pointer-events-none" />
          </div>

          {/* Date filter */}
          <div className="relative">
            <Clock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-stone-400 pointer-events-none" />
            <select
              value={dateFilter}
              onChange={e => setDateFilter(e.target.value as DateFilter)}
              className="pl-9 pr-8 py-2 text-sm border border-stone-200 rounded-lg appearance-none bg-white focus:outline-none focus:ring-2 focus:ring-amber-700/20 focus:border-amber-700"
            >
              {(Object.keys(DATE_FILTER_LABELS) as DateFilter[]).map(k => (
                <option key={k} value={k}>{DATE_FILTER_LABELS[k]}</option>
              ))}
            </select>
            <ChevronDown className="absolute right-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-stone-400 pointer-events-none" />
          </div>
        </div>

        {/* Custom date range */}
        {dateFilter === 'custom' && (
          <div className="flex flex-wrap items-center gap-3 pl-1">
            <label className="text-xs text-stone-500 font-medium">From:</label>
            <input
              type="date"
              value={customStart}
              onChange={e => setCustomStart(e.target.value)}
              className="px-3 py-1.5 text-sm border border-stone-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-amber-700/20"
            />
            <label className="text-xs text-stone-500 font-medium">To:</label>
            <input
              type="date"
              value={customEnd}
              onChange={e => setCustomEnd(e.target.value)}
              className="px-3 py-1.5 text-sm border border-stone-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-amber-700/20"
            />
          </div>
        )}

        {/* Bulk action bar */}
        {selectedReps.size > 0 && (
          <div className="flex flex-wrap items-center gap-3 pt-2 border-t border-stone-100">
            <span className="text-sm font-medium text-stone-700">
              {selectedReps.size} selected
            </span>
            <button
              onClick={() => setShowBulkModal(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-lg bg-amber-700 text-white hover:bg-amber-800 transition"
            >
              <CalendarDays className="w-4 h-4" />
              Set Default Event
            </button>
            <button
              onClick={clearSelection}
              className="text-sm text-stone-500 hover:text-stone-700 transition"
            >
              Clear selection
            </button>
          </div>
        )}
      </div>

      {/* Error */}
      {error && (
        <div className="flex items-center gap-3 text-red-700 bg-red-50 border border-red-200 rounded-xl px-4 py-3 mb-4">
          <AlertCircle className="w-5 h-5" />
          <span className="text-sm font-medium">{error}</span>
        </div>
      )}

      {/* Table */}
      <div className="bg-white border border-stone-200 rounded-xl overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="w-6 h-6 text-amber-700 animate-spin" />
          </div>
        ) : filteredReps.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-stone-400">
            <Users className="w-10 h-10 mb-2" />
            <p className="text-sm">No sales reps found.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-stone-50 border-b border-stone-200 text-stone-500 text-xs uppercase tracking-wide">
                  <th className="px-4 py-3 text-left w-10">
                    <input
                      type="checkbox"
                      checked={selectedReps.size === filteredReps.length && filteredReps.length > 0}
                      onChange={toggleSelectAll}
                      className="rounded border-stone-300 text-amber-700 focus:ring-amber-700/20"
                    />
                  </th>
                  <th className="px-4 py-3 text-left">Rep</th>
                  <th className="px-4 py-3 text-left">Status</th>
                  <th className="px-4 py-3 text-left">Default Event</th>
                  <th className="px-4 py-3 text-right">Leads</th>
                  <th className="px-4 py-3 text-right">Contacted</th>
                  <th className="px-4 py-3 text-right">Samples</th>
                  <th className="px-4 py-3 text-right">Converted</th>
                  <th className="px-4 py-3 text-right">Lost</th>
                  <th className="px-4 py-3 text-right">Conv. Rate</th>
                  <th className="px-4 py-3 text-right w-10"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-100">
                {filteredReps.map(rep => {
                  const m = metricsMap[rep.rep_code];
                  const metrics = m ?? {
                    total: 0, contacted: 0, samples_sent: 0, converted: 0, lost: 0,
                    requires_review: 0, active_leads: 0, closed_leads: 0,
                    last_lead_captured: null, last_lead_activity: null,
                  };
                  return (
                    <tr
                      key={rep.id}
                      className={`hover:bg-stone-50 transition ${selectedReps.has(rep.rep_code) ? 'bg-amber-50/40' : ''}`}
                    >
                      <td className="px-4 py-3">
                        <input
                          type="checkbox"
                          checked={selectedReps.has(rep.rep_code)}
                          onChange={() => toggleRep(rep.rep_code)}
                          className="rounded border-stone-300 text-amber-700 focus:ring-amber-700/20"
                        />
                      </td>
                      <td className="px-4 py-3">
                        <button
                          onClick={() => setSelectedRepCode(rep.rep_code)}
                          className="text-left group"
                        >
                          <p className="font-medium text-stone-900 group-hover:text-amber-700 transition">
                            {rep.name ?? '—'}
                          </p>
                          <p className="text-xs text-stone-400">{rep.rep_code}</p>
                        </button>
                      </td>
                      <td className="px-4 py-3">
                        {rep.is_active ? (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-green-50 text-green-700 border border-green-200">
                            <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
                            Active
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-stone-100 text-stone-500 border border-stone-200">
                            <span className="w-1.5 h-1.5 rounded-full bg-stone-400" />
                            Inactive
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-stone-600">
                        {rep.default_event_name ? (
                          <span className="text-sm">{rep.default_event_name}</span>
                        ) : (
                          <span className="text-stone-400 text-sm">Not set</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right font-medium text-stone-700">{metrics.total}</td>
                      <td className="px-4 py-3 text-right text-stone-600">{metrics.contacted}</td>
                      <td className="px-4 py-3 text-right text-stone-600">{metrics.samples_sent}</td>
                      <td className="px-4 py-3 text-right text-stone-600">{metrics.converted}</td>
                      <td className="px-4 py-3 text-right text-stone-600">{metrics.lost}</td>
                      <td className="px-4 py-3 text-right">
                        <span className="font-medium text-stone-700">{pct(metrics.converted, metrics.total)}</span>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <button
                          onClick={() => setSelectedRepCode(rep.rep_code)}
                          className="p-1 text-stone-400 hover:text-amber-700 transition"
                          title="View performance"
                        >
                          <ChevronRight className="w-4 h-4" />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Metrics loading indicator */}
      {metricsLoading && (
        <div className="flex items-center justify-center gap-2 py-3 text-sm text-stone-400">
          <Loader2 className="w-4 h-4 animate-spin" />
          Calculating performance metrics…
        </div>
      )}

      {/* Bulk assignment modal */}
      {showBulkModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-stone-900/40 backdrop-blur-sm px-4"
          onClick={() => { if (!bulkApplying) setShowBulkModal(false); }}
        >
          <div
            className="w-full max-w-md bg-white rounded-2xl shadow-2xl border border-stone-200 overflow-hidden animate-in fade-in zoom-in-95 duration-200"
            onClick={e => e.stopPropagation()}
          >
            <div className="px-6 pt-6 pb-2">
              <h2 className="text-lg font-bold text-stone-900">Set Default Event</h2>
              <p className="text-sm text-stone-500 mt-1">
                Select an active event to set as the default for{' '}
                <span className="font-semibold text-stone-700">{selectedReps.size} sales rep{selectedReps.size !== 1 ? 's' : ''}</span>.
              </p>
            </div>

            <div className="px-6 py-4 space-y-3">
              {activeEvents.length === 0 ? (
                <div className="flex items-center gap-2 px-4 py-3 bg-amber-50 border border-amber-200 text-amber-800 text-sm rounded-xl">
                  <AlertCircle className="w-4 h-4 flex-shrink-0" />
                  No active events available. Events must have status "ACTIVE" to be assigned.
                </div>
              ) : (
                <div className="relative">
                  <CalendarDays className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-stone-400 pointer-events-none" />
                  <select
                    value={bulkEventId}
                    onChange={e => setBulkEventId(e.target.value)}
                    disabled={bulkApplying}
                    className="w-full pl-9 pr-8 py-2.5 text-sm border border-stone-200 rounded-lg appearance-none bg-white focus:outline-none focus:ring-2 focus:ring-amber-700/20 focus:border-amber-700 disabled:opacity-50"
                  >
                    <option value="">Select an event…</option>
                    {activeEvents.map(e => (
                      <option key={e.id} value={e.id}>{e.name ?? e.event_code}</option>
                    ))}
                  </select>
                  <ChevronDown className="absolute right-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-stone-400 pointer-events-none" />
                </div>
              )}

              {bulkError && (
                <div className="flex items-center gap-2 px-4 py-3 bg-red-50 border border-red-200 text-red-700 text-sm rounded-xl">
                  <AlertCircle className="w-4 h-4 flex-shrink-0" />
                  {bulkError}
                </div>
              )}

              {bulkEventId && activeEvents.find(e => e.id === bulkEventId) && (
                <div className="flex items-center gap-2 px-4 py-3 bg-stone-50 border border-stone-200 text-stone-700 text-sm rounded-xl">
                  <CheckCircle2 className="w-4 h-4 text-green-600 flex-shrink-0" />
                  Set <span className="font-semibold">{activeEvents.find(e => e.id === bulkEventId)?.name ?? activeEvents.find(e => e.id === bulkEventId)?.event_code}</span> as the default event for {selectedReps.size} sales rep{selectedReps.size !== 1 ? 's' : ''}?
                </div>
              )}
            </div>

            <div className="px-6 py-4 flex items-center justify-end gap-2 border-t border-stone-100">
              <button
                onClick={() => { setShowBulkModal(false); setBulkError(null); }}
                disabled={bulkApplying}
                className="px-4 py-2 text-sm font-medium rounded-lg border border-stone-200 text-stone-600 hover:bg-stone-50 transition disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={applyBulkDefaultEvent}
                disabled={bulkApplying || !bulkEventId || activeEvents.length === 0}
                className="flex items-center gap-1.5 px-4 py-2 text-sm font-semibold rounded-lg bg-amber-700 text-white hover:bg-amber-800 transition disabled:opacity-50"
              >
                {bulkApplying ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
                Set Default Event
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Toast */}
      {toast && (
        <div className="fixed bottom-6 right-6 z-50 flex items-center gap-2 px-4 py-3 bg-stone-900 text-white text-sm font-medium rounded-xl shadow-lg animate-in fade-in slide-in-from-bottom-4 duration-200">
          <CheckCircle2 className="w-4 h-4 text-green-400" />
          {toast}
        </div>
      )}
    </div>
  );
}

// ─── Rep Detail View ──────────────────────────────────────────────────────────

function RepDetailView({
  repCode,
  onBack,
  dateFilter,
  customStart,
  customEnd,
}: {
  repCode: string;
  onBack: () => void;
  dateFilter: DateFilter;
  customStart: string;
  customEnd: string;
}) {
  const [rep, setRep] = useState<SalesRepRow | null>(null);
  const [metrics, setMetrics] = useState<RepMetrics | null>(null);
  const [eventMetrics, setEventMetrics] = useState<EventMetrics[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      try {
        const dateStart = getDateStart(dateFilter, customStart);
        const dateEnd = getDateEnd(dateFilter, customEnd);

        // Fetch rep profile
        const { data: repData } = await supabase
          .from('sales_representatives')
          .select('id, rep_code, name, email, phone, is_active, role, default_event_id')
          .eq('rep_code', repCode)
          .maybeSingle();

        if (cancelled || !repData) return;

        // Fetch default event name
        let defaultEventName: string | null = null;
        let defaultEventCode: string | null = null;
        if (repData.default_event_id) {
          const { data: evt } = await supabase
            .from('events')
            .select('event_code, name')
            .eq('id', repData.default_event_id)
            .maybeSingle();
          if (evt) {
            defaultEventName = evt.name;
            defaultEventCode = evt.event_code;
          }
        }

        if (cancelled) return;

        setRep({
          ...repData,
          is_active: repData.is_active ?? true,
          default_event_name: defaultEventName,
          default_event_code: defaultEventCode,
        });

        // Fetch leads for this rep
        let query = supabase
          .from('lead_entries')
          .select('id, lead_status, created_at, updated_at, event_code');

        if (dateStart) query = query.gte('created_at', dateStart);
        if (dateEnd) query = query.lte('created_at', dateEnd);

        const { data: leads } = await query;

        if (cancelled) return;

        // Calculate aggregate metrics
        const m: RepMetrics = {
          total: 0, contacted: 0, samples_sent: 0, converted: 0, lost: 0,
          requires_review: 0, active_leads: 0, closed_leads: 0,
          last_lead_captured: null, last_lead_activity: null,
        };

        const byEvent: Record<string, EventMetrics> = {};

        for (const lead of leads ?? []) {
          m.total++;

          const status = (lead.lead_status ?? '').toUpperCase();
          if (status === 'CONTACTED') m.contacted++;
          else if (status === 'QUALIFIED') m.samples_sent++;
          else if (status === 'CONVERTED') { m.converted++; m.closed_leads++; }
          else if (status === 'LOST') { m.lost++; m.closed_leads++; }
          else if (status === 'REQUIRES_REVIEW') m.requires_review++;

          if (status !== 'CONVERTED' && status !== 'LOST') m.active_leads++;

          if (lead.created_at) {
            if (!m.last_lead_captured || lead.created_at > m.last_lead_captured) {
              m.last_lead_captured = lead.created_at;
            }
          }
          if (lead.updated_at) {
            if (!m.last_lead_activity || lead.updated_at > m.last_lead_activity) {
              m.last_lead_activity = lead.updated_at;
            }
          }

          // Event breakdown
          const ec = lead.event_code ?? 'unknown';
          if (!byEvent[ec]) {
            byEvent[ec] = {
              event_code: ec,
              event_name: null,
              total: 0, contacted: 0, samples_sent: 0, converted: 0, lost: 0,
            };
          }
          const em = byEvent[ec];
          em.total++;
          if (status === 'CONTACTED') em.contacted++;
          else if (status === 'QUALIFIED') em.samples_sent++;
          else if (status === 'CONVERTED') em.converted++;
          else if (status === 'LOST') em.lost++;
        }

        setMetrics(m);

        // Fetch event names for event metrics
        const eventCodes = Object.keys(byEvent);
        if (eventCodes.length > 0) {
          const { data: events } = await supabase
            .from('events')
            .select('event_code, name')
            .in('event_code', eventCodes);

          if (events) {
            const nameMap = Object.fromEntries(events.map(e => [e.event_code, e.name]));
            for (const ec of eventCodes) {
              byEvent[ec].event_name = nameMap[ec] ?? null;
            }
          }
        }

        if (cancelled) return;

        setEventMetrics(Object.values(byEvent).sort((a, b) => b.total - a.total));
      } catch {
        // non-critical
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => { cancelled = true; };
  }, [repCode, dateFilter, customStart, customEnd]);

  if (loading) {
    return (
      <div className="p-6 max-w-6xl mx-auto flex items-center justify-center py-20">
        <Loader2 className="w-6 h-6 text-amber-700 animate-spin" />
      </div>
    );
  }

  if (!rep || !metrics) {
    return (
      <div className="p-6 max-w-6xl mx-auto">
        <button onClick={onBack} className="flex items-center gap-1.5 text-sm text-stone-500 hover:text-stone-700 transition mb-4">
          <ArrowLeft className="w-4 h-4" /> Back to Sales Reps
        </button>
        <div className="flex flex-col items-center justify-center py-16 text-stone-400">
          <Users className="w-10 h-10 mb-2" />
          <p className="text-sm">Sales rep not found.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-6xl mx-auto">
      {/* Back button */}
      <button onClick={onBack} className="flex items-center gap-1.5 text-sm text-stone-500 hover:text-stone-700 transition mb-4">
        <ArrowLeft className="w-4 h-4" /> Back to Sales Reps
      </button>

      {/* Rep header */}
      <div className="bg-white border border-stone-200 rounded-xl px-6 py-5 mb-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-bold text-stone-900">{rep.name ?? '—'}</h1>
              {rep.is_active ? (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-green-50 text-green-700 border border-green-200">
                  <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
                  Active
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-stone-100 text-stone-500 border border-stone-200">
                  <span className="w-1.5 h-1.5 rounded-full bg-stone-400" />
                  Inactive
                </span>
              )}
            </div>
            <p className="text-sm text-stone-400 mt-1">{rep.rep_code}</p>
            <div className="flex flex-wrap gap-4 mt-2 text-sm text-stone-500">
              {rep.email && (
                <span className="flex items-center gap-1.5">
                  <Mail className="w-3.5 h-3.5" /> {rep.email}
                </span>
              )}
              {rep.phone && (
                <span className="flex items-center gap-1.5">
                  <Phone className="w-3.5 h-3.5" /> {rep.phone}
                </span>
              )}
            </div>
          </div>
          <div className="text-right">
            <p className="text-xs text-stone-400 font-medium">Default Event</p>
            <p className="text-sm text-stone-700 font-medium mt-0.5">
              {rep.default_event_name ?? 'Not set'}
            </p>
            {rep.default_event_code && (
              <p className="text-xs text-stone-400">{rep.default_event_code}</p>
            )}
          </div>
        </div>
      </div>

      {/* Performance overview cards */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3 mb-6">
        <MetricCard icon={<BarChart3 className="w-4 h-4" />} label="Total Leads" value={metrics.total} color="stone" />
        <MetricCard icon={<Phone className="w-4 h-4" />} label="Contacted" value={metrics.contacted} color="blue" />
        <MetricCard icon={<Award className="w-4 h-4" />} label="Samples Sent" value={metrics.samples_sent} color="amber" />
        <MetricCard icon={<TrendingUp className="w-4 h-4" />} label="Converted" value={metrics.converted} color="green" />
        <MetricCard icon={<TrendingDown className="w-4 h-4" />} label="Lost" value={metrics.lost} color="red" />
        <MetricCard icon={<Target className="w-4 h-4" />} label="Conv. Rate" value={pct(metrics.converted, metrics.total)} color="stone" />
      </div>

      {/* Funnel + rates */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
        {/* Funnel */}
        <div className="bg-white border border-stone-200 rounded-xl p-5">
          <h3 className="text-sm font-semibold text-stone-700 mb-4 flex items-center gap-2">
            <Layers className="w-4 h-4 text-amber-700" />
            Performance Funnel
          </h3>
          <FunnelBar label="Total Leads" value={metrics.total} max={metrics.total} color="bg-stone-400" />
          <FunnelBar label="Contacted" value={metrics.contacted} max={metrics.total} color="bg-blue-400" />
          <FunnelBar label="Samples Sent" value={metrics.samples_sent} max={metrics.total} color="bg-amber-500" />
          <FunnelBar label="Converted" value={metrics.converted} max={metrics.total} color="bg-green-500" />
          <div className="mt-4 pt-3 border-t border-stone-100">
            <div className="flex items-center gap-2 text-sm">
              <TrendingDown className="w-4 h-4 text-red-500" />
              <span className="text-stone-600">Lost (separate outcome)</span>
              <span className="ml-auto font-semibold text-stone-700">{metrics.lost}</span>
            </div>
          </div>
        </div>

        {/* Rates */}
        <div className="bg-white border border-stone-200 rounded-xl p-5">
          <h3 className="text-sm font-semibold text-stone-700 mb-4 flex items-center gap-2">
            <TrendingUp className="w-4 h-4 text-amber-700" />
            Conversion Rates
          </h3>
          <RateRow label="Contact Rate" value={pct(metrics.contacted, metrics.total)} />
          <RateRow label="Samples Sent Rate" value={pct(metrics.samples_sent, metrics.total)} />
          <RateRow label="Conversion Rate" value={pct(metrics.converted, metrics.total)} />
          <RateRow label="Loss Rate" value={pct(metrics.lost, metrics.total)} />
          {metrics.requires_review > 0 && (
            <div className="mt-3 pt-3 border-t border-stone-100">
              <div className="flex items-center gap-2 text-sm">
                <AlertCircle className="w-4 h-4 text-amber-600" />
                <span className="text-stone-600">Requires Review</span>
                <span className="ml-auto font-semibold text-stone-700">{metrics.requires_review}</span>
              </div>
              <p className="text-xs text-stone-400 mt-1">
                These leads are pending review and not yet classified in the funnel.
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Lead status summary */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
        <div className="bg-white border border-stone-200 rounded-xl p-5">
          <h3 className="text-sm font-semibold text-stone-700 mb-4 flex items-center gap-2">
            <Activity className="w-4 h-4 text-amber-700" />
            Lead Status Summary
          </h3>
          <div className="space-y-2">
            <SummaryRow label="Active / Open Leads" value={metrics.active_leads} />
            <SummaryRow label="Closed Leads" value={metrics.closed_leads} />
            <SummaryRow label="Last Lead Captured" value={formatDateTime(metrics.last_lead_captured)} />
            <SummaryRow label="Last Lead Activity" value={formatDateTime(metrics.last_lead_activity)} />
          </div>
        </div>

        {/* Event performance table */}
        <div className="bg-white border border-stone-200 rounded-xl p-5">
          <h3 className="text-sm font-semibold text-stone-700 mb-4 flex items-center gap-2">
            <CalendarDays className="w-4 h-4 text-amber-700" />
            Performance by Event
          </h3>
          {eventMetrics.length === 0 ? (
            <p className="text-sm text-stone-400 py-4 text-center">No event data available.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-stone-400 text-xs uppercase tracking-wide border-b border-stone-100">
                    <th className="text-left py-2 pr-2">Event</th>
                    <th className="text-right py-2 px-1">Leads</th>
                    <th className="text-right py-2 px-1">Cont.</th>
                    <th className="text-right py-2 px-1">Samp.</th>
                    <th className="text-right py-2 px-1">Conv.</th>
                    <th className="text-right py-2 pl-1">Lost</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-stone-50">
                  {eventMetrics.map(em => (
                    <tr key={em.event_code} className="hover:bg-stone-50">
                      <td className="py-2 pr-2 text-stone-700 font-medium truncate max-w-[140px]">
                        {em.event_name ?? em.event_code}
                      </td>
                      <td className="text-right py-2 px-1 text-stone-600">{em.total}</td>
                      <td className="text-right py-2 px-1 text-stone-600">{em.contacted}</td>
                      <td className="text-right py-2 px-1 text-stone-600">{em.samples_sent}</td>
                      <td className="text-right py-2 px-1 text-stone-600">{em.converted}</td>
                      <td className="text-right py-2 pl-1 text-stone-600">{em.lost}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Small UI Components ──────────────────────────────────────────────────────

function MetricCard({
  icon, label, value, color,
}: {
  icon: React.ReactNode;
  label: string;
  value: string | number;
  color: 'stone' | 'blue' | 'amber' | 'green' | 'red';
}) {
  const colorMap = {
    stone: 'text-stone-600 bg-stone-50',
    blue: 'text-blue-600 bg-blue-50',
    amber: 'text-amber-700 bg-amber-50',
    green: 'text-green-600 bg-green-50',
    red: 'text-red-600 bg-red-50',
  };
  return (
    <div className="bg-white border border-stone-200 rounded-xl p-4">
      <div className={`inline-flex items-center justify-center w-8 h-8 rounded-lg mb-2 ${colorMap[color]}`}>
        {icon}
      </div>
      <p className="text-2xl font-bold text-stone-900">{value}</p>
      <p className="text-xs text-stone-400 mt-0.5">{label}</p>
    </div>
  );
}

function FunnelBar({
  label, value, max, color,
}: {
  label: string;
  value: number;
  max: number;
  color: string;
}) {
  const width = max > 0 ? Math.max((value / max) * 100, 2) : 0;
  return (
    <div className="mb-3 last:mb-0">
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs text-stone-500 font-medium">{label}</span>
        <span className="text-xs text-stone-700 font-semibold">{value}</span>
      </div>
      <div className="h-6 bg-stone-100 rounded-lg overflow-hidden">
        <div
          className={`h-full ${color} rounded-lg transition-all duration-500`}
          style={{ width: `${width}%` }}
        />
      </div>
    </div>
  );
}

function RateRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between py-2 border-b border-stone-100 last:border-0">
      <span className="text-sm text-stone-600">{label}</span>
      <span className="text-sm font-semibold text-stone-800">{value}</span>
    </div>
  );
}

function SummaryRow({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex items-center justify-between py-2 border-b border-stone-100 last:border-0">
      <span className="text-sm text-stone-600">{label}</span>
      <span className="text-sm font-medium text-stone-800">{value}</span>
    </div>
  );
}
