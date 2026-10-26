// ============================================================================
// pages/produktion.js – Produktion im persönlichen Fenster der Küche.
//
// Das ist die Seite, an der tatsächlich gearbeitet wird. Sie beantwortet genau drei Fragen, in dieser
// Reihenfolge, weil man sie in dieser Reihenfolge stellt:
//
//   1. WAS SOLL ICH MACHEN?   Die offenen Aufträge. Erst die, die auf meinen Namen laufen.
//   2. WAS HABE ICH GEMACHT?  Ein Formular mit drei Feldern: Menge, Behälter, fertig.
//   3. WAS IST DA?            Welcher Behälter enthält was, und wie lange noch.
//
// Beim Eintragen ist alles vorausgefüllt, was das System weiss: die Menge aus dem Auftrag, der Behälter
// aus dem Produkt, der Ort aus dem Behälter, das MHD aus der Haltbarkeit. Wer gerade drei Bleche aus dem
// Ofen geholt hat, tippt einmal und ist fertig – alles andere wäre eine Erfassung, die niemand macht.
// ============================================================================
import { store } from "../store.js";
import { escapeHtml, dateDe, todayStr } from "../format.js";
import { confirmDialog, alertDialog } from "../dialog.js";
import { zahlText, einheitText, wannText } from "./kueche.js";

const PHASE_NAME = { frueh: "Frühschicht", mittel: "Mittelschicht", spaet: "Spätschicht" };

/** Die Karten für das persönliche Fenster. Leeres Array, wenn der Betrieb keine Produktion hat oder
 * die Person nicht in der Küche arbeitet. */
function buildProduktionsKarten(emp, { onChange }) {
  if (!store.getPreps(true).some((p) => p.produzierbar)) return [];
  return [buildAuftraege(emp, onChange), buildBestandKarte(emp, onChange)];
}

// ---------------------------------------------------------------------
// 1. Was soll ich machen?
// ---------------------------------------------------------------------
function buildAuftraege(emp, onChange) {
  const card = document.createElement("section");
  card.className = "card";
  const heute = todayStr();
  const alle = store.getProduktionsAuftraege({ nurOffen: true, fuerPerson: emp.id }).filter((a) => a.fuerDatum <= heute);
  // Was auf meinen Namen läuft, steht oben: dafür bin ich zuständig, der Rest ist für die Küche allgemein.
  const meine = alle.filter((a) => a.zugewiesenAn === emp.id);
  const offen = alle.filter((a) => !a.zugewiesenAn);

  card.innerHTML = `<h2>🧑‍🍳 Produzieren</h2>`;
  if (alle.length === 0) {
    const leer = document.createElement("p");
    leer.className = "muted small";
    leer.textContent = "Nichts offen – alles ist über dem Soll. Was du zusätzlich machst, trägst du unten ein.";
    card.appendChild(leer);
  } else {
    const hinweis = document.createElement("p");
    hinweis.className = "muted small";
    hinweis.textContent = `${alle.length} ${alle.length === 1 ? "Auftrag" : "Aufträge"} offen. Antippen, wenn du fertig bist.`;
    card.appendChild(hinweis);

    if (meine.length > 0) {
      card.appendChild(abschnitt("Für dich", meine, emp, onChange, true));
      if (offen.length > 0) card.appendChild(abschnitt("Für die Küche", offen, emp, onChange, false));
    } else {
      card.appendChild(abschnitt(null, offen, emp, onChange, false));
    }
  }

  // Etwas produzieren, das niemand beauftragt hat – kommt in jeder Küche vor und darf nicht verloren gehen.
  const extra = document.createElement("button");
  extra.className = "btn btn-secondary";
  extra.textContent = "＋ Ohne Auftrag eintragen";
  extra.onclick = () => openChargeForm({ emp, auftrag: null, onChange });
  card.appendChild(extra);
  return card;
}

function abschnitt(titel, auftraege, emp, onChange, meine) {
  const box = document.createElement("div");
  if (titel) {
    const h = document.createElement("p");
    h.className = "muted small res-bereich";
    h.innerHTML = `<b>${escapeHtml(titel)}</b>`;
    box.appendChild(h);
  }
  const liste = document.createElement("div");
  liste.className = "task-list";
  for (const a of auftraege) {
    const p = store.getPrep(a.produktId);
    const row = document.createElement("div");
    row.className = "task-row" + (meine ? " task-vom-chef" : "");
    const spaeter = a.fuerDatum < todayStr();
    row.innerHTML = `<div class="task-row-text"><span><b>${zahlText(a.menge)} ${escapeHtml(einheitText(a.einheit, a.menge))} ${escapeHtml(
      p?.name || "?"
    )}</b></span><span class="muted small task-row-meta">${[
      a.quelle === "system" ? "fehlt im Bestand" : a.quelle === "chef" ? "vom Chef" : "aus der Küche",
      a.schichtGruppe ? PHASE_NAME[a.schichtGruppe] : null,
      spaeter ? `seit ${dateDe(a.fuerDatum)} offen` : null,
    ]
      .filter(Boolean)
      .map(escapeHtml)
      .join(" · ")}</span></div>`;

    const akt = document.createElement("div");
    akt.className = "employee-actions";
    const fertig = document.createElement("button");
    fertig.className = "btn btn-primary";
    fertig.textContent = "Fertig";
    fertig.onclick = () => openChargeForm({ emp, auftrag: a, onChange });
    const weg = document.createElement("button");
    weg.className = "btn btn-link";
    weg.textContent = "✕";
    weg.title = "Auftrag streichen";
    weg.onclick = async () => {
      if (!(await confirmDialog(`„${zahlText(a.menge)} ${einheitText(a.einheit, a.menge)} ${p?.name || ""}“ streichen, ohne zu produzieren?`, { danger: true, okLabel: "Streichen" })))
        return;
      store.updateProduktionsAuftrag(a.id, { status: "abgebrochen", erledigtAm: new Date().toISOString() });
      onChange();
    };
    akt.append(fertig, weg);
    row.appendChild(akt);
    liste.appendChild(row);
  }
  box.appendChild(liste);
  return box;
}

// ---------------------------------------------------------------------
// 2. Was habe ich gemacht?
// ---------------------------------------------------------------------
function openChargeForm({ emp, auftrag, onChange }) {
  const produkte = store.getPreps(true).filter((p) => p.produzierbar);
  if (produkte.length === 0) return alertDialog("Es ist noch kein Produktionsprodukt angelegt.");

  const overlay = document.createElement("div");
  overlay.className = "overlay";
  const box = document.createElement("div");
  box.className = "dialog";
  box.innerHTML = `<h2>${auftrag ? "Fertig – was ist daraus geworden?" : "Produktion eintragen"}</h2>`;

  const feld = (label, node, hinweis) => {
    const l = document.createElement("label");
    l.className = "field";
    l.innerHTML = `<span>${label}</span>`;
    l.appendChild(node);
    if (hinweis) {
      const h = document.createElement("p");
      h.className = "muted small";
      h.textContent = hinweis;
      l.appendChild(h);
    }
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
  produktSel.disabled = !!auftrag; // aus einem Auftrag heraus steht das Produkt fest
  const menge = Object.assign(document.createElement("input"), {
    type: "text",
    value: auftrag ? zahlText(auftrag.menge) : "",
    placeholder: "z.B. 4",
  });
  menge.inputMode = "decimal";
  const behaelterSel = document.createElement("select");
  const ort = Object.assign(document.createElement("input"), { type: "text", placeholder: "z.B. Kühlhaus, Regal 2" });
  const einheitAnzeige = document.createElement("span");
  einheitAnzeige.className = "muted small";
  const mhdAnzeige = document.createElement("p");
  mhdAnzeige.className = "muted small";
  const notiz = Object.assign(document.createElement("input"), { type: "text", placeholder: "optional" });

  /** Behälterliste und die abgeleiteten Angaben an das gewählte Produkt anpassen. */
  function aktualisiere() {
    const p = store.getPrep(produktSel.value);
    const belegt = new Map(store.offeneChargen().map((c) => [c.behaelterId, c]));
    const vorher = behaelterSel.value;
    behaelterSel.innerHTML = "";
    const leer = document.createElement("option");
    leer.value = "";
    leer.textContent = "– ohne Behälter –";
    behaelterSel.appendChild(leer);
    for (const b of store.getBehaelter(true)) {
      const drin = belegt.get(b.id);
      const o = document.createElement("option");
      o.value = b.id;
      // Belegte Behälter bleiben wählbar: man füllt auch mal nach. Aber es muss dranstehen.
      o.textContent = drin ? `${b.name} — belegt: ${store.getPrep(drin.produktId)?.name || "?"}` : b.name;
      behaelterSel.appendChild(o);
    }
    behaelterSel.value = vorher || p?.standardBehaelterId || "";
    const b = store.getBehaelterById(behaelterSel.value);
    if (b && !ort.value) ort.value = b.ort;
    einheitAnzeige.textContent = p ? einheitText(p.einheit, 2) : "";
    mhdAnzeige.textContent = p?.haltbarkeitTage
      ? `Haltbar bis ${dateDe(new Date(Date.now() + p.haltbarkeitTage * 86400000).toISOString().slice(0, 10))} (${p.haltbarkeitTage} ${
          p.haltbarkeitTage === 1 ? "Tag" : "Tage"
        }) – wird automatisch eingetragen.`
      : "Für dieses Produkt ist keine Haltbarkeit hinterlegt – es gibt dann auch keine Ablauf-Warnung.";
  }
  produktSel.onchange = () => {
    ort.value = "";
    behaelterSel.value = "";
    aktualisiere();
  };
  behaelterSel.onchange = () => {
    const b = store.getBehaelterById(behaelterSel.value);
    ort.value = b ? b.ort : "";
  };

  box.appendChild(feld("Was", produktSel));
  const r1 = document.createElement("div");
  r1.className = "res-form-row";
  const mengeFeld = feld("Wie viel", menge);
  mengeFeld.appendChild(einheitAnzeige);
  r1.append(mengeFeld, feld("In welchen Behälter", behaelterSel));
  box.appendChild(r1);
  box.appendChild(feld("Wo steht es", ort));
  box.appendChild(mhdAnzeige);
  box.appendChild(feld("Notiz", notiz));
  aktualisiere();

  const akt = document.createElement("div");
  akt.className = "dialog-actions";
  const abbrechen = document.createElement("button");
  abbrechen.className = "btn btn-secondary";
  abbrechen.textContent = "Abbrechen";
  abbrechen.onclick = () => overlay.remove();
  const speichern = document.createElement("button");
  speichern.className = "btn btn-primary";
  speichern.textContent = "Eintragen";
  speichern.onclick = async () => {
    const m = Number(String(menge.value).replace(",", "."));
    if (!Number.isFinite(m) || m <= 0) {
      await alertDialog("Bitte eintragen, wie viel du gemacht hast.");
      return;
    }
    const daten = {
      produktId: produktSel.value,
      menge: m,
      behaelterId: behaelterSel.value || null,
      ort: ort.value.trim(),
      vonId: emp.id,
      vonName: emp.name,
      notiz: notiz.value.trim(),
    };
    const ergebnis = auftrag ? store.erledigeProduktionsAuftrag(auftrag.id, daten) : store.addCharge(daten);
    overlay.remove();
    if (!ergebnis) {
      await alertDialog("Das konnte nicht gespeichert werden. Bitte noch einmal versuchen.");
      return;
    }
    onChange();
  };
  akt.append(abbrechen, speichern);
  box.appendChild(akt);
  overlay.appendChild(box);
  document.body.appendChild(overlay);
  menge.focus();
}

// ---------------------------------------------------------------------
// 3. Was ist da?
// ---------------------------------------------------------------------
function buildBestandKarte(emp, onChange) {
  const card = document.createElement("section");
  card.className = "card";
  const produkte = store.getPreps(true).filter((p) => p.produzierbar);
  const ablauf = store.ablaufendeChargen(1);

  card.innerHTML = `<h2>📦 Was da ist</h2>
    <p class="muted small">Die Summe der vollen Behälter. Ist einer leer, tipp ihn an – erst dann weiss
    das System, dass nachproduziert werden muss.</p>`;

  if (ablauf.length > 0) {
    const warn = document.createElement("div");
    warn.className = "callout callout-warn";
    warn.innerHTML =
      `<b>${ablauf.length} ${ablauf.length === 1 ? "Behälter ist" : "Behälter sind"} am Ende der Haltbarkeit:</b><br>` +
      ablauf
        .slice(0, 5)
        .map((c) => {
          const p = store.getPrep(c.produktId);
          const b = store.getBehaelterById(c.behaelterId);
          return `${escapeHtml(p?.name || "?")} in ${escapeHtml(b?.name || "–")} (${c.mhd < todayStr() ? "abgelaufen" : "heute"})`;
        })
        .join("<br>");
    card.appendChild(warn);
  }

  if (produkte.length === 0) {
    const leer = document.createElement("p");
    leer.className = "muted small";
    leer.textContent = "Noch kein Produktionsprodukt angelegt.";
    card.appendChild(leer);
    return card;
  }

  const gruppen = document.createElement("div");
  gruppen.className = "group-list";
  for (const p of produkte) {
    // Abgelaufenes steht mit in der Liste – es steht ja auch noch im Kühlhaus – aber durchgestrichen
    // und ohne Anteil am Bestand. Es verschwindet erst, wenn jemand sagt, dass es weg ist.
    const chargen = store.offeneChargen(p.id);
    const ist = store.istMenge(p.id) || 0;
    const status = store.prepStatus(p);

    const wrap = document.createElement("div");
    const kopf = document.createElement("button");
    kopf.type = "button";
    kopf.className = "group-header";
    kopf.innerHTML = `
      <span class="group-header-chevron">▶</span>
      <span class="group-header-name">${escapeHtml(p.name)}</span>
      <span class="group-header-meta ${status === "ok" ? "" : "res-warn"}">${zahlText(ist)} / ${zahlText(p.soll)} ${escapeHtml(
        einheitText(p.einheit, p.soll)
      )}</span>`;
    const body = document.createElement("div");
    body.className = "group-body";
    body.hidden = true;
    kopf.onclick = () => {
      body.hidden = !body.hidden;
      kopf.classList.toggle("open", !body.hidden);
    };

    if (chargen.length === 0) {
      const leer = document.createElement("p");
      leer.className = "muted small";
      leer.textContent = "Kein voller Behälter.";
      body.appendChild(leer);
    } else {
      const liste = document.createElement("div");
      liste.className = "task-list";
      for (const c of chargen) {
        const b = store.getBehaelterById(c.behaelterId);
        const abgelaufen = c.mhd && c.mhd < todayStr();
        const row = document.createElement("div");
        row.className = "task-row" + (abgelaufen ? " done" : "");
        row.innerHTML = `<div class="task-row-text"><span><b>${zahlText(c.menge)} ${escapeHtml(einheitText(c.einheit, c.menge))}</b> in ${escapeHtml(
          b?.name || "– ohne Behälter –"
        )}</span><span class="muted small task-row-meta">${[
          c.ort,
          c.vonName ? `von ${c.vonName}` : null,
          wannText(c.am),
          c.mhd ? (abgelaufen ? `⚠ abgelaufen seit ${dateDe(c.mhd)} – zählt nicht mehr` : `haltbar bis ${dateDe(c.mhd)}`) : null,
          c.notiz || null,
        ]
          .filter(Boolean)
          .map(escapeHtml)
          .join(" · ")}</span></div>`;
        const leerBtn = document.createElement("button");
        leerBtn.className = "btn btn-secondary";
        leerBtn.textContent = abgelaufen ? "Weggeworfen" : "Leer";
        leerBtn.onclick = async () => {
          const frage = abgelaufen
            ? `${b?.name || "Der Behälter"} ist abgelaufen – weggeworfen und sauber?`
            : `${b?.name || "Der Behälter"} ist leer? Danach zählt er nicht mehr zum Bestand.`;
          if (!(await confirmDialog(frage, { okLabel: abgelaufen ? "Weggeworfen" : "Ist leer" }))) return;
          store.chargeLeer(c.id, emp.name);
          onChange();
        };
        row.appendChild(leerBtn);
        liste.appendChild(row);
      }
      body.appendChild(liste);
    }

    // Rückverfolgung: was wurde zuletzt gemacht, von wem. Steht hier, weil hier gefragt wird.
    const verlauf = store.produktionsVerlauf(p.id, 14).filter((c) => c.leerAm);
    if (verlauf.length > 0) {
      const h = document.createElement("p");
      h.className = "muted small";
      h.textContent =
        "Zuletzt aufgebraucht: " +
        verlauf
          .slice(0, 3)
          .map((c) => `${zahlText(c.menge)} ${einheitText(c.einheit, c.menge)} von ${c.vonName || "?"}, ${wannText(c.am)}`)
          .join(" · ");
      body.appendChild(h);
    }

    wrap.append(kopf, body);
    gruppen.appendChild(wrap);
  }
  card.appendChild(gruppen);
  return card;
}

export { buildProduktionsKarten, openChargeForm };
