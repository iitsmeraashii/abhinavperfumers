import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const GRAPH_API_VERSION = "v25.0";

interface SendRequestBody {
  conversation_id: string;
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
    const wabaId = Deno.env.get("META_WABA_ID");

    if (!token || !wabaId) {
      return new Response(
        JSON.stringify({ error: "Meta credentials not configured" }),
        { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const body = await req.json() as SendRequestBody;
    const { conversation_id, text_body } = body;

    if (!conversation_id || !text_body?.trim()) {
      return new Response(
        JSON.stringify({ error: "Missing required fields: conversation_id, text_body" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // ── Load conversation ──
    const { data: conversation, error: conversationError } = await supabase
      .from("whatsapp_conversations")
      .select("wa_phone_number, customer_service_window_expires_at")
      .eq("id", conversation_id)
      .maybeSingle();

    if (conversationError || !conversation) {
      return new Response(
        JSON.stringify({ error: "Conversation not found" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // ── Enforce service window server-side ──
    const expiresAt = conversation.customer_service_window_expires_at
      ? new Date(conversation.customer_service_window_expires_at).getTime()
      : 0;
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
      return new Response(
        JSON.stringify({ error: "The customer service window has expired. Start a new conversation with an approved template." }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const toPhone = conversation.wa_phone_number;

    // ── Resolve sender phone number ID ──
    // Priority: runtime_configuration.whatsapp_phone_number_id > META_PHONE_NUMBER_ID (if valid) > query Meta API
    let phoneNumberId: string | null = null;

    const { data: runtimeConfig } = await supabase
      .from("runtime_configuration")
      .select("whatsapp_phone_number_id")
      .eq("id", 1)
      .maybeSingle();

    if (runtimeConfig?.whatsapp_phone_number_id) {
      phoneNumberId = runtimeConfig.whatsapp_phone_number_id;
    }

    if (!phoneNumberId) {
      const envPhoneNumberId = Deno.env.get("META_PHONE_NUMBER_ID");
      // Use env var only if it differs from the WABA ID (which is a common misconfiguration)
      if (envPhoneNumberId && envPhoneNumberId !== wabaId) {
        phoneNumberId = envPhoneNumberId;
      }
    }

    if (!phoneNumberId) {
      // Fall back to querying the Meta API for phone numbers on the WABA
      const phoneResp = await fetch(
        `https://graph.facebook.com/${GRAPH_API_VERSION}/${wabaId}/phone_numbers?fields=id,display_phone_number&limit=100`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      const phoneData = await phoneResp.json() as
        { data?: { id: string; display_phone_number?: string }[]; error?: { message?: string } };

      if (!phoneResp.ok) {
        throw new Error(phoneData.error?.message || "Unable to resolve WhatsApp phone number ID");
      }

      const phones = phoneData.data ?? [];
      if (phones.length >= 1 && phones[0]?.id) {
        phoneNumberId = phones[0].id;
      }
    }

    if (!phoneNumberId) {
      return new Response(
        JSON.stringify({ error: "Unable to resolve the WhatsApp phone number ID for sending." }),
        { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // ── Resolve from_phone for the database record ──
    let fromPhone = Deno.env.get("META_BUSINESS_PHONE_NUMBER");

    if (!fromPhone) {
      const { data: lastOutbound } = await supabase
        .from("whatsapp_messages")
        .select("from_phone")
        .eq("conversation_id", conversation_id)
        .eq("direction", "OUTBOUND")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      fromPhone = lastOutbound?.from_phone ?? null;
    }

    // ── Call Meta WhatsApp Cloud API ──
    const metaUrl = `https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}/messages`;
    const metaBody = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: toPhone,
      type: "text",
      text: { preview_url: false, body: text_body },
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
        to_phone: toPhone,
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
      to_phone: toPhone,
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
