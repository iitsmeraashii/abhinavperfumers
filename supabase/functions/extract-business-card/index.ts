import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

// ─── Extraction schema ────────────────────────────────────────────────────────

interface FieldConfidenceReport {
  fullName?:     number;
  company?:      number;
  designation?:  number;
  website?:      number;
  address?:      number;
  phoneNumbers?: number[];
  emails?:       number[];
}

type FieldExtractionStatus = 'extracted' | 'absent' | 'uncertain';

interface FieldStatusReport {
  fullName?:     FieldExtractionStatus;
  company?:      FieldExtractionStatus;
  designation?:  FieldExtractionStatus;
  website?:      FieldExtractionStatus;
  address?:      FieldExtractionStatus;
  phoneNumbers?: FieldExtractionStatus[];
  emails?:       FieldExtractionStatus[];
}

interface ExtractionResult {
  fullName:       string;
  firstName:      string;
  lastName:       string;
  company:        string;
  designation:    string;
  emails:         string[];
  phoneNumbers:   string[];
  website:        string;
  address:        string;
  confidence:     number;
  notes:          string;
  rawText:        string;
  /** Model-reported per-field confidence. Optional — absent until the
   *  prompt is extended to request it. */
  fieldConfidence?: FieldConfidenceReport;
  fieldStatus?: FieldStatusReport;
}

const EMPTY_RESULT: ExtractionResult = {
  fullName: "", firstName: "", lastName: "", company: "",
  designation: "", emails: [], phoneNumbers: [], website: "",
  address: "", confidence: 0, notes: "", rawText: "",
};

// ─── Validation / normalization ───────────────────────────────────────────────

function normalizeEmail(email: string): string | null {
  const e = email.toLowerCase().replace(/\s+/g, "");
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : null;
}

function normalizePhone(phone: string): string {
  // Keep digits, +, -, spaces, parens — strip everything else
  return phone.replace(/[^\d+\-\s()]/g, "").trim();
}

function clamp01(v: unknown): number | undefined {
  if (typeof v !== "number" || !isFinite(v)) return undefined;
  return Math.min(1, Math.max(0, v));
}

function normalizeConfidenceArray(
  arr: unknown,
  expectedLength: number,
): number[] | undefined {
  if (!Array.isArray(arr)) return undefined;
  const out: number[] = [];
  for (let i = 0; i < Math.min(arr.length, expectedLength); i++) {
    const c = clamp01(arr[i]);
    if (c !== undefined) out.push(c);
  }
  return out.length > 0 ? out : undefined;
}

function normalizeFieldConfidence(
  raw: unknown,
  emails: string[],
  phoneNumbers: string[],
): FieldConfidenceReport | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  const report: FieldConfidenceReport = {};

  const fc = clamp01(r.fullName);
  if (fc !== undefined) report.fullName = fc;

  const cc = clamp01(r.company);
  if (cc !== undefined) report.company = cc;

  const dc = clamp01(r.designation);
  if (dc !== undefined) report.designation = dc;

  const wc = clamp01(r.website);
  if (wc !== undefined) report.website = wc;

  const ac = clamp01(r.address);
  if (ac !== undefined) report.address = ac;

  const pc = normalizeConfidenceArray(r.phoneNumbers, phoneNumbers.length);
  if (pc !== undefined) report.phoneNumbers = pc;

  const ec = normalizeConfidenceArray(r.emails, emails.length);
  if (ec !== undefined) report.emails = ec;

  return Object.keys(report).length > 0 ? report : undefined;
}

function normalizeFieldStatus(
  raw: unknown,
  emails: string[],
  phoneNumbers: string[],
): FieldStatusReport | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  const report: FieldStatusReport = {};

  const valid: FieldExtractionStatus[] = ['extracted', 'absent', 'uncertain'];

  const check = (v: unknown): FieldExtractionStatus | undefined =>
    typeof v === 'string' && valid.includes(v as FieldExtractionStatus)
      ? v as FieldExtractionStatus
      : undefined;

  const fs = check(r.fullName);
  if (fs) report.fullName = fs;
  const cs = check(r.company);
  if (cs) report.company = cs;
  const ds = check(r.designation);
  if (ds) report.designation = ds;
  const ws = check(r.website);
  if (ws) report.website = ws;
  const as_ = check(r.address);
  if (as_) report.address = as_;

  if (Array.isArray(r.phoneNumbers)) {
    const arr: FieldExtractionStatus[] = [];
    for (let i = 0; i < r.phoneNumbers.length; i++) {
      const s = check(r.phoneNumbers[i]);
      if (s) arr.push(s);
    }
    if (arr.length > 0) report.phoneNumbers = arr;
  }

  if (Array.isArray(r.emails)) {
    const arr: FieldExtractionStatus[] = [];
    for (let i = 0; i < r.emails.length; i++) {
      const s = check(r.emails[i]);
      if (s) arr.push(s);
    }
    if (arr.length > 0) report.emails = arr;
  }

  return Object.keys(report).length > 0 ? report : undefined;
}

function validateAndNormalize(raw: Partial<ExtractionResult>): ExtractionResult {
  const emails = (raw.emails ?? [])
    .flatMap(e => e.split(/[,;]/))
    .map(e => normalizeEmail(e))
    .filter((e): e is string => e !== null)
    .filter((e, i, a) => a.indexOf(e) === i);

  const phoneNumbers = (raw.phoneNumbers ?? [])
    .flatMap(p => p.split(/[,;\/]/))
    .map(normalizePhone)
    .filter(p => p.replace(/\D/g, "").length >= 7)
    .filter((p, i, a) => a.indexOf(p) === i);

  const fullName = (raw.fullName ?? "").trim();
  const parts = fullName.split(/\s+/);

  return {
    fullName,
    firstName:    raw.firstName?.trim() || (parts[0] ?? ""),
    lastName:     raw.lastName?.trim()  || (parts.slice(1).join(" ")),
    company:      (raw.company      ?? "").trim(),
    designation:  (raw.designation  ?? "").trim(),
    website:      (raw.website      ?? "").trim(),
    address:      (raw.address      ?? "").trim(),
    notes:        (raw.notes        ?? "").trim(),
    rawText:      (raw.rawText      ?? "").trim(),
    emails,
    phoneNumbers,
    confidence:   Math.min(1, Math.max(0, raw.confidence ?? 0)),
    fieldConfidence: normalizeFieldConfidence(raw.fieldConfidence, emails, phoneNumbers),
    fieldStatus: normalizeFieldStatus(raw.fieldStatus, emails, phoneNumbers),
  };
}

// ─── Image preprocessing ──────────────────────────────────────────────────────
// Converts FormData image to base64 for OpenAI vision.
// Edge runtime has no Canvas API — preprocessing (resize/sharpen) is done
// on the frontend before upload, so we just base64-encode here.

async function imageToBase64(blob: Blob): Promise<{ b64: string; mime: string }> {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  const b64 = btoa(binary);
  const mime = blob.type || "image/jpeg";
  return { b64, mime };
}

// ─── OpenAI Vision extraction ─────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are an intelligent business card extraction engine.

Extract information ONLY from the provided business card image.

Rules:
- Return valid JSON only, no markdown, no code fences
- Do not hallucinate missing data — leave fields empty strings or empty arrays
- Preserve exact phone numbers as shown on card
- Preserve exact email spellings
- Split multiple phone numbers into the phoneNumbers array
- Split multiple emails into the emails array
- Remove spaces from email addresses
- Normalize phone numbers (keep country codes if visible)
- Infer full name carefully from the most prominent name text
- Infer company separately from designation/job title
- Ignore logos, decorative graphics, and purely visual elements
- confidence should be 0.0 to 1.0 reflecting overall extraction quality
- If uncertain about a field, leave it as empty string or empty array
- rawText should contain ALL visible text on the card, line by line

CRITICAL — Do NOT fabricate obscured or partial phone numbers:
- Never reconstruct missing phone digits.
- Never guess obscured, masked, blurred, cropped, or partially unreadable digits.
- If a phone number is partially visible (e.g. "+91 98 XXXX 344"), do NOT invent
  the missing digits to produce an apparently complete number.
- Do not convert partially visible or masked phone numbers into apparently
  complete phone numbers.
- If you cannot reliably read the complete phone number, either omit it entirely
  (empty array) or return only the digits you can clearly see, but do NOT present
  an invented complete number.
- Returning no phone number is always better than returning a fabricated one.

Phone number ordering — CRITICAL:
The first entry in phoneNumbers MUST be the best primary contact number for WhatsApp/mobile use.
Apply this priority order when sorting phoneNumbers:
1. HIGHEST PRIORITY — Any number that is visually emphasised on the card:
   circled, underlined, starred (*), ticked (✓), highlighted, or annotated with
   "mobile", "mob", "m:", "cell", "whatsapp", "wa", "primary", "direct" (case-insensitive).
   Place this number first regardless of type.
2. SECOND — Mobile / cell numbers that are NOT emphasised:
   - Indian mobile: 10 digits starting with 6, 7, 8, or 9 (with or without +91 / 91 prefix)
   - International mobile: country code followed by a 9-10 digit mobile-range number
   - Numbers labelled "mob", "cell", "m:" even without emphasis
3. THIRD — Numbers with no clear type classification (ambiguous length or format)
4. LAST — Landline / office numbers:
   - Indian landline: area code (2-4 digits) + 6-8 digit number, often shown with STD code in parentheses
   - Numbers labelled "tel", "office", "off", "fax", "direct", "board", "ext"
   - Numbers starting with 1800, 1860 (toll-free)

Within each priority tier, preserve the original card order.
If only one number exists, place it first regardless of type.

Field-level confidence — IMPORTANT:
In addition to the overall "confidence" field, you MUST include a "fieldConfidence" object
that reports your confidence in the correctness of EACH extracted value individually.

The overall "confidence" reflects the extraction as a whole.
fieldConfidence values reflect whether THIS SPECIFIC extracted value is correct.

DO NOT simply copy the overall confidence into every field.
A field can have a much lower confidence than the overall score if the evidence
for that specific field is ambiguous, partially obscured, or difficult to read.
For example, it is valid and expected to return overall confidence 0.90 but
fieldConfidence.phoneNumbers[0] = 0.45 if the phone number is hard to read.

If a phone number, email, or website is blurred, masked, or partially unreadable
and you decide to include it, its fieldConfidence MUST be low (e.g. below 0.6)
to reflect that the value may be incomplete or unreliable.

fieldConfidence rules:
- Every value must be a number between 0.0 and 1.0.
- Only include keys for fields that were actually extracted (non-empty).
- If a field was not extracted (empty string or empty array), omit its key entirely.
  Do NOT invent confidence values for missing fields.
- For array fields (phoneNumbers, emails), return exactly one confidence value
  per extracted entry, in the same order as the array.
  phoneNumbers[0] confidence corresponds to phoneNumbers[0] value.
  emails[0] confidence corresponds to emails[0] value.
- If a field has a single clear value that is easy to read, confidence should be high (e.g. 0.9+).
- If a field value is ambiguous, partially cut off, or requires inference, confidence should be lower.
- Do NOT change whether a field is extracted based on confidence.
  If the existing rules say to leave a field empty when uncertain, keep it empty.
  fieldConfidence exposes uncertainty in extracted values — it does not encourage
  extracting uncertain values.

Field extraction status — IMPORTANT:
In addition to "fieldConfidence", you MUST include a "fieldStatus" object that
classifies each field's extraction outcome as one of:
  - "extracted": The field is present on the card AND a usable value was extracted.
  - "absent":    The field is genuinely not present on the card at all.
  - "uncertain": The field appears to be present on the card, but the value cannot
                 be reliably determined because it is blurry, obscured, partially
                 visible, illegible, or ambiguous.

CRITICAL — uncertain fields:
If a phone number, email, or website is visibly present but cannot be confidently
read, DO NOT invent or reconstruct the missing characters. Instead:
  - Return an empty value (empty string or empty array) for that field.
  - Mark the field as "uncertain" in fieldStatus.
  - This signals that a human reviewer should check the original card.

For array fields (phoneNumbers, emails):
  - Provide one fieldStatus entry per attempted field on the card.
  - If the card has one phone number that is unclear:
      phoneNumbers: []
      fieldStatus.phoneNumbers: ["uncertain"]
  - If the card has two phone numbers, one clear and one unclear:
      phoneNumbers: ["+919876543210"]
      fieldStatus.phoneNumbers: ["extracted", "uncertain"]
  - If the card genuinely has no phone number:
      phoneNumbers: []
      fieldStatus.phoneNumbers: ["absent"]
  - If the card has no phone number at all, omit the phoneNumbers key from fieldStatus entirely,
    OR set it to ["absent"].

Do NOT mark a field as "uncertain" if it is simply not on the card — use "absent" instead.
Do NOT mark a field as "absent" if it IS on the card but hard to read — use "uncertain" instead.

Return ONLY valid JSON matching this exact schema:
{
  "fullName": "",
  "firstName": "",
  "lastName": "",
  "company": "",
  "designation": "",
  "emails": [],
  "phoneNumbers": [],
  "website": "",
  "address": "",
  "confidence": 0.0,
  "notes": "",
  "rawText": "",
  "fieldConfidence": {
    "fullName": 0.0,
    "company": 0.0,
    "designation": 0.0,
    "website": 0.0,
    "address": 0.0,
    "phoneNumbers": [0.0],
    "emails": [0.0]
  },
  "fieldStatus": {
    "fullName": "extracted",
    "company": "extracted",
    "designation": "extracted",
    "website": "extracted",
    "address": "extracted",
    "phoneNumbers": ["extracted"],
    "emails": ["extracted"]
  }
}`;

async function callOpenAIVision(
  b64Image: string,
  mimeType: string,
  apiKey: string,
): Promise<ExtractionResult> {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o",
      messages: [
        {
          role: "system",
          content: SYSTEM_PROMPT,
        },
        {
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: {
                url: `data:${mimeType};base64,${b64Image}`,
                detail: "high",
              },
            },
            {
              type: "text",
              text: "Extract all contact information from this business card. Return valid JSON only.",
            },
          ],
        },
      ],
      max_tokens: 1400,
      temperature: 0.1,
    }),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "unknown error");
    throw new Error(`OpenAI API error ${response.status}: ${errText.slice(0, 300)}`);
  }

  const json = await response.json();

  const text: string = json?.choices?.[0]?.message?.content ?? "";
  if (!text) throw new Error("OpenAI returned empty response");

  // Strip markdown code fences if present
  const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();

  let parsed: Partial<ExtractionResult>;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error(`OpenAI returned invalid JSON: ${cleaned.slice(0, 200)}`);
  }

  return validateAndNormalize(parsed);
}

// ─── Handler ──────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const apiKey = Deno.env.get("OPENAI_API_KEY");
    if (!apiKey) {
      return new Response(
        JSON.stringify({ error: "OPENAI_API_KEY not configured" }),
        { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    if (req.method !== "POST") {
      return new Response(
        JSON.stringify({ error: "Method not allowed" }),
        { status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const startMs = Date.now();
    let imageBlob: Blob;

    const contentType = req.headers.get("content-type") ?? "";

    if (contentType.includes("multipart/form-data")) {
      const form = await req.formData();
      const file = form.get("image");
      if (!file || !(file instanceof File)) {
        return new Response(
          JSON.stringify({ error: "Missing 'image' field in form data" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      imageBlob = file;
    } else if (contentType.includes("application/json")) {
      const body = await req.json();
      // Accept base64 directly from frontend
      if (!body.imageBase64) {
        return new Response(
          JSON.stringify({ error: "Missing imageBase64 field" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      // Reconstruct blob for consistency
      const binaryStr = atob(body.imageBase64);
      const bytes = new Uint8Array(binaryStr.length);
      for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
      imageBlob = new Blob([bytes], { type: body.mimeType ?? "image/jpeg" });
    } else {
      // Treat raw body as image
      const buffer = await req.arrayBuffer();
      imageBlob = new Blob([buffer], { type: contentType || "image/jpeg" });
    }

    const { b64, mime } = await imageToBase64(imageBlob);

    // Attempt extraction with one automatic retry on failure
    let result: ExtractionResult;
    let attempt = 1;

    try {
      result = await callOpenAIVision(b64, mime, apiKey);
    } catch (firstErr) {
      attempt = 2;
      console.warn("[extract-business-card] first attempt failed, retrying:", firstErr);
      try {
        result = await callOpenAIVision(b64, mime, apiKey);
      } catch (secondErr) {
        throw secondErr;
      }
    }

    const durationMs = Date.now() - startMs;

    return new Response(
      JSON.stringify({
        success:     true,
        data:        result,
        durationMs,
        attempt,
        model:       "gpt-4o",
      }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );

  } catch (err) {
    console.error("[extract-business-card] error:", err);
    const msg = err instanceof Error ? err.message : String(err);
    return new Response(
      JSON.stringify({ success: false, error: msg }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
