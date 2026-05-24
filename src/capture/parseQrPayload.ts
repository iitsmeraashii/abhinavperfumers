// Pure parsing utilities — no side effects, no imports outside stdlib.
// Supports: vCard 2.1/3.0, MECARD, URL, plain-text contact,
//           and semi-structured exhibition/event QR text blocks.

import type { ManualEntryFields } from './types';

export type QrContentType =
  | 'vcard'
  | 'mecard'
  | 'url'
  | 'plaintext'
  | 'exhibition'
  | 'unknown';

/** How confident we are in the extracted data. */
export type ExtractionConfidence = 'high' | 'medium' | 'low';

/** Which parsing strategy produced the result. */
export type ExtractionStrategy = 'vcard' | 'mecard' | 'url' | 'heuristic' | 'none';

export interface ParsedContact {
  fields: Partial<ManualEntryFields>;
  /** Raw QR text for draftData.rawQr */
  raw: string;
  /** True when at least one named contact field was extracted */
  hasData: boolean;
  /** Content classification for contextual UI messages */
  qrType: QrContentType;
  /** Parsing strategy used — drives "inferred" UX copy */
  extractionStrategy: ExtractionStrategy;
  /** Rough confidence for debug overlay */
  confidence: ExtractionConfidence;
  /** Lines the heuristic pipeline classified as noise */
  ignoredLines: string[];
}

// ─── Regex constants ──────────────────────────────────────────────────────────

const RE_PHONE = /^[+]?[\d][\d\s\-().]{6,}[\d]$/;
const RE_EMAIL = /^[\w.+\-]+@[\w\-]+\.[a-z]{2,}$/i;

// Lines that start with or contain these are almost certainly event noise
const RE_NOISE = /\b(expo|exhibition|fair|summit|fest|pass|ticket|badge|entry|visitor|delegate|conference|hall|pavilion|stall|booth|edition|mumbai|delhi|bangalore|chennai|hyderabad|kolkata|pune|ahmedabad|2024|2025|2026|day pass|\d{1,2}[\s-]day)\b/i;

// Alphanumeric ID codes — e.g. CMPL-IV26-26223, QR12345, REG/2026/001
const RE_ID_CODE = /^[A-Z]{2,}[-/][A-Z0-9]+[-/]?[A-Z0-9]*$/i;

// Designation keyword list — intentionally broad to cover common Indian business titles
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

// Company suffix tokens — if a line contains any of these it's likely a company
const COMPANY_SUFFIXES = [
  'pvt ltd', 'pvt. ltd', 'pvt. ltd.', 'private limited',
  'ltd', 'limited',
  'llp', 'llc',
  'inc', 'incorporated',
  'corp', 'corporation',
  'co.', ' co ',
  'industries', 'industry',
  'enterprises', 'enterprise',
  'solutions', 'solution',
  'systems', 'system',
  'technologies', 'technology', 'tech',
  'services', 'service',
  'group',
  'labs', 'laboratory', 'laboratories',
  'trading', 'traders', 'trader',
  'exports', 'export',
  'imports', 'import',
  'international',
  'global',
  'associates', 'associate',
  'consultants', 'consulting',
  'constructions', 'construction',
  'infra', 'infrastructure',
  'foods', 'food',
  'chemicals', 'chemical',
  'plastics', 'plastic',
  'metals', 'metal', 'steel', 'iron', 'inox',
  'textiles', 'textile', 'fabrics', 'fabric',
  'pharma', 'pharmaceutical',
  'engineering',
  'projects', 'project',
  'ventures',
  'holdings',
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function looksLikeCompany(line: string): boolean {
  const lower = line.toLowerCase();
  return COMPANY_SUFFIXES.some(s => lower.includes(s));
}

function looksLikeDesignation(line: string): boolean {
  const lower = line.trim().toLowerCase();
  // Exact match first
  if (DESIGNATIONS.has(lower)) return true;
  // Multi-word: "Sales Head", "Purchase Manager", etc.
  for (const d of DESIGNATIONS) {
    if (lower === d || lower.startsWith(d + ' ') || lower.endsWith(' ' + d)) return true;
  }
  return false;
}

/** A "name-like" line is short, title-case, has no digits, and isn't noise/company/designation. */
function looksLikeName(line: string): boolean {
  if (line.length < 3 || line.length > 50) return false;
  if (/\d/.test(line)) return false;
  if (looksLikeCompany(line)) return false;
  if (looksLikeDesignation(line)) return false;
  if (RE_NOISE.test(line)) return false;
  if (RE_ID_CODE.test(line)) return false;
  // Must have at least one word that starts with an uppercase letter
  const words = line.trim().split(/\s+/);
  if (words.length < 1 || words.length > 5) return false;
  const titleCaseWords = words.filter(w => /^[A-Z][a-z]/.test(w));
  return titleCaseWords.length >= 1;
}

// ─── vCard ────────────────────────────────────────────────────────────────────

function parseVCard(text: string): Partial<ManualEntryFields> | null {
  if (!/BEGIN:VCARD/i.test(text)) return null;

  const get = (re: RegExp): string =>
    (text.match(re)?.[1] ?? '').trim()
      .replace(/\\,/g, ',')
      .replace(/\\;/g, ';')
      .replace(/\\n/gi, ' ');

  const fn = get(/^FN[^:]*:(.+)$/im);

  let name = fn;
  if (!name) {
    const n = get(/^N[^:]*:(.+)$/im);
    if (n) {
      const parts = n.split(';').map(s => s.trim()).filter(Boolean);
      name = [parts[1], parts[2], parts[0]].filter(Boolean).join(' ');
    }
  }

  const org   = get(/^ORG[^:]*:(.+)$/im).split(';')[0];
  const tel   = get(/^TEL[^:]*:(.+)$/im);
  const email = get(/^EMAIL[^:]*:(.+)$/im);
  const title = get(/^TITLE[^:]*:(.+)$/im);
  const note  = get(/^NOTE[^:]*:(.+)$/im);

  if (!name && !org && !tel && !email) return null;

  return {
    clientName:  name  || undefined,
    company:     org   || undefined,
    phone:       tel   || undefined,
    email:       email || undefined,
    designation: title || undefined,
    notes:       note  || undefined,
  };
}

// ─── MECARD ───────────────────────────────────────────────────────────────────

function parseMeCard(text: string): Partial<ManualEntryFields> | null {
  if (!/^MECARD:/i.test(text)) return null;

  const get = (key: string): string => {
    const m = text.match(new RegExp(`${key}:([^;]+)`, 'i'));
    return (m?.[1] ?? '').trim();
  };

  const rawName = get('N');
  let name = '';
  if (rawName) {
    const parts = rawName.split(',').map(s => s.trim()).filter(Boolean);
    name = parts.length === 2 ? `${parts[1]} ${parts[0]}` : parts[0];
  }

  const org   = get('ORG');
  const tel   = get('TEL');
  const email = get('EMAIL');
  const note  = get('NOTE');

  if (!name && !org && !tel && !email) return null;

  return {
    clientName:  name  || undefined,
    company:     org   || undefined,
    phone:       tel   || undefined,
    email:       email || undefined,
    notes:       note  || undefined,
  };
}

// ─── URL QR ───────────────────────────────────────────────────────────────────

function parseUrl(text: string): Partial<ManualEntryFields> | null {
  if (!/^https?:\/\//i.test(text.trim())) return null;
  return { notes: text.trim() };
}

// ─── Plain-text heuristics (original simple path) ─────────────────────────────

function parsePlainText(text: string): Partial<ManualEntryFields> | null {
  const lines = text.split(/\t|\r?\n/).map(l => l.trim()).filter(Boolean);
  if (lines.length === 0) return null;

  const fields: Partial<ManualEntryFields> = {};

  for (const line of lines) {
    if (!fields.phone && RE_PHONE.test(line.replace(/[\s\-().]/g, '') ? line : '')) {
      if (/\d{7,}/.test(line.replace(/[\s\-().]/g, ''))) {
        fields.phone = line;
        continue;
      }
    }
    if (!fields.email && RE_EMAIL.test(line)) {
      fields.email = line;
      continue;
    }
    if (/^https?:\/\//i.test(line)) {
      fields.notes = (fields.notes ? fields.notes + '\n' : '') + line;
      continue;
    }
  }

  const nameLine = lines.find(l =>
    !/\d{7,}/.test(l) && !/@/.test(l) && !/^https?:\/\//i.test(l),
  );
  if (nameLine) fields.clientName = nameLine;

  if (!fields.clientName && !fields.phone && !fields.email) return null;
  return fields;
}

// ─── Exhibition / semi-structured heuristic pipeline ─────────────────────────
//
// Applied when all structured parsers fail. Works line-by-line, classifying
// each line into a role (phone, email, designation, company, name, noise)
// and then assembles the best-fit contact record.
//
// Returns the extracted fields plus two metadata arrays:
//   inferredFields — labels for what was successfully inferred
//   ignoredLines   — lines discarded as noise

export interface HeuristicResult {
  fields: Partial<ManualEntryFields>;
  inferredFields: string[];
  ignoredLines: string[];
  confidence: ExtractionConfidence;
}

export function parseExhibitionText(text: string): HeuristicResult | null {
  // Split on newlines OR tabs — many real-world QR codes use tabs as field separators
  const rawLines = text.split(/\t|\r?\n/).map(l => l.trim()).filter(Boolean);
  if (rawLines.length === 0) return null;

  const fields: Partial<ManualEntryFields> = {};
  const inferredFields: string[] = [];
  const ignoredLines: string[] = [];

  // Tracks which lines have been consumed so we don't double-assign
  const consumed = new Set<number>();

  // ── Pass 1: unambiguous structured fields ────────────────────────────────
  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i];
    const stripped = line.replace(/[\s\-().]/g, '');

    // Phone — starts with + or digit, 7+ consecutive digits after stripping
    if (!fields.phone && /^[+\d]/.test(line) && /\d{7,}/.test(stripped)) {
      fields.phone = line;
      inferredFields.push('phone');
      consumed.add(i);
      continue;
    }

    // Email
    if (!fields.email && RE_EMAIL.test(line)) {
      fields.email = line;
      inferredFields.push('email');
      consumed.add(i);
      continue;
    }
  }

  // ── Pass 2: noise / ID codes ─────────────────────────────────────────────
  for (let i = 0; i < rawLines.length; i++) {
    if (consumed.has(i)) continue;
    const line = rawLines[i];

    if (RE_NOISE.test(line) || RE_ID_CODE.test(line)) {
      ignoredLines.push(line);
      consumed.add(i);
    }
  }

  // ── Pass 3: company ───────────────────────────────────────────────────────
  for (let i = 0; i < rawLines.length; i++) {
    if (consumed.has(i)) continue;
    const line = rawLines[i];

    if (!fields.company && looksLikeCompany(line)) {
      fields.company = line;
      inferredFields.push('company');
      consumed.add(i);
      break;
    }
  }

  // ── Pass 4: designation ───────────────────────────────────────────────────
  for (let i = 0; i < rawLines.length; i++) {
    if (consumed.has(i)) continue;
    const line = rawLines[i];

    if (!fields.designation && looksLikeDesignation(line)) {
      fields.designation = line;
      inferredFields.push('designation');
      consumed.add(i);
      break;
    }
  }

  // ── Pass 5: name — first remaining line that looks name-like ─────────────
  for (let i = 0; i < rawLines.length; i++) {
    if (consumed.has(i)) continue;
    const line = rawLines[i];

    if (!fields.clientName && looksLikeName(line)) {
      fields.clientName = line;
      inferredFields.push('clientName');
      consumed.add(i);
      break;
    }
  }

  // ── Pass 6: remaining unconsumed lines → noise bucket ────────────────────
  for (let i = 0; i < rawLines.length; i++) {
    if (!consumed.has(i)) {
      ignoredLines.push(rawLines[i]);
    }
  }

  // Require at least one meaningful contact signal to return a result
  const hasContact = !!(fields.clientName || fields.company || fields.phone || fields.email);
  if (!hasContact) return null;

  // Confidence scoring: more fields = more confident
  const fieldCount = inferredFields.length;
  const confidence: ExtractionConfidence =
    fieldCount >= 4 ? 'high' :
    fieldCount >= 2 ? 'medium' :
    'low';

  return { fields, inferredFields, ignoredLines, confidence };
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function parseQrPayload(raw: string): ParsedContact {
  const text = raw.trim();

  let qrType: QrContentType = 'unknown';
  let extractionStrategy: ExtractionStrategy = 'none';
  let parsed: Partial<ManualEntryFields> | null = null;
  let ignoredLines: string[] = [];
  let confidence: ExtractionConfidence = 'low';

  if ((parsed = parseVCard(text))) {
    qrType = 'vcard';
    extractionStrategy = 'vcard';
    confidence = 'high';
  } else if ((parsed = parseMeCard(text))) {
    qrType = 'mecard';
    extractionStrategy = 'mecard';
    confidence = 'high';
  } else if ((parsed = parseUrl(text))) {
    qrType = 'url';
    extractionStrategy = 'url';
    confidence = 'high';
  } else {
    // Try exhibition/semi-structured heuristic pipeline first for multi-line/tab-delimited text
    const lines = text.split(/\t|\r?\n/).filter(l => l.trim().length > 0);
    if (lines.length >= 2) {
      const heuristic = parseExhibitionText(text);
      if (heuristic) {
        parsed = heuristic.fields;
        ignoredLines = heuristic.ignoredLines;
        confidence = heuristic.confidence;
        qrType = 'exhibition';
        extractionStrategy = 'heuristic';
      }
    }

    // Fall back to the original simple single-line plaintext path
    if (!parsed) {
      parsed = parsePlainText(text) ?? {};
      if (parsed && (parsed.clientName || parsed.phone || parsed.email)) {
        qrType = 'plaintext';
        extractionStrategy = 'heuristic';
        confidence = 'medium';
      }
    }
  }

  if (!parsed) parsed = {};

  const hasData = !!(
    parsed.clientName || parsed.company || parsed.phone || parsed.email
  );

  // Remove undefined keys so spread-merges work cleanly
  const fields = Object.fromEntries(
    Object.entries(parsed).filter(([, v]) => v !== undefined),
  ) as Partial<ManualEntryFields>;

  return {
    fields,
    raw: text,
    hasData,
    qrType,
    extractionStrategy,
    confidence,
    ignoredLines,
  };
}


export { parseQrPayload }