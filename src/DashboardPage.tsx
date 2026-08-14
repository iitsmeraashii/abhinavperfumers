import { useEffect, useState } from 'react';
import { supabase } from './supabaseClient';
import { useAuth } from './AuthContext';
import {
  Users, TrendingUp, Calendar, Clock,
  MessageCircle, AlertCircle, XCircle,
  PhoneCall, Star, CheckCircle2, HeartCrack,
  Loader2, RefreshCw, ArrowRight,
} from 'lucide-react';

interface DashboardData {
  total_leads: number;
  leads_today: number;
  leads_last_7_days: number;
  leads_last_30_days: number;
  whatsapp_sent: number;
  whatsapp_failed: number;
  invalid_leads: number;
  new_leads: number;
  contacted_leads: number;
  qualified_leads: number;
  converted_leads: number;
  lost_leads: number;
}

const EMPTY: DashboardData = {
  total_leads: 0, leads_today: 0, leads_last_7_days: 0, leads_last_30_days: 0,
  whatsapp_sent: 0, whatsapp_failed: 0, invalid_leads: 0,
  new_leads: 0, contacted_leads: 0, qualified_leads: 0, converted_leads: 0, lost_leads: 0,
};

function num(n: number) {
  return n.toLocaleString('en-IN');
}

function pct(part: number, total: number) {
  if (!total) return 0;
  return Math.round((part / total) * 100);
}

export interface DashboardFilter {
  dateFilter?: 'today' | '7days' | '30days';
  systemStatus?: string;
  leadStatus?: string;
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

interface FunnelStepProps {
  label: string;
  value: number;
  total: number;
  color: string;
  bar: string;
  isLast?: boolean;
  onClick?: () => void;
}

function FunnelStep({ label, value, total, color, bar, isLast, onClick }: FunnelStepProps) {
  const width = pct(value, total);
  return (
    <div
      className={`flex-1 min-w-0 rounded-lg p-2 -m-2 transition-all duration-150 ${onClick ? 'cursor-pointer hover:bg-stone-50 active:scale-[0.98]' : ''}`}
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e) => { if (e.key === 'Enter' || e.key === ' ') onClick(); } : undefined}
    >
      <div className="flex items-end justify-between mb-1.5">
        <span className={`text-xs font-semibold ${color}`}>{label}</span>
        <span className="text-xs text-stone-500 tabular-nums">{num(value)}</span>
      </div>
      <div className="h-2 rounded-full bg-stone-100 overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-700 ${bar}`}
          style={{ width: `${width}%` }}
        />
      </div>
      <p className="text-xs text-stone-400 mt-1 tabular-nums">{width}% of total</p>
      {!isLast && (
        <div className="hidden sm:flex justify-end pr-1 mt-1">
          <ArrowRight className="w-3.5 h-3.5 text-stone-300" />
        </div>
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
}

export default function DashboardPage({ onNavigateToLeads }: DashboardPageProps) {
  const { user } = useAuth();
  const nav = (f: DashboardFilter) => onNavigateToLeads?.(f);
  const [data, setData] = useState<DashboardData>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const isAdmin = user?.role === 'admin';

  async function fetchData() {
    setLoading(true);
    setError('');

    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const d7 = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const d30 = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();

    let q = supabase.from('lead_entries').select(
      'created_at, system_status, lead_status'
    );
    if (!isAdmin && user?.rep_code) {
      q = q.eq('sales_rep_code', user.rep_code);
    }

    const { data: rows, error: err } = await q;

    if (err || !rows) {
      setError('Failed to load dashboard data.');
      setLoading(false);
      return;
    }

    const totals: DashboardData = { ...EMPTY };
    totals.total_leads = rows.length;

    for (const row of rows) {
      const ca = row.created_at ?? '';
      if (ca >= todayStart) totals.leads_today++;
      if (ca >= d7) totals.leads_last_7_days++;
      if (ca >= d30) totals.leads_last_30_days++;

      const ss = (row.system_status ?? '').toUpperCase();
      if (ss === 'WHATSAPP_SENT') totals.whatsapp_sent++;
      if (ss === 'WHATSAPP_FAILED') totals.whatsapp_failed++;
      if (ss === 'INVALID_LEAD') totals.invalid_leads++;

      const ls = (row.lead_status ?? '').toUpperCase();
      if (ls === 'NEW') totals.new_leads++;
      if (ls === 'CONTACTED') totals.contacted_leads++;
      if (ls === 'QUALIFIED') totals.qualified_leads++;
      if (ls === 'CONVERTED') totals.converted_leads++;
      if (ls === 'LOST') totals.lost_leads++;
    }

    setData(totals);
    setLoading(false);
  }

  useEffect(() => { fetchData(); }, [user]);

  const funnelTotal = data.total_leads || 1;

  return (
    <div className="p-6 max-w-5xl mx-auto">
      {/* Page header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-stone-900">Dashboard</h1>
          <p className="text-xs text-stone-400 mt-0.5">
            {isAdmin ? 'All leads — admin view' : `Your leads — ${user?.rep_code}`}
          </p>
        </div>
        <button
          onClick={fetchData}
          disabled={loading}
          className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg border border-stone-200 text-stone-600 hover:bg-stone-50 transition disabled:opacity-50"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      {error && (
        <div className="mb-5 flex items-center gap-2 px-4 py-3 bg-red-50 border border-red-200 text-red-700 text-sm rounded-xl">
          <AlertCircle className="w-4 h-4 flex-shrink-0" />
          {error}
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-24">
          <Loader2 className="w-6 h-6 text-stone-400 animate-spin" />
        </div>
      ) : (
        <div className="flex flex-col gap-8">

          {/* ── Top: Lead volume ── */}
          <section>
            <SectionLabel>Lead Volume</SectionLabel>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <KpiCard icon={<Users className="w-5 h-5" />}      label="Total Leads"  value={data.total_leads}        color="blue"
                onClick={() => nav({})} />
              <KpiCard icon={<TrendingUp className="w-5 h-5" />} label="Today"        value={data.leads_today}        color="blue" sub="since midnight"
                onClick={() => nav({ dateFilter: 'today' })} />
              <KpiCard icon={<Calendar className="w-5 h-5" />}   label="Last 7 Days"  value={data.leads_last_7_days}  color="blue"
                onClick={() => nav({ dateFilter: '7days' })} />
              <KpiCard icon={<Clock className="w-5 h-5" />}      label="Last 30 Days" value={data.leads_last_30_days} color="blue"
                onClick={() => nav({ dateFilter: '30days' })} />
            </div>
          </section>

          {/* ── Middle: WhatsApp & system ── */}
          <section>
            <SectionLabel>System Status</SectionLabel>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <KpiCard icon={<MessageCircle className="w-5 h-5" />} label="WhatsApp Sent"   value={data.whatsapp_sent}   color="green"
                sub={`${pct(data.whatsapp_sent, data.total_leads)}% of total`}
                onClick={() => nav({ systemStatus: 'WHATSAPP_SENT' })} />
              <KpiCard icon={<AlertCircle className="w-5 h-5" />}   label="WhatsApp Failed" value={data.whatsapp_failed}  color="red"
                sub={`${pct(data.whatsapp_failed, data.total_leads)}% of total`}
                onClick={() => nav({ systemStatus: 'WHATSAPP_FAILED' })} />
              <KpiCard icon={<XCircle className="w-5 h-5" />}       label="Invalid Leads"   value={data.invalid_leads}   color="stone"
                sub={`${pct(data.invalid_leads, data.total_leads)}% of total`}
                onClick={() => nav({ systemStatus: 'INVALID_LEAD' })} />
            </div>
          </section>

          {/* ── Bottom: Lead status ── */}
          <section>
            <SectionLabel>Lead Status Breakdown</SectionLabel>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <KpiCard icon={<PhoneCall className="w-5 h-5" />}    label="Contacted" value={data.contacted_leads} color="yellow"
                sub={`${pct(data.contacted_leads, data.total_leads)}% of total`}
                onClick={() => nav({ leadStatus: 'CONTACTED' })} />
              <KpiCard icon={<Star className="w-5 h-5" />}         label="Samples Sent" value={data.qualified_leads} color="yellow"
                sub={`${pct(data.qualified_leads, data.total_leads)}% of total`}
                onClick={() => nav({ leadStatus: 'QUALIFIED' })} />
              <KpiCard icon={<CheckCircle2 className="w-5 h-5" />} label="Converted" value={data.converted_leads} color="green"
                sub={`${pct(data.converted_leads, data.total_leads)}% of total`}
                onClick={() => nav({ leadStatus: 'CONVERTED' })} />
              <KpiCard icon={<HeartCrack className="w-5 h-5" />}   label="Lost"      value={data.lost_leads}      color="red"
                sub={`${pct(data.lost_leads, data.total_leads)}% of total`}
                onClick={() => nav({ leadStatus: 'LOST' })} />
            </div>
          </section>

          {/* ── Funnel ── */}
          <section>
            <SectionLabel>Sales Funnel</SectionLabel>
            <div className="bg-white border border-stone-200 rounded-xl px-6 py-5">
              <div className="flex flex-col sm:flex-row gap-6">
                <FunnelStep label="New"       value={data.new_leads}       total={funnelTotal} color="text-blue-600"   bar="bg-blue-400"
                  onClick={() => nav({ leadStatus: 'NEW' })} />
                <FunnelStep label="Contacted" value={data.contacted_leads} total={funnelTotal} color="text-yellow-600" bar="bg-yellow-400"
                  onClick={() => nav({ leadStatus: 'CONTACTED' })} />
                <FunnelStep label="Samples Sent" value={data.qualified_leads} total={funnelTotal} color="text-teal-600"   bar="bg-teal-400"
                  onClick={() => nav({ leadStatus: 'QUALIFIED' })} />
                <FunnelStep label="Converted" value={data.converted_leads} total={funnelTotal} color="text-green-600"  bar="bg-green-400" isLast
                  onClick={() => nav({ leadStatus: 'CONVERTED' })} />
              </div>

              {/* Conversion rate summary */}
              <div className="mt-5 pt-4 border-t border-stone-100 flex flex-wrap gap-x-6 gap-y-1">
                <span className="text-xs text-stone-400">
                  Contact rate: <strong className="text-stone-600">{pct(data.contacted_leads, data.new_leads || 1)}%</strong>
                </span>
                <span className="text-xs text-stone-400">
                  Sample rate: <strong className="text-stone-600">{pct(data.qualified_leads, data.contacted_leads || 1)}%</strong>
                </span>
                <span className="text-xs text-stone-400">
                  Close rate: <strong className="text-stone-600">{pct(data.converted_leads, data.qualified_leads || 1)}%</strong>
                </span>
                <span className="text-xs text-stone-400">
                  Overall conversion: <strong className="text-green-600">{pct(data.converted_leads, data.total_leads)}%</strong>
                </span>
              </div>
            </div>
          </section>

        </div>
      )}
    </div>
  );
}
