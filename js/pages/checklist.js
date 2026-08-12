// ============================================================================
// pages/checklist.js – BETA: Schicht-Checkliste + Übergabe-Notizen für den Tag.
// Bewusst ohne PIN erreichbar (soll morgens schnell von jedem genutzt werden können).
// ============================================================================
import { store } from "../store.js";
import { todayStr, dateDe, escapeHtml } from "../format.js";

const SHIFT_LABEL = { fruh: "Früh", mittel: "Mittel", spaet: "Spät" };
const SHIFT_KEYS = ["fruh", "mittel", "spaet"];

function renderChecklist(navigate) {
  const container = document.createElement("div");
  container.className = "page";

  let date = todayStr();
  let shift = "fruh";

  function rerender() {
    container.innerHTML = "";
    container.appendChild(build());
  }

  function build() {
    const frag = document.createElement("div");
    frag.innerHTML = `
      <button class="btn btn-link" id="back-btn">← Zurück zur Übersicht</button>
      <h1>📋 Checkliste <span class="badge badge-orange">Beta</span></h1>
      <p class="muted">Testfunktion – noch nicht Teil des festen Ablaufs. Vorlagen richtet der Admin unter Admin → 🧪 Beta ein.</p>
    `;
    frag.querySelector("#back-btn").onclick = () => navigate("");

    const controlRow = document.createElement("div");
    controlRow.className = "kb-grid";
    const dateField = document.createElement("label");
    dateField.className = "field";
    dateField.innerHTML = `<span>Datum</span>`;
    const dateInput = document.createElement("input");
    dateInput.type = "date";
    dateInput.value = date;
    dateInput.onchange = () => {
      date = dateInput.value;
      rerender();
    };
    dateField.appendChild(dateInput);

    const shiftField = document.createElement("label");
    shiftField.className = "field";
    shiftField.innerHTML = `<span>Schicht</span>`;
    const shiftSelect = document.createElement("select");
    for (const key of SHIFT_KEYS) {
      const opt = document.createElement("option");
      opt.value = key;
      opt.textContent = SHIFT_LABEL[key];
      if (key === shift) opt.selected = true;
      shiftSelect.appendChild(opt);
    }
    shiftSelect.onchange = () => {
      shift = shiftSelect.value;
      rerender();
    };
    shiftField.appendChild(shiftSelect);

    controlRow.appendChild(dateField);
    controlRow.appendChild(shiftField);
    frag.appendChild(controlRow);

    // Checkliste für die gewählte Schicht
    const templates = store.getChecklistTemplates();
    const items = templates[shift] || [];
    const log = store.getDayChecklist(date);

    const checklistCard = document.createElement("section");
    checklistCard.className = "card";
    checklistCard.innerHTML = `<h2>Checkliste ${SHIFT_LABEL[shift]}schicht – ${escapeHtml(dateDe(date))}</h2>`;

    if (items.length === 0) {
      const empty = document.createElement("p");
      empty.className = "muted";
      empty.textContent = "Noch keine Checkliste für diese Schicht hinterlegt.";
      checklistCard.appendChild(empty);
    } else {
      const list = document.createElement("div");
      list.className = "shift-table";
      for (const item of items) {
        const checked = !!log.checked[shift]?.[item];
        const row = document.createElement("label");
        row.className = "field-checkbox";
        row.style.padding = "8px";
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = checked;
        cb.onchange = () => {
          store.toggleChecklistItem(date, shift, item);
          rerender();
        };
        row.appendChild(cb);
        const span = document.createElement("span");
        span.style.textDecoration = checked ? "line-through" : "none";
        span.style.color = checked ? "var(--gray)" : "inherit";
        span.textContent = item;
        row.appendChild(span);
        list.appendChild(row);
      }
      checklistCard.appendChild(list);
    }
    frag.appendChild(checklistCard);

    // Übergabe-Notizen (gelten für den ganzen Tag, schichtübergreifend)
    const notesCard = document.createElement("section");
    notesCard.className = "card";
    notesCard.innerHTML = `<h2>Notizen für die nächste Schicht</h2><p class="muted small">Gilt für den ganzen Tag ${escapeHtml(dateDe(date))} – z.B. "Milch bestellen" oder "Kaffeemaschine spinnt".</p>`;
    const notesList = document.createElement("div");
    notesList.className = "storno-list";
    for (const note of log.notes) {
      const row = document.createElement("div");
      row.className = "storno-row";
      const time = new Date(note.time).toLocaleString("de-DE", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" });
      row.innerHTML = `<span class="muted small">${time}</span>`;
      const textSpan = document.createElement("span");
      textSpan.className = "storno-reason";
      textSpan.style.textDecoration = note.done ? "line-through" : "none";
      textSpan.style.color = note.done ? "var(--gray)" : "inherit";
      textSpan.textContent = note.text;
      row.appendChild(textSpan);
      const doneBtn = document.createElement("button");
      doneBtn.className = "btn btn-secondary";
      doneBtn.textContent = note.done ? "Wieder offen" : "Erledigt";
      doneBtn.onclick = () => {
        store.toggleChecklistNoteDone(date, note.id);
        rerender();
      };
      row.appendChild(doneBtn);
      const delBtn = document.createElement("button");
      delBtn.className = "btn btn-icon-danger";
      delBtn.textContent = "✕";
      delBtn.onclick = () => {
        store.removeChecklistNote(date, note.id);
        rerender();
      };
      row.appendChild(delBtn);
      notesList.appendChild(row);
    }
    notesCard.appendChild(notesList);

    const addRow = document.createElement("div");
    addRow.style.display = "flex";
    addRow.style.gap = "8px";
    addRow.style.marginTop = "10px";
    const noteInput = document.createElement("input");
    noteInput.type = "text";
    noteInput.placeholder = "Neue Notiz…";
    noteInput.style.flex = "1";
    const addBtn = document.createElement("button");
    addBtn.className = "btn btn-primary";
    addBtn.textContent = "＋ Hinzufügen";
    const addNote = () => {
      const text = noteInput.value.trim();
      if (!text) return;
      store.addChecklistNote(date, text);
      rerender();
    };
    addBtn.onclick = addNote;
    noteInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") addNote();
    });
    addRow.appendChild(noteInput);
    addRow.appendChild(addBtn);
    notesCard.appendChild(addRow);
    frag.appendChild(notesCard);

    return frag;
  }

  rerender();
  return container;
}

export { renderChecklist, SHIFT_LABEL, SHIFT_KEYS };
