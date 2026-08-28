// ============================================================================
// chef/planning.js – Schichtplanung am Laptop, aufgebaut wie der Papier-Schichtplan:
// Zeilen = Schichten, Spalten = Wochentage. So sieht man auf einen Blick, welche
// Schicht an welchem Tag noch unbesetzt ist.
// Zusagen und Ablehnen geht direkt in der Zelle (✓ / ✗), ohne Zwischendialog.
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
const dateDeShort = (s) => {
  const [, m, d] = s.split("-");
  return `${d}.${m}.`;
};
/** Zeiten, die an DIESEM Wochentag gelten (manche Schichten enden an einzelnen Tagen später).
 * Bewusst klein gehalten und gespiegelt aus js/store.js – diese Ansicht kennt den Store nicht. */
function slotAmTag(slot, wochentagIndex) {
  const ov = slot?.weekdayOverrides?.[wochentagIndex];
  return ov ? { ...slot, ...ov } : slot;
}

function renderPlanning(state, { onChanged, today }) {
  const el = document.createElement("div");
  let weekStart = addDaysISO(mondayOf(today), 7); // Standard: die Woche, für die geplant wird
  let busy = false;

  const rolleVon = (name) =>
    (state.employeeRoles || []).find((r) => String(r.name || "").trim().toLowerCase() === name.trim().toLowerCase())?.role || "service";
  const istKueche = (name) => rolleVon(name) === "kueche";

  function rerender() {
    el.innerHTML = "";
    el.appendChild(build());
  }

  /** Alle Verfügbarkeits-Einträge der Woche, flach: {name, date, slots[], confirmedSlotId, bossConfirmed, note} */
  function eintraege() {
    const out = [];
    const bucket = (state.availability || {})[weekStart];
    for (const [name, entry] of Object.entries(bucket?.entries || {})) {
      for (const day of entry?.days || []) out.push({ name, ...day });
    }
    return out;
  }

  function istKrank(name, date) {
    const n = name.trim().toLowerCase();
    return (state.sickReports || []).some(
      (r) => String(r.employeeName || "").trim().toLowerCase() === n && r.from <= date && (r.to || r.from) >= date
    );
  }

  function build() {
    const frag = document.createElement("div");
    frag.innerHTML = `<h1>📅 Schichtplan</h1>`;

    const nav = document.createElement("div");
    nav.className = "week-nav";
    const prev = document.createElement("button");
    prev.className = "btn btn-secondary";
    prev.textContent = "←";
    prev.title = "Vorherige Woche";
    prev.onclick = () => {
      weekStart = addDaysISO(weekStart, -7);
      rerender();
    };
    const label = document.createElement("span");
    label.className = "week-nav-label";
    label.textContent = `${dateDe(weekStart)} – ${dateDe(addDaysISO(weekStart, 6))}`;
    const next = document.createElement("button");
    next.className = "btn btn-secondary";
    next.textContent = "→";
    next.title = "Nächste Woche";
    next.onclick = () => {
      weekStart = addDaysISO(weekStart, 7);
      rerender();
    };
    const heute = document.createElement("button");
    heute.className = "btn btn-secondary";
    heute.textContent = "Aktuelle Woche";
    heute.onclick = () => {
      weekStart = mondayOf(today);
      rerender();
    };
    nav.append(prev, label, next, heute);
    frag.appendChild(nav);

    if (!state.shiftSlots) {
      const c = document.createElement("section");
      c.className = "card";
      c.innerHTML = `<p class="muted small">Die Schichtzeiten sind noch nicht da. Das iPad muss sich einmal abgleichen.</p>`;
      frag.appendChild(c);
      return frag;
    }

    frag.appendChild(buildPlan("Service / Bar", state.shiftSlots.service || [], false));
    frag.appendChild(buildPlan("Küche", state.shiftSlots.kueche || [], true));
    frag.appendChild(buildKranke());

    const legend = document.createElement("p");
    legend.className = "muted small";
    legend.textContent = `✅ fest eingeteilt · 🔶 wartet auf dich · grau = Schicht entfällt an dem Tag · „frei" = noch niemand eingeteilt`;
    frag.appendChild(legend);
    return frag;
  }

  function buildPlan(titel, slots, kueche) {
    const card = document.createElement("section");
    card.className = "card";
    card.innerHTML = `<h2>${escapeHtml(titel)}</h2>`;
    if (slots.length === 0) {
      card.innerHTML += `<p class="muted small">Keine Schichten hinterlegt.</p>`;
      return card;
    }

    const scroll = document.createElement("div");
    scroll.style.overflowX = "auto";
    const table = document.createElement("table");
    table.className = "plan-table plan-roster";

    const thead = document.createElement("thead");
    const hr = document.createElement("tr");
    hr.innerHTML = `<th>Schicht</th>`;
    for (let i = 0; i < 7; i++) {
      const date = addDaysISO(weekStart, i);
      const th = document.createElement("th");
      th.innerHTML = `${WEEKDAY_SHORT[i]}<br/><span class="muted small">${dateDeShort(date)}</span>`;
      hr.appendChild(th);
    }
    thead.appendChild(hr);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    const alle = eintraege();
    for (const slot of slots) {
      const tr = document.createElement("tr");
      const nameTd = document.createElement("td");
      nameTd.className = "roster-slot";
      // Weicht die Zeit an einzelnen Tagen ab, wird das an der Schicht vermerkt. Tage mit gleicher
      // Abweichung werden zusammengefasst, damit dort "Mo/Di bis 17:00" steht statt zweimal dasselbe.
      const nachEndzeit = new Map();
      for (const [wd, ov] of Object.entries(slot.weekdayOverrides || {})) {
        const bis = ov.to || slot.to;
        if (!nachEndzeit.has(bis)) nachEndzeit.set(bis, []);
        nachEndzeit.get(bis).push(WEEKDAY_SHORT[Number(wd)]);
      }
      const abweichung = [...nachEndzeit.entries()].map(([bis, tage]) => `${tage.join("/")} bis ${bis}`).join(", ");
      nameTd.innerHTML =
        `<b>${escapeHtml(slot.label)}</b><br/><span class="muted small">${escapeHtml(slot.from)}–${escapeHtml(slot.to)}</span>` +
        (abweichung ? `<br/><span class="muted small">${escapeHtml(abweichung)}</span>` : "");
      tr.appendChild(nameTd);

      for (let i = 0; i < 7; i++) {
        const date = addDaysISO(weekStart, i);
        const gilt = !slot.allowedWeekdays || slot.allowedWeekdays.includes(i);
        tr.appendChild(buildCell(slotAmTag(slot, i), date, gilt, kueche, alle));
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    scroll.appendChild(table);
    card.appendChild(scroll);
    return card;
  }

  function buildCell(slot, date, gilt, kueche, alle) {
    const td = document.createElement("td");
    td.className = "roster-cell";
    if (!gilt) {
      td.className += " roster-off";
      td.innerHTML = `<span class="muted">–</span>`;
      return td;
    }

    // Nur Personen der passenden Rolle betrachten (Service und Bar teilen sich einen Plan).
    const relevant = alle.filter((e) => e.date === date && istKueche(e.name) === kueche && !istKrank(e.name, date));
    const fest = relevant.find((e) => e.confirmedSlotId === slot.id && e.bossConfirmed);
    const wartet = relevant.find((e) => e.confirmedSlotId === slot.id && !e.bossConfirmed);
    const kandidaten = relevant.filter((e) => e.confirmedSlotId !== slot.id && (e.slots || []).some((s) => s.id === slot.id));

    const box = document.createElement("div");
    box.className = "roster-box";

    const zeile = (e, zustand) => {
      const row = document.createElement("div");
      row.className = "roster-person";
      const nm = document.createElement("span");
      nm.className = "roster-name";
      nm.textContent = (zustand === "fest" ? "✅ " : zustand === "wartet" ? "🔶 " : "") + e.name;
      if (e.note) {
        nm.title = e.note;
        nm.textContent += " 📝";
      }
      row.appendChild(nm);

      const btns = document.createElement("div");
      btns.className = "roster-actions";
      if (zustand !== "fest") {
        const ja = document.createElement("button");
        ja.className = "roster-btn roster-yes";
        ja.textContent = "✓";
        ja.title = `${e.name} für ${slot.label} einteilen`;
        ja.onclick = () => senden(e.name, date, slot.label, "confirm");
        btns.appendChild(ja);
      }
      const nein = document.createElement("button");
      nein.className = "roster-btn roster-no";
      nein.textContent = "✗";
      nein.title = zustand === "fest" ? `${e.name} wieder austragen` : `${e.name} für ${slot.label} ablehnen`;
      nein.onclick = () => senden(e.name, date, slot.label, "reject");
      btns.appendChild(nein);
      row.appendChild(btns);
      return row;
    };

    if (fest) box.appendChild(zeile(fest, "fest"));
    if (wartet) box.appendChild(zeile(wartet, "wartet"));
    for (const k of kandidaten) box.appendChild(zeile(k, "kandidat"));

    if (!fest) {
      // Kein fest Eingeteilter -> Schicht ist offen. Das ist die Information, um die es beim Planen geht.
      const frei = document.createElement("div");
      frei.className = "roster-frei";
      frei.textContent = kandidaten.length || wartet ? "noch nicht entschieden" : "frei";
      box.insertBefore(frei, box.firstChild);
    }

    const plus = document.createElement("button");
    plus.className = "roster-btn roster-add";
    plus.textContent = "＋";
    plus.title = "Jemanden von Hand eintragen";
    plus.onclick = () => openAssign(date, slot, kueche);
    box.appendChild(plus);

    td.appendChild(box);
    return td;
  }

  async function senden(name, date, slotLabel, decision, note) {
    if (busy) return;
    busy = true;
    // Sofortige Rückmeldung, damit man bei mehreren Klicks hintereinander sieht, dass etwas passiert.
    el.querySelectorAll(".roster-btn").forEach((b) => (b.disabled = true));
    try {
      await decideShift(name, date, slotLabel, decision, note);
      await onChanged();
    } catch (e) {
      zeigeFehler(e.message);
      el.querySelectorAll(".roster-btn").forEach((b) => (b.disabled = false));
    }
    busy = false;
  }

  /** Fehler als Hinweis oben in der Ansicht statt als blockierender Dialog – beim schnellen Durchklicken
   * eines Wochenplans wäre ein Dialog pro Klick unbrauchbar. */
  function zeigeFehler(text) {
    el.querySelector(".roster-error")?.remove();
    const box = document.createElement("div");
    box.className = "callout callout-warn roster-error";
    box.textContent = "⚠ " + text;
    el.prepend(box);
    setTimeout(() => box.remove(), 6000);
  }

  /** Jemanden von Hand auf diese Schicht setzen – auch ohne gemeldete Verfügbarkeit. */
  function openAssign(date, slot, kueche) {
    const passende = [...(state.employees || [])].filter((n) => istKueche(n) === kueche).sort((a, b) => a.localeCompare(b));
    const overlay = document.createElement("div");
    overlay.className = "overlay";
    overlay.innerHTML = `
      <div class="dialog">
        <h2>${escapeHtml(slot.label)} · ${escapeHtml(dateDe(date))}</h2>
        <p class="muted small">${escapeHtml(slot.from)}–${escapeHtml(slot.to)} Uhr</p>
        ${
          passende.length
            ? `<label class="field"><span>Mitarbeiter</span><select id="ra-emp">${passende.map((n) => `<option>${escapeHtml(n)}</option>`).join("")}</select></label>
               <label class="field"><span>Info zur Schicht (optional)</span><input type="text" id="ra-note" maxlength="200" placeholder="z.B. bitte Lieferung annehmen" /></label>
               <p class="muted small">Die Person bekommt die Schicht als bestätigt angezeigt – am iPad und auf ihrem Handy.</p>`
            : `<p class="muted small">Für diesen Bereich sind keine Mitarbeiter hinterlegt.</p>`
        }
        <p class="muted small" id="ra-status"></p>
        <div class="dialog-actions">
          <button class="btn btn-secondary" id="ra-cancel">Abbrechen</button>
          ${passende.length ? `<button class="btn btn-primary" id="ra-save">Eintragen</button>` : ""}
        </div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.querySelector("#ra-cancel").onclick = () => overlay.remove();
    const save = overlay.querySelector("#ra-save");
    if (save) {
      save.onclick = async () => {
        const status = overlay.querySelector("#ra-status");
        overlay.querySelectorAll("button").forEach((b) => (b.disabled = true));
        status.textContent = "Wird gespeichert…";
        try {
          await decideShift(overlay.querySelector("#ra-emp").value, date, slot.label, "confirm", overlay.querySelector("#ra-note").value.trim());
          overlay.remove();
          await onChanged();
        } catch (e) {
          status.textContent = "⚠ " + e.message;
          overlay.querySelectorAll("button").forEach((b) => (b.disabled = false));
        }
      };
    }
  }

  function buildKranke() {
    const wochenEnde = addDaysISO(weekStart, 6);
    const krank = (state.sickReports || []).filter((r) => (r.to || r.from) >= weekStart && r.from <= wochenEnde);
    const card = document.createElement("section");
    card.className = "card";
    card.innerHTML = `<h2>🤒 Krankmeldungen diese Woche</h2>`;
    if (krank.length === 0) {
      card.innerHTML += `<p class="muted small">Keine.</p>`;
      return card;
    }
    const list = document.createElement("div");
    list.className = "task-list";
    for (const r of krank) {
      const row = document.createElement("div");
      row.className = "task-row";
      const zeitraum = r.from === (r.to || r.from) ? dateDe(r.from) : `${dateDe(r.from)} – ${dateDe(r.to)}`;
      row.innerHTML = `<div class="task-row-text"><span><b>${escapeHtml(r.employeeName)}</b></span><span class="muted small task-row-meta">${escapeHtml(
        zeitraum
      )}${r.note ? ` · ${escapeHtml(r.note)}` : ""}</span></div>`;
      list.appendChild(row);
    }
    card.appendChild(list);
    return card;
  }

  rerender();
  return el;
}

export { renderPlanning };
