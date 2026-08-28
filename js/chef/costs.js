// ============================================================================
// chef/costs.js – Kostenübersicht am Laptop: Umsatz, Lohn inkl. Nebenkosten,
// Lohnquote und Umschlag über einen frei wählbaren Zeitraum, plus Aufschlüsselung
// je Mitarbeiter und je Tag.
// ============================================================================
import { euro, hours, escapeHtml, dateDe, todayStr } from "../format.js";

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

function firstOfMonth() {
  return todayStr().slice(0, 7) + "-01";
}

function renderCosts(state) {
  const el = document.createElement("div");
  let from = firstOfMonth();
  let to = todayStr();

  function rerender() {
    el.innerHTML = "";
    el.appendChild(build());
  }

  function build() {
    const frag = document.createElement("div");
    frag.innerHTML = `
      <h1>💰 Kostenübersicht</h1>
      <p class="muted">Zahlen aus den abgeglichenen Tagen. Offene (noch nicht abgeschlossene) Tage sind mitgerechnet und können sich noch ändern.</p>
    `;

    const financials = state.financials || [];
    if (financials.length === 0) {
      const card = document.createElement("section");
      card.className = "card";
      card.innerHTML = `<p class="muted small">Keine Kennzahlen verfügbar. Am iPad unter Admin → Einstellungen → Backup & Synchronisation die Kennzahlen-Freigabe aktivieren.</p>`;
      frag.appendChild(card);
      return frag;
    }

    frag.appendChild(buildRange());
    const rows = financials.filter((r) => r.date >= from && r.date <= to);
    if (rows.length === 0) {
      const card = document.createElement("section");
      card.className = "card";
      card.innerHTML = `<p class="muted small">Für diesen Zeitraum liegen keine Daten vor.</p>`;
      frag.appendChild(card);
      return frag;
    }
    frag.appendChild(buildSummary(rows));
    frag.appendChild(buildPerEmployee(rows));
    frag.appendChild(buildPerDay(rows));
    return frag;
  }

  function buildRange() {
    const card = document.createElement("section");
    card.className = "card";
    const grid = document.createElement("div");
    grid.className = "kb-grid";

    const mk = (labelText, value, onChange) => {
      const wrap = document.createElement("label");
      wrap.className = "field";
      wrap.innerHTML = `<span>${labelText}</span>`;
      const input = document.createElement("input");
      input.type = "date";
      input.value = value;
      input.onchange = () => onChange(input.value);
      wrap.appendChild(input);
      return wrap;
    };
    grid.appendChild(
      mk("Von", from, (v) => {
        from = v;
        rerender();
      })
    );
    grid.appendChild(
      mk("Bis", to, (v) => {
        to = v;
        rerender();
      })
    );
    card.appendChild(grid);

    const quick = document.createElement("div");
    quick.className = "employee-actions";
    quick.style.marginTop = "10px";
    const presets = [
      ["Dieser Monat", () => [firstOfMonth(), todayStr()]],
      ["Letzte 7 Tage", () => [isoDaysAgo(6), todayStr()]],
      ["Letzte 30 Tage", () => [isoDaysAgo(29), todayStr()]],
    ];
    for (const [name, fn] of presets) {
      const b = document.createElement("button");
      b.className = "btn btn-secondary";
      b.textContent = name;
      b.onclick = () => {
        [from, to] = fn();
        rerender();
      };
      quick.appendChild(b);
    }
    card.appendChild(quick);
    return card;
  }

  function isoDaysAgo(n) {
    const d = new Date();
    d.setDate(d.getDate() - n);
    return d.toISOString().slice(0, 10);
  }

  function buildSummary(rows) {
    const sum = (key) => round2(rows.reduce((s, r) => s + (Number(r[key]) || 0), 0));
    const umsatz = sum("umsatzGesamt");
    const lohn = sum("totalLohn");
    const neben = sum("totalLohnnebenkosten");
    const lohnGesamt = round2(lohn + neben);
    const quote = umsatz > 0 ? round2((lohnGesamt / umsatz) * 100) : 0;

    const card = document.createElement("section");
    card.className = "card";
    card.innerHTML = `
      <h2>${escapeHtml(dateDe(from))} – ${escapeHtml(dateDe(to))}</h2>
      <div class="summary-line"><span>Umsatz</span><span><b>${euro(umsatz)}</b></span></div>
      <div class="summary-line"><span>Trinkgeld</span><span>${euro(sum("trinkgeldGesamt"))}</span></div>
      <div class="summary-line"><span>Lohn</span><span>${euro(lohn)}</span></div>
      <div class="summary-line"><span>Lohnnebenkosten (geschätzt)</span><span>${euro(neben)}</span></div>
      <div class="summary-line"><span>Lohnkosten gesamt</span><span><b>${euro(lohnGesamt)}</b> (${String(quote).replace(".", ",")}% vom Umsatz)</span></div>
      <div class="summary-line"><span>Stunden</span><span>${hours(sum("totalHours"))}</span></div>
      <div class="summary-line"><span>Umschlag</span><span>${euro(sum("umschlag"))}</span></div>
      <p class="muted small">${rows.length} Tag(e) im Zeitraum.</p>
    `;
    return card;
  }

  function buildPerEmployee(rows) {
    const byName = new Map();
    for (const r of rows) {
      for (const pe of r.perEmployee || []) {
        const cur = byName.get(pe.name) || { hours: 0, lohn: 0, neben: 0, tip: 0, tage: 0 };
        cur.hours += Number(pe.hours) || 0;
        cur.lohn += Number(pe.lohn) || 0;
        cur.neben += Number(pe.lohnnebenkosten) || 0;
        cur.tip += Number(pe.tip) || 0;
        cur.tage++;
        byName.set(pe.name, cur);
      }
    }
    const card = document.createElement("section");
    card.className = "card";
    card.innerHTML = `<h2>Je Mitarbeiter</h2>`;
    if (byName.size === 0) {
      card.innerHTML += `<p class="muted small">Keine Schichten in diesem Zeitraum.</p>`;
      return card;
    }
    const scroll = document.createElement("div");
    scroll.style.overflowX = "auto";
    const table = document.createElement("table");
    table.className = "calc-table";
    table.innerHTML = `<thead><tr><th>Mitarbeiter</th><th>Tage</th><th>Stunden</th><th>Lohn</th><th>Nebenkosten</th><th>Gesamtkosten</th><th>Trinkgeld</th></tr></thead>`;
    const tbody = document.createElement("tbody");
    for (const [name, v] of [...byName.entries()].sort((a, b) => b[1].lohn - a[1].lohn)) {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${escapeHtml(name)}</td>
        <td>${v.tage}</td>
        <td>${hours(round2(v.hours))}</td>
        <td>${euro(round2(v.lohn))}</td>
        <td>${euro(round2(v.neben))}</td>
        <td><b>${euro(round2(v.lohn + v.neben))}</b></td>
        <td>${euro(round2(v.tip))}</td>`;
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    scroll.appendChild(table);
    card.appendChild(scroll);
    return card;
  }

  function buildPerDay(rows) {
    const card = document.createElement("section");
    card.className = "card";
    const details = document.createElement("details");
    details.className = "history";
    details.innerHTML = `<summary>Tagesgenaue Aufschlüsselung (${rows.length})</summary>`;
    const scroll = document.createElement("div");
    scroll.style.overflowX = "auto";
    scroll.style.marginTop = "10px";
    const table = document.createElement("table");
    table.className = "calc-table";
    table.innerHTML = `<thead><tr><th>Datum</th><th>Umsatz</th><th>Lohnkosten</th><th>Stunden</th><th>Umschlag</th><th>Status</th></tr></thead>`;
    const tbody = document.createElement("tbody");
    for (const r of [...rows].sort((a, b) => (a.date < b.date ? 1 : -1))) {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${escapeHtml(dateDe(r.date))}</td>
        <td>${euro(r.umsatzGesamt)}</td>
        <td>${euro(round2((Number(r.totalLohn) || 0) + (Number(r.totalLohnnebenkosten) || 0)))}</td>
        <td>${hours(r.totalHours)}</td>
        <td>${euro(r.umschlag)}</td>
        <td>${r.status === "abgeschlossen" ? '<span class="badge badge-green">Abgeschlossen</span>' : '<span class="badge badge-orange">Offen</span>'}</td>`;
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    scroll.appendChild(table);
    details.appendChild(scroll);
    card.appendChild(details);
    return card;
  }

  rerender();
  return el;
}

export { renderCosts };
