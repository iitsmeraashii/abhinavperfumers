// OCR hook — loads Tesseract.js from CDN at runtime (avoids npm bundling issues).
// Fully offline-capable once the CDN script is cached by the browser.
// No cloud APIs, no AI — pure in-browser OCR.

import { useState, useRef, useCallback } from 'react';
import { parseBusinessCardText } from './parseBusinessCard';
import type { OcrResult, OcrStatus } from './types';

const OCR_MAX_PX = 1200;

// Tesseract v4 CDN — loaded once, cached by the browser thereafter
const TESSERACT_CDN = 'https://cdn.jsdelivr.net/npm/tesseract.js@4/dist/tesseract.min.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface OcrState {
  status: OcrStatus;
  progress: number;
  progressLabel: string;
  result: OcrResult | null;
  error: string | null;
}

export interface UseOcrReturn {
  ocrState: OcrState;
  runOcr: (assetId: string, dataUrl: string) => Promise<OcrResult | null>;
  cancelOcr: () => void;
  resetOcr: () => void;
}

const IDLE_STATE: OcrState = {
  status: 'idle',
  progress: 0,
  progressLabel: '',
  result: null,
  error: null,
};

// ─── CDN loader ───────────────────────────────────────────────────────────────

let tesseractLoadPromise: Promise<void> | null = null;

function loadTesseract(): Promise<void> {
  // Already available on window
  if (typeof window !== 'undefined' && (window as unknown as Record<string, unknown>)['Tesseract']) {
    return Promise.resolve();
  }
  if (tesseractLoadPromise) return tesseractLoadPromise;

  tesseractLoadPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${TESSERACT_CDN}"]`);
    if (existing) {
      existing.addEventListener('load', () => resolve());
      existing.addEventListener('error', () => reject(new Error('Tesseract CDN load failed')));
      return;
    }
    const script = document.createElement('script');
    script.src = TESSERACT_CDN;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Failed to load OCR engine. Check your connection.'));
    document.head.appendChild(script);
  });

  return tesseractLoadPromise;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function resizeForOcr(dataUrl: string, maxPx = OCR_MAX_PX): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const { naturalWidth: w, naturalHeight: h } = img;
      const scale = Math.min(1, maxPx / Math.max(w, h));
      const canvas = document.createElement('canvas');
      canvas.width  = Math.round(w * scale);
      canvas.height = Math.round(h * scale);
      const ctx = canvas.getContext('2d');
      if (!ctx) { resolve(dataUrl); return; }
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL('image/jpeg', 0.92));
    };
    img.onerror = () => reject(new Error('Could not load image for OCR resize'));
    img.src = dataUrl;
  });
}

function friendlyLabel(status: string, pct: number): string {
  if (status.includes('load')) return 'Loading OCR engine…';
  if (status.includes('init')) return 'Initialising OCR…';
  if (status.includes('recogni')) return `Extracting text… ${Math.round(pct * 100)}%`;
  return 'Processing…';
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useOcr(): UseOcrReturn {
  const [ocrState, setOcrState] = useState<OcrState>(IDLE_STATE);
  const cancelledRef = useRef(false);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const workerRef = useRef<any>(null);

  const cancelOcr = useCallback(() => {
    cancelledRef.current = true;
    try { workerRef.current?.terminate(); } catch { /* ignore */ }
    workerRef.current = null;
    setOcrState(IDLE_STATE);
  }, []);

  const resetOcr = useCallback(() => {
    cancelledRef.current = false;
    setOcrState(IDLE_STATE);
  }, []);

  const runOcr = useCallback(async (assetId: string, dataUrl: string): Promise<OcrResult | null> => {
    cancelledRef.current = false;

    setOcrState({
      status: 'processing',
      progress: 0,
      progressLabel: 'Preparing image…',
      result: null,
      error: null,
    });

    try {
      // Resize first — keeps mobile from freezing on large camera images
      const resized = await resizeForOcr(dataUrl);
      if (cancelledRef.current) return null;

      setOcrState(s => ({ ...s, progressLabel: 'Loading OCR engine…', progress: 0.03 }));

      // Load Tesseract from CDN (no-op if already loaded)
      await loadTesseract();
      if (cancelledRef.current) return null;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const Tesseract = (window as any).Tesseract;
      if (!Tesseract?.createWorker) throw new Error('OCR engine unavailable');

      setOcrState(s => ({ ...s, progressLabel: 'Initialising OCR…', progress: 0.08 }));

      const worker = await Tesseract.createWorker('eng', 1, {
        logger: (m: { status: string; progress: number }) => {
          if (cancelledRef.current) return;
          if (m.status && typeof m.progress === 'number') {
            setOcrState(s => ({
              ...s,
              progress: 0.08 + m.progress * 0.88,
              progressLabel: friendlyLabel(m.status, m.progress),
            }));
          }
        },
      });

      if (cancelledRef.current) { await worker.terminate(); return null; }
      workerRef.current = worker;

      const { data } = await worker.recognize(resized);
      await worker.terminate();
      workerRef.current = null;

      if (cancelledRef.current) return null;

      const rawText: string = data.text ?? '';
      const parsed = parseBusinessCardText(rawText);

      const result: OcrResult = {
        assetId,
        rawText,
        fields: parsed.fields,
        confidence: parsed.confidence,
        inferredFields: parsed.inferredFields,
        ignoredLines: parsed.ignoredLines,
        completedAt: new Date().toISOString(),
      };

      setOcrState({ status: 'done', progress: 1, progressLabel: 'Done', result, error: null });
      return result;

    } catch (err) {
      if (cancelledRef.current) return null;
      try { workerRef.current?.terminate(); } catch { /* ignore */ }
      workerRef.current = null;

      const msg = err instanceof Error ? err.message : 'OCR failed';
      setOcrState({ status: 'error', progress: 0, progressLabel: '', result: null, error: msg });
      return null;
    }
  }, []);

  return { ocrState, runOcr, cancelOcr, resetOcr };
}
