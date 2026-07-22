// Capture Validation Engine — single source of truth for capture promotion eligibility.
//
// A capture is valid ONLY if it contains at least one contact identifier:
//
//   Required identifiers (at least one):
//     clientName, company, phone
//
//   Supplementary data (not sufficient on their own):
//     email, address, website, notes, voice note, notes image,
//     business card photo, QR code payload
//
// Evidence (a scanned QR, a card photo) is NOT enough by itself — extraction
// may have failed or not completed, leaving the lead with no identifiable
// contact. The rep must have at least a name, company, or phone number to
// save a lead in CRM mode.
//
// This module has no React dependency — it operates on DraftData only.
// Integrate via validationEngine singleton; do not duplicate rules elsewhere.

import type { DraftData } from './types';

// ─── Public types ─────────────────────────────────────────────────────────────

export interface ValidationError {
  /** Human-readable message shown in the UI when validation fails. */
  message: string;
}

export interface ValidationResult {
  valid:  boolean;
  /** Present only when valid === false. */
  error?: ValidationError;
}

// ─── Engine ───────────────────────────────────────────────────────────────────

export class CaptureValidationEngine {
  validate(data: DraftData): ValidationResult {
    const hasName    = !!String(data.clientName ?? '').trim();
    const hasCompany = !!String(data.company    ?? '').trim();
    const hasPhone   = !!String(data.phone      ?? '').trim();

    if (hasName || hasCompany || hasPhone) {
      return { valid: true };
    }

    return {
      valid: false,
      error: {
        message: 'At least one identifier is required — enter a name, company, or phone number to save this lead',
      },
    };
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────────

export const validationEngine = new CaptureValidationEngine();
