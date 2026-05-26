// Lead Queue — local capture draft + sync visibility workspace.
// Shows all captured leads grouped by sync state.
// Works fully offline: reads only from IndexedDB, never blocks on network.

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Inbox, RefreshCw, Wifi, WifiOff, Search, X, Clock, CheckCircle2, AlertCircle, Loader2, FileText, ChevronDown, ChevronRight, Flame, Thermometer, Snowflake, Camera, QrCode, ClipboardList, RotateCcw, Trash2, CreditCard as Edit3, Eye, ArrowRight, Filter, Plus } from 'lucide-react';
import {
  loadQueueItems, deleteQueueItem, getDisplayName, getDisplayCompany,
  getLeadTemperature, type QueueItem, type QueueItemStatus,
} from './capture/leadQueueStorage';
import { getPendingCount, flushQueue } from './capture/captureOfflineQueue';
import { useOnlineStatus } from './capture/useOnlineStatus';

// ─── Status config ─────────────────────────────────────────────────────────────

interface StatusConfig {
  label:    string;
  short:    string;
  dot:      string;
  badge:    string;
  icon:     React.ReactNode;
  section:  string;
  priority: number;
}

const STATUS_CONFIG: Record<QueueItemStatus, StatusConfig> = {
  draft: {
    label: 'In Progress', short: 'Draft',
    dot:   'bg-stone-400',
    badge: 'bg-stone-100 text-stone-600 border-stone-200',
    icon:  <FileText className="w-3 h-3" />,
    section: 'Drafts', priority: 1,
  },
  needs_review: {
    label: 'Needs Review', short: 'Review',
    dot:   'bg-yellow-400',
    badge: 'bg-yellow-50 text-yellow-700 border-yellow-200',
    icon:  <AlertCircle className="w-3 h-3" />,
    section: 'Needs Review', priority: 2,
  },
  local_only: {
    label: 'Saved Locally', short: 'Local',
    dot:   'bg-stone-500',
    badge: 'bg-stone-100 text-stone-700 border-stone-200',
    icon:  <FileText className="w-3 h-3" />,
    section: 'Saved Locally', priority: 3,
  },
  pending_sync: {
    label: 'Pending Sync', short: 'Pending',
    dot:   'bg-blue-400',
    badge: 'bg-blue-50 text-blue-700 border-blue-200',
    icon:  <Clock className="w-3 h-3" />,
    section: 'Pending Sync', priority: 4,
  },
  syncing: {
    label: 'Syncing', short: 'Syncing',
    dot:   'bg-blue-500 animate-pulse',
    badge: 'bg-blue-50 text-blue-700 border-blue-200',
    icon:  <Loader2 className="w-3 h-3 animate-spin" />,
    section: 'Pending Sync', priority: 4,
  },
  failed: {
    label: 'Sync Failed', short: 'Failed',
    dot:   'bg-red-400',
    badge: 'bg-red-50 text-red-700 border-red-200',
    icon:  <AlertCircle className="w-3 h-3" />,
    section: 'Failed', priority: 5,
  },
  synced: {
    label: 'Synced', short: 'Synced',
    dot:   'bg-green-500',
    badge: 'bg-green-50 text-green-700 border-green-200',
    icon:  <CheckCircle2 className="w-3 h-3" />,
    section: 'Synced', priority: 6,
  },
};

// Section display order
const SECTION_ORDER = ['Failed', 'Needs Review', 'Pending Sync', 'Saved Locally', 'Drafts', 'Synced'];

// ─── Filter types ─────────────────────────────────────────────────────────────

type FilterTab = 'all' | 'pending' | 'failed' | 'drafts' | 'synced';

const FILTER_TABS: { id: FilterTab; label: string }[] = [
  { id: 'all',     label: 'All'     },
  { id: 'pending', label: 'Pending' },
  { id: 'failed',  label: 'Failed'  },
  { id: 'drafts',  label: 'Drafts'  },
  { id: 'synced',  label: 'Synced'  },
];

function matchesFilter(item: QueueItem, filter: FilterTab): boolean {
  if (filter === 'all') return true;
  if (filter === 'pending') return (
    item.status === 'pending_sync' || item.status === 'syncing' ||
    item.status === 'local_only'   || item.status === 'needs_review'
  );
  if (filter === 'failed')  return item.status === 'failed';
  if (filter === 'drafts')  return item.status === 'draft';
  if (filter === 'synced')  return item.status === 'synced';
  return true;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000)      return 'just now';
  if (diff < 3_600_000)   return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000)  return `${Math.round(diff / 3_600_000)}h ago`;
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

function MethodIcon({ method }: { method: QueueItem['captureMethod'] }) {
  if (method === 'BUSINESS_CARD') return <Camera className="w-3.5 h-3.5" />;
  if (method === 'QR')            return <QrCode className="w-3.5 h-3.5" />;
  return <ClipboardList className="w-3.5 h-3.5" />;
}

function TempIcon({ temp }: { temp: ReturnType<typeof getLeadTemperature> }) {
  if (temp === 'Hot')  return <Flame       className="w-3.5 h-3.5 text-red-500"    />;
  if (temp === 'Warm') return <Thermometer className="w-3.5 h-3.5 text-amber-500"  />;
  if (temp === 'Cold') return <Snowflake   className="w-3.5 h-3.5 text-blue-400"   />;
  return null;
}

// ─── Status badge ─────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: QueueItemStatus }) {
  const cfg = STATUS_CONFIG[status];
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold border ${cfg.badge}`}>
      {cfg.icon}
      {cfg.short}
    </span>
  );
}

// ─── Queue item card ──────────────────────────────────────────────────────────

interface QueueCardProps {
  item:        QueueItem;
  isOnline:    boolean;
  onContinue:  (item: QueueItem) => void;
  onRetry:     (item: QueueItem) => void;
  onDelete:    (item: QueueItem) => void;
  onView:      (item: QueueItem) => void;
}

function QueueCard({ item, isOnline, onContinue, onRetry, onDelete, onView }: QueueCardProps) {
  const [expanded, setExpanded] = useState(false);
  const name      = getDisplayName(item);
  const company   = getDisplayCompany(item);
  const temp      = getLeadTemperature(item);
  const cfg       = STATUS_CONFIG[item.status];
  const isFailed  = item.status === 'failed';
  const isDraft   = item.status === 'draft' || item.status === 'needs_review' || item.status === 'local_only';
  const isSynced  = item.status === 'synced';
  const phone     = item.draftData.phone || (item.draftData.phoneNumbers as string[] | undefined)?.[0];
  const hasNotes  = !!item.draftData.notes?.trim();

  return (
    <div className={[
      'bg-white rounded-2xl border overflow-hidden transition-all duration-150',
      isFailed ? 'border-red-200 shadow-red-50 shadow-sm' : 'border-stone-200 shadow-sm',
    ].join(' ')}>

      {/* Main row — tappable */}
      <button
        className="w-full text-left px-4 pt-4 pb-3 flex items-start gap-3 active:bg-stone-50 transition-colors"
        onClick={() => setExpanded(e => !e)}
        aria-expanded={expanded}
      >
        {/* Method icon circle */}
        <div className={[
          'w-10 h-10 rounded-xl flex items-center justify-center shrink-0 mt-0.5',
          item.captureMethod === 'BUSINESS_CARD' ? 'bg-amber-50 text-amber-600' :
          item.captureMethod === 'QR'            ? 'bg-teal-50 text-teal-600'   :
                                                   'bg-blue-50 text-blue-600',
        ].join(' ')}>
          <MethodIcon method={item.captureMethod} />
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0 flex-1">
              <p className={`text-sm font-semibold leading-tight truncate ${
                name === 'Unnamed Lead' ? 'text-stone-400 italic' : 'text-stone-900'
              }`}>{name}</p>
              {company && (
                <p className="text-xs text-stone-500 truncate mt-0.5">{company}</p>
              )}
            </div>
            {/* Chevron */}
            <div className="shrink-0 mt-0.5">
              {expanded
                ? <ChevronDown className="w-4 h-4 text-stone-300" />
                : <ChevronRight className="w-4 h-4 text-stone-300" />}
            </div>
          </div>

          {/* Meta row */}
          <div className="flex items-center gap-2 mt-2 flex-wrap">
            <StatusBadge status={item.status} />
            {temp && (
              <span className="flex items-center gap-1">
                <TempIcon temp={temp} />
                <span className="text-[11px] text-stone-500">{temp}</span>
              </span>
            )}
            {phone && (
              <span className="text-[11px] text-stone-400 truncate">{phone}</span>
            )}
            <span className="text-[11px] text-stone-400 ml-auto shrink-0">{relativeTime(item.updatedAt)}</span>
          </div>
        </div>
      </button>

      {/* Error message for failed items — always visible */}
      {isFailed && item.lastError && (
        <div className="px-4 pb-3 -mt-1">
          <p className="text-[11px] text-red-600 bg-red-50 rounded-lg px-3 py-2 leading-snug">
            {item.lastError.length > 120 ? item.lastError.slice(0, 120) + '…' : item.lastError}
          </p>
        </div>
      )}

      {/* Expanded details */}
      {expanded && (
        <div className="px-4 pb-3 border-t border-stone-100 pt-3 space-y-2 animate-in slide-in-from-top-1 duration-150">
          {item.draftData.designation && (
            <p className="text-xs text-stone-500"><span className="font-medium text-stone-700">Role:</span> {item.draftData.designation}</p>
          )}
          {item.draftData.email && (
            <p className="text-xs text-stone-500 truncate"><span className="font-medium text-stone-700">Email:</span> {item.draftData.email}</p>
          )}
          {item.eventName && (
            <p className="text-xs text-stone-500"><span className="font-medium text-stone-700">Event:</span> {item.eventName}</p>
          )}
          {hasNotes && (
            <p className="text-xs text-stone-500 line-clamp-2 italic">"{item.draftData.notes}"</p>
          )}
          {item.backendSessionId && (
            <p className="text-[10px] text-stone-300 font-mono truncate">ID: {item.backendSessionId.slice(0, 16)}…</p>
          )}
        </div>
      )}

      {/* Action bar */}
      <div className="px-4 pb-4 flex gap-2 border-t border-stone-50 pt-3">
        {/* Primary action */}
        {isDraft && (
          <button
            onClick={() => onContinue(item)}
            className="flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl
              bg-stone-900 hover:bg-stone-800 active:scale-[0.97]
              text-white text-sm font-semibold transition-all"
          >
            <Edit3 className="w-3.5 h-3.5" /> Continue
          </button>
        )}
        {isFailed && (
          <button
            onClick={() => onRetry(item)}
            disabled={!isOnline}
            className="flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl
              bg-stone-900 hover:bg-stone-800 active:scale-[0.97]
              text-white text-sm font-semibold transition-all disabled:opacity-40"
          >
            <RotateCcw className="w-3.5 h-3.5" /> Retry
          </button>
        )}
        {isSynced && (
          <button
            onClick={() => onView(item)}
            className="flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl
              border border-stone-200 text-stone-700 text-sm font-medium
              hover:bg-stone-50 active:scale-[0.97] transition-all"
          >
            <Eye className="w-3.5 h-3.5" /> View Lead
          </button>
        )}
        {!isDraft && !isFailed && !isSynced && (
          <button
            onClick={() => onView(item)}
            className="flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl
              border border-stone-200 text-stone-700 text-sm font-medium
              hover:bg-stone-50 active:scale-[0.97] transition-all"
          >
            <Eye className="w-3.5 h-3.5" /> Details
          </button>
        )}

        {/* Delete */}
        <button
          onClick={() => onDelete(item)}
          className="flex items-center justify-center px-3.5 py-2.5 rounded-xl
            border border-stone-100 text-stone-400 hover:text-red-500
            hover:border-red-100 hover:bg-red-50 active:scale-[0.97] transition-all"
          aria-label="Delete"
        >
          <Trash2 className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}

// ─── Section ──────────────────────────────────────────────────────────────────

interface SectionProps {
  title:       string;
  count:       number;
  items:       QueueItem[];
  isOnline:    boolean;
  defaultOpen: boolean;
  onContinue:  (item: QueueItem) => void;
  onRetry:     (item: QueueItem) => void;
  onDelete:    (item: QueueItem) => void;
  onView:      (item: QueueItem) => void;
}

function QueueSection({ title, count, items, isOnline, defaultOpen, onContinue, onRetry, onDelete, onView }: SectionProps) {
  const [open, setOpen] = useState(defaultOpen);

  if (items.length === 0) return null;

  return (
    <div>
      <button
        className="w-full flex items-center justify-between px-1 py-2 mb-2"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
      >
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-stone-700">{title}</span>
          <span className="text-xs font-medium text-stone-400 bg-stone-100 rounded-full px-2 py-0.5">{count}</span>
        </div>
        {open
          ? <ChevronDown className="w-4 h-4 text-stone-400" />
          : <ChevronRight className="w-4 h-4 text-stone-400" />}
      </button>

      {open && (
        <div className="space-y-3 animate-in slide-in-from-top-1 duration-150">
          {items.map(item => (
            <QueueCard
              key={item.id}
              item={item}
              isOnline={isOnline}
              onContinue={onContinue}
              onRetry={onRetry}
              onDelete={onDelete}
              onView={onView}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Delete confirm sheet ─────────────────────────────────────────────────────

function DeleteSheet({ item, onConfirm, onCancel }: {
  item:      QueueItem;
  onConfirm: () => void;
  onCancel:  () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center md:items-center p-4">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-[2px]" onClick={onCancel} />
      <div className="relative z-10 w-full max-w-sm bg-white rounded-2xl shadow-2xl overflow-hidden
        animate-in slide-in-from-bottom-4 md:zoom-in-95 duration-200">
        <div className="px-5 pt-5 pb-4 border-b border-stone-100 flex items-start gap-3">
          <div className="w-10 h-10 rounded-full bg-red-50 flex items-center justify-center shrink-0">
            <Trash2 className="w-5 h-5 text-red-600" />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-stone-900">Delete this lead?</h3>
            <p className="text-xs text-stone-500 mt-0.5 leading-relaxed">
              "{getDisplayName(item)}" will be permanently removed from your local queue.
              {item.status !== 'synced' && ' This cannot be recovered.'}
            </p>
          </div>
        </div>
        <div className="p-4 flex gap-3">
          <button onClick={onCancel}
            className="flex-1 py-3.5 rounded-xl border border-stone-200 text-sm font-medium
              text-stone-700 hover:bg-stone-50 active:bg-stone-100 transition-colors">
            Cancel
          </button>
          <button onClick={onConfirm}
            className="flex-1 py-3.5 rounded-xl bg-red-600 hover:bg-red-700
              text-white text-sm font-semibold transition-colors">
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Debug panel ─────────────────────────────────────────────────────────────

function QueueDebugPanel({ items, filtered, pendingOps, isOnline }: {
  items:      QueueItem[];
  filtered:   QueueItem[];
  pendingOps: number;
  isOnline:   boolean;
}) {
  const [open, setOpen] = useState(false);

  const statusBreakdown = items.reduce<Record<string, number>>((acc, i) => {
    acc[i.status] = (acc[i.status] ?? 0) + 1;
    return acc;
  }, {});

  const sourceBreakdown = items.reduce<Record<string, number>>((acc, i) => {
    const src = (i as QueueItem & { source?: string }).source ?? 'unknown';
    acc[src] = (acc[src] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <div className="mt-8 rounded-2xl border border-stone-200 bg-white overflow-hidden">
      <button
        className="w-full flex items-center justify-between px-4 py-3 text-left"
        onClick={() => setOpen(o => !o)}
      >
        <span className="text-xs font-semibold text-stone-500 uppercase tracking-wide">Queue Debug</span>
        {open ? <ChevronDown className="w-4 h-4 text-stone-400" /> : <ChevronRight className="w-4 h-4 text-stone-400" />}
      </button>

      {open && (
        <div className="px-4 pb-4 space-y-3 border-t border-stone-100 pt-3 text-xs text-stone-600 font-mono">
          <div className="grid grid-cols-2 gap-2">
            <div className="bg-stone-50 rounded-lg px-3 py-2">
              <p className="text-[10px] text-stone-400 mb-0.5">Total in queue</p>
              <p className="font-bold text-stone-800 text-sm">{items.length}</p>
            </div>
            <div className="bg-stone-50 rounded-lg px-3 py-2">
              <p className="text-[10px] text-stone-400 mb-0.5">Showing (filtered)</p>
              <p className="font-bold text-stone-800 text-sm">{filtered.length}</p>
            </div>
            <div className="bg-stone-50 rounded-lg px-3 py-2">
              <p className="text-[10px] text-stone-400 mb-0.5">Pending ops (IDB)</p>
              <p className="font-bold text-stone-800 text-sm">{pendingOps}</p>
            </div>
            <div className="bg-stone-50 rounded-lg px-3 py-2">
              <p className="text-[10px] text-stone-400 mb-0.5">Network</p>
              <p className={`font-bold text-sm ${isOnline ? 'text-green-700' : 'text-amber-700'}`}>
                {isOnline ? 'Online' : 'Offline'}
              </p>
            </div>
          </div>

          {Object.keys(statusBreakdown).length > 0 && (
            <div>
              <p className="text-[10px] text-stone-400 mb-1.5 uppercase tracking-wide">Status breakdown</p>
              <div className="space-y-1">
                {Object.entries(statusBreakdown).map(([status, count]) => (
                  <div key={status} className="flex items-center justify-between bg-stone-50 rounded-lg px-3 py-1.5">
                    <span className="text-stone-600">{status}</span>
                    <span className="font-bold text-stone-800">{count}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {Object.keys(sourceBreakdown).length > 0 && (
            <div>
              <p className="text-[10px] text-stone-400 mb-1.5 uppercase tracking-wide">Source breakdown</p>
              <div className="space-y-1">
                {Object.entries(sourceBreakdown).map(([src, count]) => (
                  <div key={src} className="flex items-center justify-between bg-stone-50 rounded-lg px-3 py-1.5">
                    <span className="text-stone-600">{src}</span>
                    <span className="font-bold text-stone-800">{count}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {items.length > 0 && (
            <div>
              <p className="text-[10px] text-stone-400 mb-1.5 uppercase tracking-wide">Raw records</p>
              <div className="space-y-1 max-h-48 overflow-y-auto">
                {items.map(item => (
                  <div key={item.id} className="bg-stone-50 rounded-lg px-3 py-2 text-[10px] leading-relaxed">
                    <p className="font-bold text-stone-700 truncate">{getDisplayName(item)}</p>
                    <p className="text-stone-400">status: <span className="text-stone-600">{item.status}</span></p>
                    <p className="text-stone-400">method: <span className="text-stone-600">{item.captureMethod ?? 'null'}</span></p>
                    <p className="text-stone-400 truncate">id: <span className="text-stone-600">{item.id.slice(0, 24)}…</span></p>
                    <p className="text-stone-400">updated: <span className="text-stone-600">{relativeTime(item.updatedAt)}</span></p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Empty state ──────────────────────────────────────────────────────────────

function EmptyState({ filter, onCapture }: { filter: FilterTab; onCapture: () => void }) {
  const msgs: Record<FilterTab, { title: string; body: string }> = {
    all:     { title: 'No leads in queue',      body: 'Captured leads will appear here. Start with a business card, QR scan, or manual entry.' },
    pending: { title: 'Nothing pending',         body: 'All captured leads are up to date.' },
    failed:  { title: 'No failed syncs',         body: 'All leads synced successfully.' },
    drafts:  { title: 'No saved drafts',         body: 'Drafts appear here when you start a capture and navigate away.' },
    synced:  { title: 'No synced leads yet',     body: 'Leads confirmed on the server will appear here.' },
  };
  const { title, body } = msgs[filter];

  return (
    <div className="flex flex-col items-center justify-center py-16 px-8 text-center">
      <div className="w-16 h-16 rounded-2xl bg-stone-100 flex items-center justify-center mb-4">
        <Inbox className="w-8 h-8 text-stone-300" />
      </div>
      <p className="text-sm font-semibold text-stone-700 mb-1">{title}</p>
      <p className="text-xs text-stone-400 leading-relaxed mb-6">{body}</p>
      {filter === 'all' && (
        <button
          onClick={onCapture}
          className="flex items-center gap-2 px-5 py-3 rounded-xl bg-stone-900 hover:bg-stone-800
            text-white text-sm font-semibold transition-colors active:scale-[0.97]"
        >
          <Plus className="w-4 h-4" /> Capture New Lead
        </button>
      )}
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

interface Props {
  onCapture:    () => void;
  onContinueDraft: (sessionId: string) => void;
  onViewLead?:  (backendSessionId: string) => void;
}

export default function LeadQueuePage({ onCapture, onContinueDraft, onViewLead }: Props) {
  const [items,       setItems]       = useState<QueueItem[]>([]);
  const [loading,     setLoading]     = useState(true);
  const [filter,      setFilter]      = useState<FilterTab>('all');
  const [search,      setSearch]      = useState('');
  const [pendingOps,  setPendingOps]  = useState(0);
  const [isFlushing,  setIsFlushing]  = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<QueueItem | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const handleReconnect = useCallback(async () => {
    setIsFlushing(true);
    try { await flushQueue(); }
    finally {
      setIsFlushing(false);
      getPendingCount().then(setPendingOps);
      loadQueueItems().then(setItems);
    }
  }, []);

  const isOnline = useOnlineStatus({ onReconnect: handleReconnect });

  const reload = useCallback(async () => {
    const [loadedItems, pendingCount] = await Promise.all([
      loadQueueItems(),
      getPendingCount(),
    ]);
    setItems(loadedItems);
    setPendingOps(pendingCount);
    setLoading(false);
  }, []);

  useEffect(() => { reload(); }, [reload]);

  // Filter + search
  const filtered = useMemo(() => {
    let list = items.filter(i => matchesFilter(i, filter));
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter(i =>
        getDisplayName(i).toLowerCase().includes(q) ||
        (i.draftData.company ?? '').toLowerCase().includes(q),
      );
    }
    return list;
  }, [items, filter, search]);

  // Group by section
  const sections = useMemo(() => {
    const groups: Record<string, QueueItem[]> = {};
    for (const item of filtered) {
      const section = STATUS_CONFIG[item.status].section;
      if (!groups[section]) groups[section] = [];
      groups[section].push(item);
    }
    return SECTION_ORDER
      .filter(s => groups[s]?.length > 0)
      .map(s => ({ title: s, items: groups[s] }));
  }, [filtered]);

  // Badge counts for filter tabs
  const counts = useMemo(() => {
    const c: Record<FilterTab, number> = { all: 0, pending: 0, failed: 0, drafts: 0, synced: 0 };
    for (const item of items) {
      c.all++;
      if (
        item.status === 'pending_sync' || item.status === 'syncing' ||
        item.status === 'local_only'   || item.status === 'needs_review'
      ) c.pending++;
      if (item.status === 'failed')  c.failed++;
      if (item.status === 'draft')   c.drafts++;
      if (item.status === 'synced')  c.synced++;
    }
    return c;
  }, [items]);

  const handleDelete = useCallback(async (item: QueueItem) => {
    await deleteQueueItem(item.id);
    setItems(prev => prev.filter(i => i.id !== item.id));
    setDeleteTarget(null);
  }, []);

  const handleRetry = useCallback(async (item: QueueItem) => {
    if (!isOnline) return;
    setIsFlushing(true);
    try { await flushQueue(); }
    finally { setIsFlushing(false); reload(); }
  }, [isOnline, reload]);

  const handleContinue = useCallback((item: QueueItem) => {
    onContinueDraft(item.id);
  }, [onContinueDraft]);

  const handleView = useCallback((item: QueueItem) => {
    if (item.backendSessionId && onViewLead) onViewLead(item.backendSessionId);
  }, [onViewLead]);

  const urgentCount = counts.failed + counts.pending;

  return (
    <div className="min-h-[calc(100vh-57px)] bg-stone-50">
      <div className="w-full max-w-lg mx-auto px-4 pt-8 pb-24">

        {/* ── Header ── */}
        <div className="mb-6">
          <div className="flex items-start justify-between">
            <div>
              <h1 className="text-2xl font-bold text-stone-900 tracking-tight">Lead Queue</h1>
              <p className="mt-1 text-sm text-stone-500">
                {loading ? 'Loading…' :
                 items.length === 0 ? 'No leads captured yet' :
                 `${items.length} lead${items.length !== 1 ? 's' : ''} captured`}
              </p>
            </div>

            {/* Sync status pill */}
            <div className="flex items-center gap-2 mt-1">
              {isFlushing ? (
                <span className="flex items-center gap-1.5 text-xs font-medium text-blue-600 bg-blue-50
                  border border-blue-200 rounded-full px-2.5 py-1">
                  <Loader2 className="w-3 h-3 animate-spin" /> Syncing…
                </span>
              ) : !isOnline ? (
                <span className="flex items-center gap-1.5 text-xs font-medium text-amber-700 bg-amber-50
                  border border-amber-200 rounded-full px-2.5 py-1">
                  <WifiOff className="w-3 h-3" /> Offline
                </span>
              ) : pendingOps > 0 ? (
                <span className="flex items-center gap-1.5 text-xs font-medium text-blue-600 bg-blue-50
                  border border-blue-200 rounded-full px-2.5 py-1">
                  <Clock className="w-3 h-3" /> {pendingOps} pending
                </span>
              ) : (
                <span className="flex items-center gap-1.5 text-xs font-medium text-green-700 bg-green-50
                  border border-green-200 rounded-full px-2.5 py-1">
                  <Wifi className="w-3 h-3" /> Online
                </span>
              )}

              <button
                onClick={reload}
                className="w-8 h-8 rounded-full bg-white border border-stone-200 flex items-center justify-center
                  text-stone-500 hover:bg-stone-50 active:bg-stone-100 active:scale-95 transition-all"
                aria-label="Refresh queue"
              >
                <RefreshCw className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          {/* Offline sync banner */}
          {!isOnline && pendingOps > 0 && (
            <div className="mt-3 rounded-xl bg-amber-50 border border-amber-200 px-4 py-3 flex items-start gap-3">
              <WifiOff className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-semibold text-amber-900 leading-tight">
                  {pendingOps} lead{pendingOps !== 1 ? 's' : ''} waiting to sync
                </p>
                <p className="text-xs text-amber-700 mt-0.5">
                  Saved safely offline. Will sync automatically when connected.
                </p>
              </div>
            </div>
          )}

          {/* Failed leads banner */}
          {counts.failed > 0 && isOnline && (
            <div className="mt-3 rounded-xl bg-red-50 border border-red-200 px-4 py-3 flex items-center gap-3">
              <AlertCircle className="w-4 h-4 text-red-500 shrink-0" />
              <div className="flex-1">
                <p className="text-sm font-semibold text-red-800 leading-tight">
                  {counts.failed} lead{counts.failed !== 1 ? 's' : ''} failed to sync
                </p>
                <p className="text-xs text-red-600 mt-0.5">Saved offline safely — retry when ready</p>
              </div>
              <button
                onClick={() => {
                  setIsFlushing(true);
                  flushQueue().finally(() => { setIsFlushing(false); reload(); });
                }}
                className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-red-100
                  hover:bg-red-200 text-red-800 text-xs font-semibold transition-colors shrink-0"
              >
                <RotateCcw className="w-3.5 h-3.5" /> Retry All
              </button>
            </div>
          )}
        </div>

        {/* ── Search bar ── */}
        <div className="relative mb-4">
          <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-stone-400 pointer-events-none" />
          <input
            ref={searchRef}
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search by name or company…"
            className="w-full pl-10 pr-10 py-3 rounded-xl border border-stone-200 bg-white
              text-sm text-stone-900 placeholder:text-stone-400
              focus:outline-none focus:border-stone-400 focus:ring-1 focus:ring-stone-100 transition-all"
          />
          {search && (
            <button
              onClick={() => setSearch('')}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-stone-400 hover:text-stone-600"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>

        {/* ── Filter tabs ── */}
        <div className="flex gap-1.5 mb-6 overflow-x-auto pb-1 -mx-1 px-1 no-scrollbar">
          {FILTER_TABS.map(tab => {
            const cnt = counts[tab.id];
            const active = filter === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => setFilter(tab.id)}
                className={[
                  'flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-sm font-medium',
                  'whitespace-nowrap shrink-0 transition-all active:scale-[0.97]',
                  active
                    ? 'bg-stone-900 text-white shadow-sm'
                    : 'bg-white border border-stone-200 text-stone-600 hover:border-stone-300',
                ].join(' ')}
              >
                {tab.label}
                {cnt > 0 && (
                  <span className={`text-[11px] font-semibold rounded-full px-1.5 py-0.5 min-w-[18px] text-center ${
                    active ? 'bg-white/20 text-white' : 'bg-stone-100 text-stone-500'
                  }`}>{cnt}</span>
                )}
              </button>
            );
          })}
        </div>

        {/* ── Content ── */}
        {loading ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="w-6 h-6 text-stone-400 animate-spin" />
          </div>
        ) : filtered.length === 0 ? (
          <EmptyState filter={filter} onCapture={onCapture} />
        ) : (
          <div className="space-y-6">
            {sections.map(section => (
              <QueueSection
                key={section.title}
                title={section.title}
                count={section.items.length}
                items={section.items}
                isOnline={isOnline}
                defaultOpen={section.title !== 'Synced'}
                onContinue={handleContinue}
                onRetry={handleRetry}
                onDelete={(item) => setDeleteTarget(item)}
                onView={handleView}
              />
            ))}
          </div>
        )}

        {/* ── Debug panel ── */}
        {!loading && <QueueDebugPanel items={items} filtered={filtered} pendingOps={pendingOps} isOnline={isOnline} />}

        {/* ── FAB — Capture new lead ── */}
        {!loading && (
          <div className="fixed bottom-[calc(4rem+env(safe-area-inset-bottom))] right-4 md:bottom-6 md:right-6 z-30">
            <button
              onClick={onCapture}
              className="flex items-center gap-2 px-4 py-3.5 rounded-full
                bg-stone-900 hover:bg-stone-800 active:scale-[0.97]
                text-white text-sm font-semibold shadow-lg shadow-stone-900/20
                transition-all"
            >
              <Plus className="w-4 h-4" />
              <span className="hidden sm:inline">Capture Lead</span>
              <span className="sm:hidden">New</span>
            </button>
          </div>
        )}
      </div>

      {/* ── Delete confirmation ── */}
      {deleteTarget && (
        <DeleteSheet
          item={deleteTarget}
          onConfirm={() => handleDelete(deleteTarget)}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
    </div>
  );
}
