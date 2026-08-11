// ============================================================================
// pages/exportpage.js – Monatsübersicht & CSV-Export fürs Steuerbüro
// ============================================================================
import { store } from "../store.js";
import { computeMonth, ROLE_LABEL } from "../calc.js";
import { euro, hours, monthLabel, dateDe, escapeHtml } from "../format.js";

function renderExport() {
  const container = document.createElement("div");
  container.className = "page";

  let selectedMonth = new Date().toISOString().slice(0, 7);

  function rerender() {
    container.innerHTML = "";
    container.appendChild(build());
  }

  function build() {
    const frag = document.createElement("div");
    frag.innerHTML = `<h1>Monatsübersicht</h1><p class="muted">Für die Übergabe an euer Steuerbüro. Nur abgeschlossene Tage werden berücksichtigt.</p>`;

    const monthInput = document.createElement("input");
    monthInput.type = "month";
    monthInput.value = selectedMonth;
    monthInput.onchange = () => {
      selectedMonth = monthInput.value;
      rerender();
    };
    frag.appendChild(monthInput);

    const settings = store.getSettings();
    const employees = store.getEmployees(true);
    const days = store.getDays();
    const result = computeMonth(days, employees, settings, selectedMonth);

    const h2 = document.createElement("h2");
    h2.textContent = monthLabel(selectedMonth);
    h2.style.marginTop = "16px";
    frag.appendChild(h2);

    if (result.rows.length === 0) {
      const empty = document.createElement("div");
      empty.className = "empty-state";
      empty.textContent = "Keine abgeschlossenen Tage in diesem Monat.";
      frag.appendChild(empty);
      return frag;
    }

    const table = document.createElement("table");
    table.className = "calc-table";
    table.innerHTML = `<thead><tr><th>Mitarbeiter</th><th>Rolle</th><th>Stunden</th><th>Lohn (steuerpflichtig)</th><th>Trinkgeld (steuerfrei)</th><th>Gesamt</th></tr></thead>`;
    const tbody = document.createElement("tbody");
    let sumHours = 0, sumLohn = 0, sumTip = 0;
    for (const row of result.rows) {
      sumHours += row.hours;
      sumLohn += row.lohn;
      sumTip += row.tip;
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${escapeHtml(row.employee.name)}</td>
        <td>${ROLE_LABEL[row.employee.role]}</td>
        <td>${hours(row.hours)}</td>
        <td>${euro(row.lohn)}</td>
        <td>${euro(row.tip)}</td>
        <td><b>${euro(row.lohn + row.tip)}</b></td>
      `;
      tbody.appendChild(tr);
    }
    const trTotal = document.createElement("tr");
    trTotal.className = "total-row";
    trTotal.innerHTML = `<td><b>Gesamt</b></td><td></td><td><b>${hours(sumHours)}</b></td><td><b>${euro(sumLohn)}</b></td><td><b>${euro(sumTip)}</b></td><td><b>${euro(sumLohn + sumTip)}</b></td>`;
    tbody.appendChild(trTotal);
    table.appendChild(tbody);
    frag.appendChild(table);

    const umschlagInfo = document.createElement("p");
    umschlagInfo.className = "muted";
    umschlagInfo.innerHTML = `Summe Umschlag/Café in diesem Monat: <b>${euro(result.dayUmschlagTotal)}</b> (${result.days.length} abgeschlossene Tage)`;
    frag.appendChild(umschlagInfo);

    // Umsatzsteuer-Aufteilung fürs Steuerbüro
    const vatSection = document.createElement("section");
    vatSection.className = "card";
    vatSection.innerHTML = `<h2>Umsatzsteuer</h2>`;
    const vatTable = document.createElement("table");
    vatTable.className = "calc-table";
    vatTable.innerHTML = `
      <thead><tr><th></th><th>Umsatz (brutto)</th><th>davon enthaltene USt.</th></tr></thead>
      <tbody>
        <tr><td>7 % ermäßigt</td><td>${euro(result.umsatz7)}</td><td>${euro(result.ust7)}</td></tr>
        <tr><td>19 % regulär</td><td>${euro(result.umsatz19)}</td><td>${euro(result.ust19)}</td></tr>
        <tr class="total-row"><td><b>Summe</b></td><td><b>${euro(result.umsatz7 + result.umsatz19)}</b></td><td><b>${euro(result.ust7 + result.ust19)}</b></td></tr>
      </tbody>
    `;
    vatSection.appendChild(vatTable);
    if (Math.abs(result.umsatz7 + result.umsatz19 - result.umsatzGesamt) >= 0.1) {
      const w = document.createElement("p");
      w.className = "callout callout-warn";
      w.textContent = `Hinweis: Gemeldeter Gesamtumsatz (${euro(result.umsatzGesamt)}) weicht von 7%+19% (${euro(result.umsatz7 + result.umsatz19)}) ab – bitte einzelne Tage prüfen.`;
      vatSection.appendChild(w);
    }
    frag.appendChild(vatSection);

    // Minijob-Warnungen
    const warnings = [];
    for (const row of result.rows) {
      if (row.employee.isMinijob && row.lohn > row.employee.minijobLimit) {
        warnings.push(`${row.employee.name}: ${euro(row.lohn)} Lohn diesen Monat, Minijob-Grenze ist ${euro(row.employee.minijobLimit)}!`);
      } else if (row.employee.isMinijob && row.lohn > row.employee.minijobLimit * 0.85) {
        warnings.push(`${row.employee.name}: ${euro(row.lohn)} Lohn – nähert sich der Minijob-Grenze von ${euro(row.employee.minijobLimit)}.`);
      }
    }
    if (warnings.length) {
      const w = document.createElement("div");
      w.className = "callout callout-warn";
      w.innerHTML = warnings.map(escapeHtml).join("<br/>");
      frag.appendChild(w);
    }

    const csvBtn = document.createElement("button");
    csvBtn.className = "btn btn-primary";
    csvBtn.textContent = "⬇ Als CSV exportieren (Excel)";
    csvBtn.onclick = () => downloadCsv(result, selectedMonth);
    frag.appendChild(csvBtn);

    return frag;
  }

  function downloadCsv(result, month) {
    const n = (x) => x.toFixed(2).replace(".", ",");
    const lines = [["Mitarbeiter", "Rolle", "Stunden", "Lohn (steuerpflichtig)", "Trinkgeld (steuerfrei)", "Gesamt"]];
    for (const row of result.rows) {
      lines.push([row.employee.name, ROLE_LABEL[row.employee.role], n(row.hours), n(row.lohn), n(row.tip), n(row.lohn + row.tip)]);
    }
    lines.push([]);
    lines.push(["Umsatzsteuer", "Umsatz (brutto)", "davon enthaltene USt."]);
    lines.push(["7 % ermäßigt", n(result.umsatz7), n(result.ust7)]);
    lines.push(["19 % regulär", n(result.umsatz19), n(result.ust19)]);
    lines.push(["Summe", n(result.umsatz7 + result.umsatz19), n(result.ust7 + result.ust19)]);
    const csv = lines.map((l) => l.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(";")).join("\r\n");
    const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `abrechnung-${month}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  rerender();
  return container;
}

export { renderExport };
