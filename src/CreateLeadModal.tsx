import { useState } from 'react';
import { supabase } from './supabaseClient';
import { getAuthIdentity } from './capture/captureAuth';
import {
  X, Loader2, AlertCircle, User, Building2,
  Phone, MapPin, Check,
} from 'lucide-react';

interface Props {
  conversationId: string;
  waPhoneNumber: string;
  customerName?: string | null;
  onClose: () => void;
  onCreated: (leadId: string) => void;
}

interface FormState {
  clientName: string;
  company: string;
  designation: string;
  phone: string;
  email: string;
  address: string;
  state: string;
  leadTemperature: string;
  notes: string;
}

export default function CreateLeadModal({ conversationId, waPhoneNumber, customerName, onClose, onCreated }: Props) {
  const [form, setForm] = useState<FormState>({
    clientName: customerName ?? '',
    company: '',
    designation: '',
    phone: waPhoneNumber,
    email: '',
    address: '',
    state: '',
    leadTemperature: 'Warm',
    notes: '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [created, setCreated] = useState(false);

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm(prev => ({ ...prev, [key]: value }));
  }

  function deriveStateFromAddress(addr: string): string {
    if (!addr.trim()) return '';
    const lower = addr.toLowerCase();
    const states = ['andhra pradesh', 'assam', 'bihar', 'chhattisgarh', 'delhi', 'goa', 'gujarat',
      'haryana', 'himachal pradesh', 'jharkhand', 'karnataka', 'kerala', 'madhya pradesh',
      'maharashtra', 'odisha', 'punjab', 'rajasthan', 'tamil nadu', 'telangana', 'uttar pradesh',
      'uttarakhand', 'west bengal', 'ap', 'assam', 'br', 'cg', 'dl', 'ga', 'gj', 'hr', 'hp',
      'jh', 'ka', 'kl', 'mp', 'mh', 'od', 'pb', 'rj', 'tn', 'ts', 'up', 'uk', 'wb'];
    for (const s of states) {
      if (lower.includes(s)) return s.toUpperCase();
    }
    return '';
  }

  async function handleCreate() {
    setSaving(true);
    setError('');

    try {
      const identity = await getAuthIdentity();
      if (!identity?.repCode) {
        setError('Not authenticated or rep profile unavailable.');
        setSaving(false);
        return;
      }

      const leadId = crypto.randomUUID();
      const now = new Date().toISOString();

      const phones: string[] = [];
      if (form.phone.trim()) phones.push(form.phone.trim());

      const emails: string[] = [];
      if (form.email.trim()) emails.push(form.email.trim());

      const { error: insertErr } = await supabase.from('lead_entries').insert({
        id: leadId,
        client_name: form.clientName.trim() || null,
        company: form.company.trim() || null,
        designation: form.designation.trim() || null,
        phones: phones.length ? phones : null,
        emails: emails.length ? emails : null,
        address: form.address.trim() || null,
        state: form.state.trim() || deriveStateFromAddress(form.address),
        notes: form.notes.trim() || null,
        lead_temperature: form.leadTemperature || null,
        lead_type: 'NEW',
        lead_status: 'NEW',
        system_status: 'CREATED',
        sales_rep_code: identity.repCode,
        created_at: now,
        updated_at: now,
      });

      if (insertErr) {
        setError(insertErr.message || 'Failed to create lead.');
        setSaving(false);
        return;
      }

      // Link the new lead to the conversation
      const { error: linkErr } = await supabase
        .from('whatsapp_conversation_leads')
        .insert({
          conversation_id: conversationId,
          lead_entry_id: leadId,
        });

      if (linkErr) {
        // Lead was created but linking failed — still report success
        // since the lead exists; the user can link it manually
        console.warn('[CreateLeadModal] link failed:', linkErr.message);
      }

      setCreated(true);
      setSaving(false);
      onCreated(leadId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An unexpected error occurred.');
      setSaving(false);
    }
  }

  const inputCls = 'w-full px-3 py-2 text-sm border border-stone-200 rounded-lg bg-white text-stone-800 placeholder:text-stone-400 focus:outline-none focus:ring-2 focus:ring-amber-500 focus:border-transparent transition';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/30">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[85vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-stone-100">
          <h2 className="text-base font-semibold text-stone-800">Create New Lead</h2>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-full hover:bg-stone-100 flex items-center justify-center text-stone-400 transition"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Error */}
        {error && (
          <div className="mx-5 mt-3 flex items-center gap-2 px-3 py-2 bg-red-50 border border-red-200 text-red-700 text-xs rounded-lg">
            <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" />
            {error}
          </div>
        )}

        {/* Form */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
          {created ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <div className="w-12 h-12 rounded-full bg-green-100 flex items-center justify-center mb-3">
                <Check className="w-6 h-6 text-green-600" />
              </div>
              <p className="text-sm font-semibold text-stone-700">Lead created and linked</p>
              <p className="text-xs text-stone-400 mt-1">The new lead has been linked to this conversation.</p>
            </div>
          ) : (
            <>
              {/* Client Name */}
              <div>
                <label className="text-xs text-stone-400 mb-1 block flex items-center gap-1">
                  <User className="w-3 h-3" /> Client Name
                </label>
                <input
                  type="text"
                  value={form.clientName}
                  onChange={e => update('clientName', e.target.value)}
                  placeholder="Enter client name"
                  className={inputCls}
                />
              </div>

              {/* Company */}
              <div>
                <label className="text-xs text-stone-400 mb-1 block flex items-center gap-1">
                  <Building2 className="w-3 h-3" /> Company
                </label>
                <input
                  type="text"
                  value={form.company}
                  onChange={e => update('company', e.target.value)}
                  placeholder="Company name"
                  className={inputCls}
                />
              </div>

              {/* Designation */}
              <div>
                <label className="text-xs text-stone-400 mb-1 block">Designation</label>
                <input
                  type="text"
                  value={form.designation}
                  onChange={e => update('designation', e.target.value)}
                  placeholder="Job title"
                  className={inputCls}
                />
              </div>

              {/* Phone (pre-filled) */}
              <div>
                <label className="text-xs text-stone-400 mb-1 block flex items-center gap-1">
                  <Phone className="w-3 h-3" /> Phone
                </label>
                <input
                  type="text"
                  value={form.phone}
                  onChange={e => update('phone', e.target.value)}
                  placeholder="Phone number"
                  className={`${inputCls} bg-amber-50/30`}
                />
                <p className="text-[10px] text-stone-400 mt-0.5">Pre-filled from WhatsApp number</p>
              </div>

              {/* Email */}
              <div>
                <label className="text-xs text-stone-400 mb-1 block">Email</label>
                <input
                  type="email"
                  value={form.email}
                  onChange={e => update('email', e.target.value)}
                  placeholder="Email address"
                  className={inputCls}
                />
              </div>

              {/* Address */}
              <div>
                <label className="text-xs text-stone-400 mb-1 block flex items-center gap-1">
                  <MapPin className="w-3 h-3" /> Address
                </label>
                <input
                  type="text"
                  value={form.address}
                  onChange={e => update('address', e.target.value)}
                  placeholder="City, State"
                  className={inputCls}
                />
              </div>

              {/* Lead Temperature */}
              <div>
                <label className="text-xs text-stone-400 mb-1 block">Lead Temperature</label>
                <select
                  value={form.leadTemperature}
                  onChange={e => update('leadTemperature', e.target.value)}
                  className={inputCls}
                >
                  <option value="Hot">Hot</option>
                  <option value="Warm">Warm</option>
                  <option value="Cold">Cold</option>
                </select>
              </div>

              {/* Notes */}
              <div>
                <label className="text-xs text-stone-400 mb-1 block">Notes</label>
                <textarea
                  value={form.notes}
                  onChange={e => update('notes', e.target.value)}
                  placeholder="Additional notes…"
                  rows={2}
                  className={`${inputCls} resize-none`}
                />
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-stone-100 flex justify-end gap-2">
          {created ? (
            <button
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium text-white bg-stone-800 hover:bg-stone-700 rounded-lg transition"
            >
              Done
            </button>
          ) : (
            <>
              <button
                onClick={onClose}
                disabled={saving}
                className="px-4 py-2 text-sm font-medium text-stone-600 hover:bg-stone-100 rounded-lg transition disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={handleCreate}
                disabled={saving || !form.clientName.trim()}
                className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-stone-800 hover:bg-stone-700 rounded-lg transition disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
                Create & Link
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
