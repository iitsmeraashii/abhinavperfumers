import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

interface SendRequestBody {
  conversation_id: string;
  to_phone: string;
  text_body: string;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(
      JSON.stringify({ error: "Method not allowed" }),
      { status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  try {
    const token = Deno.env.get("META_ACCESS_TOKEN");
    const phoneNumberId = Deno.env.get("META_PHONE_NUMBER_ID");

    if (!token || !phoneNumberId) {
      return new Response(
        JSON.stringify({ error: "Meta credentials not configured" }),
        { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const body = await req.json() as SendRequestBody;
    const { conversation_id, to_phone, text_body } = body;

    if (!conversation_id || !to_phone || !text_body?.trim()) {
      return new Response(
        JSON.stringify({ error: "Missing required fields: conversation_id, to_phone, text_body" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Determine from_phone: check META_BUSINESS_PHONE_NUMBER, then fall back to
    // the most recent outbound message's from_phone in this conversation.
    let fromPhone = Deno.env.get("META_BUSINESS_PHONE_NUMBER");

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    if (!fromPhone) {
      const { data: lastOutbound } = await supabase
        .from("whatsapp_messages")
        .select("from_phone")
        .eq("conversation_id", conversation_id)
        .eq("direction", "OUTBOUND")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (lastOutbound?.from_phone) {
        fromPhone = lastOutbound.from_phone;
      }
    }

    // ── Call Meta WhatsApp Cloud API ──
    const metaUrl = `https://graph.facebook.com/v21.0/${phoneNumberId}/messages`;
    const metaBody = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: to_phone,
      type: "text",
      text: { body: text_body },
    };

    const metaResp = await fetch(metaUrl, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(metaBody),
    });

    const metaJson = await metaResp.json();

    if (!metaResp.ok) {
      // Meta rejected the message — persist a FAILED row
      const errorObj = metaJson?.error || {};
      const now = new Date().toISOString();

      await supabase.from("whatsapp_messages").insert({
        conversation_id,
        direction: "OUTBOUND",
        source: "LEADSINN",
        message_type: "TEXT",
        message_purpose: "CONVERSATION_REPLY",
        from_phone: fromPhone || null,
        to_phone,
        text_body,
        status: "FAILED",
        error_code: errorObj.code ?? null,
        error_title: errorObj.title ?? null,
        error_message: errorObj.message ?? null,
        error_details: errorObj.error_data?.details ?? JSON.stringify(errorObj),
        failed_at: now,
        last_attempt_at: now,
        timestamp: now,
        raw_payload: metaJson,
        attempt_log: [{ at: now, stage: "meta_api", error: errorObj.message ?? "Unknown error" }],
      });

      return new Response(
        JSON.stringify({
          success: false,
          error: errorObj.message || "Meta API rejected the message",
          error_code: errorObj.code,
        }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // ── Meta accepted — persist the outbound message ──
    const wamid = metaJson?.messages?.[0]?.id ?? null;
    const now = new Date().toISOString();

    const { error: insertErr } = await supabase.from("whatsapp_messages").insert({
      conversation_id,
      wamid,
      direction: "OUTBOUND",
      source: "LEADSINN",
      message_type: "TEXT",
      message_purpose: "CONVERSATION_REPLY",
      from_phone: fromPhone || null,
      to_phone,
      text_body,
      status: "ACCEPTED",
      accepted_at: now,
      last_attempt_at: now,
      timestamp: now,
      raw_payload: metaJson,
      attempt_log: [],
    });

    if (insertErr) {
      console.error("[send-whatsapp-message] Failed to insert message row:", insertErr.message);
    }

    // ── Update conversation timestamps ──
    await supabase
      .from("whatsapp_conversations")
      .update({
        last_message_at: now,
        last_outbound_at: now,
        updated_at: now,
      })
      .eq("id", conversation_id);

    return new Response(
      JSON.stringify({
        success: true,
        wamid,
        message: "Message sent",
      }),
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
