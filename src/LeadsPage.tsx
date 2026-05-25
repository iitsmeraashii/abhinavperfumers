import { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { supabase } from './supabaseClient';
import { useAuth } from './AuthContext';
import {
  ChevronLeft, ChevronRight, Loader2, Inbox,
  Search, X, ChevronDown, SlidersHorizontal, Download,
} from 'lucide-react';

interface Lead {
  id: string;
  client_name: string;
  company: string;
  phone: string;
  event_code: string;
  sales_rep_code: string;
  lead_type: string;
  lead_temperature: string;
  lead_status: string;
  state: string;
  application: string;
  system_status: string;
  created_at: string;
}

interface Event {
  event_code: string;
  name: string;
}

interface SalesRep {
  rep_code: string;
  name: string;
}

type DateFilter = 'today' | '7days' | '30days' | null;

interface AdvancedFilters {
  leadType: string;
  temperature: string;
  state: string;
  application: string;
  leadStatus: string;
  dateFrom: string;
  dateTo: string;
}

const EMPTY_ADVANCED: AdvancedFilters = {
  leadType: '',
  temperature: '',
  state: '',
  application: '',
  leadStatus: '',
  dateFrom: '',
  dateTo: '',
};

const PAGE_SIZE = 20;

const TEMP_COLORS: Record<string, string> = {
  hot: 'bg-red-100 text-red-700',
  warm: 'bg-amber-100 text-amber-700',
  cold: 'bg-blue-100 text-blue-700',
};

const STATUS_COLORS: Record<string, string> = {
  new:       'bg-stone-100 text-stone-600',
  contacted: 'bg-sky-100 text-sky-700',
  qualified: 'bg-teal-100 text-teal-700',
  lost:      'bg-red-100 text-red-600',
  converted: 'bg-green-100 text-green-700',
};

const STATUS_OPTIONS: { label: string; value: string }[] = [
  { label: 'New',       value: 'NEW' },
  { label: 'Contacted', value: 'CONTACTED' },
  { label: 'Qualified', value: 'QUALIFIED' },
  { label: 'Lost',      value: 'LOST' },
  { label: 'Converted', value: 'CONVERTED' },
];

function badge(value: string | null, colorMap?: Record<string, string>) {
  if (!value) return <span className="text-stone-400">—</span>;
  const key = value.toLowerCase();
  const cls = colorMap?.[key] ?? 'bg-stone-100 text-stone-600';
  return (
    <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${cls}`}>
      {value}
    </span>
  );
}

function getDateFilterStart(filter: DateFilter): string | null {
  if (!filter) return null;
  const now = new Date();
  if (filter === 'today') {
    return new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  }
  if (filter === '7days') {
    const d = new Date(now); d.setDate(d.getDate() - 7); return d.toISOString();
  }
  if (filter === '30days') {
    const d = new Date(now); d.setDate(d.getDate() - 30); return d.toISOString();
  }
  return null;
}

function countActiveAdvanced(f: AdvancedFilters): number {
  return [f.leadType, f.temperature, f.state, f.application, f.dateFrom, f.dateTo]
    .filter(Boolean).length;
}

interface SelectFieldProps {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { label: string; value: string }[];
  placeholder?: string;
}

function SelectField({ label, value, onChange, options, placeholder = 'Any' }: SelectFieldProps) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs font-medium text-stone-500 uppercase tracking-wide">{label}</label>
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        className="w-full px-3 py-2 text-sm border border-stone-200 rounded-lg bg-white text-stone-800 focus:outline-none focus:ring-2 focus:ring-amber-500 focus:border-transparent transition"
      >
        <option value="">{placeholder}</option>
        {options.map(o => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </div>
  );
}

// ── URL helpers ──────────────────────────────────────────────────────────────

function readParams(): {
  page: number;
  search: string;
  dateFilter: DateFilter;
  eventFilter: string;
  repFilter: string;
  adv: AdvancedFilters;
} {
  const p = new URLSearchParams(window.location.search);
  const rawPage = parseInt(p.get('page') ?? '1', 10);
  const page = Number.isFinite(rawPage) && rawPage >= 1 ? rawPage - 1 : 0;
  const dateRaw = p.get('date');
  const dateFilter: DateFilter =
    dateRaw === 'today' || dateRaw === '7days' || dateRaw === '30days' ? dateRaw : null;
  return {
    page,
    search: p.get('search') ?? '',
    dateFilter,
    eventFilter: p.get('event') ?? '',
    repFilter: p.get('rep') ?? '',
    adv: {
      leadType: p.get('leadType') ?? '',
      temperature: p.get('temperature') ?? '',
      state: p.get('state') ?? '',
      application: p.get('application') ?? '',
      leadStatus: p.get('leadStatus') ?? '',
      dateFrom: p.get('dateFrom') ?? '',
      dateTo: p.get('dateTo') ?? '',
    },
  };
}

function buildParams(
  page: number,
  search: string,
  dateFilter: DateFilter,
  eventFilter: string,
  repFilter: string,
  adv: AdvancedFilters,
): URLSearchParams {
  const p = new URLSearchParams(window.location.search);

  // preserve unrelated params (lead, followup, etc.)
  const set = (k: string, v: string) => { if (v) p.set(k, v); else p.delete(k); };

  set('page', page > 0 ? String(page + 1) : '');
  set('search', search);
  set('date', dateFilter ?? '');
  set('event', eventFilter);
  set('rep', repFilter);
  set('leadType', adv.leadType);
  set('temperature', adv.temperature);
  set('state', adv.state);
  set('application', adv.application);
  set('leadStatus', adv.leadStatus);
  set('dateFrom', adv.dateFrom);
  set('dateTo', adv.dateTo);

  return p;
}

function pushParams(params: URLSearchParams) {
  const url = new URL(window.location.href);
  url.search = params.toString();
  window.history.replaceState({}, '', url.toString());
}

// ── Component ────────────────────────────────────────────────────────────────

interface LeadsPageProps {
  onSelectLead: (id: string) => void;
  initialEventCode?: string;
}

export default function LeadsPage({ onSelectLead, initialEventCode }: LeadsPageProps) {
  const { user } = useAuth();

  // Initialise all state from URL on first render (stable — not recomputed on re-renders)
  const init = useMemo(readParams, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Track user identity so the reset effect only fires on actual user switches, not remounts
  const prevUserIdRef = useRef<string | undefined>(undefined);

  // Data
  const [leads, setLeads] = useState<Lead[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(init.page);
  const [total, setTotal] = useState(0);

  // Quick filters
  const [searchInput, setSearchInput] = useState(init.search);
  const [searchTerm, setSearchTerm] = useState(init.search);
  const [dateFilter, setDateFilter] = useState<DateFilter>(init.dateFilter);
  // initialEventCode (from parent Dashboard click) wins over URL param only on first load
  const [eventFilter, setEventFilter] = useState(initialEventCode ?? init.eventFilter);
  const [repFilter, setRepFilter] = useState(init.repFilter);
  const [statusFilter, setStatusFilter] = useState(init.adv.leadStatus);

  // Advanced filters (draft = what's in the panel, applied = active)
  const [panelOpen, setPanelOpen] = useState(false);
  const [draft, setDraft] = useState<AdvancedFilters>(init.adv);
  const [applied, setApplied] = useState<AdvancedFilters>(init.adv);

  // Dynamic options
  const [events, setEvents] = useState<Event[]>([]);
  const [salesReps, setSalesReps] = useState<SalesRep[]>([]);
  const [stateOptions, setStateOptions] = useState<string[]>([]);
  const [applicationOptions, setApplicationOptions] = useState<string[]>([]);

  const [exporting, setExporting] = useState(false);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const eventDropdownRef = useRef<HTMLDivElement>(null);
  const repDropdownRef = useRef<HTMLDivElement>(null);
  const [eventDropdownOpen, setEventDropdownOpen] = useState(false);
  const [repDropdownOpen, setRepDropdownOpen] = useState(false);

  const totalPages = Math.ceil(total / PAGE_SIZE);
  const advancedCount = countActiveAdvanced(applied);

  // Sync state → URL whenever anything changes
  useEffect(() => {
    const advWithStatus = { ...applied, leadStatus: statusFilter || applied.leadStatus };
    pushParams(buildParams(page, searchTerm, dateFilter, eventFilter, repFilter, advWithStatus));
  }, [page, searchTerm, dateFilter, eventFilter, repFilter, applied, statusFilter]);

  // Fetch static option lists
  useEffect(() => {
    supabase.from('events').select('event_code, name').order('start_date', { ascending: false })
      .then(({ data }) => setEvents((data as Event[]) ?? []));

    if (user?.role === 'admin') {
      supabase.from('sales_representatives').select('rep_code, name').eq('login_enabled', true).order('name')
        .then(({ data }) => setSalesReps((data as SalesRep[]) ?? []));
    }

    supabase.from('leads_list_view').select('state').then(({ data }) => {
      const unique = [...new Set((data ?? []).map((r: { state: string }) => r.state).filter(Boolean))].sort();
      setStateOptions(unique as string[]);
    });

    supabase.from('leads_list_view').select('application').then(({ data }) => {
      const all = (data ?? []).flatMap((r: { application: string }) =>
        (r.application ?? '').split(',').map((s: string) => s.trim()).filter(Boolean)
      );
      const deduped = [...new Map(all.map((s: string) => [s.toLowerCase(), s])).values()].sort((a, b) => a.localeCompare(b));
      setApplicationOptions(deduped);
    });
  }, []);

  // Close dropdowns on outside click
  useEffect(() => {
    function handler(e: MouseEvent) {
      if (eventDropdownRef.current && !eventDropdownRef.current.contains(e.target as Node)) {
        setEventDropdownOpen(false);
      }
      if (repDropdownRef.current && !repDropdownRef.current.contains(e.target as Node)) {
        setRepDropdownOpen(false);
      }
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const fetchLeads = useCallback(async (
    pageIndex: number,
    term: string,
    dateFilt: DateFilter,
    eventFilt: string,
    repFilt: string,
    adv: AdvancedFilters,
    statusFilt: string,
  ) => {
    if (!user) return;
    setLoading(true);

    const from = pageIndex * PAGE_SIZE;
    const to = from + PAGE_SIZE - 1;

    let query = supabase
      .from('leads_list_view')
      .select('*', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(from, to);

    if (user.role === 'sales_rep') {
      query = query.eq('sales_rep_code', user.rep_code);
    } else if (repFilt) {
      query = query.eq('sales_rep_code', repFilt);
    }
    if (term.trim()) {
      query = query.ilike('search_text', `%${term.trim()}%`);
    }

    const quickDateStart = getDateFilterStart(dateFilt);
    if (quickDateStart) query = query.gte('created_at', quickDateStart);

    if (eventFilt) query = query.eq('event_code', eventFilt);

    if (adv.leadType) query = query.eq('lead_type', adv.leadType);
    if (adv.temperature) query = query.eq('lead_temperature', adv.temperature);
    if (adv.state) query = query.eq('state', adv.state);
    if (adv.application) query = query.ilike('application', `%${adv.application}%`);
    const effectiveStatus = statusFilt || adv.leadStatus;
    if (effectiveStatus) query = query.eq('lead_status', effectiveStatus);
    if (adv.dateFrom) query = query.gte('created_at', new Date(adv.dateFrom).toISOString());
    if (adv.dateTo) {
      const end = new Date(adv.dateTo);
      end.setHours(23, 59, 59, 999);
      query = query.lte('created_at', end.toISOString());
    }

    const { data, error, count } = await query;

    if (error) {
      console.error('[leads fetch error]', error);
      setLeads([]);
      setTotal(0);
    } else {
      setLeads((data as Lead[]) ?? []);
      setTotal(count ?? 0);
    }
    setLoading(false);
  }, [user]);

  useEffect(() => {
    const userId = user?.rep_code ?? user?.role;
    // Only reset if the user identity actually changed (not on initial mount or remounts)
    if (prevUserIdRef.current === undefined) {
      prevUserIdRef.current = userId;
      return;
    }
    if (prevUserIdRef.current === userId) return;
    prevUserIdRef.current = userId;
    setPage(0);
    setSearchInput('');
    setSearchTerm('');
    setDateFilter(null);
    setEventFilter(initialEventCode ?? '');
    setRepFilter('');
    setStatusFilter('');
    setApplied(EMPTY_ADVANCED);
    setDraft(EMPTY_ADVANCED);
  }, [user]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    fetchLeads(page, searchTerm, dateFilter, eventFilter, repFilter, applied, statusFilter);
  }, [page, searchTerm, dateFilter, eventFilter, repFilter, applied, statusFilter, fetchLeads]);

  async function exportCSV() {
    if (!user) return;
    setExporting(true);

    let query = supabase
      .from('lead_entries')
      .select('id, client_name, designation, company, phones, emails, address, state, notes, lead_type, application, price_range, lead_temperature, quick_keywords, target_market, certification, benchmark, sales_rep_code, event_code, whatsapp_status, system_status, lead_status, created_at, updated_at')
      .order('created_at', { ascending: false });

    if (user.role === 'sales_rep') query = query.eq('sales_rep_code', user.rep_code);
    if (searchTerm.trim()) query = (query as any).ilike('search_text', `%${searchTerm.trim()}%`);

    const quickDateStart = getDateFilterStart(dateFilter);
    if (quickDateStart) query = query.gte('created_at', quickDateStart);
    if (eventFilter) query = query.eq('event_code', eventFilter);
    if (applied.leadType) query = query.eq('lead_type', applied.leadType);
    if (applied.temperature) query = query.eq('lead_temperature', applied.temperature);
    if (applied.state) query = query.eq('state', applied.state);
    if (applied.application) query = query.ilike('application', `%${applied.application}%`);
    if (applied.dateFrom) query = query.gte('created_at', new Date(applied.dateFrom).toISOString());
    if (applied.dateTo) {
      const end = new Date(applied.dateTo);
      end.setHours(23, 59, 59, 999);
      query = query.lte('created_at', end.toISOString());
    }

    const { data, error } = await query;
    setExporting(false);

    if (error || !data || data.length === 0) return;

    const filterLines: string[] = [];
    if (searchTerm.trim()) filterLines.push(`Search: ${searchTerm.trim()}`);
    if (dateFilter) filterLines.push(`Date Filter: ${dateFilter}`);
    if (eventFilter) {
      const ev = events.find(e => e.event_code === eventFilter);
      filterLines.push(`Event: ${ev ? `${ev.name} (${eventFilter})` : eventFilter}`);
    }
    if (applied.leadType) filterLines.push(`Lead Type: ${applied.leadType}`);
    if (applied.temperature) filterLines.push(`Temperature: ${applied.temperature}`);
    if (applied.state) filterLines.push(`State: ${applied.state}`);
    if (applied.application) filterLines.push(`Application: ${applied.application}`);
    if (applied.dateFrom) filterLines.push(`Date From: ${applied.dateFrom}`);
    if (applied.dateTo) filterLines.push(`Date To: ${applied.dateTo}`);
    if (user.role === 'sales_rep') filterLines.push(`Sales Rep: ${user.rep_code}`);

    const now = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
    const commentLines = [
      `# Leads Export`,
      `# Exported At: ${now}`,
      `# Total Records: ${data.length}`,
      `# Applied Filters:`,
      ...(filterLines.length > 0 ? filterLines.map(l => `#   ${l}`) : [`#   None`]),
      `#`,
    ];

    const CSV_COLUMNS: (keyof typeof data[0])[] = [
      'id', 'client_name', 'designation', 'company', 'phones', 'emails',
      'address', 'state', 'lead_type', 'lead_temperature', 'application',
      'price_range', 'quick_keywords', 'target_market', 'certification',
      'benchmark', 'sales_rep_code', 'event_code', 'whatsapp_status',
      'system_status', 'lead_status', 'notes', 'created_at', 'updated_at',
    ];

    function escapeCell(v: unknown): string {
      if (v === null || v === undefined) return '';
      const str = Array.isArray(v) ? v.join('; ') : String(v);
      if (str.includes(',') || str.includes('"') || str.includes('\n')) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    }

    const header = CSV_COLUMNS.join(',');
    const rows = data.map(row =>
      CSV_COLUMNS.map(col => escapeCell((row as Record<string, unknown>)[col])).join(',')
    );

    const csvContent = [
      ...commentLines,
      header,
      ...rows,
    ].join('\n');

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `leads_export_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // Search
  function handleSearchChange(value: string) {
    setSearchInput(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => { setSearchTerm(value); setPage(0); }, 300);
  }
  function clearSearch() {
    setSearchInput('');
    setSearchTerm('');
    setPage(0);
    if (debounceRef.current) clearTimeout(debounceRef.current);
  }

  // Quick filters
  function toggleDateFilter(f: DateFilter) {
    setDateFilter(prev => prev === f ? null : f);
    setPage(0);
  }
  function setEventFilterAndReset(code: string) {
    setEventFilter(prev => prev === code ? '' : code);
    setEventDropdownOpen(false);
    setPage(0);
  }
  function clearQuickFilters() {
    setDateFilter(null);
    setEventFilter('');
    setRepFilter('');
    setStatusFilter('');
    setPage(0);
  }

  // Advanced panel
  function openPanel() {
    setDraft({ ...applied });
    setPanelOpen(true);
  }
  function applyAdvanced() {
    setApplied({ ...draft });
    setPage(0);
    setPanelOpen(false);
  }
  function clearAdvanced() {
    setDraft(EMPTY_ADVANCED);
    setApplied(EMPTY_ADVANCED);
    setPage(0);
    setPanelOpen(false);
  }
  function patchDraft(key: keyof AdvancedFilters, value: string) {
    setDraft(prev => ({ ...prev, [key]: value }));
  }

  const advancedChips: { label: string; key: keyof AdvancedFilters }[] = [
    applied.leadType ? { label: `Type: ${applied.leadType}`, key: 'leadType' } : null,
    applied.temperature ? { label: `Temp: ${applied.temperature}`, key: 'temperature' } : null,
    applied.state ? { label: `State: ${applied.state}`, key: 'state' } : null,
    applied.application ? { label: `App: ${applied.application}`, key: 'application' } : null,
    applied.dateFrom ? { label: `From: ${applied.dateFrom}`, key: 'dateFrom' } : null,
    applied.dateTo ? { label: `To: ${applied.dateTo}`, key: 'dateTo' } : null,
  ].filter(Boolean) as { label: string; key: keyof AdvancedFilters }[];

  function removeAdvancedChip(key: keyof AdvancedFilters) {
    const next = { ...applied, [key]: '' };
    setApplied(next);
    setDraft(next);
    setPage(0);
  }

  function formatDate(iso: string) {
    if (!iso) return '—';
    return new Date(iso).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true });
  }

  // Build the URL for a lead detail link (preserves all current list params)
  function leadHref(id: string): string {
    const p = buildParams(page, searchTerm, dateFilter, eventFilter, repFilter, applied);
    p.set('lead', id);
    // remove page from the lead detail URL — not needed there
    // but we keep all filter params so opening in new tab shows the list in context
    return `?${p.toString()}`;
  }

  const rangeStart = total === 0 ? 0 : page * PAGE_SIZE + 1;
  const rangeEnd = Math.min((page + 1) * PAGE_SIZE, total);
  const hasQuickFilters = dateFilter !== null || eventFilter !== '' || repFilter !== '' || statusFilter !== '';
  const selectedEvent = events.find(e => e.event_code === eventFilter);
  const eventButtonLabel = eventFilter ? (selectedEvent?.name ?? eventFilter) : 'Event';
  const selectedRep = salesReps.find(r => r.rep_code === repFilter);
  const repButtonLabel = repFilter ? (selectedRep?.name ?? repFilter) : 'Sales Rep';

  function getPageNumbers(): (number | '...')[] {
    if (totalPages <= 7) return Array.from({ length: totalPages }, (_, i) => i);
    const pages: (number | '...')[] = [];
    if (page <= 3) {
      pages.push(0, 1, 2, 3, 4, '...', totalPages - 1);
    } else if (page >= totalPages - 4) {
      pages.push(0, '...', totalPages - 5, totalPages - 4, totalPages - 3, totalPages - 2, totalPages - 1);
    } else {
      pages.push(0, '...', page - 1, page, page + 1, '...', totalPages - 1);
    }
    return pages;
  }

  const dateButtons: { label: string; value: DateFilter }[] = [
    { label: 'Today', value: 'today' },
    { label: 'Last 7 Days', value: '7days' },
    { label: 'Last 30 Days', value: '30days' },
  ];

  return (
    <div className="p-6">
      {/* Header */}
      <div className="flex flex-col gap-4 mb-5 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-xl font-semibold text-stone-800">Leads</h2>
          <p className="text-sm text-stone-500 mt-0.5">
            {user?.role === 'admin' ? 'All leads' : `Leads assigned to ${user?.rep_code}`}
          </p>
        </div>

        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-stone-400 pointer-events-none" />
          <input
            type="text"
            value={searchInput}
            onChange={e => handleSearchChange(e.target.value)}
            placeholder="Search by name, company, phone, email"
            className="pl-9 pr-8 py-2 text-sm border border-stone-200 rounded-lg bg-white text-stone-800 placeholder-stone-400 focus:outline-none focus:ring-2 focus:ring-amber-500 focus:border-transparent w-72 transition"
          />
          {searchInput && (
            <button onClick={clearSearch} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-stone-400 hover:text-stone-600 transition">
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-2 mb-3">
        {dateButtons.map(btn => (
          <button
            key={btn.value}
            onClick={() => toggleDateFilter(btn.value)}
            className={`px-3 py-1.5 text-xs font-medium rounded-lg border transition ${
              dateFilter === btn.value
                ? 'bg-amber-700 border-amber-700 text-white'
                : 'border-stone-200 bg-white text-stone-600 hover:border-stone-300 hover:bg-stone-50'
            }`}
          >
            {btn.label}
          </button>
        ))}

        {/* Status quick-filter pills */}
        {STATUS_OPTIONS.map(opt => (
          <button
            key={opt.value}
            onClick={() => { setStatusFilter(prev => prev === opt.value ? '' : opt.value); setPage(0); }}
            className={`px-3 py-1.5 text-xs font-medium rounded-lg border transition ${
              statusFilter === opt.value
                ? 'bg-amber-700 border-amber-700 text-white'
                : 'border-stone-200 bg-white text-stone-600 hover:border-stone-300 hover:bg-stone-50'
            }`}
          >
            {opt.label}
          </button>
        ))}

        {/* Event dropdown */}
        <div className="relative" ref={eventDropdownRef}>
          <button
            onClick={() => setEventDropdownOpen(o => !o)}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border transition ${
              eventFilter
                ? 'bg-amber-700 border-amber-700 text-white'
                : 'border-stone-200 bg-white text-stone-600 hover:border-stone-300 hover:bg-stone-50'
            }`}
          >
            <span className="max-w-[140px] truncate">{eventButtonLabel}</span>
            {eventFilter
              ? <X className="w-3 h-3 flex-shrink-0" onClick={e => { e.stopPropagation(); setEventFilterAndReset(''); }} />
              : <ChevronDown className="w-3 h-3 flex-shrink-0" />
            }
          </button>
          {eventDropdownOpen && (
            <div className="absolute z-20 mt-1 left-0 bg-white border border-stone-200 rounded-xl shadow-lg min-w-[200px] max-h-60 overflow-y-auto py-1">
              {events.length === 0
                ? <p className="px-3 py-2 text-xs text-stone-400">No events found</p>
                : events.map(ev => (
                  <button
                    key={ev.event_code}
                    onClick={() => setEventFilterAndReset(ev.event_code)}
                    className={`w-full text-left px-3 py-2 text-xs transition ${
                      eventFilter === ev.event_code ? 'bg-amber-50 text-amber-700 font-medium' : 'text-stone-700 hover:bg-stone-50'
                    }`}
                  >
                    <span className="font-medium block truncate">{ev.name ?? ev.event_code}</span>
                    <span className="text-stone-400 font-mono">{ev.event_code}</span>
                  </button>
                ))
              }
            </div>
          )}
        </div>

        {/* Sales Rep dropdown — admin only */}
        {user?.role === 'admin' && (
          <div className="relative" ref={repDropdownRef}>
            <button
              onClick={() => setRepDropdownOpen(o => !o)}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border transition ${
                repFilter
                  ? 'bg-amber-700 border-amber-700 text-white'
                  : 'border-stone-200 bg-white text-stone-600 hover:border-stone-300 hover:bg-stone-50'
              }`}
            >
              <span className="max-w-[140px] truncate">{repButtonLabel}</span>
              {repFilter
                ? <X className="w-3 h-3 flex-shrink-0" onClick={e => { e.stopPropagation(); setRepFilter(''); setRepDropdownOpen(false); setPage(0); }} />
                : <ChevronDown className="w-3 h-3 flex-shrink-0" />
              }
            </button>
            {repDropdownOpen && (
              <div className="absolute z-20 mt-1 left-0 bg-white border border-stone-200 rounded-xl shadow-lg min-w-[200px] max-h-60 overflow-y-auto py-1">
                {salesReps.length === 0
                  ? <p className="px-3 py-2 text-xs text-stone-400">No reps found</p>
                  : salesReps.map(rep => (
                    <button
                      key={rep.rep_code}
                      onClick={() => { setRepFilter(prev => prev === rep.rep_code ? '' : rep.rep_code); setRepDropdownOpen(false); setPage(0); }}
                      className={`w-full text-left px-3 py-2 text-xs transition ${
                        repFilter === rep.rep_code ? 'bg-amber-50 text-amber-700 font-medium' : 'text-stone-700 hover:bg-stone-50'
                      }`}
                    >
                      <span className="font-medium block truncate">{rep.name}</span>
                      <span className="text-stone-400 font-mono">{rep.rep_code}</span>
                    </button>
                  ))
                }
              </div>
            )}
          </div>
        )}

        {/* More Filters */}
        <button
          onClick={openPanel}
          className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border transition ${
            advancedCount > 0
              ? 'bg-amber-700 border-amber-700 text-white'
              : 'border-stone-200 bg-white text-stone-600 hover:border-stone-300 hover:bg-stone-50'
          }`}
        >
          <SlidersHorizontal className="w-3.5 h-3.5" />
          More Filters
          {advancedCount > 0 && (
            <span className="bg-white text-amber-700 rounded-full w-4 h-4 text-[10px] font-bold flex items-center justify-center leading-none">
              {advancedCount}
            </span>
          )}
        </button>

        {hasQuickFilters && (
          <button onClick={clearQuickFilters} className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-stone-500 hover:text-red-600 transition">
            <X className="w-3 h-3" /> Clear
          </button>
        )}

        <div className="ml-auto flex items-center gap-3">
          {!loading && total > 0 && (
            <span className="text-sm text-stone-500 whitespace-nowrap">
              Showing <span className="font-medium text-stone-700">{rangeStart}–{rangeEnd}</span> of{' '}
              <span className="font-medium text-stone-700">{total}</span> leads
            </span>
          )}
          {total > 0 && (
            <button
              onClick={exportCSV}
              disabled={exporting}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-stone-200 bg-white text-stone-600 hover:border-stone-300 hover:bg-stone-50 disabled:opacity-50 disabled:cursor-not-allowed transition"
            >
              {exporting
                ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                : <Download className="w-3.5 h-3.5" />
              }
              {exporting ? 'Exporting…' : 'Export CSV'}
            </button>
          )}
        </div>
      </div>

      {/* Advanced filter chips */}
      {advancedChips.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 mb-4">
          {advancedChips.map(chip => (
            <span
              key={chip.key}
              className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium bg-amber-50 text-amber-700 border border-amber-200 rounded-full"
            >
              {chip.label}
              <button onClick={() => removeAdvancedChip(chip.key)} className="hover:text-amber-900 transition">
                <X className="w-3 h-3" />
              </button>
            </span>
          ))}
          <button
            onClick={clearAdvanced}
            className="text-xs text-stone-400 hover:text-red-500 transition ml-1"
          >
            Clear all
          </button>
        </div>
      )}

      {/* Table */}
      <div className="bg-white border border-stone-200 rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-stone-100 bg-stone-50">
                <th className="text-left px-4 py-3 font-medium text-stone-500">Client</th>
                <th className="text-left px-4 py-3 font-medium text-stone-500">Company</th>
                <th className="text-left px-4 py-3 font-medium text-stone-500">Phone</th>
                <th className="text-left px-4 py-3 font-medium text-stone-500">Event</th>
                <th className="text-left px-4 py-3 font-medium text-stone-500">Rep</th>
                <th className="text-left px-4 py-3 font-medium text-stone-500">Type</th>
                <th className="text-left px-4 py-3 font-medium text-stone-500">Temp</th>
                <th className="text-left px-4 py-3 font-medium text-stone-500">Status</th>
                <th className="text-left px-4 py-3 font-medium text-stone-500">Created</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={9} className="py-16 text-center">
                    <Loader2 className="w-5 h-5 text-amber-600 animate-spin mx-auto" />
                  </td>
                </tr>
              ) : leads.length === 0 ? (
                <tr>
                  <td colSpan={9} className="py-16 text-center">
                    <Inbox className="w-8 h-8 text-stone-300 mx-auto mb-2" />
                    <p className="text-stone-400 text-sm">No leads found</p>
                  </td>
                </tr>
              ) : (
                leads.map(lead => {
                  const rowBg =
                    lead.system_status === 'INVALID_LEAD'    ? 'bg-red-50 hover:bg-red-100' :
                    lead.system_status === 'WHATSAPP_FAILED' ? 'bg-yellow-50 hover:bg-yellow-100' :
                    lead.system_status === 'WHATSAPP_SENT'   ? 'bg-green-50 hover:bg-green-100' :
                    'bg-white hover:bg-stone-50';
                  return (
                    <tr
                      key={lead.id}
                      className={`border-b border-stone-100 last:border-0 transition-colors ${rowBg}`}
                    >
                      {/* Entire row is wrapped in an anchor for right-click / cmd-click support.
                          We intercept left-click to use the SPA callback instead of navigation. */}
                      <td className="px-4 py-3 font-medium text-stone-800">
                        <a
                          href={leadHref(lead.id)}
                          className="block -mx-4 -my-3 px-4 py-3 cursor-pointer"
                          onClick={e => { e.preventDefault(); onSelectLead(lead.id); }}
                        >
                          {lead.client_name || '—'}
                        </a>
                      </td>
                      <td className="px-4 py-3 text-stone-600 cursor-pointer" onClick={() => onSelectLead(lead.id)}>{lead.company || '—'}</td>
                      <td className="px-4 py-3 text-stone-600 cursor-pointer" onClick={() => onSelectLead(lead.id)}>{lead.phone || '—'}</td>
                      <td className="px-4 py-3 text-stone-600 cursor-pointer" onClick={() => onSelectLead(lead.id)}>{lead.event_code || '—'}</td>
                      <td className="px-4 py-3 text-stone-600 cursor-pointer" onClick={() => onSelectLead(lead.id)}>{lead.sales_rep_code || '—'}</td>
                      <td className="px-4 py-3 cursor-pointer" onClick={() => onSelectLead(lead.id)}>{badge(lead.lead_type)}</td>
                      <td className="px-4 py-3 cursor-pointer" onClick={() => onSelectLead(lead.id)}>{badge(lead.lead_temperature, TEMP_COLORS)}</td>
                      <td className="px-4 py-3 cursor-pointer" onClick={() => onSelectLead(lead.id)}>{badge(lead.lead_status, STATUS_COLORS)}</td>
                      <td className="px-4 py-3 text-stone-500 cursor-pointer" onClick={() => onSelectLead(lead.id)}>{formatDate(lead.created_at)}</td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {!loading && totalPages > 1 && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-stone-100 bg-stone-50 flex-wrap gap-2">
            <span className="text-xs text-stone-500">
              Page <span className="font-medium text-stone-700">{page + 1}</span> of{' '}
              <span className="font-medium text-stone-700">{totalPages}</span>
            </span>
            <div className="flex items-center gap-1">
              <button
                onClick={() => setPage(p => p - 1)}
                disabled={page === 0}
                className="flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium rounded-lg border border-stone-200 text-stone-600 hover:bg-white disabled:opacity-40 disabled:cursor-not-allowed transition"
              >
                <ChevronLeft className="w-3.5 h-3.5" /> Previous
              </button>
              {getPageNumbers().map((p, i) =>
                p === '...' ? (
                  <span key={`e-${i}`} className="px-2 text-stone-400 text-xs select-none">…</span>
                ) : (
                  <button
                    key={p}
                    onClick={() => setPage(p)}
                    className={`w-8 h-8 text-xs font-medium rounded-lg border transition ${
                      p === page ? 'bg-amber-700 border-amber-700 text-white' : 'border-stone-200 text-stone-600 hover:bg-white'
                    }`}
                  >
                    {p + 1}
                  </button>
                )
              )}
              <button
                onClick={() => setPage(p => p + 1)}
                disabled={page >= totalPages - 1}
                className="flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium rounded-lg border border-stone-200 text-stone-600 hover:bg-white disabled:opacity-40 disabled:cursor-not-allowed transition"
              >
                Next <ChevronRight className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Advanced Filters Panel */}
      {panelOpen && (
        <>
          <div
            className="fixed inset-0 bg-black/20 z-30 backdrop-blur-[1px]"
            onClick={() => setPanelOpen(false)}
          />

          <div className="fixed right-0 top-0 h-full w-80 bg-white shadow-2xl z-40 flex flex-col">
            <div className="flex items-center justify-between px-5 py-4 border-b border-stone-100">
              <div className="flex items-center gap-2">
                <SlidersHorizontal className="w-4 h-4 text-stone-600" />
                <span className="text-sm font-semibold text-stone-800">More Filters</span>
              </div>
              <button
                onClick={() => setPanelOpen(false)}
                className="p-1 rounded-lg text-stone-400 hover:text-stone-600 hover:bg-stone-100 transition"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto px-5 py-5 flex flex-col gap-5">
              <SelectField
                label="Lead Type"
                value={draft.leadType}
                onChange={v => patchDraft('leadType', v)}
                options={[
                  { label: 'New', value: 'NEW' },
                  { label: 'Existing', value: 'EXISTING' },
                ]}
              />

              <SelectField
                label="Temperature"
                value={draft.temperature}
                onChange={v => patchDraft('temperature', v)}
                options={[
                  { label: 'Hot', value: 'Hot' },
                  { label: 'Warm', value: 'Warm' },
                  { label: 'Cold', value: 'Cold' },
                ]}
              />

              <SelectField
                label="State"
                value={draft.state}
                onChange={v => patchDraft('state', v)}
                options={stateOptions.map(s => ({ label: s, value: s }))}
              />

              <SelectField
                label="Application"
                value={draft.application}
                onChange={v => patchDraft('application', v)}
                options={applicationOptions.map(a => ({ label: a, value: a }))}
              />

              <div className="flex flex-col gap-3">
                <span className="text-xs font-medium text-stone-500 uppercase tracking-wide">Custom Date Range</span>
                <div className="flex flex-col gap-1">
                  <label className="text-xs text-stone-500">Start Date</label>
                  <input
                    type="date"
                    value={draft.dateFrom}
                    onChange={e => patchDraft('dateFrom', e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-stone-200 rounded-lg bg-white text-stone-800 focus:outline-none focus:ring-2 focus:ring-amber-500 focus:border-transparent transition"
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <label className="text-xs text-stone-500">End Date</label>
                  <input
                    type="date"
                    value={draft.dateTo}
                    onChange={e => patchDraft('dateTo', e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-stone-200 rounded-lg bg-white text-stone-800 focus:outline-none focus:ring-2 focus:ring-amber-500 focus:border-transparent transition"
                  />
                </div>
              </div>
            </div>

            <div className="px-5 py-4 border-t border-stone-100 flex gap-3">
              <button
                onClick={clearAdvanced}
                className="flex-1 px-4 py-2 text-sm font-medium rounded-lg border border-stone-200 text-stone-600 hover:bg-stone-50 transition"
              >
                Clear Filters
              </button>
              <button
                onClick={applyAdvanced}
                className="flex-1 px-4 py-2 text-sm font-medium rounded-lg bg-amber-700 text-white hover:bg-amber-800 transition"
              >
                Apply Filters
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
