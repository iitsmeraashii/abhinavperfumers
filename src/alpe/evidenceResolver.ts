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
    console.log('[ALPE TRACE] EVIDENCE_RESOLVE', { input: null, result: 'no_asset' });
    return emptyResult(null, 'no_asset', null);
  }

  console.log('[ALPE TRACE] EVIDENCE_RESOLVE_INPUT', {
    assetId: ref.assetId,
    assetType: ref.assetType,
    storagePath: ref.storagePath ?? null,
    mimeType: ref.mimeType ?? null,
    localAssetId: ref.localAssetId ?? null,
  });

  // ── Row-level diagnostics: query the capture_assets row before resolution.
  // This captures the exact state of the row at the moment the resolver tries
  // to use it, so we can compare it against what _writeAssetStorageMeta wrote.
  let dbRowId: string | null = null;
  let dbStoragePath: string | null | undefined = undefined;
  let dbStorageBucket: string | null | undefined = undefined;
  let dbUploadStatus: string | null | undefined = undefined;
  let idMismatch = false;

  try {
    const { data: dbRow, error: dbErr } = await supabase
      .from('capture_assets')
      .select('id, storage_path, storage_bucket, storage_upload_status')
      .eq('id', ref.assetId)
      .maybeSingle();

    if (dbErr) {
      alpeLog('EvidenceResolver — pre-resolution query ERROR', {
        assetId: ref.assetId,
        error: dbErr.message,
      });
    } else if (dbRow) {
      const r = dbRow as { id: string; storage_path: string | null; storage_bucket: string | null; storage_upload_status: string | null };
      dbRowId = r.id;
      dbStoragePath = r.storage_path;
      dbStorageBucket = r.storage_bucket;
      dbUploadStatus = r.storage_upload_status;
      idMismatch = r.id !== ref.assetId;

      alpeLog('EvidenceResolver — pre-resolution row state', {
        resolverAssetId: ref.assetId,
        dbRowId: r.id,
        idMismatch,
        refStoragePath: ref.storagePath ?? null,
        dbStoragePath: r.storage_path,
        dbStorageBucket: r.storage_bucket,
        dbUploadStatus: r.storage_upload_status,
        assetType: ref.assetType,
        assetSide: ref.assetSide ?? null,
        localAssetId: ref.localAssetId ?? null,
      });

      if (idMismatch) {
        console.error('[EVIDENCE_DIAG] ID MISMATCH in EvidenceResolver!', {
          resolverAssetId: ref.assetId,
          dbRowId: r.id,
          localAssetId: ref.localAssetId,
        });
      }

      // If the DB row has a storage_path but the AssetReference does not, the
      // worker built the reference from a stale row (before upload completed).
      // Update the ref so resolution can proceed.
      if (!ref.storagePath && r.storage_path) {
        alpeLog('EvidenceResolver — DB has storage_path but ref does not; patching', {
          assetId: ref.assetId,
          dbStoragePath: r.storage_path,
        });
        ref = { ...ref, storagePath: r.storage_path };
      }
    } else {
      // No row found by assetId — try by local_asset_id, in case the worker
      // passed the local ID instead of the DB ID.
      alpeLog('EvidenceResolver — no row found by assetId, trying local_asset_id', {
        assetId: ref.assetId,
        localAssetId: ref.localAssetId,
      });
      if (ref.localAssetId) {
        const { data: byLocal } = await supabase
          .from('capture_assets')
          .select('id, storage_path, storage_bucket, storage_upload_status, capture_session_id')
          .eq('local_asset_id', ref.localAssetId)
          .maybeSingle();
        if (byLocal) {
          const r2 = byLocal as { id: string; storage_path: string | null; storage_bucket: string | null; storage_upload_status: string | null; capture_session_id: string };
          alpeLog('EvidenceResolver — found row by local_asset_id', {
            assetId: ref.assetId,
            localAssetId: ref.localAssetId,
            dbRowId: r2.id,
            dbStoragePath: r2.storage_path,
            dbStorageBucket: r2.storage_bucket,
            dbUploadStatus: r2.storage_upload_status,
            sessionId: r2.capture_session_id,
          });
          dbRowId = r2.id;
          dbStoragePath = r2.storage_path;
          dbStorageBucket = r2.storage_bucket;
          dbUploadStatus = r2.storage_upload_status;
          idMismatch = r2.id !== ref.assetId;

          if (!ref.storagePath && r2.storage_path) {
            ref = { ...ref, storagePath: r2.storage_path };
          }
        }
      }
    }
  } catch (queryErr) {
    alpeLog('EvidenceResolver — pre-resolution query threw', {
      assetId: ref.assetId,
      error: queryErr instanceof Error ? queryErr.message : String(queryErr),
    });
  }

  if (!ref.storagePath) {
    alpeLog('EvidenceResolver — no storage path', {
      assetId: ref.assetId,
      dbRowId,
      dbStoragePath: dbStoragePath ?? null,
      dbStorageBucket: dbStorageBucket ?? null,
      dbUploadStatus: dbUploadStatus ?? null,
    });
    return {
      reference:   ref,
      mimeType:    ref.mimeType ?? null,
      storagePath: null,
      url:         null,
      blob:        null,
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
