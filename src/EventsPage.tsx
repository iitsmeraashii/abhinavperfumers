import { useEffect, useState, useCallback, useRef } from 'react';
import { supabase } from './supabaseClient';
import {
  CalendarDays, MapPin, Plus, Loader2, AlertCircle, CheckCircle2,
  X, Save, FileText, Lock, Info, Trash2, Users, TrendingUp,
  ThermometerSun, BarChart2, ArrowRight, Globe, ChevronLeft,
} from 'lucide-react';
import { formatDateShort } from './utils/dateFormat';

function useIsMobile() {
  const [isMobile, setIsMobile] = useState(() => window.innerWidth < 768);
  useEffect(() => {
    const handler = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener('resize', handler);
    return () => window.removeEventListener('resize', handler);
  }, []);
  return isMobile;
}

// ─── Types ────────────────────────────────────────────────────────────────────

type EventStatus = 'DRAFT' | 'UPCOMING' | 'ACTIVE' | 'COMPLETED' | 'ARCHIVED';
type EditMode = 'full' | 'template-only' | 'readonly';

interface Event {
  id: string;
  event_code: string;
  name: string | null;
  location: string | null;
  description: string | null;
  start_date: string | null;
  end_date: string | null;
  message_template_id: string | null;
  status: EventStatus;
  updated_at: string;
}

interface Template {
  id: string;
  name: string;
}

interface FormState {
  event_code: string;
  name: string;
  location: string;
  description: string;
  start_date: string;
  end_date: string;
  message_template_id: string;
  status: EventStatus;
}

interface Metrics {
  total: number;
  contacted: number;
  converted: number;
  lost: number;
  invalid: number;
  hot: number;
  warm: number;
  cold: number;
}

interface RepRow {
  rep_code: string;
  rep_name: string;
  total: number;
  contacted: number;
  converted: number;
  lost: number;
}

interface StateRow { state: string; count: number; }
interface DayRow { day: string; count: number; }

interface EventListItem extends Event { lead_count: number; }

// ─── Constants ────────────────────────────────────────────────────────────────

const ALL_STATUSES: EventStatus[] = ['DRAFT', 'UPCOMING', 'ACTIVE', 'COMPLETED', 'ARCHIVED'];

const EMPTY_FORM: FormState = {
  event_code: '', name: '', location: '', description: '',
  start_date: '', end_date: '', message_template_id: '', status: 'DRAFT',
};

const STATUS_STYLES: Record<EventStatus, { badge: string; tab: string; dot: string }> = {
  DRAFT:     { badge: 'bg-stone-100 text-stone-600',   tab: 'text-stone-600',  dot: 'bg-stone-400' },
  UPCOMING:  { badge: 'bg-blue-100 text-blue-700',     tab: 'text-blue-600',   dot: 'bg-blue-500' },
  ACTIVE:      { badge: 'bg-yellow-100 text-yellow-700', tab: 'text-yellow-600', dot: 'bg-yellow-500' },
  COMPLETED: { badge: 'bg-green-100 text-green-700',   tab: 'text-green-600',  dot: 'bg-green-500' },
  ARCHIVED:  { badge: 'bg-stone-100 text-stone-400',   tab: 'text-stone-400',  dot: 'bg-stone-300' },
};

const INPUT_BASE = 'w-full text-sm px-3 py-2 rounded-lg border bg-white outline-none transition';
const INPUT_ON   = 'border-stone-200 focus:border-stone-500 text-stone-800';
const INPUT_OFF  = 'border-stone-100 bg-stone-50 text-stone-400 cursor-not-allowed';

function getEditMode(status: EventStatus): EditMode {
  if (status === 'COMPLETED' || status === 'ARCHIVED') return 'readonly';
  if (status === 'ACTIVE') return 'template-only';
  return 'full';
}

function eventToForm(e: Event): FormState {
  return {
    event_code: e.event_code ?? '',
    name: e.name ?? '',
    location: e.location ?? '',
    description: e.description ?? '',
    start_date: e.start_date ?? '',
    end_date: e.end_date ?? '',
    message_template_id: e.message_template_id ?? '',
    status: e.status ?? 'DRAFT',
  };
}

function formChanged(a: FormState, b: FormState) {
  return JSON.stringify(a) !== JSON.stringify(b);
}

function fmt(d: string | null) {
  return formatDateShort(d) ?? '—';
}

function pct(n: number, total: number) {
  if (!total) return '0%';
  return `${Math.round((n / total) * 100)}%`;
}

// ─── Small UI components ───────────────────────────────────────────────────────

function StatusBadge({ status }: { status: EventStatus }) {
  const s = STATUS_STYLES[status] ?? STATUS_STYLES.DRAFT;
  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-semibold ${s.badge}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${s.dot}`} />
      {status}
    </span>
  );
}

function Toast({ message, type, onClose }: { message: string; type: 'success' | 'error'; onClose: () => void }) {
  useEffect(() => { const t = setTimeout(onClose, 3500); return () => clearTimeout(t); }, [onClose]);
  return (
    <div className={`fixed bottom-6 right-6 z-50 flex items-center gap-3 px-4 py-3 rounded-xl shadow-lg border text-sm font-medium
      ${type === 'success' ? 'bg-green-50 border-green-200 text-green-800' : 'bg-red-50 border-red-200 text-red-800'}`}>
      {type === 'success' ? <CheckCircle2 className="w-4 h-4 flex-shrink-0" /> : <AlertCircle className="w-4 h-4 flex-shrink-0" />}
      {message}
      <button onClick={onClose} className="ml-1 opacity-60 hover:opacity-100"><X className="w-3.5 h-3.5" /></button>
    </div>
  );
}

function ConfirmDialog({ title, body, confirmLabel, confirmClass, onConfirm, onCancel }: {
  title: string; body: string; confirmLabel: string; confirmClass: string;
  onConfirm: () => void; onCancel: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm">
      <div className="bg-white rounded-2xl border border-stone-200 shadow-xl p-6 max-w-sm w-full mx-4">
        <div className="flex items-start gap-3 mb-5">
          <AlertCircle className="w-5 h-5 text-red-500 flex-shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-semibold text-stone-800 mb-1">{title}</p>
            <p className="text-sm text-stone-500 leading-relaxed">{body}</p>
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <button onClick={onCancel} className="px-4 py-2 text-sm font-medium text-stone-600 border border-stone-200 rounded-lg hover:bg-stone-50 transition">Cancel</button>
          <button onClick={onConfirm} className={`px-4 py-2 text-sm font-medium text-white rounded-lg transition ${confirmClass}`}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}

function SectionCard({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-xl border border-stone-200 overflow-hidden">
      <div className="px-5 py-3.5 border-b border-stone-100 flex items-center gap-2.5">
        <span className="text-stone-400">{icon}</span>
        <span className="text-sm font-semibold text-stone-700">{title}</span>
      </div>
      <div className="px-5 py-4">{children}</div>
    </div>
  );
}

function Field({ label, required, error, children }: {
  label: string; required?: boolean; error?: string; children: React.ReactNode;
}) {
  return (
    <div>
      <label className="block text-xs font-medium text-stone-500 mb-1.5">
        {label}{required && <span className="text-red-400 ml-0.5">*</span>}
      </label>
      {children}
      {error && <p className="text-xs text-red-500 mt-1">{error}</p>}
    </div>
  );
}

// ─── Main Page ─────────────────────────────────────────────────────────────────

interface EventsPageProps {
  onViewLeads?: (eventCode: string) => void;
}

export default function EventsPage({ onViewLeads }: EventsPageProps) {
  const isMobile = useIsMobile();
  const [mobileShowDetail, setMobileShowDetail] = useState(false);

  const [activeTab, setActiveTab] = useState<EventStatus>('ACTIVE');
  const [events, setEvents] = useState<EventListItem[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loadingList, setLoadingList] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [savedForm, setSavedForm] = useState<FormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [errors, setErrors] = useState<Partial<Record<keyof FormState, string>>>({});
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [unsavedTarget, setUnsavedTarget] = useState<'new' | string | null>(null);

  // Analytics
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [repRows, setRepRows] = useState<RepRow[]>([]);
  const [stateRows, setStateRows] = useState<StateRow[]>([]);
  const [dayRows, setDayRows] = useState<DayRow[]>([]);
  const [loadingMetrics, setLoadingMetrics] = useState(false);

  const listRef = useRef<HTMLUListElement>(null);

  const showToast = useCallback((message: string, type: 'success' | 'error') => {
    setToast({ message, type });
  }, []);

  // ── Fetch ──────────────────────────────────────────────────────────────────

  async function fetchEvents(tab: EventStatus) {
    setLoadingList(true);
    const { data } = await supabase
      .from('event_list_view')
      .select('id, event_code, name, location, start_date, end_date, status, lead_count')
      .eq('status', tab)
      .order('start_date', { ascending: false });
    setEvents((data ?? []) as EventListItem[]);
    setLoadingList(false);
  }

  async function fetchTemplates() {
    const { data } = await supabase
      .from('message_templates')
      .select('id, name')
      .eq('status', 'ACTIVE')
      .order('name');
    setTemplates((data ?? []) as Template[]);
  }

  async function fetchAnalytics(eventCode: string) {
    setLoadingMetrics(true);
    setMetrics(null);
    setRepRows([]);
    setStateRows([]);
    setDayRows([]);

    const [metricsRes, repRes, stateRes, dayRes] = await Promise.all([
      supabase
        .from('event_metrics_view')
        .select('total_leads, contacted_leads, converted_leads, lost_leads, invalid_leads, hot_leads, warm_leads, cold_leads')
        .eq('event_code', eventCode)
        .maybeSingle(),
      supabase
        .from('event_sales_performance_view')
        .select('sales_rep_code, sales_rep_name, total_leads, contacted, converted, lost')
        .eq('event_code', eventCode)
        .order('total_leads', { ascending: false }),
      supabase
        .from('event_state_distribution_view')
        .select('state, lead_count')
        .eq('event_code', eventCode)
        .order('lead_count', { ascending: false }),
      supabase
        .from('event_daily_trend_view')
        .select('lead_date, lead_count')
        .eq('event_code', eventCode)
        .order('lead_date', { ascending: true }),
    ]);

    if (metricsRes.data) {
      const r = metricsRes.data;
      setMetrics({
        total: Number(r.total_leads),
        contacted: Number(r.contacted_leads),
        converted: Number(r.converted_leads),
        lost: Number(r.lost_leads),
        invalid: Number(r.invalid_leads),
        hot: Number(r.hot_leads),
        warm: Number(r.warm_leads),
        cold: Number(r.cold_leads),
      });
    }

    setRepRows(
      (repRes.data ?? []).map(r => ({
        rep_code: r.sales_rep_code,
        rep_name: r.sales_rep_name ?? r.sales_rep_code,
        total: Number(r.total_leads),
        contacted: Number(r.contacted),
        converted: Number(r.converted),
        lost: Number(r.lost),
      }))
    );

    setStateRows(
      (stateRes.data ?? []).map(r => ({ state: r.state, count: Number(r.lead_count) }))
    );

    setDayRows(
      (dayRes.data ?? []).map(r => ({ day: r.lead_date as string, count: Number(r.lead_count) }))
    );

    setLoadingMetrics(false);
  }

  // ── Effects ────────────────────────────────────────────────────────────────

  useEffect(() => { fetchEvents(activeTab); fetchTemplates(); }, []);

  useEffect(() => {
    fetchEvents(activeTab);
    setSelectedId(null);
    setIsNew(false);
    setForm(EMPTY_FORM);
    setSavedForm(EMPTY_FORM);
    setErrors({});
    setMetrics(null);
    setRepRows([]);
    setStateRows([]);
    setDayRows([]);
    setMobileShowDetail(false);
  }, [activeTab]);

  const editMode: EditMode = getEditMode(form.status);
  const isDirty = formChanged(form, savedForm);

  // ── Selection helpers ─────────────────────────────────────────────────────

  async function loadEvent(ev: EventListItem | Event) {
    setSelectedId(ev.id);
    setIsNew(false);
    setErrors({});
    setMobileShowDetail(true);
    // Fetch full event record (list view omits description, message_template_id)
    const { data: full } = await supabase
      .from('events')
      .select('id, event_code, name, location, description, start_date, end_date, message_template_id, status, updated_at')
      .eq('id', ev.id)
      .maybeSingle();
    const f = eventToForm((full ?? ev) as Event);
    setForm(f);
    setSavedForm(f);
    fetchAnalytics(ev.event_code);
  }

  function startNew() {
    setSelectedId(null);
    setForm({ ...EMPTY_FORM, status: activeTab === 'DRAFT' ? 'DRAFT' : 'DRAFT' });
    setSavedForm(EMPTY_FORM);
    setIsNew(true);
    setErrors({});
    setMetrics(null);
    setRepRows([]);
    setStateRows([]);
    setDayRows([]);
    setMobileShowDetail(true);
  }

  function guardUnsaved(proceed: () => void, target: 'new' | string) {
    if (isDirty) { setUnsavedTarget(target); return; }
    proceed();
  }

  function handleUnsavedDiscard() {
    const target = unsavedTarget;
    setUnsavedTarget(null);
    if (target === 'new') { startNew(); return; }
    if (target) { const ev = events.find(e => e.id === target); if (ev) loadEvent(ev); }
  }

  function handleTabChange(tab: EventStatus) {
    if (isDirty) { setUnsavedTarget(`__tab__${tab}` as any); return; }
    setActiveTab(tab);
  }

  // Extend discard to handle tab switches
  function handleUnsavedDiscardExtended() {
    const target = unsavedTarget as string;
    setUnsavedTarget(null);
    if (target?.startsWith('__tab__')) {
      const tab = target.replace('__tab__', '') as EventStatus;
      setActiveTab(tab);
    } else if (target === 'new') {
      startNew();
    } else if (target) {
      const ev = events.find(e => e.id === target);
      if (ev) loadEvent(ev);
    }
  }

  // ── Form helpers ──────────────────────────────────────────────────────────

  function patch(field: keyof FormState, value: string) {
    setForm(f => ({ ...f, [field]: value }));
    setErrors(e => ({ ...e, [field]: undefined }));
  }

  function validate() {
    const e: Partial<Record<keyof FormState, string>> = {};
    if (!form.name.trim()) e.name = 'Name is required';
    if (!form.start_date) e.start_date = 'Start date is required';
    if (!form.end_date) e.end_date = 'End date is required';
    if (form.start_date && form.end_date && form.end_date < form.start_date)
      e.end_date = 'End date must be on or after start date';
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  // ── Save ──────────────────────────────────────────────────────────────────

  async function handleSave() {
    if (!validate()) return;
    setSaving(true);

    const payload: Record<string, unknown> = { updated_at: new Date().toISOString() };

    if (editMode === 'full' || isNew) {
      payload.event_code = form.event_code.trim().toUpperCase();
      payload.name = form.name.trim();
      payload.location = form.location.trim() || null;
      payload.description = form.description.trim() || null;
      payload.start_date = form.start_date || null;
      payload.end_date = form.end_date || null;
      payload.status = form.status;
      payload.message_template_id = form.message_template_id || null;
    } else if (editMode === 'template-only') {
      payload.message_template_id = form.message_template_id || null;
    }

    if (isNew) {
      const { data, error } = await supabase
        .from('events').insert(payload).select().maybeSingle();
      if (error || !data) {
        showToast(error?.message ?? 'Failed to create event.', 'error');
      } else {
        showToast('Event created.', 'success');
        await fetchEvents(activeTab);
        loadEvent(data as Event);
      }
    } else {
      const { error } = await supabase.from('events').update(payload).eq('id', selectedId!);
      if (error) {
        showToast('Failed to save event.', 'error');
      } else {
        showToast('Event saved.', 'success');
        setSavedForm({ ...form });
        await fetchEvents(activeTab);
      }
    }
    setSaving(false);
  }

  // ── Delete ────────────────────────────────────────────────────────────────

  async function handleDelete() {
    if (!selectedId) return;
    setDeleting(true);
    setConfirmDelete(false);

    if (form.status === 'UPCOMING') {
      const { count } = await supabase
        .from('lead_entries')
        .select('id', { count: 'exact', head: true })
        .eq('event_code', form.event_code);
      if ((count ?? 0) > 0) {
        showToast('Cannot delete event with existing leads.', 'error');
        setDeleting(false);
        return;
      }
    }

    const { error } = await supabase.from('events').delete().eq('id', selectedId);
    if (error) {
      showToast('Failed to delete event.', 'error');
    } else {
      showToast('Event deleted.', 'success');
      setSelectedId(null);
      setForm(EMPTY_FORM);
      setSavedForm(EMPTY_FORM);
      setIsNew(false);
      setMetrics(null);
      setRepRows([]);
      setStateRows([]);
      setDayRows([]);
      await fetchEvents(activeTab);
    }
    setDeleting(false);
  }

  function handleCancel() { setForm(savedForm); setErrors({}); }

  // ── Derived ────────────────────────────────────────────────────────────────

  const hasEditor = isNew || selectedId !== null;
  const canDelete = !isNew && (form.status === 'DRAFT' || form.status === 'UPCOMING');

  const maxDay = dayRows.length > 0 ? Math.max(...dayRows.map(d => d.count)) : 1;
  const maxState = stateRows.length > 0 ? Math.max(...stateRows.map(s => s.count)) : 1;

  const modeBanner = editMode === 'readonly'
    ? { icon: Lock, cls: 'bg-stone-50 border-stone-200 text-stone-500', text: `This event is ${form.status.toLowerCase()} — read only.` }
    : editMode === 'template-only'
    ? { icon: Info, cls: 'bg-yellow-50 border-yellow-200 text-yellow-700', text: 'Event is ACTIVE. Only the message template can be changed.' }
    : null;

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col h-[calc(100vh-57px)] overflow-hidden bg-stone-50">

      {/* ── Top Bar ── */}
      <div className="bg-white border-b border-stone-200 px-3 md:px-6 py-0 flex items-stretch justify-between flex-shrink-0">
        <div className="flex items-stretch gap-0.5 md:gap-1 overflow-x-auto">
          {ALL_STATUSES.map(s => {
            const st = STATUS_STYLES[s];
            const active = s === activeTab;
            return (
              <button
                key={s}
                onClick={() => handleTabChange(s)}
                className={`flex items-center gap-1.5 px-2.5 md:px-4 text-xs font-semibold border-b-2 transition-colors py-3 whitespace-nowrap
                  ${active
                    ? `border-stone-800 ${st.tab}`
                    : 'border-transparent text-stone-400 hover:text-stone-600'}`}
              >
                <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${active ? st.dot : 'bg-stone-300'}`} />
                {s}
              </button>
            );
          })}
        </div>
        <div className="flex items-center flex-shrink-0 pl-2">
          <button
            onClick={() => guardUnsaved(startNew, 'new')}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-stone-800 hover:bg-stone-700 rounded-lg transition"
          >
            <Plus className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Create Event</span>
          </button>
        </div>
      </div>

      {/* ── Body ── */}
      <div className="flex flex-1 overflow-hidden">

        {/* ── LEFT PANEL — hidden on mobile when detail is open ── */}
        <aside className={`
          flex-col bg-white border-r border-stone-200 overflow-hidden
          ${isMobile
            ? mobileShowDetail ? 'hidden' : 'flex w-full'
            : 'flex w-72 flex-shrink-0'}
        `}>
          <div className="px-4 py-2.5 border-b border-stone-100">
            <p className="text-xs font-semibold text-stone-400 uppercase tracking-wide">
              {activeTab} Events
            </p>
          </div>
          <div className="flex-1 overflow-y-auto">
            {loadingList ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="w-5 h-5 text-stone-300 animate-spin" />
              </div>
            ) : events.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 px-4 text-center">
                <CalendarDays className="w-8 h-8 text-stone-200 mb-2" />
                <p className="text-xs text-stone-400">No {activeTab.toLowerCase()} events.</p>
              </div>
            ) : (
              <ul ref={listRef} className="py-1">
                {events.map(ev => {
                  const isSelected = selectedId === ev.id;
                  return (
                    <li key={ev.id}>
                      <button
                        onClick={() => guardUnsaved(() => loadEvent(ev), ev.id)}
                        className={`w-full text-left px-4 py-3 border-b border-stone-50 transition-colors
                          ${isSelected
                            ? 'bg-stone-100 border-l-2 border-l-stone-800'
                            : 'hover:bg-stone-50 border-l-2 border-l-transparent'}`}
                      >
                        <p className="text-sm font-semibold text-stone-800 truncate leading-tight mb-1">
                          {ev.name ?? ev.event_code}
                        </p>
                        <p className="text-[11px] font-mono text-stone-400 mb-1">{ev.event_code}</p>
                        {ev.location && (
                          <p className="text-xs text-stone-400 flex items-center gap-1 truncate mb-1">
                            <MapPin className="w-2.5 h-2.5 flex-shrink-0" />{ev.location}
                          </p>
                        )}
                        <div className="flex items-center justify-between mt-1">
                          <p className="text-[11px] text-stone-400">
                            {fmt(ev.start_date)}{ev.end_date && ev.end_date !== ev.start_date ? ` – ${fmt(ev.end_date)}` : ''}
                          </p>
                          <span className="flex items-center gap-1 text-[11px] text-stone-500 font-medium">
                            <Users className="w-3 h-3" />{ev.lead_count}
                          </span>
                        </div>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </aside>

        {/* ── RIGHT PANEL — full-screen on mobile when detail is open ── */}
        <div className={`
          overflow-y-auto bg-stone-50
          ${isMobile
            ? mobileShowDetail ? 'flex flex-col w-full' : 'hidden'
            : 'flex-1'}
        `}>
          {/* Mobile sticky back header */}
          {isMobile && mobileShowDetail && (
            <div className="sticky top-0 z-10 flex items-center gap-3 bg-white border-b border-stone-200 px-4 py-3 flex-shrink-0">
              <button
                onClick={() => setMobileShowDetail(false)}
                className="flex items-center gap-1.5 text-sm font-medium text-stone-600 hover:text-stone-900 transition"
              >
                <ChevronLeft className="w-4 h-4" />
                Events
              </button>
              <span className="text-sm font-semibold text-stone-800 truncate">
                {isNew ? 'New Event' : (form.name || form.event_code || '—')}
              </span>
            </div>
          )}

          {!hasEditor ? (
            <div className="flex flex-col items-center justify-center h-full text-center px-8">
              <CalendarDays className="w-12 h-12 text-stone-200 mb-3" />
              <p className="text-sm font-medium text-stone-400 mb-1">No event selected</p>
              <p className="text-xs text-stone-300">Select an event from the list or create a new one.</p>
            </div>
          ) : (
            <div className="p-6 max-w-3xl mx-auto flex flex-col gap-5">

              {/* Header */}
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-lg font-bold text-stone-900">
                    {isNew ? 'New Event' : (form.name || form.event_code)}
                  </h2>
                  {!isNew && (
                    <p className="text-xs font-mono text-stone-400 mt-0.5">{form.event_code}</p>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  {isDirty && editMode !== 'readonly' && (
                    <span className="text-xs font-medium text-yellow-600 bg-yellow-50 border border-yellow-200 px-2 py-0.5 rounded-full">
                      Unsaved
                    </span>
                  )}
                  {!isNew && <StatusBadge status={form.status} />}
                </div>
              </div>

              {/* Mode banner */}
              {modeBanner && !isNew && (
                <div className={`flex items-center gap-2.5 px-4 py-3 rounded-xl border text-sm ${modeBanner.cls}`}>
                  <modeBanner.icon className="w-4 h-4 flex-shrink-0" />
                  {modeBanner.text}
                </div>
              )}

              {/* ── SECTION 1: BASIC INFO ── */}
              <SectionCard title="Basic Info" icon={<CalendarDays className="w-4 h-4" />}>
                <div className="grid grid-cols-2 gap-4">

                  {/* Event Code — only on new */}
                  {isNew && (
                    <div className="col-span-2">
                      <Field label="Event Code" required error={errors.event_code}>
                        <input
                          type="text"
                          value={form.event_code}
                          onChange={e => patch('event_code', e.target.value.toUpperCase())}
                          placeholder="e.g. EXPO2026"
                          className={`${INPUT_BASE} font-mono ${INPUT_ON}`}
                        />
                      </Field>
                    </div>
                  )}

                  <div className="col-span-2">
                    <Field label="Name" required error={errors.name}>
                      <input
                        type="text"
                        value={form.name}
                        onChange={e => patch('name', e.target.value)}
                        disabled={editMode !== 'full' && !isNew}
                        placeholder="Event name"
                        className={`${INPUT_BASE} ${editMode !== 'full' && !isNew ? INPUT_OFF : INPUT_ON}`}
                      />
                    </Field>
                  </div>

                  <div className="col-span-2">
                    <Field label="Description">
                      <textarea
                        value={form.description}
                        onChange={e => patch('description', e.target.value)}
                        disabled={editMode !== 'full' && !isNew}
                        placeholder="Optional description"
                        rows={2}
                        className={`${INPUT_BASE} resize-none ${editMode !== 'full' && !isNew ? INPUT_OFF : INPUT_ON}`}
                      />
                    </Field>
                  </div>

                  <div className="col-span-2">
                    <Field label="Location">
                      <input
                        type="text"
                        value={form.location}
                        onChange={e => patch('location', e.target.value)}
                        disabled={editMode !== 'full' && !isNew}
                        placeholder="e.g. Pragati Maidan, Delhi"
                        className={`${INPUT_BASE} ${editMode !== 'full' && !isNew ? INPUT_OFF : INPUT_ON}`}
                      />
                    </Field>
                  </div>

                  <Field label="Start Date" required error={errors.start_date}>
                    <input
                      type="date"
                      value={form.start_date}
                      onChange={e => patch('start_date', e.target.value)}
                      disabled={editMode !== 'full' && !isNew}
                      className={`${INPUT_BASE} ${editMode !== 'full' && !isNew ? INPUT_OFF : INPUT_ON}`}
                    />
                  </Field>

                  <Field label="End Date" required error={errors.end_date}>
                    <input
                      type="date"
                      value={form.end_date}
                      onChange={e => patch('end_date', e.target.value)}
                      disabled={editMode !== 'full' && !isNew}
                      className={`${INPUT_BASE} ${editMode !== 'full' && !isNew ? INPUT_OFF : INPUT_ON}`}
                    />
                  </Field>

                  <Field label="Status">
                    {editMode === 'full' || isNew ? (
                      <select
                        value={form.status}
                        onChange={e => patch('status', e.target.value)}
                        className={`${INPUT_BASE} ${INPUT_ON}`}
                      >
                        {ALL_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
                      </select>
                    ) : (
                      <div className="pt-1"><StatusBadge status={form.status} /></div>
                    )}
                  </Field>

                  <Field label="Message Template" error={errors.message_template_id}>
                    {editMode === 'readonly' && !isNew ? (
                      <div className={`${INPUT_BASE} ${INPUT_OFF} flex items-center gap-2`}>
                        <FileText className="w-3.5 h-3.5 flex-shrink-0" />
                        <span className="truncate">{templates.find(t => t.id === form.message_template_id)?.name ?? '—'}</span>
                      </div>
                    ) : (
                      <select
                        value={form.message_template_id}
                        onChange={e => patch('message_template_id', e.target.value)}
                        className={`${INPUT_BASE} ${INPUT_ON}`}
                      >
                        <option value="">— None —</option>
                        {templates.map(t => (
                          <option key={t.id} value={t.id}>{t.name}</option>
                        ))}
                      </select>
                    )}
                  </Field>

                </div>
              </SectionCard>

              {/* ── SECTIONS 2-5: ANALYTICS (only when event selected, not new) ── */}
              {!isNew && selectedId && (
                <>
                  {loadingMetrics ? (
                    <div className="flex items-center justify-center py-10">
                      <Loader2 className="w-5 h-5 text-stone-300 animate-spin" />
                    </div>
                  ) : metrics ? (
                    <>
                      {/* ── SECTION 2: METRICS ── */}
                      <SectionCard title="Event Metrics" icon={<BarChart2 className="w-4 h-4" />}>
                        <div className="grid grid-cols-3 gap-3 mb-5">
                          {[
                            { label: 'Total Leads', value: metrics.total, cls: 'bg-stone-50 border-stone-200 text-stone-800' },
                            { label: 'Contacted', value: metrics.contacted, cls: 'bg-blue-50 border-blue-200 text-blue-800' },
                            { label: 'Converted', value: metrics.converted, cls: 'bg-green-50 border-green-200 text-green-800' },
                            { label: 'Lost', value: metrics.lost, cls: 'bg-red-50 border-red-200 text-red-700' },
                            { label: 'Invalid', value: metrics.invalid, cls: 'bg-orange-50 border-orange-200 text-orange-700' },
                            { label: 'Contact Rate', value: pct(metrics.contacted, metrics.total), cls: 'bg-sky-50 border-sky-200 text-sky-800' },
                          ].map(item => (
                            <div key={item.label} className={`rounded-xl border px-4 py-3 ${item.cls}`}>
                              <p className="text-[11px] font-medium opacity-70 mb-0.5">{item.label}</p>
                              <p className="text-2xl font-bold">{item.value}</p>
                            </div>
                          ))}
                        </div>

                        {/* Temperature */}
                        <div className="border-t border-stone-100 pt-4">
                          <div className="flex items-center gap-2 mb-3">
                            <ThermometerSun className="w-3.5 h-3.5 text-stone-400" />
                            <p className="text-xs font-semibold text-stone-500 uppercase tracking-wide">Lead Temperature</p>
                          </div>
                          <div className="grid grid-cols-3 gap-3">
                            {[
                              { label: 'Hot', value: metrics.hot, bar: 'bg-red-400', text: 'text-red-700', bg: 'bg-red-50 border-red-200' },
                              { label: 'Warm', value: metrics.warm, bar: 'bg-orange-400', text: 'text-orange-700', bg: 'bg-orange-50 border-orange-200' },
                              { label: 'Cold', value: metrics.cold, bar: 'bg-sky-400', text: 'text-sky-700', bg: 'bg-sky-50 border-sky-200' },
                            ].map(t => (
                              <div key={t.label} className={`rounded-xl border px-4 py-3 ${t.bg}`}>
                                <p className={`text-[11px] font-medium mb-0.5 ${t.text} opacity-80`}>{t.label}</p>
                                <p className={`text-2xl font-bold ${t.text}`}>{t.value}</p>
                                <div className="mt-2 h-1.5 bg-white/60 rounded-full overflow-hidden">
                                  <div
                                    className={`h-full rounded-full ${t.bar}`}
                                    style={{ width: pct(t.value, metrics.total) }}
                                  />
                                </div>
                                <p className={`text-[10px] mt-1 ${t.text} opacity-60`}>{pct(t.value, metrics.total)}</p>
                              </div>
                            ))}
                          </div>
                        </div>
                      </SectionCard>

                      {/* ── SECTION 3: SALES PERFORMANCE ── */}
                      {repRows.length > 0 && (
                        <SectionCard title="Sales Performance" icon={<TrendingUp className="w-4 h-4" />}>
                          <div className="overflow-x-auto -mx-1">
                            <table className="w-full text-sm">
                              <thead>
                                <tr className="border-b border-stone-100">
                                  <th className="text-left px-2 py-2 text-xs font-semibold text-stone-500">Sales Rep</th>
                                  <th className="text-right px-2 py-2 text-xs font-semibold text-stone-500">Total</th>
                                  <th className="text-right px-2 py-2 text-xs font-semibold text-stone-500">Contacted</th>
                                  <th className="text-right px-2 py-2 text-xs font-semibold text-stone-500">Converted</th>
                                  <th className="text-right px-2 py-2 text-xs font-semibold text-stone-500">Lost</th>
                                  <th className="text-right px-2 py-2 text-xs font-semibold text-stone-500">Rate</th>
                                </tr>
                              </thead>
                              <tbody className="divide-y divide-stone-50">
                                {repRows.map(r => (
                                  <tr key={r.rep_code} className="hover:bg-stone-50 transition-colors">
                                    <td className="px-2 py-2.5">
                                      <p className="font-medium text-stone-800">{r.rep_name}</p>
                                      <p className="text-[11px] text-stone-400 font-mono">{r.rep_code}</p>
                                    </td>
                                    <td className="px-2 py-2.5 text-right font-semibold text-stone-700">{r.total}</td>
                                    <td className="px-2 py-2.5 text-right text-blue-700">{r.contacted}</td>
                                    <td className="px-2 py-2.5 text-right text-green-700">{r.converted}</td>
                                    <td className="px-2 py-2.5 text-right text-red-600">{r.lost}</td>
                                    <td className="px-2 py-2.5 text-right text-stone-500">{pct(r.contacted, r.total)}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </SectionCard>
                      )}

                      {/* ── SECTION 4: GEOGRAPHIC INSIGHTS ── */}
                      {stateRows.length > 0 && (
                        <SectionCard title="Geographic Insights" icon={<Globe className="w-4 h-4" />}>
                          <div className="space-y-2">
                            {stateRows.map(s => (
                              <div key={s.state} className="flex items-center gap-3">
                                <p className="text-sm text-stone-700 w-36 flex-shrink-0 truncate">{s.state}</p>
                                <div className="flex-1 h-2 bg-stone-100 rounded-full overflow-hidden">
                                  <div
                                    className="h-full bg-stone-600 rounded-full transition-all"
                                    style={{ width: `${(s.count / maxState) * 100}%` }}
                                  />
                                </div>
                                <p className="text-sm font-semibold text-stone-700 w-8 text-right">{s.count}</p>
                              </div>
                            ))}
                          </div>
                        </SectionCard>
                      )}

                      {/* ── SECTION 5: DAILY TREND ── */}
                      {dayRows.length > 0 && (
                        <SectionCard title="Daily Lead Trend" icon={<TrendingUp className="w-4 h-4" />}>
                          {dayRows.length <= 14 ? (
                            // Bar chart for short ranges
                            <div className="pt-2">
                              {/* Y-axis labels + bars */}
                              <div className="flex gap-3">
                                {/* Y-axis */}
                                <div className="flex flex-col justify-between text-right pb-6" style={{ minWidth: '24px' }}>
                                  {[maxDay, Math.round(maxDay / 2), 0].map(v => (
                                    <span key={v} className="text-[10px] text-stone-400 leading-none">{v}</span>
                                  ))}
                                </div>
                                {/* Chart area */}
                                <div className="flex-1 flex flex-col">
                                  {/* Gridlines + bars */}
                                  <div className="relative flex items-end gap-1.5 h-36 border-b border-stone-200">
                                    {/* Horizontal gridlines */}
                                    <div className="absolute inset-0 flex flex-col justify-between pointer-events-none pb-0">
                                      {[0, 1, 2].map(i => (
                                        <div key={i} className={`w-full border-t ${i === 2 ? 'border-stone-200' : 'border-stone-100 border-dashed'}`} />
                                      ))}
                                    </div>
                                    {/* Bars */}
                                    {dayRows.map(d => {
                                      const heightPct = Math.max(3, (d.count / maxDay) * 100);
                                      return (
                                        <div key={d.day} className="flex-1 flex items-end group relative h-full">
                                          {/* Tooltip */}
                                          <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-10">
                                            <div className="bg-stone-800 text-white text-[10px] font-semibold px-2 py-1 rounded-md whitespace-nowrap shadow-lg">
                                              {d.count} lead{d.count !== 1 ? 's' : ''}
                                            </div>
                                            <div className="w-1.5 h-1.5 bg-stone-800 rotate-45 mx-auto -mt-1" />
                                          </div>
                                          <div
                                            className="w-full rounded-t-md transition-all duration-200 cursor-default"
                                            style={{
                                              height: `${heightPct}%`,
                                              background: `linear-gradient(to top, #292524, #57534e)`,
                                            }}
                                          />
                                        </div>
                                      );
                                    })}
                                  </div>
                                  {/* X-axis labels */}
                                  <div className="flex gap-1.5 mt-2">
                                    {dayRows.map(d => (
                                      <div key={d.day} className="flex-1 text-center">
                                        <span className="text-[10px] text-stone-400 leading-none">{d.day.slice(5)}</span>
                                      </div>
                                    ))}
                                  </div>
                                </div>
                              </div>
                              {/* Summary row */}
                              <div className="mt-4 pt-3 border-t border-stone-100 flex items-center justify-between text-xs text-stone-400">
                                <span>{dayRows.length} day{dayRows.length !== 1 ? 's' : ''}</span>
                                <span className="font-medium text-stone-600">{dayRows.reduce((s, d) => s + d.count, 0)} total leads</span>
                              </div>
                            </div>
                          ) : (
                            // Table for long ranges
                            <div className="max-h-56 overflow-y-auto">
                              <table className="w-full text-sm">
                                <thead className="sticky top-0 bg-white">
                                  <tr className="border-b border-stone-100">
                                    <th className="text-left px-2 py-1.5 text-xs font-semibold text-stone-500">Date</th>
                                    <th className="text-right px-2 py-1.5 text-xs font-semibold text-stone-500">Leads</th>
                                    <th className="px-2 py-1.5 w-32"></th>
                                  </tr>
                                </thead>
                                <tbody className="divide-y divide-stone-50">
                                  {dayRows.map(d => (
                                    <tr key={d.day} className="hover:bg-stone-50">
                                      <td className="px-2 py-2 text-stone-600">{fmt(d.day)}</td>
                                      <td className="px-2 py-2 text-right font-semibold text-stone-800">{d.count}</td>
                                      <td className="px-2 py-2">
                                        <div className="h-1.5 bg-stone-100 rounded-full overflow-hidden">
                                          <div
                                            className="h-full bg-stone-600 rounded-full"
                                            style={{ width: `${(d.count / maxDay) * 100}%` }}
                                          />
                                        </div>
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          )}
                        </SectionCard>
                      )}
                    </>
                  ) : (
                    <div className="bg-white rounded-xl border border-stone-100 px-5 py-8 text-center">
                      <Users className="w-8 h-8 text-stone-200 mx-auto mb-2" />
                      <p className="text-sm text-stone-400">No leads captured for this event yet.</p>
                    </div>
                  )}
                </>
              )}

              {/* ── SECTION 6: ACTIONS ── */}
              <SectionCard title="Actions" icon={<Save className="w-4 h-4" />}>
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <div className="flex items-center gap-2 flex-wrap">
                    {editMode !== 'readonly' && (
                      <>
                        <button
                          onClick={handleSave}
                          disabled={saving}
                          className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-stone-800 hover:bg-stone-700 rounded-lg transition disabled:opacity-50"
                        >
                          {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                          {saving ? 'Saving…' : 'Save Event'}
                        </button>
                        {isDirty && (
                          <button
                            onClick={handleCancel}
                            className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-stone-600 border border-stone-200 hover:bg-stone-100 rounded-lg transition"
                          >
                            <X className="w-3.5 h-3.5" /> Cancel
                          </button>
                        )}
                      </>
                    )}
                    {!isNew && onViewLeads && (
                      <button
                        onClick={() => onViewLeads(form.event_code)}
                        className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-stone-700 border border-stone-200 hover:bg-stone-50 rounded-lg transition"
                      >
                        <ArrowRight className="w-3.5 h-3.5" /> View Leads
                      </button>
                    )}
                  </div>
                  {canDelete && (
                    <button
                      onClick={() => setConfirmDelete(true)}
                      disabled={deleting}
                      className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-red-600 border border-red-200 hover:bg-red-50 rounded-lg transition disabled:opacity-50"
                    >
                      {deleting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                      Delete Event
                    </button>
                  )}
                </div>
              </SectionCard>

            </div>
          )}
        </div>
      </div>

      {/* ── Dialogs & Toasts ── */}
      {confirmDelete && (
        <ConfirmDialog
          title={`Delete "${form.name || form.event_code}"?`}
          body="This action cannot be undone."
          confirmLabel="Delete"
          confirmClass="bg-red-600 hover:bg-red-700"
          onConfirm={handleDelete}
          onCancel={() => setConfirmDelete(false)}
        />
      )}
      {unsavedTarget !== null && (
        <ConfirmDialog
          title="Unsaved changes"
          body="You have unsaved changes. Discard them and continue?"
          confirmLabel="Discard"
          confirmClass="bg-yellow-600 hover:bg-yellow-700"
          onConfirm={handleUnsavedDiscardExtended}
          onCancel={() => setUnsavedTarget(null)}
        />
      )}
      {toast && (
        <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />
      )}
    </div>
  );
}
