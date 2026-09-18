// ============================================================================
// manager/app.js – Store-Management: Anmeldung, Aufbau, Laden.
//
// Anders aufgebaut als der Laptop: nicht nach Datenart (Tabellen), sondern nach dem, was man als
// Store-Managerin am Tag tut. Zuerst "Heute" – was ist los, was fehlt, was ist offen –, dann die Bereiche,
// in denen man etwas erledigt. Auf dem Handy sitzt die Navigation unten am Daumen, auf dem iPad oben.
//
// Anmeldung mit PIN über einen Ziffernblock, wie am iPad im Café – kein Passwortfeld mit Tastatur.
// ============================================================================
import { getSession, clearSession, getWorkerUrl, setWorkerUrl, login, getOverview } from "./api.js";
import { el, text, knopf, toast } from "./ui.js";
import { buildPinDots, buildPinKeypad } from "../pinpad.js";
import { renderHeute } from "./heute.js";
import { renderBestand } from "./bestand.js";
import { renderAufgaben } from "./aufgaben.js";
import { renderTeam } from "./team.js";
import { renderPlan } from "./plan.js";
import { renderMeins } from "./meins.js";

const APP_VERSION = "2026-09-18.1";
const outlet = document.getElementById("outlet");

const TABS = [
  { id: "heute", symbol: "🏠", label: "Heute", render: renderHeute },
  { id: "bestand", symbol: "📦", label: "Bestand", render: renderBestand },
  { id: "aufgaben", symbol: "✅", label: "Aufgaben", render: renderAufgaben },
  { id: "team", symbol: "👥", label: "Team", render: renderTeam },
  { id: "plan", symbol: "📅", label: "Plan", render: renderPlan },
  { id: "meins", symbol: "🗒", label: "Meins", render: renderMeins },
];

const LS_TAB = "cafeapp_manager_tab";
let aktiverTab = (() => {
  try {
    return localStorage.getItem(LS_TAB) || "heute";
  } catch {
    return "heute";
  }
})();
let daten = null;

function show(node) {
  outlet.innerHTML = "";
  outlet.appendChild(node);
}

// ---------------------------------------------------------------------
// Anmeldung
// ---------------------------------------------------------------------
function renderLogin(meldung) {
  const wrap = el("div", "page mg-login");
  wrap.appendChild(el("div", "mg-login-kopf", `<div class="mg-login-logo">🗂</div><h1>Store-Management</h1><p class="muted">frnds Café &amp; Kitchen</p>`));

  const card = el("section", "card");
  let urlInput = null;
  if (!getWorkerUrl()) {
    urlInput = document.createElement("input");
    urlInput.type = "text";
    urlInput.placeholder = "https://…workers.dev";
    const l = el("label", "field");
    l.append(text("span", null, "Adresse (einmalig, bekommst du von Karim)"), urlInput);
    card.appendChild(l);
  }

  let pin = "";
  const status = text("p", meldung ? "callout callout-warn" : "muted small", meldung || "PIN eingeben");
  const punkte = el("div");
  const zeichnePunkte = () => {
    punkte.innerHTML = "";
    punkte.appendChild(buildPinDots(pin));
  };
  zeichnePunkte();

  const absenden = async () => {
    if (urlInput) {
      if (!urlInput.value.trim()) {
        status.className = "callout callout-warn";
        status.textContent = "Bitte zuerst die Adresse eintragen.";
        return;
      }
      setWorkerUrl(urlInput.value);
    }
    if (pin.length < 4) return;
    status.className = "muted small";
    status.textContent = "Melde an…";
    try {
      await login(pin);
      await laden();
    } catch (e) {
      pin = "";
      zeichnePunkte();
      status.className = "callout callout-warn";
      status.textContent = "⚠ " + e.message;
    }
  };
  const pad = buildPinKeypad((taste) => {
    if (taste === "⌫") pin = pin.slice(0, -1);
    else if (taste === "✓") return absenden();
    else if (pin.length < 8) pin += taste;
    zeichnePunkte();
  });
  card.append(status, punkte, pad);
  wrap.appendChild(card);
  show(wrap);
}

// ---------------------------------------------------------------------
// Aufbau
// ---------------------------------------------------------------------
function renderShell() {
  const session = getSession();
  const scroll = window.scrollY;
  const wrap = el("div", "mg-shell");

  const kopf = el("header", "mg-kopf");
  const titel = el("div", "mg-kopf-titel");
  titel.appendChild(text("b", null, session?.role === "boss" ? "🗂 Store · Chef-Ansicht" : "🗂 frnds Store"));
  titel.appendChild(
    text(
      "span",
      "muted small",
      `Stand ${daten.updatedAt ? new Date(daten.updatedAt).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" }) : "–"} · ${APP_VERSION}`
    )
  );
  const aktionen = el("div", "mg-kopf-aktionen");
  aktionen.appendChild(knopf("↻", "mg-icon-btn", () => laden({ still: true })));
  aktionen.lastChild.title = "Aktualisieren";
  aktionen.appendChild(
    knopf("Abmelden", "btn btn-link", () => {
      clearSession();
      renderLogin();
    })
  );
  kopf.append(titel, aktionen);
  wrap.appendChild(kopf);

  const nav = el("nav", "mg-nav");
  for (const t of TABS) {
    const b = knopf("", "mg-nav-btn" + (t.id === aktiverTab ? " an" : ""), () => wechsle(t.id));
    b.innerHTML = `<span class="mg-nav-sym">${t.symbol}</span><span class="mg-nav-label">${t.label}</span>`;
    const badge = zaehler(t.id);
    if (badge) b.appendChild(text("span", "mg-nav-badge", String(badge)));
    nav.appendChild(b);
  }
  wrap.appendChild(nav);

  const inhalt = el("div", "page mg-inhalt");
  const tab = TABS.find((t) => t.id === aktiverTab) || TABS[0];
  inhalt.appendChild(tab.render(daten, { neuLaden: () => laden({ still: true }), wechsle, rolle: session?.role }));
  wrap.appendChild(inhalt);
  show(wrap);
  window.scrollTo(0, scroll);
}

/** Kleine Zahl an der Navigation: nur, wo wirklich etwas auf sie wartet. */
function zaehler(tabId) {
  if (!daten) return 0;
  if (tabId === "bestand") {
    return (daten.bestand || []).filter((a) => a.aktiv !== false && a.menge !== null && a.menge !== undefined && a.soll > 0 && a.menge < a.soll).length;
  }
  if (tabId === "meins" && getSession()?.role === "manager") {
    return (daten.aufgaben || []).filter((a) => a.von === "chef" && a.art !== "wiederkehrend" && !a.erledigtAm).length;
  }
  return 0;
}

function wechsle(tabId) {
  aktiverTab = tabId;
  try {
    localStorage.setItem(LS_TAB, tabId);
  } catch {}
  window.scrollTo(0, 0);
  renderShell();
}

async function laden({ still = false } = {}) {
  if (!still || !daten) show(el("div", "page", `<p class="muted">Lade…</p>`));
  try {
    daten = await getOverview();
    renderShell();
  } catch (e) {
    if (e.abgemeldet || !getSession()) return renderLogin(e.message);
    if (daten) {
      toast("⚠ " + e.message, true);
      return;
    }
    const box = el("div", "page");
    box.appendChild(text("div", "callout callout-warn", "⚠ " + e.message));
    box.appendChild(knopf("Nochmal versuchen", "btn btn-secondary", () => laden()));
    show(box);
  }
}

if (getSession()) laden();
else renderLogin();
