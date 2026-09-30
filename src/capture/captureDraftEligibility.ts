import type { DraftData } from './types';

const TEXT_FIELDS: (keyof DraftData)[] = [
  'clientName', 'company', 'phone', 'email', 'designation',
  'notes', 'website', 'address', 'previousRepCode', 'priceRange',
  'leadType', 'leadTemperature',
  'ocrRawText', 'visionRawText', 'extractionSource',
  'voiceNoteTranscript', 'notesImageDataUrl',
];

const ARRAY_FIELDS: (keyof DraftData)[] = [
  'phoneNumbers', 'emails', 'application', 'quickKeywords',
  'targetMarket', 'certification', 'benchmark',
];

export function isDraftEmpty(dd: DraftData): boolean {
  const hasText = TEXT_FIELDS.some(
    (k) => dd[k] != null && String(dd[k]).trim() !== '',
  );
  const hasArray = ARRAY_FIELDS.some(
    (k) => Array.isArray(dd[k]) && (dd[k] as unknown[]).length > 0,
  );
  const hasCard = !!(dd.cardFrontAssetId || dd.cardBackAssetId);
  const hasQr = !!dd.rawQr;
  const hasVoice = !!(dd.voiceNoteDurationMs && dd.voiceNoteDurationMs > 0);
  return !hasText && !hasArray && !hasCard && !hasQr && !hasVoice;
}
