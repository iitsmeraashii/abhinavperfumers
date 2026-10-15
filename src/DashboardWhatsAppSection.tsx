import type { DashboardDateBounds } from './dashboardDateRange';
import { useEffect, useRef, useState } from 'react';
import { ArrowRight, MessageCircle } from 'lucide-react';
import { useAuth } from './AuthContext';
import { useOnlineStatus } from './capture/useOnlineStatus';
import { identityKey, isAuthorized } from './dashboardMetricsLoader';
import { supabase } from './supabaseClient';
import { WHATSAPP_STATUS_OPTIONS } from './whatsappStatusFilter';
import { parseWhatsAppCounts } from './dashboardWhatsAppCounts';

type Result = { key: string; counts: Record<string, number> | null; error: boolean };

export default function DashboardWhatsAppSection({ refresh, onNavigate, bounds }: {
  refresh: number;
  bounds?: DashboardDateBounds;
  onNavigate: (statuses: string[]) => void;
}) {
  const { user, authMode } = useAuth();
  const online = useOnlineStatus();
  const identity = identityKey(user);
  const allowed = !!identity && online && authMode === 'online' && isAuthorized();
  const [retry, setRetry] = useState(0);
  const [result, setResult] = useState<Result | null>(null);
  const generation = useRef(0);
  const key = `${identity}|${authMode}|${online}|${refresh}|${retry}|${bounds?.from}|${bounds?.before}`;
  const liveKey = useRef(key);
  liveKey.current = key;

  useEffect(() => {
    const attempt = ++generation.current;
    if (!allowed) return;
    let cancelled = false;
    const current = () => !cancelled && generation.current === attempt && liveKey.current === key && isAuthorized();
    setResult(null);
    void (async () => {
      try {
        const { data, error } = await (bounds
          ? supabase.rpc('get_dashboard_whatsapp_status_counts_range', { p_from: bounds.from, p_before: bounds.before })
          : supabase.rpc('get_dashboard_whatsapp_status_counts'));
        if (!current()) return;
        const counts = error ? null : parseWhatsAppCounts(data);
        setResult({ key, counts, error: !counts });
      } catch {
        if (current()) setResult({ key, counts: null, error: true });
      }
    })();
    return () => { cancelled = true; generation.current++; };
  }, [allowed, key]);

  if (!identity) return null;
  const currentResult = result?.key === key ? result : null;
  return (
    <section aria-label="WhatsApp outreach status">
      <h2 className="text-xs font-semibold text-stone-400 uppercase tracking-widest mb-2">WhatsApp outreach status</h2>
      <p className="text-xs text-stone-500 mb-4">{bounds ? 'Initial outreach status for leads created in the selected period.' : 'All-time initial outreach status.'} Not set may mean no template is configured or sending has not started; it does not mean delivery failed.</p>
      {!allowed ? <p className="text-sm text-stone-500">Available when connected and signed in online.</p>
        : !currentResult ? <p role="status" className="text-sm text-stone-500">Loading WhatsApp status…</p>
        : currentResult.error ? <div role="alert" className="text-sm text-red-600">
          WhatsApp status unavailable. <button type="button" onClick={() => setRetry(value => value + 1)} className="underline font-medium">Retry</button>
        </div>
        : <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {WHATSAPP_STATUS_OPTIONS.map(option => (
            <button type="button" key={option.value} onClick={() => onNavigate([option.value])}
              className="text-left p-4 rounded-xl border border-stone-200 bg-white hover:border-amber-300 hover:bg-amber-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-amber-600 transition-colors">
              <div className="flex items-center gap-2 text-sm text-stone-600"><MessageCircle className="w-4 h-4 text-amber-600" />{option.label}</div>
              <div className="flex items-center justify-between mt-2"><span className="text-2xl font-bold text-stone-900">{currentResult.counts![option.value].toLocaleString('en-IN')}</span><ArrowRight className="w-4 h-4 text-stone-400" /></div>
            </button>
          ))}
        </div>}
    </section>
  );
}
