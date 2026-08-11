// ============================================================================
// pages/start.js – Startseite: Liste aller Tage
// ============================================================================
import { store } from "../store.js";
import { computeDay } from "../calc.js";
import { euro, todayStr, dateDe, escapeHtml } from "../format.js";

function renderStart(navigate) {
  const el = document.createElement("div");
  el.className = "page";

  const today = todayStr();
  const existingToday = store.getDayByDate(today);
  const employees = store.getEmployees(false);

  const header = document.createElement("div");
  header.className = "start-header";
  header.innerHTML = `
    <div>
      <h1>Schichten &amp; Abrechnung</h1>
      <p class="muted">Alle vergangenen Tage im Überblick – tippe auf einen Tag für Details.</p>
    </div>
  `;
  const bigBtn = document.createElement("button");
  bigBtn.className = "btn btn-primary btn-huge";
  bigBtn.textContent = existingToday ? "▶ Heute weiter bearbeiten" : "＋ Heute erfassen";
  bigBtn.onclick = () => {
    const day = existingToday || store.createDay(today);
    navigate(`day/${day.id}`);
  };
  header.appendChild(bigBtn);
  el.appendChild(header);

  if (employees.length === 0) {
    const warn = document.createElement("div");
    warn.className = "callout callout-warn";
    warn.innerHTML = `Noch keine Mitarbeiter angelegt. Bitte zuerst unter <b>Mitarbeiter</b> das Team eintragen (Name, Rolle, Stundenlohn).`;
    el.appendChild(warn);
  }

  const days = store.getDays();
  if (days.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "Noch keine Tage erfasst. Leg mit dem Button oben den ersten Tag an.";
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
    row.innerHTML = `
      <div class="day-row-main">
        <div class="day-row-date">${escapeHtml(dateDe(day.date))}</div>
        <div class="muted small">${staffCount} Mitarbeiter · ${breakdown.totalHours.toFixed(2).replace(".", ",")} Std.</div>
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

export { renderStart };
