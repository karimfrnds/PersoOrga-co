// ============================================================================
// chef/planning.js – Schichtplanung am Laptop: Wochentabelle Mitarbeiter × Tage.
// Eine Zelle anklicken öffnet die Entscheidung (bestätigen/ablehnen).
// ============================================================================
import { escapeHtml, dateDe } from "../format.js";
import { decideShift } from "./api.js";

const WEEKDAY_SHORT = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];

function mondayOf(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const day = dt.getUTCDay();
  dt.setUTCDate(dt.getUTCDate() + (day === 0 ? -6 : 1 - day));
  return dt.toISOString().slice(0, 10);
}
function addDaysISO(dateStr, n) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}
function dateDeShort(dateStr) {
  const [, m, d] = dateStr.split("-");
  return `${d}.${m}.`;
}

/** Zieht die Verfügbarkeits-Einträge einer Person für einen Tag aus dem Worker-Stand. */
function dayEntryFor(state, name, weekStart, date) {
  const needle = name.trim().toLowerCase();
  for (const [ws, bucket] of Object.entries(state.availability || {})) {
    if (ws !== weekStart) continue;
    const key = Object.keys(bucket?.entries || {}).find((n) => n.trim().toLowerCase() === needle);
    if (!key) continue;
    return (bucket.entries[key].days || []).find((d) => d.date === date) || null;
  }
  return null;
}

function isSick(state, name, date) {
  const needle = name.trim().toLowerCase();
  return (state.sickReports || []).some(
    (r) => String(r.employeeName || "").trim().toLowerCase() === needle && r.from <= date && (r.to || r.from) >= date
  );
}

function renderPlanning(state, { onChanged, today }) {
  const el = document.createElement("div");
  // Standard ist die kommende Woche – das ist die, für die geplant wird.
  let weekStart = addDaysISO(mondayOf(today), 7);

  function rerender() {
    el.innerHTML = "";
    el.appendChild(build());
  }

  function build() {
    const frag = document.createElement("div");
    frag.innerHTML = `
      <h1>📅 Schichtplanung</h1>
      <p class="muted">Wer arbeitet wann, wer könnte noch, wer wartet auf deine Entscheidung. Zelle anklicken zum Entscheiden.</p>
    `;

    const nav = document.createElement("div");
    nav.className = "week-nav";
    const prev = document.createElement("button");
    prev.className = "btn btn-secondary";
    prev.textContent = "← Vorherige Woche";
    prev.onclick = () => {
      weekStart = addDaysISO(weekStart, -7);
      rerender();
    };
    const label = document.createElement("span");
    label.className = "week-nav-label";
    label.textContent = `${dateDe(weekStart)} – ${dateDe(addDaysISO(weekStart, 6))}`;
    const next = document.createElement("button");
    next.className = "btn btn-secondary";
    next.textContent = "Nächste Woche →";
    next.onclick = () => {
      weekStart = addDaysISO(weekStart, 7);
      rerender();
    };
    nav.append(prev, label, next);
    frag.appendChild(nav);

    const legend = document.createElement("p");
    legend.className = "muted small";
    legend.textContent = "✅ Fest bestätigt · 🔶 Wartet auf Bestätigung · 🕓 Kandidat, noch offen · 🤒 Krank · – Keine Angabe";
    frag.appendChild(legend);

    frag.appendChild(buildTable());
    return frag;
  }

  function buildTable() {
    const card = document.createElement("section");
    card.className = "card";
    const employees = [...(state.employees || [])].sort((a, b) => a.localeCompare(b));
    if (employees.length === 0) {
      card.innerHTML = `<p class="muted small">Noch keine Mitarbeiter bekannt – das iPad muss sich mindestens einmal abgeglichen haben.</p>`;
      return card;
    }

    const scroll = document.createElement("div");
    scroll.style.overflowX = "auto";
    const table = document.createElement("table");
    table.className = "plan-table";

    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    headRow.innerHTML = `<th>Mitarbeiter</th>`;
    for (let i = 0; i < 7; i++) {
      const th = document.createElement("th");
      th.innerHTML = `${WEEKDAY_SHORT[i]}<br/><span class="muted small">${dateDeShort(addDaysISO(weekStart, i))}</span>`;
      headRow.appendChild(th);
    }
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    for (const name of employees) {
      const tr = document.createElement("tr");
      const nameTd = document.createElement("td");
      nameTd.innerHTML = `<b>${escapeHtml(name)}</b>`;
      tr.appendChild(nameTd);

      for (let i = 0; i < 7; i++) {
        const date = addDaysISO(weekStart, i);
        const td = document.createElement("td");
        const entry = dayEntryFor(state, name, weekStart, date);

        if (isSick(state, name, date)) {
          td.innerHTML = `<span class="plan-cell plan-cell-sick">🤒 Krank</span>`;
        } else if (!entry || (entry.slots || []).length === 0) {
          td.innerHTML = `<span class="muted">–</span>`;
        } else {
          const confirmed = (entry.slots || []).find((s) => s.id === entry.confirmedSlotId);
          if (confirmed && entry.bossConfirmed) {
            td.innerHTML = `<span class="plan-cell plan-cell-confirmed">✅ ${escapeHtml(confirmed.label)}</span>`;
          } else if (confirmed) {
            td.innerHTML = `<span class="plan-cell plan-cell-pending">🔶 ${escapeHtml(confirmed.label)}</span>`;
          } else {
            const labels = entry.slots.map((s) => s.label).join(", ");
            td.innerHTML = `<span class="plan-cell plan-cell-pending">🕓 ${escapeHtml(labels)}</span>`;
          }
          td.style.cursor = "pointer";
          td.onclick = () => openDecide(name, date, entry);
        }
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    scroll.appendChild(table);
    card.appendChild(scroll);
    return card;
  }

  function openDecide(name, date, entry) {
    const overlay = document.createElement("div");
    overlay.className = "overlay";
    const rows = (entry.slots || [])
      .map((s) => {
        const fest = entry.confirmedSlotId === s.id && entry.bossConfirmed;
        return `
          <div class="plan-decide-row">
            <span>${fest ? "✅" : "🔶"} <b>${escapeHtml(s.label)}</b> (${escapeHtml(s.from)}–${escapeHtml(s.to)} Uhr)</span>
            <div class="employee-actions">
              ${fest ? "" : `<button class="btn btn-primary" data-confirm="${escapeHtml(s.label)}">Bestätigen</button>`}
              <button class="btn btn-icon-danger" data-reject="${escapeHtml(s.label)}" title="Ablehnen">✕</button>
            </div>
          </div>`;
      })
      .join("");
    overlay.innerHTML = `
      <div class="dialog">
        <h2>${escapeHtml(name)} – ${escapeHtml(dateDe(date))}</h2>
        <div class="plan-decide-list">${rows}</div>
        <p class="muted small" id="cd-status"></p>
        <div class="dialog-actions"><button class="btn btn-secondary" id="cd-close">Schließen</button></div>
      </div>`;
    document.body.appendChild(overlay);
    const status = overlay.querySelector("#cd-status");
    overlay.querySelector("#cd-close").onclick = () => overlay.remove();

    const send = async (slotLabel, decision) => {
      overlay.querySelectorAll("button").forEach((b) => (b.disabled = true));
      status.textContent = "Wird gespeichert…";
      try {
        await decideShift(name, date, slotLabel, decision);
        overlay.remove();
        await onChanged();
      } catch (e) {
        status.textContent = "⚠ " + e.message;
        overlay.querySelectorAll("button").forEach((b) => (b.disabled = false));
      }
    };
    overlay.querySelectorAll("[data-confirm]").forEach((b) => (b.onclick = () => send(b.dataset.confirm, "confirm")));
    overlay.querySelectorAll("[data-reject]").forEach((b) => (b.onclick = () => send(b.dataset.reject, "reject")));
  }

  rerender();
  return el;
}

export { renderPlanning };
