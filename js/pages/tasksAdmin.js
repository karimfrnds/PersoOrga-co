// ============================================================================
// pages/tasksAdmin.js – Admin-Tab „Aufgaben": Vorlagen für die tägliche
// Aufgabenliste, die Mitarbeiter beim Einstempeln sehen und abhaken.
// ============================================================================
import { store } from "../store.js";

function renderTasksAdmin() {
  const container = document.createElement("div");
  container.className = "page";

  function build() {
    const frag = document.createElement("div");
    frag.innerHTML = `
      <h1>Aufgaben</h1>
      <p class="muted">Ein Punkt pro Zeile. Diese Liste wird jedem neuen Tag automatisch mitgegeben – Mitarbeiter sehen und
      haken sie direkt nach dem Einstempeln ab, unabhängig davon, welche Schicht sie haben.</p>
    `;

    const card = document.createElement("section");
    card.className = "card";
    card.innerHTML = `<h2>Tägliche Aufgaben-Vorlage</h2>`;

    const textarea = document.createElement("textarea");
    textarea.rows = 10;
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

    const note = document.createElement("p");
    note.className = "muted small";
    note.textContent = "Änderungen hier wirken sich nur auf neue Tage aus – bereits angelegte (auch der heutige) behalten ihre eigene Aufgabenliste, die aber jederzeit direkt in der Tagesansicht ergänzt werden kann.";
    card.appendChild(note);

    frag.appendChild(card);
    return frag;
  }

  container.appendChild(build());
  return container;
}

export { renderTasksAdmin };
