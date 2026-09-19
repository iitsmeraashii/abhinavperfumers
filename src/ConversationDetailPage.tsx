import { useEffect, useState, useRef, useCallback } from 'react';
import { supabase } from './supabaseClient';
import { useAuth } from './AuthContext';
import {
  ArrowLeft, Loader2, AlertCircle, MessageCircle, Phone,
  Link2, Link2Off, ExternalLink, Clock, Send,
  FileText, Image as ImageIcon, Headphones, FileVideo, FileCheck,
  CheckCheck, Check, X, Circle, Plus, Unlink,
  AlertTriangle, Lock, ChevronDown, ChevronUp, RotateCw,
  Paperclip, Search, Globe, LayoutTemplate,
} from 'lucide-react';
import { formatDateTime } from './utils/dateFormat';
import { formatBytes } from './utils/formatBytes';
import { getAuthIdentity } from './capture/captureAuth';
import LinkExistingLeadModal from './LinkExistingLeadModal';
import CreateLeadModal from './CreateLeadModal';

// ── Types ───────────────────────────────────────────────────────────────────

interface Conversation {
  id: string;
  conversation_code: string | null;
  profile_name: string | null;
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
  error_title: string | null;
  error_message: string | null;
  error_details: string | null;
  retry_count: number | null;
  retry_at: string | null;
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

interface PickerAsset {
  id: string;
  name: string;
  description: string | null;
  asset_type: 'DOCUMENT' | 'IMAGE';
  file_name: string;
  mime_type: string;
  file_size: number | null;
  share_message: string | null;
}

type AssetFilter = 'all' | 'DOCUMENT' | 'IMAGE';

interface MetaTemplateComponent {
  type: string;
  format?: string;
  text?: string;
  example?: Record<string, unknown>;
}

interface MetaTemplate {
  name: string;
  id: string;
  status: string;
  category: string;
  language: string;
  components: MetaTemplateComponent[];
}

function getTemplateHeaderFormat(tpl: MetaTemplate): string | null {
  const header = tpl.components.find(c => c.type.toLowerCase() === 'header');
  return header?.format?.toUpperCase() ?? null;
}

function getTemplateBodyExampleParams(tpl: MetaTemplate): string[] {
  const body = tpl.components.find(c => c.type.toLowerCase() === 'body');
  if (!body?.text) return [];
  const matches = body.text.match(/\{\{(\d+)\}\}/g);
  if (!matches) return [];
  const indices = [...new Set(matches.map(m => m.replace(/[{}]/g, '')))];
  return indices.sort();
}

function isTemplateCompatible(tpl: MetaTemplate, assetType: 'IMAGE' | 'DOCUMENT'): boolean {
  const fmt = getTemplateHeaderFormat(tpl);
  if (!fmt) return false;
  if (assetType === 'IMAGE') return fmt === 'IMAGE';
  if (assetType === 'DOCUMENT') return fmt === 'DOCUMENT';
  return false;
}

function isTextOnlyTemplate(tpl: MetaTemplate): boolean {
  const fmt = getTemplateHeaderFormat(tpl);
  return !fmt || fmt === 'TEXT';
}

function getTemplateBodyText(tpl: MetaTemplate): string | null {
  const body = tpl.components.find(c => c.type.toLowerCase() === 'body');
  return body?.text ?? null;
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

function normalizeIso(iso: string): string {
  return /[Zz]$/.test(iso) || /[+-]\d{2}:?\d{2}$/.test(iso)
    ? iso
    : iso.replace(' ', 'T') + 'Z';
}

function formatRemaining(expiresAt: string): string {
  const expires = new Date(normalizeIso(expiresAt)).getTime();
  if (isNaN(expires)) return '';
  const diff = expires - Date.now();
  if (diff <= 0) return 'expired';
  const hours = Math.floor(diff / (60 * 60 * 1000));
  const minutes = Math.floor((diff % (60 * 60 * 1000)) / (60 * 1000));
  if (hours > 0) return `${hours}h ${minutes}m remaining`;
  return `${minutes}m remaining`;
}

function formatExpiredAgo(expiresAt: string): string {
  const expires = new Date(normalizeIso(expiresAt)).getTime();
  if (isNaN(expires)) return '';
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
  const expires = new Date(normalizeIso(expiresAt)).getTime();
  if (isNaN(expires)) return 'none';
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
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
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

  const [expandedErrors, setExpandedErrors] = useState<Set<string>>(new Set());

  const [draftText, setDraftText] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState('');
  const [selectedAsset, setSelectedAsset] = useState<PickerAsset | null>(null);
  const [assetMessage, setAssetMessage] = useState('');
  const [showAssetPicker, setShowAssetPicker] = useState(false);

  // Template send state (expired window)
  const [selectedTemplate, setSelectedTemplate] = useState<MetaTemplate | null>(null);
  const [showTemplatePicker, setShowTemplatePicker] = useState(false);
  const [templateParams, setTemplateParams] = useState<string[]>([]);

  const [textOnlyTemplate, setTextOnlyTemplate] = useState<MetaTemplate | null>(null);
  const [showTextOnlyPicker, setShowTextOnlyPicker] = useState(false);
  const [textOnlyParams, setTextOnlyParams] = useState<string[]>([]);

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
          id, conversation_code, profile_name, wa_phone_number, status,
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
          error_code, error_title, error_message, error_details,
          retry_count, retry_at
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
          error_code, error_title, error_message, error_details,
          retry_count, retry_at
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
    const sw = deriveServiceWindow(conversation?.customer_service_window_expires_at ?? null);
    const isAssetSend = !!selectedAsset && (sw === 'open' || sw === 'expiring');
    const isTemplateAssetSend = !!selectedAsset && !!selectedTemplate && (sw === 'closed' || sw === 'none');
    const isTextOnlySend = !!textOnlyTemplate && !selectedAsset && (sw === 'closed' || sw === 'none');
    if ((!text && !isAssetSend && !isTemplateAssetSend && !isTextOnlySend) || sending) return;
    setSending(true);
    setSendError('');

    try {
      const apiUrl = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/send-whatsapp-message`;
      const payload: Record<string, unknown> = { conversation_id: conversationId };
      if (isTemplateAssetSend) {
        payload.asset_id = selectedAsset!.id;
        payload.template_name = selectedTemplate!.name;
        payload.template_language = selectedTemplate!.language;
        const bodyParamIndices = getTemplateBodyExampleParams(selectedTemplate!);
        if (bodyParamIndices.length > 0 && templateParams.some(p => p.trim())) {
          payload.template_params = bodyParamIndices.map((_, i) => ({
            type: 'text',
            text: templateParams[i]?.trim() || '',
          }));
        }
      } else if (isTextOnlySend) {
        payload.template_name = textOnlyTemplate!.name;
        payload.template_language = textOnlyTemplate!.language;
        const bodyParamIndices = getTemplateBodyExampleParams(textOnlyTemplate!);
        if (bodyParamIndices.length > 0 && textOnlyParams.some(p => p.trim())) {
          payload.template_params = bodyParamIndices.map((_, i) => ({
            type: 'text',
            text: textOnlyParams[i]?.trim() || '',
          }));
        }
      } else if (isAssetSend) {
        payload.asset_id = selectedAsset!.id;
        if (assetMessage.trim()) payload.share_message = assetMessage.trim();
      } else {
        payload.text_body = text;
      }
      const resp = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
        },
        body: JSON.stringify(payload),
      });

      const data = await resp.json();

      if (!resp.ok || !data.success) {
        setSendError(data.error || `Send failed (${resp.status})`);
        return;
      }

      // Success — clear draft/asset/template and reload messages
      setDraftText('');
      setSelectedAsset(null);
      setAssetMessage('');
      setSelectedTemplate(null);
      setTemplateParams([]);
      setTextOnlyTemplate(null);
      setTextOnlyParams([]);
      setSendError('');

      // Reload messages from the database so the real outbound row appears
      const { data: msgData } = await supabase
        .from('whatsapp_messages')
        .select(`
          id, direction, message_type, text_body,
          media_filename, media_mime_type, media_caption, media_url,
          timestamp, status, template_name,
          error_code, error_title, error_message, error_details,
          retry_count, retry_at
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

  const serviceWindow = deriveServiceWindow(conversation.customer_service_window_expires_at);
  const wCfg = WINDOW_CONFIG[serviceWindow];
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
                  {conversation.profile_name?.trim() || conversation.wa_phone_number}
                </h1>
                {conversation.profile_name?.trim() && (
                  <span className="text-sm text-stone-500 truncate">
                    {conversation.wa_phone_number}
                  </span>
                )}
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

                              {/* Caption under image media only */}
                              {msg.message_type === 'image' && msg.media_caption && (
                                <p className={`text-sm whitespace-pre-wrap break-words ${
                                  isInbound ? 'text-stone-700' : 'text-stone-200'
                                }`}>
                                  {msg.media_caption}
                                </p>
                              )}
                            </div>
                          )}

                          {/* Failed message state */}
                          {(!isInbound && deriveOutboundStatus(msg) === 'failed') && (
                            <div className="mt-1.5">
                              <div className="flex items-center justify-between gap-3 whitespace-nowrap">
                                <div className="flex items-center gap-1.5 text-[11px] text-red-300">
                                  <AlertTriangle className="w-3 h-3 flex-shrink-0" />
                                  <span>Failed to send</span>
                                </div>
                                {msg.retry_at && (
                                  <div className="flex items-center gap-1.5 text-[10px] text-amber-300/80">
                                    <RotateCw className="w-2.5 h-2.5 flex-shrink-0" />
                                    <span>
                                      Retry scheduled · Next attempt: {formatDateTime(msg.retry_at)}
                                      {msg.retry_count != null && <span> · Attempt {msg.retry_count} / 3</span>}
                                    </span>
                                  </div>
                                )}
                                {(msg.error_message || msg.error_title || msg.error_details || msg.error_code != null) && (
                                  <button
                                    onClick={() => setExpandedErrors(prev => {
                                      const next = new Set(prev);
                                      if (next.has(msg.id)) next.delete(msg.id);
                                      else next.add(msg.id);
                                      return next;
                                    })}
                                    className="flex items-center gap-1 text-[10px] text-stone-400 hover:text-stone-300 transition"
                                  >
                                    {expandedErrors.has(msg.id) ? <ChevronUp className="w-2.5 h-2.5" /> : <ChevronDown className="w-2.5 h-2.5" />}
                                    Details
                                  </button>
                                )}
                              </div>
                              {expandedErrors.has(msg.id) && (
                                <div className="mt-1 w-full max-h-32 overflow-x-auto overflow-y-auto px-2 py-1.5 rounded-lg bg-red-500/10 border border-red-500/20 text-[10px] text-red-200/90 space-y-0.5 font-mono break-all">
                                  {msg.error_code != null && (
                                    <p><span className="text-red-300/60">Code:</span> {msg.error_code}</p>
                                  )}
                                  {msg.error_title && (
                                    <p><span className="text-red-300/60">Title:</span> {msg.error_title}</p>
                                  )}
                                  {msg.error_message && (
                                    <p><span className="text-red-300/60">Message:</span> {msg.error_message}</p>
                                  )}
                                  {msg.error_details && (
                                    <p><span className="text-red-300/60">Details:</span> {msg.error_details}</p>
                                  )}
                                </div>
                              )}
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

            {(serviceWindow === 'open' || serviceWindow === 'expiring') ? (
              <>
              {/* Asset attachment preview with editable message */}
              {selectedAsset && (
                <div className="mb-2 px-3 py-2.5 bg-amber-50 border border-amber-200 rounded-lg">
                  <div className="flex items-start gap-2.5">
                    <div className="flex-shrink-0 w-8 h-8 rounded-lg bg-white border border-amber-200 flex items-center justify-center overflow-hidden">
                      {selectedAsset.asset_type === 'IMAGE'
                        ? <ImageIcon className="w-4 h-4 text-stone-500" />
                        : <FileText className="w-4 h-4 text-stone-500" />}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-stone-800 truncate">{selectedAsset.name}</p>
                      <p className="text-xs text-stone-500 truncate">
                        {selectedAsset.file_name}
                        {selectedAsset.file_size != null && ` · ${formatBytes(selectedAsset.file_size)}`}
                      </p>
                    </div>
                    <button
                      onClick={() => { setSelectedAsset(null); setAssetMessage(''); }}
                      className="flex-shrink-0 p-1.5 rounded-lg text-stone-400 hover:bg-stone-100 hover:text-stone-600 transition"
                      aria-label="Remove attachment"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                  <div className="mt-2">
                    <label className="block text-[10px] font-medium text-stone-500 uppercase tracking-wide mb-1">
                      Message for this send
                    </label>
                    <textarea
                      value={assetMessage}
                      onChange={e => setAssetMessage(e.target.value)}
                      placeholder={selectedAsset.asset_type === 'IMAGE'
                        ? 'Add a caption for this image…'
                        : 'Add a message to send with this document…'}
                      rows={2}
                      className="w-full px-2.5 py-2 text-sm border border-amber-200 rounded-lg bg-white text-stone-800 placeholder:text-stone-400 focus:outline-none focus:ring-2 focus:ring-amber-500 focus:border-transparent transition resize-none"
                    />
                  </div>
                </div>
              )}
              <div className="flex items-end gap-2">
                <button
                  onClick={() => setShowAssetPicker(true)}
                  disabled={sending || !!selectedAsset}
                  className="flex-shrink-0 w-10 h-10 rounded-full flex items-center justify-center transition disabled:opacity-40 disabled:cursor-not-allowed border border-stone-200 bg-white text-stone-500 hover:bg-stone-50 hover:text-stone-700"
                  title="Attach asset"
                >
                  <Paperclip className="w-4 h-4" />
                </button>
                <textarea
                  ref={textareaRef}
                  value={draftText}
                  onChange={e => setDraftText(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      if ((draftText.trim() || selectedAsset) && !sending) handleSend();
                    }
                  }}
                  placeholder={selectedAsset ? 'Add a message (optional)…' : 'Type a message…'}
                  rows={1}
                  className="flex-1 resize-none px-3.5 py-2.5 text-sm border border-stone-200 rounded-2xl bg-white text-stone-800 placeholder:text-stone-400 focus:outline-none focus:ring-2 focus:ring-amber-500 focus:border-transparent transition max-h-32"
                  style={{ minHeight: '42px' }}
                />
                <button
                  onClick={handleSend}
                  disabled={(!draftText.trim() && !selectedAsset) || sending}
                  className="flex-shrink-0 w-10 h-10 rounded-full flex items-center justify-center transition disabled:bg-stone-100 disabled:cursor-not-allowed bg-stone-800 hover:bg-stone-700 text-white"
                >
                  {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                </button>
              </div>
              </>
            ) : (
              <div className="space-y-2">
                {/* Expired window info banner */}
                <div className="flex items-center gap-2 px-3 py-2 bg-stone-100 border border-stone-200 rounded-lg">
                  <Lock className="w-3.5 h-3.5 text-stone-400 flex-shrink-0" />
                  <span className="text-xs text-stone-500">
                    {serviceWindow === 'closed'
                      ? 'Service window expired. Send an approved template with an asset.'
                      : 'No service window. Send an approved template with an asset.'}
                  </span>
                </div>

                {/* Asset selection for template send */}
                {selectedAsset && selectedTemplate ? (
                  <div className="px-3 py-2.5 bg-amber-50 border border-amber-200 rounded-lg space-y-3">
                    {/* Asset info */}
                    <div className="flex items-start gap-2.5">
                      <div className="flex-shrink-0 w-8 h-8 rounded-lg bg-white border border-amber-200 flex items-center justify-center overflow-hidden">
                        {selectedAsset.asset_type === 'IMAGE'
                          ? <ImageIcon className="w-4 h-4 text-stone-500" />
                          : <FileText className="w-4 h-4 text-stone-500" />}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-stone-800 truncate">{selectedAsset.name}</p>
                        <p className="text-xs text-stone-500 truncate">
                          {selectedAsset.file_name}
                          {selectedAsset.file_size != null && ` · ${formatBytes(selectedAsset.file_size)}`}
                        </p>
                      </div>
                      <button
                        onClick={() => { setSelectedAsset(null); setSelectedTemplate(null); setTemplateParams([]); }}
                        className="flex-shrink-0 p-1.5 rounded-lg text-stone-400 hover:bg-stone-100 hover:text-stone-600 transition"
                        aria-label="Remove attachment"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>

                    {/* Template info */}
                    <div className="flex items-start gap-2.5 pt-2 border-t border-amber-200/60">
                      <div className="flex-shrink-0 w-8 h-8 rounded-lg bg-white border border-amber-200 flex items-center justify-center">
                        <LayoutTemplate className="w-4 h-4 text-stone-500" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-stone-800 truncate">{selectedTemplate.name}</p>
                        <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-stone-100 text-stone-500 font-medium">
                            {getTemplateHeaderFormat(selectedTemplate) ?? 'No header'}
                          </span>
                          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-stone-100 text-stone-500 font-medium flex items-center gap-0.5">
                            <Globe className="w-2.5 h-2.5" />
                            {selectedTemplate.language}
                          </span>
                          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-stone-100 text-stone-500 font-medium">
                            {selectedTemplate.category}
                          </span>
                        </div>
                      </div>
                      <button
                        onClick={() => { setSelectedTemplate(null); setTemplateParams([]); }}
                        className="flex-shrink-0 text-[10px] font-medium text-stone-500 hover:text-stone-700 transition px-1.5 py-1 rounded"
                      >
                        Change
                      </button>
                    </div>

                    {/* Template body parameters */}
                    {(() => {
                      const bodyParams = getTemplateBodyExampleParams(selectedTemplate);
                      if (bodyParams.length === 0) return null;
                      return (
                        <div className="pt-2 border-t border-amber-200/60">
                          <label className="block text-[10px] font-medium text-stone-500 uppercase tracking-wide mb-1.5">
                            Template Parameters
                          </label>
                          <div className="space-y-1.5">
                            {bodyParams.map((idx, i) => (
                              <div key={idx}>
                                <label className="block text-[10px] text-stone-400 mb-0.5">Parameter {idx}</label>
                                <input
                                  type="text"
                                  value={templateParams[i] ?? ''}
                                  onChange={e => {
                                    const next = [...templateParams];
                                    next[i] = e.target.value;
                                    setTemplateParams(next);
                                  }}
                                  placeholder={`Value for {{${idx}}}`}
                                  className="w-full px-2.5 py-1.5 text-sm border border-amber-200 rounded-lg bg-white text-stone-800 placeholder:text-stone-400 focus:outline-none focus:ring-2 focus:ring-amber-500 focus:border-transparent transition"
                                />
                              </div>
                            ))}
                          </div>
                        </div>
                      );
                    })()}

                    {/* Send button */}
                    <div className="flex items-center gap-2 pt-2 border-t border-amber-200/60">
                      <button
                        onClick={() => { setSelectedAsset(null); setSelectedTemplate(null); setTemplateParams([]); }}
                        disabled={sending}
                        className="flex-1 px-3 py-2 text-sm font-medium text-stone-600 border border-stone-200 rounded-lg hover:bg-stone-50 transition disabled:opacity-50"
                      >
                        Cancel
                      </button>
                      <button
                        onClick={handleSend}
                        disabled={sending}
                        className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-sm font-medium text-white bg-stone-800 hover:bg-stone-700 rounded-lg transition disabled:opacity-50"
                      >
                        {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                        Send Template
                      </button>
                    </div>
                  </div>
                ) : textOnlyTemplate ? (
                  /* Text-only template selected (no asset) */
                  <div className="px-3 py-2.5 bg-amber-50 border border-amber-200 rounded-lg space-y-3">
                    <div className="flex items-start gap-2.5">
                      <div className="flex-shrink-0 w-8 h-8 rounded-lg bg-white border border-amber-200 flex items-center justify-center">
                        <LayoutTemplate className="w-4 h-4 text-stone-500" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-stone-800 truncate">{textOnlyTemplate.name}</p>
                        <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-stone-100 text-stone-500 font-medium">
                            Text only
                          </span>
                          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-stone-100 text-stone-500 font-medium flex items-center gap-0.5">
                            <Globe className="w-2.5 h-2.5" />
                            {textOnlyTemplate.language}
                          </span>
                          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-stone-100 text-stone-500 font-medium">
                            {textOnlyTemplate.category}
                          </span>
                        </div>
                      </div>
                      <button
                        onClick={() => { setTextOnlyTemplate(null); setTextOnlyParams([]); }}
                        className="flex-shrink-0 p-1.5 rounded-lg text-stone-400 hover:bg-stone-100 hover:text-stone-600 transition"
                        aria-label="Remove template"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>

                    {/* Template body preview */}
                    {(() => {
                      const bodyText = getTemplateBodyText(textOnlyTemplate);
                      if (!bodyText) return null;
                      return (
                        <div className="pt-2 border-t border-amber-200/60">
                          <label className="block text-[10px] font-medium text-stone-500 uppercase tracking-wide mb-1">
                            Template Body
                          </label>
                          <p className="text-xs text-stone-600 leading-relaxed bg-white border border-amber-200/50 rounded-lg px-2.5 py-2">
                            {bodyText}
                          </p>
                        </div>
                      );
                    })()}

                    {/* Template body parameters */}
                    {(() => {
                      const bodyParams = getTemplateBodyExampleParams(textOnlyTemplate);
                      if (bodyParams.length === 0) return null;
                      return (
                        <div className="pt-2 border-t border-amber-200/60">
                          <label className="block text-[10px] font-medium text-stone-500 uppercase tracking-wide mb-1.5">
                            Template Parameters
                          </label>
                          <div className="space-y-1.5">
                            {bodyParams.map((idx, i) => (
                              <div key={idx}>
                                <label className="block text-[10px] text-stone-400 mb-0.5">Parameter {idx}</label>
                                <input
                                  type="text"
                                  value={textOnlyParams[i] ?? ''}
                                  onChange={e => {
                                    const next = [...textOnlyParams];
                                    next[i] = e.target.value;
                                    setTextOnlyParams(next);
                                  }}
                                  placeholder={`Value for {{${idx}}}`}
                                  className="w-full px-2.5 py-1.5 text-sm border border-amber-200 rounded-lg bg-white text-stone-800 placeholder:text-stone-400 focus:outline-none focus:ring-2 focus:ring-amber-500 focus:border-transparent transition"
                                />
                              </div>
                            ))}
                          </div>
                        </div>
                      );
                    })()}

                    {/* Send / Cancel */}
                    <div className="flex items-center gap-2 pt-2 border-t border-amber-200/60">
                      <button
                        onClick={() => { setTextOnlyTemplate(null); setTextOnlyParams([]); }}
                        disabled={sending}
                        className="flex-1 px-3 py-2 text-sm font-medium text-stone-600 border border-stone-200 rounded-lg hover:bg-stone-50 transition disabled:opacity-50"
                      >
                        Cancel
                      </button>
                      <button
                        onClick={handleSend}
                        disabled={sending}
                        className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-sm font-medium text-white bg-stone-800 hover:bg-stone-700 rounded-lg transition disabled:opacity-50"
                      >
                        {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                        Send Template
                      </button>
                    </div>
                  </div>
                ) : selectedAsset ? (
                  /* Asset selected, need template */
                  <div className="space-y-2">
                    <div className="flex items-start gap-2.5 px-3 py-2.5 bg-amber-50 border border-amber-200 rounded-lg">
                      <div className="flex-shrink-0 w-8 h-8 rounded-lg bg-white border border-amber-200 flex items-center justify-center overflow-hidden">
                        {selectedAsset.asset_type === 'IMAGE'
                          ? <ImageIcon className="w-4 h-4 text-stone-500" />
                          : <FileText className="w-4 h-4 text-stone-500" />}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-stone-800 truncate">{selectedAsset.name}</p>
                        <p className="text-xs text-stone-500 truncate">
                          {selectedAsset.file_name}
                          {selectedAsset.file_size != null && ` · ${formatBytes(selectedAsset.file_size)}`}
                        </p>
                      </div>
                      <button
                        onClick={() => { setSelectedAsset(null); setTemplateParams([]); }}
                        className="flex-shrink-0 p-1.5 rounded-lg text-stone-400 hover:bg-stone-100 hover:text-stone-600 transition"
                        aria-label="Remove attachment"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                    <button
                      onClick={() => setShowTemplatePicker(true)}
                      className="w-full flex items-center justify-center gap-1.5 px-3 py-2.5 text-sm font-medium text-stone-700 border border-stone-200 rounded-lg hover:bg-stone-50 transition bg-white"
                    >
                      <LayoutTemplate className="w-4 h-4" />
                      Choose Template
                    </button>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <div className="flex items-center gap-2">
                      <div className="flex-1 flex items-center gap-2 px-3.5 py-3 bg-white border border-stone-200 rounded-2xl opacity-60 cursor-not-allowed select-none">
                        <Lock className="w-4 h-4 text-stone-400 flex-shrink-0" />
                        <span className="text-sm text-stone-400">
                          {serviceWindow === 'closed'
                            ? 'Service window expired. Free-form replies are unavailable.'
                            : 'No service window. Free-form replies are unavailable.'}
                        </span>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => setShowTextOnlyPicker(true)}
                        disabled={sending}
                        className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2.5 text-sm font-medium text-stone-700 border border-stone-200 rounded-lg hover:bg-stone-50 transition bg-white"
                      >
                        <LayoutTemplate className="w-4 h-4" />
                        Use Template
                      </button>
                      <button
                        onClick={() => setShowAssetPicker(true)}
                        disabled={sending}
                        className="flex items-center justify-center gap-1.5 px-3 py-2.5 text-sm font-medium text-stone-700 border border-stone-200 rounded-lg hover:bg-stone-50 transition bg-white"
                      >
                        <Paperclip className="w-4 h-4" />
                        Asset + Template
                      </button>
                    </div>
                  </div>
                )}
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
                {serviceWindow === 'open' && (
                  <p className="text-xs text-stone-500 mt-0.5">
                    {formatRemaining(conversation.customer_service_window_expires_at)}
                  </p>
                )}
                {serviceWindow === 'expiring' && (
                  <p className="text-xs text-amber-600 mt-0.5 font-medium">
                    {formatRemaining(conversation.customer_service_window_expires_at)}
                  </p>
                )}
                {serviceWindow === 'closed' && (
                  <p className="text-xs text-stone-400 mt-0.5">
                    {formatExpiredAgo(conversation.customer_service_window_expires_at)}
                  </p>
                )}
                <p className="text-[10px] text-stone-400 mt-1">
                  {serviceWindow === 'closed' ? 'Expired' : 'Expires'}: {formatDateTime(conversation.customer_service_window_expires_at)}
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

      {/* ── Asset Picker Modal ── */}
      {showAssetPicker && (
        <AssetPickerModal
          onSelect={(asset) => {
            setSelectedAsset(asset);
            setAssetMessage(asset.share_message ?? '');
            setShowAssetPicker(false);
          }}
          onClose={() => setShowAssetPicker(false)}
        />
      )}

      {/* ── Template Picker Modal (asset flow) ── */}
      {showTemplatePicker && selectedAsset && (
        <TemplatePickerModal
          assetType={selectedAsset.asset_type}
          onSelect={(tpl) => {
            setSelectedTemplate(tpl);
            setTemplateParams([]);
            setShowTemplatePicker(false);
          }}
          onClose={() => setShowTemplatePicker(false)}
        />
      )}

      {/* ── Text-Only Template Picker Modal ── */}
      {showTextOnlyPicker && (
        <TextOnlyTemplatePickerModal
          onSelect={(tpl) => {
            setTextOnlyTemplate(tpl);
            setTextOnlyParams([]);
            setShowTextOnlyPicker(false);
          }}
          onClose={() => setShowTextOnlyPicker(false)}
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

// ── Asset Picker Modal ───────────────────────────────────────────────────────

interface AssetPickerModalProps {
  onSelect: (asset: PickerAsset) => void;
  onClose: () => void;
}

function AssetPickerModal({ onSelect, onClose }: AssetPickerModalProps) {
  const [assets, setAssets] = useState<PickerAsset[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  const [filter, setFilter] = useState<AssetFilter>('all');
  const [thumbUrls, setThumbUrls] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError('');
      let q = supabase
        .from('whatsapp_assets')
        .select('id, name, description, asset_type, file_name, mime_type, file_size, share_message')
        .eq('active', true)
        .order('name', { ascending: true });

      if (filter !== 'all') q = q.eq('asset_type', filter);
      if (searchTerm.trim()) {
        const term = searchTerm.trim();
        q = q.or(`name.ilike.%${term}%,file_name.ilike.%${term}%`);
      }

      const { data, error: err } = await q;
      if (cancelled) return;
      if (err) {
        setError(err.message || 'Failed to load assets.');
        setAssets([]);
      } else {
        setAssets((data ?? []) as PickerAsset[]);
      }
      setLoading(false);
    }
    load();
    return () => { cancelled = true; };
  }, [filter, searchTerm]);

  // Generate signed URLs for image thumbnails
  useEffect(() => {
    const imageAssets = assets.filter(a => a.asset_type === 'IMAGE');
    if (imageAssets.length === 0) {
      setThumbUrls({});
      return;
    }
    let cancelled = false;
    (async () => {
      const urls: Record<string, string> = {};
      for (const asset of imageAssets) {
        const { data } = await supabase.storage
          .from('whatsapp-assets')
          .createSignedUrl(`${asset.id}/${asset.file_name}`, 300);
        if (data && !cancelled) urls[asset.id] = data.signedUrl;
      }
      if (!cancelled) setThumbUrls(urls);
    })();
    return () => { cancelled = true; };
  }, [assets]);

  function handleSearchChange(v: string) {
    setSearchInput(v);
    setTimeout(() => setSearchTerm(v), 300);
  }

  const FILTER_TABS: { label: string; value: AssetFilter }[] = [
    { label: 'All', value: 'all' },
    { label: 'Documents', value: 'DOCUMENT' },
    { label: 'Images', value: 'IMAGE' },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="relative bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[80vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-stone-100">
          <h2 className="text-base font-semibold text-stone-800">Choose Asset</h2>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-stone-400 hover:bg-stone-100 hover:text-stone-600 transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Search */}
        <div className="px-5 py-3 border-b border-stone-100">
          <div className="relative mb-2.5">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-stone-400" />
            <input
              type="text"
              value={searchInput}
              onChange={e => handleSearchChange(e.target.value)}
              placeholder="Search assets…"
              className="w-full pl-9 pr-3 py-2 text-sm border border-stone-200 rounded-lg bg-white text-stone-800 placeholder:text-stone-400 focus:outline-none focus:ring-2 focus:ring-amber-500 focus:border-transparent transition"
            />
          </div>
          <div className="flex items-center gap-1.5">
            {FILTER_TABS.map(tab => {
              const active = filter === tab.value;
              return (
                <button
                  key={tab.value}
                  onClick={() => setFilter(tab.value)}
                  className={`flex-shrink-0 px-2.5 py-1 text-xs font-medium rounded-lg border transition ${
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
        </div>

        {/* List */}
        <div className="flex-1 overflow-y-auto px-5 py-3">
          {loading && (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="w-5 h-5 text-stone-400 animate-spin" />
            </div>
          )}
          {error && (
            <div className="flex items-center gap-2 px-3 py-2.5 bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg">
              <AlertCircle className="w-4 h-4 flex-shrink-0" />
              {error}
            </div>
          )}
          {!loading && !error && assets.length === 0 && (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <div className="w-12 h-12 rounded-full bg-stone-100 flex items-center justify-center mb-3">
                <FileText className="w-5 h-5 text-stone-400" />
              </div>
              <p className="text-sm font-medium text-stone-500">No assets found</p>
              <p className="text-xs text-stone-400 mt-1">
                {searchTerm || filter !== 'all'
                  ? 'Try adjusting your search or filters.'
                  : 'No active assets have been added yet.'}
              </p>
            </div>
          )}
          {!loading && !error && assets.length > 0 && (
            <div className="space-y-1.5">
              {assets.map(asset => (
                <button
                  key={asset.id}
                  onClick={() => onSelect(asset)}
                  className="w-full flex items-start gap-3 px-3 py-2.5 rounded-xl border border-stone-100 hover:border-stone-300 hover:bg-stone-50 transition text-left"
                >
                  <div className="flex-shrink-0 w-9 h-9 rounded-lg bg-stone-50 border border-stone-100 flex items-center justify-center overflow-hidden">
                    {asset.asset_type === 'IMAGE' && thumbUrls[asset.id] ? (
                      <img src={thumbUrls[asset.id]} alt={asset.name} className="w-full h-full object-cover" />
                    ) : asset.asset_type === 'IMAGE' ? (
                      <ImageIcon className="w-4 h-4 text-stone-400" />
                    ) : (
                      <FileText className="w-4 h-4 text-stone-400" />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-stone-800 truncate">{asset.name}</span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-stone-100 text-stone-500 font-medium flex-shrink-0">
                        {asset.asset_type}
                      </span>
                    </div>
                    <p className="text-xs text-stone-400 mt-0.5 truncate">
                      {asset.file_name}
                      {asset.file_size != null && ` · ${formatBytes(asset.file_size)}`}
                    </p>
                    {asset.description && (
                      <p className="text-xs text-stone-500 mt-1 line-clamp-2 leading-relaxed">{asset.description}</p>
                    )}
                    {asset.share_message && (
                      <p className="text-xs text-stone-400 mt-1 italic line-clamp-1">"{asset.share_message}"</p>
                    )}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Template Picker Modal ─────────────────────────────────────────────────────

interface TemplatePickerModalProps {
  assetType: 'IMAGE' | 'DOCUMENT';
  onSelect: (template: MetaTemplate) => void;
  onClose: () => void;
}

function TemplatePickerModal({ assetType, onSelect, onClose }: TemplatePickerModalProps) {
  const [templates, setTemplates] = useState<MetaTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  const [nextCursor, setNextCursor] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError('');
      try {
        const apiUrl = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/fetch-whatsapp-templates?limit=100`;
        const resp = await fetch(apiUrl, {
          headers: {
            'Authorization': `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
          },
        });
        if (!cancelled) {
          const data = await resp.json();
          if (!resp.ok) {
            setError(data.error || 'Failed to load templates.');
            setTemplates([]);
          } else {
            setTemplates(data.templates ?? []);
            setNextCursor(data.nextCursor ?? null);
          }
        }
      } catch {
        if (!cancelled) setError('Failed to load templates.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, []);

  async function loadMore() {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const apiUrl = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/fetch-whatsapp-templates?limit=100&after=${nextCursor}`;
      const resp = await fetch(apiUrl, {
        headers: { 'Authorization': `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}` },
      });
      const data = await resp.json();
      if (resp.ok) {
        setTemplates(prev => [...prev, ...(data.templates ?? [])]);
        setNextCursor(data.nextCursor ?? null);
      }
    } catch {
      // ignore
    } finally {
      setLoadingMore(false);
    }
  }

  function handleSearchChange(v: string) {
    setSearchInput(v);
    setTimeout(() => setSearchTerm(v), 300);
  }

  const approvedTemplates = templates.filter(t => t.status.toLowerCase() === 'approved');
  const compatibleTemplates = approvedTemplates.filter(t => isTemplateCompatible(t, assetType));
  const filtered = searchTerm.trim()
    ? compatibleTemplates.filter(t =>
        t.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
        t.language.toLowerCase().includes(searchTerm.toLowerCase()))
    : compatibleTemplates;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="relative bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[80vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-stone-100">
          <div>
            <h2 className="text-base font-semibold text-stone-800">Choose Template</h2>
            <p className="text-xs text-stone-400 mt-0.5">
              Showing approved templates with {assetType === 'IMAGE' ? 'IMAGE' : 'DOCUMENT'} header
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-stone-400 hover:bg-stone-100 hover:text-stone-600 transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Search */}
        <div className="px-5 py-3 border-b border-stone-100">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-stone-400" />
            <input
              type="text"
              value={searchInput}
              onChange={e => handleSearchChange(e.target.value)}
              placeholder="Search templates…"
              className="w-full pl-9 pr-3 py-2 text-sm border border-stone-200 rounded-lg bg-white text-stone-800 placeholder:text-stone-400 focus:outline-none focus:ring-2 focus:ring-amber-500 focus:border-transparent transition"
            />
          </div>
        </div>

        {/* List */}
        <div className="flex-1 overflow-y-auto px-5 py-3">
          {loading && (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="w-5 h-5 text-stone-400 animate-spin" />
            </div>
          )}
          {error && (
            <div className="flex items-center gap-2 px-3 py-2.5 bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg">
              <AlertCircle className="w-4 h-4 flex-shrink-0" />
              {error}
            </div>
          )}
          {!loading && !error && filtered.length === 0 && (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <div className="w-12 h-12 rounded-full bg-stone-100 flex items-center justify-center mb-3">
                <LayoutTemplate className="w-5 h-5 text-stone-400" />
              </div>
              <p className="text-sm font-medium text-stone-500">No compatible templates found</p>
              <p className="text-xs text-stone-400 mt-1">
                {searchTerm
                  ? 'Try adjusting your search.'
                  : `No approved templates with ${assetType} header exist yet.`}
              </p>
            </div>
          )}
          {!loading && !error && filtered.length > 0 && (
            <>
              <div className="space-y-1.5">
                {filtered.map(tpl => {
                  const headerFmt = getTemplateHeaderFormat(tpl);
                  const bodyParams = getTemplateBodyExampleParams(tpl);
                  return (
                    <button
                      key={tpl.id}
                      onClick={() => onSelect(tpl)}
                      className="w-full flex items-start gap-3 px-3 py-2.5 rounded-xl border border-stone-100 hover:border-stone-300 hover:bg-stone-50 transition text-left"
                    >
                      <div className="flex-shrink-0 w-9 h-9 rounded-lg bg-stone-50 border border-stone-100 flex items-center justify-center">
                        <LayoutTemplate className="w-4 h-4 text-stone-400" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium text-stone-800 truncate">{tpl.name}</span>
                          {headerFmt && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-50 text-amber-600 font-medium flex-shrink-0">
                              {headerFmt}
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-stone-100 text-stone-500 font-medium flex items-center gap-0.5">
                            <Globe className="w-2.5 h-2.5" />
                            {tpl.language}
                          </span>
                          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-stone-100 text-stone-500 font-medium">
                            {tpl.category}
                          </span>
                          {bodyParams.length > 0 && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-blue-50 text-blue-500 font-medium">
                              {bodyParams.length} param{bodyParams.length > 1 ? 's' : ''}
                            </span>
                          )}
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
              {nextCursor && (
                <button
                  onClick={loadMore}
                  disabled={loadingMore}
                  className="w-full flex items-center justify-center gap-1.5 px-3 py-2.5 mt-2 text-sm text-stone-500 hover:text-stone-700 hover:bg-stone-50 rounded-lg transition"
                >
                  {loadingMore ? <Loader2 className="w-4 h-4 animate-spin" /> : <ChevronDown className="w-4 h-4" />}
                  Load more
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Text-Only Template Picker Modal ───────────────────────────────────────────

interface TextOnlyTemplatePickerModalProps {
  onSelect: (template: MetaTemplate) => void;
  onClose: () => void;
}

function TextOnlyTemplatePickerModal({ onSelect, onClose }: TextOnlyTemplatePickerModalProps) {
  const [templates, setTemplates] = useState<MetaTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  const [nextCursor, setNextCursor] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError('');
      try {
        const apiUrl = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/fetch-whatsapp-templates?limit=100`;
        const resp = await fetch(apiUrl, {
          headers: {
            'Authorization': `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
          },
        });
        if (!cancelled) {
          const data = await resp.json();
          if (!resp.ok) {
            setError(data.error || 'Failed to load templates.');
            setTemplates([]);
          } else {
            setTemplates(data.templates ?? []);
            setNextCursor(data.nextCursor ?? null);
          }
        }
      } catch {
        if (!cancelled) setError('Failed to load templates.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, []);

  async function loadMore() {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const apiUrl = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/fetch-whatsapp-templates?limit=100&after=${nextCursor}`;
      const resp = await fetch(apiUrl, {
        headers: { 'Authorization': `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}` },
      });
      const data = await resp.json();
      if (resp.ok) {
        setTemplates(prev => [...prev, ...(data.templates ?? [])]);
        setNextCursor(data.nextCursor ?? null);
      }
    } catch {
      // ignore
    } finally {
      setLoadingMore(false);
    }
  }

  function handleSearchChange(v: string) {
    setSearchInput(v);
    setTimeout(() => setSearchTerm(v), 300);
  }

  const approvedTemplates = templates.filter(t => t.status.toLowerCase() === 'approved');
  const textOnlyTemplates = approvedTemplates.filter(isTextOnlyTemplate);
  const filtered = searchTerm.trim()
    ? textOnlyTemplates.filter(t =>
        t.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
        t.language.toLowerCase().includes(searchTerm.toLowerCase()))
    : textOnlyTemplates;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="relative bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[80vh] flex flex-col overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-stone-100">
          <div>
            <h2 className="text-base font-semibold text-stone-800">Choose Text Template</h2>
            <p className="text-xs text-stone-400 mt-0.5">Approved templates without media headers</p>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-stone-400 hover:bg-stone-100 hover:text-stone-600 transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="px-5 py-3 border-b border-stone-100">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-stone-400" />
            <input
              type="text"
              value={searchInput}
              onChange={e => handleSearchChange(e.target.value)}
              placeholder="Search templates…"
              className="w-full pl-9 pr-3 py-2 text-sm border border-stone-200 rounded-lg bg-white text-stone-800 placeholder:text-stone-400 focus:outline-none focus:ring-2 focus:ring-amber-500 focus:border-transparent transition"
            />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-3">
          {loading && (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="w-5 h-5 text-stone-400 animate-spin" />
            </div>
          )}
          {error && (
            <div className="flex items-center gap-2 px-3 py-2.5 bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg">
              <AlertCircle className="w-4 h-4 flex-shrink-0" />
              {error}
            </div>
          )}
          {!loading && !error && filtered.length === 0 && (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <div className="w-12 h-12 rounded-full bg-stone-100 flex items-center justify-center mb-3">
                <LayoutTemplate className="w-5 h-5 text-stone-400" />
              </div>
              <p className="text-sm font-medium text-stone-500">No text-only templates found</p>
              <p className="text-xs text-stone-400 mt-1">
                {searchTerm ? 'Try adjusting your search.' : 'No approved text-only templates exist yet.'}
              </p>
            </div>
          )}
          {!loading && !error && filtered.length > 0 && (
            <>
              <div className="space-y-1.5">
                {filtered.map(tpl => {
                  const bodyParams = getTemplateBodyExampleParams(tpl);
                  const bodyText = getTemplateBodyText(tpl);
                  return (
                    <button
                      key={tpl.id}
                      onClick={() => onSelect(tpl)}
                      className="w-full flex items-start gap-3 px-3 py-2.5 rounded-xl border border-stone-100 hover:border-stone-300 hover:bg-stone-50 transition text-left"
                    >
                      <div className="flex-shrink-0 w-9 h-9 rounded-lg bg-stone-50 border border-stone-100 flex items-center justify-center">
                        <LayoutTemplate className="w-4 h-4 text-stone-400" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <span className="text-sm font-medium text-stone-800 truncate">{tpl.name}</span>
                        <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-stone-100 text-stone-500 font-medium flex items-center gap-0.5">
                            <Globe className="w-2.5 h-2.5" />
                            {tpl.language}
                          </span>
                          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-stone-100 text-stone-500 font-medium">
                            {tpl.category}
                          </span>
                          {bodyParams.length > 0 && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-blue-50 text-blue-500 font-medium">
                              {bodyParams.length} param{bodyParams.length > 1 ? 's' : ''}
                            </span>
                          )}
                        </div>
                        {bodyText && (
                          <p className="text-xs text-stone-400 mt-1 line-clamp-2 leading-relaxed">{bodyText}</p>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
              {nextCursor && (
                <button
                  onClick={loadMore}
                  disabled={loadingMore}
                  className="w-full flex items-center justify-center gap-1.5 px-3 py-2.5 mt-2 text-sm text-stone-500 hover:text-stone-700 hover:bg-stone-50 rounded-lg transition"
                >
                  {loadingMore ? <Loader2 className="w-4 h-4 animate-spin" /> : <ChevronDown className="w-4 h-4" />}
                  Load more
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}