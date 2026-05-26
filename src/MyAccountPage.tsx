import { useEffect, useRef, useState } from 'react';
import {
  User, Hash, Phone, Mail, Shield, CheckCircle2, XCircle,
  CalendarDays, MapPin, AlignLeft, Copy, Check, ChevronDown,
  Loader2, AlertCircle, CalendarCheck, ArrowLeft, LogOut,
} from 'lucide-react';
import { useAuth } from './AuthContext';
import { useEvent, type AppEvent } from './EventContext';

// ─── Toast ────────────────────────────────────────────────────────────────────

function Toast({ message, type }: { message: string | null; type: 'success' | 'error' }) {
  if (!message) return null;
  return (
    <div className={`fixed bottom-24 md:bottom-6 left-1/2 -translate-x-1/2 z-50
      flex items-center gap-2 px-4 py-2.5 rounded-full shadow-lg text-sm font-medium
      whitespace-nowrap pointer-events-none
      ${type === 'success' ? 'bg-emerald-700 text-white' : 'bg-red-700 text-white'}`}
    >
      {type === 'success'
        ? <CheckCircle2 className="w-4 h-4 shrink-0" />
        : <AlertCircle className="w-4 h-4 shrink-0" />}
      {message}
    </div>
  );
}

// ─── Copy button ──────────────────────────────────────────────────────────────

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  function handle() {
    navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }
  return (
    <button
      onClick={handle}
      className="ml-1.5 p-1 rounded text-stone-400 hover:text-stone-700 hover:bg-stone-100 transition-colors"
      aria-label="Copy"
    >
      {copied
        ? <Check className="w-3.5 h-3.5 text-emerald-600" />
        : <Copy className="w-3.5 h-3.5" />}
    </button>
  );
}

// ─── Skeleton ─────────────────────────────────────────────────────────────────

function Skeleton({ className }: { className?: string }) {
  return <div className={`animate-pulse rounded-lg bg-stone-100 ${className ?? ''}`} />;
}

// ─── Field row ────────────────────────────────────────────────────────────────

function FieldRow({
  icon,
  label,
  value,
  copiable,
  mono,
}: {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
  copiable?: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-start gap-3 py-3.5 border-b border-stone-100 last:border-0">
      <span className="mt-0.5 text-stone-400 shrink-0">{icon}</span>
      <div className="flex-1 min-w-0">
        <p className="text-[11px] font-medium text-stone-400 uppercase tracking-wider mb-0.5">{label}</p>
        <div className="flex items-center gap-0.5">
          <p className={`text-sm text-stone-900 break-all ${mono ? 'font-mono' : 'font-medium'}`}>
            {value || <span className="text-stone-400 font-normal italic">—</span>}
          </p>
          {copiable && <CopyButton value={copiable} />}
        </div>
      </div>
    </div>
  );
}

// ─── Badge helpers ────────────────────────────────────────────────────────────

function ActiveBadge({ active }: { active: boolean }) {
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium
      ${active ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-600'}`}>
      {active
        ? <><CheckCircle2 className="w-3 h-3" />Active</>
        : <><XCircle className="w-3 h-3" />Inactive</>}
    </span>
  );
}

function EventBadges({ event }: { event: AppEvent }) {
  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium
        ${event.is_active ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-600'}`}>
        {event.is_active ? <CheckCircle2 className="w-3 h-3" /> : <XCircle className="w-3 h-3" />}
        {event.is_active ? 'Active' : 'Inactive'}
      </span>
      {event.is_default && (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-sky-50 text-sky-700">
          <CalendarCheck className="w-3 h-3" />
          Default
        </span>
      )}
    </div>
  );
}

// ─── Event dropdown ───────────────────────────────────────────────────────────

function EventSelect({
  events,
  selected,
  onChange,
  disabled,
}: {
  events: AppEvent[];
  selected: AppEvent | null;
  onChange: (e: AppEvent) => void;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  if (events.length === 0) {
    return (
      <div className="flex items-center gap-2 px-3 py-3 bg-amber-50 border border-amber-200 rounded-xl text-sm text-amber-700">
        <AlertCircle className="w-4 h-4 shrink-0" />
        No active events available
      </div>
    );
  }

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => !disabled && setOpen(o => !o)}
        disabled={disabled}
        className={`w-full flex items-center justify-between gap-2 px-3.5 py-3 bg-white
          border border-stone-200 rounded-xl text-sm shadow-sm transition-colors
          ${disabled ? 'opacity-60 cursor-not-allowed' : 'hover:border-stone-300 cursor-pointer'}`}
      >
        <span className="flex items-center gap-2 min-w-0">
          <CalendarDays className="w-4 h-4 text-stone-400 shrink-0" />
          <span className="truncate font-medium text-stone-900">
            {selected
              ? selected.name
              : <span className="text-stone-400 font-normal">Select an event…</span>}
          </span>
        </span>
        <ChevronDown className={`w-4 h-4 text-stone-400 shrink-0 transition-transform duration-150 ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="absolute z-30 top-full mt-1.5 inset-x-0 bg-white border border-stone-200
          rounded-xl shadow-xl overflow-hidden max-h-60 overflow-y-auto">
          {events.map(ev => {
            const isSel = selected?.id === ev.id;
            return (
              <button
                key={ev.id}
                onClick={() => { onChange(ev); setOpen(false); }}
                className={`w-full flex items-center justify-between gap-3 px-4 py-3 text-left
                  transition-colors border-b border-stone-50 last:border-0
                  ${isSel ? 'bg-stone-900 text-white' : 'text-stone-700 hover:bg-stone-50'}`}
              >
                <div className="min-w-0">
                  <p className={`text-sm font-medium truncate ${isSel ? 'text-white' : 'text-stone-900'}`}>
                    {ev.name}
                  </p>
                  <p className={`text-xs truncate mt-0.5 ${isSel ? 'text-stone-300' : 'text-stone-400'}`}>
                    {ev.event_code}
                    {ev.start_date
                      ? ` · ${new Date(ev.start_date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}`
                      : ''}
                  </p>
                </div>
                <div className="shrink-0 flex items-center gap-1.5">
                  {ev.is_default && (
                    <span className={`text-xs px-1.5 py-0.5 rounded font-medium
                      ${isSel ? 'bg-white/20 text-white' : 'bg-sky-50 text-sky-700'}`}>
                      Default
                    </span>
                  )}
                  {isSel && <Check className="w-4 h-4" />}
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Event details card ───────────────────────────────────────────────────────

function EventDetailsCard({ event }: { event: AppEvent }) {
  function fmt(d: string | null) {
    if (!d) return '—';
    return new Date(d).toLocaleDateString('en-IN', {
      day: 'numeric', month: 'long', year: 'numeric',
    });
  }

  return (
    <div className="mt-4 rounded-xl border border-stone-200 bg-stone-50 overflow-hidden">
      {/* Header row */}
      <div className="px-4 py-3 border-b border-stone-200 flex items-start justify-between gap-3 flex-wrap">
        <div>
          <p className="text-[11px] font-medium text-stone-400 uppercase tracking-wider mb-0.5">Event Code</p>
          <div className="flex items-center gap-0.5">
            <span className="text-sm font-mono font-semibold text-stone-800">{event.event_code}</span>
            <CopyButton value={event.event_code} />
          </div>
        </div>
        <EventBadges event={event} />
      </div>

      <div className="px-4 py-3 space-y-3">
        <div>
          <p className="text-[11px] font-medium text-stone-400 uppercase tracking-wider mb-0.5">Event Name</p>
          <p className="text-sm font-medium text-stone-900">{event.name}</p>
        </div>

        {event.description && (
          <div>
            <p className="text-[11px] font-medium text-stone-400 uppercase tracking-wider mb-0.5 flex items-center gap-1">
              <AlignLeft className="w-3 h-3" /> Description
            </p>
            <p className="text-sm text-stone-600 leading-relaxed">{event.description}</p>
          </div>
        )}

        <div className="grid grid-cols-2 gap-3">
          <div>
            <p className="text-[11px] font-medium text-stone-400 uppercase tracking-wider mb-0.5">Start Date</p>
            <p className="text-sm text-stone-700">{fmt(event.start_date)}</p>
          </div>
          <div>
            <p className="text-[11px] font-medium text-stone-400 uppercase tracking-wider mb-0.5">End Date</p>
            <p className="text-sm text-stone-700">{fmt(event.end_date)}</p>
          </div>
        </div>

        {event.location && (
          <div>
            <p className="text-[11px] font-medium text-stone-400 uppercase tracking-wider mb-0.5 flex items-center gap-1">
              <MapPin className="w-3 h-3" /> Location
            </p>
            <p className="text-sm text-stone-700">{event.location}</p>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Section shell ────────────────────────────────────────────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-2xl border border-stone-200 overflow-hidden shadow-sm">
      <div className="px-5 py-4 border-b border-stone-100">
        <h2 className="text-sm font-semibold text-stone-700">{title}</h2>
      </div>
      <div className="px-5">{children}</div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function MyAccountPage({ onBack }: { onBack: () => void }) {
  const { user, salesRep, logout } = useAuth();
  const { selectedEvent, activeEvents, loadingEvent, setSelectedEvent, refreshSelectedEvent } = useEvent();

  const [toast, setToast]         = useState<{ msg: string; type: 'success' | 'error' } | null>(null);
  const [saving, setSaving]       = useState(false);
  const toastTimer                = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Refresh event validation on mount
  useEffect(() => {
    refreshSelectedEvent();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function showToast(msg: string, type: 'success' | 'error') {
    setToast({ msg, type });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3000);
  }

  async function handleEventChange(event: AppEvent) {
    if (!event.is_active) {
      showToast('Cannot select an inactive event', 'error');
      return;
    }
    setSaving(true);
    try {
      await setSelectedEvent(event);
      showToast(`Default event set to "${event.name}"`, 'success');
    } catch {
      showToast('Failed to save — please try again', 'error');
    } finally {
      setSaving(false);
    }
  }

  const initials = (user?.name ?? 'U')
    .split(' ')
    .map(w => w[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);

  const roleLabel = user?.role === 'admin' ? 'Administrator' : 'Sales Representative';

  return (
    <div className="min-h-[calc(100vh-57px)] bg-stone-50">

      {/* Page header */}
      <div className="sticky top-0 z-10 bg-white border-b border-stone-200 px-4 py-3 flex items-center gap-3">
        <button
          onClick={onBack}
          className="flex items-center justify-center w-8 h-8 rounded-lg hover:bg-stone-100 transition-colors text-stone-500"
          aria-label="Back"
        >
          <ArrowLeft className="w-4 h-4" />
        </button>
        <h1 className="text-base font-semibold text-stone-800">My Account</h1>
      </div>

      <div className="max-w-lg mx-auto px-4 py-6 space-y-5">

        {/* Avatar + identity hero */}
        <div className="flex items-center gap-4 px-1">
          <div className="w-14 h-14 rounded-full bg-stone-900 flex items-center justify-center shrink-0 shadow-sm">
            <span className="text-lg font-bold text-white tracking-wide">{initials}</span>
          </div>
          <div>
            <p className="text-lg font-semibold text-stone-900 leading-tight">{user?.name}</p>
            <p className="text-sm text-stone-500 mt-0.5">{roleLabel}</p>
          </div>
        </div>

        {/* Section A — Rep details */}
        <Section title="Sales Representative Details">
          <FieldRow
            icon={<User className="w-4 h-4" />}
            label="Full Name"
            value={user?.name ?? ''}
          />
          <FieldRow
            icon={<Hash className="w-4 h-4" />}
            label="Rep Code"
            value={<span className="font-mono tracking-widest">{user?.rep_code}</span>}
            copiable={user?.rep_code}
            mono
          />
          <FieldRow
            icon={<Phone className="w-4 h-4" />}
            label="Phone"
            value={salesRep?.phone ?? ''}
            copiable={salesRep?.phone ?? undefined}
          />
          <FieldRow
            icon={<Mail className="w-4 h-4" />}
            label="Email"
            value={salesRep?.email ?? ''}
            copiable={salesRep?.email}
          />
          <FieldRow
            icon={<Shield className="w-4 h-4" />}
            label="Role"
            value={roleLabel}
          />
          <FieldRow
            icon={<CheckCircle2 className="w-4 h-4" />}
            label="Account Status"
            value={<ActiveBadge active={salesRep?.is_active ?? false} />}
          />
        </Section>

        {/* Section B — Default event */}
        <Section title="Default Event">
          <div className="py-4 space-y-3">
            <p className="text-xs text-stone-500 leading-relaxed">
              Choose which event your lead captures are linked to. Only active events can be selected.
              The app automatically falls back to the system default if your selected event becomes inactive.
            </p>

            {loadingEvent ? (
              <Skeleton className="h-12 w-full" />
            ) : (
              <EventSelect
                events={activeEvents}
                selected={selectedEvent}
                onChange={handleEventChange}
                disabled={saving}
              />
            )}

            {saving && (
              <div className="flex items-center gap-2 text-xs text-stone-500">
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                Saving…
              </div>
            )}

            {selectedEvent && !loadingEvent && (
              <EventDetailsCard event={selectedEvent} />
            )}

            {!selectedEvent && !loadingEvent && (
              <div className="flex items-center gap-2 px-3 py-3 bg-amber-50 border border-amber-200 rounded-xl text-sm text-amber-700">
                <AlertCircle className="w-4 h-4 shrink-0" />
                No event selected — lead captures will not be linked to an event
              </div>
            )}
          </div>
        </Section>

        {/* Logout */}
        <div className="pb-8">
          <button
            onClick={logout}
            className="w-full flex items-center justify-center gap-2 py-3.5 rounded-xl
              border border-red-200 text-red-600 text-sm font-medium
              hover:bg-red-50 active:bg-red-100 transition-colors"
          >
            <LogOut className="w-4 h-4" />
            Log Out
          </button>
        </div>

      </div>

      <Toast message={toast?.msg ?? null} type={toast?.type ?? 'success'} />
    </div>
  );
}
