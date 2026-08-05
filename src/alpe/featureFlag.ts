// ALPE Feature Flag — single application-level toggle for routing capture
// processing through the ALPE pipeline instead of the synchronous Capture
// Processing Engine.
//
// When disabled (default): Capture uses the existing Capture Processing Engine
// exactly as today — no behavior change.
//
// When enabled: Capture submits Processing Jobs into ALPE instead of running
// extraction, validation, decision, and promotion synchronously.

export function useAlpeProcessing(): boolean {
  return import.meta.env.VITE_USE_ALPE_PROCESSING === 'true';
}
