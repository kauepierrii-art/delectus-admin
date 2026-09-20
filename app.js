import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from "./config.js";

const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
const stages = [
  "Acesso confirmado",
  "01 — Identificação",
  "02 — Origem",
  "03 — Observação",
  "04 — Iniciativa",
  "05 — Convergência",
  "06 — Discernimento",
  "07 — Admissão",
];

const loginView = document.querySelector("#loginView");
const dashboardView = document.querySelector("#dashboardView");
const loginForm = document.querySelector("#loginForm");
const loginButton = document.querySelector("#loginButton");
const loginMessage = document.querySelector("#loginMessage");
const logoutButton = document.querySelector("#logoutButton");
const refreshButton = document.querySelector("#refreshButton");
const searchInput = document.querySelector("#searchInput");
const summaryCards = document.querySelector("#summaryCards");
const tableMessage = document.querySelector("#tableMessage");
const referencesTable = document.querySelector("#referencesTable");
const referencesBody = document.querySelector("#referencesBody");
const lastUpdate = document.querySelector("#lastUpdate");

let dashboardData = null;
let requestVersion = 0;

function clearDashboard() {
  requestVersion++;
  dashboardData = null;
  summaryCards.replaceChildren();
  referencesBody.replaceChildren();
  referencesTable.hidden = true;
  lastUpdate.textContent = "Aguardando atualização.";
  searchInput.value = "";
  refreshButton.disabled = false;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatDate(value) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(value));
}

function setAuthenticated(authenticated) {
  loginView.hidden = authenticated;
  dashboardView.hidden = !authenticated;
  logoutButton.hidden = !authenticated;
}

function renderSummary(summary) {
  const cards = [
    ["REFERÊNCIAS", summary.referenceCount],
    ["ATIVAS", summary.activeReferences],
    ["SESSÕES REGISTRADAS", summary.sessionCount],
    ["CONCLUÍDAS", summary.completedSessions],
  ];
  summaryCards.innerHTML = cards
    .map(([label, value]) => `<article><span>${label}</span><strong>${value}</strong></article>`)
    .join("");
}

function sessionDetails(reference) {
  if (!reference.sessions.length) {
    return '<p class="empty-sessions">Nenhuma sessão registrada para esta referência.</p>';
  }
  return `
    <div class="session-list">
      ${reference.sessions.map((session, index) => `
        <article>
          <span>SESSÃO ${String(index + 1).padStart(2, "0")}</span>
          <strong>${escapeHtml(stages[session.currentStage] ?? "Etapa desconhecida")}</strong>
          <small>Primeiro acesso: ${formatDate(session.firstSeenAt)}</small>
          <small>Última atividade: ${formatDate(session.lastSeenAt)}</small>
          ${session.resetAt ? `<small>Reiniciado em: ${formatDate(session.resetAt)}</small>` : ""}
          <button class="details-button reset-session-button" type="button" data-session-id="${escapeHtml(session.id)}">REINICIAR PROTOCOLO</button>
        </article>
      `).join("")}
    </div>`;
}

function renderReferences() {
  const query = searchInput.value.trim().toLocaleLowerCase("pt-BR");
  const references = (dashboardData?.references ?? []).filter((reference) =>
    reference.code.toLocaleLowerCase("pt-BR").includes(query) ||
    reference.meaning.toLocaleLowerCase("pt-BR").includes(query) ||
    (reference.aliases ?? []).some((alias) => alias.toLocaleLowerCase("pt-BR").includes(query))
  );

  tableMessage.hidden = references.length > 0;
  referencesTable.hidden = references.length === 0;
  tableMessage.textContent = dashboardData
    ? "Nenhuma referência corresponde à busca."
    : "Carregando registros…";

  referencesBody.innerHTML = references.map((reference) => `
    <tr class="reference-row">
      <td><strong>${escapeHtml(reference.code)}</strong><small>${escapeHtml((reference.aliases ?? []).join(" · "))}</small></td>
      <td><span class="status ${reference.active ? "active" : "inactive"}">${reference.active ? "ATIVA" : "INATIVA"}</span></td>
      <td>${reference.sessionCount}</td>
      <td>${reference.sessionCount
        ? escapeHtml(stages[reference.highestStage] ?? "—")
        : "Não iniciado"}</td>
      <td>${formatDate(reference.lastActivity)}</td>
      <td><button class="details-button" type="button" aria-expanded="false">DETALHES</button></td>
    </tr>
    <tr class="details-row" hidden>
      <td colspan="6">${sessionDetails(reference)}</td>
    </tr>
  `).join("");

  referencesBody.querySelectorAll(".details-button").forEach((button) => {
    if (button.classList.contains("reset-session-button")) return;
    button.addEventListener("click", () => {
      const row = button.closest("tr").nextElementSibling;
      const opening = row.hidden;
      row.hidden = !opening;
      button.setAttribute("aria-expanded", String(opening));
      button.textContent = opening ? "FECHAR" : "DETALHES";
    });
  });
  referencesBody.querySelectorAll(".reset-session-button").forEach((button) => {
    button.addEventListener("click", () => resetSession(button.dataset.sessionId));
  });
}

async function resetSession(sessionId) {
  if (!sessionId || !window.confirm("Reiniciar este protocolo? O histórico da sessão será preservado, mas o participante voltará à etapa inicial no próximo acesso.")) return;
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return;
  refreshButton.disabled = true;
  try {
    const response = await fetch(`${SUPABASE_URL}/functions/v1/admin-dashboard`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        apikey: SUPABASE_PUBLISHABLE_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ action: "reset-session", sessionId }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || "Não foi possível reiniciar o protocolo.");
    await loadDashboard();
  } catch (error) {
    window.alert(error.message || "Não foi possível reiniciar o protocolo.");
  } finally {
    refreshButton.disabled = false;
  }
}

async function loadDashboard() {
  const version = ++requestVersion;
  refreshButton.disabled = true;
  tableMessage.hidden = false;
  tableMessage.textContent = "Atualizando registros…";

  const { data: { session } } = await supabase.auth.getSession();
  if (version !== requestVersion) return;
  if (!session) {
    clearDashboard();
    setAuthenticated(false);
    return;
  }

  try {
    const response = await fetch(`${SUPABASE_URL}/functions/v1/admin-dashboard`, {
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        apikey: SUPABASE_PUBLISHABLE_KEY,
      },
    });
    const payload = await response.json();
    if (version !== requestVersion) return;
    if (!response.ok) throw new Error(payload.error || "Falha ao carregar o painel.");
    dashboardData = payload;
    renderSummary(payload.summary);
    renderReferences();
    lastUpdate.textContent = `Atualizado em ${formatDate(payload.generatedAt)}.`;
  } catch (error) {
    if (version !== requestVersion) return;
    dashboardData = null;
    summaryCards.replaceChildren();
    referencesBody.replaceChildren();
    lastUpdate.textContent = "Atualização indisponível.";
    referencesTable.hidden = true;
    tableMessage.hidden = false;
    tableMessage.textContent = error.message;
  } finally {
    if (version === requestVersion) refreshButton.disabled = false;
  }
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  loginButton.disabled = true;
  loginMessage.textContent = "Verificando credenciais…";
  const form = new FormData(loginForm);
  const { error } = await supabase.auth.signInWithPassword({
    email: String(form.get("email") ?? "").trim(),
    password: String(form.get("password") ?? ""),
  });
  if (error) {
    loginMessage.textContent = "E-mail ou senha inválidos.";
    loginButton.disabled = false;
    return;
  }
  loginForm.reset();
  loginMessage.textContent = "";
  loginButton.disabled = false;
});

logoutButton.addEventListener("click", async () => {
  clearDashboard();
  setAuthenticated(false);
  await supabase.auth.signOut({ scope: "local" });
});
refreshButton.addEventListener("click", loadDashboard);
searchInput.addEventListener("input", renderReferences);

supabase.auth.onAuthStateChange((_event, session) => {
  setAuthenticated(Boolean(session));
  if (!session) clearDashboard();
  // Leave the auth callback before calling getSession (Supabase auth lock).
  else setTimeout(() => loadDashboard(), 0);
});

