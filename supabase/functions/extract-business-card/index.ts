import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

// ─── Extraction schema ────────────────────────────────────────────────────────

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
  "rawText": ""
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
      max_tokens: 1024,
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
