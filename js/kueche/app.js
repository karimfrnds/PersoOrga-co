// ============================================================================
// kueche/app.js – das Tablet in der Produktionsküche.
//
// Es hält KEINE eigenen Daten. Es liest, was das Haupt-Tablet geschickt hat, und legt alles, was hier
// jemand tut, in eine Warteschlange, die das Haupt-Tablet abarbeitet. Zwei Geräte mit je eigener Kopie
// derselben Daten waren schon einmal der Grund, warum ein abgeschlossener Tag verschwunden ist.
//
// Gebaut für Hände, die gerade Teig anhatten: grosse Flächen, wenig Text, ein Schritt pro Bild.
// Wer fertig ist, meldet sich ab – das Gerät gehört niemandem, und die nächste Schicht soll nicht
// versehentlich auf fremden Namen stempeln. Nach fünf Minuten ohne Berührung passiert das von selbst.
// ============================================================================
import { getSession, clearSession, getWorkerUrl, setWorkerUrl, login, getOverview, stempeln, sendeCharge, sendeLeer, sendeAuftragWeg } from "./api.js";
import { buildPinDots, buildPinKeypad } from "../pinpad.js";
import { escapeHtml, dateDe, todayStr } from "../format.js";

const APP_VERSION = "2026-10-26.1";
const outlet = document.getElementById("outlet");

// Nach dieser Zeit ohne Berührung meldet sich das Tablet von selbst ab.
const ABMELDEN_NACH_MS = 5 * 60 * 1000;
// So oft holt es neue Aufträge – in der Küche ändert sich nichts im Sekundentakt.
const ABGLEICH_MS = 60 * 1000;

let daten = null;
let ansicht = "auftraege"; // "auftraege" | "bestand" | "rezepte"
let flash = null;
let letzteBeruehrung = Date.now();
let abgleichTimer = null;

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
/** "heute 14:20" statt eines Datums, solange es heute war – darum geht es in der Küche meistens. */
const wann = (iso) => {
  if (!iso) return "";
  const tag = String(iso).slice(0, 10);
  const heute = todayStr();
  if (tag === heute) return `heute ${uhr(iso)}`;
  return `${dateDe(tag)}, ${uhr(iso)}`;
};

for (const ereignis of ["pointerdown", "keydown", "touchstart"]) {
  window.addEventListener(ereignis, () => (letzteBeruehrung = Date.now()), { passive: true });
}

// ---------------------------------------------------------------------
// Anmeldung
// ---------------------------------------------------------------------
function renderLogin(meldung) {
  stoppeAbgleich();
  // Die Nächste fängt bei "Produzieren" an, nicht dort, wo die Vorgängerin aufgehört hat.
  ansicht = "auftraege";
  const wrap = el("div", "page kiosk-wrap");
  wrap.appendChild(el("div", "kiosk-head", `<div class="kiosk-greeting">👩‍🍳 Produktionsküche</div><h1>PIN eingeben</h1>`));

  const card = el("section", "card");
  let urlInput = null;
  if (!getWorkerUrl()) {
    urlInput = document.createElement("input");
    urlInput.type = "text";
    urlInput.placeholder = "https://…workers.dev";
    const l = el("label", "field", "<span>Adresse (einmalig, bekommst du von Karim)</span>");
    l.appendChild(urlInput);
    card.appendChild(l);
  }

  let pin = "";
  const status = el("p", meldung ? "callout callout-warn" : "muted small", meldung || "Mit dem eigenen PIN anmelden.");
  const punkte = el("div");
  const zeichne = () => {
    punkte.innerHTML = "";
    punkte.appendChild(buildPinDots(pin));
  };
  zeichne();

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
      zeichne();
      status.className = "callout callout-warn";
      status.textContent = "⚠ " + e.message;
    }
  };
  card.append(status, punkte, buildPinKeypad((taste) => {
    if (taste === "⌫") pin = pin.slice(0, -1);
    else if (taste === "✓") return absenden();
    else if (pin.length < 8) pin += taste;
    zeichne();
  }));
  wrap.appendChild(card);
  wrap.appendChild(el("p", "muted small", `Küchen-Tablet · ${APP_VERSION}`));
  show(wrap);
}

// ---------------------------------------------------------------------
// Aufbau
// ---------------------------------------------------------------------
function renderShell() {
  const session = getSession();
  const scroll = window.scrollY;
  const wrap = el("div");

  const kopf = el("header", "mg-kopf");
  const titel = el("div", "mg-kopf-titel");
  titel.appendChild(el("b", null, `👩‍🍳 ${escapeHtml(session?.name || "")}`));
  titel.appendChild(
    el(
      "span",
      "muted small",
      daten.imDienst ? `im Dienst seit ${escapeHtml(daten.seit || "–")} Uhr${daten.wartet ? " · wird übertragen" : ""}` : "nicht eingestempelt"
    )
  );
  const aktionen = el("div", "mg-kopf-aktionen");
  aktionen.appendChild(knopf("↻", "mg-icon-btn", () => laden({ still: true })));
  aktionen.appendChild(
    // Bewusst nicht "Fertig": so heisst der Knopf an einem Auftrag. Zwei gleich benannte Knöpfe auf
    // einem Bildschirm, von denen einer abmeldet, sind in einer Küche ein Fehlgriff, der passiert.
    knopf("Abmelden", "btn btn-secondary", () => {
      clearSession();
      daten = null;
      renderLogin("Abgemeldet. Der oder die Nächste bitte.");
    })
  );
  kopf.append(titel, aktionen);
  wrap.appendChild(kopf);

  const inhalt = el("div", "page");
  if (flash) {
    inhalt.appendChild(el("div", "callout", escapeHtml(flash)));
    flash = null;
  }
  inhalt.appendChild(buildStempel());

  if (!daten.imDienst) {
    // Ohne Schicht keine Produktion: was jemand macht, muss einer Schicht zuzuordnen sein, sonst taucht
    // Arbeitszeit nirgends auf und am Monatsende fehlt sie auf der Abrechnung.
    inhalt.appendChild(
      el("div", "callout callout-warn", "<b>Erst einstempeln.</b><br>Aufträge und Bestand siehst du, sobald deine Schicht läuft – was du machst, gehört zu deiner Arbeitszeit.")
    );
    if ((daten.rezepte || []).length > 0) inhalt.appendChild(buildRezepte());
    wrap.appendChild(inhalt);
    show(wrap);
    window.scrollTo(0, scroll);
    return;
  }

  inhalt.appendChild(buildReiter());
  if (ansicht === "auftraege") inhalt.appendChild(buildAuftraege());
  else if (ansicht === "bestand") inhalt.appendChild(buildBestand());
  else inhalt.appendChild(buildRezepte());
  if (ansicht === "auftraege") inhalt.appendChild(buildNotizen());
  wrap.appendChild(inhalt);
  show(wrap);
  window.scrollTo(0, scroll);
}

function buildStempel() {
  const card = el("section", "card");
  const b = document.createElement("button");
  b.className = "btn btn-huge " + (daten.imDienst ? "btn-secondary" : "btn-primary");
  b.textContent = daten.imDienst ? "🚪 Schicht beenden" : "▶ Schicht starten";
  b.onclick = async () => {
    b.disabled = true;
    try {
      await stempeln(daten.imDienst ? "out" : "in");
      flash = daten.imDienst ? "Ausgestempelt. Schönen Feierabend." : "Eingestempelt. Los geht's.";
      await laden({ still: true });
    } catch (e) {
      b.disabled = false;
      await zeigeFehler(e);
    }
  };
  card.appendChild(b);
  return card;
}

function buildReiter() {
  const nav = el("nav", "mg-nav");
  const offen = (daten.auftraege || []).length;
  for (const [id, symbol, label] of [
    ["auftraege", "🧑‍🍳", "Produzieren"],
    ["bestand", "📦", "Was da ist"],
    ["rezepte", "📖", "Rezepte"],
  ]) {
    const b = knopf("", "mg-nav-btn" + (ansicht === id ? " an" : ""), () => {
      ansicht = id;
      window.scrollTo(0, 0);
      renderShell();
    });
    b.innerHTML = `<span class="mg-nav-sym">${symbol}</span><span class="mg-nav-label">${label}</span>`;
    if (id === "auftraege" && offen > 0) b.appendChild(el("span", "mg-nav-badge", String(offen)));
    nav.appendChild(b);
  }
  return nav;
}

// ---------------------------------------------------------------------
// Aufträge
// ---------------------------------------------------------------------
function buildAuftraege() {
  const card = el("section", "card");
  const alle = daten.auftraege || [];
  const name = (getSession()?.name || "").trim().toLowerCase();
  const meine = alle.filter((a) => String(a.zugewiesenName || "").trim().toLowerCase() === name);
  const offen = alle.filter((a) => !a.zugewiesenName);

  card.appendChild(el("h2", null, "🧑‍🍳 Was zu machen ist"));
  if (alle.length === 0) {
    card.appendChild(el("p", "muted small", "Nichts offen – alles ist über dem Soll. Was du zusätzlich machst, trägst du unten ein."));
  } else {
    if (meine.length > 0) {
      card.appendChild(el("p", "muted small res-bereich", "<b>Für dich</b>"));
      card.appendChild(auftragsListe(meine, true));
      if (offen.length > 0) {
        card.appendChild(el("p", "muted small res-bereich", "<b>Für die Küche</b>"));
        card.appendChild(auftragsListe(offen, false));
      }
    } else {
      card.appendChild(auftragsListe(offen, false));
    }
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
      if (!confirm(`„${zahlText(a.menge)} ${a.einheit} ${p?.name || ""}“ streichen, ohne zu produzieren?`)) return;
      try {
        await sendeAuftragWeg(a.id);
        flash = "Auftrag gestrichen.";
        await laden({ still: true });
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

// ---------------------------------------------------------------------
// Produktion eintragen
// ---------------------------------------------------------------------
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
    const b = (daten.behaelter || []).find((x) => x.id === behaelterSel.value);
    ort.value = b?.ort || "";
    mhdZeile.textContent = p?.haltbarkeitTage
      ? `Haltbar ${p.haltbarkeitTage} ${p.haltbarkeitTage === 1 ? "Tag" : "Tage"} – das Datum wird automatisch eingetragen.`
      : "Für dieses Produkt ist keine Haltbarkeit hinterlegt.";
  }
  produktSel.onchange = aktualisiere;
  behaelterSel.onchange = () => {
    const b = (daten.behaelter || []).find((x) => x.id === behaelterSel.value);
    ort.value = b?.ort || "";
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
      await laden({ still: true });
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

// ---------------------------------------------------------------------
// Was da ist
// ---------------------------------------------------------------------
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
        `<b>${abgelaufen.length} ${abgelaufen.length === 1 ? "Behälter ist abgelaufen" : "Behälter sind abgelaufen"}</b><br>` +
          "Zählt nicht mehr zum Bestand – bitte wegwerfen und als leer eintragen."
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
              `<span class="muted small task-row-meta">${[c.ort, c.vonName ? `von ${c.vonName}` : null, wann(c.am), c.mhd ? (alt ? `⚠ abgelaufen seit ${dateDe(c.mhd)}` : `haltbar bis ${dateDe(c.mhd)}`) : null]
                .filter(Boolean)
                .map(escapeHtml)
                .join(" · ")}</span>`
          )
        );
        row.appendChild(
          knopf(alt ? "Weggeworfen" : "Leer", "btn btn-secondary", async () => {
            if (!confirm(alt ? `${b?.name || "Der Behälter"} weggeworfen und sauber?` : `${b?.name || "Der Behälter"} ist leer?`)) return;
            try {
              await sendeLeer(c.id);
              flash = "Eingetragen.";
              await laden({ still: true });
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

// ---------------------------------------------------------------------
// Rezepte
// ---------------------------------------------------------------------
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
    liste.appendChild(el("div", "task-row", `<div class="task-row-text"><span>${escapeHtml(n.text)}</span><span class="muted small task-row-meta">${escapeHtml(
      [n.von, n.fuer ? `für ${dateDe(n.fuer)}` : null].filter(Boolean).join(" · ")
    )}</span></div>`));
  }
  card.appendChild(liste);
  card.appendChild(el("p", "muted small", "Eintragen kannst du sie am Haupt-Tablet."));
  return card;
}

// ---------------------------------------------------------------------
// Laden und Abgleich
// ---------------------------------------------------------------------
async function zeigeFehler(e) {
  if (e?.abgemeldet || !getSession()) {
    daten = null;
    renderLogin(e.message);
    return;
  }
  await meldung("⚠ " + e.message);
}

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

async function laden({ still = false } = {}) {
  if (!still || !daten) show(el("div", "page", `<p class="muted">Lade…</p>`));
  try {
    daten = await getOverview();
    renderShell();
    starteAbgleich();
  } catch (e) {
    if (e.abgemeldet || !getSession()) return renderLogin(e.message);
    if (daten) {
      // Der Stand von eben ist besser als eine leere Seite: wer gerade produziert, soll weiterarbeiten
      // können, wenn das WLAN kurz weg ist.
      flash = "⚠ " + e.message;
      renderShell();
      return;
    }
    const box = el("div", "page");
    box.appendChild(el("div", "callout callout-warn", "⚠ " + escapeHtml(e.message)));
    box.appendChild(knopf("Nochmal versuchen", "btn btn-secondary", () => laden()));
    show(box);
  }
}

function starteAbgleich() {
  stoppeAbgleich();
  abgleichTimer = setInterval(() => {
    // Abmelden, wenn das Tablet nur herumsteht. Ein offenes Fenster auf fremden Namen ist auf einem
    // geteilten Gerät gefährlicher als ein PIN, den jemand noch einmal tippen muss.
    if (Date.now() - letzteBeruehrung > ABMELDEN_NACH_MS) {
      clearSession();
      daten = null;
      renderLogin("Automatisch abgemeldet. Bitte PIN eingeben.");
      return;
    }
    // Nicht neu zeichnen, während jemand gerade in einem Formular steht.
    if (document.querySelector(".overlay")) return;
    laden({ still: true }).catch(() => {});
  }, ABGLEICH_MS);
}
function stoppeAbgleich() {
  if (abgleichTimer) clearInterval(abgleichTimer);
  abgleichTimer = null;
}

renderLogin();
