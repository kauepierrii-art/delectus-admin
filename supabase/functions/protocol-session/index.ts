import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.4";

// Protocolo Delectus: valida referências e registra telemetria do beta.
// Este endpoint não concede permissões administrativas nem verifica soluções de enigmas.
const origins = new Set([
  "https://protocolodelectus.vercel.app",
  "https://sociedade-five.vercel.app",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:8000",
  "http://127.0.0.1:8000",
]);

function headers(req: Request) {
  const origin = req.headers.get("origin") ?? "";
  return {
    "Access-Control-Allow-Origin": origins.has(origin)
      ? origin
      : "https://protocolodelectus.vercel.app",
    "Access-Control-Allow-Headers": "apikey, authorization, content-type, x-client-info",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Max-Age": "600",
    "Cache-Control": "no-store",
    "Vary": "Origin",
  };
}
function reply(req: Request, status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers(req), "Content-Type": "application/json; charset=utf-8" },
  });
}
function normalize(value: unknown) {
  if (typeof value !== "string") return "";
  const alias = value.trim().toLowerCase().replace(/\s+/g, " ");
  return /^[a-z ]{3,32}$/.test(alias) ? alias : "";
}
function validToken(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}
async function hashToken(token: string) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
function newToken() {
  return [...crypto.getRandomValues(new Uint8Array(32))]
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: headers(req) });
  if (req.method !== "POST") return reply(req, 405, { error: "Método não permitido." });
  const origin = req.headers.get("origin");
  if (origin && !origins.has(origin)) return reply(req, 403, { error: "Origem não permitida." });

  const endpoint = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!endpoint || !serviceKey) return reply(req, 500, { error: "Serviço indisponível." });
  const db = createClient(endpoint, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  let payload: Record<string, unknown>;
  try {
    if (Number(req.headers.get("content-length") || 0) > 2048)
      return reply(req, 413, { error: "Solicitação muito grande." });
    const raw = await req.text();
    if (raw.length > 2048) return reply(req, 413, { error: "Solicitação muito grande." });
    payload = JSON.parse(raw);
    if (!payload || typeof payload !== "object" || Array.isArray(payload))
      return reply(req, 400, { error: "Solicitação inválida." });
  } catch {
    return reply(req, 400, { error: "Solicitação inválida." });
  }

  if (payload.action === "open") {
    const alias = normalize(payload.reference);
    if (!alias) return reply(req, 401, { error: "Referência não localizada." });
    const { data: aliasRow, error: aliasError } = await db
      .from("protocol_reference_aliases").select("reference_id, is_active")
      .eq("alias", alias).maybeSingle();
    if (aliasError) return reply(req, 500, { error: "Falha ao verificar referência." });
    if (!aliasRow?.is_active) return reply(req, 401, { error: "Referência não localizada." });
    const { data: reference, error: referenceError } = await db
      .from("protocol_references").select("id, is_active")
      .eq("id", aliasRow.reference_id).maybeSingle();
    if (referenceError) return reply(req, 500, { error: "Falha ao verificar referência." });
    if (!reference?.is_active) return reply(req, 401, { error: "Referência não localizada." });

    const deviceId = validToken(payload.deviceId) ? payload.deviceId : newToken();
    let session: {
      id: string;
      current_stage: number;
      reset_at?: string | null;
      reset_acknowledged_at?: string | null;
    } | null = null;
    let created = false;
    let token = validToken(payload.token) ? payload.token : "";
    if (token) {
      const { data, error } = await db.from("protocol_sessions")
        .select("id, current_stage, reset_at, reset_acknowledged_at").eq("reference_id", reference.id)
        .eq("access_token_hash", await hashToken(token)).maybeSingle();
      if (error) return reply(req, 500, { error: "Falha ao consultar sessão." });
      session = data;
    }
    if (!session) {
      token = newToken();
      const { data, error } = await db.from("protocol_sessions")
        .insert({
          reference_id: reference.id,
          device_hash: await hashToken(deviceId),
          access_token_hash: await hashToken(token),
        })
        .select("id, current_stage, reset_at, reset_acknowledged_at").single();
      if (error || !data) return reply(req, 500, { error: "Falha ao iniciar sessão." });
      session = data;
      created = true;
    }
    const { error: seenError } = await db.from("protocol_sessions")
      .update({ last_seen_at: new Date().toISOString() }).eq("id", session.id);
    if (seenError) return reply(req, 500, { error: "Falha ao atualizar sessão." });
    // O primeiro acesso já está representado por first_seen_at. O evento é
    // criado somente uma vez, ao abrir uma sessão nova, para não duplicar
    // telemetria em recarregamentos ou tentativas repetidas.
    if (created) {
      const { error: eventError } = await db.from("protocol_progress_events").insert({
        session_id: session.id, reference_id: reference.id,
        stage: Number(session.current_stage) || 0, event_type: "access",
      });
      if (eventError) console.error("Falha ao registrar primeiro acesso.");
    }
    const resetRequired = Boolean(session.reset_at &&
      (!session.reset_acknowledged_at || session.reset_acknowledged_at < session.reset_at));
    return reply(req, 200, {
      token, reference: alias.toUpperCase(), currentStage: session.current_stage,
      resetRequired, resetAt: resetRequired ? session.reset_at : null,
    });
  }

  if (payload.action === "ack-reset") {
    if (!validToken(payload.token) || typeof payload.resetAt !== "string")
      return reply(req, 400, { error: "Solicitação inválida." });
    const digest = await hashToken(payload.token);
    const { error } = await db.from("protocol_sessions")
      .update({ reset_acknowledged_at: new Date().toISOString() })
      .eq("access_token_hash", digest)
      // Do not acknowledge a newer reset that could have happened after open.
      .eq("reset_at", payload.resetAt);
    if (error) return reply(req, 500, { error: "Falha ao confirmar reinício." });
    return reply(req, 200, { ok: true });
  }

  if (payload.action === "complete") {
    if (!validToken(payload.token) || !Number.isInteger(payload.stage) ||
        Number(payload.stage) < 1 || Number(payload.stage) > 7)
      return reply(req, 400, { error: "Solicitação inválida." });
    const digest = await hashToken(payload.token);
    const { data: session, error } = await db.from("protocol_sessions")
      .select("id, reference_id, current_stage, completed_stages")
      .eq("access_token_hash", digest).maybeSingle();
    if (error) return reply(req, 500, { error: "Falha ao consultar sessão." });
    if (!session) return reply(req, 401, { error: "Sessão não localizada." });
    const { data: reference, error: refError } = await db
      .from("protocol_references").select("is_active")
      .eq("id", session.reference_id).maybeSingle();
    if (refError) return reply(req, 500, { error: "Falha ao verificar referência." });
    if (!reference?.is_active) return reply(req, 403, { error: "Referência desativada." });

    const stage = Number(payload.stage);
    const previous = Number(session.current_stage) || 0;
    if (stage <= previous) return reply(req, 200, { currentStage: previous });
    // Os eventos são telemetria declarada pelo navegador, não prova da solução do enigma.
    const completed = Array.from(new Set([...(session.completed_stages ?? []), stage]))
      .sort((a, b) => a - b);
    const { error: updateError } = await db.from("protocol_sessions")
      .update({
        current_stage: stage,
        completed_stages: completed,
        last_seen_at: new Date().toISOString(),
      }).eq("id", session.id);
    if (updateError) return reply(req, 500, { error: "Falha ao atualizar progresso." });
    const { error: eventError } = await db.from("protocol_progress_events").insert({
      session_id: session.id, reference_id: session.reference_id,
      stage, event_type: "stage_completed",
    });
    if (eventError) console.error("Falha ao registrar evento de progresso.");
    return reply(req, 200, { currentStage: stage });
  }
  return reply(req, 400, { error: "Operação inválida." });
});

