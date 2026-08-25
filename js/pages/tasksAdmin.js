// ============================================================================
// pages/tasksAdmin.js – Admin-Tab „Aufgaben": Vorlage für jeden Tag + Übersicht
// aller zugeordneten Einzelaufgaben (manuell oder per Telegram-Bot angelegt),
// mit Mitarbeiter, Tag und Priorität – hier auch anlegen/bearbeiten möglich.
// ============================================================================
import { store } from "../store.js";
import { todayStr, dateDe, escapeHtml } from "../format.js";
import { confirmDialog, alertDialog } from "../dialog.js";

const PRIORITY_LABEL = { niedrig: "🔵 Niedrig", normal: "Normal", hoch: "🔴 Hoch" };
const PRIORITY_ORDER = { hoch: 0, normal: 1, niedrig: 2 };

function renderTasksAdmin() {
  const container = document.createElement("div");
  container.className = "page";

  function rerender() {
    container.innerHTML = "";
    container.appendChild(build());
  }

  function build() {
    const frag = document.createElement("div");
    frag.innerHTML = `<h1>Aufgaben</h1>`;
    frag.appendChild(buildTemplateCard());
    frag.appendChild(buildOverviewCard());
    return frag;
  }

  // ---------------------------------------------------------------------
  // Tägliche Aufgaben-Vorlage
  // ---------------------------------------------------------------------
  function buildTemplateCard() {
    const card = document.createElement("section");
    card.className = "card";
    card.innerHTML = `
      <h2>Tägliche Aufgaben-Vorlage</h2>
      <p class="muted small">
        Ein Punkt pro Zeile – wird jedem neuen Tag automatisch mitgegeben, unabhängig von den zugeordneten
        Einzelaufgaben unten.
      </p>
    `;
    const textarea = document.createElement("textarea");
    textarea.rows = 6;
    textarea.style.fontFamily = "inherit";
    textarea.style.fontSize = "15px";
    textarea.style.padding = "10px 12px";
    textarea.style.borderRadius = "10px";
    textarea.style.border = "1px solid var(--border)";
    textarea.placeholder = "z.B.\nKaffeemaschine reinigen\nVitrine auffüllen\nKasse zählen";
    textarea.value = store.getTaskTemplates().join("\n");
    textarea.onchange = () => {
      const items = textarea.value.split("\n").map((s) => s.trim()).filter(Boolean);
      store.setTaskTemplates(items);
    };
    card.appendChild(textarea);
    return card;
  }

  // ---------------------------------------------------------------------
  // Übersicht der zugeordneten Einzelaufgaben (heute + kommende Tage)
  // ---------------------------------------------------------------------
  function buildOverviewCard() {
    const card = document.createElement("section");
    card.className = "card";
    card.innerHTML = `
      <h2>Zugeordnete Aufgaben</h2>
      <p class="muted small">Alle Einzelaufgaben ab heute – manuell angelegt oder per Telegram-Bot eingetragen.</p>
    `;

    const addBtn = document.createElement("button");
    addBtn.className = "btn btn-primary";
    addBtn.textContent = "＋ Neue Aufgabe";
    addBtn.onclick = () => openTaskForm(null);
    card.appendChild(addBtn);

    const rows = store.getTasksFrom(todayStr()).sort((a, b) => {
      if (a.date !== b.date) return a.date < b.date ? -1 : 1;
      return (PRIORITY_ORDER[a.priority] ?? 1) - (PRIORITY_ORDER[b.priority] ?? 1);
    });

    if (rows.length === 0) {
      const empty = document.createElement("p");
      empty.className = "muted small";
      empty.textContent = "Keine Aufgaben ab heute.";
      card.appendChild(empty);
      return card;
    }

    const list = document.createElement("div");
    list.className = "task-list";
    const employees = store.getEmployees(true);
    for (const row of rows) {
      const wrap = document.createElement("div");
      wrap.className = "task-row" + (row.done ? " done" : "");
      wrap.style.cursor = "pointer";

      const textWrap = document.createElement("div");
      textWrap.className = "task-row-text";
      const header = document.createElement("span");
      const assignee = row.assignedTo ? employees.find((e) => e.id === row.assignedTo) : null;
      header.innerHTML = `<b>${escapeHtml(dateDe(row.date))}</b> · ${assignee ? escapeHtml(assignee.name) : "Alle"}${row.priority !== "normal" ? ` · ${PRIORITY_LABEL[row.priority]}` : ""}`;
      textWrap.appendChild(header);
      const textSpan = document.createElement("span");
      textSpan.textContent = row.text;
      textWrap.appendChild(textSpan);
      if (row.done) {
        const doneMeta = document.createElement("span");
        doneMeta.className = "muted small task-row-meta";
        doneMeta.textContent = `✓ erledigt${row.doneBy ? " von " + row.doneBy : ""}`;
        textWrap.appendChild(doneMeta);
      }
      wrap.appendChild(textWrap);

      const actions = document.createElement("div");
      actions.className = "employee-actions";
      const editBtn = document.createElement("button");
      editBtn.className = "btn btn-secondary";
      editBtn.textContent = "Bearbeiten";
      editBtn.onclick = (e) => {
        e.stopPropagation();
        openTaskForm(row);
      };
      actions.appendChild(editBtn);
      const delBtn = document.createElement("button");
      delBtn.className = "btn btn-icon-danger";
      delBtn.textContent = "✕";
      delBtn.onclick = async (e) => {
        e.stopPropagation();
        if (await confirmDialog(`Aufgabe „${row.text}" endgültig löschen?`, { danger: true, okLabel: "Löschen" })) {
          store.removeDayTask(row.dayId, row.id);
          rerender();
        }
      };
      actions.appendChild(delBtn);
      wrap.appendChild(actions);

      list.appendChild(wrap);
    }
    card.appendChild(list);
    return card;
  }

  function openTaskForm(existing) {
    const isEdit = !!existing;
    const employees = store.getEmployees(false);
    const overlay = document.createElement("div");
    overlay.className = "overlay";
    overlay.innerHTML = `
      <div class="dialog">
        <h2>${isEdit ? "Aufgabe bearbeiten" : "Neue Aufgabe"}</h2>
        <label class="field"><span>Aufgabe</span><input type="text" id="t-text" value="${existing ? escapeHtml(existing.text) : ""}" /></label>
        <label class="field"><span>Mitarbeiter</span>
          <select id="t-assignee">
            <option value="">– Alle –</option>
            ${employees.map((e) => `<option value="${e.id}" ${existing?.assignedTo === e.id ? "selected" : ""}>${escapeHtml(e.name)}</option>`).join("")}
          </select>
        </label>
        <label class="field"><span>Tag</span><input type="date" id="t-date" value="${existing ? existing.date : todayStr()}" /></label>
        <label class="field"><span>Priorität</span>
          <select id="t-priority">
            <option value="niedrig" ${existing?.priority === "niedrig" ? "selected" : ""}>🔵 Niedrig</option>
            <option value="normal" ${!existing || existing.priority === "normal" ? "selected" : ""}>Normal</option>
            <option value="hoch" ${existing?.priority === "hoch" ? "selected" : ""}>🔴 Hoch</option>
          </select>
        </label>
        <div class="dialog-actions">
          <button class="btn btn-secondary" id="t-cancel">Abbrechen</button>
          <button class="btn btn-primary" id="t-save">Speichern</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    overlay.querySelector("#t-cancel").onclick = () => overlay.remove();
    overlay.querySelector("#t-save").onclick = async () => {
      const text = overlay.querySelector("#t-text").value.trim();
      const assignedTo = overlay.querySelector("#t-assignee").value || null;
      const date = overlay.querySelector("#t-date").value;
      const priority = overlay.querySelector("#t-priority").value;
      if (!text) {
        await alertDialog("Bitte einen Aufgabentext eintragen.");
        return;
      }
      if (!date) {
        await alertDialog("Bitte einen Tag auswählen.");
        return;
      }
      if (isEdit) {
        store.updateTaskFields(existing.dayId, existing.id, { text, assignedTo, priority });
        if (date !== existing.date) store.moveTaskToDay(existing.dayId, existing.id, date);
      } else {
        const day = store.getOrCreateDayByDate(date);
        store.addAdminTask(day.id, { text, assignedTo, priority });
      }
      overlay.remove();
      rerender();
    };
  }

  rerender();
  return container;
}

export { renderTasksAdmin };
