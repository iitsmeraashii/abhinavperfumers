// Capture Profile — centralized definition of operating behaviour for the
// lead capture module.
//
// A Capture Profile determines:
//   - which capture journey to display
//   - whether the UI waits for AI/OCR processing before presenting results
//   - future per-profile defaults (e.g. auto-advance, field visibility)
//
// A Capture Profile is NOT network connectivity. Connectivity is a runtime
// capability that only determines whether background processing executes
// immediately or waits. Both profiles use the same backend pipeline.
//
// Supported profiles:
//   CRM        — accuracy first; rep reviews extraction results before saving
//   EXHIBITION — speed first; capture is non-blocking; processing happens later

// ─── Type ─────────────────────────────────────────────────────────────────────

export type CaptureProfile = 'CRM' | 'EXHIBITION';

// ─── Default ──────────────────────────────────────────────────────────────────
// The application defaults to CRM. Exhibition mode is not yet implemented.

export const DEFAULT_CAPTURE_PROFILE: CaptureProfile = 'CRM';

// ─── Profile descriptors ──────────────────────────────────────────────────────
// Stable metadata about each profile. Future code should read from here rather
// than switch on the literal string, so behaviour stays co-located with the type.

export interface CaptureProfileDescriptor {
  /** Human-readable label shown in future profile-switcher UI. */
  label: string;
  /** One-line purpose description. */
  purpose: string;
  /** Whether the UI waits for AI/OCR extraction before showing the review form. */
  waitForExtraction: boolean;
  /** Whether the capture journey skips the review form and saves immediately. */
  skipReview: boolean;
}

export const CAPTURE_PROFILE_DESCRIPTORS: Record<CaptureProfile, CaptureProfileDescriptor> = {
  CRM: {
    label:             'CRM',
    purpose:           'Accuracy first — rep reviews extracted data before saving.',
    waitForExtraction: true,
    skipReview:        false,
  },
  EXHIBITION: {
    label:             'Exhibition',
    purpose:           'Speed first — capture is non-blocking; processing happens later.',
    waitForExtraction: false,
    skipReview:        true,
  },
};
