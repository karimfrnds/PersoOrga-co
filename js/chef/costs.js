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
    frag.appendChild(buildStundenExport(rows));
    frag.appendChild(buildPerEmployee(rows));
    frag.appendChild(buildPerDay(rows));
    return frag;
  }

  /** Stunden-Nachweis fürs Steuerbüro: gearbeitete Zeit je Mitarbeiter und Tag, Pause bereits abgezogen. */
  function buildStundenExport(rows) {
    const card = document.createElement("section");
    card.className = "card";
    card.innerHTML = `
      <h2>📤 Stunden fürs Steuerbüro</h2>
      <p class="muted small">Gearbeitete Stunden je Mitarbeiter im gewählten Zeitraum – die gesetzliche Pause ist
      bereits abgezogen. Als CSV-Datei, die sich in Excel öffnen lässt.</p>`;

    // Je Person: Summe + die einzelnen Tage
    const proPerson = new Map();
    for (const r of rows) {
      for (const pe of r.perEmployee || []) {
        if (!proPerson.has(pe.name)) proPerson.set(pe.name, { stunden: 0, pause: 0, tage: [] });
        const p = proPerson.get(pe.name);
        p.stunden += Number(pe.hours) || 0;
        p.pause += Number(pe.breakMinutes) || 0;
        p.tage.push({ date: r.date, stunden: Number(pe.hours) || 0, pause: Number(pe.breakMinutes) || 0 });
      }
    }

    if (proPerson.size === 0) {
      card.innerHTML += `<p class="muted small">Keine Arbeitszeiten in diesem Zeitraum.</p>`;
      return card;
    }

    const vorschau = document.createElement("table");
    vorschau.className = "calc-table";
    vorschau.innerHTML = `<thead><tr><th>Mitarbeiter</th><th>Tage</th><th>Stunden (netto)</th></tr></thead>`;
    const tb = document.createElement("tbody");
    let gesamt = 0;
    for (const [name, p] of [...proPerson.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      gesamt += p.stunden;
      const tr = document.createElement("tr");
      tr.innerHTML = `<td>${escapeHtml(name)}</td><td>${p.tage.length}</td><td>${hours(round2(p.stunden))}</td>`;
      tb.appendChild(tr);
    }
    const tot = document.createElement("tr");
    tot.className = "total-row";
    tot.innerHTML = `<td><b>Gesamt</b></td><td></td><td><b>${hours(round2(gesamt))}</b></td>`;
    tb.appendChild(tot);
    vorschau.appendChild(tb);
    const scroll = document.createElement("div");
    scroll.style.overflowX = "auto";
    scroll.appendChild(vorschau);
    card.appendChild(scroll);

    const btn = document.createElement("button");
    btn.className = "btn btn-primary";
    btn.textContent = "⬇ Stunden als CSV herunterladen";
    btn.onclick = () => ladeCsvHerunter(proPerson);
    card.appendChild(btn);

    const hinweis = document.createElement("p");
    hinweis.className = "muted small";
    hinweis.textContent =
      "Enthält nur abgeglichene Tage. Läuft das iPad gerade nicht, fehlen die letzten Tage – vorher am iPad einmal abgleichen lassen.";
    card.appendChild(hinweis);
    return card;
  }

  function ladeCsvHerunter(proPerson) {
    const n = (x) => round2(x).toFixed(2).replace(".", ",");
    const zeilen = [];
    zeilen.push(["Stundennachweis", `${from} bis ${to}`]);
    zeilen.push(["Hinweis", "Stunden sind Netto-Arbeitszeit, die gesetzliche Pause ist bereits abgezogen."]);
    zeilen.push([]);
    zeilen.push(["Summe je Mitarbeiter", "Tage", "Stunden (netto)", "davon abgezogene Pause (Min)"]);
    for (const [name, p] of [...proPerson.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      zeilen.push([name, String(p.tage.length), n(p.stunden), String(Math.round(p.pause))]);
    }
    zeilen.push([]);
    zeilen.push(["Einzelne Tage"]);
    zeilen.push(["Datum", "Mitarbeiter", "Stunden (netto)", "abgezogene Pause (Min)"]);
    const alleTage = [];
    for (const [name, p] of proPerson.entries()) for (const t of p.tage) alleTage.push({ name, ...t });
    alleTage.sort((a, b) => (a.date === b.date ? a.name.localeCompare(b.name) : a.date < b.date ? -1 : 1));
    for (const t of alleTage) zeilen.push([t.date, t.name, n(t.stunden), String(Math.round(t.pause))]);

    const csv = zeilen.map((z) => z.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(";")).join("\r\n");
    // BOM voran, damit Excel die Umlaute richtig anzeigt.
    const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `stunden-${from}-bis-${to}.csv`;
    a.click();
    URL.revokeObjectURL(url);
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
    `;
    card.appendChild(buildWareneinsatz(rows, umsatz, lohnGesamt));
    const fuss = document.createElement("p");
    fuss.className = "muted small";
    fuss.textContent = `${rows.length} Tag(e) im Zeitraum.`;
    card.appendChild(fuss);
    return card;
  }

  /** Wareneinsatz und Prime Cost.
   *
   * Prime Cost ist Wareneinsatz plus Personal – in der Gastronomie die eine Zahl, auf die geschaut wird,
   * weil das die beiden Kostenbloecke sind, die man taeglich beeinflussen kann. Miete und Versicherung
   * stehen ohnehin fest.
   *
   * Gerechnet wird nur ueber Tage, an denen der Wareneinsatz auch wirklich erfasst ist: ein Tag ohne
   * hochgeladenen Kassenbericht haette 0 EUR Wareneinsatz und wuerde die Quote schoenrechnen.
   */
  function buildWareneinsatz(rows, umsatz, lohnGesamt) {
    const box = document.createElement("div");
    const mitWaren = rows.filter((r) => Number(r.materialkosten) > 0);
    const waren = round2(mitWaren.reduce((s, r) => s + Number(r.materialkosten), 0));

    if (mitWaren.length === 0) {
      const hinweis = document.createElement("p");
      hinweis.className = "muted small";
      hinweis.innerHTML =
        `<b>Wareneinsatz: noch keine Daten.</b> Er entsteht automatisch, sobald Kassenberichte hochgeladen
         sind, bei den Artikeln Einkaufspreise stehen und die verkauften Produkte einem Rezept oder Artikel
         zugeordnet sind.`;
      box.appendChild(hinweis);
      return box;
    }

    // Fuer die Quote nur die Tage nehmen, die auch Wareneinsatz haben – sonst vergleicht man den
    // Wareneinsatz von 12 Tagen mit dem Umsatz von 30.
    const umsatzMitWaren = round2(mitWaren.reduce((s, r) => s + (Number(r.umsatzGesamt) || 0), 0));
    const warenQuote = umsatzMitWaren > 0 ? round2((waren / umsatzMitWaren) * 100) : 0;
    const lohnMitWaren = round2(
      mitWaren.reduce((s, r) => s + (Number(r.totalLohn) || 0) + (Number(r.totalLohnnebenkosten) || 0), 0)
    );
    const primeCost = round2(waren + lohnMitWaren);
    const primeQuote = umsatzMitWaren > 0 ? round2((primeCost / umsatzMitWaren) * 100) : 0;
    const prozent = (n) => String(n).replace(".", ",") + " %";

    box.innerHTML = `
      <div class="summary-line"><span>Wareneinsatz</span><span><b>${euro(waren)}</b> (${prozent(warenQuote)} vom Umsatz)</span></div>
      <div class="summary-line"><span>Rohertrag</span><span>${euro(round2(umsatzMitWaren - waren))}</span></div>
      <div class="summary-line"><span><b>Prime Cost</b> (Ware + Personal)</span><span><b>${euro(primeCost)}</b> (${prozent(primeQuote)})</span></div>`;

    const einordnung = document.createElement("p");
    einordnung.className = primeQuote > 70 ? "callout callout-warn" : "callout";
    einordnung.innerHTML =
      primeQuote > 70
        ? `<b>Prime Cost bei ${prozent(primeQuote)}.</b> Über etwa 70 % bleibt wenig für Miete, Energie und alles andere. Die beiden Stellschrauben sind Einkauf und Personaleinsatz.`
        : `<b>Prime Cost bei ${prozent(primeQuote)}.</b> Ware und Personal zusammen – die beiden Blöcke, die sich täglich beeinflussen lassen. Unter etwa 70 % gilt als gesund.`;
    box.appendChild(einordnung);

    if (mitWaren.length < rows.length) {
      const hinweis = document.createElement("p");
      hinweis.className = "muted small";
      hinweis.textContent =
        `Wareneinsatz und die beiden Quoten beruhen auf ${mitWaren.length} von ${rows.length} Tagen – nur auf denen ` +
        `ist er erfasst. Die anderen sind bewusst nicht mitgerechnet, sonst sähe die Quote besser aus, als sie ist.`;
      box.appendChild(hinweis);
    }
    return box;
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
