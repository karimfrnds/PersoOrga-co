// ============================================================================
// pages/adminDays.js – Admin-Tab „Tage": Übersicht aller Tage (früher die
// öffentliche Startseite). Tage entstehen inzwischen automatisch beim ersten
// Einstempeln – hier gibt es zusätzlich die Möglichkeit, einen Tag manuell
// anzulegen (z.B. zum Nacherfassen).
// ============================================================================
import { store } from "../store.js";
import { computeDay } from "../calc.js";
import { euro, todayStr, dateDe, escapeHtml } from "../format.js";
import { promptDialog } from "../dialog.js";

function renderAdminDays(navigate) {
  const el = document.createElement("div");
  el.className = "page";

  const employees = store.getEmployees(false);

  const header = document.createElement("div");
  header.className = "start-header";
  header.innerHTML = `<h1>Tage</h1><p class="muted">Alle Tage im Überblick – tippe auf einen Tag für Details, Kassenabschluss und Aufgaben.</p>`;
  const addBtn = document.createElement("button");
  addBtn.className = "btn btn-secondary";
  addBtn.textContent = "＋ Tag manuell anlegen";
  addBtn.onclick = async () => {
    const date = await promptDialog("Für welches Datum soll ein Tag angelegt werden?", {
      title: "Tag anlegen",
      type: "date",
      defaultValue: todayStr(),
      okLabel: "Anlegen",
    });
    if (!date) return;
    const day = store.getOrCreateDayByDate(date);
    navigate(`day/${day.id}`);
  };
  header.appendChild(addBtn);
  el.appendChild(header);

  if (employees.length === 0) {
    const warn = document.createElement("div");
    warn.className = "callout callout-warn";
    warn.innerHTML = `Noch keine Mitarbeiter angelegt. Bitte zuerst unter <b>Mitarbeiter</b> das Team eintragen (Name, Rolle, Stundenlohn, PIN).`;
    el.appendChild(warn);
  }

  const days = store.getDays();
  if (days.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "Noch keine Tage erfasst. Tage entstehen automatisch, sobald sich jemand am Kiosk-Bildschirm einstempelt.";
    el.appendChild(empty);
    return el;
  }

  const list = document.createElement("div");
  list.className = "day-list";

  for (const day of days) {
    const settings = store.getSettings();
    const breakdown = computeDay(day, store.getEmployees(), settings);
    const row = document.createElement("button");
    row.className = "day-row";
    row.onclick = () => navigate(`day/${day.id}`);
    const badgeClass = day.status === "abgeschlossen" ? "badge badge-green" : "badge badge-orange";
    const badgeLabel = day.status === "abgeschlossen" ? "Abgeschlossen" : "Offen";
    const staffCount = new Set(day.shifts.map((s) => s.employeeId)).size;
    const openTasks = day.tasks.filter((t) => !t.done).length;
    row.innerHTML = `
      <div class="day-row-main">
        <div class="day-row-date">${escapeHtml(dateDe(day.date))}</div>
        <div class="muted small">${staffCount} Mitarbeiter · ${breakdown.totalHours.toFixed(2).replace(".", ",")} Std.${day.tasks.length ? ` · ${openTasks === 0 ? "✔ Aufgaben erledigt" : `${openTasks} Aufgabe(n) offen`}` : ""}</div>
      </div>
      <div class="day-row-numbers">
        <div><span class="muted small">Umsatz</span><br/>${euro(day.kassenabschluss.umsatzGesamt)}</div>
        <div><span class="muted small">Umschlag</span><br/><b>${euro(breakdown.umschlag)}</b></div>
      </div>
      <div class="${badgeClass}">${badgeLabel}</div>
    `;
    list.appendChild(row);
  }
  el.appendChild(list);

  return el;
}

export { renderAdminDays };
