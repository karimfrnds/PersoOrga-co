// ============================================================================
// kueche/app.js – die Stempelstation in der Produktionsküche.
//
// Dasselbe Verhalten wie das Haupt-Tablet, nur für die Küche: Leerlauf mit PIN-Feld, darunter wer im
// Dienst ist. PIN tippen heisst einstempeln. Danach das eigene Fenster – Aufträge, Bestand, Rezepte –
// und "Zurück" bringt das Tablet in den Leerlauf, OHNE auszustempeln. Ausgestempelt wird nur über den
// Knopf, der auch so heisst.
//
// Es hält KEINE eigenen Daten. Es liest, was das Haupt-Tablet geschickt hat, und legt alles, was hier
// passiert, in eine Warteschlange, die das Haupt-Tablet abarbeitet. Zwei Geräte mit je eigener Kopie
// derselben Daten waren im September der Grund, warum ein abgeschlossener Tag verschwunden ist.
//
// Zwei Anmeldungen: das GERÄT bleibt angemeldet – sonst könnte der Leerlauf gar nichts anzeigen und es
// wäre keine Stempelstation. Die PERSON nur, solange ihr Fenster offen ist.
// ============================================================================
import {
  getGeraet,
  getPerson,
  clearGeraet,
  clearPerson,
  getWorkerUrl,
  setWorkerUrl,
  geraetAnmelden,
  personAnmelden,
  getStation,
  getHub,
  sendeStamm,
  getOverview,
  stempeln,
  sendeCharge,
  sendeLeer,
  sendeAuftragWeg,
} from "./api.js";
import { buildPinDots, buildPinKeypad } from "../pinpad.js";
import { escapeHtml, dateDe, todayStr } from "../format.js";

const APP_VERSION = "2026-10-29.1";
const outlet = document.getElementById("outlet");

// Wie lange ein persönliches Fenster offen bleiben darf, ohne dass jemand es anfasst. Danach zurück in
// den Leerlauf – nicht ausgestempelt, nur geschlossen. Ein offenes Fenster auf fremden Namen ist auf
// einem geteilten Gerät gefährlicher als ein PIN, den jemand noch einmal tippt.
const FENSTER_ZU_NACH_MS = 3 * 60 * 1000;
const LEERLAUF_ABGLEICH_MS = 30 * 1000;
const FENSTER_ABGLEICH_MS = 60 * 1000;

let ansicht = "leerlauf"; // "leerlauf" | "fenster" | "hub"
let station = null; // Daten des Leerlaufs
let daten = null; // Daten des persönlichen Fensters
let hub = null; // Auswertung der Küche (Geräte-Zugang reicht)
let reiter = "auftraege"; // "auftraege" | "bestand" | "rezepte"
let pin = "";
let fehler = "";
let flash = null;
let begruesst = null; // { name } – wartet auf "Schicht starten?"
let letzteBeruehrung = Date.now();
let timer = null;

const show = (node) => {
  outlet.innerHTML = "";
  outlet.appendChild(node);
};
const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html !== undefined) n.innerHTML = html;
  return n;
};
const knopf = (text, cls, onClick) => {
  const b = document.createElement("button");
  b.className = cls;
  b.textContent = text;
  b.onclick = onClick;
  return b;
};
const zahlText = (n) => {
  const x = Number(n);
  if (!Number.isFinite(x)) return "–";
  return Number.isInteger(x) ? String(x) : String(Math.round(x * 100) / 100).replace(".", ",");
};
const uhr = (iso) => {
  try {
    return new Date(iso).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
};
const wann = (iso) => {
  if (!iso) return "";
  const tag = String(iso).slice(0, 10);
  return tag === todayStr() ? `heute ${uhr(iso)}` : `${dateDe(tag)}, ${uhr(iso)}`;
};

for (const ereignis of ["pointerdown", "keydown", "touchstart"]) {
  window.addEventListener(ereignis, () => (letzteBeruehrung = Date.now()), { passive: true });
}

// =====================================================================
// Einrichtung des Geräts – einmalig
// =====================================================================
function renderEinrichtung(meldungText) {
  stoppeTimer();
  const wrap = el("div", "page kiosk-wrap");
  wrap.appendChild(el("div", "kiosk-head", `<div class="kiosk-greeting">👩‍🍳 Küchen-Tablet</div><h1>Einmal einrichten</h1>`));
  const card = el("section", "card");
  card.appendChild(el("p", "muted small", "Adresse und Zugang bekommst du von Karim. Danach fragt das Tablet nie wieder danach – ab dann ist es eine Stempelstation."));

  const urlInput = document.createElement("input");
  urlInput.type = "text";
  urlInput.placeholder = "https://…workers.dev";
  urlInput.value = getWorkerUrl();
  const l = el("label", "field", "<span>Adresse</span>");
  l.appendChild(urlInput);
  card.appendChild(l);

  let gpin = "";
  const status = el("p", meldungText ? "callout callout-warn" : "muted small", meldungText || "Zugang des Küchen-Tablets eingeben.");
  const punkte = el("div");
  const zeichne = () => {
    punkte.innerHTML = "";
    punkte.appendChild(buildPinDots(gpin));
  };
  zeichne();

  const absenden = async () => {
    if (!urlInput.value.trim()) {
      status.className = "callout callout-warn";
      status.textContent = "Bitte zuerst die Adresse eintragen.";
      return;
    }
    setWorkerUrl(urlInput.value);
    if (gpin.length < 4) return;
    status.className = "muted small";
    status.textContent = "Richte ein…";
    try {
      await geraetAnmelden(gpin);
      flash = "Eingerichtet. Ab jetzt geht es direkt los.";
      await ladeStation();
    } catch (e) {
      gpin = "";
      zeichne();
      status.className = "callout callout-warn";
      status.textContent = "⚠ " + e.message;
    }
  };
  card.append(
    status,
    punkte,
    buildPinKeypad((taste) => {
      if (taste === "⌫") gpin = gpin.slice(0, -1);
      else if (taste === "✓") return absenden();
      else if (gpin.length < 8) gpin += taste;
      zeichne();
    })
  );
  wrap.appendChild(card);
  wrap.appendChild(el("p", "muted small", `Küchen-Tablet · ${APP_VERSION}`));
  show(wrap);
}

// =====================================================================
// Leerlauf – PIN-Feld und wer im Dienst ist
// =====================================================================
function renderLeerlauf() {
  if (begruesst) return renderBegruessung();
  const wrap = el("div", "kiosk-wrap");

  const stunde = new Date().getHours();
  const gruss = stunde < 11 ? "Guten Morgen" : stunde < 18 ? "Hallo" : "Guten Abend";
  wrap.appendChild(el("div", "kiosk-head", `<div class="kiosk-greeting">${gruss} 👩‍🍳</div><h1>PIN eingeben zum Ein-/Ausstempeln</h1>`));

  if (flash) {
    wrap.appendChild(el("div", "callout", escapeHtml(flash)));
    flash = null;
  }

  // Was die Küche als Ganzes angeht, steht hier – das sieht ohnehin jeder, der den Raum betritt, und
  // erspart das Anmelden für die Frage "steht noch was an?".
  if (station && (station.auftraegeOffen > 0 || station.abgelaufen > 0)) {
    const teile = [];
    if (station.auftraegeOffen > 0) teile.push(`${station.auftraegeOffen} ${station.auftraegeOffen === 1 ? "Auftrag" : "Aufträge"} offen`);
    if (station.abgelaufen > 0) teile.push(`${station.abgelaufen} ${station.abgelaufen === 1 ? "Behälter abgelaufen" : "Behälter abgelaufen"}`);
    wrap.appendChild(
      el("div", "kiosk-faellig" + (station.abgelaufen > 0 ? " kiosk-faellig-spaet" : ""), `<div class="kiosk-faellig-kopf">🧑‍🍳 ${escapeHtml(teile.join(" · "))}</div>`)
    );
  }

  wrap.appendChild(buildPinDots(pin));
  if (fehler) wrap.appendChild(el("div", "callout callout-warn kiosk-error", escapeHtml(fehler)));
  wrap.appendChild(buildPinKeypad(taste));

  const card = el("section", "card kiosk-inservice-card");
  card.appendChild(el("h2", null, "Im Dienst"));
  const liste = station?.imDienst || [];
  if (liste.length === 0) {
    card.appendChild(el("p", "muted small", "Aktuell niemand eingestempelt."));
  } else {
    const box = el("div", "employee-list");
    for (const p of liste) {
      // Reine Anzeige: ins eigene Fenster kommt man nur über den PIN, nie über den Namen.
      const zeile = el("div", "employee-row kiosk-inservice-row");
      zeile.innerHTML = `<div class="employee-main"><b>${escapeHtml(p.name)}</b><span class="muted small">seit ${escapeHtml(p.seit || "–")} Uhr${
        p.wartet ? " · wird übertragen" : ""
      }</span></div>`;
      box.appendChild(zeile);
    }
    card.appendChild(box);
    card.appendChild(el("p", "muted small", "Zum Öffnen oder Ausstempeln den eigenen PIN eingeben."));
  }
  wrap.appendChild(card);

  // Der Hub ist ohne persönliche Anmeldung erreichbar: wer vorbeigeht, soll sehen, wie es steht.
  // Das sieht ohnehin jeder, der den Raum betritt – Stunden und Löhne stehen hier nicht drin.
  wrap.appendChild(
    knopf("📊 Übersicht der Küche", "btn btn-secondary", async () => {
      try {
        hub = await getHub(false);
        ansicht = "hub";
        window.scrollTo(0, 0);
        zeichneJetzt();
      } catch (e) {
        await zeigeFehler(e);
      }
    })
  );

  wrap.appendChild(el("p", "muted small", `Küchen-Tablet · ${APP_VERSION}${station?.updatedAt ? ` · Stand ${uhr(station.updatedAt)}` : ""}`));
  show(wrap);
}

function taste(k) {
  fehler = "";
  if (k === "⌫") {
    pin = pin.slice(0, -1);
    return zeichneJetzt();
  }
  if (k === "✓") return absendenPin();
  if (pin.length < 8) pin += k;
  zeichneJetzt();
}

async function absendenPin() {
  if (pin.length === 0) return;
  const eingabe = pin;
  pin = "";
  try {
    const p = await personAnmelden(eingabe);
    fehler = "";
    if (p.rolle === "kuechenleitung") {
      // Die Küchenleitung stempelt hier nicht ein – sie pflegt. Direkt in den Hub, mit Pflege-Rechten.
      hub = await getHub(true);
      ansicht = "hub";
      zeichneJetzt();
      starteTimer();
      return;
    }
    daten = await getOverview();
    if (daten.imDienst) {
      // Schon im Dienst: direkt ins Fenster, wie am Haupt-Tablet.
      ansicht = "fenster";
      reiter = "auftraege";
      zeichneJetzt();
      starteTimer();
    } else {
      // Sonst erst fragen – wer nur nachsehen will, was ansteht, soll sich nicht aus Versehen einstempeln.
      begruesst = { name: p.name };
      zeichneJetzt();
    }
  } catch (e) {
    clearPerson();
    fehler = /nicht erkannt/.test(e.message) ? "PIN nicht erkannt. Bitte noch einmal versuchen." : e.message;
    zeichneJetzt();
  }
}

function renderBegruessung() {
  const wrap = el("div", "kiosk-wrap");
  wrap.appendChild(
    el(
      "div",
      "kiosk-greet-card card card-highlight",
      `<div class="kiosk-greet-emoji">👋</div><h1>Hallo ${escapeHtml(begruesst.name)}!</h1><p class="muted">Schicht jetzt starten?</p>`
    )
  );
  const start = knopf("▶ Schicht starten", "btn btn-primary btn-huge", async () => {
    start.disabled = true;
    try {
      await stempeln("in");
      begruesst = null;
      daten = await getOverview();
      ansicht = "fenster";
      reiter = "auftraege";
      zeichneJetzt();
      starteTimer();
    } catch (e) {
      start.disabled = false;
      await zeigeFehler(e);
    }
  });
  wrap.appendChild(start);
  wrap.appendChild(
    knopf("← Abbrechen", "btn btn-link", () => {
      begruesst = null;
      zurueckInDenLeerlauf();
    })
  );
  show(wrap);
}

// =====================================================================
// Persönliches Fenster
// =====================================================================
function renderFenster() {
  const person = getPerson();
  const scroll = window.scrollY;
  const wrap = el("div");

  const kopf = el("div", "page");
  // "Zurück" schliesst das Fenster, ohne auszustempeln – genau wie am Haupt-Tablet.
  kopf.appendChild(knopf("← Zurück", "btn btn-link", () => zurueckInDenLeerlauf()));
  kopf.appendChild(el("h1", null, `Hallo ${escapeHtml(person?.name || "")}`));
  kopf.appendChild(el("p", "muted", `im Dienst seit ${escapeHtml(daten.seit || "–")} Uhr${daten.wartet ? " · wird übertragen" : ""}`));
  if (flash) {
    kopf.appendChild(el("div", "callout", escapeHtml(flash)));
    flash = null;
  }
  wrap.appendChild(kopf);

  const inhalt = el("div", "page");
  inhalt.appendChild(buildReiter());
  if (reiter === "auftraege") {
    inhalt.appendChild(buildAuftraege());
    inhalt.appendChild(buildNotizen());
  } else if (reiter === "bestand") {
    inhalt.appendChild(buildBestand());
  } else {
    inhalt.appendChild(buildRezepte());
  }

  const ende = el("section", "card");
  ende.appendChild(
    knopf("🚪 Schicht beenden", "btn btn-primary btn-huge", async () => {
      try {
        await stempeln("out");
        flash = `Ausgestempelt, ${person?.name || ""} – schönen Feierabend.`;
        zurueckInDenLeerlauf();
      } catch (e) {
        await zeigeFehler(e);
      }
    })
  );
  inhalt.appendChild(ende);
  wrap.appendChild(inhalt);
  show(wrap);
  window.scrollTo(0, scroll);
}

function buildReiter() {
  const nav = el("nav", "mg-nav");
  const offen = (daten.auftraege || []).length;
  for (const [id, symbol, label] of [
    ["auftraege", "🧑‍🍳", "Produzieren"],
    ["bestand", "📦", "Was da ist"],
    ["rezepte", "📖", "Rezepte"],
  ]) {
    const b = knopf("", "mg-nav-btn" + (reiter === id ? " an" : ""), () => {
      reiter = id;
      window.scrollTo(0, 0);
      zeichneJetzt();
    });
    b.innerHTML = `<span class="mg-nav-sym">${symbol}</span><span class="mg-nav-label">${label}</span>`;
    if (id === "auftraege" && offen > 0) b.appendChild(el("span", "mg-nav-badge", String(offen)));
    nav.appendChild(b);
  }
  return nav;
}

function buildAuftraege() {
  const card = el("section", "card");
  const alle = daten.auftraege || [];
  const name = (getPerson()?.name || "").trim().toLowerCase();
  const meine = alle.filter((a) => String(a.zugewiesenName || "").trim().toLowerCase() === name);
  const offen = alle.filter((a) => !a.zugewiesenName);

  card.appendChild(el("h2", null, "🧑‍🍳 Was zu machen ist"));
  if (alle.length === 0) {
    card.appendChild(el("p", "muted small", "Nichts offen – alles ist über dem Soll. Was du zusätzlich machst, trägst du unten ein."));
  } else if (meine.length > 0) {
    card.appendChild(el("p", "muted small res-bereich", "<b>Für dich</b>"));
    card.appendChild(auftragsListe(meine, true));
    if (offen.length > 0) {
      card.appendChild(el("p", "muted small res-bereich", "<b>Für die Küche</b>"));
      card.appendChild(auftragsListe(offen, false));
    }
  } else {
    card.appendChild(auftragsListe(offen, false));
  }
  card.appendChild(knopf("＋ Ohne Auftrag eintragen", "btn btn-secondary", () => openCharge(null)));
  return card;
}

function auftragsListe(auftraege, meine) {
  const liste = el("div", "task-list");
  for (const a of auftraege) {
    const p = (daten.produkte || []).find((x) => x.id === a.produktId);
    const row = el("div", "task-row" + (meine ? " task-vom-chef" : ""));
    const spaet = a.fuerDatum && a.fuerDatum < daten.datum;
    row.appendChild(
      el(
        "div",
        "task-row-text",
        `<span><b>${zahlText(a.menge)} ${escapeHtml(a.einheit || "")} ${escapeHtml(p?.name || "?")}</b></span>` +
          `<span class="muted small task-row-meta">${[
            a.quelle === "system" ? "fehlt im Bestand" : a.quelle === "chef" ? "vom Chef" : "aus der Küche",
            spaet ? `seit ${dateDe(a.fuerDatum)} offen` : null,
          ]
            .filter(Boolean)
            .map(escapeHtml)
            .join(" · ")}</span>`
      )
    );
    const akt = el("div", "employee-actions");
    akt.appendChild(knopf("Fertig", "btn btn-primary", () => openCharge(a)));
    const weg = knopf("✕", "btn btn-link", async () => {
      if (!(await frage(`„${zahlText(a.menge)} ${a.einheit} ${p?.name || ""}“ streichen, ohne zu produzieren?`, "Streichen"))) return;
      try {
        await sendeAuftragWeg(a.id);
        flash = "Auftrag gestrichen.";
        await ladeFenster();
      } catch (e) {
        await zeigeFehler(e);
      }
    });
    weg.title = "Streichen";
    akt.appendChild(weg);
    row.appendChild(akt);
    liste.appendChild(row);
  }
  return liste;
}

function openCharge(auftrag) {
  const produkte = daten.produkte || [];
  if (produkte.length === 0) return meldung("Es ist noch kein Produktionsprodukt angelegt.");

  const overlay = el("div", "overlay");
  const box = el("div", "dialog");
  box.appendChild(el("h2", null, auftrag ? "Fertig – was ist daraus geworden?" : "Produktion eintragen"));

  const feld = (label, node, hinweis) => {
    const l = el("label", "field", `<span>${label}</span>`);
    l.appendChild(node);
    if (hinweis) l.appendChild(el("p", "muted small", hinweis));
    return l;
  };
  const auswahl = (paare, wert) => {
    const sel = document.createElement("select");
    for (const [v, t] of paare) {
      const o = document.createElement("option");
      o.value = v;
      o.textContent = t;
      if (String(v) === String(wert)) o.selected = true;
      sel.appendChild(o);
    }
    return sel;
  };

  const produktSel = auswahl(produkte.map((p) => [p.id, p.name]), auftrag?.produktId || produkte[0].id);
  produktSel.disabled = !!auftrag;
  const menge = Object.assign(document.createElement("input"), { type: "text", value: auftrag ? zahlText(auftrag.menge) : "" });
  menge.inputMode = "decimal";
  const behaelterSel = document.createElement("select");
  const ort = Object.assign(document.createElement("input"), { type: "text", placeholder: "z.B. Kühlhaus, Regal 2" });
  const mhdZeile = el("p", "muted small");
  const notiz = Object.assign(document.createElement("input"), { type: "text", placeholder: "optional" });

  function aktualisiere() {
    const p = produkte.find((x) => x.id === produktSel.value);
    const belegt = new Map((daten.chargen || []).map((c) => [c.behaelterId, c]));
    behaelterSel.innerHTML = "";
    const leer = document.createElement("option");
    leer.value = "";
    leer.textContent = "– ohne Behälter –";
    behaelterSel.appendChild(leer);
    for (const b of daten.behaelter || []) {
      const drin = belegt.get(b.id);
      const o = document.createElement("option");
      o.value = b.id;
      // Belegte bleiben wählbar – man füllt auch mal nach. Aber es muss dranstehen.
      o.textContent = drin ? `${b.name} — belegt: ${produkte.find((x) => x.id === drin.produktId)?.name || "?"}` : b.name;
      behaelterSel.appendChild(o);
    }
    behaelterSel.value = p?.standardBehaelterId || "";
    ort.value = (daten.behaelter || []).find((x) => x.id === behaelterSel.value)?.ort || "";
    mhdZeile.textContent = p?.haltbarkeitTage
      ? `Haltbar ${p.haltbarkeitTage} ${p.haltbarkeitTage === 1 ? "Tag" : "Tage"} – das Datum wird automatisch eingetragen.`
      : "Für dieses Produkt ist keine Haltbarkeit hinterlegt.";
  }
  produktSel.onchange = aktualisiere;
  behaelterSel.onchange = () => {
    ort.value = (daten.behaelter || []).find((x) => x.id === behaelterSel.value)?.ort || "";
  };

  box.appendChild(feld("Was", produktSel));
  const r = el("div", "res-form-row");
  r.append(feld("Wie viel", menge), feld("In welchen Behälter", behaelterSel));
  box.appendChild(r);
  box.appendChild(feld("Wo steht es", ort));
  box.appendChild(mhdZeile);
  box.appendChild(feld("Notiz", notiz));
  aktualisiere();

  const akt = el("div", "dialog-actions");
  akt.appendChild(knopf("Abbrechen", "btn btn-secondary", () => overlay.remove()));
  const speichern = knopf("Eintragen", "btn btn-primary", async () => {
    const m = Number(String(menge.value).replace(",", "."));
    if (!Number.isFinite(m) || m <= 0) return meldung("Bitte eintragen, wie viel du gemacht hast.");
    speichern.disabled = true;
    try {
      await sendeCharge({
        produktId: produktSel.value,
        menge: m,
        behaelterId: behaelterSel.value || null,
        ort: ort.value.trim(),
        notiz: notiz.value.trim(),
        auftragId: auftrag?.id || null,
      });
      overlay.remove();
      flash = "Eingetragen. Danke.";
      await ladeFenster();
    } catch (e) {
      speichern.disabled = false;
      await zeigeFehler(e);
    }
  });
  akt.appendChild(speichern);
  box.appendChild(akt);
  overlay.appendChild(box);
  document.body.appendChild(overlay);
  menge.focus();
}

function buildBestand() {
  const card = el("section", "card");
  card.appendChild(el("h2", null, "📦 Was da ist"));
  card.appendChild(el("p", "muted small", "Die Summe der vollen Behälter. Ist einer leer, tipp ihn an – erst dann weiss das System, dass nachproduziert werden muss."));

  const heute = daten.datum;
  const abgelaufen = (daten.chargen || []).filter((c) => c.mhd && c.mhd < heute);
  if (abgelaufen.length > 0) {
    card.appendChild(
      el(
        "div",
        "callout callout-warn",
        `<b>${abgelaufen.length} ${abgelaufen.length === 1 ? "Behälter ist abgelaufen" : "Behälter sind abgelaufen"}</b><br>Zählt nicht mehr zum Bestand – bitte wegwerfen und als leer eintragen.`
      )
    );
  }

  const produkte = daten.produkte || [];
  if (produkte.length === 0) {
    card.appendChild(el("p", "muted small", "Noch kein Produktionsprodukt angelegt."));
    return card;
  }

  for (const p of produkte) {
    const chargen = (daten.chargen || []).filter((c) => c.produktId === p.id);
    const ist = chargen.filter((c) => !c.mhd || c.mhd >= heute).reduce((n, c) => n + Number(c.menge || 0), 0);
    const knapp = p.soll > 0 && ist < p.soll;

    const block = el("div");
    block.appendChild(
      el(
        "div",
        "summary-line",
        `<span><b>${escapeHtml(p.name)}</b></span><span class="${knapp ? "res-warn" : ""}">${zahlText(ist)} / ${zahlText(p.soll)} ${escapeHtml(p.einheit || "")}</span>`
      )
    );
    if (chargen.length === 0) {
      block.appendChild(el("p", "muted small", "Kein voller Behälter."));
    } else {
      const liste = el("div", "task-list");
      for (const c of chargen) {
        const b = (daten.behaelter || []).find((x) => x.id === c.behaelterId);
        const alt = c.mhd && c.mhd < heute;
        const row = el("div", "task-row" + (alt ? " done" : ""));
        row.appendChild(
          el(
            "div",
            "task-row-text",
            `<span><b>${zahlText(c.menge)} ${escapeHtml(c.einheit || "")}</b> in ${escapeHtml(b?.name || "– ohne Behälter –")}</span>` +
              `<span class="muted small task-row-meta">${[
                c.ort,
                c.vonName ? `von ${c.vonName}` : null,
                wann(c.am),
                c.mhd ? (alt ? `⚠ abgelaufen seit ${dateDe(c.mhd)} – zählt nicht mehr` : `haltbar bis ${dateDe(c.mhd)}`) : null,
              ]
                .filter(Boolean)
                .map(escapeHtml)
                .join(" · ")}</span>`
          )
        );
        row.appendChild(
          knopf(alt ? "Weggeworfen" : "Leer", "btn btn-secondary", async () => {
            const text = alt ? `${b?.name || "Der Behälter"} weggeworfen und sauber?` : `${b?.name || "Der Behälter"} ist leer?`;
            if (!(await frage(text, alt ? "Weggeworfen" : "Ist leer"))) return;
            try {
              await sendeLeer(c.id);
              flash = "Eingetragen.";
              await ladeFenster();
            } catch (e) {
              await zeigeFehler(e);
            }
          })
        );
        liste.appendChild(row);
      }
      block.appendChild(liste);
    }
    card.appendChild(block);
  }
  return card;
}

function buildRezepte() {
  const card = el("section", "card");
  card.appendChild(el("h2", null, "📖 Rezepte"));
  const rezepte = daten.rezepte || [];
  if (rezepte.length === 0) {
    card.appendChild(el("p", "muted small", "Noch keine Rezepte hinterlegt."));
    return card;
  }
  const gruppen = el("div", "group-list");
  for (const r of rezepte) {
    const wrap = el("div");
    const kopf = document.createElement("button");
    kopf.type = "button";
    kopf.className = "group-header";
    kopf.innerHTML = `<span class="group-header-chevron">▶</span><span class="group-header-name">${escapeHtml(r.name)}</span><span class="group-header-meta">${escapeHtml(
      r.ergibt || ""
    )}</span>`;
    const body = el("div", "group-body");
    body.hidden = true;
    kopf.onclick = () => {
      body.hidden = !body.hidden;
      kopf.classList.toggle("open", !body.hidden);
    };
    if ((r.zutaten || []).length > 0) {
      body.appendChild(el("p", "muted small res-bereich", "<b>Zutaten</b>"));
      body.appendChild(el("ul", null, r.zutaten.map((z) => `<li>${escapeHtml(z)}</li>`).join("")));
    }
    if ((r.schritte || []).length > 0) {
      body.appendChild(el("p", "muted small res-bereich", "<b>So geht's</b>"));
      body.appendChild(el("ol", null, r.schritte.map((z) => `<li>${escapeHtml(z)}</li>`).join("")));
    }
    if (r.notiz) body.appendChild(el("p", "muted small", escapeHtml(r.notiz)));
    wrap.append(kopf, body);
    gruppen.appendChild(wrap);
  }
  card.appendChild(gruppen);
  return card;
}

function buildNotizen() {
  const notizen = daten.notizen || [];
  if (notizen.length === 0) return el("div");
  const card = el("section", "card");
  card.appendChild(el("h2", null, "📝 Für die nächste Schicht"));
  const liste = el("div", "task-list");
  for (const n of notizen.slice(0, 10)) {
    liste.appendChild(
      el(
        "div",
        "task-row",
        `<div class="task-row-text"><span>${escapeHtml(n.text)}</span><span class="muted small task-row-meta">${escapeHtml(
          [n.von, n.fuer ? `für ${dateDe(n.fuer)}` : null].filter(Boolean).join(" · ")
        )}</span></div>`
      )
    );
  }
  card.appendChild(liste);
  card.appendChild(el("p", "muted small", "Eintragen kannst du sie am Haupt-Tablet."));
  return card;
}

// =====================================================================
// Der Hub: wie es in der Küche steht
//
// Erreichbar ohne persönliche Anmeldung. Die Küchenleitung sieht dasselbe und kann zusätzlich pflegen.
// Gerechnet wird alles im Worker, nicht hier und schon gar nicht von einem Modell: eine Zahl, die sich
// jemand ausgedacht hat, wäre schlimmer als gar keine Auswertung.
// =====================================================================
function renderHub() {
  const scroll = window.scrollY;
  const wrap = el("div");
  const kopf = el("div", "page");
  kopf.appendChild(
    knopf("← Zurück", "btn btn-link", () => {
      hub = null;
      zurueckInDenLeerlauf();
    })
  );
  kopf.appendChild(el("h1", null, "📊 Übersicht der Küche"));
  kopf.appendChild(
    el("p", "muted", hub.darfPflegen ? `Angemeldet als ${escapeHtml(hub.name)} – du kannst hier pflegen.` : "Zum Ändern mit dem PIN der Küchenleitung anmelden.")
  );
  if (flash) {
    kopf.appendChild(el("div", "callout", escapeHtml(flash)));
    flash = null;
  }
  wrap.appendChild(kopf);

  const inhalt = el("div", "page");

  // --- Was jetzt ansteht ---
  const jetzt = el("section", "card");
  jetzt.appendChild(el("h2", null, "Jetzt"));
  const unterSoll = (hub.produkte || []).filter((p) => p.unterSoll);
  const zeilen = [
    `${hub.auftraegeOffen} ${hub.auftraegeOffen === 1 ? "Auftrag" : "Aufträge"} offen`,
    `${unterSoll.length} ${unterSoll.length === 1 ? "Produkt" : "Produkte"} unter Soll`,
    `${(hub.ablaufend || []).length} ${(hub.ablaufend || []).length === 1 ? "Behälter läuft ab" : "Behälter laufen ab"}`,
  ];
  jetzt.appendChild(el("p", (hub.ablaufend || []).length > 0 || unterSoll.length > 0 ? "callout callout-warn" : "callout", escapeHtml(zeilen.join(" · "))));
  if ((hub.ablaufend || []).length > 0) {
    const liste = el("div", "mg-liste");
    for (const a of hub.ablaufend.slice(0, 8)) {
      const hin = a.mhd < hub.datum ? "abgelaufen" : a.mhd === hub.datum ? "heute" : `bis ${dateDe(a.mhd)}`;
      liste.appendChild(
        el(
          "div",
          "summary-line",
          `<span>${escapeHtml(a.produkt)} <span class="muted small">${escapeHtml(a.behaelter || "ohne Behälter")}</span></span><span class="${
            a.mhd < hub.datum ? "res-warn" : ""
          }">${escapeHtml(hin)}</span>`
        )
      );
    }
    jetzt.appendChild(liste);
  }
  inhalt.appendChild(jetzt);

  // --- Je Produkt: Bestand, Produktion, Ausschuss ---
  const prod = el("section", "card");
  prod.appendChild(el("h2", null, "Produkte"));
  prod.appendChild(el("p", "muted small", "Was da ist, was in den letzten Wochen produziert wurde, und was davon in die Tonne ging."));
  if ((hub.produkte || []).length === 0) {
    prod.appendChild(el("p", "muted small", "Noch kein Produktionsprodukt angelegt."));
  } else {
    const scrollBox = el("div");
    scrollBox.style.overflowX = "auto";
    const tabelle = document.createElement("table");
    tabelle.className = "calc-table";
    tabelle.innerHTML = `<thead><tr><th>Produkt</th><th>Ist / Soll</th><th>7 Tage</th><th>30 Tage</th><th>Ausschuss</th>${
      hub.darfPflegen ? "<th></th>" : ""
    }</tr></thead>`;
    const tbody = document.createElement("tbody");
    for (const p of hub.produkte) {
      const tr = document.createElement("tr");
      // Ausschuss ab 10 % ist der Punkt, an dem das Soll zu hoch steht – das soll ins Auge fallen.
      const hoch = p.ausschussAnteil >= 10;
      tr.innerHTML =
        `<td><b>${escapeHtml(p.name)}</b></td>` +
        `<td class="${p.unterSoll ? "res-warn" : ""}">${zahlText(p.ist)} / ${zahlText(p.soll)} ${escapeHtml(p.einheit || "")}</td>` +
        `<td>${zahlText(p.produziert7)}</td>` +
        `<td>${zahlText(p.produziert30)}</td>` +
        `<td class="${hoch ? "res-warn" : ""}">${p.ausschuss30 > 0 ? `${zahlText(p.ausschuss30)} (${p.ausschussAnteil} %)` : "–"}</td>`;
      if (hub.darfPflegen) {
        const td = document.createElement("td");
        td.appendChild(knopf("Ändern", "btn btn-secondary", () => openProduktForm(p)));
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    tabelle.appendChild(tbody);
    scrollBox.appendChild(tabelle);
    prod.appendChild(scrollBox);
  }
  if (hub.darfPflegen) {
    prod.appendChild(knopf("＋ Produkt", "btn btn-primary", () => openProduktForm(null)));
    prod.appendChild(knopf("＋ Auftrag geben", "btn btn-secondary", () => openAuftragForm()));
  }
  inhalt.appendChild(prod);

  // --- Behälter ---
  const beh = el("section", "card");
  beh.appendChild(el("h2", null, "Behälter"));
  const bListe = el("div", "task-list");
  for (const b of hub.behaelter || []) {
    const row = el("div", "task-row");
    row.appendChild(
      el(
        "div",
        "task-row-text",
        `<span><b>${escapeHtml(b.name)}</b></span><span class="muted small task-row-meta">${escapeHtml(
          [b.groesse, b.ort].filter(Boolean).join(" · ") || "ohne Angabe"
        )}${b.belegtMit ? ` · <b>belegt: ${escapeHtml(b.belegtMit)}</b>` : " · frei"}</span>`
      )
    );
    if (hub.darfPflegen) row.appendChild(knopf("Ändern", "btn btn-secondary", () => openBehaelterForm(b)));
    bListe.appendChild(row);
  }
  if ((hub.behaelter || []).length === 0) beh.appendChild(el("p", "muted small", "Noch kein Behälter angelegt."));
  else beh.appendChild(bListe);
  if (hub.darfPflegen) beh.appendChild(knopf("＋ Behälter", "btn btn-primary", () => openBehaelterForm(null)));
  inhalt.appendChild(beh);

  // --- Verbrauch und Reichweite ---
  //
  // Die Zahl, nach der man bestellt. Sie kommt aus den Zählungen: zwischen zwei Zählungen liegt der
  // Verbrauch. Wo zu wenig gezählt wurde, steht das auch dort – geraten wird nicht.
  // Selbst Hergestelltes steht in seiner eigenen Karte – hier geht es um das, was eingekauft wird.
  const verb = (hub.verbrauch || []).filter((v) => !v.produzierbar);
  if (verb.length > 0) {
    const vk = el("section", "card");
    vk.appendChild(el("h2", null, "📉 Verbrauch und Reichweite"));
    vk.appendChild(el("p", "muted small", "Aus den Zählungen gerechnet. Wurde zwischendurch geliefert, bleibt der Abschnitt aussen vor – lieber eine Zahl aus wenigen gemessenen Tagen als eine geschätzte."));
    const scrollBox = el("div");
    scrollBox.style.overflowX = "auto";
    const tabelle = document.createElement("table");
    tabelle.className = "calc-table";
    tabelle.innerHTML = `<thead><tr><th>Artikel</th><th>Da</th><th>Pro Tag</th><th>Reicht noch</th><th>Je 100 Stück</th></tr></thead>`;
    const tbody = document.createElement("tbody");
    for (const v of verb) {
      const knapp = v.reichweite !== null && v.reichweite <= 3;
      const tr = document.createElement("tr");
      tr.innerHTML =
        `<td><b>${escapeHtml(v.name)}</b></td>` +
        `<td>${v.ist === null ? "–" : zahlText(v.ist)} ${escapeHtml(v.einheit || "")}</td>` +
        `<td>${v.proTag === null ? '<span class="muted small">noch zu wenig gezählt</span>' : zahlText(v.proTag)}</td>` +
        `<td class="${knapp ? "res-warn" : ""}">${
          v.reichweite === null ? "–" : v.reichweite === 0 ? "<b>heute leer</b>" : `${v.reichweite} ${v.reichweite === 1 ? "Tag" : "Tage"}`
        }</td>` +
        `<td class="muted small">${v.jeHundert === null ? "–" : zahlText(v.jeHundert)}</td>`;
      tbody.appendChild(tr);
    }
    tabelle.appendChild(tbody);
    scrollBox.appendChild(tabelle);
    vk.appendChild(scrollBox);
    const ohne = verb.filter((v) => v.proTag === null).length;
    if (ohne > 0) {
      vk.appendChild(
        el(
          "p",
          "muted small",
          `Bei ${ohne} ${ohne === 1 ? "Artikel" : "Artikeln"} reichen die Zählungen noch nicht. Zwei Zählungen über mindestens drei Tage, dann steht hier eine Zahl.`
        )
      );
    }
    inhalt.appendChild(vk);
  }

  // --- Wer hat was gemacht ---
  if ((hub.personen || []).length > 0) {
    const pers = el("section", "card");
    pers.appendChild(el("h2", null, "Letzte 30 Tage"));
    const liste = el("div", "mg-liste");
    for (const p of hub.personen) {
      liste.appendChild(
        el(
          "div",
          "summary-line",
          `<span>${escapeHtml(p.name)}</span><span>${p.chargen} ${p.chargen === 1 ? "Charge" : "Chargen"} <span class="muted small">· ${p.produkte} ${
            p.produkte === 1 ? "Produkt" : "Produkte"
          }</span></span>`
        )
      );
    }
    pers.appendChild(liste);
    inhalt.appendChild(pers);
  }

  wrap.appendChild(inhalt);
  show(wrap);
  window.scrollTo(0, scroll);
}

/** Kleines Formular-Gerüst für die Pflege.
 *
 * `felderBauen` baut die Felder in den Kasten und gibt zurück, wie man sie ausliest: entweder die
 * fertigen Daten oder eine Meldung, warum es so nicht geht. Damit bleibt jedes Formular ein Stück
 * Code statt zweier, die sich über eine Hilfsvariable verständigen. */
function stammForm(titel, felderBauen) {
  const overlay = el("div", "overlay");
  const box = el("div", "dialog");
  box.appendChild(el("h2", null, titel));
  const feld = (label, node, hinweis) => {
    const l = el("label", "field", `<span>${label}</span>`);
    l.appendChild(node);
    if (hinweis) l.appendChild(el("p", "muted small", hinweis));
    return l;
  };
  const lesen = felderBauen(box, feld);
  const akt = el("div", "dialog-actions");
  akt.appendChild(knopf("Abbrechen", "btn btn-secondary", () => overlay.remove()));
  const ok = knopf("Speichern", "btn btn-primary", async () => {
    const { daten, fehler: warum } = lesen();
    if (!daten) return meldung(warum);
    ok.disabled = true;
    if (await pflege(daten)) overlay.remove();
    else ok.disabled = false;
  });
  akt.appendChild(ok);
  box.appendChild(akt);
  overlay.appendChild(box);
  document.body.appendChild(overlay);
}

const textFeld = (wert, platzhalter = "") => Object.assign(document.createElement("input"), { type: "text", value: wert ?? "", placeholder: platzhalter });
const kommaFeld = (wert, platzhalter = "") => {
  const i = textFeld(wert ? zahlText(wert) : "", platzhalter);
  i.inputMode = "decimal";
  return i;
};
const auswahlFeld = (paare, wert) => {
  const sel = document.createElement("select");
  for (const [v, t] of paare) {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = t;
    if (String(v) === String(wert)) o.selected = true;
    sel.appendChild(o);
  }
  return sel;
};
const zahlAus = (f) => Number(String(f.value).replace(",", ".")) || 0;

async function pflege(daten) {
  try {
    await sendeStamm(daten);
    flash = "Gespeichert. Das Haupt-Tablet übernimmt es beim nächsten Abgleich.";
    hub = await getHub(true);
    zeichneJetzt();
    return true;
  } catch (e) {
    await zeigeFehler(e);
    return false;
  }
}

function openProduktForm(vorhanden) {
  stammForm(vorhanden ? "Produkt ändern" : "Neues Produktionsprodukt", (box, feld) => {
    const name = textFeld(vorhanden?.name, "z.B. Zimtschnecken-Teig");
    const einheit = textFeld(vorhanden?.einheit || "Blech", "Blech, Liter, kg …");
    const soll = kommaFeld(vorhanden?.soll, "z.B. 4");
    const gebinde = kommaFeld(vorhanden?.gebinde, "z.B. 1");
    const haltbar = kommaFeld(vorhanden?.haltbarkeitTage, "z.B. 3");
    const rezept = auswahlFeld([["", "– kein Rezept –"], ...(hub.rezepte || []).map((r) => [r.id, r.name])], "");
    box.appendChild(feld("Produkt", name));
    const r1 = el("div", "res-form-row");
    r1.append(feld("Soll (immer da)", soll), feld("Einheit", einheit));
    box.appendChild(r1);
    const r2 = el("div", "res-form-row");
    r2.append(feld("Gebinde", gebinde, "Portion, in der produziert wird."), feld("Haltbar (Tage)", haltbar, "0 = kein MHD."));
    box.appendChild(r2);
    box.appendChild(feld("Rezept", rezept));
    return () =>
      name.value.trim()
        ? {
            daten: {
              art: "produkt",
              id: vorhanden?.produktId || null,
              name: name.value.trim(),
              einheit: einheit.value.trim(),
              soll: zahlAus(soll),
              gebinde: zahlAus(gebinde),
              haltbarkeitTage: Math.round(zahlAus(haltbar)),
              rezeptId: rezept.value || null,
            },
          }
        : { daten: null, fehler: "Bitte einen Namen eintragen." };
  });
}

function openBehaelterForm(vorhanden) {
  stammForm(vorhanden ? "Behälter ändern" : "Neuer Behälter", (box, feld) => {
    const name = textFeld(vorhanden?.name, "z.B. GN 1/1 – 3");
    const groesse = textFeld(vorhanden?.groesse, "z.B. 10 L");
    const ort = textFeld(vorhanden?.ort, "z.B. Kühlhaus, Regal 2");
    box.appendChild(feld("Name", name, "Eindeutig und am Behälter lesbar – beschrifte ihn genauso."));
    const r = el("div", "res-form-row");
    r.append(feld("Grösse", groesse), feld("Steht normalerweise", ort));
    box.appendChild(r);
    return () =>
      name.value.trim()
        ? { daten: { art: "behaelter", id: vorhanden?.id || null, name: name.value.trim(), groesse: groesse.value.trim(), ort: ort.value.trim() } }
        : { daten: null, fehler: "Bitte einen Namen eintragen." };
  });
}

function openAuftragForm() {
  stammForm("Auftrag geben", (box, feld) => {
    const produkt = auswahlFeld((hub.produkte || []).map((p) => [p.produktId, p.name]), (hub.produkte || [])[0]?.produktId);
    const menge = kommaFeld("", "z.B. 4");
    const fuer = textFeld("", "Name, oder leer für die ganze Küche");
    box.appendChild(feld("Was", produkt));
    box.appendChild(feld("Wie viel", menge));
    box.appendChild(feld("Für wen", fuer, "Leer heisst: gilt für jeden in der Küche."));
    return () =>
      zahlAus(menge) > 0
        ? { daten: { art: "auftrag", produktId: produkt.value, menge: zahlAus(menge), fuer: fuer.value.trim() } }
        : { daten: null, fehler: "Bitte eine Menge grösser als null eintragen." };
  });
}

// =====================================================================
// Dialoge
// =====================================================================
function meldung(text) {
  return new Promise((fertig) => {
    const overlay = el("div", "overlay");
    const box = el("div", "dialog", `<h2>Hinweis</h2><p>${escapeHtml(text)}</p>`);
    const akt = el("div", "dialog-actions");
    akt.appendChild(
      knopf("OK", "btn btn-primary", () => {
        overlay.remove();
        fertig();
      })
    );
    box.appendChild(akt);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
  });
}

function frage(text, okLabel = "OK") {
  return new Promise((fertig) => {
    const overlay = el("div", "overlay");
    const box = el("div", "dialog", `<h2>Bitte bestätigen</h2><p>${escapeHtml(text)}</p>`);
    const akt = el("div", "dialog-actions");
    akt.appendChild(
      knopf("Abbrechen", "btn btn-secondary", () => {
        overlay.remove();
        fertig(false);
      })
    );
    akt.appendChild(
      knopf(okLabel, "btn btn-primary", () => {
        overlay.remove();
        fertig(true);
      })
    );
    box.appendChild(akt);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
  });
}

async function zeigeFehler(e) {
  if (e?.abgemeldet) {
    // Welche der beiden Anmeldungen abgelaufen ist, zeigt sich durch Ausprobieren: geht der Leerlauf
    // noch, war es die persönliche – dann muss nur der nächste PIN neu getippt werden.
    clearPerson();
    daten = null;
    try {
      station = await getStation();
      flash = "Die Anmeldung ist abgelaufen. Bitte PIN neu eingeben.";
      ansicht = "leerlauf";
      zeichneJetzt();
      starteTimer();
    } catch {
      clearGeraet();
      renderEinrichtung("Der Zugang des Tablets gilt nicht mehr. Bitte neu einrichten.");
    }
    return;
  }
  await meldung("⚠ " + e.message);
}

// =====================================================================
// Laden, Zeichnen, Abgleich
// =====================================================================
function zeichneJetzt() {
  if (ansicht === "fenster" && daten) renderFenster();
  else if (ansicht === "hub" && hub) renderHub();
  else renderLeerlauf();
}

function zurueckInDenLeerlauf() {
  clearPerson();
  daten = null;
  hub = null;
  begruesst = null;
  pin = "";
  fehler = "";
  ansicht = "leerlauf";
  reiter = "auftraege";
  window.scrollTo(0, 0);
  // Der Leerlauf soll sofort stimmen – wer gerade ausgestempelt hat, darf nicht noch dastehen.
  ladeStation().catch(() => zeichneJetzt());
}

async function ladeStation() {
  if (!getGeraet()) return renderEinrichtung();
  try {
    station = await getStation();
    ansicht = "leerlauf";
    zeichneJetzt();
    starteTimer();
  } catch (e) {
    if (e.abgemeldet) {
      clearGeraet();
      return renderEinrichtung("Der Zugang des Tablets gilt nicht mehr. Bitte neu einrichten.");
    }
    if (station) {
      // Der Stand von eben ist besser als eine leere Seite.
      flash = "⚠ " + e.message;
      zeichneJetzt();
      return;
    }
    const box = el("div", "page");
    box.appendChild(el("div", "callout callout-warn", "⚠ " + escapeHtml(e.message)));
    box.appendChild(knopf("Nochmal versuchen", "btn btn-secondary", () => ladeStation()));
    show(box);
  }
}

async function ladeFenster() {
  try {
    daten = await getOverview();
    zeichneJetzt();
  } catch (e) {
    await zeigeFehler(e);
  }
}

function starteTimer() {
  stoppeTimer();
  const takt = ansicht === "fenster" ? FENSTER_ABGLEICH_MS : LEERLAUF_ABGLEICH_MS;
  timer = setInterval(() => {
    if (document.querySelector(".overlay")) return; // nicht neu zeichnen, während jemand tippt
    if (ansicht === "fenster" || ansicht === "hub") {
      if (Date.now() - letzteBeruehrung > FENSTER_ZU_NACH_MS) {
        // NUR das Fenster schliessen, nicht ausstempeln: wer in der Küche steht, arbeitet weiter.
        flash = ansicht === "hub" ? "Übersicht geschlossen." : "Fenster geschlossen – du bist weiter eingestempelt.";
        zurueckInDenLeerlauf();
        return;
      }
      if (ansicht === "hub") getHub(!!hub?.darfPflegen).then((d) => { hub = d; zeichneJetzt(); }).catch(() => {});
      else ladeFenster().catch(() => {});
    } else {
      // Im Leerlauf nicht neu zeichnen, während jemand gerade einen PIN tippt.
      if (pin.length > 0 || begruesst) return;
      ladeStation().catch(() => {});
    }
  }, takt);
}
function stoppeTimer() {
  if (timer) clearInterval(timer);
  timer = null;
}

if (getGeraet() && getWorkerUrl()) ladeStation();
else renderEinrichtung();
