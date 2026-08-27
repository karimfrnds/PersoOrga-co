// ============================================================================
// pages/shiftPlanningAdmin.js – Admin-Tab „Schichtplanung": Tabellen-Übersicht,
// wer in der gewählten Woche wann arbeitet, arbeiten könnte oder noch auf eine
// Entscheidung wartet. Ersetzt das Wühlen durch einzelne Tage – eine Zelle
// anklicken genügt, um eine Schicht zu bestätigen oder abzulehnen.
// ============================================================================
import { store } from "../store.js";
import { dateDe, escapeHtml } from "../format.js";

const WEEKDAY_SHORT = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];

function mondayOf(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const day = dt.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day;
  dt.setUTCDate(dt.getUTCDate() + diff);
  return dt.toISOString().slice(0, 10);
}
function addDaysISO(dateStr, n) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}
function dateDeShort(dateStr) {
  const [y, m, d] = dateStr.split("-");
  return `${d}.${m}.`;
}
function todayStrLocal() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function renderShiftPlanningAdmin() {
  const container = document.createElement("div");
  container.className = "page";

  // Überlebt Rerenders: gewählte Woche (Montag als Anker).
  let weekStart = mondayOf(todayStrLocal());

  function rerender() {
    container.innerHTML = "";
    container.appendChild(build());
  }

  function build() {
    const frag = document.createElement("div");
    const weekEnd = addDaysISO(weekStart, 6);
    frag.innerHTML = `
      <h1>📅 Schichtplanung</h1>
      <p class="muted">Wer arbeitet wann, wer könnte noch, wer wartet auf eine Entscheidung – eine Zelle antippen, um zu entscheiden.</p>
    `;

    const nav = document.createElement("div");
    nav.className = "week-nav";
    const prevBtn = document.createElement("button");
    prevBtn.className = "btn btn-secondary";
    prevBtn.textContent = "← Vorherige Woche";
    prevBtn.onclick = () => {
      weekStart = addDaysISO(weekStart, -7);
      rerender();
    };
    const label = document.createElement("span");
    label.className = "week-nav-label";
    label.textContent = `${dateDe(weekStart)} – ${dateDe(weekEnd)}`;
    const nextBtn = document.createElement("button");
    nextBtn.className = "btn btn-secondary";
    nextBtn.textContent = "Nächste Woche →";
    nextBtn.onclick = () => {
      weekStart = addDaysISO(weekStart, 7);
      rerender();
    };
    nav.appendChild(prevBtn);
    nav.appendChild(label);
    nav.appendChild(nextBtn);
    frag.appendChild(nav);

    const legend = document.createElement("p");
    legend.className = "muted small";
    legend.innerHTML = `✅ Fest bestätigt &nbsp; 🔶 Wartet auf Entscheidung &nbsp; – Keine Angabe`;
    frag.appendChild(legend);

    frag.appendChild(buildTable());
    return frag;
  }

  function buildTable() {
    const card = document.createElement("section");
    card.className = "card";
    const employees = store.getEmployees(false);
    if (employees.length === 0) {
      const empty = document.createElement("p");
      empty.className = "muted small";
      empty.textContent = "Noch keine Mitarbeiter angelegt.";
      card.appendChild(empty);
      return card;
    }

    const wrap = document.createElement("div");
    wrap.style.overflowX = "auto";
    const table = document.createElement("table");
    table.className = "plan-table";

    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    headRow.innerHTML = `<th>Mitarbeiter</th>`;
    for (let i = 0; i < 7; i++) {
      const date = addDaysISO(weekStart, i);
      const th = document.createElement("th");
      th.innerHTML = `${WEEKDAY_SHORT[i]}<br/><span class="muted small">${dateDeShort(date)}</span>`;
      headRow.appendChild(th);
    }
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    for (const emp of [...employees].sort((a, b) => a.name.localeCompare(b.name))) {
      const tr = document.createElement("tr");
      const nameTd = document.createElement("td");
      nameTd.innerHTML = `<b>${escapeHtml(emp.name)}</b>`;
      tr.appendChild(nameTd);

      for (let i = 0; i < 7; i++) {
        const date = addDaysISO(weekStart, i);
        const td = document.createElement("td");
        const day = store.getDayByDate(date);
        const avail = day ? store.getAvailability(day.id, emp.id) : null;
        const slotDefs = store.getShiftSlotsForRole(emp.role, date);
        const slotById = new Map(slotDefs.map((s) => [s.id, s]));

        if (!avail || avail.slotIds.length === 0) {
          td.innerHTML = `<span class="muted">–</span>`;
        } else if (avail.confirmedSlotId && avail.bossConfirmed) {
          const slot = slotById.get(avail.confirmedSlotId);
          td.innerHTML = `<span class="plan-cell plan-cell-confirmed">✅ ${escapeHtml(slot?.label || avail.confirmedSlotId)}</span>`;
          td.style.cursor = "pointer";
          td.onclick = () => openDecideDialog(day.id, emp, date, avail, slotDefs);
        } else {
          const labels = avail.slotIds.map((id) => slotById.get(id)?.label).filter(Boolean).join(", ") || "?";
          td.innerHTML = `<span class="plan-cell plan-cell-pending">🔶 ${escapeHtml(labels)}</span>`;
          td.style.cursor = "pointer";
          td.onclick = () => openDecideDialog(day.id, emp, date, avail, slotDefs);
        }
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    wrap.appendChild(table);
    card.appendChild(wrap);
    return card;
  }

  function openDecideDialog(dayId, emp, date, avail, slotDefs) {
    const slotById = new Map(slotDefs.map((s) => [s.id, s]));
    const overlay = document.createElement("div");
    overlay.className = "overlay";
    const optionsHtml = avail.slotIds
      .map((id) => {
        const slot = slotById.get(id);
        if (!slot) return "";
        const isConfirmed = avail.confirmedSlotId === id && avail.bossConfirmed;
        return `
          <div class="plan-decide-row">
            <span>${isConfirmed ? "✅" : "🔶"} <b>${escapeHtml(slot.label)}</b> (${slot.from}–${slot.to} Uhr)</span>
            <div class="employee-actions">
              ${isConfirmed ? "" : `<button class="btn btn-primary" data-confirm="${id}">Bestätigen</button>`}
              <button class="btn btn-icon-danger" data-reject="${id}">✕</button>
            </div>
          </div>
        `;
      })
      .join("");
    overlay.innerHTML = `
      <div class="dialog">
        <h2>${escapeHtml(emp.name)} – ${dateDe(date)}</h2>
        <div class="plan-decide-list">${optionsHtml}</div>
        <div class="dialog-actions">
          <button class="btn btn-secondary" id="pd-close">Schließen</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    overlay.querySelector("#pd-close").onclick = () => overlay.remove();
    overlay.querySelectorAll("[data-confirm]").forEach((btn) => {
      btn.onclick = () => {
        store.confirmAvailability(dayId, emp.id, btn.dataset.confirm);
        overlay.remove();
        rerender();
      };
    });
    overlay.querySelectorAll("[data-reject]").forEach((btn) => {
      btn.onclick = () => {
        store.rejectAvailability(dayId, emp.id, btn.dataset.reject);
        overlay.remove();
        rerender();
      };
    });
  }

  rerender();
  return container;
}

export { renderShiftPlanningAdmin };
