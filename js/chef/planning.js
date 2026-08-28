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

    const addBtn = document.createElement("button");
    addBtn.className = "btn btn-primary";
    addBtn.textContent = "＋ Person eintragen";
    addBtn.onclick = () => openAssign();
    frag.appendChild(addBtn);

    const legend = document.createElement("p");
    legend.className = "muted small";
    legend.textContent = "✅ Fest bestätigt · 🔶 Wartet auf Bestätigung · 🕓 Kandidat, noch offen · 🤒 Krank · – Keine Angabe · 📝 Info hinterlegt";
    frag.appendChild(legend);

    frag.appendChild(buildTable());
    return frag;
  }

  /** Schichten, die für die Rolle dieser Person an diesem Wochentag angeboten werden. Definitionen kommen
   * vom iPad – hier wird nichts fest verdrahtet, damit es bei Änderungen nicht auseinanderläuft. */
  function slotsFor(name, date) {
    const slots = state.shiftSlots;
    if (!slots) return [];
    const role = (state.employeeRoles || []).find((r) => String(r.name || "").trim().toLowerCase() === name.trim().toLowerCase())?.role;
    const list = (role === "kueche" ? slots.kueche : slots.service) || [];
    const [y, m, d] = date.split("-").map(Number);
    const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    const idx = wd === 0 ? 6 : wd - 1; // 0 = Montag
    return list.filter((s) => !s.allowedWeekdays || s.allowedWeekdays.includes(idx));
  }

  /** Jemanden von Hand eintragen – auch wenn die Person für den Tag gar nichts gemeldet hat. */
  function openAssign(presetName, presetDate) {
    const employees = [...(state.employees || [])].sort((a, b) => a.localeCompare(b));
    if (employees.length === 0) return;
    const overlay = document.createElement("div");
    overlay.className = "overlay";
    overlay.innerHTML = `
      <div class="dialog">
        <h2>Person eintragen</h2>
        <label class="field"><span>Mitarbeiter</span>
          <select id="as-emp">${employees.map((n) => `<option ${n === presetName ? "selected" : ""}>${escapeHtml(n)}</option>`).join("")}</select>
        </label>
        <label class="field"><span>Tag</span><input type="date" id="as-date" value="${presetDate || weekStart}" /></label>
        <label class="field"><span>Schicht</span><select id="as-slot"></select></label>
        <label class="field"><span>Info zur Schicht (optional)</span><input type="text" id="as-note" maxlength="200" placeholder="z.B. bitte Lieferung annehmen" /></label>
        <p class="muted small">Die Person bekommt die Schicht als bestätigt angezeigt – im Kiosk am iPad und in ihrer App.</p>
        <p class="muted small" id="as-status"></p>
        <div class="dialog-actions">
          <button class="btn btn-secondary" id="as-cancel">Abbrechen</button>
          <button class="btn btn-primary" id="as-save">Eintragen</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const empSel = overlay.querySelector("#as-emp");
    const dateIn = overlay.querySelector("#as-date");
    const slotSel = overlay.querySelector("#as-slot");
    const status = overlay.querySelector("#as-status");

    const refreshSlots = () => {
      const list = slotsFor(empSel.value, dateIn.value);
      slotSel.innerHTML = list.length
        ? list.map((s) => `<option value="${escapeHtml(s.label)}">${escapeHtml(s.label)} (${escapeHtml(s.from)}–${escapeHtml(s.to)})</option>`).join("")
        : `<option value="">– an diesem Tag keine Schicht für diese Rolle –</option>`;
    };
    refreshSlots();
    empSel.onchange = refreshSlots;
    dateIn.onchange = refreshSlots;

    overlay.querySelector("#as-cancel").onclick = () => overlay.remove();
    overlay.querySelector("#as-save").onclick = async () => {
      if (!slotSel.value) {
        status.textContent = "⚠ Für diese Rolle gibt es an dem Tag keine Schicht.";
        return;
      }
      overlay.querySelectorAll("button").forEach((b) => (b.disabled = true));
      status.textContent = "Wird gespeichert…";
      try {
        await decideShift(empSel.value, dateIn.value, slotSel.value, "confirm", overlay.querySelector("#as-note").value.trim());
        overlay.remove();
        await onChanged();
      } catch (e) {
        status.textContent = "⚠ " + e.message;
        overlay.querySelectorAll("button").forEach((b) => (b.disabled = false));
      }
    };
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

        const noteTag = entry?.note ? ` <span title="${escapeHtml(entry.note)}">📝</span>` : "";
        if (isSick(state, name, date)) {
          td.innerHTML = `<span class="plan-cell plan-cell-sick">🤒 Krank</span>`;
        } else if (!entry || (entry.slots || []).length === 0) {
          // Leere Zelle: direkt jemanden für diesen Tag eintragen.
          td.innerHTML = `<span class="muted">–</span>`;
          td.style.cursor = "pointer";
          td.title = "Person für diesen Tag eintragen";
          td.onclick = () => openAssign(name, date);
        } else {
          const confirmed = (entry.slots || []).find((s) => s.id === entry.confirmedSlotId);
          if (confirmed && entry.bossConfirmed) {
            td.innerHTML = `<span class="plan-cell plan-cell-confirmed">✅ ${escapeHtml(confirmed.label)}</span>${noteTag}`;
          } else if (confirmed) {
            td.innerHTML = `<span class="plan-cell plan-cell-pending">🔶 ${escapeHtml(confirmed.label)}</span>${noteTag}`;
          } else {
            const labels = entry.slots.map((s) => s.label).join(", ");
            td.innerHTML = `<span class="plan-cell plan-cell-pending">🕓 ${escapeHtml(labels)}</span>${noteTag}`;
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
        <label class="field"><span>Info zur Schicht (optional)</span>
          <input type="text" id="cd-note" maxlength="200" value="${escapeHtml(entry.note || "")}" placeholder="z.B. bitte Lieferung annehmen" />
        </label>
        <p class="muted small">Die Info wird beim Bestätigen mitgespeichert und der Person angezeigt.</p>
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
        await decideShift(name, date, slotLabel, decision, overlay.querySelector("#cd-note").value.trim());
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
