// OCR hook — tesseract.js v7, singleton worker, mobile-Safari hardened.
//
// Uses a dynamic import of the local ESM bundle (served from /public) to avoid
// Vite CJS resolution issues with the tesseract.js npm package in dev mode.
//
// Key design decisions:
//   - Worker created ONCE globally — avoids reloading 10MB WASM on every scan
//   - Images downscaled to ≤600px as Blob — protects Safari WASM heap limit
//   - OCR receives an object URL (Blob ref), never the raw base64 string
//   - Hard 15-second timeout on worker init and recognize()
//   - All canvas / object URL refs revoked immediately after use

import { useState, useRef, useCallback } from 'react';
import { parseBusinessCardText } from './parseBusinessCard';
import type { OcrResult, OcrStatus } from './types';

// ─── Config ───────────────────────────────────────────────────────────────────

const OCR_MAX_PX       = 600;
const OCR_JPEG_QUALITY = 0.6;
const OCR_TIMEOUT_MS   = 15_000;

// ESM bundle and worker served as static assets from /public (copied from node_modules).
// corePath / langPath fall back to tesseract.js CDN defaults when omitted.
const TESSERACT_ESM_URL    = '/tesseract.esm.min.js';
const TESSERACT_WORKER_URL = '/tesseract.worker.min.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface OcrState {
  status:        OcrStatus;
  progress:      number;
  progressLabel: string;
  result:        OcrResult | null;
  error:         string | null;
}

export interface UseOcrReturn {
  ocrState:  OcrState;
  runOcr:    (assetId: string, dataUrl: string) => Promise<OcrResult | null>;
  cancelOcr: () => void;
  resetOcr:  () => void;
}

const IDLE_STATE: OcrState = {
  status:        'idle',
  progress:      0,
  progressLabel: '',
  result:        null,
  error:         null,
};

// ─── Singleton worker ─────────────────────────────────────────────────────────
// One worker per browser-tab lifetime.  Re-creating it on every scan reloads
// the entire WASM binary — on mobile Safari this reliably exhausts the per-tab
// heap before recognize() executes.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TesseractWorker = any;

let workerSingleton:   TesseractWorker    | null = null;
let workerInitPromise: Promise<TesseractWorker> | null = null;

async function getOrCreateWorker(
  onProgress: (status: string, progress: number) => void,
): Promise<TesseractWorker> {
  if (workerSingleton)   return workerSingleton;
  if (workerInitPromise) return workerInitPromise;

  workerInitPromise = (async () => {
    // Dynamic import of the local ESM build — bypasses Vite's CJS transform issues
    const mod = await import(/* @vite-ignore */ TESSERACT_ESM_URL);
    // ESM bundle wraps CJS: exports land on .default or directly on the module
    const createWorker = mod.createWorker ?? mod.default?.createWorker;
    if (typeof createWorker !== 'function') {
      throw new Error('tesseract.js ESM bundle did not export createWorker');
    }

    const worker = await createWorker('eng', 1 /* OEM.LSTM_ONLY */, {
      workerPath: TESSERACT_WORKER_URL,
      // corePath and langPath intentionally omitted — tesseract.js v7 resolves
      // these from its own CDN defaults relative to workerPath at runtime.
      logger: (m: { status: string; progress: number }) => {
        if (m.status && typeof m.progress === 'number') {
          onProgress(m.status, m.progress);
        }
      },
    });

    workerSingleton = worker;
    return worker;
  })().catch((err) => {
    workerInitPromise = null;
    workerSingleton   = null;
    throw err;
  });

  return workerInitPromise;
}

function invalidateWorker() {
  try { workerSingleton?.terminate(); } catch { /* ignore */ }
  workerSingleton   = null;
  workerInitPromise = null;
}

// ─── Image preparation ────────────────────────────────────────────────────────
// Returns a JPEG Blob at ≤600px wrapped in an object URL.
// Blob avoids the 33% base64 memory overhead that blows Safari's WASM heap.

interface PreparedImage {
  objectUrl:      string;
  width:          number;
  height:         number;
  originalWidth:  number;
  originalHeight: number;
  sizeBytes:      number;
}

function prepareImageForOcr(dataUrl: string): Promise<PreparedImage> {
  return new Promise((resolve, reject) => {
    const img = new Image();

    img.onload = () => {
      const origW = img.naturalWidth;
      const origH = img.naturalHeight;
      const scale = Math.min(1, OCR_MAX_PX / Math.max(origW, origH, 1));
      const w     = Math.max(1, Math.round(origW * scale));
      const h     = Math.max(1, Math.round(origH * scale));

      const canvas = document.createElement('canvas');
      canvas.width  = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) { reject(new Error('Canvas 2D context unavailable')); return; }

      ctx.drawImage(img, 0, 0, w, h);

      canvas.toBlob((blob) => {
        // Release backing store immediately — don't hold the full image in memory
        canvas.width  = 1;
        canvas.height = 1;

        if (!blob) { reject(new Error('canvas.toBlob() returned null')); return; }

        resolve({
          objectUrl:      URL.createObjectURL(blob),
          width:          w,
          height:         h,
          originalWidth:  origW,
          originalHeight: origH,
          sizeBytes:      blob.size,
        });
      }, 'image/jpeg', OCR_JPEG_QUALITY);
    };

    img.onerror = () => reject(new Error('Failed to decode image for OCR'));
    img.src = dataUrl;
  });
}

// ─── Timeout helper ───────────────────────────────────────────────────────────

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error(`OCR timeout after ${ms / 1000}s (${label})`)),
      ms,
    );
    p.then(v => { clearTimeout(t); resolve(v); },
           e => { clearTimeout(t); reject(e);  });
  });
}

// ─── Progress label ───────────────────────────────────────────────────────────

function friendlyLabel(status: string, pct: number): string {
  if (/load|init/i.test(status))   return 'Loading OCR engine…';
  if (/recogni/i.test(status))     return `Reading card… ${Math.round(pct * 100)}%`;
  return 'Processing…';
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useOcr(): UseOcrReturn {
  const [ocrState, setOcrState] = useState<OcrState>(IDLE_STATE);
  const cancelledRef = useRef(false);

  const cancelOcr = useCallback(() => {
    cancelledRef.current = true;
    setOcrState(IDLE_STATE);
  }, []);

  const resetOcr = useCallback(() => {
    cancelledRef.current = false;
    setOcrState(IDLE_STATE);
  }, []);

  const runOcr = useCallback(async (assetId: string, dataUrl: string): Promise<OcrResult | null> => {
    cancelledRef.current = false;

    setOcrState({
      status: 'processing', progress: 0.02,
      progressLabel: 'Preparing image…', result: null, error: null,
    });

    let prepared: PreparedImage | null = null;

    try {
      // ── 1. Downscale → Blob ───────────────────────────────────────────────
      prepared = await prepareImageForOcr(dataUrl);
      if (cancelledRef.current) { URL.revokeObjectURL(prepared.objectUrl); return null; }

      setOcrState(s => ({
        ...s,
        progress:      0.06,
        progressLabel: `Image ready (${prepared!.width}×${prepared!.height}, ${Math.round(prepared!.sizeBytes / 1024)}KB) — loading OCR…`,
      }));

      // ── 2. Get / create singleton worker ──────────────────────────────────
      const worker = await withTimeout(
        getOrCreateWorker((status, progress) => {
          if (cancelledRef.current) return;
          setOcrState(s => ({
            ...s,
            progress:      0.06 + progress * 0.30,
            progressLabel: friendlyLabel(status, progress),
          }));
        }),
        OCR_TIMEOUT_MS,
        'worker init',
      );

      if (cancelledRef.current) { URL.revokeObjectURL(prepared.objectUrl); return null; }

      setOcrState(s => ({ ...s, progress: 0.38, progressLabel: 'Engine ready — reading card…' }));

      // ── 3. Recognize ──────────────────────────────────────────────────────
      // Pass the object URL so Tesseract fetches the Blob — never sees base64
      const { data } = await withTimeout(
        worker.recognize(prepared.objectUrl),
        OCR_TIMEOUT_MS,
        `recognize ${prepared.width}×${prepared.height}`,
      );

      URL.revokeObjectURL(prepared.objectUrl);
      prepared = null;

      if (cancelledRef.current) return null;

      // ── 4. Heuristic parse ────────────────────────────────────────────────
      const rawText: string = data?.text ?? '';
      const parsed = parseBusinessCardText(rawText);

      const result: OcrResult = {
        assetId,
        rawText,
        fields:         parsed.fields,
        confidence:     parsed.confidence,
        inferredFields: parsed.inferredFields,
        ignoredLines:   parsed.ignoredLines,
        completedAt:    new Date().toISOString(),
      };

      setOcrState({ status: 'done', progress: 1, progressLabel: 'Done', result, error: null });
      return result;

    } catch (err) {
      if (prepared) { try { URL.revokeObjectURL(prepared.objectUrl); } catch { /* ignore */ } }
      if (cancelledRef.current) return null;

      const isTimeout = err instanceof Error && err.message.includes('timeout');
      const baseMsg   = err instanceof Error ? err.message : 'Unknown OCR error';
      const stack     = err instanceof Error ? (err.stack ?? '') : '';

      // Invalidate worker on timeout or WASM crash so next attempt reinits cleanly
      if (isTimeout || /wasm|WebAssembly/i.test(stack)) invalidateWorker();

      const displayMsg = isTimeout
        ? `OCR timed out after ${OCR_TIMEOUT_MS / 1000}s. Tap "Retry OCR" or fill in manually.`
        : `OCR failed: ${baseMsg}`;

      setOcrState({ status: 'error', progress: 0, progressLabel: '', result: null, error: displayMsg });

      console.error('[useOcr] OCR failed', {
        message: baseMsg, stack, isTimeout, assetId, workerAlive: !!workerSingleton,
      });

      return null;
    }
  }, []);

  return { ocrState, runOcr, cancelOcr, resetOcr };
}
