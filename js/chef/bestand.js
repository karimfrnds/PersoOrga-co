// ============================================================================
// chef/bestand.js – Bestand am Laptop: welche Artikel Küche und Bar zählen, das Soll, und der letzte Stand.
//
// Gezählt wird am Handy und am iPad. Hier wird festgelegt – und nachgesehen, wie weit der Stand vom Soll
// weg ist. Änderungen gehen wie überall als Wunsch an den Worker; der iPad übernimmt sie beim nächsten
// Abgleich, die Liste zeigt sie sofort.
// ============================================================================
import { escapeHtml } from "../format.js";
import { bestandAction } from "./api.js";

const BEREICHE = [
  { id: "kueche", label: "Küche", symbol: "🍳", wer: "Küchen-Team" },
  { id: "bar", label: "Bar", symbol: "🍸", wer: "Bar und Service" },
  { id: "divers", label: "Divers", symbol: "🧺", wer: "Store-Managerin" },
];
// Muss zu PREP_EINHEITEN in js/store.js passen.
const EINHEITEN = ["Stück", "Flaschen", "Packungen", "Kisten", "Liter", "kg", "g", "Behälter", "Schale", "Blech", "Beutel", "Portionen"];

const zahl = (n) => (n === null || n === undefined ? "–" : Number.isInteger(n) ? String(n) : String(n).replace(".", ","));
function wann(iso) {
  if (!iso) return "nie";
  const d = new Date(iso);
  return d.toLocaleString("de-DE", { weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}
function status(a) {
  if (a.menge === null || a.menge === undefined) return "unbekannt";
  if (a.menge <= 0) return "leer";
  if (a.soll > 0 && a.menge < a.soll) return "knapp";
  return "ok";
}
const STATUS_TEXT = { leer: "leer", knapp: "unter Soll", unbekannt: "nicht gezählt", ok: "genug" };

function renderBestand(state, { onChanged }) {
  const el = document.createElement("div");
  // Überlebt das Neuzeichnen: welcher Artikel gerade im Formular steht ("neu:<bereich>" für einen neuen).
  let bearbeite = null;

  function rerender() {
    el.innerHTML = "";
    el.appendChild(build());
  }

  function build() {
    const frag = document.createElement("div");
    frag.innerHTML = `
      <h1>🧮 Bestand</h1>
      <p class="muted">Du legst fest, welche Artikel gezählt werden und was mindestens da sein soll. Gezählt
      wird am Handy und im persönlichen Fenster am iPad – <b>Küche</b> vom Küchen-Team, <b>Bar</b> von Bar und Service,
      <b>Divers</b> von der Store-Managerin (sie sieht alle drei).</p>`;

    const vorlagen = (state.taskTemplates || []).filter((t) => t.bestandBereich);
    const tipp = document.createElement("p");
    tipp.className = vorlagen.length > 0 ? "muted small" : "callout";
    tipp.innerHTML =
      vorlagen.length > 0
        ? `Zähltage: ${vorlagen.map((t) => `<b>${escapeHtml(t.text)}</b> (${tageText(t.weekdays)})`).join(" · ")} – zu ändern unter „📋 Aufgaben“.`
        : `Noch kein fester Zähltag. Unter <b>📋 Aufgaben</b> eine Standard-Aufgabe anlegen, z.B. „Bar zählen“ für Dienstag, und bei „Mit Bestand verknüpft“ die Bar wählen.`;
    frag.appendChild(tipp);

    for (const b of BEREICHE) frag.appendChild(buildBereich(b));
    return frag;
  }

  function tageText(weekdays) {
    const kurz = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];
    return Array.isArray(weekdays) && weekdays.length > 0 ? weekdays.map((w) => kurz[w]).join(", ") : "jeden Tag";
  }

  function buildBereich(b) {
    const card = document.createElement("section");
    card.className = "card";
    const alle = (state.bestand || [])
      .filter((a) => a.bereich === b.id)
      .sort((x, y) => (Number(x.sort) || 0) - (Number(y.sort) || 0) || String(x.name).localeCompare(String(y.name)));
    const letzte = (state.bestandAbschluesse || []).filter((a) => a.bereich === b.id).slice(-1)[0];
    const fehlt = alle.filter((a) => a.aktiv !== false && ["leer", "knapp"].includes(status(a)));

    card.innerHTML = `<h2>${b.symbol} ${b.label} <span class="muted small">· zählt: ${b.wer}</span></h2>
      <p class="muted small">${letzte ? `Letzte abgeschlossene Zählung: ${escapeHtml(letzte.by || "?")}, ${escapeHtml(wann(letzte.at))}` : "Noch keine abgeschlossene Zählung."}${
        fehlt.length > 0 ? ` · <b class="res-warn">${fehlt.length} unter Soll</b>` : ""
      }</p>`;

    const status_ = document.createElement("p");
    status_.className = "muted small";

    if (alle.length === 0) {
      card.appendChild(Object.assign(document.createElement("p"), { className: "muted small", textContent: "Noch keine Artikel." }));
    } else {
      const scroll = document.createElement("div");
      scroll.style.overflowX = "auto";
      const tabelle = document.createElement("table");
      tabelle.className = "calc-table";
      tabelle.innerHTML = `<thead><tr><th>Artikel</th><th>Ist</th><th>Soll</th><th>Fehlt</th><th>Stand</th><th>Zuletzt gezählt</th><th></th></tr></thead>`;
      const tbody = document.createElement("tbody");
      for (const a of alle) {
        const st = status(a);
        const tr = document.createElement("tr");
        if (a.aktiv === false) tr.style.opacity = "0.5";
        // "Fehlt" ist die Zahl, die man beim Bestellen braucht – nicht der Ist-Wert.
        const differenz = a.menge !== null && a.menge !== undefined && a.soll > a.menge ? a.soll - a.menge : null;
        tr.innerHTML = `
          <td><b>${escapeHtml(a.name)}</b>${a.aktiv === false ? ' <span class="badge badge-gray">wird nicht gezählt</span>' : ""}${
          String(a.id).startsWith("vorlaeufig-") ? ' <span class="muted small">(kommt beim nächsten iPad-Abgleich an)</span>' : ""
        }</td>
          <td>${zahl(a.menge)}</td>
          <td>${zahl(a.soll)} ${escapeHtml(a.einheit || "")}</td>
          <td>${differenz !== null ? `<b>${zahl(differenz)}</b>` : "–"}</td>
          <td class="${st === "leer" || st === "knapp" ? "res-warn" : "muted"}">${STATUS_TEXT[st]}</td>
          <td class="muted small">${escapeHtml(wann(a.at))}${a.by ? " · " + escapeHtml(a.by) : ""}</td>`;
        const td = document.createElement("td");
        td.className = "employee-actions";
        const aendern = document.createElement("button");
        aendern.className = "btn btn-secondary";
        aendern.textContent = "Ändern";
        aendern.disabled = String(a.id).startsWith("vorlaeufig-");
        aendern.onclick = () => {
          bearbeite = a;
          rerender();
        };
        td.appendChild(aendern);
        tr.appendChild(td);
        tbody.appendChild(tr);
      }
      tabelle.appendChild(tbody);
      scroll.appendChild(tabelle);
      card.appendChild(scroll);
    }

    const offenHier = bearbeite && (bearbeite === "neu:" + b.id || bearbeite.bereich === b.id);
    if (offenHier) {
      card.appendChild(buildForm(typeof bearbeite === "string" ? null : bearbeite, b.id, status_));
    } else {
      const neu = document.createElement("button");
      neu.className = "btn btn-primary";
      neu.textContent = `＋ Artikel für ${b.label}`;
      neu.onclick = () => {
        bearbeite = "neu:" + b.id;
        rerender();
      };
      card.appendChild(neu);
    }
    card.appendChild(status_);
    return card;
  }

  function buildForm(vorhanden, bereich, status_) {
    const box = document.createElement("div");
    box.className = "res-form";
    const feld = (label, node) => {
      const l = document.createElement("label");
      l.className = "field";
      l.innerHTML = `<span>${label}</span>`;
      l.appendChild(node);
      return l;
    };
    const eingabe = (wert, platz) => Object.assign(document.createElement("input"), { type: "text", value: wert ?? "", placeholder: platz || "" });

    const name = eingabe(vorhanden?.name, "z.B. Hafermilch");
    const soll = eingabe(vorhanden ? zahl(vorhanden.soll) : "", "z.B. 80");
    soll.inputMode = "decimal";
    const einheit = document.createElement("select");
    for (const e of EINHEITEN) einheit.appendChild(Object.assign(document.createElement("option"), { value: e, textContent: e }));
    einheit.value = vorhanden?.einheit && EINHEITEN.includes(vorhanden.einheit) ? vorhanden.einheit : "Stück";
    const bereichSel = document.createElement("select");
    for (const b of BEREICHE) bereichSel.appendChild(Object.assign(document.createElement("option"), { value: b.id, textContent: `${b.symbol} ${b.label}` }));
    bereichSel.value = vorhanden?.bereich || bereich;
    const notiz = eingabe(vorhanden?.notiz, "z.B. Lager hinten links");
    const aktiv = Object.assign(document.createElement("input"), { type: "checkbox", checked: vorhanden ? vorhanden.aktiv !== false : true });

    const reihe = document.createElement("div");
    reihe.className = "res-form-row";
    reihe.append(feld("Artikel", name), feld("Soll (mindestens)", soll), feld("Einheit", einheit), feld("Wer zählt?", bereichSel));
    box.append(reihe, feld("Notiz", notiz));
    const aktivZeile = document.createElement("label");
    aktivZeile.className = "field-checkbox";
    aktivZeile.append(aktiv, document.createTextNode(" Wird gezählt (ausschalten statt löschen – der Verlauf bleibt)"));
    box.appendChild(aktivZeile);

    const akt = document.createElement("div");
    akt.className = "employee-actions";
    const speichern = Object.assign(document.createElement("button"), { className: "btn btn-primary", textContent: "Speichern" });
    speichern.onclick = () => {
      if (!name.value.trim()) {
        status_.className = "res-warn small";
        status_.textContent = "Bitte einen Namen eintragen.";
        return;
      }
      const daten = {
        name: name.value.trim(),
        soll: Number(soll.value.replace(",", ".")) || 0,
        einheit: einheit.value,
        bereich: bereichSel.value,
        notiz: notiz.value.trim(),
        aktiv: aktiv.checked,
      };
      bearbeite = null;
      aktion(() => bestandAction(vorhanden ? { kind: "update", itemId: vorhanden.id, ...daten } : { kind: "create", ...daten }), status_);
    };
    const abbrechen = Object.assign(document.createElement("button"), { className: "btn btn-link", textContent: "Abbrechen" });
    abbrechen.onclick = () => {
      bearbeite = null;
      rerender();
    };
    akt.append(speichern, abbrechen);
    if (vorhanden) {
      const weg = Object.assign(document.createElement("button"), { className: "btn btn-link", textContent: "Löschen" });
      weg.onclick = () => {
        if (!confirm(`„${vorhanden.name}“ endgültig löschen? Zum Pausieren lieber „Wird gezählt“ ausschalten.`)) return;
        bearbeite = null;
        aktion(() => bestandAction({ kind: "delete", itemId: vorhanden.id }), status_);
      };
      akt.appendChild(weg);
    }
    box.appendChild(akt);
    return box;
  }

  async function aktion(fn, statusEl) {
    statusEl.className = "muted small";
    statusEl.textContent = "Wird gespeichert…";
    try {
      await fn();
      await onChanged();
    } catch (e) {
      statusEl.className = "callout callout-warn";
      statusEl.textContent = e.message;
    }
  }

  rerender();
  return el;
}

export { renderBestand };
