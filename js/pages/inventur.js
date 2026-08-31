// ============================================================================
// pages/inventur.js – Inventur am iPad: durchzählen, eintragen, Differenz sehen.
//
// Gezählt wird im Laden, mit dem iPad in der Hand. Deshalb: nach Bereich getrennt (man steht entweder
// in der Küche oder hinter der Bar), eine Zeile pro Artikel, grosse Eingabefelder, und der Soll-Bestand
// steht daneben – nicht damit man abschreibt, sondern damit auffällt, wenn etwas weit daneben liegt.
//
// Der Kern ist die DIFFERENZ. Ein Inventurprogramm, das den Bestand einfach überschreibt, verschenkt die
// eigentliche Information: die Lücke zwischen "müsste da sein" und "ist da" ist Bruch, Schwund, eine
// Fehlbuchung oder ein Rezept, das nicht stimmt. Ohne sie merkt man nie, dass etwas nicht stimmt.
// ============================================================================
import { store } from "../store.js";
import { escapeHtml, todayStr, euro, dateDe } from "../format.js";
import { confirmDialog } from "../dialog.js";

const BEREICHE = [
  { id: "kueche", label: "🍳 Küche" },
  { id: "bar", label: "🍸 Bar" },
];

function renderInventur() {
  const container = document.createElement("div");
  container.className = "page";

  let bereich = "kueche";
  // Eingetragene Zahlen überleben den Bereichswechsel – sonst wäre alles weg, sobald man umschaltet.
  const gezaehlt = {};
  let letzteInventur = null;

  function rerender() {
    container.innerHTML = "";
    container.appendChild(build());
  }

  function build() {
    const frag = document.createElement("div");
    frag.innerHTML = `
      <h1>📋 Inventur</h1>
      <p class="muted">Zähl durch und trag ein, was wirklich da ist. Was du leer lässt, bleibt unverändert –
      nicht gezählt ist nicht dasselbe wie null da.</p>`;

    if (letzteInventur) frag.appendChild(buildErgebnis(letzteInventur));
    frag.appendChild(buildBereichswahl());
    frag.appendChild(buildListe());
    frag.appendChild(buildVerlauf());
    return frag;
  }

  function buildBereichswahl() {
    const reihe = document.createElement("div");
    reihe.className = "handoff-days";
    for (const b of BEREICHE) {
      const btn = document.createElement("button");
      btn.className = "btn " + (bereich === b.id ? "btn-primary" : "btn-secondary");
      const offen = store.getStocktakeSheet(b.id).length;
      btn.textContent = `${b.label} (${offen})`;
      btn.onclick = () => {
        bereich = b.id;
        rerender();
      };
      reihe.appendChild(btn);
    }
    return reihe;
  }

  function buildListe() {
    const card = document.createElement("section");
    card.className = "card";
    const zeilen = store.getStocktakeSheet(bereich);
    card.innerHTML = `<h2>${BEREICHE.find((b) => b.id === bereich).label}</h2>`;

    if (zeilen.length === 0) {
      card.innerHTML += `<p class="muted small">Hier gibt es nichts zu zählen. Es tauchen nur Artikel mit
        Mengeneinheit auf – die anderen werden nur als Ampel geführt. Bereich und Einheit stellst du unter
        Admin → Vorräte ein.</p>`;
      return card;
    }

    const scroll = document.createElement("div");
    scroll.style.overflowX = "auto";
    const tabelle = document.createElement("table");
    tabelle.className = "calc-table";
    tabelle.innerHTML = `<thead><tr><th>Artikel</th><th>Soll</th><th>Gezählt</th><th>Differenz</th></tr></thead>`;
    const tbody = document.createElement("tbody");

    for (const z of zeilen) {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td><b>${escapeHtml(z.name)}</b></td>
        <td class="muted">${z.soll} ${escapeHtml(z.unit)}</td>`;

      const eingabeTd = document.createElement("td");
      const inp = document.createElement("input");
      inp.type = "number";
      inp.step = "0.1";
      inp.inputMode = "decimal";
      inp.style.width = "90px";
      inp.placeholder = "–";
      inp.value = gezaehlt[z.stockItemId] ?? "";
      eingabeTd.appendChild(inp);
      tr.appendChild(eingabeTd);

      const diffTd = document.createElement("td");
      const zeigeDiff = () => {
        const wert = inp.value.trim();
        if (wert === "") {
          diffTd.innerHTML = `<span class="muted">nicht gezählt</span>`;
          return;
        }
        const diff = Math.round((Number(wert) - z.soll) * 100) / 100;
        const wertText = z.pricePerUnit != null ? ` (${euro(diff * z.pricePerUnit)})` : "";
        diffTd.innerHTML =
          diff === 0
            ? `<span class="inv-passt">stimmt</span>`
            : `<span class="${diff < 0 ? "inv-fehlt" : "inv-mehr"}">${diff > 0 ? "+" : ""}${diff} ${escapeHtml(z.unit)}${wertText}</span>`;
      };
      inp.oninput = () => {
        gezaehlt[z.stockItemId] = inp.value;
        zeigeDiff();
        aktualisiereSumme();
      };
      zeigeDiff();
      tr.appendChild(diffTd);
      tbody.appendChild(tr);
    }
    tabelle.appendChild(tbody);
    scroll.appendChild(tabelle);
    card.appendChild(scroll);

    const summe = document.createElement("p");
    summe.className = "muted small";
    card.appendChild(summe);

    function aktualisiereSumme() {
      const zeilenMitZahl = zeilen.filter((z) => (gezaehlt[z.stockItemId] ?? "") !== "");
      let wert = 0;
      let ohnePreis = 0;
      for (const z of zeilenMitZahl) {
        const diff = Number(gezaehlt[z.stockItemId]) - z.soll;
        if (z.pricePerUnit != null) wert += diff * z.pricePerUnit;
        else ohnePreis++;
      }
      summe.innerHTML =
        `${zeilenMitZahl.length} von ${zeilen.length} gezählt · Differenz ${euro(wert)}` +
        (ohnePreis > 0 ? ` <span class="res-warn">(${ohnePreis} ohne Einkaufspreis, dort fehlt der Wert)</span>` : "");
      speichern.disabled = zeilenMitZahl.length === 0;
    }

    const speichern = document.createElement("button");
    speichern.className = "btn btn-primary btn-huge";
    speichern.textContent = "Inventur übernehmen";
    speichern.onclick = async () => {
      const zeilenMitZahl = zeilen.filter((z) => (gezaehlt[z.stockItemId] ?? "") !== "");
      const abweichungen = zeilenMitZahl.filter((z) => Number(gezaehlt[z.stockItemId]) !== z.soll).length;
      const frage =
        `${zeilenMitZahl.length} Artikel gezählt, davon ${abweichungen} mit Abweichung.\n\n` +
        `Der gezählte Stand wird der neue Bestand. Nicht gezählte Artikel bleiben unverändert.`;
      if (!(await confirmDialog(frage, { title: "Inventur übernehmen?", okLabel: "Übernehmen" }))) return;
      const counts = {};
      for (const z of zeilenMitZahl) counts[z.stockItemId] = gezaehlt[z.stockItemId];
      letzteInventur = store.saveStocktake({ date: todayStr(), bereich, counts });
      for (const z of zeilenMitZahl) delete gezaehlt[z.stockItemId];
      rerender();
      container.scrollIntoView({ block: "start" });
    };
    card.appendChild(speichern);
    aktualisiereSumme();
    return card;
  }

  function buildErgebnis(inv) {
    const card = document.createElement("section");
    card.className = "card";
    const abweichungen = inv.entries.filter((e) => e.differenz !== 0);
    card.innerHTML = `<h2>✅ Inventur übernommen</h2>
      <p class="muted small">${inv.entries.length} Artikel gezählt, ${abweichungen.length} mit Abweichung.</p>`;

    if (abweichungen.length === 0) {
      card.innerHTML += `<div class="callout">Alles hat gestimmt. Das ist selten – schön.</div>`;
      return card;
    }

    const box = document.createElement("div");
    box.className = inv.differenzWert < 0 ? "callout callout-warn" : "callout";
    box.innerHTML =
      `<b>Differenz insgesamt: ${euro(inv.differenzWert)}</b><br/>` +
      (inv.differenzWert < 0
        ? "Es ist weniger da als gebucht. Das ist Bruch, Schwund oder ein Rezept, das mehr verbraucht als hinterlegt."
        : "Es ist mehr da als gebucht. Meist eine nicht erfasste Lieferung oder ein zu grosszügig hinterlegtes Rezept.");
    card.appendChild(box);

    const liste = document.createElement("div");
    liste.className = "task-list";
    for (const e of [...abweichungen].sort((a, b) => Math.abs(b.wert || 0) - Math.abs(a.wert || 0)).slice(0, 12)) {
      const row = document.createElement("div");
      row.className = "task-row";
      row.innerHTML = `<div class="task-row-text"><span><b>${escapeHtml(e.name)}</b></span>
        <span class="muted small task-row-meta">Soll ${e.soll} · gezählt ${e.ist} · <b class="${
          e.differenz < 0 ? "inv-fehlt" : "inv-mehr"
        }">${e.differenz > 0 ? "+" : ""}${e.differenz} ${escapeHtml(e.unit)}</b>${e.wert != null ? ` (${euro(e.wert)})` : ""}</span></div>`;
      liste.appendChild(row);
    }
    card.appendChild(liste);
    return card;
  }

  function buildVerlauf() {
    const card = document.createElement("section");
    card.className = "card";
    card.innerHTML = `<h2>Frühere Inventuren</h2>`;
    const alle = store.getStocktakes(8).filter((i) => i.id !== letzteInventur?.id);
    if (alle.length === 0) {
      card.innerHTML += `<p class="muted small">Noch keine. Die erste ist die wichtigste – ab dann siehst du,
        ob sich die Differenz vergrößert.</p>`;
      return card;
    }
    const liste = document.createElement("div");
    liste.className = "task-list";
    for (const inv of alle) {
      const row = document.createElement("div");
      row.className = "task-row";
      const abw = inv.entries.filter((e) => e.differenz !== 0).length;
      row.innerHTML = `<div class="task-row-text"><span><b>${escapeHtml(dateDe(inv.date))}</b> · ${
        inv.bereich === "bar" ? "Bar" : "Küche"
      }</span><span class="muted small task-row-meta">${inv.entries.length} gezählt · ${abw} Abweichungen · <b class="${
        inv.differenzWert < 0 ? "inv-fehlt" : "inv-mehr"
      }">${euro(inv.differenzWert)}</b></span></div>`;
      liste.appendChild(row);
    }
    card.appendChild(liste);
    return card;
  }

  rerender();
  return container;
}

export { renderInventur };
