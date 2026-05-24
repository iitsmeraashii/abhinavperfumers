// OCR hook — Tesseract.js loaded from CDN, singleton worker, mobile-Safari hardened.
//
// Key design decisions:
//   - Worker is created ONCE globally and reused across scans (avoids WASM reload cost)
//   - Images are downscaled to ≤600px BEFORE OCR (Safari WASM heap limit protection)
//   - OCR receives a Blob, NOT a base64 string (avoids 30-50% memory overhead)
//   - Hard 15-second timeout races the Tesseract promise
//   - All canvas/URL/bitmap references are revoked on completion or error

import { useState, useRef, useCallback } from 'react';
import { parseBusinessCardText } from './parseBusinessCard';
import type { OcrResult, OcrStatus } from './types';

// ─── Config ───────────────────────────────────────────────────────────────────

// 600px max dimension — stays well under Safari's WASM memory pressure threshold
const OCR_MAX_PX = 600;
const OCR_JPEG_QUALITY = 0.6;
const OCR_TIMEOUT_MS = 15_000;
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

// ─── Singleton worker ─────────────────────────────────────────────────────────
// One worker instance per browser tab lifetime. Creating a new Tesseract worker
// on every scan re-initialises the WASM module, which on mobile Safari can exceed
// the per-tab memory limit before the first recognize() call even executes.

let workerSingleton: unknown = null;
let workerInitPromise: Promise<unknown> | null = null;

async function getOrCreateWorker(
  progressCb: (status: string, progress: number) => void,
): Promise<unknown> {
  // If we already have a healthy worker, return it
  if (workerSingleton) return workerSingleton;

  // If initialisation is in flight, wait for it
  if (workerInitPromise) return workerInitPromise;

  workerInitPromise = (async () => {
    await loadTesseractCdn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const Tesseract = (window as any).Tesseract;
    if (!Tesseract?.createWorker) throw new Error('Tesseract not available after CDN load');

    const worker = await Tesseract.createWorker('eng', 1, {
      logger: (m: { status: string; progress: number }) => {
        if (m.status && typeof m.progress === 'number') {
          progressCb(m.status, m.progress);
        }
      },
    });

    workerSingleton = worker;
    return worker;
  })();

  try {
    const w = await workerInitPromise;
    return w;
  } catch (err) {
    // Reset so next call can retry from scratch
    workerInitPromise = null;
    workerSingleton = null;
    throw err;
  }
}

// Called when a worker crashes or behaves unexpectedly — force re-init next time
function invalidateWorker() {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (workerSingleton as any)?.terminate?.();
  } catch { /* ignore */ }
  workerSingleton = null;
  workerInitPromise = null;
}

// ─── CDN loader ───────────────────────────────────────────────────────────────

let cdnLoadPromise: Promise<void> | null = null;

function loadTesseractCdn(): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (typeof window !== 'undefined' && (window as any).Tesseract) return Promise.resolve();
  if (cdnLoadPromise) return cdnLoadPromise;

  cdnLoadPromise = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector(`script[src="${TESSERACT_CDN}"]`);
    if (existing) {
      existing.addEventListener('load', () => resolve());
      existing.addEventListener('error', () => reject(new Error('Tesseract CDN script failed to load')));
      return;
    }
    const script = document.createElement('script');
    script.src = TESSERACT_CDN;
    script.async = true;
    script.onload  = () => resolve();
    script.onerror = () => reject(new Error('Failed to load OCR engine. Check your internet connection.'));
    document.head.appendChild(script);
  });

  return cdnLoadPromise;
}

// ─── Image preparation ────────────────────────────────────────────────────────
// Returns a Blob (JPEG, quality 0.6) at ≤600px.
// Using Blob avoids the ~33% base64 overhead and reduces Safari's heap pressure.

interface PreparedImage {
  blob: Blob;
  width: number;
  height: number;
  originalWidth: number;
  originalHeight: number;
  objectUrl: string;  // caller must revoke after use
}

async function prepareImageForOcr(dataUrl: string): Promise<PreparedImage> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const { naturalWidth: origW, naturalHeight: origH } = img;
      const scale = Math.min(1, OCR_MAX_PX / Math.max(origW, origH));
      const w = Math.max(1, Math.round(origW * scale));
      const h = Math.max(1, Math.round(origH * scale));

      const canvas = document.createElement('canvas');
      canvas.width  = w;
      canvas.height = h;

      const ctx = canvas.getContext('2d');
      if (!ctx) {
        reject(new Error('Canvas 2D context unavailable'));
        return;
      }

      ctx.drawImage(img, 0, 0, w, h);

      canvas.toBlob(
        (blob) => {
          // Immediately nullify canvas to release backing store memory
          canvas.width  = 1;
          canvas.height = 1;

          if (!blob) {
            reject(new Error('canvas.toBlob() returned null — image may be too large'));
            return;
          }

          const objectUrl = URL.createObjectURL(blob);
          resolve({ blob, width: w, height: h, originalWidth: origW, originalHeight: origH, objectUrl });
        },
        'image/jpeg',
        OCR_JPEG_QUALITY,
      );
    };
    img.onerror = () => reject(new Error('Failed to load image for OCR preparation'));
    img.src = dataUrl;
  });
}

// ─── Timeout race ─────────────────────────────────────────────────────────────

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`OCR timeout after ${ms / 1000}s (${label})`)),
      ms,
    );
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

// ─── Progress label ───────────────────────────────────────────────────────────

function friendlyLabel(status: string, pct: number): string {
  if (status.includes('load') || status.includes('init'))  return 'Loading OCR engine…';
  if (status.includes('recogni')) return `Reading card… ${Math.round(pct * 100)}%`;
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
      status: 'processing',
      progress: 0.01,
      progressLabel: 'Preparing image…',
      result: null,
      error: null,
    });

    let prepared: PreparedImage | null = null;

    try {
      // ── Step 1: Downscale to Blob ────────────────────────────────────────
      prepared = await prepareImageForOcr(dataUrl);
      if (cancelledRef.current) {
        URL.revokeObjectURL(prepared.objectUrl);
        return null;
      }

      setOcrState(s => ({
        ...s,
        progress: 0.05,
        progressLabel: `Image ready (${prepared!.width}×${prepared!.height}) — loading OCR…`,
      }));

      // ── Step 2: Get/create singleton worker ──────────────────────────────
      const worker = await withTimeout(
        getOrCreateWorker((status, progress) => {
          if (cancelledRef.current) return;
          setOcrState(s => ({
            ...s,
            progress: 0.05 + progress * 0.25,
            progressLabel: friendlyLabel(status, progress),
          }));
        }),
        OCR_TIMEOUT_MS,
        'worker init',
      );

      if (cancelledRef.current) {
        URL.revokeObjectURL(prepared.objectUrl);
        return null;
      }

      setOcrState(s => ({ ...s, progress: 0.30, progressLabel: 'Engine ready — reading card…' }));

      // ── Step 3: Recognize from object URL (Blob reference, not base64) ──
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const recognizePromise = (worker as any).recognize(prepared.objectUrl);

      const { data } = await withTimeout(
        recognizePromise,
        OCR_TIMEOUT_MS,
        `recognize ${prepared.width}×${prepared.height}`,
      );

      // Revoke the object URL immediately after recognize() completes
      URL.revokeObjectURL(prepared.objectUrl);
      prepared = null;

      if (cancelledRef.current) return null;

      const rawText: string = data?.text ?? '';

      // ── Step 4: Heuristic parsing ────────────────────────────────────────
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
      // Revoke object URL if we bailed out mid-flow
      if (prepared) {
        try { URL.revokeObjectURL(prepared.objectUrl); } catch { /* ignore */ }
        prepared = null;
      }

      if (cancelledRef.current) return null;

      // Build a rich error message with context for the debug panel
      const isTimeout = err instanceof Error && err.message.includes('timeout');
      const baseMsg   = err instanceof Error ? err.message : 'Unknown OCR error';
      const stack     = err instanceof Error ? (err.stack ?? '') : '';

      // If the worker might be in a bad state (e.g. WASM crash), invalidate it
      // so the next attempt re-initialises cleanly.
      if (isTimeout || stack.includes('wasm') || stack.includes('WebAssembly')) {
        invalidateWorker();
      }

      const displayMsg = isTimeout
        ? `OCR timed out after ${OCR_TIMEOUT_MS / 1000}s. Tap "Retry OCR" or fill in manually.`
        : `OCR failed: ${baseMsg}`;

      setOcrState({
        status: 'error',
        progress: 0,
        progressLabel: '',
        result: null,
        error: displayMsg,
      });

      // Log to console so it appears in the mobile Safari Web Inspector
      console.error('[useOcr] OCR failed', {
        message: baseMsg,
        stack,
        isTimeout,
        assetId,
        workerAlive: !!workerSingleton,
      });

      return null;
    }
  }, []);

  return { ocrState, runOcr, cancelOcr, resetOcr };
}
