// ============================================================================
// pages/hours.js – Stunden-Übersicht über einen frei wählbaren Zeitraum
// (Arbeitszeit-Dokumentation, unabhängig von Lohn-/Trinkgeldabrechnung)
// ============================================================================
import { store } from "../store.js";
import { computeRange, ROLE_LABEL } from "../calc.js";
import { euro, hours, todayStr, escapeHtml } from "../format.js";
import { requireUnlock } from "../adminAuth.js";

function firstOfMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}

function renderHours(navigate) {
  const container = document.createElement("div");
  container.className = "page";

  let from = firstOfMonth();
  let to = todayStr();

  function rerender() {
    container.innerHTML = "";
    container.appendChild(build());
  }

  function build() {
    const frag = document.createElement("div");
    frag.innerHTML = `<h1>Stunden-Übersicht</h1><p class="muted">Erfasste Arbeitszeit pro Mitarbeiter in einem Zeitraum – dient als Nachweis der Arbeitszeit (auch offene Tage werden mitgezählt).</p>`;

    // Zeiten nachtragen / bearbeiten
    const editCard = document.createElement("section");
    editCard.className = "card";
    editCard.innerHTML = `<h2>Arbeitszeit nachtragen oder bearbeiten</h2><p class="muted small">Tag auswählen – existiert er noch nicht, wird er angelegt; ist er schon abgeschlossen, wird er zum Bearbeiten automatisch wieder geöffnet.</p>`;
    const editRow = document.createElement("div");
    editRow.style.display = "flex";
    editRow.style.gap = "10px";
    editRow.style.alignItems = "flex-end";
    editRow.style.flexWrap = "wrap";
    const dateField = document.createElement("label");
    dateField.className = "field";
    dateField.innerHTML = `<span>Datum</span>`;
    const dateInput = document.createElement("input");
    dateInput.type = "date";
    dateInput.value = todayStr();
    dateField.appendChild(dateInput);
    const goBtn = document.createElement("button");
    goBtn.className = "btn btn-primary";
    goBtn.textContent = "Öffnen / Anlegen";
    goBtn.onclick = async () => {
      if (!navigate) return;
      const date = dateInput.value || todayStr();
      let day = store.getDayByDate(date);
      if (!day) {
        day = store.createDay(date);
      } else if (day.status === "abgeschlossen") {
        if (!(await requireUnlock())) return;
        store.reopenDay(day.id, "Über Admin-Bereich (Stunden nachtragen) geöffnet");
      }
      navigate(`day/${day.id}`);
    };
    editRow.appendChild(dateField);
    editRow.appendChild(goBtn);
    editCard.appendChild(editRow);
    frag.appendChild(editCard);

    const rangeRow = document.createElement("div");
    rangeRow.className = "kb-grid";
    const fromField = document.createElement("label");
    fromField.className = "field";
    fromField.innerHTML = `<span>Von</span>`;
    const fromInput = document.createElement("input");
    fromInput.type = "date";
    fromInput.value = from;
    fromInput.onchange = () => {
      from = fromInput.value;
      rerender();
    };
    fromField.appendChild(fromInput);

    const toField = document.createElement("label");
    toField.className = "field";
    toField.innerHTML = `<span>Bis</span>`;
    const toInput = document.createElement("input");
    toInput.type = "date";
    toInput.value = to;
    toInput.onchange = () => {
      to = toInput.value;
      rerender();
    };
    toField.appendChild(toInput);

    rangeRow.appendChild(fromField);
    rangeRow.appendChild(toField);
    frag.appendChild(rangeRow);

    const settings = store.getSettings();
    const employees = store.getEmployees(true);
    const days = store.getDays();
    const result = computeRange(days, employees, settings, from, to);

    if (result.rows.length === 0) {
      const empty = document.createElement("div");
      empty.className = "empty-state";
      empty.textContent = "Keine Schichten in diesem Zeitraum.";
      frag.appendChild(empty);
      return frag;
    }

    const table = document.createElement("table");
    table.className = "calc-table";
    table.innerHTML = `<thead><tr><th>Mitarbeiter</th><th>Rolle</th><th>Stunden</th><th>Lohn</th><th>Trinkgeld</th></tr></thead>`;
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
      `;
      tbody.appendChild(tr);
    }
    const trTotal = document.createElement("tr");
    trTotal.className = "total-row";
    trTotal.innerHTML = `<td><b>Gesamt</b></td><td></td><td><b>${hours(sumHours)}</b></td><td><b>${euro(sumLohn)}</b></td><td><b>${euro(sumTip)}</b></td>`;
    tbody.appendChild(trTotal);
    table.appendChild(tbody);
    frag.appendChild(table);

    const info = document.createElement("p");
    info.className = "muted small";
    info.textContent = `${result.days.length} Tage im Zeitraum: ${result.closedCount} abgeschlossen, ${result.openCount} noch offen (Zahlen bei offenen Tagen können sich noch ändern).`;
    frag.appendChild(info);

    return frag;
  }

  rerender();
  return container;
}

export { renderHours };
