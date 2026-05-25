// OCR hook — tesseract.js v7, singleton worker, mobile-Safari hardened.
//
// Uses a dynamic import of the local ESM bundle (served from /public) to avoid
// Vite CJS resolution issues with the tesseract.js npm package in dev mode.
//
// Key design decisions:
//   - Worker created ONCE globally — avoids reloading 10MB WASM on every scan
//   - iOS-safe pipeline: dataUrl → Blob → objectURL → Image → canvas → Blob → objectURL
//   - NEVER uses createImageBitmap (unsupported/unreliable on iOS Safari)
//   - Pixel validation before OCR: aborts early if canvas is blank/transparent
//   - Fallback: if processed image yields empty text, retries with original image
//   - Hard 15-second timeout on worker init and recognize()
//   - Object URLs revoked only AFTER OCR completes (not before)

import { useState, useRef, useCallback } from 'react';
import { parseBusinessCardText } from './parseBusinessCard';
import type { OcrResult, OcrStatus } from './types';

// ─── Config ───────────────────────────────────────────────────────────────────

const OCR_MAX_PX       = 600;
const OCR_JPEG_QUALITY = 0.6;
const OCR_TIMEOUT_MS   = 15_000;

// ESM bundle and worker served as static assets from /public (copied from node_modules).
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

export interface OcrPipelineDiagnostics {
  // Original image (stored dataUrl)
  originalDataUrlLength:  number;
  originalMimeType:       string;
  originalNaturalWidth:   number;
  originalNaturalHeight:  number;
  originalImageLoaded:    boolean;
  // Processed image (after canvas resize)
  processedWidth:         number;
  processedHeight:        number;
  processedSizeBytes:     number;
  processedMimeType:      string;
  processingStage:        string;
  // Canvas state
  canvasContextOk:        boolean;
  drawImageOk:            boolean;
  toBlobOk:               boolean;
  // Pixel validation
  pixelSampleRgba:        number[];
  nonZeroPixelCount:      number;
  totalPixelsChecked:     number;
  canvasIsBlank:          boolean;
  // OCR source
  ocrInputObjectUrl:      string;
  ocrInputSource:         'processed' | 'original_fallback';
  // Fallback info
  fallbackTriggered:      boolean;
  fallbackReason:         string;
  // Object URLs (for preview rendering)
  originalObjectUrl:      string | null;
  processedObjectUrl:     string | null;
}

export interface UseOcrReturn {
  ocrState:    OcrState;
  runOcr:      (assetId: string, dataUrl: string) => Promise<OcrResult | null>;
  cancelOcr:   () => void;
  resetOcr:    () => void;
  diagnostics: OcrPipelineDiagnostics | null;
}

const IDLE_STATE: OcrState = {
  status:        'idle',
  progress:      0,
  progressLabel: '',
  result:        null,
  error:         null,
};

// ─── Singleton worker ─────────────────────────────────────────────────────────

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
    const mod = await import(/* @vite-ignore */ TESSERACT_ESM_URL);
    const createWorker = mod.createWorker ?? mod.default?.createWorker;
    if (typeof createWorker !== 'function') {
      throw new Error('tesseract.js ESM bundle did not export createWorker');
    }

    const worker = await createWorker('eng', 1 /* OEM.LSTM_ONLY */, {
      workerPath: TESSERACT_WORKER_URL,
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

// ─── Safe image loader (iOS Safari hardened) ──────────────────────────────────
// Loads a Blob or dataUrl into an HTMLImageElement and waits for full load.
// NEVER uses createImageBitmap — unsupported/unreliable on iOS WebKit.

function loadImageFromBlob(blob: Blob): Promise<{ img: HTMLImageElement; url: string }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => resolve({ img, url });
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Failed to load image from Blob'));
    };
    img.src = url;
  });
}

function dataUrlToBlob(dataUrl: string): Blob {
  const [header, b64] = dataUrl.split(',');
  const mime = header.match(/:(.*?);/)?.[1] ?? 'image/jpeg';
  const bytes = atob(b64);
  const arr = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

// ─── Image preparation with full diagnostics ──────────────────────────────────
// iOS-safe pipeline:
//   dataUrl → Blob → objectURL → HTMLImageElement.onload → canvas.drawImage
//   → pixel validation → canvas.toBlob → objectURL for Tesseract

interface PreparedImage {
  objectUrl:      string;   // passed to Tesseract — revoke AFTER OCR
  width:          number;
  height:         number;
  originalWidth:  number;
  originalHeight: number;
  sizeBytes:      number;
  diagnostics:    Partial<OcrPipelineDiagnostics>;
}

async function prepareImageForOcr(dataUrl: string): Promise<PreparedImage> {
  const diag: Partial<OcrPipelineDiagnostics> = {
    originalDataUrlLength: dataUrl.length,
    originalMimeType:      dataUrl.split(';')[0]?.split(':')[1] ?? 'unknown',
    processingStage:       'init',
    fallbackTriggered:     false,
    fallbackReason:        '',
    originalObjectUrl:     null,
    processedObjectUrl:    null,
  };

  // ── Step 1: dataUrl → Blob ─────────────────────────────────────────────────
  diag.processingStage = 'dataUrl→Blob';
  const originalBlob = dataUrlToBlob(dataUrl);

  // ── Step 2: Blob → objectURL → HTMLImageElement (iOS safe) ────────────────
  diag.processingStage = 'Blob→Image';
  const { img: originalImg, url: originalObjectUrl } = await loadImageFromBlob(originalBlob);
  diag.originalObjectUrl    = originalObjectUrl;
  diag.originalNaturalWidth  = originalImg.naturalWidth;
  diag.originalNaturalHeight = originalImg.naturalHeight;
  diag.originalImageLoaded   = originalImg.complete && originalImg.naturalWidth > 0;

  if (!diag.originalImageLoaded || !originalImg.naturalWidth || !originalImg.naturalHeight) {
    URL.revokeObjectURL(originalObjectUrl);
    throw new Error(
      `Image loaded but has zero dimensions (${originalImg.naturalWidth}×${originalImg.naturalHeight}). ` +
      'Possible blank/corrupt image.',
    );
  }

  const origW = originalImg.naturalWidth;
  const origH = originalImg.naturalHeight;

  // ── Step 3: Downscale on canvas ────────────────────────────────────────────
  diag.processingStage = 'canvas→drawImage';
  const scale = Math.min(1, OCR_MAX_PX / Math.max(origW, origH, 1));
  const w     = Math.max(1, Math.round(origW * scale));
  const h     = Math.max(1, Math.round(origH * scale));

  const canvas = document.createElement('canvas');
  canvas.width  = w;
  canvas.height = h;

  const ctx = canvas.getContext('2d');
  diag.canvasContextOk = !!ctx;
  if (!ctx) {
    URL.revokeObjectURL(originalObjectUrl);
    throw new Error('Canvas 2D context unavailable — possible iOS memory pressure');
  }

  // drawImage: image MUST be fully loaded before this call.
  // We use onload via loadImageFromBlob, so this is guaranteed.
  ctx.drawImage(originalImg, 0, 0, w, h);
  diag.drawImageOk      = true;
  diag.processedWidth   = w;
  diag.processedHeight  = h;

  // ── Step 4: Pixel validation ───────────────────────────────────────────────
  // Sample top-left 10×10 region to check canvas isn't blank/transparent
  diag.processingStage = 'pixel→validation';
  const sampleW = Math.min(w, 10);
  const sampleH = Math.min(h, 10);
  const imageData = ctx.getImageData(0, 0, sampleW, sampleH);
  const pixels    = imageData.data; // RGBA flat array

  const samplePixels: number[] = [];
  let nonZero = 0;
  for (let i = 0; i < pixels.length; i++) {
    if (i < 20) samplePixels.push(pixels[i]);
    if (pixels[i] !== 0) nonZero++;
  }

  diag.pixelSampleRgba       = samplePixels;
  diag.nonZeroPixelCount     = nonZero;
  diag.totalPixelsChecked    = pixels.length;
  diag.canvasIsBlank         = nonZero === 0;

  console.log('[useOcr] pixel validation', {
    canvasSize: `${w}×${h}`,
    nonZeroPixels: nonZero,
    totalPixels: pixels.length,
    blank: nonZero === 0,
    first20rgba: samplePixels,
  });

  if (diag.canvasIsBlank) {
    // Canvas is entirely blank — drawImage produced nothing
    // Possible iOS memory eviction or canvas taint — use original blob directly
    console.warn('[useOcr] canvas is blank after drawImage — falling back to original blob for OCR');
    URL.revokeObjectURL(originalObjectUrl);
    // Don't call toBlob on the blank canvas — just use the original
    diag.fallbackTriggered = true;
    diag.fallbackReason    = 'canvas blank after drawImage (all pixels zero)';
    diag.ocrInputSource    = 'original_fallback';
    diag.processedObjectUrl = null;

    // Re-open original blob as objectURL for Tesseract
    const fallbackUrl = URL.createObjectURL(originalBlob);
    diag.ocrInputObjectUrl = fallbackUrl;

    return {
      objectUrl:      fallbackUrl,
      width:          origW,
      height:         origH,
      originalWidth:  origW,
      originalHeight: origH,
      sizeBytes:      originalBlob.size,
      diagnostics:    diag,
    };
  }

  // ── Step 5: canvas → Blob (for Tesseract) ─────────────────────────────────
  diag.processingStage = 'canvas→Blob';

  const processedBlob = await new Promise<Blob | null>((res) => {
    // Release canvas backing store after toBlob starts — reduces peak memory
    canvas.toBlob((b) => {
      canvas.width  = 1;
      canvas.height = 1;
      res(b);
    }, 'image/jpeg', OCR_JPEG_QUALITY);
  });

  diag.toBlobOk = !!processedBlob;

  if (!processedBlob) {
    // toBlob returned null — fall back to original
    URL.revokeObjectURL(originalObjectUrl);
    console.warn('[useOcr] canvas.toBlob returned null — falling back to original blob');
    diag.fallbackTriggered  = true;
    diag.fallbackReason     = 'canvas.toBlob() returned null';
    diag.ocrInputSource     = 'original_fallback';
    diag.processedObjectUrl = null;

    const fallbackUrl = URL.createObjectURL(originalBlob);
    diag.ocrInputObjectUrl = fallbackUrl;

    return {
      objectUrl:      fallbackUrl,
      width:          origW,
      height:         origH,
      originalWidth:  origW,
      originalHeight: origH,
      sizeBytes:      originalBlob.size,
      diagnostics:    diag,
    };
  }

  diag.processedSizeBytes = processedBlob.size;
  diag.processedMimeType  = processedBlob.type;
  diag.processingStage    = 'done';
  diag.ocrInputSource     = 'processed';

  // Create objectURL for Tesseract — MUST NOT revoke until after OCR
  const processedObjectUrl = URL.createObjectURL(processedBlob);
  diag.processedObjectUrl = processedObjectUrl;
  diag.ocrInputObjectUrl  = processedObjectUrl;

  // Clean up original object URL — no longer needed
  URL.revokeObjectURL(originalObjectUrl);
  diag.originalObjectUrl = null;

  return {
    objectUrl:      processedObjectUrl,
    width:          w,
    height:         h,
    originalWidth:  origW,
    originalHeight: origH,
    sizeBytes:      processedBlob.size,
    diagnostics:    diag,
  };
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
  const [ocrState,    setOcrState]    = useState<OcrState>(IDLE_STATE);
  const [diagnostics, setDiagnostics] = useState<OcrPipelineDiagnostics | null>(null);
  const cancelledRef = useRef(false);

  const cancelOcr = useCallback(() => {
    cancelledRef.current = true;
    setOcrState(IDLE_STATE);
  }, []);

  const resetOcr = useCallback(() => {
    cancelledRef.current = false;
    setOcrState(IDLE_STATE);
    setDiagnostics(null);
  }, []);

  const runOcr = useCallback(async (assetId: string, dataUrl: string): Promise<OcrResult | null> => {
    cancelledRef.current = false;

    setOcrState({
      status: 'processing', progress: 0.02,
      progressLabel: 'Preparing image…', result: null, error: null,
    });
    setDiagnostics(null);

    let prepared: PreparedImage | null = null;

    try {
      // ── 1. Prepare image with full diagnostics ────────────────────────────
      prepared = await prepareImageForOcr(dataUrl);

      const fullDiag = prepared.diagnostics as OcrPipelineDiagnostics;
      setDiagnostics(fullDiag);

      console.log('[useOcr] image pipeline diagnostics', {
        originalSize:     dataUrl.length,
        originalMime:     fullDiag.originalMimeType,
        originalDims:     `${fullDiag.originalNaturalWidth}×${fullDiag.originalNaturalHeight}`,
        processedDims:    `${prepared.width}×${prepared.height}`,
        processedBytes:   prepared.sizeBytes,
        canvasBlank:      fullDiag.canvasIsBlank,
        toBlobOk:         fullDiag.toBlobOk,
        drawImageOk:      fullDiag.drawImageOk,
        fallback:         fullDiag.fallbackTriggered,
        fallbackReason:   fullDiag.fallbackReason,
        ocrSource:        fullDiag.ocrInputSource,
        pixelSample:      fullDiag.pixelSampleRgba,
        nonZeroPixels:    fullDiag.nonZeroPixelCount,
      });

      if (cancelledRef.current) { URL.revokeObjectURL(prepared.objectUrl); return null; }

      setOcrState(s => ({
        ...s,
        progress:      0.06,
        progressLabel: `Image ready (${prepared!.width}×${prepared!.height}, ${Math.round(prepared!.sizeBytes / 1024)}KB)${fullDiag.fallbackTriggered ? ' [original fallback]' : ''} — loading OCR…`,
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

      // ── 3. Recognize — pass objectURL so Tesseract fetches the Blob ───────
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const recognizeResult = await withTimeout<any>(
        worker.recognize(prepared.objectUrl),
        OCR_TIMEOUT_MS,
        `recognize ${prepared.width}×${prepared.height}`,
      );
      const { data } = recognizeResult;

      // Revoke only AFTER Tesseract is done
      URL.revokeObjectURL(prepared.objectUrl);
      prepared = null;

      if (cancelledRef.current) return null;

      const rawText: string = data?.text ?? '';

      console.log('[useOcr] OCR result', {
        rawTextLength: rawText.length,
        rawTextPreview: rawText.slice(0, 200),
        source: fullDiag.ocrInputSource,
      });

      // ── 4. Fallback: if processed image returned empty, try original ───────
      let finalRawText = rawText;

      if (!rawText.trim() && !fullDiag.fallbackTriggered) {
        // Processed image yielded nothing — retry with original dataUrl
        console.warn('[useOcr] processed image OCR returned empty text — retrying with original blob');
        setOcrState(s => ({ ...s, progressLabel: 'Retrying with original image…' }));

        try {
          const originalBlob    = dataUrlToBlob(dataUrl);
          const originalObjUrl  = URL.createObjectURL(originalBlob);

          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const fallbackResult = await withTimeout<any>(
            worker.recognize(originalObjUrl),
            OCR_TIMEOUT_MS,
            'recognize original fallback',
          );
          URL.revokeObjectURL(originalObjUrl);

          const fallbackText: string = fallbackResult?.data?.text ?? '';
          console.log('[useOcr] original blob OCR result', {
            rawTextLength: fallbackText.length,
            rawTextPreview: fallbackText.slice(0, 200),
          });

          if (fallbackText.trim()) {
            finalRawText = fallbackText;
            setDiagnostics(prev => prev ? {
              ...prev,
              fallbackTriggered: true,
              fallbackReason:    'processed image OCR returned empty text',
              ocrInputSource:    'original_fallback',
            } : prev);
          }
        } catch (fallbackErr) {
          console.warn('[useOcr] original blob OCR fallback also failed', fallbackErr);
        }
      }

      // ── 5. Heuristic parse ────────────────────────────────────────────────
      const parsed = parseBusinessCardText(finalRawText);

      const result: OcrResult = {
        assetId,
        rawText:        finalRawText,
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

  return { ocrState, runOcr, cancelOcr, resetOcr, diagnostics };
}
