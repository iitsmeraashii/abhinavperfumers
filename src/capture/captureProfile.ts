// Capture Profile — centralized definition of operating profile for the
// lead capture module.
//
// A Capture Profile is an identifier that selects a strategy bundle from the
// Profile Engine. The strategy bundle — NOT this descriptor — determines
// runtime behaviour (validation rules, review thresholds, upload timing,
// queue policy, promotion options, etc.).
//
// This file contains ONLY presentation metadata: human-readable labels,
// icons, colours, and help text for a future profile-switcher UI. No
// property here is read by any runtime code path. Adding a new profile
// means adding a new union member + descriptor entry here and a new
// strategy bundle in profileStrategies.ts — nothing else.

// ─── Type ─────────────────────────────────────────────────────────────────────

export type CaptureProfile = 'CRM' | 'EXHIBITION';

// ─── Default ──────────────────────────────────────────────────────────────────
// The application defaults to CRM. Exhibition mode is not yet implemented.

export const DEFAULT_CAPTURE_PROFILE: CaptureProfile = 'CRM';

// ─── Profile descriptors (presentation only) ──────────────────────────────────
// Stable display metadata for each profile. Never read at runtime for
// behavioural decisions — all behaviour lives in the strategy layer
// (profileStrategies.ts). This metadata exists for future UI surfaces
// (profile switcher, settings page, help tooltips).

export interface CaptureProfileDescriptor {
  /** Unique profile identifier — matches the CaptureProfile union member. */
  id:          CaptureProfile;
  /** Human-readable label shown in UI. */
  displayName: string;
  /** Short tagline for profile-switcher cards. */
  tagline:     string;
  /** Longer description for tooltips / help text. */
  description: string;
  /** Lucide icon name for the profile (rendered by the UI layer). */
  icon:        string;
  /** Tailwind color token for branding the profile card. */
  color:       string;
}

export const CAPTURE_PROFILE_DESCRIPTORS: Record<CaptureProfile, CaptureProfileDescriptor> = {
  CRM: {
    id:          'CRM',
    displayName: 'CRM',
    tagline:     'Accuracy first',
    description: 'Rep reviews extracted data before saving. Ideal for relationship-driven sales where data quality matters most.',
    icon:        'Contact',
    color:       'blue',
  },
  EXHIBITION: {
    id:          'EXHIBITION',
    displayName: 'Exhibition',
    tagline:     'Speed first',
    description: 'Capture is non-blocking; processing happens later. Ideal for high-traffic trade show booths where throughput is the priority.',
    icon:        'Zap',
    color:       'amber',
  },
};
