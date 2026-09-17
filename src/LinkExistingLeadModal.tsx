import { useState, useEffect, useRef } from 'react';
import { supabase } from './supabaseClient';
import {
  X, Search, Loader2, AlertCircle, User, Building2,
  Phone, CalendarDays, Check, Plus,
} from 'lucide-react';

interface LeadResult {
  id: string;
  client_name: string | null;
  company: string | null;
  phones: string[] | null;
  lead_status: string | null;
  lead_temperature: string | null;
  state: string | null;
  event_code: string | null;
  created_at: string;
}

interface Props {
  conversationId: string;
  existingLeadIds: string[];
  onClose: () => void;
  onLinked: () => void;
}

export default function LinkExistingLeadModal({ conversationId, existingLeadIds, onClose, onLinked }: Props) {
  const [search, setSearch] = useState('');
  const [results, setResults] = useState<LeadResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [linking, setLinking] = useState<string | null>(null);
  const [linkedId, setLinkedId] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!search.trim()) {
      setResults([]);
      return;
    }

    setLoading(true);
    setError('');

    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      const term = search.trim();

      // Search by name, company, or phone overlap
      const { data, error: err } = await supabase
        .from('lead_entries')
        .select('id, client_name, company, phones, lead_status, lead_temperature, state, event_code, created_at')
        .or(`client_name.ilike.%${term}%,company.ilike.%${term}%`)
        .order('created_at', { ascending: false })
        .limit(20);

      // Also search by phone if term looks numeric
      let phoneMatches: LeadResult[] = [];
      if (term.replace(/\D/g, '').length >= 3) {
        const { data: phoneData } = await supabase
          .from('lead_entries')
          .select('id, client_name, company, phones, lead_status, lead_temperature, state, event_code, created_at')
          .overlaps('phones', [term])
          .order('created_at', { ascending: false })
          .limit(20);
        phoneMatches = (phoneData ?? []) as LeadResult[];
      }

      // Also search by event_code
      let eventMatches: LeadResult[] = [];
      const { data: eventData } = await supabase
        .from('lead_entries')
        .select('id, client_name, company, phones, lead_status, lead_temperature, state, event_code, created_at')
        .ilike('event_code', `%${term}%`)
        .order('created_at', { ascending: false })
        .limit(20);
      eventMatches = (eventData ?? []) as LeadResult[];

      if (err) {
        setError(err.message || 'Search failed.');
        setResults([]);
        setLoading(false);
        return;
      }

      // Merge and deduplicate
      const allResults = [...(data ?? []), ...phoneMatches, ...eventMatches];
      const seen = new Set<string>();
      const deduped: LeadResult[] = [];
      for (const r of allResults as LeadResult[]) {
        if (!seen.has(r.id)) {
          seen.add(r.id);
          deduped.push(r);
        }
      }
      setResults(deduped);
      setLoading(false);
    }, 300);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [search]);

  async function handleLink(leadId: string) {
    setLinking(leadId);
    setError('');

    // Check for duplicate
    if (existingLeadIds.includes(leadId)) {
      setError('This lead is already linked to this conversation.');
      setLinking(null);
      return;
    }

    const { error: insertErr } = await supabase
      .from('whatsapp_conversation_leads')
      .insert({
        conversation_id: conversationId,
        lead_entry_id: leadId,
      });

    if (insertErr) {
      if (insertErr.code === '23505') {
        setError('This lead is already linked to this conversation.');
      } else {
        setError(insertErr.message || 'Failed to link lead.');
      }
      setLinking(null);
      return;
    }

    setLinkedId(leadId);
    setLinking(null);
    onLinked();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/30">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[80vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-stone-100">
          <h2 className="text-base font-semibold text-stone-800">Link Existing Lead</h2>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-full hover:bg-stone-100 flex items-center justify-center text-stone-400 transition"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Search bar */}
        <div className="px-5 py-3 border-b border-stone-100">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-stone-400" />
            <input
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search by name, company, phone, or event…"
              autoFocus
              className="w-full pl-9 pr-3 py-2.5 text-sm border border-stone-200 rounded-xl bg-white text-stone-800 placeholder:text-stone-400 focus:outline-none focus:ring-2 focus:ring-amber-500 focus:border-transparent transition"
            />
          </div>
        </div>

        {/* Error */}
        {error && (
          <div className="mx-5 mt-3 flex items-center gap-2 px-3 py-2 bg-red-50 border border-red-200 text-red-700 text-xs rounded-lg">
            <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" />
            {error}
          </div>
        )}

        {/* Results */}
        <div className="flex-1 overflow-y-auto px-5 py-3">
          {!search.trim() && !loading && (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <Search className="w-8 h-8 text-stone-300 mb-2" />
              <p className="text-sm text-stone-400">Start typing to search for leads</p>
            </div>
          )}

          {loading && (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="w-5 h-5 text-stone-400 animate-spin" />
            </div>
          )}

          {!loading && search.trim() && results.length === 0 && !error && (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <User className="w-8 h-8 text-stone-300 mb-2" />
              <p className="text-sm text-stone-400">No leads found matching "{search}"</p>
            </div>
          )}

          {!loading && results.length > 0 && (
            <div className="space-y-2">
              {results.map(lead => {
                const isExisting = existingLeadIds.includes(lead.id);
                const isThisLinked = linkedId === lead.id;
                const isThisLinking = linking === lead.id;

                return (
                  <div
                    key={lead.id}
                    className={`border rounded-lg px-3 py-2.5 transition ${
                      isThisLinked
                        ? 'border-green-200 bg-green-50/50'
                        : isExisting
                        ? 'border-stone-100 bg-stone-50 opacity-60'
                        : 'border-stone-200 hover:border-stone-300'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-stone-800 truncate">
                          {lead.client_name || 'Unnamed Lead'}
                        </p>
                        <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                          {lead.company && (
                            <span className="text-xs text-stone-500 truncate flex items-center gap-1">
                              <Building2 className="w-3 h-3" />
                              {lead.company}
                            </span>
                          )}
                          {lead.phones && lead.phones.length > 0 && (
                            <span className="text-xs text-stone-500 truncate flex items-center gap-1">
                              <Phone className="w-3 h-3" />
                              {lead.phones[0]}
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                          {lead.lead_status && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-stone-100 text-stone-500 font-medium">
                              {lead.lead_status}
                            </span>
                          )}
                          {lead.lead_temperature && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-stone-100 text-stone-500 font-medium">
                              {lead.lead_temperature}
                            </span>
                          )}
                          {lead.event_code && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-stone-100 text-stone-500 font-medium flex items-center gap-0.5">
                              <CalendarDays className="w-2.5 h-2.5" />
                              {lead.event_code}
                            </span>
                          )}
                        </div>
                      </div>

                      <div className="flex-shrink-0">
                        {isThisLinked ? (
                          <span className="flex items-center gap-1 px-2 py-1 text-xs font-medium text-green-600">
                            <Check className="w-3.5 h-3.5" />
                            Linked
                          </span>
                        ) : isExisting ? (
                          <span className="text-xs text-stone-400 px-2 py-1">Already linked</span>
                        ) : isThisLinking ? (
                          <Loader2 className="w-4 h-4 text-stone-400 animate-spin" />
                        ) : (
                          <button
                            onClick={() => handleLink(lead.id)}
                            className="flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-stone-700 bg-stone-100 hover:bg-stone-200 rounded-lg transition"
                          >
                            <Plus className="w-3.5 h-3.5" />
                            Link
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-stone-100 flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium text-stone-600 hover:bg-stone-100 rounded-lg transition"
          >
            {linkedId ? 'Done' : 'Cancel'}
          </button>
        </div>
      </div>
    </div>
  );
}
