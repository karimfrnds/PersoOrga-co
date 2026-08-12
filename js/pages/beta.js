// ============================================================================
// pages/beta.js – BETA-Testbereich für Admin: Wochenplan-Upload, Checklisten-Vorlagen.
// Bewusst getrennt von den Kernfunktionen (Tageserfassung), damit die App für den
// täglichen Betrieb einfach bleibt, während neue Ideen hier ausprobiert werden können.
// ============================================================================
import { store } from "../store.js";
import { requireUnlock } from "../adminAuth.js";
import { alertDialog, confirmDialog } from "../dialog.js";
import { escapeHtml, dateDe, todayStr } from "../format.js";
import { SHIFT_LABEL, SHIFT_KEYS } from "./checklist.js";

const WEEKDAY_NAMES = {
  montag: 0, mo: 0,
  dienstag: 1, di: 1,
  mittwoch: 2, mi: 2,
  donnerstag: 3, do: 3,
  freitag: 4, fr: 4,
  samstag: 5, sa: 5,
  sonntag: 6, so: 6,
};

function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
}

function mondayOf(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const day = dt.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day;
  dt.setUTCDate(dt.getUTCDate() + diff);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
}

function renderBeta(navigate) {
  const container = document.createElement("div");
  container.className = "page";

  let parsedRows = null; // Vorschau nach CSV-Einlesen
  let weekStart = mondayOf(todayStr()); // Montag der Zielwoche für den Wochenplan-Upload

  function rerender() {
    container.innerHTML = "";
    container.appendChild(build());
  }

  function build() {
    const frag = document.createElement("div");
    frag.innerHTML = `
      <h1>🧪 Beta – Testfunktionen</h1>
      <p class="muted">Ideen zum Ausprobieren, bevor sie (falls sinnvoll) fest in die App kommen. Wirkt sich nicht auf den normalen Tagesablauf aus, außer ihr nutzt es aktiv.</p>
    `;
    frag.appendChild(buildScheduleUpload());
    frag.appendChild(buildChecklistAdmin());
    return frag;
  }

  // ---------------------------------------------------------------------
  // Wochenplan-Upload
  // ---------------------------------------------------------------------
  function buildScheduleUpload() {
    const card = document.createElement("section");
    card.className = "card";
    card.innerHTML = `
      <h2>Wochenplan-Upload</h2>
      <p class="muted small">
        CSV-Datei mit Spalten <b>Wochentag;Mitarbeiter;Von;Bis</b> hochladen (aus Excel/Numbers als CSV exportieren) –
        derselbe Plan lässt sich so für jede Woche wiederverwenden. Zuerst unten festlegen, für welche Woche er gelten soll,
        dann die Datei hochladen. Für jede Zeile wird die Schicht automatisch in die passende Tageserfassung eingetragen –
        dort könnt ihr sie danach ganz normal noch anpassen.
      </p>
    `;

    const weekField = document.createElement("label");
    weekField.className = "field";
    weekField.innerHTML = `<span>Woche beginnt am (Montag)</span>`;
    const weekInput = document.createElement("input");
    weekInput.type = "date";
    weekInput.value = weekStart;
    weekInput.onchange = () => {
      weekStart = weekInput.value;
      if (parsedRows) parsedRows = reresolveRows(parsedRows);
      rerender();
    };
    weekField.appendChild(weekInput);
    card.appendChild(weekField);

    const weekInfo = document.createElement("p");
    weekInfo.className = "muted small";
    weekInfo.textContent = `Zielwoche: ${dateDe(weekStart)} bis ${dateDe(addDays(weekStart, 6))}`;
    card.appendChild(weekInfo);

    const templateBtn = document.createElement("button");
    templateBtn.className = "btn btn-secondary";
    templateBtn.textContent = "⬇ Vorlage herunterladen (CSV)";
    templateBtn.onclick = downloadTemplate;
    card.appendChild(templateBtn);

    const fileLabel = document.createElement("label");
    fileLabel.className = "btn btn-secondary";
    fileLabel.textContent = "⬆ CSV auswählen";
    fileLabel.style.marginLeft = "10px";
    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = ".csv,text/csv";
    fileInput.style.display = "none";
    fileInput.onchange = async () => {
      const file = fileInput.files[0];
      if (!file) return;
      const text = await file.text();
      try {
        parsedRows = parseScheduleCsv(text);
      } catch (e) {
        await alertDialog("Datei konnte nicht gelesen werden: " + e.message);
        return;
      }
      rerender();
    };
    fileLabel.appendChild(fileInput);
    card.appendChild(fileLabel);

    if (parsedRows) {
      card.appendChild(buildPreview());
    }

    return card;
  }

  function downloadTemplate() {
    const csv = "Wochentag;Mitarbeiter;Von;Bis\r\nMontag;Anna;10:00;18:00\r\nDienstag;Timm;09:00;17:00\r\n";
    const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "wochenplan-vorlage.csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  function resolveDate(raw) {
    const explicit = parseExplicitDate(raw);
    if (explicit) return explicit;
    const offset = parseWeekday(raw);
    if (offset !== null) return addDays(weekStart, offset);
    return null;
  }

  function reresolveRows(rows) {
    return rows.map((r) => ({ ...r, date: resolveDate(r.dateRaw) }));
  }

  function parseScheduleCsv(text) {
    const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
    if (lines.length === 0) throw new Error("Datei ist leer.");
    const delimiter = (lines[0].match(/;/g) || []).length >= (lines[0].match(/,/g) || []).length ? ";" : ",";
    const employees = store.getEmployees(false);

    const rows = [];
    for (const line of lines) {
      const cols = line.split(delimiter).map((c) => c.trim().replace(/^"|"$/g, ""));
      const [rawDay, rawName, rawFrom, rawTo] = cols;
      const date = resolveDate(rawDay);
      const from = normalizeTime(rawFrom);
      const to = normalizeTime(rawTo);
      // Kopfzeile oder Zeilen ohne erkennbaren Wochentag/Datum überspringen
      if (!date) continue;
      rows.push({
        dateRaw: rawDay || "",
        date,
        name: rawName || "",
        employeeId: (employees.find((e) => e.name.trim().toLowerCase() === (rawName || "").trim().toLowerCase()) || {}).id || "",
        from: from || "",
        to: to || "",
      });
    }
    if (rows.length === 0) throw new Error("Keine gültigen Zeilen gefunden. Format: Wochentag;Mitarbeiter;Von;Bis");
    return rows;
  }

  function parseWeekday(raw) {
    if (!raw) return null;
    const key = raw.trim().toLowerCase().replace(/\.$/, "");
    return key in WEEKDAY_NAMES ? WEEKDAY_NAMES[key] : null;
  }

  function parseExplicitDate(raw) {
    if (!raw) return null;
    let m = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/); // YYYY-MM-DD
    if (m) return raw;
    m = raw.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/); // DD.MM.YYYY
    if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
    return null;
  }

  function normalizeTime(raw) {
    if (!raw) return null;
    const m = raw.match(/^(\d{1,2})[:.](\d{2})$/);
    if (!m) return null;
    return `${m[1].padStart(2, "0")}:${m[2]}`;
  }

  function buildPreview() {
    const wrap = document.createElement("div");
    const employees = store.getEmployees(false);
    const table = document.createElement("table");
    table.className = "calc-table";
    table.innerHTML = `<thead><tr><th>Wochentag</th><th>Datum</th><th>Mitarbeiter</th><th>Von</th><th>Bis</th><th></th></tr></thead>`;
    const tbody = document.createElement("tbody");
    for (const row of parsedRows) {
      const tr = document.createElement("tr");
      const dayCell = document.createElement("td");
      dayCell.textContent = row.dateRaw;
      tr.appendChild(dayCell);

      const dateCell = document.createElement("td");
      dateCell.textContent = row.date ? dateDe(row.date) : `⚠ unlesbar`;
      tr.appendChild(dateCell);

      const nameCell = document.createElement("td");
      if (row.employeeId) {
        nameCell.textContent = row.name;
      } else {
        const select = document.createElement("select");
        select.innerHTML =
          `<option value="">– „${escapeHtml(row.name)}" überspringen –</option>` +
          employees.map((e) => `<option value="${e.id}">${escapeHtml(e.name)}</option>`).join("");
        select.onchange = () => {
          row.employeeId = select.value;
        };
        nameCell.appendChild(select);
      }
      tr.appendChild(nameCell);

      const fromCell = document.createElement("td");
      fromCell.textContent = row.from || "⚠";
      tr.appendChild(fromCell);
      const toCell = document.createElement("td");
      toCell.textContent = row.to || "⚠";
      tr.appendChild(toCell);

      const statusCell = document.createElement("td");
      statusCell.className = "muted small";
      statusCell.textContent = row.date && row.from && row.to ? (row.employeeId ? "✔ bereit" : "wird übersprungen") : "wird übersprungen";
      tr.appendChild(statusCell);

      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    wrap.appendChild(table);

    const applyBtn = document.createElement("button");
    applyBtn.className = "btn btn-primary btn-huge";
    applyBtn.textContent = "In Tageserfassung übernehmen";
    applyBtn.onclick = applySchedule;
    wrap.appendChild(applyBtn);

    const cancelBtn = document.createElement("button");
    cancelBtn.className = "btn btn-link";
    cancelBtn.textContent = "Verwerfen";
    cancelBtn.onclick = () => {
      parsedRows = null;
      rerender();
    };
    wrap.appendChild(cancelBtn);

    return wrap;
  }

  async function applySchedule() {
    const usable = parsedRows.filter((r) => r.date && r.from && r.to && r.employeeId);
    if (usable.length === 0) {
      await alertDialog("Keine übernehmbaren Zeilen (Mitarbeiter zuordnen oder Format prüfen).");
      return;
    }
    if (!(await confirmDialog(`${usable.length} Schicht(en) für die Woche ${dateDe(weekStart)} – ${dateDe(addDays(weekStart, 6))} in die jeweilige Tageserfassung eintragen?`, { okLabel: "Übernehmen" }))) {
      return;
    }
    let created = 0;
    for (const row of usable) {
      let day = store.getDayByDate(row.date);
      if (!day) {
        day = store.createDay(row.date);
      } else if (day.status === "abgeschlossen") {
        if (!(await requireUnlock())) continue;
        store.reopenDay(day.id, "Wochenplan-Upload");
      }
      store.addShift(day.id, { employeeId: row.employeeId, from: row.from, to: row.to });
      created++;
    }
    parsedRows = null;
    rerender();
    await alertDialog(`${created} Schicht(en) übernommen. Die Tage findet ihr wie gewohnt in der Übersicht.`);
  }

  // ---------------------------------------------------------------------
  // Checklisten-Vorlagen
  // ---------------------------------------------------------------------
  function buildChecklistAdmin() {
    const card = document.createElement("section");
    card.className = "card";
    card.innerHTML = `
      <h2>Checklisten-Vorlagen</h2>
      <p class="muted small">
        Ein Punkt pro Zeile. Mitarbeiter sehen und haken diese Liste unter „📋 Checkliste" auf der Startseite ab
        (kein PIN nötig, damit es morgens schnell geht).
      </p>
    `;
    const templates = store.getChecklistTemplates();
    for (const key of SHIFT_KEYS) {
      const field = document.createElement("label");
      field.className = "field";
      field.style.marginBottom = "12px";
      field.innerHTML = `<span>${SHIFT_LABEL[key]}schicht</span>`;
      const textarea = document.createElement("textarea");
      textarea.rows = 4;
      textarea.style.fontFamily = "inherit";
      textarea.style.fontSize = "15px";
      textarea.style.padding = "10px 12px";
      textarea.style.borderRadius = "10px";
      textarea.style.border = "1px solid var(--border)";
      textarea.value = (templates[key] || []).join("\n");
      textarea.onchange = () => {
        const items = textarea.value.split("\n").map((s) => s.trim()).filter(Boolean);
        store.setChecklistTemplate(key, items);
      };
      field.appendChild(textarea);
      card.appendChild(field);
    }
    return card;
  }

  rerender();
  return container;
}

export { renderBeta };
