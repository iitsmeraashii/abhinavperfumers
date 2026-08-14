// Vision extraction hook — OpenAI Vision via Supabase Edge Function.
//
// Pipeline:
//   1. Preprocess image (resize, sharpen, JPEG) — iOS-safe canvas pipeline
//   2. Call extract-business-card edge function (secure, API key never in frontend)
//   3. Validate + normalize response
//   4. Tesseract fallback if vision fails
//   5. Return structured VisionResult with per-field confidence
//
// Design:
//   - Primary: OpenAI Vision via edge function
//   - Fallback: Tesseract OCR (existing useOcr pipeline)
//   - No API key ever touches the frontend

import { useState, useRef, useCallback } from 'react';
import type { VisionResult, VisionStatus, VisionExtractedFields, FieldConfidence, FieldConfidenceReport } from './types';
import { supabase } from '../supabaseClient';

// ─── Config ───────────────────────────────────────────────────────────────────

const MAX_IMAGE_PX     = 1600;
const JPEG_QUALITY     = 0.82;
const EDGE_FUNCTION    = 'extract-business-card';
const REQUEST_TIMEOUT  = 30_000;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface VisionState {
  status:        VisionStatus;
  progressLabel: string;
  progress:      number;
  result:        VisionResult | null;
  error:         string | null;
}

export interface UseVisionExtractionReturn {
  visionState:  VisionState;
  runExtraction: (assetId: string, dataUrl: string) => Promise<VisionResult | null>;
  cancelExtraction: () => void;
  resetExtraction: () => void;
}

const IDLE_STATE: VisionState = {
  status: 'idle', progressLabel: '', progress: 0, result: null, error: null,
};

// ─── iOS-safe image preprocessing ────────────────────────────────────────────
// dataUrl → Blob → objectURL → Image.onload → canvas.drawImage → toBlob
// NEVER uses createImageBitmap (unreliable on iOS Safari)

function dataUrlToBlob(dataUrl: string): Blob {
  const [header, b64] = dataUrl.split(',');
  const mime = header.match(/:(.*?);/)?.[1] ?? 'image/jpeg';
  const bytes = atob(b64);
  const arr = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

function loadImageFromBlob(blob: Blob): Promise<{ img: HTMLImageElement; url: string }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => resolve({ img, url });
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Image load failed')); };
    img.src = url;
  });
}

interface ProcessedImage {
  blob:   Blob;
  width:  number;
  height: number;
}

async function preprocessImage(dataUrl: string): Promise<ProcessedImage> {
  const sourceBlob = dataUrlToBlob(dataUrl);
  const { img, url } = await loadImageFromBlob(sourceBlob);

  const origW = img.naturalWidth;
  const origH = img.naturalHeight;
  URL.revokeObjectURL(url);

  if (!origW || !origH) throw new Error('Image has zero dimensions');

  const scale = Math.min(1, MAX_IMAGE_PX / Math.max(origW, origH));
  const w = Math.max(1, Math.round(origW * scale));
  const h = Math.max(1, Math.round(origH * scale));

  const canvas = document.createElement('canvas');
  canvas.width  = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D context unavailable');

  ctx.drawImage(img, 0, 0, w, h);

  // Subtle sharpening via convolution — improves OCR on slightly blurry cards
  try {
    const imageData = ctx.getImageData(0, 0, w, h);
    const data = imageData.data;
    const sharpenKernel = [0, -0.5, 0, -0.5, 3, -0.5, 0, -0.5, 0];
    const output = new Uint8ClampedArray(data.length);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = (y * w + x) * 4;
        for (let c = 0; c < 3; c++) {
          let sum = 0;
          for (let ky = -1; ky <= 1; ky++) {
            for (let kx = -1; kx <= 1; kx++) {
              const ni = ((y + ky) * w + (x + kx)) * 4 + c;
              sum += data[ni] * sharpenKernel[(ky + 1) * 3 + (kx + 1)];
            }
          }
          output[i + c] = Math.max(0, Math.min(255, sum));
        }
        output[i + 3] = data[i + 3]; // alpha unchanged
      }
    }
    // Copy border pixels unchanged
    for (let x = 0; x < w; x++) {
      for (let c = 0; c < 4; c++) {
        output[x * 4 + c] = data[x * 4 + c];
        output[((h - 1) * w + x) * 4 + c] = data[((h - 1) * w + x) * 4 + c];
      }
    }
    for (let y = 0; y < h; y++) {
      for (let c = 0; c < 4; c++) {
        output[(y * w) * 4 + c] = data[(y * w) * 4 + c];
        output[(y * w + w - 1) * 4 + c] = data[(y * w + w - 1) * 4 + c];
      }
    }
    ctx.putImageData(new ImageData(output, w, h), 0, 0);
  } catch {
    // Sharpening failed (e.g. cross-origin taint) — use unsharpened canvas
  }

  const blob = await new Promise<Blob | null>(res => {
    canvas.toBlob(res, 'image/jpeg', JPEG_QUALITY);
    canvas.width = 1; canvas.height = 1;
  });

  if (!blob) throw new Error('canvas.toBlob() returned null');
  return { blob, width: w, height: h };
}

// ─── Per-field confidence ─────────────────────────────────────────────────────

function deriveFieldConfidence(
  fields: VisionExtractedFields,
): Record<Exclude<keyof VisionExtractedFields, 'fieldConfidence'>, FieldConfidence> {
  const overall = fields.confidence;

  function grade(value: string | string[], weight = 1): FieldConfidence {
    const present = Array.isArray(value) ? value.length > 0 : value.trim().length > 0;
    if (!present) return 'unknown';
    const score = overall * weight;
    if (score >= 0.75) return 'high';
    if (score >= 0.45) return 'medium';
    return 'low';
  }

  return {
    fullName:     grade(fields.fullName, 1.1),
    firstName:    grade(fields.firstName),
    lastName:     grade(fields.lastName),
    company:      grade(fields.company, 1.05),
    designation:  grade(fields.designation),
    emails:       grade(fields.emails),
    phoneNumbers: grade(fields.phoneNumbers, 1.05),
    website:      grade(fields.website, 0.9),
    address:      grade(fields.address, 0.85),
    confidence:   overall >= 0.75 ? 'high' : overall >= 0.45 ? 'medium' : 'low',
    notes:        grade(fields.notes, 0.8),
    rawText:      grade(fields.rawText),
  };
}

// ─── Timeout helper ───────────────────────────────────────────────────────────

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Request timed out after ${ms / 1000}s`)), ms);
    p.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
  });
}

// ─── Edge function call ───────────────────────────────────────────────────────

interface EdgeResponse {
  success:    boolean;
  data?:      VisionExtractedFields;
  durationMs: number;
  attempt:    number;
  error?:     string;
}

async function callEdgeFunction(imageBlob: Blob): Promise<EdgeResponse> {
  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token;
  if (!token) throw new Error('Not authenticated');

  const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/${EDGE_FUNCTION}`;

  const form = new FormData();
  form.append('image', imageBlob, 'card.jpg');

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Apikey': import.meta.env.VITE_SUPABASE_ANON_KEY,
    },
    body: form,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Edge function error ${response.status}: ${text.slice(0, 200)}`);
  }

  return response.json();
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useVisionExtraction(): UseVisionExtractionReturn {
  const [visionState, setVisionState] = useState<VisionState>(IDLE_STATE);
  const cancelledRef = useRef(false);

  const cancelExtraction = useCallback(() => {
    cancelledRef.current = true;
    setVisionState(IDLE_STATE);
  }, []);

  const resetExtraction = useCallback(() => {
    cancelledRef.current = false;
    setVisionState(IDLE_STATE);
  }, []);

  const runExtraction = useCallback(async (
    assetId: string,
    dataUrl: string,
  ): Promise<VisionResult | null> => {
    cancelledRef.current = false;
    const startMs = Date.now();

    setVisionState({
      status: 'preprocessing',
      progress: 0.05,
      progressLabel: 'Preparing image…',
      result: null, error: null,
    });

    try {
      // ── 1. Preprocess ──────────────────────────────────────────────────────
      const processed = await preprocessImage(dataUrl);
      if (cancelledRef.current) return null;

      setVisionState(s => ({
        ...s,
        status: 'extracting',
        progress: 0.20,
        progressLabel: 'Reading business card…',
      }));

      // ── 2. Call edge function (OpenAI Vision) ──────────────────────────────
      let edgeResponse: EdgeResponse;
      let source: VisionResult['source'] = 'openai_vision';

      try {
        edgeResponse = await withTimeout(callEdgeFunction(processed.blob), REQUEST_TIMEOUT);
        // DIAGNOSTIC — temporary, unconditional. Shows the raw parsed edge-function response.
        console.log('[EXTRACTION_RESPONSE_RAW_OBJECT]', edgeResponse.data);
        console.log('[EXTRACTION_RESPONSE_RAW_JSON]', JSON.stringify(edgeResponse.data, null, 2));
        console.log('[EXTRACTION_FIELD_CONFIDENCE]', {
          overallConfidence: edgeResponse.data?.confidence,
          fieldConfidence: edgeResponse.data?.fieldConfidence,
          phoneNumbers: edgeResponse.data?.phoneNumbers,
          emails: edgeResponse.data?.emails,
        });
        if (!edgeResponse.success || !edgeResponse.data) {
          throw new Error(edgeResponse.error ?? 'Extraction returned no data');
        }
      } catch (visionErr) {
        if (cancelledRef.current) return null;
        console.warn('[useVisionExtraction] OpenAI Vision failed, falling back to Tesseract:', visionErr);

        // ── 3. Tesseract fallback ──────────────────────────────────────────
        setVisionState(s => ({
          ...s,
          status: 'extracting',
          progress: 0.35,
          progressLabel: 'Vision unavailable — using OCR fallback…',
        }));

        const fallbackResult = await runTesseractFallback(assetId, dataUrl);
        if (cancelledRef.current) return null;

        const result: VisionResult = {
          assetId,
          fields:          fallbackResult,
          source:          'tesseract_fallback',
          durationMs:      Date.now() - startMs,
          attempt:         1,
          completedAt:     new Date().toISOString(),
          fieldConfidence: deriveFieldConfidence(fallbackResult),
        };

        setVisionState({ status: 'done', progress: 1, progressLabel: 'Extracted (OCR fallback)', result, error: null });
        return result;
      }

      if (cancelledRef.current) return null;

      setVisionState(s => ({
        ...s,
        status: 'validating',
        progress: 0.85,
        progressLabel: 'Validating contact info…',
      }));

      // ── 4. Build result ────────────────────────────────────────────────────
      const fields = edgeResponse.data!;
      const modelFieldConfidence = fields.fieldConfidence;
      const hasModelFieldConfidence =
        modelFieldConfidence != null &&
        typeof modelFieldConfidence === 'object' &&
        Object.keys(modelFieldConfidence).length > 0;
      const result: VisionResult = {
        assetId,
        fields,
        source,
        durationMs:      edgeResponse.durationMs ?? Date.now() - startMs,
        attempt:         edgeResponse.attempt ?? 1,
        completedAt:     new Date().toISOString(),
        fieldConfidence: hasModelFieldConfidence
          ? modelFieldConfidence as FieldConfidenceReport
          : deriveFieldConfidence(fields),
      };

      setVisionState({ status: 'done', progress: 1, progressLabel: 'Extracted successfully', result, error: null });
      return result;

    } catch (err) {
      if (cancelledRef.current) return null;
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[useVisionExtraction] extraction failed:', msg);
      setVisionState({ status: 'error', progress: 0, progressLabel: '', result: null, error: msg });
      return null;
    }
  }, []);

  return { visionState, runExtraction, cancelExtraction, resetExtraction };
}

// ─── Tesseract fallback ───────────────────────────────────────────────────────
// Minimal adapter — reuses existing Tesseract worker singleton, maps result
// to VisionExtractedFields shape so the rest of the pipeline is uniform.

async function runTesseractFallback(assetId: string, dataUrl: string): Promise<VisionExtractedFields> {
  // Dynamic import keeps Tesseract out of the main bundle when not needed
  const { useOcr: _unused, ...ocrModule } = await import('./useOcr');
  void _unused; void ocrModule;

  // Direct worker usage (bypasses React hook lifecycle)
  const { default: runOcrDirect } = await import('./ocrFallback');
  const rawText = await runOcrDirect(dataUrl);

  const { parseBusinessCardText } = await import('./parseBusinessCard');
  const parsed = parseBusinessCardText(rawText);

  const f = parsed.fields;
  return {
    fullName:     String(f.clientName ?? ''),
    firstName:    String(f.clientName ?? '').split(' ')[0] ?? '',
    lastName:     String(f.clientName ?? '').split(' ').slice(1).join(' '),
    company:      String(f.company ?? ''),
    designation:  String(f.designation ?? ''),
    emails:       f.email ? [String(f.email)] : [],
    phoneNumbers: f.phone ? [String(f.phone)] : [],
    website:      '',
    address:      '',
    confidence:   parsed.confidence === 'high' ? 0.7 : parsed.confidence === 'medium' ? 0.45 : 0.2,
    notes:        '',
    rawText,
  };
}
