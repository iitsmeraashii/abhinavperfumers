// Extraction service — reuses the existing OpenAI Vision edge function and
// Tesseract OCR fallback without duplicating logic.  Extracted from
// useVisionExtraction.ts as standalone (non-hook) functions so the ALPE
// pipeline can call them without a React component context.
//
// The functions below are lifted verbatim from useVisionExtraction.ts and
// ocrFallback.ts — same constants, same flow, same edge function contract.

import { supabase } from '../supabaseClient';
import type { VisionExtractedFields, VisionResult } from '../capture/types';
import type { ResolvedEvidence } from './evidenceResolver';

// ─── Config (mirrors useVisionExtraction.ts) ─────────────────────────────────

const MAX_IMAGE_PX    = 1600;
const JPEG_QUALITY    = 0.82;
const EDGE_FUNCTION   = 'extract-business-card';
const REQUEST_TIMEOUT = 30_000;

// ─── iOS-safe image preprocessing (from useVisionExtraction.ts) ──────────────

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

async function preprocessImage(dataUrl: string): Promise<Blob> {
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
        output[i + 3] = data[i + 3];
      }
    }
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
    // Sharpening failed — use unsharpened canvas
  }

  const blob = await new Promise<Blob | null>(res => {
    canvas.toBlob(res, 'image/jpeg', JPEG_QUALITY);
    canvas.width = 1; canvas.height = 1;
  });

  if (!blob) throw new Error('canvas.toBlob() returned null');
  return blob;
}

// ─── Edge function call (from useVisionExtraction.ts) ────────────────────────

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

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Request timed out after ${ms / 1000}s`)), ms);
    p.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
  });
}

// ─── Tesseract fallback (from useVisionExtraction.ts → ocrFallback.ts) ────────

async function runTesseractFallback(dataUrl: string): Promise<VisionExtractedFields> {
  const { default: runOcr } = await import('../capture/ocrFallback');
  const rawText = await runOcr(dataUrl);

  const { parseBusinessCardText } = await import('../capture/parseBusinessCard');
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

// ─── Public extraction API ────────────────────────────────────────────────────

export interface ExtractionOutcome {
  source:     VisionResult['source'];
  confidence: number;
  fields:     VisionExtractedFields | null;
  error:      string | null;
}

/**
 * Extract contact data from a resolved business card image.
 *
 * Flow mirrors useVisionExtraction.runExtraction exactly:
 *   1. Fetch image from resolved URL → dataUrl
 *   2. Preprocess (resize, sharpen, JPEG)
 *   3. Call OpenAI Vision edge function
 *   4. Fall back to Tesseract OCR if vision fails
 *   5. Return normalized VisionExtractedFields
 */
export async function extractBusinessCard(
  resolved: ResolvedEvidence,
): Promise<ExtractionOutcome> {
  if (resolved.status !== 'resolved' || !resolved.url) {
    return { source: 'manual', confidence: 0, fields: null, error: resolved.error ?? `Asset not resolved (status: ${resolved.status})` };
  }

  try {
    // Fetch image from signed URL → dataUrl for preprocessing
    const response = await fetch(resolved.url);
    if (!response.ok) throw new Error(`Fetch image failed: ${response.status}`);
    const blob = await response.blob();
    const dataUrl = await blobToDataUrl(blob);

    // Preprocess
    const processedBlob = await preprocessImage(dataUrl);

    // Call edge function (OpenAI Vision)
    try {
      const edgeResponse = await withTimeout(callEdgeFunction(processedBlob), REQUEST_TIMEOUT);
      if (!edgeResponse.success || !edgeResponse.data) {
        throw new Error(edgeResponse.error ?? 'Extraction returned no data');
      }
      return {
        source:     'openai_vision',
        confidence: edgeResponse.data.confidence,
        fields:     edgeResponse.data,
        error:      null,
      };
    } catch (visionErr) {
      console.warn('[extractionService] OpenAI Vision failed, falling back to Tesseract:', visionErr);
      const fallbackFields = await runTesseractFallback(dataUrl);
      return {
        source:     'tesseract_fallback',
        confidence: fallbackFields.confidence,
        fields:     fallbackFields,
        error:      null,
      };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[extractionService] extraction failed:', msg);
    return { source: 'manual', confidence: 0, fields: null, error: msg };
  }
}

/**
 * Extract contact data from a QR code payload.
 * Reuses parseQrPayload — the same parser used by the capture UI.
 */
export async function extractQr(
  resolved: ResolvedEvidence,
): Promise<ExtractionOutcome> {
  if (resolved.status !== 'resolved' || !resolved.url) {
    return { source: 'manual', confidence: 0, fields: null, error: resolved.error ?? `Asset not resolved (status: ${resolved.status})` };
  }

  try {
    // Fetch QR text from the resolved URL
    const response = await fetch(resolved.url);
    if (!response.ok) throw new Error(`Fetch QR failed: ${response.status}`);
    const rawText = await response.text();

    const { parseQrPayload } = await import('../capture/parseQrPayload');
    const parsed = parseQrPayload(rawText);

    const f = parsed.fields;
    const confidence = parsed.confidence === 'high' ? 0.9 : parsed.confidence === 'medium' ? 0.6 : 0.3;

    const fields: VisionExtractedFields = {
      fullName:     String(f.clientName ?? ''),
      firstName:    String(f.clientName ?? '').split(' ')[0] ?? '',
      lastName:     String(f.clientName ?? '').split(' ').slice(1).join(' '),
      company:      String(f.company ?? ''),
      designation:  String(f.designation ?? ''),
      emails:       f.email ? [String(f.email)] : [],
      phoneNumbers: f.phone ? [String(f.phone)] : [],
      website:      String(f.website ?? ''),
      address:      String(f.address ?? ''),
      confidence,
      notes:        String(f.notes ?? ''),
      rawText,
    };

    return {
      source:     'openai_vision', // QR parsing is deterministic, not AI
      confidence,
      fields,
      error:      null,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[extractionService] QR extraction failed:', msg);
    return { source: 'manual', confidence: 0, fields: null, error: msg };
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error('FileReader failed'));
    reader.readAsDataURL(blob);
  });
}
