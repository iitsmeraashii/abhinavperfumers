import { useEffect, useState } from 'react';
import { supabase } from './supabaseClient';
import { Bell, CheckCircle2, X, Loader2, AlertCircle, CalendarDays, User, FileText } from 'lucide-react';

interface FollowUp {
  id: string;
  lead_id: string;
  reminder_date: string;
  note: string;
  status: 'PENDING' | 'COMPLETED';
  created_by: string;
  lead_entries: { client_name: string; company: string | null } | null;
}

interface Props {
  followUpId: string;
  onClose: () => void;
}

export default function FollowUpCompleteModal({ followUpId, onClose }: Props) {
  const [followUp, setFollowUp] = useState<FollowUp | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [completing, setCompleting] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    (async () => {
      const { data, error } = await supabase
        .from('lead_follow_ups')
        .select('id, lead_id, reminder_date, note, status, created_by, lead_entries(client_name, company)')
        .eq('id', followUpId)
        .maybeSingle();

      if (error || !data) {
        setNotFound(true);
      } else {
        setFollowUp(data as FollowUp);
        if ((data as FollowUp).status === 'COMPLETED') setDone(true);
      }
      setLoading(false);
    })();
  }, [followUpId]);

  async function handleConfirm() {
    if (!followUp) return;
    setCompleting(true);
    setError('');
    const { error } = await supabase
      .from('lead_follow_ups')
      .update({ status: 'COMPLETED', updated_at: new Date().toISOString() })
      .eq('id', followUpId);
    if (error) {
      setError('Failed to update. Please try again.');
      setCompleting(false);
      return;
    }
    setDone(true);
    setCompleting(false);
  }

  function formatDate(iso: string) {
    return new Date(iso).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Modal */}
      <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden animate-in">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-stone-100">
          <div className="flex items-center gap-2">
            <Bell className="w-5 h-5 text-amber-600" />
            <h2 className="text-base font-semibold text-stone-800">Follow-up Reminder</h2>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-stone-400 hover:text-stone-600 hover:bg-stone-100 transition"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="px-6 py-5">
          {loading ? (
            <div className="flex items-center justify-center py-10">
              <Loader2 className="w-6 h-6 text-amber-600 animate-spin" />
            </div>
          ) : notFound ? (
            <div className="flex flex-col items-center justify-center py-8 text-center gap-3">
              <AlertCircle className="w-10 h-10 text-stone-300" />
              <p className="text-stone-500 font-medium">Follow-up not found</p>
              <p className="text-stone-400 text-sm">This follow-up may have been deleted or the link is invalid.</p>
            </div>
          ) : done ? (
            <div className="flex flex-col items-center justify-center py-8 text-center gap-3">
              <div className="w-14 h-14 rounded-full bg-green-100 flex items-center justify-center">
                <CheckCircle2 className="w-7 h-7 text-green-600" />
              </div>
              <p className="text-stone-800 font-semibold text-lg">All done!</p>
              <p className="text-stone-500 text-sm">This follow-up has been marked as completed.</p>
            </div>
          ) : followUp ? (
            <div className="flex flex-col gap-5">
              <p className="text-stone-600 text-sm">
                Do you want to mark the following reminder as <span className="font-semibold text-green-700">Completed</span>?
              </p>

              {/* Follow-up details card */}
              <div className="bg-stone-50 border border-stone-200 rounded-xl p-4 flex flex-col gap-3">
                {/* Lead name */}
                {followUp.lead_entries && (
                  <div className="flex items-start gap-2.5">
                    <User className="w-4 h-4 text-stone-400 mt-0.5 flex-shrink-0" />
                    <div>
                      <p className="text-xs text-stone-400 mb-0.5">Lead</p>
                      <p className="text-sm font-medium text-stone-800">
                        {followUp.lead_entries.client_name}
                        {followUp.lead_entries.company && (
                          <span className="font-normal text-stone-500"> · {followUp.lead_entries.company}</span>
                        )}
                      </p>
                    </div>
                  </div>
                )}

                {/* Reminder date */}
                <div className="flex items-start gap-2.5">
                  <CalendarDays className="w-4 h-4 text-stone-400 mt-0.5 flex-shrink-0" />
                  <div>
                    <p className="text-xs text-stone-400 mb-0.5">Reminder Date</p>
                    <p className="text-sm text-stone-800">{formatDate(followUp.reminder_date)}</p>
                  </div>
                </div>

                {/* Note */}
                <div className="flex items-start gap-2.5">
                  <FileText className="w-4 h-4 text-stone-400 mt-0.5 flex-shrink-0" />
                  <div>
                    <p className="text-xs text-stone-400 mb-0.5">Note</p>
                    <p className="text-sm text-stone-800 whitespace-pre-wrap leading-relaxed">{followUp.note}</p>
                  </div>
                </div>
              </div>

              {error && (
                <div className="flex items-center gap-2 px-3 py-2 bg-red-50 border border-red-200 text-red-600 text-sm rounded-lg">
                  <AlertCircle className="w-4 h-4 flex-shrink-0" />
                  {error}
                </div>
              )}
            </div>
          ) : null}
        </div>

        {/* Footer */}
        {!loading && !notFound && !done && followUp && (
          <div className="flex items-center justify-end gap-2 px-6 py-4 border-t border-stone-100 bg-stone-50">
            <button
              onClick={onClose}
              disabled={completing}
              className="px-4 py-2 text-sm font-medium rounded-lg border border-stone-200 text-stone-600 hover:bg-white transition disabled:opacity-50"
            >
              Not yet
            </button>
            <button
              onClick={handleConfirm}
              disabled={completing}
              className="flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-green-600 text-white hover:bg-green-700 transition disabled:opacity-60"
            >
              {completing
                ? <><Loader2 className="w-4 h-4 animate-spin" /> Updating…</>
                : <><CheckCircle2 className="w-4 h-4" /> Yes, Mark Complete</>
              }
            </button>
          </div>
        )}

        {done && (
          <div className="flex justify-center px-6 py-4 border-t border-stone-100 bg-stone-50">
            <button
              onClick={onClose}
              className="px-6 py-2 text-sm font-medium rounded-lg bg-stone-800 text-white hover:bg-stone-900 transition"
            >
              Close
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
