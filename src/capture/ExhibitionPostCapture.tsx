import { useState, useEffect } from 'react';
import { CheckCircle2, Sparkles, ArrowRight, Pencil, Trash2, ImageOff } from 'lucide-react';
import { getAsset } from './captureAssetStorage';
import type { BusinessCardAsset } from './types';

interface Props {
  frontAssetId: string;
  backAssetId?: string | null;
  onSaveAndNext: () => void;
  onAddDetails: () => void;
  onDiscard: () => void;
  saving?: boolean;
}

export function ExhibitionPostCapture({
  frontAssetId, backAssetId, onSaveAndNext, onAddDetails, onDiscard, saving,
}: Props) {
  const [frontAsset, setFrontAsset] = useState<BusinessCardAsset | null>(null);
  const [backAsset, setBackAsset]   = useState<BusinessCardAsset | null>(null);
  const [loading, setLoading]       = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const [front, back] = await Promise.all([
        getAsset(frontAssetId),
        backAssetId ? getAsset(backAssetId) : Promise.resolve(null),
      ]);
      if (cancelled) return;
      setFrontAsset(front);
      setBackAsset(back);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [frontAssetId, backAssetId]);

  return (
    <div className="mt-4 animate-in fade-in slide-in-from-bottom-3 duration-300 pb-6">
      <div className="rounded-2xl bg-white border border-stone-200 shadow-sm overflow-hidden">
        {/* ── Success header ── */}
        <div className="px-5 pt-6 pb-4 flex flex-col items-center text-center">
          <div className="w-12 h-12 rounded-full bg-green-100 flex items-center justify-center mb-3">
            <CheckCircle2 className="w-6 h-6 text-green-600" />
          </div>
          <h2 className="text-lg font-bold text-stone-900 mb-1">Business card captured successfully</h2>
        </div>

        {/* ── Captured card images ── */}
        <div className="px-5 pb-4">
          <div className="flex flex-col items-center gap-3">
            {loading ? (
              <div className="w-full max-w-sm aspect-[1.75/1] rounded-xl bg-stone-100 animate-pulse" />
            ) : frontAsset ? (
              <div className="relative w-full max-w-sm group">
                <img
                  src={frontAsset.dataUrl}
                  alt="Business card front"
                  className="w-full rounded-xl border border-stone-200 shadow-sm object-contain max-h-56 bg-stone-50"
                />
                <span className="absolute top-2 left-2 px-2 py-0.5 rounded-md bg-stone-900/70 text-white text-[10px] font-semibold tracking-wide uppercase">
                  Front
                </span>
              </div>
            ) : (
              <div className="w-full max-w-sm aspect-[1.75/1] rounded-xl border border-dashed border-stone-300 bg-stone-50 flex flex-col items-center justify-center text-stone-400">
                <ImageOff className="w-6 h-6 mb-1" />
                <span className="text-xs">Image unavailable</span>
              </div>
            )}

            {backAsset && (
              <div className="flex items-center gap-2">
                <img
                  src={backAsset.dataUrl}
                  alt="Business card back"
                  className="h-20 rounded-lg border border-stone-200 shadow-sm object-cover bg-stone-50"
                />
                <div className="flex flex-col">
                  <span className="px-1.5 py-0.5 rounded bg-stone-900/70 text-white text-[10px] font-semibold tracking-wide uppercase w-fit">
                    Back
                  </span>
                  <span className="text-[11px] text-stone-400 mt-1">Card back captured</span>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* ── AI info banner ── */}
        <div className="mx-5 mb-4 flex items-start gap-2.5 px-3.5 py-2.5 rounded-xl bg-amber-50 border border-amber-200">
          <Sparkles className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
          <p className="text-xs font-medium text-amber-800 leading-relaxed">
            Background AI will process this business card after the lead is saved.
          </p>
        </div>

        {/* ── Actions ── */}
        <div className="px-5 pb-5 space-y-2.5">
          <button
            onClick={onSaveAndNext}
            disabled={saving}
            className="w-full flex items-center justify-center gap-2 py-4 rounded-2xl
              bg-stone-900 hover:bg-stone-800 active:bg-stone-950 active:scale-[0.98]
              text-white font-bold text-base transition-all duration-150 shadow-sm
              disabled:opacity-40"
          >
            {saving ? (
              <span className="flex items-center gap-2">
                <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                Saving…
              </span>
            ) : (
              <>
                Save &amp; Next Lead
                <ArrowRight className="w-5 h-5" />
              </>
            )}
          </button>

          <button
            onClick={onAddDetails}
            disabled={saving}
            className="w-full flex items-center justify-center gap-2 py-4 rounded-2xl
              border border-stone-200 bg-white text-stone-700 font-semibold text-base
              hover:bg-stone-50 active:bg-stone-100 active:scale-[0.98]
              transition-all duration-150 disabled:opacity-40"
          >
            <Pencil className="w-4 h-4" />
            Add More Details
          </button>

          <button
            onClick={onDiscard}
            disabled={saving}
            className="w-full flex items-center justify-center gap-2 py-3.5 rounded-2xl
              text-red-500 font-medium text-sm
              hover:bg-red-50 active:bg-red-100 active:scale-[0.98]
              transition-all duration-150 disabled:opacity-40"
          >
            <Trash2 className="w-4 h-4" />
            Discard
          </button>
        </div>
      </div>
    </div>
  );
}
