import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  const openAiKey = Deno.env.get("OPENAI_API_KEY");
  if (!openAiKey) {
    return new Response(
      JSON.stringify({ error: "OpenAI API key not configured" }),
      { status: 503, headers: { "Content-Type": "application/json", ...corsHeaders } },
    );
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(
        JSON.stringify({ error: "Missing authorization" }),
        { status: 401, headers: { "Content-Type": "application/json", ...corsHeaders } },
      );
    }

    // User-scoped client for all DB writes — RLS ensures the session belongs to this user.
    const userClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } },
    );

    // Service-role client for private Storage download only.
    const serviceClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const body = await req.json();
    const { sessionId } = body as { sessionId?: string };

    if (!sessionId) {
      return new Response(
        JSON.stringify({ error: "sessionId is required" }),
        { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } },
      );
    }

    // Locate the voice note asset for this capture session.
    const { data: asset, error: assetError } = await userClient
      .from("capture_assets")
      .select("id, storage_path, mime_type")
      .eq("capture_session_id", sessionId)
      .eq("asset_type", "voice_note")
      .maybeSingle();

    if (assetError || !asset?.storage_path) {
      return new Response(
        JSON.stringify({ error: "Voice note asset not found or not yet uploaded" }),
        { status: 404, headers: { "Content-Type": "application/json", ...corsHeaders } },
      );
    }

    // Mark as transcribing so the UI can show an in-progress state.
    await userClient
      .from("capture_assets")
      .update({ transcription_status: "transcribing" })
      .eq("id", asset.id);

    // Download audio from private Storage via service role.
    const { data: fileData, error: downloadError } = await serviceClient.storage
      .from("lead-evidence")
      .download(asset.storage_path);

    if (downloadError || !fileData) {
      await userClient
        .from("capture_assets")
        .update({ transcription_status: "failed" })
        .eq("id", asset.id);
      return new Response(
        JSON.stringify({ error: "Failed to download audio file" }),
        { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } },
      );
    }

    // Derive file extension from storage path (e.g. voice.webm → webm).
    const ext = asset.storage_path.split(".").pop() ?? "webm";
    const mimeType = (asset.mime_type as string | null) ?? "audio/webm";

    // Call OpenAI Whisper.
    const form = new FormData();
    form.append("file", new File([fileData], `voice.${ext}`, { type: mimeType }));
    form.append("model", "whisper-1");
    form.append("response_format", "text");

    const whisperRes = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${openAiKey}` },
      body: form,
    });

    if (!whisperRes.ok) {
      const detail = await whisperRes.text().catch(() => "");
      console.warn("[transcribe-voice-note] Whisper API error:", whisperRes.status, detail);
      await userClient
        .from("capture_assets")
        .update({ transcription_status: "failed" })
        .eq("id", asset.id);
      return new Response(
        JSON.stringify({ error: "Transcription service unavailable" }),
        { status: 502, headers: { "Content-Type": "application/json", ...corsHeaders } },
      );
    }

    const transcript = (await whisperRes.text()).trim();

    // Persist transcript to the session and mark asset as ready.
    await Promise.all([
      userClient
        .from("capture_sessions")
        .update({ voice_note_transcript: transcript })
        .eq("id", sessionId),
      userClient
        .from("capture_assets")
        .update({ transcription_status: "ready" })
        .eq("id", asset.id),
    ]);

    return new Response(
      JSON.stringify({ transcript }),
      { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } },
    );
  } catch (err) {
    console.error("[transcribe-voice-note] unhandled error:", err);
    return new Response(
      JSON.stringify({ error: String(err) }),
      { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } },
    );
  }
});
