// Lead Evidence Service — single source of truth for all evidence attached to a lead.
//
// Responsibilities:
//   - Fetch evidence rows from capture_assets (by sessionId or leadId)
//   - Join voice note transcript from capture_sessions when fetching by sessionId/leadId
//   - Normalize DB rows into typed domain objects independent of table shape
//   - Group business card front/back into one logical BusinessCardEvidence object
//   - Generate signed URLs for all storage assets
//   - Sort evidence newest-first
//
// What this service does NOT do:
//   - Upload assets (owned by assetStorageUpload + captureEvidenceManager)
//   - Transcribe voice notes (a future edge function concern)
//   - Write to any DB table
//
// Consumers:
//   - LeadDetailPage (primary consumer — must eventually query NO tables directly)
//   - Any future UI that displays evidence for a lead or session
//
// Storage bucket: lead-evidence (private — signed URLs required)
// Signed URL TTL: 1 hour (sufficient for a UI session; refresh via refreshEvidence)

import { supabase } from '../supabaseClient';
import type { DbCaptureAsset } from './types';

const BUCKET     = 'lead-evidence';
const SIGNED_TTL = 3600; // seconds

// ─── Domain types ─────────────────────────────────────────────────────────────
// These are independent of DB column names.

export type TranscriptionStatus = 'pending' | 'processing' | 'done' | 'failed' | 'none';

export interface BusinessCardEvidence {
  kind:       'business_card';
  frontImage: string | null;   // signed URL, null when not yet uploaded
  backImage:  string | null;   // signed URL, null when not yet uploaded
  frontPath:  string | null;   // storage_path for re-signing
  backPath:   string | null;
  createdAt:  string;          // ISO — earliest of front/back
}

export interface VoiceMemoEvidence {
  kind:                'voice_memo';
  audioUrl:            string | null;   // signed URL, null when not yet uploaded
  audioPath:           string | null;   // storage_path for re-signing
  durationMs:          number | null;
  transcript:          string | null;
  transcriptionStatus: TranscriptionStatus;
  createdAt:           string;
}

export interface ImageNoteEvidence {
  kind:      'image_note';
  imageUrl:  string | null;   // signed URL, null when not yet uploaded
  imagePath: string | null;   // storage_path for re-signing
  createdAt: string;
}

export type LeadEvidence =
  | BusinessCardEvidence
  | VoiceMemoEvidence
  | ImageNoteEvidence;

export interface LeadEvidenceCollection {
  items:     LeadEvidence[];
  sessionId: string | null;
  leadId:    string | null;
  fetchedAt: string;           // ISO
}

export const EMPTY_COLLECTION: LeadEvidenceCollection = {
  items:     [],
  sessionId: null,
  leadId:    null,
  fetchedAt: new Date(0).toISOString(),
};

// ─── Fetch params ─────────────────────────────────────────────────────────────

export interface FetchEvidenceParams {
  sessionId?: string;
  leadId?:    string;
}

// ─── Internal DB row type for joined query ────────────────────────────────────

interface CaptureSessionMeta {
  voice_note_duration_ms: number | null;
  voice_note_transcript:  string | null;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Fetches all evidence for a given session or lead, normalizes it, generates
 * signed URLs, groups business cards, and returns a sorted collection.
 *
 * Pass either sessionId (capture flow) or leadId (lead detail view); if both
 * are provided, sessionId takes precedence.
 */
export async function fetchEvidence(
  params: FetchEvidenceParams,
): Promise<LeadEvidenceCollection> {
  const { sessionId, leadId } = params;
  if (!sessionId && !leadId) return EMPTY_COLLECTION;

  try {
    let resolvedSessionId: string | null = sessionId ?? null;

    // When given a leadId, resolve the capture_session that was promoted to it.
    if (!resolvedSessionId && leadId) {
      resolvedSessionId = await _resolveSessionIdForLead(leadId);
      if (!resolvedSessionId) {
        return { ...EMPTY_COLLECTION, leadId, fetchedAt: new Date().toISOString() };
      }
    }

    const [assets, sessionMeta] = await Promise.all([
      _fetchAssets(resolvedSessionId!),
      _fetchSessionMeta(resolvedSessionId!),
    ]);

    const items = await _buildCollection(assets, sessionMeta);

    return {
      items:     sortEvidenceDescending(items),
      sessionId: resolvedSessionId,
      leadId:    leadId ?? null,
      fetchedAt: new Date().toISOString(),
    };
  } catch (err) {
    console.warn('[leadEvidenceService] fetchEvidence error:', err);
    return EMPTY_COLLECTION;
  }
}

/**
 * Re-fetches the collection with fresh signed URLs and updated rows.
 * Returns a new collection; does not mutate the original.
 */
export async function refreshEvidence(
  params: FetchEvidenceParams,
): Promise<LeadEvidenceCollection> {
  return fetchEvidence(params);
}

/**
 * Appends new evidence items to an existing collection (immutable).
 * Automatically re-sorts descending and deduplicates by content identity.
 */
export function appendEvidence(
  collection: LeadEvidenceCollection,
  incoming: LeadEvidence[],
): LeadEvidenceCollection {
  if (incoming.length === 0) return collection;
  const merged = [...collection.items, ...incoming];
  return {
    ...collection,
    items:     sortEvidenceDescending(merged),
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * Sorts evidence items newest-first by createdAt.
 * Returns a new array; does not mutate the input.
 */
export function sortEvidenceDescending(items: LeadEvidence[]): LeadEvidence[] {
  return [...items].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );
}

// ─── Normalization ────────────────────────────────────────────────────────────

/**
 * Maps raw DB asset rows and optional session metadata into typed domain objects.
 * Business cards are grouped (front+back → one BusinessCardEvidence).
 * Signed URLs are generated for every row that has a storage_path.
 */
export async function normalizeEvidence(
  assets: DbCaptureAsset[],
  sessionMeta: CaptureSessionMeta | null,
): Promise<LeadEvidence[]> {
  return _buildCollection(assets, sessionMeta);
}

/**
 * Groups raw business card asset rows (front + back) into a single
 * BusinessCardEvidence object. The grouping uses storage_path for URL generation.
 * Never exposes separate front/back entries to callers.
 */
export function groupBusinessCards(
  cards: DbCaptureAsset[],
  signedUrls: Map<string, string>,
): BusinessCardEvidence | null {
  if (cards.length === 0) return null;

  const front = cards.find(c => c.side === 'front') ?? null;
  const back  = cards.find(c => c.side === 'back')  ?? null;

  const anchorCard = front ?? back!;

  return {
    kind:       'business_card',
    frontImage: front?.storage_path ? (signedUrls.get(front.storage_path) ?? null) : null,
    backImage:  back?.storage_path  ? (signedUrls.get(back.storage_path)  ?? null) : null,
    frontPath:  front?.storage_path ?? null,
    backPath:   back?.storage_path  ?? null,
    createdAt:  anchorCard.created_at,
  };
}

// ─── Private helpers ──────────────────────────────────────────────────────────

async function _resolveSessionIdForLead(leadId: string): Promise<string | null> {
  const { data, error } = await supabase
    .from('capture_sessions')
    .select('id')
    .eq('promoted_lead_id', leadId)
    .maybeSingle();

  if (error) {
    console.warn('[leadEvidenceService] _resolveSessionIdForLead error:', error.message);
    return null;
  }
  return data?.id ?? null;
}

async function _fetchAssets(sessionId: string): Promise<DbCaptureAsset[]> {
  const { data, error } = await supabase
    .from('capture_assets')
    .select('*')
    .eq('capture_session_id', sessionId);

  if (error) {
    console.warn('[leadEvidenceService] _fetchAssets error:', error.message);
    return [];
  }
  return (data ?? []) as DbCaptureAsset[];
}

async function _fetchSessionMeta(sessionId: string): Promise<CaptureSessionMeta | null> {
  const { data, error } = await supabase
    .from('capture_sessions')
    .select('voice_note_duration_ms, voice_note_transcript')
    .eq('id', sessionId)
    .maybeSingle();

  if (error) {
    console.warn('[leadEvidenceService] _fetchSessionMeta error:', error.message);
    return null;
  }
  return data as CaptureSessionMeta | null;
}

async function _buildCollection(
  assets: DbCaptureAsset[],
  sessionMeta: CaptureSessionMeta | null,
): Promise<LeadEvidence[]> {
  // Collect all storage paths that need signing
  const paths = assets
    .map(a => a.storage_path)
    .filter((p): p is string => !!p);

  const signedUrls = await _signPaths(paths);

  const cardAssets = assets.filter(a => a.asset_type === 'business_card');
  const notesAssets = assets.filter(a => a.asset_type === 'notes_image');
  const voiceAssets = assets.filter(a => a.asset_type === 'voice_note');

  const items: LeadEvidence[] = [];

  // Business cards — grouped, never individual
  if (cardAssets.length > 0) {
    const grouped = groupBusinessCards(cardAssets, signedUrls);
    if (grouped) items.push(grouped);
  }

  // Notes images — one per asset row
  for (const asset of notesAssets) {
    const signedUrl = asset.storage_path
      ? (signedUrls.get(asset.storage_path) ?? null)
      : null;
    items.push({
      kind:      'image_note',
      imageUrl:  signedUrl,
      imagePath: asset.storage_path ?? null,
      createdAt: asset.created_at,
    } satisfies ImageNoteEvidence);
  }

  // Voice notes — one per asset row, enriched with session transcript
  for (const asset of voiceAssets) {
    const signedUrl = asset.storage_path
      ? (signedUrls.get(asset.storage_path) ?? null)
      : null;

    const transcript = sessionMeta?.voice_note_transcript ?? null;
    const transcriptionStatus: TranscriptionStatus =
      transcript ? 'done' : 'none';

    items.push({
      kind:                'voice_memo',
      audioUrl:            signedUrl,
      audioPath:           asset.storage_path ?? null,
      durationMs:          sessionMeta?.voice_note_duration_ms ?? null,
      transcript,
      transcriptionStatus,
      createdAt:           asset.created_at,
    } satisfies VoiceMemoEvidence);
  }

  return items;
}

async function _signPaths(paths: string[]): Promise<Map<string, string>> {
  if (paths.length === 0) return new Map();

  const { data, error } = await supabase.storage
    .from(BUCKET)
    .createSignedUrls(paths, SIGNED_TTL);

  if (error) {
    console.warn('[leadEvidenceService] _signPaths error:', error.message);
    return new Map();
  }

  const map = new Map<string, string>();
  for (const entry of data ?? []) {
    if (entry.signedUrl) map.set(entry.path, entry.signedUrl);
  }
  return map;
}
