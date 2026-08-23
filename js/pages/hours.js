// ============================================================================
// pages/hours.js – Stunden-Übersicht + Arbeitszeit-Verwaltung (Admin).
// Bewusst getrennt von Kassenabschluss/Tagesabschluss: hier geht es NUR um
// Arbeitszeiten (wer war wann da), nicht um Umsatz, Trinkgeld oder den Tages-Status.
// ============================================================================
import { store } from "../store.js";
import { computeRange, computeDayByDayRange, computeHours, ROLE_LABEL } from "../calc.js";
import { euro, hours, todayStr, dateDe, escapeHtml } from "../format.js";
import { requireUnlock } from "../adminAuth.js";
import { confirmDialog, alertDialog } from "../dialog.js";

function firstOfMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}

function renderHours() {
  const container = document.createElement("div");
  container.className = "page";

  let editDate = todayStr();
  let deleteFrom = todayStr();
  let deleteTo = todayStr();
  let selectedForDelete = new Set();
  let from = firstOfMonth();
  let to = todayStr();

  function rerender() {
    container.innerHTML = "";
    container.appendChild(build());
  }

  function build() {
    const frag = document.createElement("div");
    frag.innerHTML = `<h1>Stunden</h1><p class="muted">Arbeitszeiten verwalten und als Nachweis einsehen – unabhängig vom Kassenabschluss.</p>`;
    frag.appendChild(buildShiftEditor());
    frag.appendChild(buildDeleteDays());
    frag.appendChild(buildOverview());
    return frag;
  }

  // ---------------------------------------------------------------------
  // 1) Arbeitszeit für einen Tag eintragen/ändern (nur Schichten, kein Kassenabschluss)
  // ---------------------------------------------------------------------
  function buildShiftEditor() {
    const card = document.createElement("section");
    card.className = "card";
    card.innerHTML = `<h2>Arbeitszeit eintragen oder ändern</h2><p class="muted small">Nur die Arbeitszeiten – hat nichts mit Kassenabschluss/Tag abschließen zu tun.</p>`;

    const dateField = document.createElement("label");
    dateField.className = "field";
    dateField.innerHTML = `<span>Tag</span>`;
    const dateInput = document.createElement("input");
    dateInput.type = "date";
    dateInput.value = editDate;
    dateInput.onchange = () => {
      editDate = dateInput.value;
      rerender();
    };
    dateField.appendChild(dateInput);
    card.appendChild(dateField);

    const employees = store.getEmployees(false);
    const day = store.getDayByDate(editDate);
    const settings = store.getSettings();

    if (employees.length === 0) {
      const w = document.createElement("div");
      w.className = "callout callout-warn";
      w.textContent = "Keine Mitarbeiter angelegt.";
      card.appendChild(w);
      return card;
    }

    const shiftTable = document.createElement("div");
    shiftTable.className = "shift-table";
    const shifts = day ? day.shifts : [];

    for (const shift of shifts) {
      const emp = employees.find((e) => e.id === shift.employeeId) || store.getEmployee(shift.employeeId);
      const options = employees.some((e) => e.id === shift.employeeId) || !emp ? employees : [...employees, emp];
      const row = document.createElement("div");
      row.className = "shift-row";

      const select = document.createElement("select");
      select.innerHTML = options
        .map((e) => `<option value="${e.id}" ${e.id === shift.employeeId ? "selected" : ""}>${escapeHtml(e.name)}${e.active === false ? " (inaktiv)" : ""} (${ROLE_LABEL[e.role]})</option>`)
        .join("");
      select.onchange = () => {
        store.updateShift(day.id, shift.id, { employeeId: select.value });
        rerender();
      };

      const fromInput = document.createElement("input");
      fromInput.type = "time";
      fromInput.value = shift.from || "";
      fromInput.onchange = () => {
        store.updateShift(day.id, shift.id, { from: fromInput.value });
        rerender();
      };
      const toInput = document.createElement("input");
      toInput.type = "time";
      toInput.value = shift.to || "";
      toInput.onchange = () => {
        store.updateShift(day.id, shift.id, { to: toInput.value });
        rerender();
      };

      const h = shift.from && shift.to ? hours(computeHours(shift.from, shift.to, settings.roundingMinutes)) : "–";

      row.appendChild(select);
      const fromLabel = document.createElement("label");
      fromLabel.className = "inline-label";
      fromLabel.append("von ", fromInput);
      const toLabel = document.createElement("label");
      toLabel.className = "inline-label";
      toLabel.append("bis ", toInput);
      row.appendChild(fromLabel);
      row.appendChild(toLabel);
      const hoursSpan = document.createElement("span");
      hoursSpan.className = "shift-hours";
      hoursSpan.textContent = h;
      row.appendChild(hoursSpan);

      const del = document.createElement("button");
      del.className = "btn btn-icon-danger";
      del.textContent = "✕";
      del.onclick = async () => {
        if (await confirmDialog("Diese Arbeitszeit wirklich entfernen?", { danger: true, okLabel: "Entfernen" })) {
          store.removeShift(day.id, shift.id);
          rerender();
        }
      };
      row.appendChild(del);
      shiftTable.appendChild(row);
    }
    card.appendChild(shiftTable);

    if (shifts.length > 0) {
      const note = document.createElement("p");
      note.className = "muted small";
      note.textContent = "Hinweis: In der Abrechnung wird ab 6 Std. automatisch 30 Min Pause abgezogen (ab 9 Std. 45 Min) – hier stehen die reinen Kommen/Gehen-Zeiten.";
      card.appendChild(note);
    }

    const addBtn = document.createElement("button");
    addBtn.className = "btn btn-secondary";
    addBtn.textContent = "＋ Arbeitszeit hinzufügen";
    addBtn.onclick = () => {
      const d = day || store.createDay(editDate);
      store.addShift(d.id, { employeeId: employees[0].id, from: "10:00", to: "18:00" });
      rerender();
    };
    card.appendChild(addBtn);

    return card;
  }

  // ---------------------------------------------------------------------
  // 2) Tage löschen
  // ---------------------------------------------------------------------
  function buildDeleteDays() {
    const card = document.createElement("section");
    card.className = "card";
    card.innerHTML = `<h2>Tage löschen</h2><p class="muted small">Ganze Tage inkl. Arbeitszeiten und Kassenabschluss endgültig entfernen – z.B. um versehentlich angelegte Tage (etwa aus einem Wochenplan-Upload) wieder loszuwerden.</p>`;

    const rangeRow = document.createElement("div");
    rangeRow.className = "kb-grid";
    const fromField = document.createElement("label");
    fromField.className = "field";
    fromField.innerHTML = `<span>Von</span>`;
    const fromInput = document.createElement("input");
    fromInput.type = "date";
    fromInput.value = deleteFrom;
    fromInput.onchange = () => {
      deleteFrom = fromInput.value;
      rerender();
    };
    fromField.appendChild(fromInput);
    const toField = document.createElement("label");
    toField.className = "field";
    toField.innerHTML = `<span>Bis</span>`;
    const toInput = document.createElement("input");
    toInput.type = "date";
    toInput.value = deleteTo;
    toInput.onchange = () => {
      deleteTo = toInput.value;
      rerender();
    };
    toField.appendChild(toInput);
    rangeRow.appendChild(fromField);
    rangeRow.appendChild(toField);
    card.appendChild(rangeRow);

    const daysInRange = store
      .getDays()
      .filter((d) => (!deleteFrom || d.date >= deleteFrom) && (!deleteTo || d.date <= deleteTo))
      .sort((a, b) => (a.date < b.date ? -1 : 1));

    if (daysInRange.length === 0) {
      const empty = document.createElement("p");
      empty.className = "muted small";
      empty.textContent = "Keine Tage in diesem Zeitraum.";
      card.appendChild(empty);
      return card;
    }

    const list = document.createElement("div");
    list.className = "employee-list";
    for (const d of daysInRange) {
      const row = document.createElement("label");
      row.className = "employee-row";
      row.style.cursor = "pointer";
      const left = document.createElement("div");
      left.className = "employee-main";
      left.style.flexDirection = "row";
      left.style.alignItems = "center";
      left.style.gap = "10px";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = selectedForDelete.has(d.id);
      cb.onchange = () => {
        if (cb.checked) selectedForDelete.add(d.id);
        else selectedForDelete.delete(d.id);
        rerender();
      };
      left.appendChild(cb);
      const staffCount = new Set(d.shifts.map((s) => s.employeeId)).size;
      const textSpan = document.createElement("span");
      textSpan.innerHTML = `<b>${escapeHtml(dateDe(d.date))}</b> <span class="muted small">– ${staffCount} Mitarbeiter, ${d.status === "abgeschlossen" ? "abgeschlossen" : "offen"}</span>`;
      left.appendChild(textSpan);
      row.appendChild(left);
      list.appendChild(row);
    }
    card.appendChild(list);

    const deleteBtn = document.createElement("button");
    deleteBtn.className = "btn btn-icon-danger";
    deleteBtn.style.width = "auto";
    deleteBtn.style.padding = "12px 18px";
    deleteBtn.style.marginTop = "12px";
    deleteBtn.disabled = selectedForDelete.size === 0;
    deleteBtn.textContent = `Ausgewählte Tage endgültig löschen (${selectedForDelete.size})`;
    deleteBtn.onclick = async () => {
      if (!(await requireUnlock())) return;
      if (
        !(await confirmDialog(
          `${selectedForDelete.size} Tag(e) inkl. aller Arbeitszeiten und Kassenabschluss-Daten endgültig löschen? Das kann nicht rückgängig gemacht werden.`,
          { danger: true, okLabel: "Endgültig löschen" }
        ))
      )
        return;
      for (const id of selectedForDelete) store.deleteDay(id);
      selectedForDelete = new Set();
      rerender();
    };
    card.appendChild(deleteBtn);

    return card;
  }

  // ---------------------------------------------------------------------
  // 3) Übersicht in einem Zeitraum: tagesgenau (wer wann gearbeitet hat) + Summe je Mitarbeiter
  // ---------------------------------------------------------------------
  function buildOverview() {
    const card = document.createElement("section");
    card.className = "card";
    card.innerHTML = `<h2>Übersicht in einem Zeitraum</h2><p class="muted small">Tagesgenau, damit klar nachvollziehbar ist, wer wann da war.</p>`;

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
    card.appendChild(rangeRow);

    const settings = store.getSettings();
    const employees = store.getEmployees(true);
    const days = store.getDays();
    const detailRows = computeDayByDayRange(days, employees, settings, from, to);

    if (detailRows.length === 0) {
      const empty = document.createElement("div");
      empty.className = "empty-state";
      empty.textContent = "Keine Schichten in diesem Zeitraum.";
      card.appendChild(empty);
      return card;
    }

    // Tagesgenaue Tabelle – ein Datum wird über alle Mitarbeiter dieses Tages hinweg zusammengefasst (rowspan),
    // damit auf einen Blick klar ist, wer an welchem Tag zusammen gearbeitet hat.
    const groups = [];
    for (const row of detailRows) {
      const last = groups[groups.length - 1];
      if (last && last.date === row.date) last.rows.push(row);
      else groups.push({ date: row.date, status: row.status, rows: [row] });
    }

    const detailTable = document.createElement("table");
    detailTable.className = "calc-table";
    detailTable.innerHTML = `<thead><tr><th>Datum</th><th>Status</th><th>Mitarbeiter</th><th>Rolle</th><th>Kommen–Gehen</th><th>Pause</th><th>Stunden</th><th>Lohn</th><th>Trinkgeld</th></tr></thead>`;
    const detailBody = document.createElement("tbody");
    for (const group of groups) {
      group.rows.forEach((row, i) => {
        const tr = document.createElement("tr");
        const dateCell = i === 0 ? `<td rowspan="${group.rows.length}"><b>${escapeHtml(dateDe(group.date))}</b></td><td rowspan="${group.rows.length}">${group.status === "abgeschlossen" ? '<span class="badge badge-green">Abgeschlossen</span>' : '<span class="badge badge-orange">Offen</span>'}</td>` : "";
        tr.innerHTML = `
          ${dateCell}
          <td>${escapeHtml(row.employee.name)}</td>
          <td>${ROLE_LABEL[row.employee.role]}</td>
          <td class="muted small">${escapeHtml(row.timeRange)}</td>
          <td class="muted small">${row.breakMinutes > 0 ? `−${row.breakMinutes} Min` : "–"}</td>
          <td>${hours(row.hours)}</td>
          <td>${euro(row.lohn)}</td>
          <td>${euro(row.tip)}</td>
        `;
        if (i > 0) tr.style.borderTop = "none";
        detailBody.appendChild(tr);
      });
    }
    detailTable.appendChild(detailBody);
    const scrollWrap = document.createElement("div");
    scrollWrap.style.overflowX = "auto";
    scrollWrap.appendChild(detailTable);
    card.appendChild(scrollWrap);

    // Summe je Mitarbeiter im Zeitraum
    const result = computeRange(days, employees, settings, from, to);
    const summaryHeading = document.createElement("h2");
    summaryHeading.textContent = "Gesamt je Mitarbeiter";
    summaryHeading.style.marginTop = "20px";
    card.appendChild(summaryHeading);

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
    card.appendChild(table);

    const info = document.createElement("p");
    info.className = "muted small";
    info.textContent = `${result.days.length} Tage im Zeitraum: ${result.closedCount} abgeschlossen, ${result.openCount} noch offen (Zahlen bei offenen Tagen können sich noch ändern).`;
    card.appendChild(info);

    return card;
  }

  rerender();
  return container;
}

export { renderHours };
