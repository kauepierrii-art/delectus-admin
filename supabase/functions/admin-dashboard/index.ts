import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.4";

const allowedOrigins = new Set([
  "https://kauepierrii-art.github.io",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
]);

function corsHeaders(req: Request) {
  const origin = req.headers.get("origin") ?? "";
  return {
    "Access-Control-Allow-Origin": allowedOrigins.has(origin)
      ? origin
      : "https://kauepierrii-art.github.io",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Vary": "Origin",
  };
}

function json(req: Request, body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(req), "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders(req) });
  }
  if (req.method !== "GET") {
    return json(req, { error: "Método não permitido." }, 405);
  }

  const authHeader = req.headers.get("Authorization");
  const token = authHeader?.replace(/^Bearer\s+/i, "");
  if (!token) return json(req, { error: "Acesso não autenticado." }, 401);

  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceKey) {
    return json(req, { error: "Configuração interna indisponível." }, 500);
  }

  const admin = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: userData, error: userError } = await admin.auth.getUser(token);
  if (userError || !userData.user) {
    return json(req, { error: "Sessão inválida ou expirada." }, 401);
  }

  const { data: adminRecord, error: adminError } = await admin
    .from("admin_users")
    .select("user_id")
    .eq("user_id", userData.user.id)
    .maybeSingle();

  if (adminError) return json(req, { error: "Falha ao verificar autorização." }, 500);
  if (!adminRecord) return json(req, { error: "Usuário sem permissão administrativa." }, 403);

  const [{ data: references, error: referencesError }, { data: sessions, error: sessionsError }] =
    await Promise.all([
      admin.from("protocol_references")
        .select("id, code, meaning, is_active, created_at")
        .order("code"),
      admin.from("protocol_sessions")
        .select("id, reference_id, current_stage, completed_stages, first_seen_at, last_seen_at")
        .order("last_seen_at", { ascending: false }),
    ]);

  if (referencesError || sessionsError) {
    return json(req, { error: "Não foi possível carregar o painel." }, 500);
  }

  const sessionRows = sessions ?? [];
  const rows = (references ?? []).map((reference) => {
    const related = sessionRows.filter((session) => session.reference_id === reference.id);
    const highestStage = related.reduce(
      (highest, session) => Math.max(highest, session.current_stage ?? 0),
      0,
    );
    return {
      id: reference.id,
      code: reference.code,
      meaning: reference.meaning,
      active: reference.is_active,
      sessionCount: related.length,
      highestStage,
      lastActivity: related[0]?.last_seen_at ?? null,
      sessions: related.map((session) => ({
        id: session.id,
        currentStage: session.current_stage,
        completedStages: session.completed_stages,
        firstSeenAt: session.first_seen_at,
        lastSeenAt: session.last_seen_at,
      })),
    };
  });

  return json(req, {
    generatedAt: new Date().toISOString(),
    summary: {
      referenceCount: rows.length,
      activeReferences: rows.filter((row) => row.active).length,
      sessionCount: sessionRows.length,
      completedSessions: sessionRows.filter((session) => session.completed_stages.includes(7)).length,
    },
    references: rows,
  });
});
