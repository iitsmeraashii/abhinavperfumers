// OCR hook — runs Tesseract.js in the browser, fully offline.
// Returns live progress, result, and a cancel handle.

import { useState, useRef, useCallback } from 'react';
import { createWorker } from 'tesseract.js';
import { parseBusinessCardText } from './parseBusinessCard';
import type { OcrResult, OcrStatus } from './types';

// Tesseract OCR resolution — downscale large images before recognition
// to keep mobile perf acceptable. 1200px is readable for printed cards.
const OCR_MAX_PX = 1200;

export interface OcrState {
  status: OcrStatus;
  progress: number;    // 0–1
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

// Resize a data-URL image to max dimension before passing to Tesseract,
// so mobile devices don't choke on large camera photos.
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

// Friendly label for Tesseract's internal status strings
function friendlyLabel(status: string, pct: number): string {
  if (status.includes('load')) return 'Loading OCR engine…';
  if (status.includes('init')) return 'Initialising OCR…';
  if (status.includes('recogni')) return `Extracting text… ${Math.round(pct * 100)}%`;
  return 'Processing…';
}

export function useOcr(): UseOcrReturn {
  const [ocrState, setOcrState] = useState<OcrState>(IDLE_STATE);
  const cancelledRef = useRef(false);
  const workerRef    = useRef<Awaited<ReturnType<typeof createWorker>> | null>(null);

  const cancelOcr = useCallback(() => {
    cancelledRef.current = true;
    workerRef.current?.terminate().catch(() => {});
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

    let worker: Awaited<ReturnType<typeof createWorker>> | null = null;

    try {
      // Step 1: resize for OCR performance
      const resized = await resizeForOcr(dataUrl);
      if (cancelledRef.current) return null;

      setOcrState(s => ({ ...s, progressLabel: 'Loading OCR engine…', progress: 0.05 }));

      // Step 2: create Tesseract worker with progress callback
      worker = await createWorker('eng', 1, {
        logger: (m) => {
          if (cancelledRef.current) return;
          if (m.status && typeof m.progress === 'number') {
            setOcrState(s => ({
              ...s,
              progress: 0.05 + m.progress * 0.9,
              progressLabel: friendlyLabel(m.status, m.progress),
            }));
          }
        },
      });

      if (cancelledRef.current) { await worker.terminate(); return null; }
      workerRef.current = worker;

      // Step 3: run recognition
      const { data } = await worker.recognize(resized);
      await worker.terminate();
      workerRef.current = null;

      if (cancelledRef.current) return null;

      const rawText = data.text ?? '';

      // Step 4: heuristic field extraction
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

      setOcrState({
        status: 'done',
        progress: 1,
        progressLabel: 'Done',
        result,
        error: null,
      });

      return result;

    } catch (err) {
      if (cancelledRef.current) return null;
      await worker?.terminate().catch(() => {});
      workerRef.current = null;

      const msg = err instanceof Error ? err.message : 'OCR failed';
      setOcrState({
        status: 'error',
        progress: 0,
        progressLabel: '',
        result: null,
        error: msg,
      });
      return null;
    }
  }, []);

  return { ocrState, runOcr, cancelOcr, resetOcr };
}
