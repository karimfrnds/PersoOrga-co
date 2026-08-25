// ============================================================================
// pages/day.js – Tageserfassung: Schichten, Kassenabschluss, Stornos, Berechnung
// ============================================================================
import { store } from "../store.js";
import { computeDay, computeHours, ROLE_LABEL } from "../calc.js";
import { euro, hours, dateDe, escapeHtml } from "../format.js";
import { confirmDialog, alertDialog } from "../dialog.js";
import { requireUnlock } from "../adminAuth.js";

function renderDay(dayId, navigate) {
  const container = document.createElement("div");
  container.className = "page";

  function rerender() {
    container.innerHTML = "";
    container.appendChild(build());
  }

  function build() {
    const day = store.getDay(dayId);
    if (!day) {
      const notFound = document.createElement("div");
      notFound.className = "empty-state";
      notFound.textContent = "Dieser Tag existiert nicht (mehr).";
      return notFound;
    }
    const employees = store.getEmployees(false);
    const settings = store.getSettings();
    const locked = day.status === "abgeschlossen";
    const breakdown = computeDay(day, store.getEmployees(), settings);

    const frag = document.createElement("div");

    // ---- Kopf ----
    const head = document.createElement("div");
    head.className = "day-head";
    head.innerHTML = `
      <button class="btn btn-link" id="back-btn">← Zurück zur Übersicht</button>
      <h1>${escapeHtml(dateDe(day.date))}</h1>
    `;
    const statusWrap = document.createElement("div");
    statusWrap.className = "day-status-wrap";
    const badge = document.createElement("span");
    badge.className = locked ? "badge badge-green" : "badge badge-orange";
    badge.textContent = locked ? "Abgeschlossen" : "Offen";
    statusWrap.appendChild(badge);
    head.appendChild(statusWrap);
    frag.appendChild(head);
    head.querySelector("#back-btn").onclick = () => navigate("");

    if (locked) {
      const info = document.createElement("div");
      info.className = "callout";
      info.innerHTML = `Dieser Tag ist abgeschlossen und gesperrt. Änderungen werden protokolliert.<br/>`;
      const editBtn = document.createElement("button");
      editBtn.className = "btn btn-secondary";
      editBtn.textContent = "Trotzdem bearbeiten";
      editBtn.onclick = async () => {
        if (await requireUnlock()) openReopenDialog(day.id, rerender);
      };
      info.appendChild(editBtn);
      frag.appendChild(info);
    }

    // ---- Aufgaben ----
    const taskSection = document.createElement("section");
    taskSection.className = "card";
    const openTasks = day.tasks.filter((t) => !t.done).length;
    taskSection.innerHTML = `<h2>0. Aufgaben${day.tasks.length ? ` <span class="muted small">(${openTasks} offen)</span>` : ""}</h2>`;
    if (day.tasks.length === 0) {
      const empty = document.createElement("p");
      empty.className = "muted small";
      empty.textContent = "Keine Aufgaben für diesen Tag (siehe Admin → Aufgaben für die Vorlage).";
      taskSection.appendChild(empty);
    } else {
      const taskList = document.createElement("div");
      taskList.className = "task-list";
      for (const task of day.tasks) {
        const row = document.createElement("label");
        row.className = "task-row" + (task.done ? " done" : "");
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = task.done;
        cb.onchange = () => {
          store.toggleDayTask(day.id, task.id, "Admin");
          rerender();
        };
        row.appendChild(cb);
        const textWrap = document.createElement("div");
        textWrap.className = "task-row-text";
        const span = document.createElement("span");
        span.textContent = (task.priority === "hoch" ? "🔴 " : task.priority === "niedrig" ? "🔵 " : "") + task.text;
        textWrap.appendChild(span);
        if (task.assignedTo) {
          const assignee = employees.find((e) => e.id === task.assignedTo) || store.getEmployee(task.assignedTo);
          if (assignee) {
            const tag = document.createElement("span");
            tag.className = "muted small task-row-meta";
            tag.textContent = `→ für ${assignee.name}${task.handoffFrom ? ` (übergeben von ${task.handoffFrom})` : ""}`;
            textWrap.appendChild(tag);
          }
        }
        if (task.done && task.doneBy) {
          const meta = document.createElement("span");
          meta.className = "muted small task-row-meta";
          meta.textContent = `✓ erledigt von ${task.doneBy}${task.doneAt ? ", " + new Date(task.doneAt).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" }) + " Uhr" : ""}`;
          textWrap.appendChild(meta);
        }
        row.appendChild(textWrap);
        taskList.appendChild(row);
      }
      taskSection.appendChild(taskList);
    }
    frag.appendChild(taskSection);

    // ---- Schichten ----
    const shiftSection = document.createElement("section");
    shiftSection.className = "card";
    shiftSection.innerHTML = `<h2>1. Wer hat gearbeitet?</h2>`;
    const shiftTable = document.createElement("div");
    shiftTable.className = "shift-table";

    if (employees.length === 0) {
      const w = document.createElement("div");
      w.className = "callout callout-warn";
      w.textContent = "Keine Mitarbeiter angelegt. Bitte zuerst unter „Mitarbeiter“ das Team eintragen.";
      shiftSection.appendChild(w);
    }

    for (const shift of day.shifts) {
      const emp = employees.find((e) => e.id === shift.employeeId) || store.getEmployee(shift.employeeId);
      const row = document.createElement("div");
      row.className = "shift-row";

      // Auswahl = aktive Mitarbeiter + (falls diese Schicht einer inzwischen deaktivierten Person gehört) diese Person zusätzlich,
      // damit alte Tage weiterhin korrekt anzeigen, wer gearbeitet hat.
      const selectOptions = employees.some((e) => e.id === shift.employeeId) || !emp ? employees : [...employees, emp];
      const select = document.createElement("select");
      select.disabled = locked;
      select.innerHTML = selectOptions
        .map((e) => `<option value="${e.id}" ${e.id === shift.employeeId ? "selected" : ""}>${escapeHtml(e.name)}${e.active === false ? " (inaktiv)" : ""} (${ROLE_LABEL[e.role]})</option>`)
        .join("");
      select.onchange = () => {
        store.updateShift(day.id, shift.id, { employeeId: select.value });
        rerender();
      };

      const fromInput = document.createElement("input");
      fromInput.type = "time";
      fromInput.value = shift.from || "";
      fromInput.disabled = locked;
      fromInput.onchange = () => {
        store.updateShift(day.id, shift.id, { from: fromInput.value });
        rerender();
      };

      const toInput = document.createElement("input");
      toInput.type = "time";
      toInput.value = shift.to || "";
      toInput.disabled = locked;
      toInput.onchange = () => {
        store.updateShift(day.id, shift.id, { to: toInput.value });
        rerender();
      };

      const h = shift.from && shift.to ? hours(computeHours(shift.from, shift.to, settings.roundingMinutes)) : "–";

      row.appendChild(select);
      const fromLabel = document.createElement("label");
      fromLabel.className = "inline-label";
      fromLabel.append("von ", fromInput);
      row.appendChild(fromLabel);
      if (shift.source === "pin" && !shift.clockOutAt) {
        const liveBadge = document.createElement("span");
        liveBadge.className = "badge badge-green";
        liveBadge.textContent = "🟢 läuft";
        row.appendChild(liveBadge);
      } else {
        const toLabel = document.createElement("label");
        toLabel.className = "inline-label";
        toLabel.append("bis ", toInput);
        row.appendChild(toLabel);
      }

      const hoursSpan = document.createElement("span");
      hoursSpan.className = "shift-hours";
      hoursSpan.textContent = h;
      row.appendChild(hoursSpan);

      if (!locked) {
        const del = document.createElement("button");
        del.className = "btn btn-icon-danger";
        del.textContent = "✕";
        del.title = "Schicht entfernen";
        del.onclick = async () => {
          if (await confirmDialog("Diese Schicht wirklich entfernen?", { danger: true, okLabel: "Entfernen" })) {
            store.removeShift(day.id, shift.id);
            rerender();
          }
        };
        row.appendChild(del);
      }

      shiftTable.appendChild(row);
    }
    shiftSection.appendChild(shiftTable);

    if (!locked && employees.length > 0) {
      const addBtn = document.createElement("button");
      addBtn.className = "btn btn-secondary";
      addBtn.textContent = "＋ Mitarbeiter hinzufügen";
      addBtn.onclick = () => {
        store.addShift(day.id, { employeeId: employees[0].id, from: "10:00", to: "18:00" });
        rerender();
      };
      shiftSection.appendChild(addBtn);
    }
    frag.appendChild(shiftSection);

    // ---- Kassenabschluss ----
    const kbSection = document.createElement("section");
    kbSection.className = "card";
    kbSection.innerHTML = `<h2>2. Kassenabschluss</h2>`;
    const kbGrid = document.createElement("div");
    kbGrid.className = "kb-grid";

    kbGrid.appendChild(numberField("Umsatz gesamt", day.kassenabschluss.umsatzGesamt, locked, (v) => {
      store.updateDay(day.id, { kassenabschluss: { ...day.kassenabschluss, umsatzGesamt: v } }, "Umsatz gesamt geändert");
      rerender();
    }));
    kbGrid.appendChild(numberField("davon Barumsatz", day.kassenabschluss.umsatzBar, locked, (v) => {
      store.updateDay(day.id, { kassenabschluss: { ...day.kassenabschluss, umsatzBar: v } }, "Barumsatz geändert");
      rerender();
    }));
    kbGrid.appendChild(numberField("davon 7% USt.", day.kassenabschluss.umsatz7, locked, (v) => {
      store.updateDay(day.id, { kassenabschluss: { ...day.kassenabschluss, umsatz7: v } }, "Umsatz 7% geändert");
      rerender();
    }));
    kbGrid.appendChild(numberField("davon 19% USt.", day.kassenabschluss.umsatz19, locked, (v) => {
      store.updateDay(day.id, { kassenabschluss: { ...day.kassenabschluss, umsatz19: v } }, "Umsatz 19% geändert");
      rerender();
    }));
    kbGrid.appendChild(numberField("davon Trinkgeld (Karte)", day.kassenabschluss.trinkgeldKarte, locked, (v) => {
      store.updateDay(day.id, { kassenabschluss: { ...day.kassenabschluss, trinkgeldKarte: v } }, "Trinkgeld Karte geändert");
      rerender();
    }));
    kbGrid.appendChild(numberField("davon Trinkgeld (Bar, optional)", day.kassenabschluss.trinkgeldBar, locked, (v) => {
      store.updateDay(day.id, { kassenabschluss: { ...day.kassenabschluss, trinkgeldBar: v } }, "Trinkgeld Bar geändert");
      rerender();
    }));
    kbSection.appendChild(kbGrid);
    const vatInfo = document.createElement("p");
    vatInfo.className = "muted small";
    vatInfo.textContent = `Enthaltene Umsatzsteuer: 7 % → ${euro(breakdown.ust7)} · 19 % → ${euro(breakdown.ust19)}`;
    kbSection.appendChild(vatInfo);
    if (Math.abs(breakdown.umsatzSplitDiff) >= 0.05) {
      const vatWarn = document.createElement("div");
      vatWarn.className = "callout callout-warn";
      vatWarn.textContent = `Hinweis: 7 % + 19 % Umsatz ergibt ${euro((Number(day.kassenabschluss.umsatz7) || 0) + (Number(day.kassenabschluss.umsatz19) || 0))}, das sind ${euro(breakdown.umsatzSplitDiff)} weniger/mehr als der Gesamtumsatz. Bitte vom Kassenbon prüfen.`;
      kbSection.appendChild(vatWarn);
    }
    frag.appendChild(kbSection);

    // ---- Stornos ----
    const stornoSection = document.createElement("section");
    stornoSection.className = "card";
    stornoSection.innerHTML = `<h2>3. Stornos</h2><p class="muted small">Jede Stornierung mit Betrag und kurzer Erklärung eintragen.</p>`;
    const stornoList = document.createElement("div");
    stornoList.className = "storno-list";
    for (const s of day.stornos) {
      const row = document.createElement("div");
      row.className = "storno-row";
      row.innerHTML = `
        <span class="storno-amount">${euro(s.amount)}</span>
        <span class="storno-reason">${escapeHtml(s.reason)}</span>
        <span class="muted small">${s.cashAffected ? "betrifft Bargeld" : "nur Info (Karte)"}</span>
      `;
      if (!locked) {
        const del = document.createElement("button");
        del.className = "btn btn-icon-danger";
        del.textContent = "✕";
        del.onclick = () => {
          store.removeStorno(day.id, s.id);
          rerender();
        };
        row.appendChild(del);
      }
      stornoList.appendChild(row);
    }
    stornoSection.appendChild(stornoList);

    if (!locked) {
      const addStornoBtn = document.createElement("button");
      addStornoBtn.className = "btn btn-secondary";
      addStornoBtn.textContent = "＋ Storno erfassen";
      addStornoBtn.onclick = () => openStornoDialog(day.id, rerender);
      stornoSection.appendChild(addStornoBtn);
    }
    frag.appendChild(stornoSection);

    // ---- Berechnung ----
    const calcSection = document.createElement("section");
    calcSection.className = "card card-highlight";
    calcSection.innerHTML = `<h2>4. Automatische Berechnung</h2>`;

    const table = document.createElement("table");
    table.className = "calc-table";
    table.innerHTML = `
      <thead><tr><th>Mitarbeiter</th><th>Rolle</th><th>Kommen–Gehen</th><th>Pause</th><th>Stunden</th><th>Punkte</th><th>Lohn</th><th>Trinkgeld</th><th>Bar-Auszahlung</th></tr></thead>
    `;
    const tbody = document.createElement("tbody");
    for (const row of breakdown.perEmployee) {
      const empShifts = day.shifts.filter((s) => s.employeeId === row.employee.id);
      const timeRange = empShifts.map((s) => `${s.from}–${s.to}`).join(", ");
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${escapeHtml(row.employee.name)}</td>
        <td>${ROLE_LABEL[row.employee.role]}</td>
        <td class="muted small">${escapeHtml(timeRange)}</td>
        <td class="muted small">${row.breakMinutes > 0 ? `−${row.breakMinutes} Min` : "–"}</td>
        <td>${hours(row.hours)}</td>
        <td class="muted">${row.points}${breakdown.totalPoints > 0 ? ` (${Math.round((row.points / breakdown.totalPoints) * 1000) / 10}%)` : ""}</td>
        <td>${euro(row.lohn)}</td>
        <td>${euro(row.tip)}</td>
        <td><b>${euro(row.cashPayout)}</b></td>
      `;
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    calcSection.appendChild(table);

    const breakNote = document.createElement("p");
    breakNote.className = "muted small";
    breakNote.textContent = "Pause wird automatisch abgezogen: über 6 Std. Arbeit −30 Min, über 9 Std. −45 Min (§4 Arbeitszeitgesetz) – \"Stunden\" ist bereits die bezahlte Zeit danach.";
    calcSection.appendChild(breakNote);

    const summary = document.createElement("div");
    summary.className = "summary-box";
    summary.innerHTML = `
      <div class="summary-line"><span>Bargeld gesamt (Barumsatz + Bar-Trinkgeld)</span><span>${euro(breakdown.bargeldGesamt)}</span></div>
      <div class="summary-line"><span>− Auszahlung an Personal (bar)</span><span>${euro(breakdown.totalCashToStaff)}</span></div>
      <div class="summary-line"><span>− Stornos (bargeldwirksam)</span><span>${euro(breakdown.stornoCashTotal)}</span></div>
      ${breakdown.unassignedTip > 0 ? `<div class="summary-line"><span>+ Nicht zugeteiltes Trinkgeld (niemand hat gearbeitet oder alle Rollen haben Gewicht 0)</span><span>${euro(breakdown.unassignedTip)}</span></div>` : ""}
      <div class="summary-line summary-total"><span>＝ Umschlag fürs Café</span><span>${euro(breakdown.umschlag)}</span></div>
    `;
    calcSection.appendChild(summary);
    frag.appendChild(calcSection);

    // ---- Abschluss ----
    if (!locked) {
      const closeBtn = document.createElement("button");
      closeBtn.className = "btn btn-primary btn-huge";
      closeBtn.textContent = "✔ Tag abschließen";
      closeBtn.onclick = async () => {
        if (day.shifts.length === 0) {
          await alertDialog("Bitte zuerst mindestens eine Schicht eintragen.");
          return;
        }
        if (await confirmDialog("Tag jetzt abschließen? Danach ist er gesperrt (kann bei Bedarf mit Begründung wieder geöffnet werden).", { okLabel: "Abschließen" })) {
          store.closeDay(day.id);
          rerender();
        }
      };
      frag.appendChild(closeBtn);
    }

    // ---- Verlauf ----
    const historyDetails = document.createElement("details");
    historyDetails.className = "history";
    historyDetails.innerHTML = `<summary>Änderungsverlauf (${day.auditLog.length})</summary>`;
    const historyList = document.createElement("ul");
    for (const entry of [...day.auditLog].reverse()) {
      const li = document.createElement("li");
      const time = new Date(entry.timestamp).toLocaleString("de-DE");
      li.textContent = `${time} – ${entry.action}: ${entry.detail}`;
      historyList.appendChild(li);
    }
    historyDetails.appendChild(historyList);
    frag.appendChild(historyDetails);

    // ---- Tag löschen (Admin) ----
    const deleteBtn = document.createElement("button");
    deleteBtn.className = "btn btn-link";
    deleteBtn.style.color = "var(--red)";
    deleteBtn.textContent = "🗑 Diesen Tag endgültig löschen";
    deleteBtn.onclick = async () => {
      if (!(await requireUnlock())) return;
      if (
        await confirmDialog(
          `Tag ${dateDe(day.date)} inkl. aller Arbeitszeiten und Kassenabschluss-Daten endgültig löschen? Das kann nicht rückgängig gemacht werden.`,
          { danger: true, okLabel: "Endgültig löschen" }
        )
      ) {
        store.deleteDay(day.id);
        navigate("");
      }
    };
    frag.appendChild(deleteBtn);

    return frag;
  }

  function numberField(label, value, disabled, onChange) {
    const wrap = document.createElement("label");
    wrap.className = "field";
    const span = document.createElement("span");
    span.textContent = label;
    const input = document.createElement("input");
    input.type = "number";
    input.step = "0.01";
    input.min = "0";
    input.inputMode = "decimal";
    input.value = value ?? 0;
    input.disabled = disabled;
    input.onchange = () => onChange(Number(input.value) || 0);
    wrap.appendChild(span);
    wrap.appendChild(input);
    return wrap;
  }

  function openReopenDialog(id, onDone) {
    const overlay = document.createElement("div");
    overlay.className = "overlay";
    overlay.innerHTML = `
      <div class="dialog">
        <h2>Tag wieder öffnen</h2>
        <p>Warum muss dieser abgeschlossene Tag noch einmal geändert werden? Das wird im Verlauf protokolliert.</p>
        <input type="text" id="reason-input" placeholder="z.B. Trinkgeld Karte falsch eingetragen" style="width:100%" />
        <div class="dialog-actions">
          <button class="btn btn-secondary" id="cancel-btn">Abbrechen</button>
          <button class="btn btn-primary" id="save-btn">Öffnen</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    const input = overlay.querySelector("#reason-input");
    input.focus();
    overlay.querySelector("#cancel-btn").onclick = () => overlay.remove();
    overlay.querySelector("#save-btn").onclick = () => {
      store.reopenDay(id, input.value.trim() || "kein Grund angegeben");
      overlay.remove();
      onDone();
    };
  }

  function openStornoDialog(dayId, onDone) {
    const overlay = document.createElement("div");
    overlay.className = "overlay";
    overlay.innerHTML = `
      <div class="dialog">
        <h2>Storno erfassen</h2>
        <label class="field"><span>Betrag (€)</span><input type="number" step="0.01" min="0" id="s-amount" /></label>
        <label class="field"><span>Erklärung</span><input type="text" id="s-reason" placeholder="z.B. Kunde falsch bestellt, storniert und neu gebucht" /></label>
        <label class="field-checkbox"><input type="checkbox" id="s-cash" checked /> War bargeldwirksam (mindert den Umschlag)</label>
        <div class="dialog-actions">
          <button class="btn btn-secondary" id="s-cancel">Abbrechen</button>
          <button class="btn btn-primary" id="s-save">Speichern</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    overlay.querySelector("#s-cancel").onclick = () => overlay.remove();
    overlay.querySelector("#s-save").onclick = async () => {
      const amount = Number(overlay.querySelector("#s-amount").value) || 0;
      const reason = overlay.querySelector("#s-reason").value.trim();
      const cashAffected = overlay.querySelector("#s-cash").checked;
      if (amount <= 0) {
        await alertDialog("Bitte einen Betrag größer als 0 eintragen.");
        return;
      }
      if (!reason) {
        await alertDialog("Bitte eine kurze Erklärung eintragen.");
        return;
      }
      store.addStorno(dayId, { amount, reason, cashAffected });
      overlay.remove();
      onDone();
    };
  }

  rerender();
  return container;
}

export { renderDay };
