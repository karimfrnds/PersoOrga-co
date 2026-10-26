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
  getOverview,
  stempeln,
  sendeCharge,
  sendeLeer,
  sendeAuftragWeg,
} from "./api.js";
import { buildPinDots, buildPinKeypad } from "../pinpad.js";
import { escapeHtml, dateDe, todayStr } from "../format.js";

const APP_VERSION = "2026-10-26.2";
const outlet = document.getElementById("outlet");

// Wie lange ein persönliches Fenster offen bleiben darf, ohne dass jemand es anfasst. Danach zurück in
// den Leerlauf – nicht ausgestempelt, nur geschlossen. Ein offenes Fenster auf fremden Namen ist auf
// einem geteilten Gerät gefährlicher als ein PIN, den jemand noch einmal tippt.
const FENSTER_ZU_NACH_MS = 3 * 60 * 1000;
const LEERLAUF_ABGLEICH_MS = 30 * 1000;
const FENSTER_ABGLEICH_MS = 60 * 1000;

let ansicht = "leerlauf"; // "leerlauf" | "fenster"
let station = null; // Daten des Leerlaufs
let daten = null; // Daten des persönlichen Fensters
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
  else renderLeerlauf();
}

function zurueckInDenLeerlauf() {
  clearPerson();
  daten = null;
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
    if (ansicht === "fenster") {
      if (Date.now() - letzteBeruehrung > FENSTER_ZU_NACH_MS) {
        // NUR das Fenster schliessen, nicht ausstempeln: wer in der Küche steht, arbeitet weiter.
        flash = "Fenster geschlossen – du bist weiter eingestempelt.";
        zurueckInDenLeerlauf();
        return;
      }
      ladeFenster().catch(() => {});
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
