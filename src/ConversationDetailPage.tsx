import { useEffect, useState, useRef, useCallback } from 'react';
import { supabase } from './supabaseClient';
import {
  ArrowLeft, Loader2, AlertCircle, MessageCircle, Phone,
  Link2, Link2Off, ExternalLink, Clock, Send,
  FileText, Image as ImageIcon, Headphones, FileVideo, FileCheck,
  CheckCheck, Check, X, Circle, Plus, Unlink,
  AlertTriangle, Lock, FileCheck2,
} from 'lucide-react';
import { formatDateTime } from './utils/dateFormat';
import { getAuthIdentity } from './capture/captureAuth';
import LinkExistingLeadModal from './LinkExistingLeadModal';
import CreateLeadModal from './CreateLeadModal';

// ── Types ───────────────────────────────────────────────────────────────────

interface Conversation {
  id: string;
  conversation_code: string | null;
  wa_phone_number: string;
  status: string;
  last_message_at: string | null;
  last_inbound_at: string | null;
  last_outbound_at: string | null;
  customer_service_window_expires_at: string | null;
  unread_count: number;
  created_at: string;
  updated_at: string;
}

interface ChatMessage {
  id: string;
  direction: string;
  message_type: string;
  text_body: string | null;
  media_filename: string | null;
  media_mime_type: string | null;
  media_caption: string | null;
  media_url: string | null;
  timestamp: string | null;
  status: string | null;
  template_name: string | null;
  error_code: number | null;
  error_message: string | null;
}

function normalizeChatMessage(message: ChatMessage): ChatMessage {
  return {
    ...message,
    direction: message.direction.toLowerCase(),
    message_type: message.message_type.toLowerCase(),
  };
}

interface LinkedLead {
  leadEntryId: string;
  clientName: string | null;
  company: string | null;
  leadStatus: string | null;
  leadTemperature: string | null;
  state: string | null;
}

interface Props {
  conversationId: string;
  onBack: () => void;
  onViewLead: (leadId: string) => void;
  onUnreadCleared?: () => void;
}

// ── Time helper ──────────────────────────────────────────────────────────────

function formatTimeOnly(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const normalized = /[Zz]$/.test(iso) || /[+-]\d{2}:\d{2}$/.test(iso) ? iso : iso + 'Z';
  return new Date(normalized).toLocaleTimeString('en-IN', {
    hour: '2-digit', minute: '2-digit',
    hour12: true,
  });
}

function formatRemaining(expiresAt: string): string {
  const expires = new Date(expiresAt.endsWith('Z') ? expiresAt : expiresAt + 'Z').getTime();
  const diff = expires - Date.now();
  if (diff <= 0) return 'expired';
  const hours = Math.floor(diff / (60 * 60 * 1000));
  const minutes = Math.floor((diff % (60 * 60 * 1000)) / (60 * 1000));
  if (hours > 0) return `${hours}h ${minutes}m remaining`;
  return `${minutes}m remaining`;
}

function formatExpiredAgo(expiresAt: string): string {
  const expires = new Date(expiresAt.endsWith('Z') ? expiresAt : expiresAt + 'Z').getTime();
  const diff = Date.now() - expires;
  if (diff <= 0) return '';
  const hours = Math.floor(diff / (60 * 60 * 1000));
  const minutes = Math.floor((diff % (60 * 60 * 1000)) / (60 * 1000));
  if (hours > 0) return `expired ${hours}h ${minutes}m ago`;
  return `expired ${minutes}m ago`;
}

// ── Service window helpers ────────────────────────────────────────────────────

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

const WINDOW_CONFIG: Record<ServiceWindowState, {
  label: string;
  badgeCls: string;
  dotCls: string;
  panelBorder: string;
  panelBg: string;
  iconCls: string;
}> = {
  open: {
    label: 'Service Window Open',
    badgeCls: 'bg-green-50 text-green-700 border-green-200',
    dotCls: 'bg-green-500',
    panelBorder: 'border-green-200',
    panelBg: 'bg-green-50/40',
    iconCls: 'text-green-600',
  },
  expiring: {
    label: 'Service Window Closing Soon',
    badgeCls: 'bg-amber-50 text-amber-700 border-amber-200',
    dotCls: 'bg-amber-500',
    panelBorder: 'border-amber-200',
    panelBg: 'bg-amber-50/40',
    iconCls: 'text-amber-600',
  },
  closed: {
    label: 'Service Window Expired',
    badgeCls: 'bg-stone-100 text-stone-500 border-stone-200',
    dotCls: 'bg-stone-400',
    panelBorder: 'border-stone-200',
    panelBg: 'bg-stone-50',
    iconCls: 'text-stone-400',
  },
  none: {
    label: 'No Service Window',
    badgeCls: 'bg-stone-50 text-stone-400 border-stone-200',
    dotCls: 'bg-stone-300',
    panelBorder: 'border-stone-200',
    panelBg: 'bg-stone-50',
    iconCls: 'text-stone-400',
  },
};

// ── Message status helpers ────────────────────────────────────────────────────

type OutboundStatus = 'sent' | 'delivered' | 'read' | 'failed' | 'pending' | 'unknown';

function deriveOutboundStatus(msg: ChatMessage): OutboundStatus {
  if (msg.direction !== 'outbound') return 'unknown';
  const s = msg.status?.toLowerCase();
  if (s === 'read') return 'read';
  if (s === 'delivered') return 'delivered';
  if (s === 'sent' || s === 'accepted') return 'sent';
  if (s === 'failed') return 'failed';
  if (s === 'pending' || s === 'queued') return 'pending';
  return 'unknown';
}

const STATUS_ICONS: Record<OutboundStatus, { icon: React.ReactNode; cls: string; label: string }> = {
  read:      { icon: <CheckCheck className="w-3.5 h-3.5" />, cls: 'text-sky-500',   label: 'Read' },
  delivered: { icon: <CheckCheck className="w-3.5 h-3.5" />, cls: 'text-stone-400', label: 'Delivered' },
  sent:      { icon: <Check className="w-3.5 h-3.5" />,       cls: 'text-stone-400', label: 'Sent' },
  failed:    { icon: <AlertTriangle className="w-3.5 h-3.5" />, cls: 'text-red-500',  label: 'Failed' },
  pending:   { icon: <Clock className="w-3.5 h-3.5" />,      cls: 'text-amber-500', label: 'Pending' },
  unknown:   { icon: null,                                   cls: '',               label: '' },
};

// ── Media helpers ───────────────────────────────────────────────────────────

function getMediaIcon(msg: ChatMessage): React.ReactNode {
  switch (msg.message_type) {
    case 'image':       return <ImageIcon className="w-5 h-5" />;
    case 'audio':       return <Headphones className="w-5 h-5" />;
    case 'video':       return <FileVideo className="w-5 h-5" />;
    case 'document':    return <FileText className="w-5 h-5" />;
    case 'template':    return <FileCheck className="w-5 h-5" />;
    default:            return <FileText className="w-5 h-5" />;
  }
}

function getMediaLabel(msg: ChatMessage): string {
  if (msg.media_filename) return msg.media_filename;
  switch (msg.message_type) {
    case 'image':    return 'Image';
    case 'audio':    return 'Audio message';
    case 'video':    return 'Video';
    case 'document': return msg.media_mime_type ?? 'Document';
    case 'template': return msg.template_name ?? 'Template message';
    default:         return msg.media_mime_type ?? `Unknown type`;
  }
}

function getMediaTypeLabel(msg: ChatMessage): string {
  switch (msg.message_type) {
    case 'image':    return 'Image';
    case 'audio':    return 'Audio';
    case 'video':    return 'Video';
    case 'document': return 'Document';
    case 'template': return 'Template';
    default:         return 'Message';
  }
}

// ── Date separator helper ────────────────────────────────────────────────────

function formatDateSeparator(iso: string | null): string {
  if (!iso) return '';
  const normalized = /[Zz]$/.test(iso) || /[+-]\d{2}:\d{2}$/.test(iso) ? iso : iso + 'Z';
  const date = new Date(normalized);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const msgDay = new Date(date);
  msgDay.setHours(0, 0, 0, 0);
  const diffDays = Math.round((today.getTime() - msgDay.getTime()) / (24 * 60 * 60 * 1000));
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  return date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

function isSameDay(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  const norm = (s: string) => /[Zz]$/.test(s) || /[+-]\d{2}:\d{2}$/.test(s) ? s : s + 'Z';
  const da = new Date(norm(a));
  const db = new Date(norm(b));
  return da.getFullYear() === db.getFullYear() &&
    da.getMonth() === db.getMonth() &&
    da.getDate() === db.getDate();
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function ConversationDetailPage({ conversationId, onBack, onViewLead, onUnreadCleared }: Props) {
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [linkedLeads, setLinkedLeads] = useState<LinkedLead[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notFound, setNotFound] = useState(false);

  const [showLinkModal, setShowLinkModal] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [unlinkTarget, setUnlinkTarget] = useState<LinkedLead | null>(null);
  const [actionError, setActionError] = useState('');
  const [unlinking, setUnlinking] = useState(false);

  const [draftText, setDraftText] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState('');

  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const onUnreadClearedRef = useRef(onUnreadCleared);
  onUnreadClearedRef.current = onUnreadCleared;

  const refreshLinkedLeads = useCallback(async () => {
    const { data: bridgeData } = await supabase
      .from('whatsapp_conversation_leads')
      .select('lead_entry_id')
      .eq('conversation_id', conversationId);

    const leadIds = (bridgeData ?? []).map(b => b.lead_entry_id);

    if (leadIds.length > 0) {
      const { data: leadData } = await supabase
        .from('lead_entries')
        .select('id, client_name, company, lead_status, lead_temperature, state')
        .in('id', leadIds);

      setLinkedLeads((leadData ?? []).map(l => ({
        leadEntryId: l.id,
        clientName: l.client_name,
        company: l.company,
        leadStatus: l.lead_status,
        leadTemperature: l.lead_temperature,
        state: l.state,
      })));
    } else {
      setLinkedLeads([]);
    }
  }, [conversationId]);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError('');
      setNotFound(false);

      const { data: convData, error: convErr } = await supabase
        .from('whatsapp_conversations')
        .select(`
          id, conversation_code, wa_phone_number, status,
          last_message_at, last_inbound_at, last_outbound_at,
          customer_service_window_expires_at, unread_count,
          created_at, updated_at
        `)
        .eq('id', conversationId)
        .maybeSingle();

      if (cancelled) return;

      if (convErr) {
        setError(convErr.message || 'Failed to load conversation.');
        setLoading(false);
        return;
      }

      if (!convData) {
        setNotFound(true);
        setLoading(false);
        return;
      }

      setConversation(convData as Conversation);

      const conv = convData as Conversation;
      if (conv.unread_count > 0) {
        try {
          const identity = await getAuthIdentity();
          const readBy = identity?.repCode ?? null;
          const { error: markErr } = await supabase.rpc('mark_conversation_read', {
            p_conversation_id: conversationId,
            p_read_by: readBy,
          });
          if (markErr) {
            console.warn('[ConversationDetail] mark_conversation_read failed:', markErr.message);
          } else {
            setConversation({ ...conv, unread_count: 0 });
            onUnreadClearedRef.current?.();
          }
        } catch (err) {
          console.warn('[ConversationDetail] mark_conversation_read error:', err);
        }
      }

      const { data: msgData, error: msgErr } = await supabase
        .from('whatsapp_messages')
        .select(`
          id, direction, message_type, text_body,
          media_filename, media_mime_type, media_caption, media_url,
          timestamp, status, template_name,
          error_code, error_message
        `)
        .eq('conversation_id', conversationId)
        .order('timestamp', { ascending: true })
        .limit(500);

      if (cancelled) return;

      if (msgErr) {
        setError(msgErr.message || 'Failed to load messages.');
        setLoading(false);
        return;
      }

      setMessages((msgData ?? []).map(message => normalizeChatMessage(message as ChatMessage)));

      await refreshLinkedLeads();

      if (cancelled) return;
      setLoading(false);
    }

    load();
    return () => { cancelled = true; };
  }, [conversationId, refreshLinkedLeads]);

  useEffect(() => {
    if (scrollRef.current && messages.length > 0) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  // ── Poll for status updates from the webhook (every 10s) ──
  useEffect(() => {
    let cancelled = false;
    const interval = setInterval(async () => {
      if (cancelled) return;
      const { data: msgData } = await supabase
        .from('whatsapp_messages')
        .select(`
          id, direction, message_type, text_body,
          media_filename, media_mime_type, media_caption, media_url,
          timestamp, status, template_name,
          error_code, error_message
        `)
        .eq('conversation_id', conversationId)
        .order('timestamp', { ascending: true })
        .limit(500);
      if (!cancelled && msgData) {
        setMessages(msgData.map(message => normalizeChatMessage(message as ChatMessage)));
      }
    }, 10000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [conversationId]);

  async function handleSend() {
    const text = draftText.trim();
    if (!text || sending) return;
    setSending(true);
    setSendError('');

    try {
      const apiUrl = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/send-whatsapp-message`;
      const resp = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
        },
        body: JSON.stringify({
          conversation_id: conversationId,
          text_body: text,
        }),
      });

      const data = await resp.json();

      if (!resp.ok || !data.success) {
        setSendError(data.error || `Send failed (${resp.status})`);
        return;
      }

      // Success — clear draft and reload messages
      setDraftText('');
      setSendError('');

      // Reload messages from the database so the real outbound row appears
      const { data: msgData } = await supabase
        .from('whatsapp_messages')
        .select(`
          id, direction, message_type, text_body,
          media_filename, media_mime_type, media_caption, media_url,
          timestamp, status, template_name,
          error_code, error_message
        `)
        .eq('conversation_id', conversationId)
        .order('timestamp', { ascending: true })
        .limit(500);

      if (msgData) {
        setMessages(msgData.map(message => normalizeChatMessage(message as ChatMessage)));
      }

      // Update conversation timestamps locally
      const nowIso = new Date().toISOString();
      setConversation(prev => prev ? {
        ...prev,
        last_message_at: nowIso,
        last_outbound_at: nowIso,
      } : prev);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to send message';
      setSendError(msg);
    } finally {
      setSending(false);
      requestAnimationFrame(() => textareaRef.current?.focus());
    }
  }

  async function handleUnlink() {
    if (!unlinkTarget) return;
    setUnlinking(true);
    setActionError('');

    const { error: delErr } = await supabase
      .from('whatsapp_conversation_leads')
      .delete()
      .eq('conversation_id', conversationId)
      .eq('lead_entry_id', unlinkTarget.leadEntryId);

    if (delErr) {
      setActionError(delErr.message || 'Failed to unlink lead.');
      setUnlinking(false);
      return;
    }

    setUnlinkTarget(null);
    setUnlinking(false);
    await refreshLinkedLeads();
  }

  // ── Render states ──

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="w-6 h-6 text-stone-400 animate-spin" />
      </div>
    );
  }

  if (notFound) {
    return (
      <div className="p-6 max-w-2xl mx-auto">
        <button onClick={onBack} className="flex items-center gap-1.5 text-sm text-stone-500 hover:text-stone-700 transition mb-6">
          <ArrowLeft className="w-4 h-4" /> Back to Conversations
        </button>
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <div className="w-14 h-14 rounded-full bg-stone-100 flex items-center justify-center mb-4">
            <AlertCircle className="w-6 h-6 text-stone-400" />
          </div>
          <h2 className="text-sm font-semibold text-stone-700 mb-1">Conversation not found</h2>
          <p className="text-xs text-stone-400 max-w-xs">
            This conversation may have been removed or the link is invalid.
          </p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6 max-w-2xl mx-auto">
        <button onClick={onBack} className="flex items-center gap-1.5 text-sm text-stone-500 hover:text-stone-700 transition mb-6">
          <ArrowLeft className="w-4 h-4" /> Back to Conversations
        </button>
        <div className="flex items-center gap-2 px-4 py-3 bg-red-50 border border-red-200 text-red-700 text-sm rounded-xl">
          <AlertCircle className="w-4 h-4 flex-shrink-0" />
          {error}
        </div>
      </div>
    );
  }

  if (!conversation) return null;

  const window = deriveServiceWindow(conversation.customer_service_window_expires_at);
  const wCfg = WINDOW_CONFIG[window];
  const hasLeads = linkedLeads.length > 0;
  const existingLeadIds = linkedLeads.map(l => l.leadEntryId);

  return (
    <div className="max-w-6xl mx-auto p-4 md:p-6">
      {/* ── Back button ── */}
      <button
        onClick={onBack}
        className="flex items-center gap-1.5 text-sm text-stone-500 hover:text-stone-700 transition mb-4"
      >
        <ArrowLeft className="w-4 h-4" /> Back to Conversations
      </button>

      {/* ── Header ── */}
      <div className="bg-white border border-stone-200 rounded-xl px-4 py-3.5 mb-4">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="flex items-start gap-3 min-w-0">
            <div className="flex-shrink-0 w-10 h-10 rounded-full bg-stone-100 flex items-center justify-center">
              <MessageCircle className="w-5 h-5 text-stone-500" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h1 className="text-base font-semibold text-stone-800 truncate">
                  {conversation.wa_phone_number}
                </h1>
                {conversation.conversation_code && (
                  <span className="text-xs text-stone-400 font-mono px-1.5 py-0.5 bg-stone-50 rounded">
                    {conversation.conversation_code}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                {/* Status badge */}
                <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border ${
                  conversation.status.toLowerCase() === 'active'
                    ? 'bg-green-50 text-green-700 border-green-200'
                    : 'bg-stone-100 text-stone-600 border-stone-200'
                }`}>
                  <Circle className={`w-1.5 h-1.5 fill-current ${
                    conversation.status.toLowerCase() === 'active' ? 'text-green-500' : 'text-stone-400'
                  }`} />
                  {conversation.status}
                </span>
                {/* Service window badge */}
                <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium border ${wCfg.badgeCls}`}>
                  <span className={`w-1.5 h-1.5 rounded-full ${wCfg.dotCls}`} />
                  {wCfg.label}
                </span>
                {/* Unread badge */}
                {conversation.unread_count > 0 && (
                  <span className="inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-full bg-red-500 text-white text-xs font-bold tabular-nums">
                    {conversation.unread_count} unread
                  </span>
                )}
              </div>
            </div>
          </div>

          {/* Activity timestamps */}
          <div className="flex flex-col items-end gap-0.5 text-xs text-stone-400 flex-shrink-0">
            {conversation.last_inbound_at && (
              <span>Last inbound: {formatDateTime(conversation.last_inbound_at)}</span>
            )}
            {conversation.last_outbound_at && (
              <span>Last outbound: {formatDateTime(conversation.last_outbound_at)}</span>
            )}
            {!conversation.last_inbound_at && !conversation.last_outbound_at && (
              <span>No activity yet</span>
            )}
          </div>
        </div>
      </div>

      {/* ── Action error ── */}
      {actionError && (
        <div className="mb-3 flex items-center gap-2 px-4 py-2.5 bg-red-50 border border-red-200 text-red-700 text-xs rounded-xl">
          <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" />
          {actionError}
        </div>
      )}

      {/* ── Main layout: chat + info panel ── */}
      <div className="flex flex-col lg:flex-row gap-4">
        {/* ── Chat area ── */}
        <div className="flex-1 flex flex-col bg-white border border-stone-200 rounded-xl overflow-hidden min-w-0"
             style={{ minHeight: '400px', maxHeight: 'calc(100vh - 280px)' }}>
          {/* Messages scroll area */}
          <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 md:px-4 py-4 space-y-1 bg-stone-50/50">
            {messages.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full text-center py-12">
                <div className="w-14 h-14 rounded-full bg-stone-100 flex items-center justify-center mb-3">
                  <MessageCircle className="w-6 h-6 text-stone-400" />
                </div>
                <p className="text-sm font-medium text-stone-500">No messages yet</p>
                <p className="text-xs text-stone-400 mt-1">Messages will appear here once the conversation starts.</p>
              </div>
            ) : (
              <>
                {messages.map((msg, idx) => {
                  const isInbound = msg.direction === 'inbound';
                  const statusInfo = isInbound ? null : STATUS_ICONS[deriveOutboundStatus(msg)];
                  const isText = msg.message_type === 'text' && msg.text_body;
                  const time = formatTimeOnly(msg.timestamp);
                  const prevMsg = idx > 0 ? messages[idx - 1] : null;
                  const showDateSep = !prevMsg || !isSameDay(prevMsg.timestamp, msg.timestamp);

                  return (
                    <div key={msg.id}>
                      {/* Date separator */}
                      {showDateSep && (
                        <div className="flex items-center justify-center my-3">
                          <span className="text-[10px] font-medium text-stone-400 bg-stone-100 px-2.5 py-1 rounded-full">
                            {formatDateSeparator(msg.timestamp)}
                          </span>
                        </div>
                      )}

                      {/* Message bubble */}
                      <div className={`flex ${isInbound ? 'justify-start' : 'justify-end'}`}>
                        <div className={`max-w-[80%] md:max-w-[70%] rounded-2xl px-3.5 py-2.5 ${
                          isInbound
                            ? 'bg-white border border-stone-200 text-stone-800 rounded-tl-sm shadow-sm'
                            : 'bg-stone-800 text-white rounded-tr-sm'
                        }`}>
                          {/* Text message */}
                          {isText && (
                            <p className="text-sm whitespace-pre-wrap break-words leading-relaxed">
                              {msg.text_body}
                            </p>
                          )}

                          {/* Media message */}
                          {!isText && (
                            <div className="space-y-2">
                              {/* Image preview if URL available */}
                              {msg.message_type === 'image' && msg.media_url ? (
                                <div className="rounded-lg overflow-hidden bg-stone-100 max-w-[240px]">
                                  <img
                                    src={msg.media_url}
                                    alt={msg.media_caption ?? msg.media_filename ?? 'Image'}
                                    className="w-full h-auto object-cover"
                                    loading="lazy"
                                  />
                                </div>
                              ) : (
                                /* Media placeholder card */
                                <div className={`flex items-center gap-3 rounded-lg px-3 py-2.5 ${
                                  isInbound ? 'bg-stone-50' : 'bg-stone-700/50'
                                }`}>
                                  <span className={`flex-shrink-0 ${isInbound ? 'text-stone-500' : 'text-stone-300'}`}>
                                    {getMediaIcon(msg)}
                                  </span>
                                  <div className="min-w-0">
                                    <p className="text-sm font-medium truncate">
                                      {getMediaLabel(msg)}
                                    </p>
                                    <p className={`text-[10px] mt-0.5 uppercase tracking-wide ${
                                      isInbound ? 'text-stone-400' : 'text-stone-400'
                                    }`}>
                                      {getMediaTypeLabel(msg)}
                                      {msg.media_mime_type ? ` · ${msg.media_mime_type}` : ''}
                                    </p>
                                  </div>
                                </div>
                              )}

                              {/* Caption under media */}
                              {msg.media_caption && (
                                <p className={`text-sm whitespace-pre-wrap break-words ${
                                  isInbound ? 'text-stone-700' : 'text-stone-200'
                                }`}>
                                  {msg.media_caption}
                                </p>
                              )}
                            </div>
                          )}

                          {/* Failed message error detail */}
                          {(!isInbound && deriveOutboundStatus(msg) === 'failed' && msg.error_message) && (
                            <div className="mt-1.5 px-2 py-1 rounded-lg bg-red-500/10 border border-red-500/20 text-[11px] text-red-300">
                              {msg.error_code != null && (
                                <span className="font-mono font-medium">[{msg.error_code}] </span>
                              )}
                              {msg.error_message}
                            </div>
                          )}

                          {/* Timestamp + status */}
                          <div className="flex items-center gap-1 mt-1 justify-end text-[10px] tabular-nums text-stone-400">
                            {time && <span>{time}</span>}
                            {statusInfo && statusInfo.icon && (
                              <span className={`flex items-center gap-0.5 ${statusInfo.cls}`}>
                                {statusInfo.icon}
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </>
            )}
          </div>

          {/* ── Composer ── */}
          <div className="border-t border-stone-100 px-3 md:px-4 py-3 bg-stone-50">
            {/* Send error */}
            {sendError && (
              <div className="mb-2 flex items-center gap-1.5 px-3 py-1.5 bg-red-50 border border-red-200 text-red-700 text-xs rounded-lg">
                <AlertCircle className="w-3 h-3 flex-shrink-0" />
                {sendError}
              </div>
            )}

            {(window === 'open' || window === 'expiring') ? (
              <div className="flex items-end gap-2">
                <textarea
                  ref={textareaRef}
                  value={draftText}
                  onChange={e => setDraftText(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      if (draftText.trim() && !sending) handleSend();
                    }
                  }}
                  placeholder="Type a message…"
                  rows={1}
                  className="flex-1 resize-none px-3.5 py-2.5 text-sm border border-stone-200 rounded-2xl bg-white text-stone-800 placeholder:text-stone-400 focus:outline-none focus:ring-2 focus:ring-amber-500 focus:border-transparent transition max-h-32"
                  style={{ minHeight: '42px' }}
                />
                <button
                  onClick={handleSend}
                  disabled={!draftText.trim() || sending}
                  className="flex-shrink-0 w-10 h-10 rounded-full flex items-center justify-center transition disabled:bg-stone-100 disabled:cursor-not-allowed bg-stone-800 hover:bg-stone-700 text-white"
                >
                  {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <div className="flex-1 flex items-center gap-2 px-3.5 py-3 bg-white border border-stone-200 rounded-2xl opacity-60 cursor-not-allowed select-none">
                  <Lock className="w-4 h-4 text-stone-400 flex-shrink-0" />
                  <span className="text-sm text-stone-400">
                    {window === 'closed'
                      ? 'Service window expired. Free-form replies are unavailable.'
                      : 'No service window. Free-form replies are unavailable.'}
                  </span>
                </div>
                <button
                  disabled
                  className="flex-shrink-0 w-10 h-10 rounded-full bg-stone-100 flex items-center justify-center opacity-50 cursor-not-allowed"
                  title="Choose Template (coming soon)"
                >
                  <FileCheck2 className="w-4 h-4 text-stone-400" />
                </button>
              </div>
            )}
          </div>
        </div>

        {/* ── Conversation Info panel ── */}
        <div className="lg:w-72 flex-shrink-0 space-y-3">
          {/* WhatsApp number */}
          <div className="bg-white border border-stone-200 rounded-xl px-4 py-3">
            <div className="flex items-center gap-2 mb-1">
              <Phone className="w-3.5 h-3.5 text-stone-400" />
              <span className="text-xs text-stone-400 font-medium">WhatsApp Number</span>
            </div>
            <p className="text-sm font-semibold text-stone-800">{conversation.wa_phone_number}</p>
          </div>

          {/* Service window detail */}
          <div className={`border rounded-xl px-4 py-3 ${wCfg.panelBorder} ${wCfg.panelBg}`}>
            <div className="flex items-center gap-2 mb-1.5">
              <Clock className={`w-3.5 h-3.5 ${wCfg.iconCls}`} />
              <span className="text-xs text-stone-500 font-medium">Service Window</span>
            </div>
            {conversation.customer_service_window_expires_at ? (
              <div>
                <p className="text-sm font-semibold text-stone-800">
                  {wCfg.label}
                </p>
                {window === 'open' && (
                  <p className="text-xs text-stone-500 mt-0.5">
                    {(() => {
                      const expiresAt = conversation.customer_service_window_expires_at;
                      const normalized = /[Zz]$/.test(expiresAt) || /[+-]\d{2}:?\d{2}$/.test(expiresAt)
                        ? expiresAt
                        : expiresAt.replace(' ', 'T') + 'Z';
                      const diff = new Date(normalized).getTime() - Date.now();
                      if (diff <= 0) return 'expired';
                      const hours = Math.floor(diff / (60 * 60 * 1000));
                      const minutes = Math.floor((diff % (60 * 60 * 1000)) / (60 * 1000));
                      return hours > 0 ? `${hours}h ${minutes}m remaining` : `${minutes}m remaining`;
                    })()}
                  </p>
                )}
                {window === 'expiring' && (
                  <p className="text-xs text-amber-600 mt-0.5 font-medium">
                    {formatRemaining(conversation.customer_service_window_expires_at)}
                  </p>
                )}
                {window === 'closed' && (
                  <p className="text-xs text-stone-400 mt-0.5">
                    {formatExpiredAgo(conversation.customer_service_window_expires_at)}
                  </p>
                )}
                <p className="text-[10px] text-stone-400 mt-1">
                  {window === 'closed' ? 'Expired' : 'Expires'}: {formatDateTime(conversation.customer_service_window_expires_at)}
                </p>
              </div>
            ) : (
              <p className="text-sm text-stone-400">No service window set</p>
            )}
          </div>

          {/* Linked Leads */}
          <div className="bg-white border border-stone-200 rounded-xl px-4 py-3">
            <div className="flex items-center gap-2 mb-2">
              <Link2 className="w-3.5 h-3.5 text-stone-400" />
              <span className="text-xs text-stone-400 font-medium">Linked Leads</span>
              {hasLeads && (
                <span className="text-[10px] text-stone-400 ml-auto">{linkedLeads.length}</span>
              )}
            </div>

            {hasLeads ? (
              <div className="space-y-2">
                {linkedLeads.map(lead => (
                  <div key={lead.leadEntryId} className="border border-stone-100 rounded-lg px-3 py-2.5 hover:border-stone-200 transition">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-stone-800 truncate">
                          {lead.clientName || 'Unnamed Lead'}
                        </p>
                        {lead.company && (
                          <p className="text-xs text-stone-500 mt-0.5 truncate">{lead.company}</p>
                        )}
                        <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                          {lead.leadStatus && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-stone-100 text-stone-500 font-medium">
                              {lead.leadStatus}
                            </span>
                          )}
                          {lead.leadTemperature && (
                            <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${
                              lead.leadTemperature === 'Hot' ? 'bg-red-50 text-red-600'
                              : lead.leadTemperature === 'Warm' ? 'bg-amber-50 text-amber-600'
                              : 'bg-stone-100 text-stone-500'
                            }`}>
                              {lead.leadTemperature}
                            </span>
                          )}
                          {lead.state && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-stone-100 text-stone-500 font-medium">
                              {lead.state}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-1 mt-2">
                      <button
                        onClick={() => onViewLead(lead.leadEntryId)}
                        className="flex items-center gap-1 px-2 py-1 text-xs font-medium text-stone-600 hover:text-stone-900 hover:bg-stone-50 rounded-lg transition"
                      >
                        <ExternalLink className="w-3 h-3" />
                        View
                      </button>
                      <button
                        onClick={() => { setActionError(''); setUnlinkTarget(lead); }}
                        className="flex items-center gap-1 px-2 py-1 text-xs font-medium text-red-500 hover:text-red-700 hover:bg-red-50 rounded-lg transition"
                      >
                        <Unlink className="w-3 h-3" />
                        Unlink
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="flex items-center gap-2 py-2">
                <Link2Off className="w-4 h-4 text-orange-400" />
                <span className="text-sm text-orange-600 font-medium">Unmatched conversation</span>
              </div>
            )}

            {/* Actions */}
            <div className="mt-3 pt-3 border-t border-stone-100 space-y-2">
              {!hasLeads && (
                <button
                  onClick={() => { setActionError(''); setShowCreateModal(true); }}
                  className="w-full flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg border border-stone-200 text-stone-700 hover:bg-stone-50 transition"
                >
                  <Plus className="w-3.5 h-3.5" />
                  Create Lead
                </button>
              )}
              <button
                onClick={() => { setActionError(''); setShowLinkModal(true); }}
                className="w-full flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg border border-stone-200 text-stone-700 hover:bg-stone-50 transition"
              >
                <Link2 className="w-3.5 h-3.5" />
                {hasLeads ? 'Link Another Lead' : 'Link Existing Lead'}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* ── Link Existing Lead Modal ── */}
      {showLinkModal && (
        <LinkExistingLeadModal
          conversationId={conversationId}
          existingLeadIds={existingLeadIds}
          onClose={() => setShowLinkModal(false)}
          onLinked={() => refreshLinkedLeads()}
        />
      )}

      {/* ── Create Lead Modal ── */}
      {showCreateModal && (
        <CreateLeadModal
          conversationId={conversationId}
          waPhoneNumber={conversation.wa_phone_number}
          onClose={() => setShowCreateModal(false)}
          onCreated={() => refreshLinkedLeads()}
        />
      )}

      {/* ── Unlink Confirmation Modal ── */}
      {unlinkTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/30">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm">
            <div className="px-5 py-4 border-b border-stone-100">
              <h3 className="text-base font-semibold text-stone-800">Unlink Lead</h3>
            </div>
            <div className="px-5 py-4">
              <p className="text-sm text-stone-600">
                Are you sure you want to unlink{' '}
                <span className="font-medium text-stone-800">
                  {unlinkTarget.clientName || 'this lead'}
                </span>{' '}
                from this conversation?
              </p>
              <p className="text-xs text-stone-400 mt-2">
                This only removes the link. The lead itself and all messages remain unchanged.
              </p>
            </div>
            <div className="px-5 py-3 border-t border-stone-100 flex justify-end gap-2">
              <button
                onClick={() => setUnlinkTarget(null)}
                disabled={unlinking}
                className="px-4 py-2 text-sm font-medium text-stone-600 hover:bg-stone-100 rounded-lg transition disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={handleUnlink}
                disabled={unlinking}
                className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-red-500 hover:bg-red-600 rounded-lg transition disabled:opacity-50"
              >
                {unlinking ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Unlink className="w-3.5 h-3.5" />}
                Unlink
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
