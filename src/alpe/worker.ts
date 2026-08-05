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

async function fetchBackendSession(backendSessionId: string): Promise<BackendSessionRow | null> {
  const { data, error } = await supabase
    .from('capture_sessions')
    .select('*')
    .eq('id', backendSessionId)
    .maybeSingle();

  if (error || !data) return null;
  return data as BackendSessionRow;
}

function reconstructDraftData(row: BackendSessionRow): DraftData {
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
  updateAlpeRuntime({ workerState: 'running', currentPipelineStage: 'LOAD_CONTEXT' });

  // 1. Reconstruct the capture session from the backend row
  const row = await fetchBackendSession(backendSessionId);
  if (!row) {
    alpeError('Worker error — capture session not found', { backendSessionId });
    updateAlpeRuntime({ workerState: null, lastWorkerError: 'Capture session not found', currentPipelineStage: null });
    return { outcome: 'failed', leadId: null, error: 'Capture session not found', result: null };
  }

  // Already promoted — nothing to do
  if (row.promoted_lead_id) {
    alpeLog('Worker — session already promoted', { leadId: row.promoted_lead_id });
    updateAlpeRuntime({ workerState: null, currentPipelineStage: null });
    return { outcome: 'completed', leadId: row.promoted_lead_id, error: null, result: null };
  }

  const draftData    = reconstructDraftData(row);
  const captureMethod = parseCaptureMethod(row.capture_method);
  const profile       = resolveProfile();
  const strategies    = getProfileStrategies(profile);

  updateAlpeRuntime({ currentCaptureProfile: profile });

  // 2. Resolve event info
  const { eventCode, eventName } = await fetchEventInfo(row.event_id);

  // 3. Build the execution plan via the existing factory
  const isOnline = typeof navigator !== 'undefined' ? navigator.onLine : true;
  const plan = executionEngine.buildPlan(profile, strategies, isOnline);

  updateAlpeRuntime({ queuePolicy: plan.queue });

  // 4. Build the processing context
  const session: CaptureSession = {
    captureMethod,
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
      backendAssetIds:    {},
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
  };

  // 5. Run the existing pipeline
  try {
    const result = await processCaptureSession(ctx);
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
    alpeError('Worker error', err);
    updateAlpeRuntime({ workerState: null, currentPipelineStage: null, lastWorkerError: msg });
    return { outcome: 'failed', leadId: null, error: msg, result: null };
  }
}
