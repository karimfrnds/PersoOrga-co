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

    const alle = eintraege();

    // Wie viele Schichten sind an dem Tag besetzt? Beantwortet die eigentliche Frage beim Planen
    // ("sind genug Leute da?") direkt im Kopf der Tabelle.
    const besetzung = [];
    for (let i = 0; i < 7; i++) {
      const date = addDaysISO(weekStart, i);
      const relevanteSlots = slots.filter((s) => !s.allowedWeekdays || s.allowedWeekdays.includes(i));
      const besetzt = relevanteSlots.filter((s) =>
        alle.some((e) => e.date === date && e.confirmedSlotId === s.id && e.bossConfirmed && istKueche(e.name) === kueche && !istKrank(e.name, date))
      ).length;
      besetzung.push({ besetzt, gesamt: relevanteSlots.length });
    }

    const thead = document.createElement("thead");
    const hr = document.createElement("tr");
    hr.innerHTML = `<th>Schicht</th>`;
    for (let i = 0; i < 7; i++) {
      const date = addDaysISO(weekStart, i);
      const { besetzt, gesamt } = besetzung[i];
      const voll = gesamt > 0 && besetzt === gesamt;
      const th = document.createElement("th");
      th.innerHTML =
        `${WEEKDAY_SHORT[i]} <span class="muted small">${dateDeShort(date)}</span>` +
        (gesamt > 0 ? `<br/><span class="roster-count ${voll ? "roster-count-voll" : ""}">${besetzt}/${gesamt} besetzt</span>` : "");
      hr.appendChild(th);
    }
    thead.appendChild(hr);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
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
    const belegt = relevant.find((e) => e.confirmedSlotId === slot.id);
    const kandidaten = relevant.filter((e) => e.confirmedSlotId !== slot.id && (e.slots || []).some((s) => s.id === slot.id));

    const box = document.createElement("div");
    box.className = "roster-box";

    if (belegt) {
      // Besetzt: Name gross und ruhig, daneben nur ✗ zum Austragen. Kein Knopf-Wirrwarr.
      td.className += belegt.bossConfirmed ? " roster-filled" : " roster-pending";
      const row = document.createElement("div");
      row.className = "roster-person";
      const nm = document.createElement("button");
      nm.className = "roster-name-btn";
      nm.textContent = belegt.name + (belegt.note ? " 📝" : "");
      nm.title = (belegt.bossConfirmed ? "Fest eingeteilt" : "Wartet auf deine Bestätigung") + (belegt.note ? ` · ${belegt.note}` : "") + " · Klicken zum Wechseln";
      nm.onclick = () => openPicker(date, slot, kueche, relevant, belegt);
      row.appendChild(nm);

      const raus = document.createElement("button");
      raus.className = "roster-btn roster-no";
      raus.textContent = "✗";
      raus.title = `${belegt.name} wieder austragen`;
      raus.onclick = () => senden(belegt.name, date, slot.label, "reject");
      row.appendChild(raus);
      box.appendChild(row);

      if (!belegt.bossConfirmed) {
        const hinweis = document.createElement("button");
        hinweis.className = "roster-confirm";
        hinweis.textContent = "✓ bestätigen";
        hinweis.onclick = () => senden(belegt.name, date, slot.label, "confirm");
        box.appendChild(hinweis);
      }
    } else {
      // Offen: die ganze Zelle ist ein Knopf. Wer sich gemeldet hat, steht als antippbarer Name darunter –
      // ein Klick teilt ein, ohne Umweg über einen Dialog.
      // Alles in EINER umbrechenden Zeile: erst der Einteilen-Knopf, dann wer sich gemeldet hat.
      // Ein Klick auf einen Namen teilt direkt ein – kein Umweg über einen Dialog.
      td.className += " roster-open";
      const chips = document.createElement("div");
      chips.className = "roster-chips";

      const frei = document.createElement("button");
      frei.className = "roster-frei-btn";
      frei.textContent = kandidaten.length ? "＋" : "frei";
      frei.title = "Jemanden einteilen";
      frei.onclick = () => openPicker(date, slot, kueche, relevant, null);
      chips.appendChild(frei);

      for (const k of kandidaten.slice(0, 2)) {
        const chip = document.createElement("button");
        chip.className = "roster-chip";
        chip.textContent = k.name;
        chip.title = `${k.name} für ${slot.label} einteilen`;
        chip.onclick = () => senden(k.name, date, slot.label, "confirm");
        chips.appendChild(chip);
      }
      if (kandidaten.length > 2) {
        const mehr = document.createElement("button");
        mehr.className = "roster-chip roster-chip-more";
        mehr.textContent = `+${kandidaten.length - 2}`;
        mehr.title = `${kandidaten.length} haben sich gemeldet – alle anzeigen`;
        mehr.onclick = () => openPicker(date, slot, kueche, relevant, null);
        chips.appendChild(mehr);
      }
      box.appendChild(chips);
    }

    td.appendChild(box);
    return td;
  }

  /** Auswahl-Fenster für eine Schicht: wer sich gemeldet hat steht oben, danach alle anderen.
   * Ein Klick auf einen Namen teilt ein – kein Dropdown, kein zweiter Bestätigungsschritt. */
  function openPicker(date, slot, kueche, relevant, belegt) {
    const alleNamen = [...(state.employees || [])].filter((n) => istKueche(n) === kueche).sort((a, b) => a.localeCompare(b));
    const gemeldet = new Set(relevant.filter((e) => (e.slots || []).some((s) => s.id === slot.id)).map((e) => e.name));
    // Wer an dem Tag schon woanders fest eingeteilt ist, wird gekennzeichnet – schützt vor Doppelbelegung.
    const anderweitig = new Map();
    for (const e of relevant) {
      if (e.confirmedSlotId && e.confirmedSlotId !== slot.id) {
        const s = (e.slots || []).find((x) => x.id === e.confirmedSlotId);
        anderweitig.set(e.name, s?.label || "andere Schicht");
      }
    }
    const krank = new Set((state.employees || []).filter((n) => istKrank(n, date)));

    const overlay = document.createElement("div");
    overlay.className = "overlay";
    const eintrag = (name) => {
      const busyMit = anderweitig.get(name);
      const istKrankHeute = krank.has(name);
      const hinweis = istKrankHeute ? "krank gemeldet" : busyMit ? `schon: ${busyMit}` : gemeldet.has(name) ? "hat sich gemeldet" : "";
      return `<button class="picker-row${belegt?.name === name ? " picker-current" : ""}${istKrankHeute ? " picker-warn" : ""}" data-name="${escapeHtml(name)}">
          <span class="picker-name">${escapeHtml(name)}${belegt?.name === name ? " ✓" : ""}</span>
          ${hinweis ? `<span class="muted small">${escapeHtml(hinweis)}</span>` : ""}
        </button>`;
    };
    const gemeldeteNamen = alleNamen.filter((n) => gemeldet.has(n));
    const uebrige = alleNamen.filter((n) => !gemeldet.has(n));

    overlay.innerHTML = `
      <div class="dialog">
        <h2>${escapeHtml(slot.label)}</h2>
        <p class="muted small">${escapeHtml(dateDe(date))} · ${escapeHtml(slot.from)}–${escapeHtml(slot.to)} Uhr</p>
        ${gemeldeteNamen.length ? `<p class="muted small"><b>Hat sich gemeldet</b></p><div class="picker-list">${gemeldeteNamen.map(eintrag).join("")}</div>` : ""}
        ${uebrige.length ? `<p class="muted small"><b>${gemeldeteNamen.length ? "Alle anderen" : "Mitarbeiter"}</b></p><div class="picker-list">${uebrige.map(eintrag).join("")}</div>` : ""}
        ${alleNamen.length ? `<label class="field"><span>Info zur Schicht (optional)</span><input type="text" id="pk-note" maxlength="200" value="${escapeHtml(belegt?.note || "")}" placeholder="z.B. bitte Lieferung annehmen" /></label>` : `<p class="muted small">Für diesen Bereich sind keine Mitarbeiter hinterlegt.</p>`}
        <p class="muted small" id="pk-status"></p>
        <div class="dialog-actions"><button class="btn btn-secondary" id="pk-close">Schließen</button></div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.querySelector("#pk-close").onclick = () => overlay.remove();
    overlay.querySelectorAll(".picker-row").forEach((b) => {
      b.onclick = async () => {
        const status = overlay.querySelector("#pk-status");
        overlay.querySelectorAll("button").forEach((x) => (x.disabled = true));
        status.textContent = "Wird gespeichert…";
        try {
          await decideShift(b.dataset.name, date, slot.label, "confirm", overlay.querySelector("#pk-note")?.value.trim() || "");
          overlay.remove();
          await onChanged();
        } catch (e) {
          status.textContent = "⚠ " + e.message;
          overlay.querySelectorAll("button").forEach((x) => (x.disabled = false));
        }
      };
    });
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
