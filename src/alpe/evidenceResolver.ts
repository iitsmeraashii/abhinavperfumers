// Evidence Resolver — converts AssetReference objects into resolved evidence
// payloads suitable for downstream AI processing.
//
// This component hides all storage implementation details (Supabase Storage,
// IndexedDB, data URLs) behind a single resolve() call.  The pipeline never
// touches storage directly; it asks the resolver for a ready-to-use payload.

import { supabase } from '../supabaseClient';
import type { AssetReference } from './assetReference';
import { alpeLog } from './diagnostics';

// ─── Resolution result model ─────────────────────────────────────────────────

export type ResolutionStatus =
  | 'resolved'      // asset fetched and payload available
  | 'no_asset'      // AssetReference was null
  | 'no_storage'    // asset exists but has no storage path
  | 'fetch_failed'  // network/storage error
  | 'corrupt';      // reference present but unusable

export interface ResolvedEvidence {
  /** The original AssetReference that was resolved. */
  reference:    AssetReference | null;
  /** MIME type of the resolved asset. */
  mimeType:     string | null;
  /** Storage path in the backend (if any). */
  storagePath:  string | null;
  /** Signed or public URL usable by an HTTP client. */
  url:          string | null;
  /** Binary blob if the asset was fetched into memory. */
  blob:         Blob | null;
  /** Object URL for the blob (revoked by caller). */
  objectUrl:    string | null;
  /** Resolution outcome. */
  status:       ResolutionStatus;
  /** Human-readable error when status is not 'resolved'. */
  error:        string | null;
}

// ─── Evidence Resolver ───────────────────────────────────────────────────────

/**
 * Resolves a single AssetReference into a ResolvedEvidence payload.
 *
 * Never throws — returns a structured result with a status field so the
 * caller can branch without try/catch.
 */
export async function resolveEvidence(
  ref: AssetReference | null,
): Promise<ResolvedEvidence> {
  if (!ref) {
    return emptyResult(null, 'no_asset', null);
  }

  if (!ref.storagePath) {
    alpeLog('EvidenceResolver — no storage path', { assetId: ref.assetId });
    return {
      reference:   ref,
      mimeType:    ref.mimeType ?? null,
      storagePath: null,
      url:         null,
      blob:         null,
      objectUrl:   null,
      status:      'no_storage',
      error:       'Asset has no storage path',
    };
  }

  try {
    const { data, error } = await supabase
      .storage
      .from(ref.metadata?.storageBucket as string ?? 'lead-evidence')
      .createSignedUrl(ref.storagePath, 3600);

    if (error || !data?.signedUrl) {
      alpeLog('EvidenceResolver — signed URL failed', {
        assetId: ref.assetId,
        error: error?.message,
      });
      return {
        reference:   ref,
        mimeType:    ref.mimeType ?? null,
        storagePath: ref.storagePath,
        url:         null,
        blob:         null,
        objectUrl:   null,
        status:      'fetch_failed',
        error:       error?.message ?? 'Failed to create signed URL',
      };
    }

    const signedUrl = data.signedUrl;

    // For image/audio assets, fetch the binary so downstream AI has it in memory
    let blob: Blob | null = null;
    let objectUrl: string | null = null;
    try {
      const response = await fetch(signedUrl);
      if (response.ok) {
        blob = await response.blob();
        objectUrl = URL.createObjectURL(blob);
      }
    } catch {
      // Binary fetch is best-effort; URL is still usable
    }

    return {
      reference:   ref,
      mimeType:    ref.mimeType ?? blob?.type ?? null,
      storagePath: ref.storagePath,
      url:         signedUrl,
      blob,
      objectUrl,
      status:      'resolved',
      error:        null,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    alpeLog('EvidenceResolver — exception', { assetId: ref.assetId, error: msg });
    return {
      reference:   ref,
      mimeType:    ref.mimeType ?? null,
      storagePath: ref.storagePath,
      url:         null,
      blob:         null,
      objectUrl:   null,
      status:      'corrupt',
      error:       msg,
    };
  }
}

/**
 * Resolves all evidence assets for a capture session in one call.
 * Returns a grouped result matching the EvidenceAssets shape.
 */
export interface ResolvedEvidenceGroup {
  businessCard: {
    front: ResolvedEvidence;
    back:  ResolvedEvidence;
  };
  qr:        ResolvedEvidence;
  notesImage: ResolvedEvidence;
  audio:     ResolvedEvidence;
}

export async function resolveAllEvidence(
  evidence: import('./assetReference').EvidenceAssets,
): Promise<ResolvedEvidenceGroup> {
  const [front, back, qr, notesImage, audio] = await Promise.all([
    resolveEvidence(evidence.businessCard.front),
    resolveEvidence(evidence.businessCard.back),
    resolveEvidence(evidence.qr),
    resolveEvidence(evidence.notesImage),
    resolveEvidence(evidence.audio),
  ]);

  return {
    businessCard: { front, back },
    qr,
    notesImage,
    audio,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function emptyResult(
  ref: AssetReference | null,
  status: ResolutionStatus,
  error: string | null,
): ResolvedEvidence {
  return {
    reference:   ref,
    mimeType:     null,
    storagePath:  null,
    url:          null,
    blob:         null,
    objectUrl:   null,
    status,
    error,
  };
}
