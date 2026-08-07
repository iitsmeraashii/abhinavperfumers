// ALPE Worker — reconstructs a CaptureSession from a backend capture_sessions
// row, builds an ExecutionPlan via the existing CaptureExecutionEngine factory,
// and runs the existing processCaptureSession pipeline.
//
// The worker does NOT duplicate business logic. It reuses:
//   - executionEngine.buildPlan() (the factory)
//   - processCaptureSession() (the pipeline)
//   - executePromotion() (the promotion service, called by the pipeline)
//
// The worker's only job is to bridge the queue → pipeline by reconstructing
// the ProcessingContext that the synchronous capture flow builds in memory.

import { supabase } from '../supabaseClient';
import { executionEngine } from '../capture/CaptureExecutionEngine';
import { getProfileStrategies } from '../capture/profileStrategies';
import {
  processCaptureSession,
  type ProcessingContext,
  type ProcessingResult,
} from './pipeline';
import type {
  CaptureMethod,
  CaptureProfile,
  CaptureSession,
  DraftData,
} from '../capture/types';
import type { QueueEntry } from './types';
import { alpeLog, alpeError, updateAlpeRuntime } from './diagnostics';
import type { AssetReference, EvidenceAssets } from './assetReference';
import { EMPTY_EVIDENCE } from './assetReference';

export interface WorkerResult {
  outcome:   'completed' | 'failed' | 'requires_review' | 'queued';
  leadId:    string | null;
  error:     string | null;
  result:    ProcessingResult | null;
}

// ─── Session reconstruction ──────────────────────────────────────────────────

interface BackendSessionRow {
  id:                    string;
  capture_method:        string;
  session_status:        string;
  extracted_fields:      Record<string, unknown>;
  notes:                 string;
  phones:                string[] | null;
  emails:                string[] | null;
  event_id:              string | null;
  lead_temperature:      string | null;
  lead_type:             string | null;
  previous_rep_code:     string | null;
  application:           string[] | null;
  price_range:           string | null;
  quick_keywords:        string[] | null;
  target_market:         string[] | null;
  certification:         string[] | null;
  benchmark:             string[] | null;
  notes_image_url:       string | null;
  voice_note_duration_ms: number | null;
  voice_note_transcript:  string | null;
  extraction_source:     string | null;
  extraction_confidence: number | null;
  promoted_lead_id:     string | null;
}

interface BackendAssetRow {
  id:                  string;
  capture_session_id:  string;
  asset_type:          string;
  asset_side:          string | null;
  side:                string | null;
  local_asset_id:      string;
  storage_path:        string | null;
  storage_bucket:      string | null;
  storage_provider:    string | null;
  storage_upload_status: string | null;
  mime_type:           string;
  file_size:           number;
  width:               number;
  height:              number;
  processing_status:   string;
  transcription_status: string | null;
}

// ─── AssetReference builder ─────────────────────────────────────────────────

function buildAssetReference(row: BackendAssetRow): AssetReference {
  const uploaded = row.storage_upload_status === 'uploaded';
  return {
    assetId:       row.id,
    assetType:     row.asset_type,
    assetSide:     row.asset_side ?? row.side ?? null,
    storagePath:   row.storage_path ?? null,
    publicUrl:     null,
    localAssetId:  row.local_asset_id,
    mimeType:      row.mime_type,
    source:        'capture_assets',
    uploaded,
    metadata: {
      width:               row.width,
      height:              row.height,
      fileSize:            row.file_size,
      transcriptionStatus: row.transcription_status,
      processingStatus:   row.processing_status,
      storageBucket:       row.storage_bucket,
      storageProvider:    row.storage_provider,
    },
  };
}

function buildEvidence(assets: BackendAssetRow[]): EvidenceAssets {
  const evidence: EvidenceAssets = {
    businessCard: { front: null, back: null },
    qr:           null,
    notesImage:   null,
    audio:        null,
  };
  for (const a of assets) {
    const ref = buildAssetReference(a);
    switch (a.asset_type) {
      case 'business_card': {
        const side = a.asset_side ?? a.side;
        if (side === 'front')      evidence.businessCard.front = ref;
        else if (side === 'back')  evidence.businessCard.back  = ref;
        break;
      }
      case 'qr':           evidence.qr         = ref; break;
      case 'notes_image':  evidence.notesImage  = ref; break;
      case 'voice_note':   evidence.audio       = ref; break;
    }
  }
  return evidence;
}

async function fetchBackendSession(backendSessionId: string): Promise<BackendSessionRow | null> {
  const { data, error } = await supabase
    .from('capture_sessions')
    .select('*')
    .eq('id', backendSessionId)
    .maybeSingle();

  if (error || !data) return null;
  return data as BackendSessionRow;
}

async function fetchBackendAssets(backendSessionId: string): Promise<BackendAssetRow[]> {
  const { data, error } = await supabase
    .from('capture_assets')
    .select('id, capture_session_id, asset_type, asset_side, side, local_asset_id, storage_path, storage_bucket, storage_provider, storage_upload_status, mime_type, file_size, width, height, processing_status, transcription_status')
    .eq('capture_session_id', backendSessionId)
    .order('created_at', { ascending: true });

  if (error || !data) return [];
  return data as BackendAssetRow[];
}

/**
 * Wait for extractable assets (business_card, qr) to finish uploading to
 * Supabase Storage. In Exhibition mode, card uploads are deferred (ON_SAVE)
 * and start when the rep presses Save & Next — fire-and-forget, not awaited.
 * The processing job is enqueued immediately, so the scheduler may pick it
 * up before the upload completes. Without this wait, the worker would see
 * storage_path = null, evidence resolution would fail (no_storage), no AI
 * extraction would run, and validation would reject the lead.
 *
 * Polls every 1s up to 30s. If the deadline expires, returns false so the
 * caller can return a retryable failure — the scheduler will retry the job
 * on the next poll, by which time the upload should have completed.
 */
const ASSET_UPLOAD_TIMEOUT_MS = 30_000;
const ASSET_UPLOAD_POLL_MS     = 1_000;

async function waitForAssetsUploaded(backendSessionId: string): Promise<boolean> {
  const deadline = Date.now() + ASSET_UPLOAD_TIMEOUT_MS;
  let pollNum = 0;
  while (Date.now() < deadline) {
    pollNum++;
    const { data, error } = await supabase
      .from('capture_assets')
      .select('asset_type, storage_upload_status, storage_path, local_asset_id')
      .eq('capture_session_id', backendSessionId)
      .in('asset_type', ['business_card', 'qr']);

    if (error) {
      traceStage(backendSessionId, 'WAIT_ASSETS', { poll: pollNum, error: error.message, result: 'query_error' });
      return false;
    }

    const extractable = (data ?? []) as { asset_type: string; storage_upload_status: string | null; storage_path: string | null; local_asset_id: string }[];
    if (extractable.length === 0) {
      traceStage(backendSessionId, 'WAIT_ASSETS', { poll: pollNum, result: 'no_extractable_assets' });
      return true;
    }

    const allUploaded = extractable.every(a => a.storage_upload_status === 'uploaded');
    const statuses = extractable.map(a => ({ localId: a.local_asset_id, status: a.storage_upload_status, storagePath: a.storage_path }));
    traceStage(backendSessionId, 'WAIT_ASSETS', { poll: pollNum, allUploaded, statuses });

    if (allUploaded) return true;

    await new Promise<void>(resolve => setTimeout(resolve, ASSET_UPLOAD_POLL_MS));
  }

  traceStage(backendSessionId, 'WAIT_ASSETS', { result: 'TIMEOUT', polls: pollNum });
  return false;
}

function reconstructDraftData(
  row: BackendSessionRow,
  assets: BackendAssetRow[],
  evidence: EvidenceAssets,
): DraftData {
  const ef = row.extracted_fields ?? {};
  const draft: DraftData = {
    clientName:      (ef.clientName as string)   ?? undefined,
    company:         (ef.company as string)      ?? undefined,
    phone:           (ef.phone as string)        ?? undefined,
    email:           (ef.email as string)        ?? undefined,
    designation:     (ef.designation as string)  ?? undefined,
    notes:           row.notes ?? undefined,
    notesImageDataUrl: row.notes_image_url ?? undefined,
    voiceNoteDurationMs: row.voice_note_duration_ms ?? undefined,
    voiceNoteTranscript:  row.voice_note_transcript ?? undefined,
    leadTemperature: (row.lead_temperature as DraftData['leadTemperature']) ?? undefined,
    leadType:        (row.lead_type as DraftData['leadType']) ?? undefined,
    previousRepCode: row.previous_rep_code ?? undefined,
    application:     (row.application as DraftData['application']) ?? undefined,
    priceRange:      row.price_range ?? undefined,
    quickKeywords:   (row.quick_keywords as string[]) ?? undefined,
    targetMarket:    (row.target_market as string[]) ?? undefined,
    certification:   (row.certification as string[]) ?? undefined,
    benchmark:       (row.benchmark as string[]) ?? undefined,
    phoneNumbers:    row.phones ?? undefined,
    emails:          row.emails ?? undefined,
    extractionSource:    row.extraction_source ?? undefined,
    extractionConfidence: row.extraction_confidence ?? undefined,
  };

  // ── DEPRECATED: scattered evidence fields ──
  // These are populated from the canonical AssetReference objects in
  // ctx.evidence for backward compatibility with downstream code that
  // still reads draftData.cardFrontAssetId etc.  New code should read
  // from ctx.evidence instead.  Do not remove until all consumers migrate.
  if (evidence.businessCard.front) {
    draft.cardFrontAssetId = evidence.businessCard.front.assetId;
    (draft as DraftData).cardFrontStoragePath = evidence.businessCard.front.storagePath ?? undefined;
  }
  if (evidence.businessCard.back) {
    draft.cardBackAssetId = evidence.businessCard.back.assetId;
    (draft as DraftData).cardBackStoragePath = evidence.businessCard.back.storagePath ?? undefined;
  }
  if (evidence.qr) {
    draft.rawQr = evidence.qr.storagePath ?? evidence.qr.localAssetId ?? undefined;
  }
  if (evidence.notesImage) {
    draft.notesImageDataUrl = draft.notesImageDataUrl ?? evidence.notesImage.storagePath ?? undefined;
  }
  // voice_note duration is read from the session row, not the asset row

  return draft;
}

function parseCaptureMethod(method: string): CaptureMethod | null {
  switch (method?.toUpperCase()) {
    case 'BUSINESS_CARD': return 'BUSINESS_CARD';
    case 'QR':            return 'QR';
    case 'MANUAL':        return 'MANUAL';
    default:              return null;
  }
}

function resolveProfile(): CaptureProfile {
  return 'CRM';
}

// ─── Trace helper ────────────────────────────────────────────────────────────

function traceStage(backendSessionId: string, stage: string, payload: Record<string, unknown>): void {
  const ts = new Date().toISOString();
  const entry = { stage, ts, ...payload };
  console.log(`[ALPE TRACE] ${stage}`, entry);
  try {
    supabase.from('alpe_runtime_dumps').insert({
      id: `trace_${backendSessionId}_${stage}_${ts}`,
      job_id: backendSessionId,
      dump_point: `TRACE:${stage}`,
      dump_data: entry,
    }).then(() => {}, () => {});
  } catch { /* ignore */ }
}

// ─── Event lookup ────────────────────────────────────────────────────────────

async function fetchEventInfo(
  eventId: string | null,
): Promise<{ eventCode: string | null; eventName: string | null }> {
  if (!eventId) return { eventCode: null, eventName: null };
  const { data, error } = await supabase
    .from('events')
    .select('event_code, name')
    .eq('id', eventId)
    .maybeSingle();
  if (error || !data) return { eventCode: null, eventName: null };
  return {
    eventCode: data.event_code as string | null,
    eventName:  data.name as string | null,
  };
}

// ─── Worker entry point ───────────────────────────────────────────────────────

export async function processJob(job: QueueEntry): Promise<WorkerResult> {
  const backendSessionId = job.capture_session_id;
  if (!backendSessionId) {
    return { outcome: 'failed', leadId: null, error: 'No capture_session_id on job', result: null };
  }

  alpeLog('Worker start', { jobId: job.id, captureSessionId: backendSessionId });
  traceStage(backendSessionId, 'WORKER_START', { jobId: job.id, state: job.state });
  updateAlpeRuntime({ workerState: 'running', currentPipelineStage: 'LOAD_CONTEXT' });

  // 1. Reconstruct the capture session from the backend row
  traceStage(backendSessionId, 'LOAD_SESSION', { started: true });
  const row = await fetchBackendSession(backendSessionId);
  if (!row) {
    traceStage(backendSessionId, 'LOAD_SESSION', { result: 'NOT_FOUND' });
    alpeError('Worker error — capture session not found', { backendSessionId });
    updateAlpeRuntime({ workerState: null, lastWorkerError: 'Capture session not found', currentPipelineStage: null });
    return { outcome: 'failed', leadId: null, error: 'Capture session not found', result: null };
  }
  traceStage(backendSessionId, 'LOAD_SESSION', {
    result: 'OK',
    captureMethod: row.capture_method,
    sessionStatus: row.session_status,
    promotedLeadId: row.promoted_lead_id,
    extractedFields: row.extracted_fields,
  });

  // Already promoted — nothing to do
  if (row.promoted_lead_id) {
    traceStage(backendSessionId, 'ALREADY_PROMOTED', { leadId: row.promoted_lead_id });
    alpeLog('Worker — session already promoted', { leadId: row.promoted_lead_id });
    updateAlpeRuntime({ workerState: null, currentPipelineStage: null });
    return { outcome: 'completed', leadId: row.promoted_lead_id, error: null, result: null };
  }

  // 1b. Load all capture_assets for this session to hydrate evidence references
  traceStage(backendSessionId, 'LOAD_ASSETS', { started: true });
  const assets = await fetchBackendAssets(backendSessionId);

  // ── TEMPORARY DIAGNOSTICS: Asset hydration ──
  console.log('[ALPE DIAG] Assets loaded:', {
    count: assets.length,
    assets: assets.map(a => ({
      id:           a.id,
      asset_type:   a.asset_type,
      side:         a.asset_side ?? a.side,
      local_id:     a.local_asset_id,
      storage_path:  a.storage_path,
      bucket:       a.storage_bucket,
      upload_status: a.storage_upload_status,
    })),
  });
  try {
    supabase.from('alpe_runtime_dumps').insert({
      id: `assets_${backendSessionId}`,
      job_id: backendSessionId,
      dump_point: 'ASSETS_LOADED',
      dump_data: {
        count: assets.length,
        assets: assets.map(a => ({
          id: a.id, asset_type: a.asset_type, side: a.asset_side ?? a.side,
          local_id: a.local_asset_id, storage_path: a.storage_path,
        })),
      },
    }).then(() => {}, () => {});
  } catch { /* ignore */ }

  // 1c. Wait for extractable assets (business_card, qr) to finish uploading.
  // In Exhibition mode, card uploads are deferred (ON_SAVE) and start when the
  // rep presses Save & Next — fire-and-forget. The processing job is enqueued
  // immediately, so uploads may still be in-flight when the scheduler claims
  // the job. Without this wait, evidence resolution would fail (no_storage),
  // no AI extraction would run, and validation would reject the lead.
  const hasExtractableAssets = assets.some(
    a => a.asset_type === 'business_card' || a.asset_type === 'qr',
  );
  if (hasExtractableAssets) {
    traceStage(backendSessionId, 'WAIT_ASSETS_START', { timeoutMs: ASSET_UPLOAD_TIMEOUT_MS });
    const ready = await waitForAssetsUploaded(backendSessionId);
    if (!ready) {
      traceStage(backendSessionId, 'WAIT_ASSETS_RESULT', { ready: false, willRetry: true });
      alpeLog('Worker — assets not uploaded yet, will retry');
      return {
        outcome: 'failed',
        leadId:  null,
        error:   'Assets not yet uploaded to storage, will retry',
        result:  null,
      };
    }
    traceStage(backendSessionId, 'WAIT_ASSETS_RESULT', { ready: true });
    // Re-fetch assets now that uploads have completed so evidence references
    // have the correct storage_path.
    assets.length = 0;
    assets.push(...await fetchBackendAssets(backendSessionId));
  }

  const evidence      = buildEvidence(assets);
  const draftData    = reconstructDraftData(row, assets, evidence);
  const captureMethod = parseCaptureMethod(row.capture_method);
  const profile       = resolveProfile();
  const strategies    = getProfileStrategies(profile);

  traceStage(backendSessionId, 'ASSET_REFERENCES', {
    businessCardFront: evidence.businessCard.front,
    businessCardBack: evidence.businessCard.back,
    qr: evidence.qr,
    notesImage: evidence.notesImage,
    audio: evidence.audio,
  });

  traceStage(backendSessionId, 'DRAFT_DATA', {
    clientName: draftData.clientName ?? null,
    company: draftData.company ?? null,
    phone: draftData.phone ?? null,
    email: draftData.email ?? null,
    captureMethod,
    profile,
  });

  updateAlpeRuntime({ currentCaptureProfile: profile });

  // 2. Resolve event info
  const { eventCode, eventName } = await fetchEventInfo(row.event_id);
  traceStage(backendSessionId, 'EVENT_INFO', { eventCode, eventName });

  // 3. Build the execution plan via the existing factory
  const isOnline = typeof navigator !== 'undefined' ? navigator.onLine : true;
  const plan = executionEngine.buildPlan(profile, strategies, isOnline);
  traceStage(backendSessionId, 'PLAN_BUILT', { isOnline, promotion: plan.promotion, review: plan.review });

  updateAlpeRuntime({ queuePolicy: plan.queue });

  // 4. Build the processing context
  const session: CaptureSession = {
    captureMethod,
    originalCaptureMethod: captureMethod,
    sessionStatus:    'DRAFT',
    captureProfile:   profile,
    createdAt:        null,
    updatedAt:        null,
    draftData,
    hasUnsavedChanges: false,
    sync: {
      status:             'synced',
      backendSessionId,
      lastSyncedAt:       null,
      pendingOps:         0,
      lastError:          null,
      backendAssetIds:    Object.fromEntries(assets.map(a => [a.local_asset_id, a.id])),
      backendExtractionIds: {},
    },
  };

  const ctx: ProcessingContext = {
    session,
    backendSessionId,
    eventCode,
    eventId:          row.event_id,
    eventName,
    completedLeadId:  backendSessionId,
    plan,
    evidence,
    correlationId:   (job.metadata as Record<string, unknown> | null)?.correlationId as string | null ?? null,
  };

  // ── TEMPORARY DIAGNOSTICS: Final hydrated ProcessingContext ──
  const hydratedDump = {
    backendSessionId:     ctx.backendSessionId,
    captureMethod:        ctx.session.captureMethod,
    // Canonical AssetReference objects
    evidence: {
      businessCard: {
        front: ctx.evidence.businessCard.front,
        back:  ctx.evidence.businessCard.back,
      },
      qr:         ctx.evidence.qr,
      notesImage: ctx.evidence.notesImage,
      audio:      ctx.evidence.audio,
    },
    // Deprecated scattered fields (for backward compat verification)
    cardFrontAssetId:     ctx.session.draftData.cardFrontAssetId ?? null,
    cardBackAssetId:      ctx.session.draftData.cardBackAssetId ?? null,
    cardFrontStoragePath: (ctx.session.draftData as Record<string, unknown>).cardFrontStoragePath ?? null,
    cardBackStoragePath:  (ctx.session.draftData as Record<string, unknown>).cardBackStoragePath ?? null,
    rawQr:                ctx.session.draftData.rawQr ?? null,
    notesImageDataUrl:    ctx.session.draftData.notesImageDataUrl ?? null,
    voiceNoteDurationMs:  ctx.session.draftData.voiceNoteDurationMs ?? null,
    clientName:           ctx.session.draftData.clientName ?? null,
    company:              ctx.session.draftData.company ?? null,
    phone:                ctx.session.draftData.phone ?? null,
    phoneNumbers:         ctx.session.draftData.phoneNumbers ?? null,
    emails:               ctx.session.draftData.emails ?? null,
    extractionSource:     ctx.session.draftData.extractionSource ?? null,
    extractionConfidence: ctx.session.draftData.extractionConfidence ?? null,
    backendAssetIds:      ctx.session.sync.backendAssetIds,
  };
  console.log('[ALPE DIAG] Hydrated ProcessingContext:', hydratedDump);
  try {
    supabase.from('alpe_runtime_dumps').insert({
      id: `hydrated_${backendSessionId}`,
      job_id: backendSessionId,
      dump_point: 'HYDRATED_CONTEXT',
      dump_data: hydratedDump,
    }).then(() => {}, () => {});
  } catch { /* ignore */ }

  // 5. Run the existing pipeline
  traceStage(backendSessionId, 'PIPELINE_START', {});
  try {
    const result = await processCaptureSession(ctx);
    traceStage(backendSessionId, 'PIPELINE_COMPLETE', { outcome: result.outcome, leadId: result.leadId, error: result.error });
    alpeLog('Worker — pipeline complete', { outcome: result.outcome, leadId: result.leadId });
    updateAlpeRuntime({ workerState: null, currentPipelineStage: null });
    return {
      outcome: result.outcome === 'success' ? 'completed' : result.outcome === 'queued' ? 'queued' : 'failed',
      leadId:  result.leadId,
      error:   result.error,
      result,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    traceStage(backendSessionId, 'PIPELINE_ERROR', { error: msg, stack: err instanceof Error ? err.stack : null });
    alpeError('Worker error', err);
    updateAlpeRuntime({ workerState: null, currentPipelineStage: null, lastWorkerError: msg });
    return { outcome: 'failed', leadId: null, error: msg, result: null };
  }
}
