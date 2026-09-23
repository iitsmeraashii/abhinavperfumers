import { useEffect, useState, useCallback, useRef } from 'react';
import { supabase } from './supabaseClient';
import {
  MessageCircle, RefreshCw, Loader2,
  ChevronLeft, ChevronRight, Inbox, AlertCircle,
  Link2, Link2Off, Search, X,
} from 'lucide-react';
import { formatDateTime } from './utils/dateFormat';

// ── Types ───────────────────────────────────────────────────────────────────

interface Conversation {
  id: string;
  conversation_code: string | null;
  profile_name: string | null;
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

interface LatestMessage {
  conversationId: string;
  messageType: string;
  textBody: string | null;
  mediaFilename: string | null;
  mediaMimeType: string | null;
  mediaCaption: string | null;
  direction: string;
  timestamp: string | null;
}

type ConversationRow = Conversation & {
  linked_lead: LinkedLeadInfo;
  latest_message: LatestMessage | null;
};

type ConversationFilter = 'all' | 'unread' | 'unmatched' | 'linked' | 'window_open' | 'window_expired';

// ── Constants ────────────────────────────────────────────────────────────────

const PAGE_SIZE = 25;

type ServiceWindowState = 'open' | 'expiring' | 'closed' | 'none';

function normalizeIso(iso: string): string {
  return /[Zz]$/.test(iso) || /[+-]\d{2}:?\d{2}$/.test(iso)
    ? iso
    : iso.replace(' ', 'T') + 'Z';
}

function deriveServiceWindow(expiresAt: string | null): ServiceWindowState {
  if (!expiresAt) return 'none';
  const now = Date.now();
  const expires = new Date(normalizeIso(expiresAt)).getTime();
  if (isNaN(expires)) return 'none';
  if (expires <= now) return 'closed';
  const fourHours = 4 * 60 * 60 * 1000;
  if (expires - now < fourHours) return 'expiring';
  return 'open';
}

const WINDOW_CONFIG: Record<ServiceWindowState, { label: string; cls: string; dot: string }> = {
  open:     { label: 'Service Window', cls: 'bg-green-50 text-green-700 border-green-200',  dot: 'bg-green-500' },
  expiring: { label: 'Closing Soon',   cls: 'bg-amber-50 text-amber-700 border-amber-200',  dot: 'bg-amber-500' },
  closed:   { label: 'Window Closed',  cls: 'bg-stone-100 text-stone-500 border-stone-200', dot: 'bg-stone-400' },
  none:     { label: 'No Window',      cls: 'bg-stone-50 text-stone-400 border-stone-200',  dot: 'bg-stone-300' },
};

const FILTER_TABS: { label: string; value: ConversationFilter }[] = [
  { label: 'All',            value: 'all' },
  { label: 'Unread',         value: 'unread' },
  { label: 'Unmatched',      value: 'unmatched' },
  { label: 'Has Linked Lead', value: 'linked' },
  { label: 'Window Open',    value: 'window_open' },
  { label: 'Window Expired', value: 'window_expired' },
];

// ── Helpers ──────────────────────────────────────────────────────────────────

function buildMessagePreview(msg: LatestMessage): string {
  if (msg.messageType === 'text' && msg.textBody) {
    return msg.textBody.length > 80 ? msg.textBody.slice(0, 80) + '…' : msg.textBody;
  }
  if (msg.mediaFilename) return msg.mediaFilename;
  switch (msg.messageType) {
    case 'image':       return '📷 Image';
    case 'audio':       return '🎵 Audio';
    case 'video':       return '🎥 Video';
    case 'document':    return '📄 Document';
    case 'template':    return msg.mediaFilename ?? 'Template message';
    case 'interactive': return msg.textBody ?? 'Interactive message';
    case 'system':      return msg.textBody ?? 'System message';
    default:            return msg.mediaMimeType ?? msg.messageType;
  }
}

// ── Component ────────────────────────────────────────────────────────────────

interface ConversationsPageProps {
  onSelectConversation?: (conversationId: string) => void;
}

export default function ConversationsPage({ onSelectConversation }: ConversationsPageProps) {
  const [rows, setRows] = useState<ConversationRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [page, setPage] = useState(0);
  const [total, setTotal] = useState(0);

  const [searchInput, setSearchInput] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  const [activeFilter, setActiveFilter] = useState<ConversationFilter>('all');

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchPage = useCallback(async (p: number, filter: ConversationFilter, search: string) => {
    setLoading(true);
    setError('');

    const from = p * PAGE_SIZE;
    const to = from + PAGE_SIZE - 1;

    // ── Step 1: If searching by message text, find matching conversation IDs ──
    let messageSearchConversationIds: Set<string> | null = null;

    if (search.trim()) {
      const term = search.trim();
      // Try phone number or conversation_code match first on conversations
      // Also search message text via whatsapp_messages
      const { data: msgMatches, error: msgErr } = await supabase
        .from('whatsapp_messages')
        .select('conversation_id')
        .ilike('text_body', `%${term}%`)
        .order('timestamp', { ascending: false })
        .limit(200);

      if (msgErr) {
        console.error('[ConversationsPage] Message search failed', msgErr);
        setError('We couldn’t load conversations right now. Please try again.');
        setRows([]);
        setTotal(0);
        setLoading(false);
        return;
      }

      messageSearchConversationIds = new Set((msgMatches ?? []).map(m => m.conversation_id));
    }

    // ── Step 2: Build conversation query with filters ──
    let q = supabase
      .from('whatsapp_conversations')
      .select(
        'id, conversation_code, profile_name, wa_phone_number, status, last_message_at, customer_service_window_expires_at, unread_count, created_at, updated_at',
        { count: 'exact' },
      )
      .order('last_message_at', { ascending: false, nullsFirst: false })
      .order('updated_at', { ascending: false });

    // Search: phone number or conversation_code
    if (search.trim()) {
      const term = search.trim();
      // If we found message matches, filter by those IDs OR phone/code match
      if (messageSearchConversationIds && messageSearchConversationIds.size > 0) {
        const ids = Array.from(messageSearchConversationIds);
        // Use OR filter: phone ilike OR code ilike OR in message-matched IDs
        q = q.or(`wa_phone_number.ilike.%${term}%,conversation_code.ilike.%${term}%,id.in.(${ids.join(',')})`);
      } else {
        // No message matches — still try phone/code
        q = q.or(`wa_phone_number.ilike.%${term}%,conversation_code.ilike.%${term}%`);
      }
    }

    // Filter: unread
    if (filter === 'unread') {
      q = q.gt('unread_count', 0);
    }

    // Filter: service window open (expires_at > now)
    if (filter === 'window_open') {
      q = q.gt('customer_service_window_expires_at', new Date().toISOString());
    }

    // Filter: service window expired (expires_at <= now)
    if (filter === 'window_expired') {
      q = q.lte('customer_service_window_expires_at', new Date().toISOString());
    }

    // Apply pagination
    q = q.range(from, to);

    const { data, count, error: err } = await q;

    if (err) {
      console.error('[ConversationsPage] Conversation load failed', err);
      setError('We couldn’t load conversations right now. Please try again.');
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

    // ── Step 3: Fetch linked-lead info via bridge table ──
    const conversationIds = conversations.map(c => c.id);

    const { data: bridgeRows } = await supabase
      .from('whatsapp_conversation_leads')
      .select('conversation_id, lead_entry_id')
      .in('conversation_id', conversationIds);

    // Map conversation_id → linked lead IDs
    const convToLeadIds = new Map<string, string[]>();
    for (const br of bridgeRows ?? []) {
      const arr = convToLeadIds.get(br.conversation_id) ?? [];
      arr.push(br.lead_entry_id);
      convToLeadIds.set(br.conversation_id, arr);
    }

    // Fetch lead details for all linked lead IDs
    const allLeadIds = Array.from(new Set((bridgeRows ?? []).map(br => br.lead_entry_id)));
    const leadMap = new Map<string, { clientName: string | null; company: string | null }>();

    if (allLeadIds.length > 0) {
      const { data: leadRows } = await supabase
        .from('lead_entries')
        .select('id, client_name, company')
        .in('id', allLeadIds);

      for (const lead of leadRows ?? []) {
        leadMap.set(lead.id, { clientName: lead.client_name, company: lead.company });
      }
    }

    // ── Step 4: Fetch latest message per conversation ──
    // We fetch the most recent message for each conversation by querying
    // whatsapp_messages filtered to our conversation IDs, ordered by
    // timestamp DESC, then taking the first per conversation_id client-side.
    const { data: recentMessages } = await supabase
      .from('whatsapp_messages')
      .select('conversation_id, message_type, text_body, media_filename, media_mime_type, media_caption, direction, timestamp')
      .in('conversation_id', conversationIds)
      .order('timestamp', { ascending: false })
      .limit(conversationIds.length * 3); // fetch a few extra in case of duplicates

    const latestPerConv = new Map<string, LatestMessage>();
    for (const msg of recentMessages ?? []) {
      if (!latestPerConv.has(msg.conversation_id)) {
        latestPerConv.set(msg.conversation_id, {
          conversationId: msg.conversation_id,
          messageType: msg.message_type,
          textBody: msg.text_body,
          mediaFilename: msg.media_filename,
          mediaMimeType: msg.media_mime_type,
          mediaCaption: msg.media_caption,
          direction: msg.direction,
          timestamp: msg.timestamp,
        });
      }
    }

    // ── Step 5: Assemble enriched rows ──
    // For unmatched/linked filters we need to post-filter since they depend on bridge table
    let enriched: ConversationRow[] = conversations.map(c => {
      const leadIds = convToLeadIds.get(c.id) ?? [];
      const firstLeadId = leadIds[0] ?? null;
      const leadInfo = firstLeadId ? leadMap.get(firstLeadId) : null;

      return {
        ...c,
        linked_lead: {
          hasLinkedLead: leadIds.length > 0,
          leadId: firstLeadId,
          clientName: leadInfo?.clientName ?? null,
          company: leadInfo?.company ?? null,
        },
        latest_message: latestPerConv.get(c.id) ?? null,
      };
    });

    // Apply post-fetch filters for unmatched/linked
    if (filter === 'unmatched') {
      enriched = enriched.filter(r => !r.linked_lead.hasLinkedLead);
    } else if (filter === 'linked') {
      enriched = enriched.filter(r => r.linked_lead.hasLinkedLead);
    }

    setRows(enriched);
    setTotal(count ?? 0);
    setLoading(false);
  }, []);

  // Fetch on page or filter change
  useEffect(() => {
    fetchPage(page, activeFilter, searchTerm);
  }, [page, activeFilter, searchTerm, fetchPage]);

  // Debounced search
  function handleSearchChange(v: string) {
    setSearchInput(v);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setSearchTerm(v);
      setPage(0);
    }, 350);
  }

  function handleFilterChange(f: ConversationFilter) {
    setActiveFilter(f);
    setPage(0);
  }

  function handleRefresh() {
    fetchPage(page, activeFilter, searchTerm);
  }

  function clearSearch() {
    setSearchInput('');
    setSearchTerm('');
    setPage(0);
  }

  const totalPages = Math.ceil(total / PAGE_SIZE);
  const rangeStart = total === 0 ? 0 : page * PAGE_SIZE + 1;
  const rangeEnd = Math.min((page + 1) * PAGE_SIZE, total);

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

      {/* Search bar */}
      <div className="mb-3 relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-stone-400" />
        <input
          type="text"
          value={searchInput}
          onChange={e => handleSearchChange(e.target.value)}
          placeholder="Search by phone, code, or message text…"
          className="w-full pl-9 pr-9 py-2.5 text-sm border border-stone-200 rounded-xl bg-white text-stone-800 placeholder:text-stone-400 focus:outline-none focus:ring-2 focus:ring-amber-500 focus:border-transparent transition"
        />
        {searchInput && (
          <button
            onClick={clearSearch}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-stone-400 hover:text-stone-600 transition"
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* Filter tabs */}
      <div className="flex items-center gap-1.5 mb-4 overflow-x-auto pb-1 -mx-1 px-1">
        {FILTER_TABS.map(tab => {
          const active = activeFilter === tab.value;
          return (
            <button
              key={tab.value}
              onClick={() => handleFilterChange(tab.value)}
              className={`flex-shrink-0 px-3 py-1.5 text-xs font-medium rounded-lg border transition ${
                active
                  ? 'bg-stone-800 border-stone-800 text-white'
                  : 'border-stone-200 bg-white text-stone-600 hover:bg-stone-50'
              }`}
            >
              {tab.label}
            </button>
          );
        })}
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
          <h2 className="text-sm font-semibold text-stone-700 mb-1">
            {searchTerm || activeFilter !== 'all' ? 'No conversations match' : 'No conversations yet'}
          </h2>
          <p className="text-xs text-stone-400 max-w-xs">
            {searchTerm || activeFilter !== 'all'
              ? 'Try adjusting your search or filters.'
              : 'WhatsApp conversations will appear here once messages are exchanged with leads.'}
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
              const isUnmatched = !linked.hasLinkedLead;
              const lastMsg = formatDateTime(conv.last_message_at);
              const preview = conv.latest_message ? buildMessagePreview(conv.latest_message) : null;
              const isInbound = conv.latest_message?.direction === 'inbound';

              return (
                <div
                  key={conv.id}
                  className="bg-white border border-stone-200 rounded-xl px-4 py-3.5 hover:border-stone-300 hover:shadow-sm transition-all duration-150 cursor-pointer"
                  onClick={() => {
                    if (onSelectConversation) onSelectConversation(conv.id);
                  }}
                >
                  <div className="flex items-start justify-between gap-3">
                    {/* Left: avatar + phone + preview */}
                    <div className="flex items-start gap-3 min-w-0 flex-1">
                      <div className="flex-shrink-0 w-9 h-9 rounded-full bg-stone-100 flex items-center justify-center mt-0.5">
                        <MessageCircle className="w-4 h-4 text-stone-500" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm font-semibold text-stone-800 truncate">
                            {conv.profile_name?.trim() || conv.wa_phone_number}
                          </span>
                          {conv.profile_name?.trim() && (
                            <span className="text-xs text-stone-500 truncate">
                              {conv.wa_phone_number}
                            </span>
                          )}
                          {conv.conversation_code && (
                            <span className="text-xs text-stone-400 font-mono">
                              {conv.conversation_code}
                            </span>
                          )}
                        </div>

                        {/* Latest message preview */}
                        {preview && (
                          <p className="text-xs text-stone-500 mt-1 truncate leading-relaxed">
                            {isInbound ? '' : ''}
                            {preview}
                          </p>
                        )}

                        <div className="flex items-center gap-2 mt-1.5 flex-wrap">
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
                              {linked.clientName || 'Linked Lead'}
                              {linked.company && (
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
