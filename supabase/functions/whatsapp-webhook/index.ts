import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const VERIFY_TOKEN = Deno.env.get("META_WEBHOOK_VERIFY_TOKEN");

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  const url = new URL(req.url);

  // ── GET: Webhook verification challenge ──
  if (req.method === "GET") {
    const mode = url.searchParams.get("hub.mode");
    const token = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge");

    if (mode === "subscribe" && token === VERIFY_TOKEN && challenge) {
      return new Response(challenge, {
        status: 200,
        headers: { "Content-Type": "text/plain", ...corsHeaders },
      });
    }
    return new Response("Forbidden", {
      status: 403,
      headers: { "Content-Type": "text/plain", ...corsHeaders },
    });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const payload = await req.json();
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // ── Process status updates (outbound delivery receipts) ──
    const entries = payload?.entry ?? [];
    let processed = 0;

    for (const entry of entries) {
      const changes = entry?.changes ?? [];
      for (const change of changes) {
        const statuses = change?.value?.statuses ?? [];

        for (const status of statuses) {
          const wamid = status?.id;
          const statusValue = status?.status; // sent | delivered | read | failed
          const timestamp = status?.timestamp;

          if (!wamid || !statusValue) continue;

          let errorCode: number | null = null;
          let errorTitle: string | null = null;
          let errorMessage: string | null = null;
          let errorDetails: string | null = null;

          if (statusValue === "failed" && status?.errors) {
            const err = status.errors[0] ?? {};
            errorCode = err.code ?? null;
            errorTitle = err.title ?? null;
            errorMessage = err.error_data?.details ?? err.message ?? null;
            errorDetails = JSON.stringify(err);
          }

          const { error: rpcError } = await supabase.rpc(
            "update_whatsapp_outbound_status",
            {
              p_wamid: wamid,
              p_status: statusValue,
              p_timestamp: timestamp ?? null,
              p_error_code: errorCode,
              p_error_title: errorTitle,
              p_error_message: errorMessage,
              p_error_details: errorDetails,
            },
          );

          if (rpcError) {
            console.error("[whatsapp-webhook] RPC error for wamid", wamid, ":", rpcError.message);
          }
          processed++;
        }
      }
    }

    return new Response(
      JSON.stringify({ success: true, processed }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[whatsapp-webhook] Error:", message);
    return new Response(
      JSON.stringify({ error: message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
