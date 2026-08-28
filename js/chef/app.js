// ============================================================================
// chef/app.js – Laptop-Ansicht für den Chef: Anmeldung, Navigation, Daten laden.
// Bewusst eine eigene Einstiegsseite (chef.html), damit die iPad-App unangetastet
// bleibt. Diese Ansicht liest nur mit und reicht Änderungen beim Worker ein –
// die Zentrale bleibt das iPad.
// ============================================================================
import { getSession, clearSession, getWorkerUrl, setWorkerUrl, login, getOverview } from "./api.js";
import { renderPlanning } from "./planning.js";
import { renderStock } from "./stock.js";
import { renderCosts } from "./costs.js";
import { escapeHtml, todayStr } from "../format.js";

// Wird bei jeder Änderung hochgezählt und in der Kopfzeile angezeigt – so ist auf einen Blick erkennbar,
// ob der Browser schon die neue Fassung geladen hat oder noch eine gecachte.
const APP_VERSION = "2026-08-28.3";

const outlet = document.getElementById("outlet");

const TABS = [
  { id: "planning", label: "📅 Schichtplanung" },
  { id: "stock", label: "📦 Bestand" },
  { id: "costs", label: "💰 Kosten" },
];
let activeTab = "planning";
let state = null;

function show(node) {
  outlet.innerHTML = "";
  outlet.appendChild(node);
}

// ---------------------------------------------------------------------
// Anmeldung
// ---------------------------------------------------------------------
function renderLogin(message) {
  const wrap = document.createElement("div");
  wrap.className = "page chef-login";
  wrap.innerHTML = `
    <h1>☕ Chef-Bereich</h1>
    <p class="muted">Anmeldung mit dem Admin-PIN.</p>
  `;

  const card = document.createElement("section");
  card.className = "card";

  const urlWrap = document.createElement("label");
  urlWrap.className = "field";
  urlWrap.innerHTML = `<span>Worker-Adresse</span>`;
  const urlInput = document.createElement("input");
  urlInput.type = "text";
  urlInput.placeholder = "https://cafe-telegram-bot.deinname.workers.dev";
  urlInput.value = getWorkerUrl();
  urlWrap.appendChild(urlInput);
  const urlHint = document.createElement("p");
  urlHint.className = "muted small";
  urlHint.textContent = "Dieselbe Adresse wie am iPad unter Einstellungen → Telegram-Aufgaben abgleichen. Wird nur einmal gebraucht.";

  const pinWrap = document.createElement("label");
  pinWrap.className = "field";
  pinWrap.innerHTML = `<span>Admin-PIN</span>`;
  const pinInput = document.createElement("input");
  pinInput.type = "password";
  pinInput.inputMode = "numeric";
  pinInput.autocomplete = "current-password";
  pinWrap.appendChild(pinInput);

  const status = document.createElement("p");
  status.className = message ? "callout callout-warn" : "muted small";
  status.textContent = message || "";

  const btn = document.createElement("button");
  btn.className = "btn btn-primary btn-huge";
  btn.textContent = "Anmelden";

  const submit = async () => {
    const url = urlInput.value.trim();
    if (!url) {
      status.className = "callout callout-warn";
      status.textContent = "Bitte die Worker-Adresse eintragen.";
      return;
    }
    setWorkerUrl(url);
    btn.disabled = true;
    status.className = "muted small";
    status.textContent = "Melde an…";
    try {
      await login(pinInput.value.trim());
      await loadAndRender();
    } catch (e) {
      status.className = "callout callout-warn";
      status.textContent = "⚠ " + e.message;
      btn.disabled = false;
    }
  };
  btn.onclick = submit;
  pinInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") submit();
  });

  card.append(urlWrap, urlHint, pinWrap, status, btn);
  wrap.appendChild(card);
  show(wrap);
  pinInput.focus();
}

// ---------------------------------------------------------------------
// Hauptansicht
// ---------------------------------------------------------------------
function renderShell() {
  const wrap = document.createElement("div");
  wrap.className = "page";

  const head = document.createElement("div");
  head.className = "chef-head";
  const title = document.createElement("div");
  title.innerHTML =
    `<b>Chef-Bereich</b> <span class="muted small">· Stand vom letzten iPad-Abgleich${
      state?.updatedAt ? `: ${new Date(state.updatedAt).toLocaleString("de-DE", { dateStyle: "short", timeStyle: "short" })}` : " – noch keiner"
    }</span>` +
    // Sichtbare Version: Browser halten die Dateien bis zu 10 Minuten fest. Wenn nach einer Änderung
    // hier noch die alte Nummer steht, ist es der Cache und kein fehlender Deploy.
    `<br/><span class="muted small">Version ${APP_VERSION}</span>`;
  const actions = document.createElement("div");
  actions.className = "employee-actions";
  const reload = document.createElement("button");
  reload.className = "btn btn-secondary";
  reload.textContent = "↻ Aktualisieren";
  reload.onclick = () => loadAndRender();
  const logout = document.createElement("button");
  logout.className = "btn btn-secondary";
  logout.textContent = "Abmelden";
  logout.onclick = () => {
    clearSession();
    renderLogin();
  };
  actions.append(reload, logout);
  head.append(title, actions);
  wrap.appendChild(head);

  const tabs = document.createElement("div");
  tabs.className = "admin-tabs";
  for (const tab of TABS) {
    const b = document.createElement("button");
    b.className = "admin-tab" + (tab.id === activeTab ? " active" : "");
    b.textContent = tab.label;
    b.onclick = () => {
      activeTab = tab.id;
      renderShell();
    };
    tabs.appendChild(b);
  }
  wrap.appendChild(tabs);

  const onChanged = () => loadAndRender();
  let view;
  if (activeTab === "stock") view = renderStock(state, { onChanged });
  else if (activeTab === "costs") view = renderCosts(state);
  else view = renderPlanning(state, { onChanged, today: todayStr() });
  wrap.appendChild(view);

  show(wrap);
}

async function loadAndRender() {
  const loading = document.createElement("div");
  loading.className = "page";
  loading.innerHTML = `<p class="muted">Lade Daten…</p>`;
  show(loading);
  try {
    state = await getOverview();
    renderShell();
  } catch (e) {
    if (!getSession()) renderLogin(e.message);
    else {
      const err = document.createElement("div");
      err.className = "page";
      err.innerHTML = `<div class="callout callout-warn">⚠ ${escapeHtml(e.message)}</div>`;
      const retry = document.createElement("button");
      retry.className = "btn btn-secondary";
      retry.textContent = "Erneut versuchen";
      retry.onclick = () => loadAndRender();
      err.appendChild(retry);
      show(err);
    }
  }
}

if (getSession()) loadAndRender();
else renderLogin();
