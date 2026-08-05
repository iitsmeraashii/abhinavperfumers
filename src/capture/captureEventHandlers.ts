// Capture Event Handlers — real-time extraction event handlers and evidence
// helpers that fire during capture (before Save & Next). These are NOT
// processing logic; they belong to the Capture layer.
//
// Extracted from the former captureProcessingEngine so that ALPE can own the
// processing pipeline while Capture retains capture-time event handling.

import { evidenceManager }            from './captureEvidenceManager';
import { extractionCoordinator }       from './captureExtractionCoordinator';
import { executionEngine } from './CaptureExecutionEngine';
import type { SyncRoutingCallbacks, QueuePolicy, UploadTiming } from './CaptureExecutionEngine';
import type {
  BusinessCardAsset,
  OcrResult,
  VisionResult,
} from './types';
import type { ParsedContact }          from './parseQrPayload';

// ─── Public evidence helpers ──────────────────────────────────────────────────

export function registerCardEvidence(
  sessionId: string,
  assets: { front: BusinessCardAsset | null; back: BusinessCardAsset | null },
  uploadTiming: UploadTiming,
): void {
  const { front, back } = assets;
  if (front) evidenceManager.register({ type: 'business_card_front', sessionId, asset: front, uploadTiming });
  if (back)  evidenceManager.register({ type: 'business_card_back',  sessionId, asset: back,  uploadTiming });
}

export function registerVoiceNoteEvidence(
  sessionId: string,
  audioBlob: Blob,
  durationMs: number,
  mimeType: string,
  uploadTiming: UploadTiming,
): void {
  evidenceManager.register({ type: 'voice_note', sessionId, audioBlob, durationMs, mimeType, uploadTiming });
}

export function notifySessionReset(): void {
  evidenceManager.onSessionReset();
}

// ─── Extraction Stage — real-time event handlers ──────────────────────────────

export type ExtractionSyncCallbacks = SyncRoutingCallbacks;
export type ExtractionHandlerOutcome = 'synced' | 'queued' | 'skipped';

export async function handleVisionExtraction(params: {
  result:           VisionResult;
  backendSessionId: string;
  backendAssetId:   string | null;
  queue:            QueuePolicy;
  isOnline:         boolean;
  syncCbs:          ExtractionSyncCallbacks;
}): Promise<ExtractionHandlerOutcome> {
  const { result, backendSessionId, backendAssetId, queue, isOnline, syncCbs } = params;

  if (result.source !== 'openai_vision') return 'skipped';

  extractionCoordinator.markVisionExtracted(result.assetId);

  const extractionId = crypto.randomUUID();
  const payload = { extractionId, backendSessionId, backendAssetId, visionResult: result };

  executionEngine.routeVisionExtraction(queue, isOnline, backendSessionId, payload, syncCbs);

  executionEngine.routeVisionExtractionMeta(queue, isOnline, {
    backendSessionId,
    source:           result.source,
    confidence:       result.fields.confidence,
    durationMs:       result.durationMs,
  });

  return isOnline ? 'synced' : 'queued';
}

export async function handleOcrExtraction(params: {
  result:           OcrResult;
  backendSessionId: string;
  backendAssetId:   string | null;
  queue:            QueuePolicy;
  isOnline:         boolean;
  syncCbs:          ExtractionSyncCallbacks;
}): Promise<ExtractionHandlerOutcome> {
  const { result, backendSessionId, backendAssetId, queue, isOnline, syncCbs } = params;

  if (extractionCoordinator.hasVisionExtraction(result.assetId)) return 'skipped';

  const extractionId = crypto.randomUUID();
  const payload = { extractionId, backendSessionId, backendAssetId, ocrResult: result };

  executionEngine.routeOcrExtraction(queue, isOnline, backendSessionId, payload, syncCbs);

  return isOnline ? 'synced' : 'queued';
}

export async function handleQrExtraction(params: {
  parsed:           ParsedContact;
  backendSessionId: string;
  durationMs:       number;
  queue:            QueuePolicy;
  isOnline:         boolean;
  syncCbs:          ExtractionSyncCallbacks;
}): Promise<ExtractionHandlerOutcome> {
  const { parsed, backendSessionId, durationMs, queue, isOnline, syncCbs } = params;

  const extractionId = crypto.randomUUID();
  const payload = { extractionId, backendSessionId, parsed, durationMs };

  executionEngine.routeQrExtraction(queue, isOnline, backendSessionId, payload, syncCbs);

  return isOnline ? 'synced' : 'queued';
}
