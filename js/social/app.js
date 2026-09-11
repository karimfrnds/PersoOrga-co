// ============================================================================
// social/app.js – Social-Media-Bereich: Anmeldung, Navigation, Daten laden.
//
// Eigene Einstiegsseite (social.html), damit weder das iPad noch die Chef-Ansicht davon berührt werden.
// Zwei Rollen kommen hier rein: der Chef mit seinem Admin-PIN und die Betreuung mit einem eigenen PIN.
// Die Betreuung kommt NUR hierher – nicht weil eine Schaltfläche fehlt, sondern weil kein Endpunkt ihr
// Löhne, Kennzahlen oder Gastdaten gibt.
// ============================================================================
import {
  getSession,
  clearSession,
  getWorkerUrl,
  setWorkerUrl,
  login,
  getOverview,
  postAction,
  shootingAction,
  terminAction,
  listeAction,
  accountAction,
} from "./api.js";
import { el, escapeHtml, feld } from "./gemeinsam.js";
import { renderKalender } from "./kalender.js";
import { renderPosts, renderFreigaben, openPostDialog, openStatsDialog } from "./posts.js";
import { renderShootings, openShootingDialog, renderListen } from "./shootings.js";
import { renderStatistik } from "./statistik.js";

const APP_VERSION = "2026-09-11.3";
const outlet = document.getElementById("outlet");

const TABS = [
  { id: "kalender", label: "🗓 Kalender" },
  { id: "posts", label: "📝 Redaktionsplan" },
  { id: "shootings", label: "📸 Shootings" },
  { id: "listen", label: "✅ Listen" },
  { id: "statistik", label: "📊 Auswertung" },
];

let daten = null;
let activeTab = "kalender";
// Überlebt das Neuzeichnen, damit man beim Blättern nicht in den aktuellen Monat zurückspringt.
let kalenderMonat = null;
let postFilter = { kanal: "", rubrik: "" };
let meldung = null;

function show(node) {
  outlet.innerHTML = "";
  outlet.appendChild(node);
}

// ---------------------------------------------------------------------
// Anmeldung
// ---------------------------------------------------------------------
function renderLogin(message) {
  const wrap = el("div", "page chef-login");
  wrap.innerHTML = `<h1>📱 Social Media</h1><p class="muted">Redaktionsplan, Shootings und Zahlen.</p>`;
  const card = el("section", "card");

  const urlInput = document.createElement("input");
  urlInput.type = "text";
  urlInput.placeholder = "https://…workers.dev";
  urlInput.value = getWorkerUrl();
  card.appendChild(feld("Adresse", urlInput, "Bekommst du einmalig von Karim. Wird gespeichert."));

  const pinInput = document.createElement("input");
  pinInput.type = "password";
  pinInput.inputMode = "numeric";
  pinInput.autocomplete = "current-password";
  pinInput.placeholder = "••••";
  card.appendChild(feld("PIN", pinInput));

  const status = el("p", "muted small");
  if (message) {
    status.className = "callout callout-warn";
    status.textContent = message;
  }

  const btn = el("button", "btn btn-primary btn-huge", "Anmelden");
  const anmelden = async () => {
    setWorkerUrl(urlInput.value.trim());
    btn.disabled = true;
    status.className = "muted small";
    status.textContent = "Wird geprüft…";
    try {
      await login(pinInput.value.trim());
      await load();
    } catch (e) {
      status.className = "callout callout-warn";
      status.textContent = e.message;
      btn.disabled = false;
    }
  };
  btn.onclick = anmelden;
  pinInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") anmelden();
  });
  card.append(btn, status);
  wrap.appendChild(card);
  show(wrap);
}

// ---------------------------------------------------------------------
// Hauptansicht
// ---------------------------------------------------------------------
function renderMain() {
  const wrap = el("div", "page");

  const kopf = el("div", "chef-head");
  kopf.innerHTML = `<div><b>${escapeHtml(daten.name)}</b> <span class="muted small">· Version ${APP_VERSION}</span></div>`;
  const abmelden = el("button", "btn btn-link", "Abmelden");
  abmelden.onclick = () => {
    clearSession();
    renderLogin();
  };
  kopf.appendChild(abmelden);
  wrap.appendChild(kopf);

  if (meldung) {
    const box = el("div", meldung.fehler ? "callout callout-warn" : "callout", escapeHtml(meldung.text));
    wrap.appendChild(box);
    meldung = null;
  }

  const nav = el("div", "admin-tabs");
  for (const tab of TABS) {
    const b = el("button", "admin-tab" + (activeTab === tab.id ? " active" : ""), tab.label);
    b.onclick = () => {
      activeTab = tab.id;
      renderMain();
    };
    nav.appendChild(b);
  }
  wrap.appendChild(nav);

  // Offene Freigaben stehen über allem – sie sind das Einzige, das jemand anderen aufhält.
  const freigaben = renderFreigaben(daten, {
    rolle: daten.rolle,
    onOeffnen: (p) => oeffnePost(p),
    onStatus: (p, ziel, mitNotiz) => statusSetzen(p, ziel, mitNotiz),
  });
  if (freigaben) wrap.appendChild(freigaben);

  if (activeTab === "kalender") {
    if (!kalenderMonat) {
      const h = new Date(daten.heute + "T12:00:00");
      kalenderMonat = { jahr: h.getFullYear(), monat: h.getMonth() };
    }
    wrap.appendChild(
      renderKalender(daten, kalenderMonat, {
        onMonat: (m) => {
          kalenderMonat = m;
          renderMain();
        },
        onTag: (eintrag) => {
          if (eintrag.art === "post") oeffnePost((daten.posts || []).find((p) => p.id === eintrag.id));
          else if (eintrag.art === "shooting") oeffneShooting((daten.shootings || []).find((s) => s.id === eintrag.id));
          else if (eintrag.art === "termin") oeffneTermin((daten.termine || []).find((t) => t.id === eintrag.id));
          else {
            // Café-Veranstaltungen gehören dem Café-Teil. Sie hier änderbar zu machen hieße, dieselbe
            // Sache an zwei Stellen zu pflegen.
            meldung = { text: "Das ist eine Veranstaltung aus dem Café – geändert wird sie dort unter Admin → Bingo." };
            renderMain();
          }
        },
        onNeu: (datum) => openNeuDialog(datum),
      })
    );
  } else if (activeTab === "posts") {
    wrap.appendChild(
      renderPosts(daten, {
        filter: postFilter,
        onFilter: (f) => {
          postFilter = f;
          renderMain();
        },
        onOeffnen: (p) => oeffnePost(p),
        onNeu: () => oeffnePost(null),
        onStatus: (p, ziel) => statusSetzen(p, ziel),
      })
    );
  } else if (activeTab === "shootings") {
    wrap.appendChild(
      renderShootings(daten, {
        onNeu: () => oeffneShooting(null),
        onOeffnen: (s) => oeffneShooting(s),
        onShot: (s, extra) => schicke(() => shootingAction({ kind: "shot", shootingId: s.id, ...extra })),
        onErledigt: (s, wert) => schicke(() => shootingAction({ kind: "update", shootingId: s.id, erledigt: wert })),
      })
    );
  } else if (activeTab === "listen") {
    wrap.appendChild(renderListen(daten, { onListe: (body) => schicke(() => listeAction(body)) }));
  } else {
    wrap.appendChild(
      renderStatistik(daten, {
        onAccount: (werte) => schicke(() => accountAction(werte)),
        onAccountLoeschen: (s) => schicke(() => accountAction({ kind: "delete", statId: s.id })),
      })
    );
  }

  show(wrap);
}

// ---------------------------------------------------------------------
// Aktionen
// ---------------------------------------------------------------------
async function schicke(fn, hinweis) {
  try {
    await fn();
    if (hinweis) meldung = { text: hinweis };
    await load();
  } catch (e) {
    meldung = { text: e.message, fehler: true };
    renderMain();
  }
}

function oeffnePost(post, vorgabe) {
  openPostDialog(daten, post, {
    rolle: daten.rolle,
    vorgabe,
    onSpeichern: (vorhanden, werte) =>
      schicke(() => postAction(vorhanden ? { kind: "update", postId: vorhanden.id, ...werte } : { kind: "create", ...werte })),
    onLoeschen: (p) => {
      if (confirm(`Post „${p.titel}" löschen?`)) schicke(() => postAction({ kind: "delete", postId: p.id }));
    },
    onStatus: (p, ziel) => statusSetzen(p, ziel),
    onStats: (p) => openStatsDialog(p, { onSpeichern: (post, werte) => schicke(() => postAction({ kind: "stats", postId: post.id, ...werte })) }),
  });
}

/** Status ändern. Beim Zurückgeben an die Betreuung darf eine Anmerkung dazu – ohne sie ist ein
 * zurückgewiesener Post nur eine Ablehnung ohne Begründung, und das ist der Anfang von Ärger. */
function statusSetzen(post, ziel, mitNotiz) {
  if (mitNotiz) {
    const notiz = prompt("Was soll geändert werden?\n\nDie Anmerkung steht danach am Post.", post.freigabeNotiz || "");
    if (notiz === null) return;
    schicke(() => postAction({ kind: "status", postId: post.id, status: ziel, freigabeNotiz: notiz }));
    return;
  }
  schicke(() => postAction({ kind: "status", postId: post.id, status: ziel }));
}

function oeffneShooting(shooting, vorgabe) {
  openShootingDialog(daten, shooting, {
    vorgabe,
    onSpeichern: (vorhanden, werte) =>
      schicke(() =>
        shootingAction(vorhanden ? { kind: "update", shootingId: vorhanden.id, ...werte } : { kind: "create", ...werte })
      ),
    onLoeschen: (s) => {
      if (confirm("Shooting löschen?")) schicke(() => shootingAction({ kind: "delete", shootingId: s.id }));
    },
  });
}

function oeffneTermin(termin, vorgabe) {
  const overlay = el("div", "overlay");
  const box = el("div", "dialog");
  box.appendChild(el("h2", null, termin ? "Termin ändern" : "Neuer Termin"));
  const datum = document.createElement("input");
  datum.type = "date";
  datum.value = termin?.datum || vorgabe?.datum || daten.heute;
  const bisDatum = document.createElement("input");
  bisDatum.type = "date";
  bisDatum.value = termin?.bisDatum || termin?.datum || vorgabe?.datum || daten.heute;
  const titel = document.createElement("input");
  titel.type = "text";
  titel.placeholder = "z.B. Neue Karte startet, Karim im Urlaub";
  titel.value = termin?.titel || "";
  const notiz = document.createElement("textarea");
  notiz.rows = 2;
  notiz.value = termin?.notiz || "";
  const reihe = el("div", "res-form-row");
  reihe.append(feld("Von", datum), feld("Bis", bisDatum));
  box.append(reihe, feld("Titel", titel), feld("Notiz", notiz));

  const akt = el("div", "dialog-actions");
  const abbrechen = el("button", "btn btn-secondary", "Abbrechen");
  abbrechen.onclick = () => overlay.remove();
  const speichern = el("button", "btn btn-primary", "Speichern");
  speichern.onclick = () => {
    if (!titel.value.trim()) return;
    overlay.remove();
    const werte = { datum: datum.value, bisDatum: bisDatum.value, titel: titel.value, notiz: notiz.value };
    schicke(() => terminAction(termin ? { kind: "update", terminId: termin.id, ...werte } : { kind: "create", ...werte }));
  };
  akt.append(abbrechen, speichern);
  box.appendChild(akt);
  if (termin) {
    const unten = el("div", "res-dialog-danger");
    const weg = el("button", "btn btn-link", "Löschen");
    weg.onclick = () => {
      overlay.remove();
      schicke(() => terminAction({ kind: "delete", terminId: termin.id }));
    };
    unten.appendChild(weg);
    box.appendChild(unten);
  }
  overlay.appendChild(box);
  document.body.appendChild(overlay);
  titel.focus();
}

/** Aus dem Kalender heraus: was soll an diesem Tag entstehen? Drei Arten, also erst die Frage – ein
 * Formular mit einem Auswahlfeld „Art" oben wäre ein Schritt mehr für jeden Eintrag. */
function openNeuDialog(datum) {
  const overlay = el("div", "overlay");
  const box = el("div", "dialog");
  box.appendChild(el("h2", null, "Was soll rein?"));
  if (datum) box.appendChild(el("p", "muted small", escapeHtml(datum.split("-").reverse().join("."))));
  const wahl = el("div", "res-gruende");
  // Immer als NEU anlegen, nur mit vorbelegtem Datum. Ein halbes Objekt durchzureichen haette den
  // Dialog aussehen lassen wie "bestehenden Eintrag bearbeiten" – samt Loeschen-Knopf.
  const vorgabe = datum ? { datum } : undefined;
  const arten = [
    ["📝 Post", () => oeffnePost(null, vorgabe)],
    ["📸 Shooting", () => oeffneShooting(null, vorgabe)],
    ["📌 Termin", () => oeffneTermin(null, vorgabe)],
  ];
  for (const [label, fn] of arten) {
    const b = el("button", "btn btn-secondary", label);
    b.onclick = () => {
      overlay.remove();
      fn();
    };
    wahl.appendChild(b);
  }
  box.appendChild(wahl);
  const akt = el("div", "dialog-actions");
  const abbrechen = el("button", "btn btn-secondary", "Abbrechen");
  abbrechen.onclick = () => overlay.remove();
  akt.appendChild(abbrechen);
  box.appendChild(akt);
  overlay.appendChild(box);
  document.body.appendChild(overlay);
}

// ---------------------------------------------------------------------
async function load() {
  const loading = el("div", "page", `<p class="muted">Lade…</p>`);
  show(loading);
  try {
    daten = await getOverview();
    renderMain();
  } catch (e) {
    if (!getSession()) renderLogin(e.message);
    else {
      const err = el("div", "page", `<div class="callout callout-warn">⚠ ${escapeHtml(e.message)}</div>`);
      const retry = el("button", "btn btn-secondary", "Nochmal versuchen");
      retry.onclick = () => load();
      err.appendChild(retry);
      show(err);
    }
  }
}

if (getSession()) load();
else renderLogin();
