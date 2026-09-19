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
  text_body?: string;
  asset_id?: string;
  share_message?: string;
  template_name?: string;
  template_language?: string;
  template_params?: { type: string; [key: string]: unknown }[];
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
    const { conversation_id, text_body, asset_id, share_message, template_name, template_language, template_params } = body;

    const isTextSend = !asset_id && !template_name;
    const isMediaSend = !!asset_id && !template_name;
    const isTemplateAssetSend = !!template_name && !!asset_id;
    const isTextOnlyTemplateSend = !!template_name && !asset_id;

    if (!conversation_id) {
      return new Response(
        JSON.stringify({ error: "Missing required field: conversation_id" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    if (isTextSend && !text_body?.trim()) {
      return new Response(
        JSON.stringify({ error: "Missing required field: text_body" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    if (isMediaSend && !asset_id?.trim()) {
      return new Response(
        JSON.stringify({ error: "Missing required field: asset_id" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    if (isTextOnlyTemplateSend && !template_name?.trim()) {
      return new Response(
        JSON.stringify({ error: "Missing required field: template_name" }),
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
    const windowOpen = Number.isFinite(expiresAt) && expiresAt > Date.now();

    // Template sends (both text-only and asset-backed) are allowed when the window is expired/closed.
    // Free-form text and direct media sends require an open window.
    if (!isTemplateAssetSend && !isTextOnlyTemplateSend && !windowOpen) {
      return new Response(
        JSON.stringify({ error: "The customer service window has expired. Start a new conversation with an approved template." }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const toPhone = conversation.wa_phone_number;

    // ── Resolve sender phone number ID ──
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
      if (envPhoneNumberId && envPhoneNumberId !== wabaId) {
        phoneNumberId = envPhoneNumberId;
      }
    }

    if (!phoneNumberId) {
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

    // ── Text-only template send path (expired window, no asset) ──
    if (isTextOnlyTemplateSend) {
      return await sendTextOnlyTemplateMessage({
        supabase, token, wabaId, phoneNumberId, toPhone, fromPhone,
        conversation_id, template_name: template_name!,
        template_language: template_language || null,
        template_params: template_params ?? [],
      });
    }

    // ── Template + asset media send path (expired window) ──
    if (isTemplateAssetSend) {
      return await sendTemplateAssetMessage({
        supabase, token, wabaId, phoneNumberId, toPhone, fromPhone,
        conversation_id, asset_id: asset_id!, template_name: template_name!,
        template_language: template_language || null,
        template_params: template_params ?? [],
      });
    }

    // ── Text message path (existing behavior, unchanged) ──
    if (isTextSend) {
      return await sendTextMessage({
        supabase, token, phoneNumberId, toPhone, fromPhone,
        conversation_id, text_body: text_body!,
      });
    }

    // ── Media message path (asset send) ──
    return await sendAssetMessage({
      supabase, token, phoneNumberId, toPhone, fromPhone,
      conversation_id, asset_id: asset_id!,
      share_message: share_message ?? null,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return new Response(
      JSON.stringify({ error: message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});

// ── Text message sender (extracted from original logic) ──────────────────────

async function sendTextMessage(opts: {
  supabase: ReturnType<typeof createClient>;
  token: string;
  phoneNumberId: string;
  toPhone: string;
  fromPhone: string | null;
  conversation_id: string;
  text_body: string;
}): Promise<Response> {
  const { supabase, token, phoneNumberId, toPhone, fromPhone, conversation_id, text_body } = opts;

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
    console.error("[send-whatsapp-message] Failed to insert text message row:", insertErr.message);
  }

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
}

// ── Asset media sender ────────────────────────────────────────────────────────

async function sendAssetMessage(opts: {
  supabase: ReturnType<typeof createClient>;
  token: string;
  phoneNumberId: string;
  toPhone: string;
  fromPhone: string | null;
  conversation_id: string;
  asset_id: string;
  share_message: string | null;
}): Promise<Response> {
  const { supabase, token, phoneNumberId, toPhone, fromPhone, conversation_id, asset_id, share_message } = opts;

  // The client-provided share_message takes precedence over the asset's
  // stored default. The asset record is still the source of truth for
  // existence, type, status, and file content.
  const effectiveMessage = share_message?.trim() || null;

  // ── Load the asset metadata ──
  const { data: asset, error: assetError } = await supabase
    .from("whatsapp_assets")
    .select("id, name, asset_type, file_name, storage_path, mime_type, file_size, share_message, active")
    .eq("id", asset_id)
    .maybeSingle();

  if (assetError || !asset) {
    return new Response(
      JSON.stringify({ error: "Asset not found" }),
      { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  if (!asset.active) {
    return new Response(
      JSON.stringify({ error: "This asset is no longer active" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  // ── Download the file from private Storage ──
  const { data: fileData, error: downloadError } = await supabase
    .storage
    .from("whatsapp-assets")
    .download(asset.storage_path);

  if (downloadError || !fileData) {
    return new Response(
      JSON.stringify({ error: "Failed to retrieve asset file from storage" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const fileBytes = new Uint8Array(await fileData.arrayBuffer());

  // ── Upload media to Meta ──
  const mediaType = asset.asset_type === "IMAGE" ? "image" : "document";
  const uploadUrl = `https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}/media`;
  const formData = new FormData();
  formData.append("messaging_product", "whatsapp");
  formData.append("type", asset.mime_type);
  const uploadBlob = new Blob([fileBytes], { type: asset.mime_type });
  formData.append("file", uploadBlob, asset.file_name);

  const uploadResp = await fetch(uploadUrl, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: formData,
  });

  const uploadJson = await uploadResp.json();

  if (!uploadResp.ok) {
    const errorObj = uploadJson?.error || {};
    const now = new Date().toISOString();

    await supabase.from("whatsapp_messages").insert({
      conversation_id,
      direction: "OUTBOUND",
      source: "LEADSINN",
      message_type: mediaType.toUpperCase(),
      message_purpose: "ASSET_SHARE",
      from_phone: fromPhone || null,
      to_phone: toPhone,
      media_filename: asset.file_name,
      media_mime_type: asset.mime_type,
      media_caption: effectiveMessage,
      status: "FAILED",
      error_code: errorObj.code ?? null,
      error_title: errorObj.title ?? null,
      error_message: errorObj.message ?? null,
      error_details: errorObj.error_data?.details ?? JSON.stringify(errorObj),
      failed_at: now,
      last_attempt_at: now,
      timestamp: now,
      raw_payload: uploadJson,
      attempt_log: [{ at: now, stage: "meta_media_upload", error: errorObj.message ?? "Unknown error" }],
    });

    return new Response(
      JSON.stringify({
        success: false,
        error: errorObj.message || "Meta API rejected the media upload",
        error_code: errorObj.code,
      }),
      { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const mediaId = uploadJson?.id;

  if (!mediaId) {
    return new Response(
      JSON.stringify({ error: "Meta media upload succeeded but no media ID was returned" }),
      { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  // ── Send the media message via Meta ──
  const metaUrl = `https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}/messages`;

  // Build the media message body.
  // WhatsApp supports captions on images but NOT on documents.
  // For documents, if a share_message exists, we send it as a separate
  // text message after the document. For images, use the caption field.
  const mediaObj: Record<string, unknown> = { id: mediaId };

  if (mediaType === "image" && effectiveMessage) {
    mediaObj.caption = effectiveMessage;
  }

  if (mediaType === "document") {
    mediaObj.filename = asset.file_name;
  }

  const metaBody = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: toPhone,
    type: mediaType,
    [mediaType]: mediaObj,
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
    const errorObj = metaJson?.error || {};
    const now = new Date().toISOString();

    await supabase.from("whatsapp_messages").insert({
      conversation_id,
      direction: "OUTBOUND",
      source: "LEADSINN",
      message_type: mediaType.toUpperCase(),
      message_purpose: "ASSET_SHARE",
      from_phone: fromPhone || null,
      to_phone: toPhone,
      media_id: mediaId,
      media_filename: asset.file_name,
      media_mime_type: asset.mime_type,
      media_caption: effectiveMessage,
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
        error: errorObj.message || "Meta API rejected the media message",
        error_code: errorObj.code,
      }),
      { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const wamid = metaJson?.messages?.[0]?.id ?? null;
  const now = new Date().toISOString();

  const { error: insertErr } = await supabase.from("whatsapp_messages").insert({
    conversation_id,
    wamid,
    direction: "OUTBOUND",
    source: "LEADSINN",
    message_type: mediaType.toUpperCase(),
    message_purpose: "ASSET_SHARE",
    from_phone: fromPhone || null,
    to_phone: toPhone,
    media_id: mediaId,
    media_filename: asset.file_name,
    media_mime_type: asset.mime_type,
    media_caption: effectiveMessage,
    status: "ACCEPTED",
    accepted_at: now,
    last_attempt_at: now,
    timestamp: now,
    raw_payload: metaJson,
    attempt_log: [],
  });

  if (insertErr) {
    console.error("[send-whatsapp-message] Failed to insert media message row:", insertErr.message);
  }

  // ── For documents with share_message, send a follow-up text ──
  // WhatsApp does not support captions on documents. If the asset has
  // a share_message and it's a document, send it as a separate text.
  if (mediaType === "document" && effectiveMessage) {
    const followUpBody = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: toPhone,
      type: "text",
      text: { preview_url: false, body: effectiveMessage },
    };

    const followUpResp = await fetch(metaUrl, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(followUpBody),
    });

    const followUpJson = await followUpResp.json();

    if (followUpResp.ok) {
      const followUpWamid = followUpJson?.messages?.[0]?.id ?? null;
      await supabase.from("whatsapp_messages").insert({
        conversation_id,
        wamid: followUpWamid,
        direction: "OUTBOUND",
        source: "LEADSINN",
        message_type: "TEXT",
        message_purpose: "ASSET_SHARE_CAPTION",
        from_phone: fromPhone || null,
        to_phone: toPhone,
        text_body: effectiveMessage,
        status: "ACCEPTED",
        accepted_at: now,
        last_attempt_at: now,
        timestamp: now,
        raw_payload: followUpJson,
        attempt_log: [],
      });
    }
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
      message: "Asset sent",
    }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
}

// ── Template + asset media sender (expired service window) ────────────────────

async function sendTemplateAssetMessage(opts: {
  supabase: ReturnType<typeof createClient>;
  token: string;
  wabaId: string;
  phoneNumberId: string;
  toPhone: string;
  fromPhone: string | null;
  conversation_id: string;
  asset_id: string;
  template_name: string;
  template_language: string | null;
  template_params: { type: string; [key: string]: unknown }[];
}): Promise<Response> {
  const {
    supabase, token, wabaId, phoneNumberId, toPhone, fromPhone,
    conversation_id, asset_id, template_name, template_language, template_params,
  } = opts;

  // ── Validate the asset ──
  const { data: asset, error: assetError } = await supabase
    .from("whatsapp_assets")
    .select("id, name, asset_type, file_name, storage_path, mime_type, file_size, active")
    .eq("id", asset_id)
    .maybeSingle();

  if (assetError || !asset) {
    return new Response(
      JSON.stringify({ error: "Asset not found" }),
      { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  if (!asset.active) {
    return new Response(
      JSON.stringify({ error: "This asset is no longer active" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  // ── Fetch the template from Meta to validate it's still approved ──
  const templateUrl = `https://graph.facebook.com/${GRAPH_API_VERSION}/${wabaId}/message_templates?limit=500`;
  const templateResp = await fetch(templateUrl, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!templateResp.ok) {
    const errBody = await templateResp.text();
    return new Response(
      JSON.stringify({ error: `Failed to verify template status: ${errBody}` }),
      { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const templateData = await templateResp.json() as {
    data?: {
      id: string;
      name: string;
      status: string;
      language: string;
      category: string;
      components?: { type: string; format?: string; text?: string }[];
    }[];
  };

  const matchedTemplate = (templateData.data ?? []).find(
    (t) => t.name === template_name && (!template_language || t.language === template_language),
  );

  if (!matchedTemplate) {
    return new Response(
      JSON.stringify({ error: "The selected template could not be found. It may have been deleted." }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  if (matchedTemplate.status.toLowerCase() !== "approved") {
    return new Response(
      JSON.stringify({ error: `Template "${template_name}" is no longer approved (status: ${matchedTemplate.status}).` }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  // ── Validate header compatibility ──
  const headerComponent = (matchedTemplate.components ?? []).find(
    (c) => c.type.toLowerCase() === "header",
  );

  const headerFormat = headerComponent?.format?.toUpperCase() ?? null;
  const assetType = asset.asset_type.toUpperCase();

  if (!headerFormat) {
    return new Response(
      JSON.stringify({ error: "The selected template does not have a media header." }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  if (assetType === "IMAGE" && headerFormat !== "IMAGE") {
    return new Response(
      JSON.stringify({ error: `This image asset requires a template with an IMAGE header, but the template has a ${headerFormat} header.` }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  if (assetType === "DOCUMENT" && headerFormat !== "DOCUMENT") {
    return new Response(
      JSON.stringify({ error: `This document asset requires a template with a DOCUMENT header, but the template has a ${headerFormat} header.` }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  // ── Download the asset from private storage ──
  const { data: fileData, error: downloadError } = await supabase
    .storage
    .from("whatsapp-assets")
    .download(asset.storage_path);

  if (downloadError || !fileData) {
    return new Response(
      JSON.stringify({ error: "Failed to retrieve asset file from storage" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const fileBytes = new Uint8Array(await fileData.arrayBuffer());

  // ── Upload media to Meta ──
  const mediaType = assetType === "IMAGE" ? "image" : "document";
  const uploadUrl = `https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}/media`;
  const formData = new FormData();
  formData.append("messaging_product", "whatsapp");
  formData.append("type", asset.mime_type);
  const uploadBlob = new Blob([fileBytes], { type: asset.mime_type });
  formData.append("file", uploadBlob, asset.file_name);

  const uploadResp = await fetch(uploadUrl, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: formData,
  });

  const uploadJson = await uploadResp.json();

  if (!uploadResp.ok) {
    const errorObj = uploadJson?.error || {};
    const now = new Date().toISOString();

    await supabase.from("whatsapp_messages").insert({
      conversation_id,
      direction: "OUTBOUND",
      source: "LEADSINN",
      message_type: "TEMPLATE",
      message_purpose: "TEMPLATE_ASSET_SHARE",
      from_phone: fromPhone || null,
      to_phone: toPhone,
      template_id: matchedTemplate.id,
      template_name: template_name,
      media_filename: asset.file_name,
      media_mime_type: asset.mime_type,
      status: "FAILED",
      error_code: errorObj.code ?? null,
      error_title: errorObj.title ?? null,
      error_message: errorObj.message ?? null,
      error_details: errorObj.error_data?.details ?? JSON.stringify(errorObj),
      failed_at: now,
      last_attempt_at: now,
      timestamp: now,
      raw_payload: uploadJson,
      attempt_log: [{ at: now, stage: "meta_media_upload", error: errorObj.message ?? "Unknown error" }],
    });

    return new Response(
      JSON.stringify({
        success: false,
        error: errorObj.message || "Meta API rejected the media upload",
        error_code: errorObj.code,
      }),
      { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const mediaId = uploadJson?.id;

  if (!mediaId) {
    return new Response(
      JSON.stringify({ error: "Meta media upload succeeded but no media ID was returned" }),
      { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  // ── Build the template message with media header ──
  const metaUrl = `https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}/messages`;

  // Build header parameter with the uploaded media
  const headerParams = [{
    type: mediaType,
    [mediaType]: { id: mediaId },
  }];

  // Build body parameters from the client-provided params
  const bodyParams = (template_params ?? []).map((p) => ({
    type: p.type,
    text: p.text ?? p.payload ?? "",
  }));

  const components: Record<string, unknown>[] = [];
  components.push({ type: "header", parameters: headerParams });
  if (bodyParams.length > 0) {
    components.push({ type: "body", parameters: bodyParams });
  }

  const metaBody = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: toPhone,
    type: "template",
    template: {
      name: template_name,
      language: { code: template_language || matchedTemplate.language },
      components,
    },
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
    const errorObj = metaJson?.error || {};
    const now = new Date().toISOString();

    await supabase.from("whatsapp_messages").insert({
      conversation_id,
      direction: "OUTBOUND",
      source: "LEADSINN",
      message_type: "TEMPLATE",
      message_purpose: "TEMPLATE_ASSET_SHARE",
      from_phone: fromPhone || null,
      to_phone: toPhone,
      template_id: matchedTemplate.id,
      template_name: template_name,
      media_id: mediaId,
      media_filename: asset.file_name,
      media_mime_type: asset.mime_type,
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
        error: errorObj.message || "Meta API rejected the template message",
        error_code: errorObj.code,
      }),
      { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const wamid = metaJson?.messages?.[0]?.id ?? null;
  const now = new Date().toISOString();

  const { error: insertErr } = await supabase.from("whatsapp_messages").insert({
    conversation_id,
    wamid,
    direction: "OUTBOUND",
    source: "LEADSINN",
    message_type: "TEMPLATE",
    message_purpose: "TEMPLATE_ASSET_SHARE",
    from_phone: fromPhone || null,
    to_phone: toPhone,
    template_id: matchedTemplate.id,
    template_name: template_name,
    media_id: mediaId,
    media_filename: asset.file_name,
    media_mime_type: asset.mime_type,
    status: "ACCEPTED",
    accepted_at: now,
    last_attempt_at: now,
    timestamp: now,
    raw_payload: metaJson,
    attempt_log: [],
  });

  if (insertErr) {
    console.error("[send-whatsapp-message] Failed to insert template message row:", insertErr.message);
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
      message: "Template sent",
    }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
}

// ── Text-only template sender (no asset, expired window) ──────────────────────

async function sendTextOnlyTemplateMessage(opts: {
  supabase: ReturnType<typeof createClient>;
  token: string;
  wabaId: string;
  phoneNumberId: string;
  toPhone: string;
  fromPhone: string | null;
  conversation_id: string;
  template_name: string;
  template_language: string | null;
  template_params: { type: string; [key: string]: unknown }[];
}): Promise<Response> {
  const {
    supabase, token, wabaId, phoneNumberId, toPhone, fromPhone,
    conversation_id, template_name, template_language, template_params,
  } = opts;

  // ── Fetch the template from Meta to validate it's still approved ──
  const templateUrl = `https://graph.facebook.com/${GRAPH_API_VERSION}/${wabaId}/message_templates?limit=500`;
  const templateResp = await fetch(templateUrl, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!templateResp.ok) {
    const errBody = await templateResp.text();
    return new Response(
      JSON.stringify({ error: `Failed to verify template status: ${errBody}` }),
      { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const templateData = await templateResp.json() as {
    data?: {
      id: string;
      name: string;
      status: string;
      language: string;
      category: string;
      components?: { type: string; format?: string; text?: string }[];
    }[];
  };

  const matchedTemplate = (templateData.data ?? []).find(
    (t) => t.name === template_name && (!template_language || t.language === template_language),
  );

  if (!matchedTemplate) {
    return new Response(
      JSON.stringify({ error: "The selected template could not be found. It may have been deleted." }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  if (matchedTemplate.status.toLowerCase() !== "approved") {
    return new Response(
      JSON.stringify({ error: `Template "${template_name}" is no longer approved (status: ${matchedTemplate.status}).` }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  // ── Validate that the template has no media header (text-only) ──
  const headerComponent = (matchedTemplate.components ?? []).find(
    (c) => c.type.toLowerCase() === "header",
  );

  const headerFormat = headerComponent?.format?.toUpperCase() ?? null;

  if (headerFormat === "IMAGE" || headerFormat === "DOCUMENT" || headerFormat === "VIDEO") {
    return new Response(
      JSON.stringify({ error: `The selected template requires a ${headerFormat} media header. Use the asset template flow instead.` }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  // ── Build body parameters from the client-provided params ──
  const bodyParams = (template_params ?? []).map((p) => ({
    type: p.type,
    text: p.text ?? p.payload ?? "",
  }));

  const components: Record<string, unknown>[] = [];
  if (bodyParams.length > 0) {
    components.push({ type: "body", parameters: bodyParams });
  }

  const metaBody = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: toPhone,
    type: "template",
    template: {
      name: template_name,
      language: { code: template_language || matchedTemplate.language },
      components,
    },
  };

  const metaUrl = `https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}/messages`;
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
    const errorObj = metaJson?.error || {};
    const now = new Date().toISOString();

    await supabase.from("whatsapp_messages").insert({
      conversation_id,
      direction: "OUTBOUND",
      source: "LEADSINN",
      message_type: "TEMPLATE",
      message_purpose: "TEMPLATE_SHARE",
      from_phone: fromPhone || null,
      to_phone: toPhone,
      template_id: matchedTemplate.id,
      template_name: template_name,
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
        error: errorObj.message || "Meta API rejected the template message",
        error_code: errorObj.code,
      }),
      { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const wamid = metaJson?.messages?.[0]?.id ?? null;
  const now = new Date().toISOString();

  const { error: insertErr } = await supabase.from("whatsapp_messages").insert({
    conversation_id,
    wamid,
    direction: "OUTBOUND",
    source: "LEADSINN",
    message_type: "TEMPLATE",
    message_purpose: "TEMPLATE_SHARE",
    from_phone: fromPhone || null,
    to_phone: toPhone,
    template_id: matchedTemplate.id,
    template_name: template_name,
    status: "ACCEPTED",
    accepted_at: now,
    last_attempt_at: now,
    timestamp: now,
    raw_payload: metaJson,
    attempt_log: [],
  });

  if (insertErr) {
    console.error("[send-whatsapp-message] Failed to insert text-only template message row:", insertErr.message);
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
      message: "Template sent",
    }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
}
