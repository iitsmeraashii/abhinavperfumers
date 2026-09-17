import { useEffect, useState, useCallback } from 'react';
import { supabase } from './supabaseClient';
import {
  MessageCircle, Phone, Clock, RefreshCw, Loader2,
  ChevronLeft, ChevronRight, Inbox, AlertCircle,
  Link2, Link2Off, CheckCircle2,
} from 'lucide-react';
import { formatDateTime } from './utils/dateFormat';

interface Conversation {
  id: string;
  conversation_code: string | null;
  wa_phone_number: string;
  status: string;
  last_message_at: string | null;
  customer_service_window_expires_at: string | null;
  unread_count: number;
  created_at: string;
  updated_at: string;
}

interface LinkedLeadInfo {
  hasLinkedLead: boolean;
  leadId: string | null;
  clientName: string | null;
  company: string | null;
}

type ConversationRow = Conversation & { linked_lead?: LinkedLeadInfo };

const PAGE_SIZE = 25;

type ServiceWindowState = 'open' | 'expiring' | 'closed' | 'none';

function deriveServiceWindow(expiresAt: string | null): ServiceWindowState {
  if (!expiresAt) return 'none';
  const now = Date.now();
  const expires = new Date(expiresAt.endsWith('Z') ? expiresAt : expiresAt + 'Z').getTime();
  if (expires <= now) return 'closed';
  const fourHours = 4 * 60 * 60 * 1000;
  if (expires - now < fourHours) return 'expiring';
  return 'open';
}

const WINDOW_CONFIG: Record<ServiceWindowState, { label: string; cls: string; dot: string }> = {
  open:      { label: 'Service Window', cls: 'bg-green-50 text-green-700 border-green-200',  dot: 'bg-green-500' },
  expiring:  { label: 'Closing Soon',    cls: 'bg-amber-50 text-amber-700 border-amber-200',  dot: 'bg-amber-500' },
  closed:    { label: 'Window Closed',   cls: 'bg-stone-100 text-stone-500 border-stone-200', dot: 'bg-stone-400' },
  none:      { label: 'No Window',       cls: 'bg-stone-50 text-stone-400 border-stone-200',  dot: 'bg-stone-300' },
};

export default function ConversationsPage() {
  const [rows, setRows] = useState<ConversationRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [page, setPage] = useState(0);
  const [total, setTotal] = useState(0);

  const fetchPage = useCallback(async (p: number) => {
    setLoading(true);
    setError('');

    const from = p * PAGE_SIZE;
    const to = from + PAGE_SIZE - 1;

    const { data, count, error: err } = await supabase
      .from('whatsapp_conversations')
      .select(`
        id,
        conversation_code,
        wa_phone_number,
        status,
        last_message_at,
        customer_service_window_expires_at,
        unread_count,
        created_at,
        updated_at
      `, { count: 'exact' })
      .order('last_message_at', { ascending: false, nullsFirst: false })
      .order('updated_at', { ascending: false })
      .range(from, to);

    if (err) {
      setError(err.message || 'Failed to load conversations.');
      setRows([]);
      setTotal(0);
      setLoading(false);
      return;
    }

    const conversations = (data ?? []) as Conversation[];

    if (conversations.length === 0) {
      setRows([]);
      setTotal(count ?? 0);
      setLoading(false);
      return;
    }

    // Batch-check for linked leads by phone number
    const phoneNumbers = conversations.map(c => c.wa_phone_number);
    const { data: linkedLeads } = await supabase
      .from('lead_entries')
      .select('id, client_name, company, phones')
      .overlaps('phones', phoneNumbers);

    const phoneToLead = new Map<string, LinkedLeadInfo>();
    for (const lead of linkedLeads ?? []) {
      const phones: string[] = lead.phones ?? [];
      for (const ph of phones) {
        if (!phoneToLead.has(ph)) {
          phoneToLead.set(ph, {
            hasLinkedLead: true,
            leadId: lead.id,
            clientName: lead.client_name,
            company: lead.company,
          });
        }
      }
    }

    const enriched: ConversationRow[] = conversations.map(c => ({
      ...c,
      linked_lead: phoneToLead.get(c.wa_phone_number) ?? { hasLinkedLead: false, leadId: null, clientName: null, company: null },
    }));

    setRows(enriched);
    setTotal(count ?? 0);
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchPage(page);
  }, [page, fetchPage]);

  const totalPages = Math.ceil(total / PAGE_SIZE);
  const rangeStart = total === 0 ? 0 : page * PAGE_SIZE + 1;
  const rangeEnd = Math.min((page + 1) * PAGE_SIZE, total);

  function handleRefresh() {
    fetchPage(page);
  }

  return (
    <div className="p-6 max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex items-start justify-between mb-5 gap-4">
        <div>
          <h1 className="text-xl font-semibold text-stone-800">WhatsApp Conversations</h1>
          <p className="text-xs text-stone-500 mt-0.5">
            {total > 0 ? `${total} conversation${total !== 1 ? 's' : ''}` : 'Manage WhatsApp conversations'}
          </p>
        </div>
        <button
          onClick={handleRefresh}
          disabled={loading}
          className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg border border-stone-200 text-stone-600 hover:bg-stone-50 transition disabled:opacity-50"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      {/* Error state */}
      {error && !loading && (
        <div className="mb-5 flex items-center gap-2 px-4 py-3 bg-red-50 border border-red-200 text-red-700 text-sm rounded-xl">
          <AlertCircle className="w-4 h-4 flex-shrink-0" />
          {error}
        </div>
      )}

      {/* Loading state */}
      {loading && (
        <div className="flex items-center justify-center py-24">
          <Loader2 className="w-6 h-6 text-stone-400 animate-spin" />
        </div>
      )}

      {/* Empty state */}
      {!loading && !error && rows.length === 0 && (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <div className="w-14 h-14 rounded-full bg-stone-100 flex items-center justify-center mb-4">
            <Inbox className="w-6 h-6 text-stone-400" />
          </div>
          <h2 className="text-sm font-semibold text-stone-700 mb-1">No conversations yet</h2>
          <p className="text-xs text-stone-400 max-w-xs">
            WhatsApp conversations will appear here once messages are exchanged with leads.
          </p>
        </div>
      )}

      {/* Conversation list */}
      {!loading && !error && rows.length > 0 && (
        <>
          <div className="flex flex-col gap-2">
            {rows.map(conv => {
              const window = deriveServiceWindow(conv.customer_service_window_expires_at);
              const wCfg = WINDOW_CONFIG[window];
              const linked = conv.linked_lead;
              const isUnmatched = !linked?.hasLinkedLead;
              const lastMsg = formatDateTime(conv.last_message_at);

              return (
                <div
                  key={conv.id}
                  className="bg-white border border-stone-200 rounded-xl px-4 py-3.5 hover:border-stone-300 hover:shadow-sm transition-all duration-150 cursor-pointer"
                  onClick={() => {
                    // Placeholder — detail view will be implemented in a later step
                  }}
                >
                  <div className="flex items-start justify-between gap-3">
                    {/* Left: phone + code */}
                    <div className="flex items-start gap-3 min-w-0 flex-1">
                      <div className="flex-shrink-0 w-9 h-9 rounded-full bg-stone-100 flex items-center justify-center mt-0.5">
                        <MessageCircle className="w-4 h-4 text-stone-500" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm font-semibold text-stone-800 truncate">
                            {conv.wa_phone_number}
                          </span>
                          {conv.conversation_code && (
                            <span className="text-xs text-stone-400 font-mono">
                              {conv.conversation_code}
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-2 mt-1 flex-wrap">
                          {/* Service window badge */}
                          <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border ${wCfg.cls}`}>
                            <span className={`w-1.5 h-1.5 rounded-full ${wCfg.dot}`} />
                            {wCfg.label}
                          </span>
                          {/* Linked / unmatched badge */}
                          {isUnmatched ? (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-orange-50 text-orange-600 border border-orange-200">
                              <Link2Off className="w-3 h-3" />
                              Unmatched
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-blue-50 text-blue-600 border border-blue-200">
                              <Link2 className="w-3 h-3" />
                              {linked?.clientName || 'Linked Lead'}
                              {linked?.company && (
                                <span className="text-blue-400 font-normal">· {linked.company}</span>
                              )}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>

                    {/* Right: unread + last message time */}
                    <div className="flex flex-col items-end gap-1 flex-shrink-0">
                      {conv.unread_count > 0 && (
                        <span className="inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-full bg-red-500 text-white text-xs font-bold tabular-nums">
                          {conv.unread_count}
                        </span>
                      )}
                      {lastMsg ? (
                        <span className="text-xs text-stone-400 whitespace-nowrap">
                          {lastMsg}
                        </span>
                      ) : (
                        <span className="text-xs text-stone-300 whitespace-nowrap">
                          No messages
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Pagination */}
          <div className="flex items-center justify-between mt-5 pt-4 border-t border-stone-100">
            <p className="text-xs text-stone-400">
              {total > 0
                ? `Showing ${rangeStart}–${rangeEnd} of ${total}`
                : 'No results'}
            </p>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setPage(p => Math.max(0, p - 1))}
                disabled={page === 0 || loading}
                className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium rounded-lg border border-stone-200 text-stone-600 hover:bg-stone-50 transition disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <ChevronLeft className="w-3.5 h-3.5" />
                Previous
              </button>
              <span className="text-xs text-stone-400 tabular-nums px-1">
                {totalPages > 0 ? `${page + 1} / ${totalPages}` : '1 / 1'}
              </span>
              <button
                onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
                disabled={page >= totalPages - 1 || loading || totalPages === 0}
                className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium rounded-lg border border-stone-200 text-stone-600 hover:bg-stone-50 transition disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Next
                <ChevronRight className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
