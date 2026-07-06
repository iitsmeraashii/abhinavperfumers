// Capture Validation Engine — single source of truth for capture promotion eligibility.
//
// A capture is valid if it contains at least one piece of meaningful data:
//
//   Contact Information:
//     clientName, company, phone, email, address, website
//
//   Notes:
//     text notes
//
//   Evidence:
//     business card (front or back asset ID), QR code, voice note, notes image
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
    const hasContact =
      !!String(data.clientName ?? '').trim() ||
      !!String(data.company    ?? '').trim() ||
      !!String(data.phone      ?? '').trim() ||
      !!String(data.email      ?? '').trim() ||
      !!String(data.address    ?? '').trim() ||
      !!String(data.website    ?? '').trim();

    const hasNotes = !!String(data.notes ?? '').trim();

    const hasEvidence =
      !!data.cardFrontAssetId      ||   // business card front
      !!data.cardBackAssetId       ||   // business card back
      !!data.rawQr                 ||   // QR code
      (data.voiceNoteDurationMs != null && data.voiceNoteDurationMs > 0) ||  // voice note
      !!data.notesImageDataUrl;         // notes image

    if (hasContact || hasNotes || hasEvidence) {
      return { valid: true };
    }

    return {
      valid: false,
      error: {
        message: 'Add at least a name, phone, company, or note before saving',
      },
    };
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────────

export const validationEngine = new CaptureValidationEngine();
