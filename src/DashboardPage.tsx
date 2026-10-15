import { DASHBOARD_RANGES, getDashboardDateBounds, type DashboardRange } from './dashboardDateRange';
import DashboardWhatsAppSection from './DashboardWhatsAppSection';
import { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import { useAuth } from './AuthContext';
import { useOnlineStatus } from './capture/useOnlineStatus';
import {
  DashboardMetricsLoader,
  EMPTY_DASHBOARD,
  identityKey,
  deriveDisplayState,
  type DashboardData,
} from './dashboardMetricsLoader';
import {
  TodaysFollowUpsLoader,
  deriveFollowUpTileState,
  type FollowUpCountResult,
  ERR_FOLLOWUP_SIGN_IN,
  ERR_FOLLOWUP_WAITING,
} from './todaysFollowUpsLoader';
import {
  SamplesOpenLoader,
  deriveSamplesOpenTileState,
  type SamplesOpenCountResult,
  ERR_SAMPLES_SIGN_IN,
  ERR_SAMPLES_WAITING,
} from './samplesOpenLoader';
import {
  UnreadConversationsLoader,
  deriveUnreadTileState,
  type UnreadConversationsCountResult,
  ERR_UNREAD_SIGN_IN,
  ERR_UNREAD_WAITING,
} from './unreadConversationsLoader';
import {
  InvalidLeadsLoader,
  deriveInvalidLeadsTileState,
  type InvalidLeadsCountResult,
  ERR_INVALID_SIGN_IN,
  ERR_INVALID_WAITING,
} from './invalidLeadsLoader';
import {
  RequiresReviewLoader,
  deriveRequiresReviewTileState,
  type RequiresReviewCountResult,
  ERR_REVIEW_SIGN_IN,
  ERR_REVIEW_WAITING,
} from './requiresReviewLoader';
import {
  Users,
  MessageCircle, AlertCircle, XCircle,
  PhoneCall, Star, CheckCircle2, HeartCrack,
  Loader2, RefreshCw, ArrowRight, Flame, Sun, Snowflake, HelpCircle, UserX,
  CalendarClock, FlaskConical, ShieldAlert,
} from 'lucide-react';

const EMPTY = EMPTY_DASHBOARD;

function num(n: number) {
  return n.toLocaleString('en-IN');
}

function pct(part: number, total: number) {
  if (!total) return 0;
  return Math.round((part / total) * 100);
}

export interface DashboardFilter {
  dateFrom?: string;
  dateTo?: string;
  whatsappStatuses?: string[];
  dateFilter?: 'today' | '7days' | '30days';
  systemStatus?: string;
  leadStatus?: string;
  temperature?: string;
}

interface KpiCardProps {
  icon: React.ReactNode;
  label: string;
  value: number;
  color: 'blue' | 'green' | 'red' | 'yellow' | 'stone';
  sub?: string;
  onClick?: () => void;
}

const COLOR_MAP = {
  blue:   { bg: 'bg-blue-50',   border: 'border-blue-100',   icon: 'text-blue-500',   val: 'text-blue-700',   sub: 'text-blue-400',   hover: 'hover:border-blue-300 hover:shadow-md' },
  green:  { bg: 'bg-green-50',  border: 'border-green-100',  icon: 'text-green-500',  val: 'text-green-700',  sub: 'text-green-400',  hover: 'hover:border-green-300 hover:shadow-md' },
  red:    { bg: 'bg-red-50',    border: 'border-red-100',    icon: 'text-red-500',    val: 'text-red-700',    sub: 'text-red-400',    hover: 'hover:border-red-300 hover:shadow-md' },
  yellow: { bg: 'bg-yellow-50', border: 'border-yellow-100', icon: 'text-yellow-500', val: 'text-yellow-700', sub: 'text-yellow-400', hover: 'hover:border-yellow-300 hover:shadow-md' },
  stone:  { bg: 'bg-stone-50',  border: 'border-stone-100',  icon: 'text-stone-400',  val: 'text-stone-700',  sub: 'text-stone-400',  hover: 'hover:border-stone-300 hover:shadow-md' },
};

function KpiCard({ icon, label, value, color, sub, onClick }: KpiCardProps) {
  const c = COLOR_MAP[color];
  const clickable = !!onClick;
  return (
    <div
      className={`rounded-xl border ${c.bg} ${c.border} px-5 py-4 flex items-start gap-4 transition-all duration-150 ${clickable ? `cursor-pointer ${c.hover} active:scale-[0.98]` : ''}`}
      onClick={onClick}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      onKeyDown={clickable ? (e) => { if (e.key === 'Enter' || e.key === ' ') onClick?.(); } : undefined}
    >
      <div className={`mt-0.5 flex-shrink-0 ${c.icon}`}>{icon}</div>
      <div className="min-w-0 flex-1">
        <p className="text-xs text-stone-500 font-medium mb-1">{label}</p>
        <p className={`text-2xl font-bold tabular-nums leading-none ${c.val}`}>{num(value)}</p>
        {sub && <p className={`text-xs mt-1 ${c.sub}`}>{sub}</p>}
      </div>
      {clickable && (
        <ArrowRight className="w-3.5 h-3.5 text-stone-300 self-center flex-shrink-0 mt-0.5" />
      )}
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="text-xs font-semibold text-stone-400 uppercase tracking-widest mb-3">{children}</h2>
  );
}

interface DashboardPageProps {
  onNavigateToLeads?: (filter: DashboardFilter) => void;
  onNavigateToFollowUps?: () => void;
  onNavigateToConversations?: () => void;
  onNavigateToConversationsUnread?: () => void;
  onNavigateToInvalidLeads?: () => void;
  onNavigateToRequiresReview?: () => void;
}

interface FollowUpAttentionTileProps {
  phase: 'loading' | 'success' | 'error' | 'unavailable';
  count: number;
  onNavigate?: () => void;
  onRetry?: () => void;
}

function FollowUpAttentionTile({ phase, count, onNavigate, onRetry }: FollowUpAttentionTileProps) {
  const handleClick = phase === 'error' ? onRetry : phase === 'success' ? onNavigate : undefined;
  const clickable = !!handleClick;

  return (
    <div
      className={`rounded-xl border px-5 py-4 flex items-center gap-4 transition-all duration-150
        ${clickable ? 'cursor-pointer hover:border-amber-300 hover:shadow-md active:scale-[0.98]' : ''}
        bg-amber-50 border-amber-100`}
      onClick={clickable ? handleClick : undefined}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      onKeyDown={clickable ? (e) => { if (e.key === 'Enter' || e.key === ' ') handleClick?.(); } : undefined}
    >
      <div className="mt-0.5 flex-shrink-0 text-amber-600">
        <CalendarClock className="w-5 h-5" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-xs text-amber-700 font-medium mb-1">Today's Follow-Ups</p>
        {phase === 'loading' ? (
          <div className="flex items-center gap-2">
            <Loader2 className="w-4 h-4 text-amber-400 animate-spin" />
            <span className="text-sm text-amber-500">Loading…</span>
          </div>
        ) : phase === 'error' ? (
          <div className="flex items-center gap-2">
            <AlertCircle className="w-4 h-4 text-red-400" />
            <span className="text-sm text-red-500">Couldn't load — tap to retry</span>
          </div>
        ) : phase === 'unavailable' ? (
          <div className="flex items-center gap-2">
            <AlertCircle className="w-4 h-4 text-stone-400" />
            <span className="text-sm text-stone-500">Unavailable</span>
          </div>
        ) : (
          <>
            <p className="text-2xl font-bold tabular-nums leading-none text-amber-800">
              {count}
            </p>
            <p className="text-xs text-amber-500 mt-1">
              {count === 1 ? 'pending follow-up due today' : 'pending follow-ups due today'}
            </p>
          </>
        )}
      </div>
      {clickable && (
        <ArrowRight className="w-3.5 h-3.5 text-amber-300 self-center flex-shrink-0 mt-0.5" />
      )}
    </div>
  );
}

function SamplesOpenAttentionTile({ phase, count, onNavigate, onRetry }: FollowUpAttentionTileProps) {
  const handleClick = phase === 'error' ? onRetry : phase === 'success' ? onNavigate : undefined;
  const clickable = !!handleClick;

  return (
    <div
      className={`rounded-xl border px-5 py-4 flex items-center gap-4 transition-all duration-150
        ${clickable ? 'cursor-pointer hover:border-amber-300 hover:shadow-md active:scale-[0.98]' : ''}
        bg-amber-50 border-amber-100`}
      onClick={clickable ? handleClick : undefined}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      onKeyDown={clickable ? (e) => { if (e.key === 'Enter' || e.key === ' ') handleClick?.(); } : undefined}
    >
      <div className="mt-0.5 flex-shrink-0 text-amber-600">
        <FlaskConical className="w-5 h-5" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-xs text-amber-700 font-medium mb-1">Samples: Open</p>
        {phase === 'loading' ? (
          <div className="flex items-center gap-2">
            <Loader2 className="w-4 h-4 text-amber-400 animate-spin" />
            <span className="text-sm text-amber-500">Loading…</span>
          </div>
        ) : phase === 'error' ? (
          <div className="flex items-center gap-2">
            <AlertCircle className="w-4 h-4 text-red-400" />
            <span className="text-sm text-red-500">Couldn't load — tap to retry</span>
          </div>
        ) : phase === 'unavailable' ? (
          <div className="flex items-center gap-2">
            <AlertCircle className="w-4 h-4 text-stone-400" />
            <span className="text-sm text-stone-500">Unavailable</span>
          </div>
        ) : (
          <>
            <p className="text-2xl font-bold tabular-nums leading-none text-amber-800">
              {count}
            </p>
            <p className="text-xs text-amber-500 mt-1">
              {count === 1 ? 'conversation with open samples request' : 'conversations with open samples requests'}
            </p>
          </>
        )}
      </div>
      {clickable && (
        <ArrowRight className="w-3.5 h-3.5 text-amber-300 self-center flex-shrink-0 mt-0.5" />
      )}
    </div>
  );
}

function UnreadConversationsAttentionTile({ phase, count, onNavigate, onRetry }: FollowUpAttentionTileProps) {
  const handleClick = phase === 'error' ? onRetry : phase === 'success' ? onNavigate : undefined;
  const clickable = !!handleClick;

  return (
    <div
      className={`rounded-xl border px-5 py-4 flex items-center gap-4 transition-all duration-150
        ${clickable ? 'cursor-pointer hover:border-amber-300 hover:shadow-md active:scale-[0.98]' : ''}
        bg-amber-50 border-amber-100`}
      onClick={clickable ? handleClick : undefined}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      onKeyDown={clickable ? (e) => { if (e.key === 'Enter' || e.key === ' ') handleClick?.(); } : undefined}
    >
      <div className="mt-0.5 flex-shrink-0 text-amber-600">
        <MessageCircle className="w-5 h-5" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-xs text-amber-700 font-medium mb-1">Unread Conversations</p>
        {phase === 'loading' ? (
          <div className="flex items-center gap-2">
            <Loader2 className="w-4 h-4 text-amber-400 animate-spin" />
            <span className="text-sm text-amber-500">Loading…</span>
          </div>
        ) : phase === 'error' ? (
          <div className="flex items-center gap-2">
            <AlertCircle className="w-4 h-4 text-red-400" />
            <span className="text-sm text-red-500">Couldn't load — tap to retry</span>
          </div>
        ) : phase === 'unavailable' ? (
          <div className="flex items-center gap-2">
            <AlertCircle className="w-4 h-4 text-stone-400" />
            <span className="text-sm text-stone-500">Unavailable</span>
          </div>
        ) : (
          <>
            <p className="text-2xl font-bold tabular-nums leading-none text-amber-800">
              {count}
            </p>
            <p className="text-xs text-amber-500 mt-1">
              {count === 1 ? 'conversation with unread messages' : 'conversations with unread messages'}
            </p>
          </>
        )}
      </div>
      {clickable && (
        <ArrowRight className="w-3.5 h-3.5 text-amber-300 self-center flex-shrink-0 mt-0.5" />
      )}
    </div>
  );
}

function InvalidLeadsAttentionTile({ phase, count, onNavigate, onRetry }: FollowUpAttentionTileProps) {
  const handleClick = phase === 'error' ? onRetry : phase === 'success' ? onNavigate : undefined;
  const clickable = !!handleClick;

  return (
    <div
      className={`rounded-xl border px-5 py-4 flex items-center gap-4 transition-all duration-150
        ${clickable ? 'cursor-pointer hover:border-amber-300 hover:shadow-md active:scale-[0.98]' : ''}
        bg-amber-50 border-amber-100`}
      onClick={clickable ? handleClick : undefined}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      onKeyDown={clickable ? (e) => { if (e.key === 'Enter' || e.key === ' ') handleClick?.(); } : undefined}
    >
      <div className="mt-0.5 flex-shrink-0 text-amber-600">
        <XCircle className="w-5 h-5" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-xs text-amber-700 font-medium mb-1">Invalid Leads</p>
        {phase === 'loading' ? (
          <div className="flex items-center gap-2">
            <Loader2 className="w-4 h-4 text-amber-400 animate-spin" />
            <span className="text-sm text-amber-500">Loading…</span>
          </div>
        ) : phase === 'error' ? (
          <div className="flex items-center gap-2">
            <AlertCircle className="w-4 h-4 text-red-400" />
            <span className="text-sm text-red-500">Couldn't load — tap to retry</span>
          </div>
        ) : phase === 'unavailable' ? (
          <div className="flex items-center gap-2">
            <AlertCircle className="w-4 h-4 text-stone-400" />
            <span className="text-sm text-stone-500">Unavailable</span>
          </div>
        ) : (
          <>
            <p className="text-2xl font-bold tabular-nums leading-none text-amber-800">
              {count}
            </p>
            <p className="text-xs text-amber-500 mt-1">
              {count === 1 ? 'lead marked invalid' : 'leads marked invalid'}
            </p>
          </>
        )}
      </div>
      {clickable && (
        <ArrowRight className="w-3.5 h-3.5 text-amber-300 self-center flex-shrink-0 mt-0.5" />
      )}
    </div>
  );
}

function RequiresReviewAttentionTile({ phase, count, onNavigate, onRetry }: FollowUpAttentionTileProps) {
  const handleClick = phase === 'error' ? onRetry : phase === 'success' ? onNavigate : undefined;
  const clickable = !!handleClick;

  return (
    <div
      className={`rounded-xl border px-5 py-4 flex items-center gap-4 transition-all duration-150
        ${clickable ? 'cursor-pointer hover:border-amber-300 hover:shadow-md active:scale-[0.98]' : ''}
        bg-amber-50 border-amber-100`}
      onClick={clickable ? handleClick : undefined}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      onKeyDown={clickable ? (e) => { if (e.key === 'Enter' || e.key === ' ') handleClick?.(); } : undefined}
    >
      <div className="mt-0.5 flex-shrink-0 text-amber-600">
        <ShieldAlert className="w-5 h-5" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-xs text-amber-700 font-medium mb-1">Requires Review</p>
        {phase === 'loading' ? (
          <div className="flex items-center gap-2">
            <Loader2 className="w-4 h-4 text-amber-400 animate-spin" />
            <span className="text-sm text-amber-500">Loading…</span>
          </div>
        ) : phase === 'error' ? (
          <div className="flex items-center gap-2">
            <AlertCircle className="w-4 h-4 text-red-400" />
            <span className="text-sm text-red-500">Couldn't load — tap to retry</span>
          </div>
        ) : phase === 'unavailable' ? (
          <div className="flex items-center gap-2">
            <AlertCircle className="w-4 h-4 text-stone-400" />
            <span className="text-sm text-stone-500">Unavailable</span>
          </div>
        ) : (
          <>
            <p className="text-2xl font-bold tabular-nums leading-none text-amber-800">
              {count}
            </p>
            <p className="text-xs text-amber-500 mt-1">
              {count === 1 ? 'lead awaiting review' : 'leads awaiting review'}
            </p>
          </>
        )}
      </div>
      {clickable && (
        <ArrowRight className="w-3.5 h-3.5 text-amber-300 self-center flex-shrink-0 mt-0.5" />
      )}
    </div>
  );
}

export default function DashboardPage({ onNavigateToLeads, onNavigateToFollowUps, onNavigateToConversations, onNavigateToConversationsUnread, onNavigateToInvalidLeads, onNavigateToRequiresReview }: DashboardPageProps) {
  const { user, authMode } = useAuth();
  const [analyticsRange, setAnalyticsRange] = useState<DashboardRange>('30days');
  const [rangeRefresh, setRangeRefresh] = useState(0);
  const bounds = useMemo(() => getDashboardDateBounds(analyticsRange), [analyticsRange, rangeRefresh]);
  const nav = (f: DashboardFilter) => onNavigateToLeads?.({ dateFrom: bounds.dateFrom, dateTo: bounds.dateTo, ...f });
  const currentIdentity = identityKey(user);

  const [whatsappRefresh, setWhatsappRefresh] = useState(0);
  const analyticsIdentity = currentIdentity ? `${currentIdentity}|${bounds.from}|${bounds.before}` : null;
  const analyticsIdentityRef = useRef(analyticsIdentity);
  analyticsIdentityRef.current = analyticsIdentity;
  const [data, setData] = useState<DashboardData>(EMPTY);
  const [dataIdentity, setDataIdentity] = useState<string | null>(null);
  const [errorIdentity, setErrorIdentity] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const isAdmin = user?.role === 'admin';

  const loaderRef = useRef<DashboardMetricsLoader | null>(null);
  if (!loaderRef.current) loaderRef.current = new DashboardMetricsLoader();

  const fuLoaderRef = useRef<TodaysFollowUpsLoader | null>(null);
  if (!fuLoaderRef.current) fuLoaderRef.current = new TodaysFollowUpsLoader();

  const [fuCount, setFuCount] = useState<number | null>(null);
  const [fuLoading, setFuLoading] = useState(true);
  const [fuError, setFuError] = useState(false);
  const [fuUnavailable, setFuUnavailable] = useState(false);
  const [fuIdentity, setFuIdentity] = useState<string | null>(null);

  const soLoaderRef = useRef<SamplesOpenLoader | null>(null);
  if (!soLoaderRef.current) soLoaderRef.current = new SamplesOpenLoader();

  const [soCount, setSoCount] = useState<number | null>(null);
  const [soLoading, setSoLoading] = useState(true);
  const [soError, setSoError] = useState(false);
  const [soUnavailable, setSoUnavailable] = useState(false);
  const [soIdentity, setSoIdentity] = useState<string | null>(null);

  const ucLoaderRef = useRef<UnreadConversationsLoader | null>(null);
  if (!ucLoaderRef.current) ucLoaderRef.current = new UnreadConversationsLoader();

  const [ucCount, setUcCount] = useState<number | null>(null);
  const [ucLoading, setUcLoading] = useState(true);
  const [ucError, setUcError] = useState(false);
  const [ucUnavailable, setUcUnavailable] = useState(false);
  const [ucIdentity, setUcIdentity] = useState<string | null>(null);

  const ilLoaderRef = useRef<InvalidLeadsLoader | null>(null);
  if (!ilLoaderRef.current) ilLoaderRef.current = new InvalidLeadsLoader();

  const [ilCount, setIlCount] = useState<number | null>(null);
  const [ilLoading, setIlLoading] = useState(true);
  const [ilError, setIlError] = useState(false);
  const [ilUnavailable, setIlUnavailable] = useState(false);
  const [ilIdentity, setIlIdentity] = useState<string | null>(null);

  const rrLoaderRef = useRef<RequiresReviewLoader | null>(null);
  if (!rrLoaderRef.current) rrLoaderRef.current = new RequiresReviewLoader();

  const [rrCount, setRrCount] = useState<number | null>(null);
  const [rrLoading, setRrLoading] = useState(true);
  const [rrError, setRrError] = useState(false);
  const [rrUnavailable, setRrUnavailable] = useState(false);
  const [rrIdentity, setRrIdentity] = useState<string | null>(null);

  // Subscribe to transport connectivity. The returned boolean is a reactive
  // dependency that re-triggers the fetch effect when transport changes.
  const isOnline = useOnlineStatus();

  const fetchFollowUpCount = useCallback(async () => {
    const loader = fuLoaderRef.current!;
    setFuLoading(true);
    setFuError(false);
    setFuUnavailable(false);
    const result: FollowUpCountResult = await loader.load(currentIdentity, user);

    if (result.kind === 'stale') return;

    if (result.kind === 'error') {
      if (result.message === ERR_FOLLOWUP_SIGN_IN || result.message === ERR_FOLLOWUP_WAITING) {
        setFuCount(null);
        setFuUnavailable(true);
      } else {
        setFuError(true);
        setFuCount(null);
      }
      setFuIdentity(currentIdentity);
      setFuLoading(false);
      return;
    }

    setFuCount(result.count);
    setFuIdentity(currentIdentity);
    setFuLoading(false);
  }, [currentIdentity, user]);

  const fetchSamplesOpenCount = useCallback(async () => {
    const loader = soLoaderRef.current!;
    setSoLoading(true);
    setSoError(false);
    setSoUnavailable(false);
    const result: SamplesOpenCountResult = await loader.load(currentIdentity, user);

    if (result.kind === 'stale') return;

    if (result.kind === 'error') {
      if (result.message === ERR_SAMPLES_SIGN_IN || result.message === ERR_SAMPLES_WAITING) {
        setSoCount(null);
        setSoUnavailable(true);
      } else {
        setSoError(true);
        setSoCount(null);
      }
      setSoIdentity(currentIdentity);
      setSoLoading(false);
      return;
    }

    setSoCount(result.count);
    setSoIdentity(currentIdentity);
    setSoLoading(false);
  }, [currentIdentity, user]);

  const fetchUnreadCount = useCallback(async () => {
    const loader = ucLoaderRef.current!;
    setUcLoading(true);
    setUcError(false);
    setUcUnavailable(false);
    const result: UnreadConversationsCountResult = await loader.load(currentIdentity, user);

    if (result.kind === 'stale') return;

    if (result.kind === 'error') {
      if (result.message === ERR_UNREAD_SIGN_IN || result.message === ERR_UNREAD_WAITING) {
        setUcCount(null);
        setUcUnavailable(true);
      } else {
        setUcError(true);
        setUcCount(null);
      }
      setUcIdentity(currentIdentity);
      setUcLoading(false);
      return;
    }

    setUcCount(result.count);
    setUcIdentity(currentIdentity);
    setUcLoading(false);
  }, [currentIdentity, user]);

  const fetchInvalidLeadsCount = useCallback(async () => {
    const loader = ilLoaderRef.current!;
    setIlLoading(true);
    setIlError(false);
    setIlUnavailable(false);
    const result: InvalidLeadsCountResult = await loader.load(currentIdentity, user);

    if (result.kind === 'stale') return;

    if (result.kind === 'error') {
      if (result.message === ERR_INVALID_SIGN_IN || result.message === ERR_INVALID_WAITING) {
        setIlCount(null);
        setIlUnavailable(true);
      } else {
        setIlError(true);
        setIlCount(null);
      }
      setIlIdentity(currentIdentity);
      setIlLoading(false);
      return;
    }

    setIlCount(result.count);
    setIlIdentity(currentIdentity);
    setIlLoading(false);
  }, [currentIdentity, user]);

  const fetchRequiresReviewCount = useCallback(async () => {
    const loader = rrLoaderRef.current!;
    setRrLoading(true);
    setRrError(false);
    setRrUnavailable(false);
    const result: RequiresReviewCountResult = await loader.load(currentIdentity, user);

    if (result.kind === 'stale') return;

    if (result.kind === 'error') {
      if (result.message === ERR_REVIEW_SIGN_IN || result.message === ERR_REVIEW_WAITING) {
        setRrCount(null);
        setRrUnavailable(true);
      } else {
        setRrError(true);
        setRrCount(null);
      }
      setRrIdentity(currentIdentity);
      setRrLoading(false);
      return;
    }

    setRrCount(result.count);
    setRrIdentity(currentIdentity);
    setRrLoading(false);
  }, [currentIdentity, user]);

  const fetchData = useCallback(async () => {
    const loader = loaderRef.current!;
    setLoading(true);
    setError('');
    const result = await loader.load(currentIdentity, bounds);

    if (result.kind === 'stale' || analyticsIdentityRef.current !== analyticsIdentity) return;

    if (result.kind === 'error') {
      setError(result.message);
      setData(EMPTY);
      setDataIdentity(null);
      setErrorIdentity(analyticsIdentity);
      setLoading(false);
      return;
    }

    setData(result.data);
    setDataIdentity(analyticsIdentity);
    setErrorIdentity(null);
    setLoading(false);
  }, [currentIdentity, analyticsIdentity, bounds]);

  // ─── Main fetch effect ───────────────────────────────────────────────
  // Fires on mount, identity change, authMode change (reconnect resume),
  // and transport change (isOnline from useOnlineStatus).
  useEffect(() => {
    setData(EMPTY);
    setDataIdentity(null);
    setErrorIdentity(null);
    setLoading(true);
    setError('');
    loaderRef.current!.invalidate();
    fetchData();

  }, [fetchData, authMode, isOnline]);

  // Attention counts always reflect current work, independent of analytics dates.
  useEffect(() => {
    setFuCount(null);
    setFuIdentity(null);
    setFuError(false);
    setFuUnavailable(false);
    setFuLoading(true);
    fuLoaderRef.current!.invalidate();
    fetchFollowUpCount();

    setSoCount(null);
    setSoIdentity(null);
    setSoError(false);
    setSoUnavailable(false);
    setSoLoading(true);
    soLoaderRef.current!.invalidate();
    fetchSamplesOpenCount();

    setUcCount(null);
    setUcIdentity(null);
    setUcError(false);
    setUcUnavailable(false);
    setUcLoading(true);
    ucLoaderRef.current!.invalidate();
    fetchUnreadCount();

    setIlCount(null);
    setIlIdentity(null);
    setIlError(false);
    setIlUnavailable(false);
    setIlLoading(true);
    ilLoaderRef.current!.invalidate();
    fetchInvalidLeadsCount();

    setRrCount(null);
    setRrIdentity(null);
    setRrError(false);
    setRrUnavailable(false);
    setRrLoading(true);
    rrLoaderRef.current!.invalidate();
    fetchRequiresReviewCount();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchFollowUpCount, fetchSamplesOpenCount, fetchUnreadCount, fetchInvalidLeadsCount, fetchRequiresReviewCount, authMode, isOnline]);

  // Cleanup on unmount — invalidate only, don't permanently unmount.
  // In StrictMode, setup→cleanup→setup reuses the same loader instance;
  // unmount() would make it permanently unusable.
  useEffect(() => {
    return () => {
      loaderRef.current?.invalidate();
      fuLoaderRef.current?.invalidate();
      soLoaderRef.current?.invalidate();
      ucLoaderRef.current?.invalidate();
      ilLoaderRef.current?.invalidate();
      rrLoaderRef.current?.invalidate();
    };
  }, []);

  const { displayData, showLoading, showError, showUnavailable } = deriveDisplayState(
    loading, error, dataIdentity, errorIdentity, analyticsIdentity, data,
  );


  return (
    <div className="p-6 max-w-5xl mx-auto">
      {/* Page header */}
      <div className="mb-6 rounded-2xl bg-amber-50 border border-amber-100 px-5 py-5 sm:px-6 sm:py-6">
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
          <div className="min-w-0">
            <span className="text-xs font-semibold text-amber-700 uppercase tracking-widest">Dashboard</span>
            <h1 className="mt-1 text-2xl sm:text-3xl font-bold text-stone-900">
              {(() => {
                const firstName = (user?.name ?? '').trim().split(/\s+/).find(Boolean);
                return firstName ? `Hello ${firstName}` : 'Hello';
              })()}
            </h1>
            <p className="mt-0.5 text-sm text-stone-600">Hope you're having a great day.</p>
            <p className="text-xs text-stone-400 mt-2">
              {isAdmin ? 'All leads — admin view' : `Your leads — ${user?.rep_code}`}
            </p>
          </div>
          <button
            onClick={() => { setWhatsappRefresh(value => value + 1); setRangeRefresh(value => value + 1); fetchFollowUpCount(); fetchSamplesOpenCount(); fetchUnreadCount(); fetchInvalidLeadsCount(); fetchRequiresReviewCount(); }}
            disabled={showLoading}
            className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg border border-stone-200 bg-white text-stone-600 hover:bg-stone-50 transition disabled:opacity-50 self-start sm:self-auto flex-shrink-0"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${showLoading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>
      </div>

      {showError && (
        <div className="mb-5 flex flex-col items-start gap-3 px-4 py-3 bg-red-50 border border-red-200 text-red-700 text-sm rounded-xl">
          <div className="flex items-center gap-2">
            <AlertCircle className="w-4 h-4 flex-shrink-0" />
            {error}
          </div>
          <button
            onClick={fetchData}
            disabled={showLoading}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-red-200 bg-white text-red-700 hover:bg-red-50 transition disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${showLoading ? 'animate-spin' : ''}`} />
            Retry
          </button>
        </div>
      )}

      {/* ── Needs your attention ── */}
      {(() => {
        const tile = deriveFollowUpTileState(
          fuLoading, fuError, fuUnavailable, fuCount, fuIdentity, currentIdentity,
        );
        if (!tile) return null;
        const soTile = deriveSamplesOpenTileState(
          soLoading, soError, soUnavailable, soCount, soIdentity, currentIdentity,
        );
        return (
          <section className="mb-6">
            <SectionLabel>Needs your attention</SectionLabel>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <FollowUpAttentionTile
                phase={tile.phase}
                count={tile.count}
                onNavigate={tile.canNavigate ? onNavigateToFollowUps : undefined}
                onRetry={tile.canRetry ? fetchFollowUpCount : undefined}
              />
              {soTile && (
                <SamplesOpenAttentionTile
                  phase={soTile.phase}
                  count={soTile.count}
                  onNavigate={soTile.canNavigate ? onNavigateToConversations : undefined}
                  onRetry={soTile.canRetry ? fetchSamplesOpenCount : undefined}
                />
              )}
              {(() => {
                const ucTile = deriveUnreadTileState(
                  ucLoading, ucError, ucUnavailable, ucCount, ucIdentity, currentIdentity,
                );
                if (!ucTile || ucTile.phase === 'hidden') return null;
                return (
                  <UnreadConversationsAttentionTile
                    phase={ucTile.phase}
                    count={ucTile.count}
                    onNavigate={ucTile.canNavigate ? onNavigateToConversationsUnread : undefined}
                    onRetry={ucTile.canRetry ? fetchUnreadCount : undefined}
                  />
                );
              })()}
              {(() => {
                const ilTile = deriveInvalidLeadsTileState(
                  ilLoading, ilError, ilUnavailable, ilCount, ilIdentity, currentIdentity,
                );
                if (!ilTile) return null;
                return (
                  <InvalidLeadsAttentionTile
                    phase={ilTile.phase}
                    count={ilTile.count}
                    onNavigate={ilTile.canNavigate ? onNavigateToInvalidLeads : undefined}
                    onRetry={ilTile.canRetry ? fetchInvalidLeadsCount : undefined}
                  />
                );
              })()}
              {(() => {
                const rrTile = deriveRequiresReviewTileState(
                  rrLoading, rrError, rrUnavailable, rrCount, rrIdentity, currentIdentity,
                );
                if (!rrTile) return null;
                return (
                  <RequiresReviewAttentionTile
                    phase={rrTile.phase}
                    count={rrTile.count}
                    onNavigate={rrTile.canNavigate ? onNavigateToRequiresReview : undefined}
                    onRetry={rrTile.canRetry ? fetchRequiresReviewCount : undefined}
                  />
                );
              })()}
            </div>
          </section>
        );
      })()}

      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-5">
        <div>
          <h2 className="text-sm font-semibold text-stone-700">Lead analytics</h2>
          <p className="text-xs text-stone-500">Current status of leads created in the selected period. Attention items above always show current work.</p>
        </div>
        <label className="text-sm text-stone-600 flex items-center gap-2">
          Date range
          <select value={analyticsRange} onChange={e => setAnalyticsRange(e.target.value as DashboardRange)} className="rounded-lg border border-stone-200 bg-white px-3 py-2">
            {DASHBOARD_RANGES.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </label>
      </div>

      {showLoading ? (
        <div className="flex items-center justify-center py-24">
          <Loader2 className="w-6 h-6 text-stone-400 animate-spin" />
        </div>
      ) : showUnavailable ? (
        <div className="flex flex-col items-center justify-center py-24 px-4 text-center">
          <UserX className="w-10 h-10 text-stone-300 mb-4" />
          <p className="text-sm font-medium text-stone-600">Profile unavailable</p>
          <p className="text-xs text-stone-400 mt-1">Sign in to view dashboard metrics.</p>
        </div>
      ) : showError ? (
        null
      ) : (
        <div className="flex flex-col gap-8">

          {/* ── Top: Lead volume ── */}
          <section>
            <SectionLabel>Lead Volume</SectionLabel>
            <div className="max-w-sm">
              <KpiCard icon={<Users className="w-5 h-5" />} label="Leads in selected period" value={displayData.total_leads} color="blue"
                onClick={() => nav({})} />
            </div>
          </section>

          <DashboardWhatsAppSection bounds={bounds} refresh={whatsappRefresh} onNavigate={statuses => nav({ whatsappStatuses: statuses })} />

          {/* ── Bottom: Lead status ── */}
          <section>
            <SectionLabel>Lead Status Breakdown</SectionLabel>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <KpiCard icon={<PhoneCall className="w-5 h-5" />}    label="Contacted" value={displayData.contacted_leads} color="yellow"
                sub={`${pct(displayData.contacted_leads, displayData.total_leads)}% of total`}
                onClick={() => nav({ leadStatus: 'CONTACTED' })} />
              <KpiCard icon={<Star className="w-5 h-5" />}         label="Samples Sent" value={displayData.qualified_leads} color="yellow"
                sub={`${pct(displayData.qualified_leads, displayData.total_leads)}% of total`}
                onClick={() => nav({ leadStatus: 'QUALIFIED' })} />
              <KpiCard icon={<CheckCircle2 className="w-5 h-5" />} label="Converted" value={displayData.converted_leads} color="green"
                sub={`${pct(displayData.converted_leads, displayData.total_leads)}% of total`}
                onClick={() => nav({ leadStatus: 'CONVERTED' })} />
              <KpiCard icon={<HeartCrack className="w-5 h-5" />}   label="Lost"      value={displayData.lost_leads}      color="red"
                sub={`${pct(displayData.lost_leads, displayData.total_leads)}% of total`}
                onClick={() => nav({ leadStatus: 'LOST' })} />
            </div>
          </section>

          {/* ── Lead Temperature ── */}
          <section>
            <SectionLabel>Lead Temperature</SectionLabel>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <KpiCard icon={<Flame className="w-5 h-5" />}      label="Hot"        value={displayData.hot_leads} color="red"
                sub={`${pct(displayData.hot_leads, displayData.total_leads)}% of total`}
                onClick={() => nav({ temperature: 'Hot' })} />
              <KpiCard icon={<Sun className="w-5 h-5" />}        label="Warm"       value={displayData.warm_leads} color="yellow"
                sub={`${pct(displayData.warm_leads, displayData.total_leads)}% of total`}
                onClick={() => nav({ temperature: 'Warm' })} />
              <KpiCard icon={<Snowflake className="w-5 h-5" />}  label="Cold"       value={displayData.cold_leads} color="blue"
                sub={`${pct(displayData.cold_leads, displayData.total_leads)}% of total`}
                onClick={() => nav({ temperature: 'Cold' })} />
              <KpiCard icon={<HelpCircle className="w-5 h-5" />} label="Unassigned" value={displayData.unassigned_temperature_leads} color="stone"
                sub={`${pct(displayData.unassigned_temperature_leads, displayData.total_leads)}% of total`}
                onClick={() => nav({ temperature: '__unassigned__' })} />
            </div>
          </section>


        </div>
      )}
    </div>
  );
}
