// Pure parsing utilities — no side effects, no imports outside stdlib.
// Supports: vCard 2.1/3.0, MECARD, plain-text contact, bare URL.

import type { ManualEntryFields } from './types';

export interface ParsedContact {
  fields: Partial<ManualEntryFields>;
  /** Raw QR text for draftData.rawQr */
  raw: string;
  /** True when at least one named field was extracted */
  hasData: boolean;
}

// ─── vCard ────────────────────────────────────────────────────────────────────

function parseVCard(text: string): Partial<ManualEntryFields> | null {
  if (!/BEGIN:VCARD/i.test(text)) return null;

  const get = (re: RegExp): string =>
    (text.match(re)?.[1] ?? '').trim().replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\n/gi, ' ');

  // FN line gives the formatted name (most reliable)
  const fn = get(/^FN[^:]*:(.+)$/im);

  // N: Last;First;Middle;Prefix;Suffix
  let name = fn;
  if (!name) {
    const n = get(/^N[^:]*:(.+)$/im);
    if (n) {
      const parts = n.split(';').map(s => s.trim()).filter(Boolean);
      // vCard N order: Last, First, Middle — reverse for display
      name = [parts[1], parts[2], parts[0]].filter(Boolean).join(' ');
    }
  }

  const org  = get(/^ORG[^:]*:(.+)$/im).split(';')[0];
  const tel  = get(/^TEL[^:]*:(.+)$/im);
  const email = get(/^EMAIL[^:]*:(.+)$/im);
  const title = get(/^TITLE[^:]*:(.+)$/im);
  const note  = get(/^NOTE[^:]*:(.+)$/im);

  if (!name && !org && !tel && !email) return null;

  return {
    clientName:  name    || undefined,
    company:     org     || undefined,
    phone:       tel     || undefined,
    email:       email   || undefined,
    designation: title   || undefined,
    notes:       note    || undefined,
  };
}

// ─── MECARD ───────────────────────────────────────────────────────────────────
// Format: MECARD:N:Last,First;ORG:Acme;TEL:+91...;EMAIL:...;NOTE:...;;

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
    // MECARD N order: Last,First
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

// ─── Plain-text heuristics ───────────────────────────────────────────────────
// Many trade-show QR codes are just free-form text blocks.

function parsePlainText(text: string): Partial<ManualEntryFields> | null {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (lines.length === 0) return null;

  const fields: Partial<ManualEntryFields> = {};

  for (const line of lines) {
    // Phone: starts with +, or contains 7+ consecutive digits
    if (!fields.phone && /^[+\d]/.test(line) && /\d{7,}/.test(line.replace(/[\s\-().]/g, ''))) {
      fields.phone = line;
      continue;
    }
    // Email
    if (!fields.email && /^[\w.+\-]+@[\w\-]+\.[a-z]{2,}$/i.test(line)) {
      fields.email = line;
      continue;
    }
    // URL — store as note, don't autofill as name
    if (/^https?:\/\//i.test(line)) {
      fields.notes = (fields.notes ? fields.notes + '\n' : '') + line;
      continue;
    }
  }

  // First non-phone/non-email/non-url line is probably the name
  const nameLine = lines.find(l =>
    !/\d{7,}/.test(l) &&
    !/@/.test(l) &&
    !/^https?:\/\//i.test(l),
  );
  if (nameLine) fields.clientName = nameLine;

  if (!fields.clientName && !fields.phone && !fields.email) return null;
  return fields;
}

// ─── URL QR ───────────────────────────────────────────────────────────────────

function parseUrl(text: string): Partial<ManualEntryFields> | null {
  if (!/^https?:\/\//i.test(text.trim())) return null;
  return { notes: text.trim() };
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function parseQrPayload(raw: string): ParsedContact {
  const text = raw.trim();

  const parsed =
    parseVCard(text) ??
    parseMeCard(text) ??
    parseUrl(text) ??
    parsePlainText(text) ??
    {};

  const hasData = !!(
    parsed.clientName || parsed.company || parsed.phone || parsed.email
  );

  // Remove undefined keys so spread-merges work cleanly
  const fields = Object.fromEntries(
    Object.entries(parsed).filter(([, v]) => v !== undefined),
  ) as Partial<ManualEntryFields>;

  return { fields, raw: text, hasData };
}
