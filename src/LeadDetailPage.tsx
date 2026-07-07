import { useEffect, useState, useRef } from 'react';
import { supabase } from './supabaseClient';
import { useAuth } from './AuthContext';
import {
  ArrowLeft, Loader2, Phone, Mail, MapPin, Building2,
  Briefcase, Tag, Award, BarChart2, CalendarDays,
  User, Users, Thermometer, Hash, FileText, Image, MessageCircle,
  AlertCircle, Clock, RefreshCw, Pencil, Check, X as XIcon,
  StickyNote, Plus, Send, ChevronDown, Bell, CheckCircle2, Link2,
} from 'lucide-react';
import { LeadEvidenceSection } from './capture/LeadEvidenceSection';
import { formatDateTime, formatDate } from './utils/dateFormat';

interface LeadDetail {
  id: string;
  client_name: string;
  designation: string;
  company: string;
  phones: string[];
  emails: string[];
  address: string;
  state: string;
  notes: string;
  lead_type: string;
  previous_associated_rep: string;
  application: string;
  price_range: string;
  lead_temperature: string;
  quick_keywords: string;
  target_market: string;
  certification: string;
  benchmark: string;
  sales_rep_code: string;
  event_code: string;
  contact_image_link: string;
  notes_image_link: string;
  created_at: string;
  whatsapp_status: string;
  whatsapp_sent_at: string;
  whatsapp_retry_count: number;
  whatsapp_last_attempt_at: string;
  whatsapp_error: string;
  system_status: string;
  lead_status: string;
}

interface EventInfo {
  name: string;
  location: string;
  start_date: string;
  end_date: string;
}

// Fields that can be edited
interface EditDraft {
  phone0: string;
  phone1: string;
  email0: string;
  email1: string;
  address: string;
  state: string;
  application: string;
  price_range: string;
  lead_temperature: string;
  quick_keywords: string;
}

interface LeadNote {
  id: string;
  note: string;
  created_by: string;
  created_at: string;
  sales_representatives: { name: string } | null;
}

interface LeadFollowUp {
  id: string;
  lead_id: string;
  reminder_date: string;
  note: string;
  status: 'PENDING' | 'COMPLETED';
  created_by: string;
  created_at: string;
}

interface Props {
  leadId: string;
  onBack: () => void;
}

const TEMP_COLORS: Record<string, { bg: string; text: string; dot: string }> = {
  hot:  { bg: 'bg-red-100',   text: 'text-red-700',   dot: 'bg-red-500' },
  warm: { bg: 'bg-amber-100', text: 'text-amber-700', dot: 'bg-amber-500' },
  cold: { bg: 'bg-blue-100',  text: 'text-blue-700',  dot: 'bg-blue-500' },
};

const WA_STATUS_STYLES: Record<string, string> = {
  sent:    'bg-green-100 text-green-700',
  failed:  'bg-red-100 text-red-700',
  pending: 'bg-amber-100 text-amber-700',
};

const SYSTEM_STATUS_STYLES: Record<string, { badge: string; dot: string; label: string }> = {
  created:          { badge: 'bg-sky-100 text-sky-700 border-sky-200',      dot: 'bg-sky-500',    label: 'Created' },
  whatsapp_sent:    { badge: 'bg-green-100 text-green-700 border-green-200', dot: 'bg-green-500',  label: 'WhatsApp Sent' },
  whatsapp_failed:  { badge: 'bg-red-100 text-red-700 border-red-200',       dot: 'bg-red-500',    label: 'WhatsApp Failed' },
  invalid_lead:     { badge: 'bg-stone-100 text-stone-500 border-stone-200', dot: 'bg-stone-400',  label: 'Invalid Lead' },
};

const LEAD_STATUS_OPTIONS = ['NEW', 'CONTACTED', 'QUALIFIED', 'CONVERTED', 'LOST'] as const;
type LeadStatus = typeof LEAD_STATUS_OPTIONS[number];

const LEAD_STATUS_STYLES: Record<string, { badge: string; dot: string; label: string; option: string }> = {
  new:       { badge: 'bg-blue-100 text-blue-700 border-blue-200',       dot: 'bg-blue-500',       label: 'New',       option: 'hover:bg-blue-50 text-blue-700' },
  contacted: { badge: 'bg-yellow-100 text-yellow-700 border-yellow-200', dot: 'bg-yellow-500',     label: 'Contacted', option: 'hover:bg-yellow-50 text-yellow-700' },
  qualified: { badge: 'bg-violet-100 text-violet-700 border-violet-200', dot: 'bg-violet-500',     label: 'Qualified', option: 'hover:bg-violet-50 text-violet-700' },
  converted: { badge: 'bg-green-100 text-green-700 border-green-200',    dot: 'bg-green-500',      label: 'Converted', option: 'hover:bg-green-50 text-green-700' },
  lost:      { badge: 'bg-red-100 text-red-700 border-red-200',          dot: 'bg-red-500',        label: 'Lost',      option: 'hover:bg-red-50 text-red-700' },
};

function val(v: string | null | undefined): string | null {
  return v && v.trim() ? v : null;
}

function formatWhatsAppNumber(raw: string): string | null {
  if (!raw || !raw.trim()) return null;
  const cleaned = raw.replace(/[\s\-()]/g, '');
  if (cleaned.startsWith('+')) {
    const digits = cleaned.replace(/\D/g, '');
    return digits.length >= 7 ? digits : null;
  }
  let digits = cleaned.replace(/\D/g, '');
  if (digits.startsWith('0')) digits = digits.slice(1);
  if (digits.length === 10) return '91' + digits;
  if (digits.length === 12 && digits.startsWith('91')) return digits;
  return digits.length >= 7 ? digits : null;
}


function Card({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="bg-white border border-stone-200 rounded-xl overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-stone-100 bg-stone-50">
        <span className="text-stone-500">{icon}</span>
        <h3 className="text-sm font-semibold text-stone-700">{title}</h3>
      </div>
      <div className="px-4 py-1">{children}</div>
    </div>
  );
}

function Row({ icon, label, value }: { icon: React.ReactNode; label: string; value: string | null }) {
  return (
    <div className="flex items-start gap-3 py-2.5 border-b border-stone-100 last:border-0">
      <span className="mt-0.5 text-stone-400 flex-shrink-0">{icon}</span>
      <div className="min-w-0 flex-1">
        <p className="text-xs text-stone-400 mb-0.5">{label}</p>
        <p className={`text-sm ${value ? 'text-stone-800' : 'text-stone-300'}`}>{value ?? '—'}</p>
      </div>
    </div>
  );
}

interface EditRowProps {
  icon: React.ReactNode;
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  required?: boolean;
  error?: string;
  placeholder?: string;
}

function EditRow({ icon, label, value, onChange, type = 'text', required, error, placeholder }: EditRowProps) {
  return (
    <div className="flex items-start gap-3 py-2.5 border-b border-stone-100 last:border-0">
      <span className="mt-3 text-stone-400 flex-shrink-0">{icon}</span>
      <div className="min-w-0 flex-1">
        <label className="text-xs text-stone-400 mb-1 block">
          {label}{required && <span className="text-red-500 ml-0.5">*</span>}
        </label>
        <input
          type={type}
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder={placeholder ?? label}
          className={`w-full px-3 py-1.5 text-sm border rounded-lg bg-white text-stone-800 placeholder-stone-300 focus:outline-none focus:ring-2 focus:ring-amber-500 focus:border-transparent transition ${
            error ? 'border-red-300' : 'border-stone-200'
          }`}
        />
        {error && <p className="text-xs text-red-500 mt-1">{error}</p>}
      </div>
    </div>
  );
}

interface SelectRowProps {
  icon: React.ReactNode;
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { label: string; value: string }[];
}

function SelectRow({ icon, label, value, onChange, options }: SelectRowProps) {
  return (
    <div className="flex items-start gap-3 py-2.5 border-b border-stone-100 last:border-0">
      <span className="mt-3 text-stone-400 flex-shrink-0">{icon}</span>
      <div className="min-w-0 flex-1">
        <label className="text-xs text-stone-400 mb-1 block">{label}</label>
        <select
          value={value}
          onChange={e => onChange(e.target.value)}
          className="w-full px-3 py-1.5 text-sm border border-stone-200 rounded-lg bg-white text-stone-800 focus:outline-none focus:ring-2 focus:ring-amber-500 focus:border-transparent transition"
        >
          <option value="">Any</option>
          {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </div>
    </div>
  );
}

function makeDraft(lead: LeadDetail): EditDraft {
  return {
    phone0: lead.phones?.[0] ?? '',
    phone1: lead.phones?.[1] ?? '',
    email0: lead.emails?.[0] ?? '',
    email1: lead.emails?.[1] ?? '',
    address: lead.address ?? '',
    state: lead.state ?? '',
    application: lead.application ?? '',
    price_range: lead.price_range ?? '',
    lead_temperature: lead.lead_temperature ?? '',
    quick_keywords: lead.quick_keywords ?? '',
  };
}

export default function LeadDetailPage({ leadId, onBack }: Props) {
  const { user } = useAuth();
  const [lead, setLead] = useState<LeadDetail | null>(null);
  const [event, setEvent] = useState<EventInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  const [editMode, setEditMode] = useState(false);
  const [draft, setDraft] = useState<EditDraft | null>(null);
  const [errors, setErrors] = useState<Partial<Record<keyof EditDraft, string>>>({});
  const [saving, setSaving] = useState(false);
  const [successMsg, setSuccessMsg] = useState('');
  const [saveError, setSaveError] = useState('');

  // Notes
  const [notes, setNotes] = useState<LeadNote[]>([]);
  const [notesLoading, setNotesLoading] = useState(false);
  const [addingNote, setAddingNote] = useState(false);
  const [noteText, setNoteText] = useState('');
  const [noteTextError, setNoteTextError] = useState('');
  const [submittingNote, setSubmittingNote] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Follow-ups
  const [followUps, setFollowUps] = useState<LeadFollowUp[]>([]);
  const [followUpsLoading, setFollowUpsLoading] = useState(false);
  const [addingFollowUp, setAddingFollowUp] = useState(false);
  const [followUpReminderDate, setFollowUpReminderDate] = useState('');
  const [followUpNote, setFollowUpNote] = useState('');
  const [followUpErrors, setFollowUpErrors] = useState<{ reminderDate?: string; note?: string }>({});
  const [submittingFollowUp, setSubmittingFollowUp] = useState(false);
  const [completingFollowUpId, setCompletingFollowUpId] = useState<string | null>(null);
  const [copiedFollowUpId, setCopiedFollowUpId] = useState<string | null>(null);

  // Lead status update
  const [statusDropdownOpen, setStatusDropdownOpen] = useState(false);
  const [updatingStatus, setUpdatingStatus] = useState(false);
  const statusDropdownRef = useRef<HTMLDivElement>(null);

  const canEdit = lead &&
    (user?.role === 'admin' || (user?.role === 'sales_rep' && lead.sales_rep_code === user.rep_code));

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (statusDropdownRef.current && !statusDropdownRef.current.contains(e.target as Node)) {
        setStatusDropdownOpen(false);
      }
    }
    if (statusDropdownOpen) document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [statusDropdownOpen]);

  async function updateLeadStatus(status: LeadStatus) {
    if (!lead || !canEdit) return;
    setUpdatingStatus(true);
    setStatusDropdownOpen(false);
    const { error } = await supabase
      .from('lead_entries')
      .update({ lead_status: status })
      .eq('id', leadId);
    if (!error) {
      setLead(prev => prev ? { ...prev, lead_status: status } : prev);
      setSuccessMsg(`Lead status updated to ${status}.`);
      setTimeout(() => setSuccessMsg(''), 3000);
    } else {
      setSaveError('Failed to update lead status. Please try again.');
      setTimeout(() => setSaveError(''), 4000);
    }
    setUpdatingStatus(false);
  }

  async function fetchNotes() {
    setNotesLoading(true);
    const { data } = await supabase
      .from('lead_notes')
      .select('id, note, created_by, created_at, sales_representatives(name)')
      .eq('lead_id', leadId)
      .order('created_at', { ascending: false });
    setNotes((data as LeadNote[]) ?? []);
    setNotesLoading(false);
  }

  async function fetchFollowUps() {
    setFollowUpsLoading(true);
    const { data } = await supabase
      .from('lead_follow_ups')
      .select('id, lead_id, reminder_date, note, status, created_by, created_at')
      .eq('lead_id', leadId)
      .order('status', { ascending: true })
      .order('reminder_date', { ascending: true });
    setFollowUps((data as LeadFollowUp[]) ?? []);
    setFollowUpsLoading(false);
  }

  useEffect(() => {
    if (!user) return;
    setLoading(true);
    setNotFound(false);
    setEditMode(false);

    (async () => {
      let leadQuery = supabase.from('lead_entries').select('*').eq('id', leadId);
      if (user.role === 'sales_rep') leadQuery = leadQuery.eq('sales_rep_code', user.rep_code);

      const [{ data, error }, , ] = await Promise.all([
        leadQuery.maybeSingle(),
        fetchNotes(),
        fetchFollowUps(),
      ]);

      if (error || !data) { setNotFound(true); setLoading(false); return; }
      setLead(data as LeadDetail);

      if (data.event_code) {
        const { data: ev } = await supabase
          .from('events').select('name, location, start_date, end_date')
          .eq('event_code', data.event_code).maybeSingle();
        setEvent(ev as EventInfo | null);
      }
      setLoading(false);
    })();
  }, [leadId, user]);

  function enterEdit() {
    if (!lead) return;
    setDraft(makeDraft(lead));
    setErrors({});
    setSaveError('');
    setSuccessMsg('');
    setEditMode(true);
  }

  function cancelEdit() {
    setEditMode(false);
    setDraft(null);
    setErrors({});
    setSaveError('');
  }

  function patchDraft(key: keyof EditDraft, value: string) {
    setDraft(prev => prev ? { ...prev, [key]: value } : prev);
    if (errors[key]) setErrors(prev => ({ ...prev, [key]: '' }));
  }

  function validate(d: EditDraft): boolean {
    const errs: Partial<Record<keyof EditDraft, string>> = {};
    if (!d.phone0.trim()) errs.phone0 = 'At least one phone number is required.';
    setErrors(errs);
    return Object.keys(errs).length === 0;
  }

  function openAddNote() {
    setAddingNote(true);
    setNoteText('');
    setNoteTextError('');
    setTimeout(() => textareaRef.current?.focus(), 50);
  }

  function cancelAddNote() {
    setAddingNote(false);
    setNoteText('');
    setNoteTextError('');
  }

  async function handleSubmitNote() {
    if (!noteText.trim()) { setNoteTextError('Note cannot be empty.'); return; }
    if (!user) return;
    setSubmittingNote(true);
    const { error } = await supabase.from('lead_notes').insert({
      lead_id: leadId,
      note: noteText.trim(),
      created_by: user.rep_code,
    });
    if (error) {
      setNoteTextError('Failed to save note. Please try again.');
      setSubmittingNote(false);
      return;
    }
    setNoteText('');
    setAddingNote(false);
    setSubmittingNote(false);
    fetchNotes();
  }

  function openAddFollowUp() {
    setFollowUpReminderDate('');
    setFollowUpNote('');
    setFollowUpErrors({});
    setAddingFollowUp(true);
  }

  function cancelAddFollowUp() {
    setAddingFollowUp(false);
    setFollowUpReminderDate('');
    setFollowUpNote('');
    setFollowUpErrors({});
  }

  async function handleSubmitFollowUp() {
    const errs: { reminderDate?: string; note?: string } = {};
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    if (!followUpReminderDate) {
      errs.reminderDate = 'Reminder date is required.';
    } else if (new Date(followUpReminderDate) < today) {
      errs.reminderDate = 'Reminder date must be today or in the future.';
    }
    if (!followUpNote.trim()) errs.note = 'Note cannot be empty.';
    if (Object.keys(errs).length > 0) { setFollowUpErrors(errs); return; }
    if (!user) return;

    setSubmittingFollowUp(true);
    const { error } = await supabase.from('lead_follow_ups').insert({
      lead_id: leadId,
      reminder_date: new Date(followUpReminderDate).toISOString(),
      note: followUpNote.trim(),
      created_by: user.rep_code,
    });
    setSubmittingFollowUp(false);
    if (error) { setFollowUpErrors({ note: 'Failed to save. Please try again.' }); return; }
    setAddingFollowUp(false);
    fetchFollowUps();
  }

  async function markFollowUpCompleted(id: string) {
    setCompletingFollowUpId(id);
    await supabase.from('lead_follow_ups').update({ status: 'COMPLETED', updated_at: new Date().toISOString() }).eq('id', id);
    setCompletingFollowUpId(null);
    fetchFollowUps();
  }

  async function handleSave() {
    if (!draft || !lead) return;
    if (!validate(draft)) return;

    setSaving(true);
    setSaveError('');
    setSuccessMsg('');

    const phones = [draft.phone0, draft.phone1].map(p => p.trim()).filter(Boolean);
    const emails = [draft.email0, draft.email1].map(e => e.trim()).filter(Boolean);

    const updates = {
      phones,
      emails,
      address: draft.address.trim() || null,
      state: draft.state.trim() || null,
      application: draft.application.trim() || null,
      price_range: draft.price_range.trim() || null,
      lead_temperature: draft.lead_temperature || null,
      quick_keywords: draft.quick_keywords.trim() || null,
      updated_at: new Date().toISOString(),
    };

    let query = supabase.from('lead_entries').update(updates).eq('id', lead.id);
    if (user?.role === 'sales_rep') query = query.eq('sales_rep_code', user.rep_code);

    const { error } = await query;

    if (error) {
      setSaveError('Failed to save changes. Please try again.');
      setSaving(false);
      return;
    }

    // Reflect changes locally
    setLead(prev => prev ? { ...prev, phones, emails, ...updates } as LeadDetail : prev);
    setEditMode(false);
    setDraft(null);
    setSaving(false);
    setSuccessMsg('Changes saved successfully.');
    setTimeout(() => setSuccessMsg(''), 4000);
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-32">
        <Loader2 className="w-6 h-6 text-amber-600 animate-spin" />
      </div>
    );
  }

  if (notFound || !lead) {
    return (
      <div className="p-6">
        <button onClick={onBack} className="flex items-center gap-1.5 text-sm text-stone-500 hover:text-stone-800 transition mb-6">
          <ArrowLeft className="w-4 h-4" /> Back to Leads
        </button>
        <div className="flex flex-col items-center justify-center py-24 text-center">
          <AlertCircle className="w-10 h-10 text-stone-300 mb-3" />
          <p className="text-stone-500 font-medium">Lead not found</p>
          <p className="text-stone-400 text-sm mt-1">This lead may not exist or you don't have access to it.</p>
        </div>
      </div>
    );
  }

  const tempKey = lead.lead_temperature?.toLowerCase();
  const tempStyle = TEMP_COLORS[tempKey] ?? { bg: 'bg-stone-100', text: 'text-stone-600', dot: 'bg-stone-400' };

  return (
    <div className="p-6 max-w-6xl mx-auto">
      {/* Back */}
      <button
        onClick={onBack}
        className="flex items-center gap-1.5 text-sm text-stone-500 hover:text-stone-800 transition mb-5 group"
      >
        <ArrowLeft className="w-4 h-4 group-hover:-translate-x-0.5 transition-transform" />
        Back to Leads
      </button>

      {/* Success / error toasts */}
      {successMsg && (
        <div className="mb-4 flex items-center gap-2 px-4 py-3 bg-green-50 border border-green-200 text-green-700 text-sm rounded-xl">
          <Check className="w-4 h-4 flex-shrink-0" />
          {successMsg}
        </div>
      )}
      {saveError && (
        <div className="mb-4 flex items-center gap-2 px-4 py-3 bg-red-50 border border-red-200 text-red-700 text-sm rounded-xl">
          <AlertCircle className="w-4 h-4 flex-shrink-0" />
          {saveError}
        </div>
      )}

      {/* Header card */}
      <div className="bg-white border border-stone-200 rounded-xl px-6 py-5 mb-6 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-bold text-stone-900">{lead.client_name || '—'}</h1>
            {lead.lead_temperature && (
              <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold ${tempStyle.bg} ${tempStyle.text}`}>
                <span className={`w-1.5 h-1.5 rounded-full ${tempStyle.dot}`} />
                {lead.lead_temperature}
              </span>
            )}
            {lead.lead_type && (
              <span className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold bg-stone-100 text-stone-600">
                {lead.lead_type}
              </span>
            )}
          </div>
          {(val(lead.designation) || val(lead.company)) && (
            <p className="text-stone-500 text-sm">
              {[val(lead.designation), val(lead.company)].filter(Boolean).join(' · ')}
            </p>
          )}

          {/* Status badges */}
          <div className="flex flex-wrap gap-3 pt-1">
            {/* System Status */}
            {(() => {
              const key = lead.system_status?.toLowerCase();
              const s = SYSTEM_STATUS_STYLES[key] ?? { badge: 'bg-stone-100 text-stone-500 border-stone-200', dot: 'bg-stone-400', label: lead.system_status };
              return lead.system_status ? (
                <div className="flex items-center gap-1.5">
                  <span className="text-xs text-stone-400 font-medium">System</span>
                  <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold border ${s.badge}`}>
                    <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${s.dot}`} />
                    {s.label}
                  </span>
                </div>
              ) : null;
            })()}

            {/* Lead Status — interactive dropdown */}
            {(() => {
              const key = lead.lead_status?.toLowerCase();
              const s = LEAD_STATUS_STYLES[key] ?? { badge: 'bg-stone-100 text-stone-500 border-stone-200', dot: 'bg-stone-400', label: lead.lead_status ?? 'Set status', option: '' };
              const isInvalid = lead.system_status?.toLowerCase() === 'invalid_lead';
              const canChange = canEdit && !isInvalid;

              return (
                <div className="flex items-center gap-1.5">
                  <span className="text-xs text-stone-400 font-medium">Lead</span>
                  <div className="relative" ref={statusDropdownRef}>
                    <button
                      disabled={!canChange || updatingStatus}
                      onClick={() => canChange && setStatusDropdownOpen(v => !v)}
                      title={isInvalid ? 'Cannot change status of an invalid lead' : undefined}
                      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold border transition
                        ${s.badge}
                        ${canChange ? 'cursor-pointer hover:opacity-80 hover:shadow-sm' : 'cursor-default opacity-70'}
                      `}
                    >
                      {updatingStatus
                        ? <Loader2 className="w-3 h-3 animate-spin flex-shrink-0" />
                        : <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${s.dot}`} />
                      }
                      {s.label}
                      {canChange && !updatingStatus && <ChevronDown className="w-3 h-3 ml-0.5 flex-shrink-0" />}
                    </button>

                    {statusDropdownOpen && (
                      <div className="absolute left-0 top-full mt-1.5 z-50 bg-white border border-stone-200 rounded-xl shadow-lg overflow-hidden min-w-[150px]">
                        {LEAD_STATUS_OPTIONS.map(opt => {
                          const os = LEAD_STATUS_STYLES[opt.toLowerCase()];
                          const isCurrent = lead.lead_status?.toUpperCase() === opt;
                          return (
                            <button
                              key={opt}
                              onClick={() => updateLeadStatus(opt)}
                              className={`w-full flex items-center gap-2 px-3 py-2 text-sm transition
                                ${isCurrent ? 'bg-stone-50 font-semibold' : 'font-medium'}
                                ${os?.option ?? 'hover:bg-stone-50 text-stone-700'}
                              `}
                            >
                              <span className={`w-2 h-2 rounded-full flex-shrink-0 ${os?.dot ?? 'bg-stone-400'}`} />
                              {os?.label ?? opt}
                              {isCurrent && <Check className="w-3.5 h-3.5 ml-auto" />}
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>
              );
            })()}
          </div>

          <p className="text-xs text-stone-400">Added {formatDateTime(lead.created_at)}</p>
        </div>

        <div className="flex items-center gap-2 self-start">
          {canEdit && !editMode && (
            <button
              onClick={enterEdit}
              className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-lg border border-stone-200 text-stone-600 hover:bg-stone-50 hover:border-stone-300 transition"
            >
              <Pencil className="w-3.5 h-3.5" /> Edit
            </button>
          )}
          {editMode && (
            <>
              <button
                onClick={cancelEdit}
                disabled={saving}
                className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-lg border border-stone-200 text-stone-600 hover:bg-stone-50 transition disabled:opacity-50"
              >
                <XIcon className="w-3.5 h-3.5" /> Cancel
              </button>
              <button
                onClick={handleSave}
                disabled={saving}
                className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-lg bg-amber-700 text-white hover:bg-amber-800 transition disabled:opacity-60"
              >
                {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
                {saving ? 'Saving…' : 'Save'}
              </button>
            </>
          )}
        </div>
      </div>

      {/* Two-column layout */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
        {/* LEFT */}
        <div className="flex flex-col gap-4">
          {/* Contact Info */}
          <Card title="Contact Info" icon={<Phone className="w-4 h-4" />}>
            {editMode && draft ? (
              <>
                <EditRow icon={<Phone className="w-3.5 h-3.5" />} label="Phone 1" value={draft.phone0}
                  onChange={v => patchDraft('phone0', v)} required error={errors.phone0} />
                <EditRow icon={<Phone className="w-3.5 h-3.5" />} label="Phone 2" value={draft.phone1}
                  onChange={v => patchDraft('phone1', v)} />
                <EditRow icon={<Mail className="w-3.5 h-3.5" />} label="Email 1" value={draft.email0}
                  onChange={v => patchDraft('email0', v)} type="email" />
                <EditRow icon={<Mail className="w-3.5 h-3.5" />} label="Email 2" value={draft.email1}
                  onChange={v => patchDraft('email1', v)} type="email" />
                <EditRow icon={<MapPin className="w-3.5 h-3.5" />} label="Address" value={draft.address}
                  onChange={v => patchDraft('address', v)} />
                <EditRow icon={<MapPin className="w-3.5 h-3.5" />} label="State" value={draft.state}
                  onChange={v => patchDraft('state', v)} />
              </>
            ) : (
              <>
                {(lead.phones ?? []).filter(Boolean).length > 0
                  ? lead.phones.filter(Boolean).map((p, i) => {
                    const waNumber = formatWhatsAppNumber(p);
                    return (
                      <div key={i} className="flex items-start gap-3 py-2.5 border-b border-stone-100 last:border-0">
                        <span className="mt-0.5 text-stone-400 flex-shrink-0"><Phone className="w-3.5 h-3.5" /></span>
                        <div className="min-w-0 flex-1">
                          <p className="text-xs text-stone-400 mb-0.5">Phone {i + 1}</p>
                          <p className="text-sm text-stone-800">{p}</p>
                        </div>
                        {i === 0 && (
                          <div className="flex items-center gap-1.5 flex-shrink-0 mt-0.5">
                            <a
                              href={`tel:${p}`}
                              onClick={e => { e.preventDefault(); window.open(`tel:${p}`); }}
                              className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-green-50 border border-green-200 text-green-700 text-xs font-medium hover:bg-green-100 transition"
                              title={`Call ${p}`}
                            >
                              <Phone className="w-3 h-3" /> Call
                            </a>
                            {waNumber ? (
                              <a
                                href={`https://wa.me/${waNumber}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-700 text-xs font-medium hover:bg-emerald-100 transition"
                                title={`WhatsApp ${p}`}
                              >
                                <MessageCircle className="w-3 h-3" /> WhatsApp
                              </a>
                            ) : (
                              <span
                                className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-stone-50 border border-stone-200 text-stone-400 text-xs font-medium cursor-not-allowed"
                                title="Invalid phone number for WhatsApp"
                              >
                                <MessageCircle className="w-3 h-3" /> WhatsApp
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })
                  : <Row icon={<Phone className="w-3.5 h-3.5" />} label="Phone" value={null} />
                }
                {(lead.emails ?? []).filter(Boolean).length > 0
                  ? lead.emails.filter(Boolean).map((e, i) => (
                    <Row key={i} icon={<Mail className="w-3.5 h-3.5" />} label={`Email ${i + 1}`} value={e} />
                  ))
                  : <Row icon={<Mail className="w-3.5 h-3.5" />} label="Email" value={null} />
                }
                <Row icon={<MapPin className="w-3.5 h-3.5" />} label="Address" value={val(lead.address)} />
                <Row icon={<MapPin className="w-3.5 h-3.5" />} label="State" value={val(lead.state)} />
              </>
            )}
          </Card>

          {/* Business Details */}
          <Card title="Business Details" icon={<Briefcase className="w-4 h-4" />}>
            {editMode && draft ? (
              <>
                <EditRow icon={<Tag className="w-3.5 h-3.5" />} label="Application" value={draft.application}
                  onChange={v => patchDraft('application', v)} />
                <EditRow icon={<BarChart2 className="w-3.5 h-3.5" />} label="Price Range" value={draft.price_range}
                  onChange={v => patchDraft('price_range', v)} />
              </>
            ) : (
              <>
                <Row icon={<Tag className="w-3.5 h-3.5" />} label="Application" value={val(lead.application)} />
                <Row icon={<BarChart2 className="w-3.5 h-3.5" />} label="Price Range" value={val(lead.price_range)} />
              </>
            )}
            {/* Read-only fields always visible */}
            <Row icon={<Building2 className="w-3.5 h-3.5" />} label="Target Market" value={val(lead.target_market)} />
            <Row icon={<Award className="w-3.5 h-3.5" />} label="Certification" value={val(lead.certification)} />
            <Row icon={<BarChart2 className="w-3.5 h-3.5" />} label="Benchmark" value={val(lead.benchmark)} />
          </Card>
        </div>

        {/* RIGHT */}
        <div className="flex flex-col gap-4">
          {/* Event Info */}
          <Card title="Event Info" icon={<CalendarDays className="w-4 h-4" />}>
            <Row icon={<CalendarDays className="w-3.5 h-3.5" />} label="Event Code" value={val(lead.event_code)} />
            <Row icon={<Building2 className="w-3.5 h-3.5" />} label="Event Name" value={val(event?.name)} />
            <Row icon={<MapPin className="w-3.5 h-3.5" />} label="Location" value={val(event?.location)} />
            <Row
              icon={<CalendarDays className="w-3.5 h-3.5" />}
              label="Dates"
              value={event?.start_date
                ? `${formatDate(event.start_date)}${event.end_date && event.end_date !== event.start_date ? ` – ${formatDate(event.end_date)}` : ''}`
                : null}
            />
          </Card>

          {/* Sales Info */}
          <Card title="Sales Info" icon={<User className="w-4 h-4" />}>
            <Row icon={<User className="w-3.5 h-3.5" />} label="Sales Rep" value={val(lead.sales_rep_code)} />
            {val(lead.previous_associated_rep) && (
              <Row icon={<Users className="w-3.5 h-3.5" />} label="Previous Rep" value={val(lead.previous_associated_rep)} />
            )}
          </Card>

          {/* Qualification */}
          <Card title="Qualification" icon={<Thermometer className="w-4 h-4" />}>
            {editMode && draft ? (
              <>
                <SelectRow
                  icon={<Thermometer className="w-3.5 h-3.5" />}
                  label="Temperature"
                  value={draft.lead_temperature}
                  onChange={v => patchDraft('lead_temperature', v)}
                  options={[
                    { label: 'Hot', value: 'Hot' },
                    { label: 'Warm', value: 'Warm' },
                    { label: 'Cold', value: 'Cold' },
                  ]}
                />
                <EditRow icon={<Hash className="w-3.5 h-3.5" />} label="Keywords" value={draft.quick_keywords}
                  onChange={v => patchDraft('quick_keywords', v)} />
              </>
            ) : (
              <>
                <Row icon={<Thermometer className="w-3.5 h-3.5" />} label="Temperature" value={val(lead.lead_temperature)} />
                <Row icon={<Hash className="w-3.5 h-3.5" />} label="Keywords" value={val(lead.quick_keywords)} />
              </>
            )}
          </Card>
        </div>
      </div>

      {/* Full-width cards */}
      <div className="flex flex-col gap-4">
        {/* Lead Notes */}
        <div className="bg-white border border-stone-200 rounded-xl overflow-hidden">
          {/* Card header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-stone-100 bg-stone-50">
            <div className="flex items-center gap-2">
              <StickyNote className="w-4 h-4 text-stone-500" />
              <h3 className="text-sm font-semibold text-stone-700">Notes</h3>
              {notes.length > 0 && (
                <span className="text-xs text-stone-400 font-normal">({notes.length})</span>
              )}
            </div>
            {canEdit && !addingNote && (
              <button
                onClick={openAddNote}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-stone-200 text-stone-600 hover:bg-white hover:border-stone-300 transition"
              >
                <Plus className="w-3.5 h-3.5" /> Add Note
              </button>
            )}
          </div>

          {/* Add note form */}
          {addingNote && (
            <div className="px-4 py-4 border-b border-stone-100 bg-amber-50/40">
              <textarea
                ref={textareaRef}
                value={noteText}
                onChange={e => { setNoteText(e.target.value); if (noteTextError) setNoteTextError(''); }}
                placeholder="Write a note…"
                rows={3}
                className={`w-full px-3 py-2 text-sm border rounded-lg bg-white text-stone-800 placeholder-stone-300 resize-none focus:outline-none focus:ring-2 focus:ring-amber-500 focus:border-transparent transition ${noteTextError ? 'border-red-300' : 'border-stone-200'}`}
              />
              {noteTextError && <p className="text-xs text-red-500 mt-1">{noteTextError}</p>}
              <div className="flex items-center gap-2 mt-2 justify-end">
                <button
                  onClick={cancelAddNote}
                  disabled={submittingNote}
                  className="px-3 py-1.5 text-xs font-medium rounded-lg border border-stone-200 text-stone-600 hover:bg-white transition disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  onClick={handleSubmitNote}
                  disabled={submittingNote}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-amber-700 text-white hover:bg-amber-800 transition disabled:opacity-60"
                >
                  {submittingNote
                    ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Saving…</>
                    : <><Send className="w-3.5 h-3.5" /> Save Note</>
                  }
                </button>
              </div>
            </div>
          )}

          {/* Notes list */}
          <div className="divide-y divide-stone-100">
            {notesLoading ? (
              <div className="flex items-center justify-center py-10">
                <Loader2 className="w-5 h-5 text-amber-600 animate-spin" />
              </div>
            ) : notes.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-10 text-center">
                <StickyNote className="w-7 h-7 text-stone-200 mb-2" />
                <p className="text-sm text-stone-400">No notes yet.</p>
              </div>
            ) : (
              notes.map(n => (
                <div key={n.id} className="px-4 py-4 hover:bg-stone-50 transition-colors">
                  <p className="text-sm text-stone-800 whitespace-pre-wrap leading-relaxed mb-2">{n.note}</p>
                  <div className="flex items-center gap-2 text-xs text-stone-400">
                    <User className="w-3 h-3" />
                    <span className="font-medium text-stone-500">
                      {n.sales_representatives?.name ?? n.created_by}
                    </span>
                    <span>·</span>
                    <Clock className="w-3 h-3" />
                    <span>{formatDateTime(n.created_at)}</span>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Follow-ups */}
        <div className="bg-white border border-stone-200 rounded-xl overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-stone-100 bg-stone-50">
            <div className="flex items-center gap-2">
              <Bell className="w-4 h-4 text-stone-500" />
              <h3 className="text-sm font-semibold text-stone-700">Follow-ups</h3>
              {followUps.length > 0 && (
                <span className="text-xs text-stone-400 font-normal">({followUps.length})</span>
              )}
            </div>
            {canEdit && !addingFollowUp && (
              <button
                onClick={openAddFollowUp}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-stone-200 text-stone-600 hover:bg-white hover:border-stone-300 transition"
              >
                <Plus className="w-3.5 h-3.5" /> Add Follow-up
              </button>
            )}
          </div>

          {/* Add follow-up form */}
          {addingFollowUp && (
            <div className="px-4 py-4 border-b border-stone-100 bg-amber-50/40">
              <div className="flex flex-col gap-3">
                <div>
                  <label className="text-xs font-medium text-stone-500 block mb-1">
                    Reminder Date & Time <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="date"
                    value={followUpReminderDate}
                    onChange={e => { setFollowUpReminderDate(e.target.value); setFollowUpErrors(prev => ({ ...prev, reminderDate: '' })); }}
                    className={`w-full px-3 py-2 text-sm border rounded-lg bg-white text-stone-800 focus:outline-none focus:ring-2 focus:ring-amber-500 focus:border-transparent transition ${followUpErrors.reminderDate ? 'border-red-300' : 'border-stone-200'}`}
                  />
                  {followUpErrors.reminderDate && <p className="text-xs text-red-500 mt-1">{followUpErrors.reminderDate}</p>}
                </div>
                <div>
                  <label className="text-xs font-medium text-stone-500 block mb-1">
                    Note <span className="text-red-500">*</span>
                  </label>
                  <textarea
                    value={followUpNote}
                    onChange={e => { setFollowUpNote(e.target.value); setFollowUpErrors(prev => ({ ...prev, note: '' })); }}
                    placeholder="What needs to be followed up on?"
                    rows={3}
                    className={`w-full px-3 py-2 text-sm border rounded-lg bg-white text-stone-800 placeholder-stone-300 resize-none focus:outline-none focus:ring-2 focus:ring-amber-500 focus:border-transparent transition ${followUpErrors.note ? 'border-red-300' : 'border-stone-200'}`}
                  />
                  {followUpErrors.note && <p className="text-xs text-red-500 mt-1">{followUpErrors.note}</p>}
                </div>
              </div>
              <div className="flex items-center gap-2 mt-3 justify-end">
                <button
                  onClick={cancelAddFollowUp}
                  disabled={submittingFollowUp}
                  className="px-3 py-1.5 text-xs font-medium rounded-lg border border-stone-200 text-stone-600 hover:bg-white transition disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  onClick={handleSubmitFollowUp}
                  disabled={submittingFollowUp}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-amber-700 text-white hover:bg-amber-800 transition disabled:opacity-60"
                >
                  {submittingFollowUp
                    ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Saving…</>
                    : <><Bell className="w-3.5 h-3.5" /> Save Follow-up</>
                  }
                </button>
              </div>
            </div>
          )}

          {/* Follow-ups list */}
          <div className="divide-y divide-stone-100">
            {followUpsLoading ? (
              <div className="flex items-center justify-center py-10">
                <Loader2 className="w-5 h-5 text-amber-600 animate-spin" />
              </div>
            ) : followUps.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-10 text-center">
                <Bell className="w-7 h-7 text-stone-200 mb-2" />
                <p className="text-sm text-stone-400">No follow-ups added yet.</p>
              </div>
            ) : (
              followUps.map(fu => {
                const now = new Date();
                const reminderDate = new Date(fu.reminder_date);
                const isOverdue = fu.status === 'PENDING' && reminderDate < now;
                const isCompleted = fu.status === 'COMPLETED';

                return (
                  <div
                    key={fu.id}
                    className={`px-4 py-4 transition-colors ${
                      isCompleted ? 'bg-stone-50/60' : isOverdue ? 'bg-red-50/40' : 'hover:bg-stone-50'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex-1 min-w-0">
                        {/* Tags row */}
                        <div className="flex flex-wrap items-center gap-2 mb-2">
                          {isCompleted ? (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-green-100 text-green-700">
                              <CheckCircle2 className="w-3 h-3" /> Completed
                            </span>
                          ) : isOverdue ? (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-red-100 text-red-700">
                              <AlertCircle className="w-3 h-3" /> Overdue
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-amber-100 text-amber-700">
                              <Clock className="w-3 h-3" /> Upcoming
                            </span>
                          )}
                          <span className={`text-xs font-medium ${isOverdue ? 'text-red-600' : isCompleted ? 'text-stone-400' : 'text-stone-600'}`}>
                            {formatDate(reminderDate.toISOString())}
                          </span>
                        </div>

                        {/* Note */}
                        <p className={`text-sm whitespace-pre-wrap leading-relaxed mb-2 ${isCompleted ? 'text-stone-400 line-through' : 'text-stone-800'}`}>
                          {fu.note}
                        </p>

                        {/* Meta */}
                        <div className="flex items-center gap-2 text-xs text-stone-400">
                          <User className="w-3 h-3" />
                          <span className="font-medium text-stone-500">{fu.created_by}</span>
                          <span>·</span>
                          <Clock className="w-3 h-3" />
                          <span>{formatDateTime(fu.created_at)}</span>
                        </div>
                      </div>

                      {/* Actions */}
                      <div className="flex-shrink-0 flex flex-col gap-1.5 items-end">
                        {/* Copy link */}
                        <button
                          onClick={() => {
                            const url = new URL(window.location.href);
                            url.search = '';
                            url.searchParams.set('followup', fu.id);
                            navigator.clipboard.writeText(url.toString());
                            setCopiedFollowUpId(fu.id);
                            setTimeout(() => setCopiedFollowUpId(null), 2000);
                          }}
                          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-stone-200 text-stone-500 bg-white hover:bg-stone-50 transition"
                        >
                          {copiedFollowUpId === fu.id
                            ? <><Check className="w-3.5 h-3.5 text-green-600" /> Copied!</>
                            : <><Link2 className="w-3.5 h-3.5" /> Copy Link</>
                          }
                        </button>

                        {canEdit && !isCompleted && (
                          <button
                            onClick={() => markFollowUpCompleted(fu.id)}
                            disabled={completingFollowUpId === fu.id}
                            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-green-200 text-green-700 bg-green-50 hover:bg-green-100 transition disabled:opacity-50"
                          >
                            {completingFollowUpId === fu.id
                              ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                              : <CheckCircle2 className="w-3.5 h-3.5" />
                            }
                            Mark Complete
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* Field Notes (raw from lead_entries) */}
        {val(lead.notes) && (
          <Card title="Field Notes" icon={<FileText className="w-4 h-4" />}>
            <div className="py-3">
              <p className="text-sm text-stone-700 whitespace-pre-wrap leading-relaxed">{lead.notes}</p>
            </div>
            {(val(lead.contact_image_link) || val(lead.notes_image_link)) && (
              <div className="flex flex-wrap gap-3 pb-3 border-t border-stone-100 pt-3">
                {val(lead.contact_image_link) && (
                  <a href={lead.contact_image_link} target="_blank" rel="noopener noreferrer" className="group flex flex-col gap-1 items-center">
                    <div className="w-24 h-24 rounded-lg overflow-hidden border border-stone-200 bg-stone-50 flex items-center justify-center">
                      <img src={lead.contact_image_link} alt="Contact" className="w-full h-full object-cover group-hover:opacity-80 transition" />
                    </div>
                    <span className="flex items-center gap-1 text-xs text-stone-400 group-hover:text-amber-600 transition">
                      <Image className="w-3 h-3" /> Contact
                    </span>
                  </a>
                )}
                {val(lead.notes_image_link) && (
                  <a href={lead.notes_image_link} target="_blank" rel="noopener noreferrer" className="group flex flex-col gap-1 items-center">
                    <div className="w-24 h-24 rounded-lg overflow-hidden border border-stone-200 bg-stone-50 flex items-center justify-center">
                      <img src={lead.notes_image_link} alt="Notes" className="w-full h-full object-cover group-hover:opacity-80 transition" />
                    </div>
                    <span className="flex items-center gap-1 text-xs text-stone-400 group-hover:text-amber-600 transition">
                      <Image className="w-3 h-3" /> Notes
                    </span>
                  </a>
                )}
              </div>
            )}
          </Card>
        )}

        {/* Captured Evidence */}
        <LeadEvidenceSection leadId={leadId} />

        {/* WhatsApp Status */}
        <Card title="WhatsApp Status" icon={<MessageCircle className="w-4 h-4" />}>
          <div className="py-2 flex flex-wrap gap-x-8 gap-y-0">
            <div className="flex items-start gap-3 py-2.5 min-w-[160px]">
              <span className="mt-0.5 text-stone-400"><MessageCircle className="w-3.5 h-3.5" /></span>
              <div>
                <p className="text-xs text-stone-400 mb-1">Status</p>
                {lead.whatsapp_status ? (
                  <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-semibold ${WA_STATUS_STYLES[lead.whatsapp_status.toLowerCase()] ?? 'bg-stone-100 text-stone-600'}`}>
                    {lead.whatsapp_status}
                  </span>
                ) : (
                  <p className="text-sm text-stone-300">—</p>
                )}
              </div>
            </div>
            <div className="flex items-start gap-3 py-2.5 min-w-[160px]">
              <span className="mt-0.5 text-stone-400"><RefreshCw className="w-3.5 h-3.5" /></span>
              <div>
                <p className="text-xs text-stone-400 mb-0.5">Retry Count</p>
                <p className="text-sm text-stone-800">{lead.whatsapp_retry_count ?? 0}</p>
              </div>
            </div>
            <div className="flex items-start gap-3 py-2.5 min-w-[200px]">
              <span className="mt-0.5 text-stone-400"><Clock className="w-3.5 h-3.5" /></span>
              <div>
                <p className="text-xs text-stone-400 mb-0.5">Last Attempt</p>
                <p className="text-sm text-stone-800">{formatDateTime(lead.whatsapp_last_attempt_at) ?? '—'}</p>
              </div>
            </div>
            {val(lead.whatsapp_error) && (
              <div className="flex items-start gap-3 py-2.5 w-full border-t border-stone-100 mt-1">
                <span className="mt-0.5 text-red-400"><AlertCircle className="w-3.5 h-3.5" /></span>
                <div>
                  <p className="text-xs text-stone-400 mb-0.5">Error</p>
                  <p className="text-sm text-red-600 font-mono">{lead.whatsapp_error}</p>
                </div>
              </div>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}
