// ============================================================================
// chef/verkauf.js – Verkauf am Laptop (Pop-up).
//
// Die drei Fragen, die ein Pop-up-Store nach zwei Wochen beantworten können muss:
//   Wie viel backen wir morgen?       – der Vorschlag oben, gerechnet auf dem iPad.
//   Werfen wir zu viel weg?           – Rest je Tag, und was das gekostet hat.
//   Wann ist was los?                 – Verkauf je Wochentag.
//
// Bewusst keine Prognose-Kurven: bei drei Produkten und drei Monaten zählt, was man am Abend davor
// entscheidet, nicht was ein Modell im Dezember sagt.
// ============================================================================
import { escapeHtml, euro, dateDe } from "../format.js";

const WT = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];

function wtIndex(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return wd === 0 ? 6 : wd - 1;
}
const zahl = (n) => (n === null || n === undefined ? "–" : String(n));

function renderVerkauf(state) {
  const el = document.createElement("div");
  const produkte = state.produkte || [];
  const tage = [...(state.verkaufTage || [])].sort((a, b) => (a.date < b.date ? 1 : -1));
  el.innerHTML = `<h1>🧁 Verkauf</h1>`;

  if (produkte.length === 0) {
    el.innerHTML += `<div class="callout">Noch keine Produkte – die legst du am iPad unter <b>Admin → Produkte &amp; Schichten</b> an.</div>`;
    return el;
  }

  // ---- Vorschlag für morgen ----
  const vorschlag = document.createElement("section");
  vorschlag.className = "card";
  vorschlag.innerHTML = `<h2>Morgen backen</h2>`;
  const vorschlaege = state.backvorschlaege || [];
  if (vorschlaege.length === 0) {
    vorschlag.innerHTML += `<p class="muted small">Sobald ein paar Tage erfasst sind, steht hier eine Menge. Grundlage sind dieselben Wochentage der letzten Wochen.</p>`;
  } else {
    for (const v of vorschlaege) {
      const p = produkte.find((x) => x.id === v.produktId);
      const zeile = document.createElement("p");
      zeile.className = "mg-kennzahl";
      zeile.innerHTML = `<b>${v.menge} ${escapeHtml(p?.name || "")}</b> <span class="muted small">aus ${v.grundlage} ${
        v.wochentag ? (v.grundlage === 1 ? "gleichem Wochentag" : "gleichen Wochentagen") : v.grundlage === 1 ? "Tag" : "Tagen"
      }${v.ausverkauft ? `, ${v.ausverkauft}× ausverkauft${v.ausverkauftUm ? ` (im Schnitt um ${escapeHtml(v.ausverkauftUm)} Uhr)` : ""}` : ""}</span>`;
      vorschlag.appendChild(zeile);
    }
  }
  el.appendChild(vorschlag);

  if (tage.length === 0) {
    el.innerHTML += `<div class="callout">Noch keine Verkaufszahlen. Sie werden am iPad im Tagesabschluss eingetragen.</div>`;
    return el;
  }

  // ---- Zahlen je Produkt ----
  for (const p of produkte) {
    const zeilen = tage.map((t) => ({ date: t.date, ...(t.produkte.find((x) => x.produktId === p.id) || {}) })).filter((z) => z.verkauft != null);
    if (zeilen.length === 0) continue;
    const verkauft = zeilen.reduce((s, z) => s + (z.verkauft || 0), 0);
    const uebrig = zeilen.reduce((s, z) => s + (z.uebrig || 0), 0);
    const gebacken = zeilen.reduce((s, z) => s + (z.gebacken || 0), 0);

    const card = document.createElement("section");
    card.className = "card";
    // Marge nur, wenn Kosten hinterlegt sind. Gerechnet auf die gebackene Menge – bezahlt ist auch,
    // was abends in die Tonne geht.
    const hergestellt = p.gebacken ? gebacken : verkauft;
    const db = p.kosten ? verkauft * p.preis - hergestellt * p.kosten : null;
    card.innerHTML = `<h2>${escapeHtml(p.name)}</h2>
      <p class="muted small">${zeilen.length} Tage · ${verkauft} verkauft · Umsatz ${euro(verkauft * p.preis)}${
        db === null ? "" : ` · <b>Deckungsbeitrag ${euro(db)}</b> (nach ${euro(hergestellt * p.kosten)} Ware)`
      }${
        p.gebacken ? ` · ${uebrig} übrig (${gebacken ? Math.round((uebrig / gebacken) * 100) : 0} % von ${gebacken} gebacken, ${euro(uebrig * p.preis)} nicht verkauft${
          p.kosten ? `, ${euro(uebrig * p.kosten)} weggeworfene Ware` : ""
        })` : ""
      }</p>`;

    // Je Wochentag: das ist die Zahl, nach der man backt.
    const proTag = new Map();
    for (const z of zeilen) {
      const i = wtIndex(z.date);
      if (!proTag.has(i)) proTag.set(i, []);
      proTag.get(i).push(z.verkauft || 0);
    }
    const wtBox = document.createElement("div");
    wtBox.className = "mg-liste";
    for (let i = 0; i < 7; i++) {
      const werte = proTag.get(i) || [];
      if (werte.length === 0) continue;
      const schnitt = werte.reduce((a, b) => a + b, 0) / werte.length;
      const zeile = document.createElement("div");
      zeile.className = "summary-line";
      zeile.innerHTML = `<span>${WT[i]} <span class="muted small">(${werte.length}×)</span></span><span><b>${Math.round(schnitt)}</b> im Schnitt · ${Math.min(
        ...werte
      )}–${Math.max(...werte)}</span>`;
      wtBox.appendChild(zeile);
    }
    card.appendChild(wtBox);

    const scroll = document.createElement("div");
    scroll.style.overflowX = "auto";
    const tabelle = document.createElement("table");
    tabelle.className = "calc-table";
    tabelle.innerHTML = `<thead><tr><th>Tag</th>${p.gebacken ? "<th>Gebacken</th>" : ""}<th>Verkauft</th>${
      p.gebacken ? "<th>Übrig</th>" : ""
    }<th>Umsatz</th></tr></thead>`;
    const tbody = document.createElement("tbody");
    for (const z of zeilen.slice(0, 21)) {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td>${escapeHtml(dateDe(z.date))}</td>${p.gebacken ? `<td>${zahl(z.gebacken)}</td>` : ""}<td><b>${zahl(z.verkauft)}</b></td>${
        p.gebacken
          ? `<td class="${z.uebrig === 0 ? "res-warn" : ""}">${
              z.uebrig === 0 ? (z.ausverkauftUm ? `ausverkauft ${escapeHtml(z.ausverkauftUm)}` : "ausverkauft") : zahl(z.uebrig)
            }</td>`
          : ""
      }<td>${euro((z.verkauft || 0) * p.preis)}</td>`;
      tbody.appendChild(tr);
    }
    tabelle.appendChild(tbody);
    scroll.appendChild(tabelle);
    card.appendChild(scroll);
    el.appendChild(card);
  }

  // ---- Tage gesamt ----
  const gesamt = document.createElement("section");
  gesamt.className = "card";
  gesamt.innerHTML = `<h2>Tage</h2>`;
  const scroll = document.createElement("div");
  scroll.style.overflowX = "auto";
  const tabelle = document.createElement("table");
  tabelle.className = "calc-table";
  const mitWare = tage.some((t) => t.ware > 0);
  tabelle.innerHTML = `<thead><tr><th>Tag</th>${produkte.map((p) => `<th>${escapeHtml(p.name)}</th>`).join("")}<th>Umsatz (Kasse)</th>${
    mitWare ? "<th>Ware</th><th>Bleibt</th>" : ""
  }<th>Notiz</th></tr></thead>`;
  const tbody = document.createElement("tbody");
  for (const t of tage.slice(0, 21)) {
    const tr = document.createElement("tr");
    tr.innerHTML =
      `<td>${escapeHtml(dateDe(t.date))}</td>` +
      produkte.map((p) => `<td>${zahl(t.produkte.find((x) => x.produktId === p.id)?.verkauft)}</td>`).join("") +
      `<td>${euro(t.umsatz || 0)}</td>` +
      (mitWare ? `<td>${t.ware ? euro(t.ware) : "–"}</td><td>${t.ware ? euro((t.umsatz || 0) - t.ware) : "–"}</td>` : "") +
      `<td class="muted small">${escapeHtml(t.notiz || "")}</td>`;
    tbody.appendChild(tr);
  }
  tabelle.appendChild(tbody);
  scroll.appendChild(tabelle);
  gesamt.appendChild(scroll);
  el.appendChild(gesamt);
  return el;
}

export { renderVerkauf };
