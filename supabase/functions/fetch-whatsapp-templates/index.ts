import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

interface MetaTemplate {
  name: string;
  parameter_format: string;
  components: MetaComponent[];
  id: string;
  status: string;
  category: string;
  language: string;
}

interface MetaComponent {
  type: string;
  format?: string;
  text?: string;
  example?: Record<string, unknown>;
}

interface MetaResponse {
  data: MetaTemplate[];
  paging?: {
    cursors?: { before?: string; after?: string };
    next?: string;
  };
}

interface FetchTemplatesResult {
  templates: MetaTemplate[];
  hasMore: boolean;
  nextCursor: string | null;
}

function hasImageHeader(components: MetaComponent[]): boolean {
  return components.some(
    (c) => c.type === "HEADER" && c.format === "IMAGE",
  );
}

async function fetchPage(url: string, token: string): Promise<MetaResponse> {
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Meta API error ${resp.status}: ${body}`);
  }
  return (await resp.json()) as MetaResponse;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  if (req.method !== "GET") {
    return new Response(
      JSON.stringify({ error: "Method not allowed" }),
      { status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  try {
    const token = Deno.env.get("META_ACCESS_TOKEN");
    const wabaId = Deno.env.get("META_WABA_ID");

    if (!token || !wabaId) {
      return new Response(
        JSON.stringify({ error: "Meta credentials not configured" }),
        { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const url = new URL(req.url);
    const after = url.searchParams.get("after");
    const limit = url.searchParams.get("limit") || "100";

    const baseUrl = `https://graph.facebook.com/v21.0/${wabaId}/message_templates`;
    const params = new URLSearchParams({
      limit,
    });
    if (after) params.set("after", after);

    const metaUrl = `${baseUrl}?${params.toString()}`;
    const page = await fetchPage(metaUrl, token);

    const templates = page.data ?? [];
    const hasMore = !!page.paging?.next;
    const nextCursor = page.paging?.cursors?.after ?? null;

    const result: FetchTemplatesResult = {
      templates: templates.map((t) => ({
        name: t.name,
        parameter_format: t.parameter_format,
        components: t.components ?? [],
        id: t.id,
        status: t.status,
        category: t.category,
        language: t.language,
      })),
      hasMore,
      nextCursor: hasMore ? nextCursor : null,
    };

    return new Response(
      JSON.stringify(result),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return new Response(
      JSON.stringify({ error: message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
