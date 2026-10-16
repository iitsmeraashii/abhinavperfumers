import { useEffect, useRef, useState } from 'react';
import { ArrowRight, CheckCircle2, Loader2, RefreshCw, XCircle } from 'lucide-react';
import { useAuth } from './AuthContext';
import { useOnlineStatus } from './capture/useOnlineStatus';
import { identityKey, isAuthorized } from './dashboardMetricsLoader';
import { supabase } from './supabaseClient';
import type { LeadsInitialFilters } from './LeadsPage';
import { EventRequestGate, eventFunnel, geographyLabel, parseEventOverview, type EventOverviewData, type GeographyRow } from './eventOverviewModel';
import './EventOverview.css';

const percent = (count: number, total: number) => total ? Math.round(count / total * 100) : 0;
const number = (value: number) => value.toLocaleString('en-IN');
const drillClass = 'text-left rounded-xl border border-stone-200 bg-white px-4 py-3 transition-colors hover:bg-amber-50 hover:border-amber-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-amber-600 disabled:cursor-default disabled:hover:bg-white';

export function EventFunnel({ data }: { data: EventOverviewData }) {
  const stages = eventFunnel(data);
  return <section className="rounded-2xl border border-amber-200 bg-gradient-to-br from-amber-50 via-white to-stone-50 p-5" aria-label="Event funnel overview">
    <h3 className="text-sm font-semibold text-stone-800">Event journey</h3>
    <p className="text-xs text-stone-500 mt-1">Cumulative sales stages inferred from NEW → Contacted → Samples Sent → Converted or Lost.</p>
    <div className={`grid grid-cols-1 ${stages.length === 4 ? 'lg:grid-cols-4' : 'lg:grid-cols-3'} gap-3 mt-5`}>
      {stages.map((stage, index) => <div key={stage.label} className="relative rounded-xl border border-amber-100 bg-white/90 p-4">
        <p className="text-[10px] uppercase tracking-wider text-amber-700">Stage {index + 1}</p>
        <h4 className="text-xs font-medium text-stone-600 mt-2 min-h-8">{stage.label}</h4>
        <p className="text-2xl font-bold tabular-nums text-stone-900">{number(stage.count)}</p>
        <div className="h-1.5 rounded-full bg-stone-100 mt-3 overflow-hidden" aria-hidden="true"><div className="event-overview-fill h-full rounded-full bg-amber-500" style={{ width: `${percent(stage.count, data.metrics.total)}%` }} /></div>
        <p className="text-[11px] text-stone-500 mt-2">{percent(stage.count, data.metrics.total)}% of total</p>
        {index < stages.length - 1 && <ArrowRight aria-hidden="true" className="hidden lg:block absolute -right-3 top-1/2 w-4 h-4 text-amber-500 z-10" />}
      </div>)}
    </div>
    <div className="ml-4 border-l-2 border-stone-200 pl-4 pt-4 grid grid-cols-1 sm:grid-cols-2 gap-3">
      <div className="rounded-xl border border-green-200 bg-green-50 p-4"><p className="flex gap-2 items-center text-xs font-medium text-green-800"><CheckCircle2 className="w-4 h-4" />Converted</p><p className="text-2xl font-bold text-green-900 mt-2">{number(data.metrics.converted)}</p><p className="text-xs text-green-700 mt-1">{percent(data.metrics.converted, data.metrics.total)}% of total</p></div>
      <div className="rounded-xl border border-red-200 bg-red-50 p-4"><p className="flex gap-2 items-center text-xs font-medium text-red-800"><XCircle className="w-4 h-4" />Lost</p><p className="text-2xl font-bold text-red-900 mt-2">{number(data.metrics.lost)}</p><p className="text-xs text-red-700 mt-1">{percent(data.metrics.lost, data.metrics.total)}% of total</p></div>
    </div>
    <p className="text-[11px] text-stone-500 mt-4">{data.templateConfigured ? 'Connected means WhatsApp Read or Delivered. Sales may progress without WhatsApp delivery, so stages need not shrink.' : 'Connected is omitted because this event has no complete saved WhatsApp template configuration.'} Lost leads are included in both preceding sales stages. These are estimates, not historical milestone records.</p>
  </section>;
}

export function GeographyBreakdown({ title, rows, more, total, onSelect }: {
  title: string; rows: GeographyRow[]; more: boolean; total: number; onSelect: (value: string | null) => void;
}) {
  return <section className="rounded-xl border border-stone-200 bg-white p-4">
    <h3 className="text-sm font-semibold text-stone-700 mb-3">{title}</h3>
    {!rows.length && <p className="text-xs text-stone-500">No leads yet.</p>}
    <div className="space-y-1 max-h-72 overflow-y-auto">
      {rows.map(row => <button type="button" key={row.value === null ? 'null' : `value:${row.value}`} onClick={() => onSelect(row.value)} className="w-full text-left rounded-lg p-2 hover:bg-amber-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-amber-600" title={row.value ?? 'Unassigned'}>
        <div className="flex items-start justify-between gap-3 text-xs"><span className="text-stone-700 break-words">{geographyLabel(row.value)}</span><span className="whitespace-nowrap font-semibold text-stone-800">{number(row.count)} <span className="text-stone-400 font-normal">· {percent(row.count, total)}%</span></span></div>
        <div className="h-1 bg-stone-100 rounded-full mt-2 overflow-hidden" aria-hidden="true"><div className="event-overview-fill h-full bg-stone-500 rounded-full" style={{ width: `${percent(row.count, total)}%` }} /></div>
      </button>)}
    </div>
    {more && <p className="text-xs text-stone-500 mt-3">Showing the top 100 groups. Use Leads filters to explore remaining values.</p>}
  </section>;
}

export default function EventOverview({ eventId, revision, onViewLeads }: {
  eventId: string; revision: string;
  onViewLeads?: (eventCode: string, filters?: LeadsInitialFilters) => void;
}) {
  const { user, authMode } = useAuth();
  const online = useOnlineStatus();
  const identity = identityKey(user);
  const allowed = !!identity && user?.role === 'admin' && online && authMode === 'online' && isAuthorized();
  const [refresh, setRefresh] = useState(0);
  const key = `${identity}|${authMode}|${online}|${eventId}|${revision}|${refresh}`;
  const currentKey = useRef(key); currentKey.current = key;
  const gate = useRef(new EventRequestGate());
  const [result, setResult] = useState<{ key: string; data: EventOverviewData | null } | null>(null);
  useEffect(() => {
    const ticket = gate.current.begin();
    if (!allowed) return;
    const current = () => gate.current.current(ticket) && currentKey.current === key && isAuthorized();
    void (async () => {
      try {
        const { data, error } = await supabase.rpc('get_event_overview', { p_event_id: eventId });
        if (current()) setResult({ key, data: error ? null : parseEventOverview(data, eventId) });
      } catch { if (current()) setResult({ key, data: null }); }
    })();
    return () => gate.current.invalidate();
  }, [allowed, key, eventId]);
  const currentResult = result?.key === key ? result : null;
  const data = currentResult?.data;
  const maxDay = Math.max(1, ...(data?.days.map(row => row.count) ?? []));
  const nav = (filters: LeadsInitialFilters = {}) => { if (data && allowed) onViewLeads?.(data.eventCode, filters); };
  const geographicFilter = (value: string | null) => value === null || value === '' ? '__unassigned__' : value;
  return <div className="event-overview space-y-5">
    <div className="flex items-center justify-between gap-3"><div><h2 className="text-base font-semibold text-stone-800">Event overview</h2><p className="text-xs text-stone-500">All leads currently associated with this event · all time</p></div><button type="button" onClick={() => setRefresh(n => n + 1)} disabled={!allowed || !currentResult} className="flex items-center gap-1.5 text-xs rounded-lg border border-stone-200 px-3 py-2 bg-white disabled:opacity-50"><RefreshCw className="w-3.5 h-3.5" />Refresh</button></div>
    {!allowed ? <p className="text-sm text-stone-500">Event insights require an online admin session.</p>
      : !currentResult ? <div role="status" className="flex gap-2 items-center py-6 text-sm text-stone-500"><Loader2 className="animate-spin motion-reduce:animate-none w-4 h-4" />Loading event insights…</div>
      : !data ? <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">Event insights could not be loaded. <button type="button" onClick={() => setRefresh(n => n + 1)} className="underline font-semibold">Retry</button></div>
      : <div key={key} className="space-y-5">
        {data.metrics.total === 0 && <p className="text-sm text-stone-500">No leads are associated with this event yet.</p>}
        <EventFunnel data={data} />
        <section aria-label="Current lead status"><h3 className="text-sm font-semibold text-stone-700 mb-3">Current lead status</h3><div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          {[
            { label: 'Total leads', count: data.metrics.total, filter: {} },
            { label: 'Contacted', count: data.metrics.contacted, filter: { leadStatus: 'CONTACTED' } },
            { label: 'Samples Sent', count: data.metrics.samples, filter: { leadStatus: 'QUALIFIED' } },
            { label: 'Converted', count: data.metrics.converted, filter: { leadStatus: 'CONVERTED' } },
            { label: 'Lost', count: data.metrics.lost, filter: { leadStatus: 'LOST' } },
            { label: 'Invalid', count: data.metrics.invalid, filter: { systemStatus: 'INVALID_LEAD' } },
            { label: 'Requires Review', count: data.metrics.review, filter: { leadStatus: 'REQUIRES_REVIEW' } },
          ].map(tile => <button key={tile.label} type="button" disabled={!onViewLeads} onClick={() => nav(tile.filter)} className={drillClass}><p className="text-xs text-stone-500">{tile.label}</p><p className="text-xl font-bold text-stone-800 mt-1">{number(tile.count)}</p></button>)}
        </div></section>
        <section aria-label="Lead temperature"><h3 className="text-sm font-semibold text-stone-700 mb-3">Lead temperature</h3><div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[
            { label: 'Hot', count: data.metrics.hot, value: 'Hot' },
            { label: 'Warm', count: data.metrics.warm, value: 'Warm' },
            { label: 'Cold', count: data.metrics.cold, value: 'Cold' },
            { label: 'Unassigned', count: data.metrics.unassigned, value: '__unassigned__' },
          ].map(tile => <button type="button" key={tile.value} disabled={!onViewLeads} className={drillClass} onClick={() => nav({ temperature: tile.value })}><p className="text-xs text-stone-500">{tile.label}</p><p className="text-xl font-bold text-stone-800 mt-1">{number(tile.count)}</p></button>)}
        </div>{data.metrics.other_temperature > 0 && <p className="text-xs text-stone-500 mt-2">Other stored temperature values: {number(data.metrics.other_temperature)}. These are not included in Unassigned.</p>}</section>
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
          <GeographyBreakdown title="Countries" rows={data.countries} more={data.countriesMore} total={data.metrics.total} onSelect={value => nav({ country: geographicFilter(value) })} />
          <GeographyBreakdown title="States / regions" rows={data.states} more={data.statesMore} total={data.metrics.total} onSelect={value => nav({ state: geographicFilter(value) })} />
        </div>
        <section className="rounded-xl border border-stone-200 bg-white p-4"><h3 className="text-sm font-semibold text-stone-700">Sales performance</h3><p className="text-xs text-stone-500 mt-1">Currently assigned sales reps; status columns show current status, not cumulative stages.</p><div className="overflow-x-auto mt-3"><table className="w-full text-xs"><thead><tr className="text-stone-500 border-b border-stone-100"><th className="text-left py-2">Sales rep</th>{['Total', 'Contacted', 'Samples', 'Converted', 'Lost'].map(label => <th className="text-right px-2 py-2" key={label}>{label}</th>)}</tr></thead><tbody>
          {data.reps.map(rep => <tr key={rep.code ?? 'null'} className="border-b border-stone-50"><td className="py-2"><button type="button" onClick={() => nav({ repCode: rep.code || '__unassigned__' })} className="text-left text-stone-700 hover:text-amber-700 underline decoration-stone-200 underline-offset-4">{rep.name || rep.code || 'Unassigned'}</button></td>{[rep.total, rep.contacted, rep.samples, rep.converted, rep.lost].map((value, index) => <td key={index} className="text-right px-2 py-2 tabular-nums text-stone-700">{number(value)}</td>)}</tr>)}
        </tbody></table></div>{data.repsMore && <p className="text-xs text-stone-500 mt-3">Showing the top 100 sales reps.</p>}</section>
        <section className="rounded-xl border border-stone-200 bg-white p-4"><h3 className="text-sm font-semibold text-stone-700">Daily captures (UTC)</h3><p className="text-xs text-stone-500 mt-1">{data.daysMore ? 'Latest 90 capture days; earlier days are omitted.' : 'Days with captured leads.'}</p><div className="max-h-56 overflow-y-auto mt-3 space-y-2">{data.days.map(day => <div key={day.day} className="flex items-center gap-3 text-xs"><span className="text-stone-500 w-24 shrink-0">{day.day}</span><div className="h-1.5 flex-1 bg-stone-100 rounded-full overflow-hidden" aria-hidden="true"><div className="event-overview-fill h-full bg-stone-500 rounded-full" style={{ width: `${percent(day.count, maxDay)}%` }} /></div><span className="tabular-nums text-stone-700">{number(day.count)}</span></div>)}</div></section>
      </div>}
  </div>;
}
