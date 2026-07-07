// Heuristic field extractor for raw OCR text from business card images.
// Shares regex/classification logic with parseQrPayload but is tuned for:
//   - multi-line free-form card layouts
//   - OCR noise (broken words, ligatures, stray punctuation)
//   - multiple phone numbers / emails on one card
//   - address blocks (recognized but not parsed)

import type { ManualEntryFields } from './types';
import type { OcrResult } from './types';

// ─── Regex constants ──────────────────────────────────────────────────────────

const RE_EMAIL = /[\w.+\-]{2,}@[\w\-]{2,}\.[a-z]{2,6}/gi;

// Phone: allows spaces, dashes, dots, brackets, leading +/0
// Require at least 7 digits
const RE_PHONE = /(?:\+?\d[\d\s\-().]{5,}\d)/g;
function hasEnoughDigits(s: string) {
  return (s.replace(/\D/g, '').length >= 7);
}

// URL detection
const RE_URL = /https?:\/\/\S+/gi;

// Lines that are almost certainly print-layout noise or headers
const RE_NOISE = /\b(expo|exhibition|fair|summit|fest|pass|ticket|badge|entry|visitor|delegate|conference|hall|pavilion|stall|booth|edition|mumbai|delhi|bangalore|chennai|hyderabad|kolkata|pune|ahmedabad|2024|2025|2026|day pass|\d{1,2}[\s-]day)\b/i;

// Alphanumeric registration / badge codes
const RE_ID_CODE = /^[A-Z]{2,}[-/][A-Z0-9]+[-/]?[A-Z0-9]*$/i;

// Lines that are clearly addresses (contain common address tokens)
const RE_ADDRESS = /\b(\d+[,\/]?\s*\w+\s+(?:street|st|road|rd|avenue|ave|lane|ln|nagar|colony|park|sector|plot|flat|floor|building|bldg|society|complex|industrial|area|estate|district|pin|pincode|zip))\b/i;
const RE_PINCODE = /\b\d{6}\b/;

// Designation keyword list
const DESIGNATIONS = new Set([
  'owner', 'founder', 'co-founder', 'cofounder',
  'director', 'managing director', 'md', 'cmd',
  'ceo', 'coo', 'cto', 'cfo', 'cmo', 'cxo',
  'president', 'vice president', 'vp',
  'manager', 'sr. manager', 'senior manager', 'agm', 'dgm', 'gm', 'general manager',
  'head', 'team lead', 'lead',
  'partner', 'senior partner',
  'proprietor', 'prop',
  'executive', 'sr. executive', 'senior executive',
  'consultant', 'advisor',
  'sales', 'sales head', 'sales manager', 'sales executive',
  'purchase', 'purchase manager', 'purchase head',
  'marketing', 'marketing manager',
  'engineer', 'sr. engineer',
  'associate', 'officer',
  'representative', 'rep',
  'supervisor', 'superintendent',
  'chairman', 'trustee',
  'dealer', 'distributor', 'stockist',
  'agent', 'broker',
]);

// Company suffix tokens
const COMPANY_SUFFIXES = [
  'pvt ltd', 'pvt. ltd', 'pvt. ltd.', 'private limited',
  'ltd', 'limited', 'llp', 'llc', 'inc', 'incorporated',
  'corp', 'corporation', 'co.', ' co ',
  'industries', 'industry', 'enterprises', 'enterprise',
  'solutions', 'solution', 'systems', 'system',
  'technologies', 'technology', 'tech',
  'services', 'service', 'group',
  'labs', 'laboratory', 'laboratories',
  'trading', 'traders', 'trader',
  'exports', 'export', 'imports', 'import',
  'international', 'global',
  'associates', 'associate',
  'consultants', 'consulting',
  'constructions', 'construction',
  'infra', 'infrastructure',
  'foods', 'food', 'chemicals', 'chemical',
  'plastics', 'plastic', 'metals', 'metal', 'steel', 'iron', 'inox',
  'textiles', 'textile', 'fabrics', 'fabric',
  'pharma', 'pharmaceutical',
  'engineering', 'projects', 'project',
  'ventures', 'holdings',
];

// ─── Classifiers ──────────────────────────────────────────────────────────────

function looksLikeCompany(line: string): boolean {
  const lower = line.toLowerCase();
  return COMPANY_SUFFIXES.some(s => lower.includes(s));
}

function looksLikeDesignation(line: string): boolean {
  const lower = line.trim().toLowerCase();
  if (DESIGNATIONS.has(lower)) return true;
  for (const d of DESIGNATIONS) {
    if (lower === d || lower.startsWith(d + ' ') || lower.endsWith(' ' + d)) return true;
  }
  return false;
}

function looksLikeName(line: string): boolean {
  if (line.length < 3 || line.length > 55) return false;
  if (/\d/.test(line)) return false;
  if (looksLikeCompany(line)) return false;
  if (looksLikeDesignation(line)) return false;
  if (RE_NOISE.test(line)) return false;
  if (RE_ID_CODE.test(line)) return false;
  const words = line.trim().split(/\s+/);
  if (words.length < 1 || words.length > 6) return false;
  const titleCaseWords = words.filter(w => /^[A-Z][a-z]/.test(w));
  return titleCaseWords.length >= 1;
}

function looksLikeAddress(line: string): boolean {
  return RE_ADDRESS.test(line) || RE_PINCODE.test(line);
}

// ─── Text pre-processing ──────────────────────────────────────────────────────

// OCR often produces broken/hyphenated words at line ends, blank lines,
// and stray punctuation. Clean lightly — don't mangle real content.
function cleanOcrText(raw: string): string {
  return raw
    // Remove form-feed and other control chars
    .replace(/[\f\r]/g, '\n')
    // Collapse 3+ newlines to 2
    .replace(/\n{3,}/g, '\n\n')
    // Trim trailing spaces per line
    .split('\n').map(l => l.trimEnd()).join('\n')
    .trim();
}

// ─── Phone priority sorting ───────────────────────────────────────────────────
// Mirrors the AI prompt priority: mobile-labelled > mobile > ambiguous > landline.
// Used by the OCR fallback path — vision AI handles its own ordering.

const RE_MOBILE_LABEL  = /\b(mob(?:ile)?|cell(?:ular)?|m\s*:|whatsapp|wa\b|primary|direct)\b/i;
const RE_LANDLINE_LABEL = /\b(tel(?:ephone)?|office|off\b|fax|board|ext(?:ension)?|toll[\s-]?free|1800|1860)\b/i;

function phonePriority(phone: string, context: string): number {
  const digits = phone.replace(/\D/g, '');
  if (RE_MOBILE_LABEL.test(context))  return 0; // explicitly labelled mobile/WhatsApp
  if (RE_LANDLINE_LABEL.test(context)) return 3; // explicitly labelled landline/office
  if (/^(91|\+91)?[6-9]\d{9}$/.test(digits)) return 1; // Indian mobile
  if (digits.length >= 11 && digits.length <= 13) return 1; // intl mobile
  return 2; // ambiguous
}

function sortPhonesByPriority(phones: string[], fullText: string): string[] {
  if (phones.length <= 1) return phones;
  return [...phones].sort((a, b) => {
    const idxA = fullText.indexOf(a.slice(0, 8));
    const idxB = fullText.indexOf(b.slice(0, 8));
    const ctxA = idxA >= 0 ? fullText.slice(Math.max(0, idxA - 30), idxA + 40) : '';
    const ctxB = idxB >= 0 ? fullText.slice(Math.max(0, idxB - 30), idxB + 40) : '';
    return phonePriority(a, ctxA) - phonePriority(b, ctxB);
  });
}

// ─── Main parser ──────────────────────────────────────────────────────────────

export interface BusinessCardParseResult {
  fields: Partial<ManualEntryFields>;
  inferredFields: string[];
  ignoredLines: string[];
  addressLines: string[];
  confidence: OcrResult['confidence'];
}

export function parseBusinessCardText(raw: string): BusinessCardParseResult {
  const cleaned = cleanOcrText(raw);
  const lines = cleaned
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0);

  const fields: Partial<ManualEntryFields> = {};
  const inferredFields: string[] = [];
  const ignoredLines: string[] = [];
  const addressLines: string[] = [];
  const consumed = new Set<number>();

  // ── Pass 1: extract structured fields using regex scanning ───────────────
  // Scan the full text as one blob for email/phone/URL (more robust than per-line)
  const fullText = cleaned;

  // Emails
  const emailMatches = [...new Set([...fullText.matchAll(RE_EMAIL)].map(m => m[0].toLowerCase()))];
  if (emailMatches.length > 0) {
    fields.email = emailMatches[0];
    inferredFields.push('email');
    // Mark lines containing these emails as consumed
    lines.forEach((l, i) => {
      if (emailMatches.some(e => l.toLowerCase().includes(e))) consumed.add(i);
    });
  }

  // Phones — scan full text, deduplicate, then sort so the best primary is first
  const phoneMatches = sortPhonesByPriority(
    [...fullText.matchAll(RE_PHONE)]
      .map(m => m[0].trim())
      .filter(hasEnoughDigits)
      .filter((v, i, arr) => arr.indexOf(v) === i),
    fullText,
  );
  if (phoneMatches.length > 0) {
    fields.phone = phoneMatches[0];
    inferredFields.push('phone');
    lines.forEach((l, i) => {
      if (phoneMatches.some(p => l.includes(p.slice(0, 8)))) consumed.add(i);
    });
  }

  // URLs → notes
  const urlMatches = [...fullText.matchAll(RE_URL)].map(m => m[0]);
  if (urlMatches.length > 0) {
    fields.notes = urlMatches.join('\n');
    lines.forEach((l, i) => {
      if (urlMatches.some(u => l.includes(u.slice(0, 12)))) consumed.add(i);
    });
  }

  // ── Pass 2: noise and ID codes ────────────────────────────────────────────
  for (let i = 0; i < lines.length; i++) {
    if (consumed.has(i)) continue;
    const l = lines[i];
    if (RE_NOISE.test(l) || RE_ID_CODE.test(l) || l.length <= 1) {
      ignoredLines.push(l);
      consumed.add(i);
    }
  }

  // ── Pass 3: address lines ─────────────────────────────────────────────────
  for (let i = 0; i < lines.length; i++) {
    if (consumed.has(i)) continue;
    const l = lines[i];
    if (looksLikeAddress(l)) {
      addressLines.push(l);
      consumed.add(i);
    }
  }

  // ── Pass 4: company ───────────────────────────────────────────────────────
  for (let i = 0; i < lines.length; i++) {
    if (consumed.has(i)) continue;
    if (!fields.company && looksLikeCompany(lines[i])) {
      fields.company = lines[i];
      inferredFields.push('company');
      consumed.add(i);
      break;
    }
  }

  // ── Pass 5: designation ───────────────────────────────────────────────────
  for (let i = 0; i < lines.length; i++) {
    if (consumed.has(i)) continue;
    if (!fields.designation && looksLikeDesignation(lines[i])) {
      fields.designation = lines[i];
      inferredFields.push('designation');
      consumed.add(i);
      break;
    }
  }

  // ── Pass 6: name — first name-like remaining line ─────────────────────────
  for (let i = 0; i < lines.length; i++) {
    if (consumed.has(i)) continue;
    if (!fields.clientName && looksLikeName(lines[i])) {
      fields.clientName = lines[i];
      inferredFields.push('clientName');
      consumed.add(i);
      break;
    }
  }

  // ── Pass 7: remaining unconsumed → noise bucket ───────────────────────────
  for (let i = 0; i < lines.length; i++) {
    if (!consumed.has(i)) ignoredLines.push(lines[i]);
  }

  // ── Confidence scoring ────────────────────────────────────────────────────
  const fieldCount = inferredFields.length;
  const hasCore = !!(fields.clientName || fields.company);
  const hasContact = !!(fields.phone || fields.email);

  const confidence: OcrResult['confidence'] =
    (hasCore && hasContact && fieldCount >= 3) ? 'high' :
    (hasCore || hasContact) && fieldCount >= 2 ? 'medium' :
    'low';

  return { fields, inferredFields, ignoredLines, addressLines, confidence };
}
