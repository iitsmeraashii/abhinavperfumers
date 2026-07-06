// Capture Extraction Coordinator — owns extraction deduplication state.
//
// Current responsibility:
//   - Track which asset IDs have already produced a Vision (openai_vision)
//     extraction_results row, so that the subsequent Tesseract OCR result for
//     the same asset is not written as a duplicate row.
//
// Future responsibilities (not yet implemented):
//   - Extraction orchestration (Vision vs. OCR routing)
//   - Extraction result synchronization
//   - Processing Engine entry point
//
// Design: module singleton, not a React context.
// Dedup state must survive React re-renders without triggering them.
// A useRef inside CaptureLeadPage served this purpose previously;
// a module-level instance is equivalent (same app-lifetime scope, no React coupling).

class CaptureExtractionCoordinator {
  private _visionExtractedAssets = new Set<string>();

  // ── Deduplication API ──────────────────────────────────────────────────────

  /**
   * Called when a Vision (openai_vision) extraction result is received for an
   * asset. Marks the asset so that a subsequent Tesseract OCR result for the
   * same asset is skipped.
   */
  markVisionExtracted(assetId: string): void {
    this._visionExtractedAssets.add(assetId);
  }

  /**
   * Returns true if a Vision extraction result has already been recorded for
   * this asset. Used by the OCR path to skip writing a duplicate row.
   */
  hasVisionExtraction(assetId: string): boolean {
    return this._visionExtractedAssets.has(assetId);
  }
}

export const extractionCoordinator = new CaptureExtractionCoordinator();
