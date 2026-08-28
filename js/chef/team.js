// ============================================================================
// chef/team.js – Mitarbeiter-Verwaltung am Laptop: anlegen, bearbeiten,
// deaktivieren/aktivieren und Nachrichten schicken.
//
// Der PIN wird hier bewusst NICHT vergeben. Er bleibt am iPad, damit kein PIN
// im Klartext über das Netz geht. Am Laptop ist nur sichtbar, ob überhaupt
// schon einer gesetzt ist.
// ============================================================================
import { escapeHtml, euro } from "../format.js";
import { employeeAction, sendMessage } from "./api.js";

const ROLLEN = [
  ["service", "Service"],
  ["kueche", "Küche"],
  ["bar", "Bar"],
];
const rollenName = (r) => ROLLEN.find(([id]) => id === r)?.[1] || r;

function renderTeam(state, { onChanged }) {
  const el = document.createElement("div");

  function rerender() {
    el.innerHTML = "";
    el.appendChild(build());
  }

  function build() {
    const frag = document.createElement("div");
    frag.innerHTML = `
      <h1>👥 Mitarbeiter</h1>
      <p class="muted">Stammdaten pflegen und Nachrichten schicken. Änderungen werden beim nächsten iPad-Abgleich übernommen.</p>`;
    frag.appendChild(buildListe());
    frag.appendChild(buildNachricht());
    return frag;
  }

  function buildListe() {
    const card = document.createElement("section");
    card.className = "card";
    card.innerHTML = `<h2>Team</h2>`;
    const status = document.createElement("p");
    status.className = "muted small";

    const leute = [...(state.employeeDetails || [])].sort((a, b) => a.name.localeCompare(b.name));
    if (leute.length === 0) {
      card.innerHTML += `<p class="muted small">Noch keine Mitarbeiter bekannt – das iPad muss sich einmal abgleichen.</p>`;
    } else {
      const ohnePin = leute.filter((e) => e.active && !e.hasPin);
      if (ohnePin.length > 0) {
        const warn = document.createElement("div");
        warn.className = "callout callout-warn";
        warn.textContent = `${ohnePin.map((e) => e.name).join(", ")} ${
          ohnePin.length === 1 ? "hat" : "haben"
        } noch keinen PIN und kann sich weder einstempeln noch am Handy anmelden. Den PIN vergibst du am iPad unter Admin → Mitarbeiter.`;
        card.appendChild(warn);
      }

      const scroll = document.createElement("div");
      scroll.style.overflowX = "auto";
      const table = document.createElement("table");
      table.className = "calc-table";
      table.innerHTML = `<thead><tr><th>Name</th><th>Rolle</th><th>Stundenlohn</th><th>Minijob</th><th>PIN</th><th></th></tr></thead>`;
      const tbody = document.createElement("tbody");
      for (const e of leute) {
        const tr = document.createElement("tr");
        if (!e.active) tr.style.opacity = "0.55";
        tr.innerHTML = `
          <td><b>${escapeHtml(e.name)}</b>${e.active ? "" : ' <span class="badge badge-gray">inaktiv</span>'}</td>
          <td>${escapeHtml(rollenName(e.role))}</td>
          <td>${euro(e.hourlyWage)}</td>
          <td>${e.isMinijob ? `ja (${euro(e.minijobLimit)})` : "nein"}</td>
          <td>${e.hasPin ? "✅" : '<span class="muted">fehlt</span>'}</td>`;
        const akt = document.createElement("td");
        akt.className = "employee-actions";
        const bearb = document.createElement("button");
        bearb.className = "btn btn-secondary";
        bearb.textContent = "Bearbeiten";
        bearb.onclick = () => openDialog(e);
        akt.appendChild(bearb);
        const um = document.createElement("button");
        um.className = "btn btn-secondary";
        um.textContent = e.active ? "Deaktivieren" : "Aktivieren";
        um.title = e.active ? "Taucht bei neuen Schichten nicht mehr auf, alte Tage bleiben erhalten" : "Wieder aufnehmen";
        um.onclick = async () => {
          if (e.active && !confirm(`${e.name} deaktivieren? Vergangene Tage bleiben unverändert erhalten.`)) return;
          status.className = "muted small";
          status.textContent = "Wird gespeichert…";
          try {
            await employeeAction({ kind: e.active ? "deactivate" : "activate", employeeId: e.id });
            await onChanged();
          } catch (err) {
            status.className = "callout callout-warn";
            status.textContent = "⚠ " + err.message;
          }
        };
        akt.appendChild(um);
        tr.appendChild(akt);
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
      scroll.appendChild(table);
      card.appendChild(scroll);
    }

    const neu = document.createElement("button");
    neu.className = "btn btn-primary";
    neu.textContent = "＋ Neuer Mitarbeiter";
    neu.onclick = () => openDialog(null);
    card.append(neu, status);
    return card;
  }

  function openDialog(person) {
    const neu = !person;
    const overlay = document.createElement("div");
    overlay.className = "overlay";
    overlay.innerHTML = `
      <div class="dialog">
        <h2>${neu ? "Neuer Mitarbeiter" : "Mitarbeiter bearbeiten"}</h2>
        <label class="field"><span>Name</span><input type="text" id="mi-name" value="${escapeHtml(person?.name || "")}" /></label>
        <label class="field"><span>Rolle</span><select id="mi-role">${ROLLEN.map(
          ([id, label]) => `<option value="${id}" ${person?.role === id ? "selected" : ""}>${label}</option>`
        ).join("")}</select></label>
        <label class="field"><span>Stundenlohn (€)</span><input type="number" id="mi-wage" step="0.01" min="0" value="${
          person?.hourlyWage ?? 12.82
        }" /></label>
        <label class="field-checkbox"><input type="checkbox" id="mi-minijob" ${person?.isMinijob ? "checked" : ""} /> Minijob (Verdienstgrenze überwachen)</label>
        <label class="field" id="mi-limit-wrap" style="display:${person?.isMinijob ? "block" : "none"}">
          <span>Minijob-Grenze pro Monat (€)</span><input type="number" id="mi-limit" step="1" min="0" value="${person?.minijobLimit ?? 556}" />
        </label>
        <p class="muted small">${
          neu
            ? "Den PIN zum Ein-/Ausstempeln vergibst du danach am iPad unter Admin → Mitarbeiter."
            : "Der PIN lässt sich nur am iPad ändern."
        }</p>
        <p class="muted small" id="mi-status"></p>
        <div class="dialog-actions">
          <button class="btn btn-secondary" id="mi-cancel">Abbrechen</button>
          <button class="btn btn-primary" id="mi-save">Speichern</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const status = overlay.querySelector("#mi-status");
    overlay.querySelector("#mi-minijob").onchange = (ev) => {
      overlay.querySelector("#mi-limit-wrap").style.display = ev.target.checked ? "block" : "none";
    };
    overlay.querySelector("#mi-cancel").onclick = () => overlay.remove();
    overlay.querySelector("#mi-save").onclick = async () => {
      const name = overlay.querySelector("#mi-name").value.trim();
      if (!name) {
        status.className = "callout callout-warn";
        status.textContent = "Bitte einen Namen eintragen.";
        return;
      }
      overlay.querySelectorAll("button").forEach((b) => (b.disabled = true));
      status.className = "muted small";
      status.textContent = "Wird gespeichert…";
      try {
        await employeeAction({
          kind: neu ? "create" : "update",
          employeeId: person?.id,
          name,
          role: overlay.querySelector("#mi-role").value,
          hourlyWage: overlay.querySelector("#mi-wage").value,
          isMinijob: overlay.querySelector("#mi-minijob").checked,
          minijobLimit: overlay.querySelector("#mi-limit").value,
        });
        overlay.remove();
        await onChanged();
      } catch (e) {
        status.className = "callout callout-warn";
        status.textContent = "⚠ " + e.message;
        overlay.querySelectorAll("button").forEach((b) => (b.disabled = false));
      }
    };
  }

  function buildNachricht() {
    const card = document.createElement("section");
    card.className = "card";
    card.innerHTML = `
      <h2>💬 Nachricht schicken</h2>
      <p class="muted small">Landet im Postfach der Person (Handy) und als Pop-up im Kiosk am iPad.</p>`;

    const aktive = [...(state.employeeDetails || [])].filter((e) => e.active).sort((a, b) => a.name.localeCompare(b.name));
    if (aktive.length === 0) {
      card.innerHTML += `<p class="muted small">Keine aktiven Mitarbeiter.</p>`;
      return card;
    }

    const empf = document.createElement("label");
    empf.className = "field";
    empf.innerHTML = `<span>An</span>`;
    const sel = document.createElement("select");
    const alle = document.createElement("option");
    alle.value = "__alle__";
    alle.textContent = "Alle Mitarbeiter";
    sel.appendChild(alle);
    for (const e of aktive) {
      const o = document.createElement("option");
      o.value = e.name;
      o.textContent = e.name;
      sel.appendChild(o);
    }
    empf.appendChild(sel);

    const textWrap = document.createElement("label");
    textWrap.className = "field";
    textWrap.innerHTML = `<span>Nachricht</span>`;
    const ta = document.createElement("textarea");
    ta.rows = 3;
    ta.maxLength = 1000;
    ta.placeholder = "z.B. Am Montag ist Inventur, bitte 30 Min früher da sein.";
    ta.style.cssText = "font-family:inherit;font-size:16px;padding:10px 12px;border-radius:10px;border:1px solid var(--border);background:var(--card-bg);color:var(--text)";
    textWrap.appendChild(ta);

    const status = document.createElement("p");
    status.className = "muted small";
    const btn = document.createElement("button");
    btn.className = "btn btn-primary";
    btn.textContent = "Senden";
    btn.onclick = async () => {
      const text = ta.value.trim();
      if (!text) {
        status.className = "callout callout-warn";
        status.textContent = "Bitte einen Text eingeben.";
        return;
      }
      btn.disabled = true;
      status.className = "muted small";
      status.textContent = "Wird gesendet…";
      try {
        const res = await sendMessage(sel.value === "__alle__" ? { toAll: true, text } : { employeeName: sel.value, text });
        ta.value = "";
        status.className = "callout";
        status.textContent = `✅ An ${res.empfaenger} ${res.empfaenger === 1 ? "Person" : "Personen"} gesendet.`;
      } catch (e) {
        status.className = "callout callout-warn";
        status.textContent = "⚠ " + e.message;
      }
      btn.disabled = false;
    };

    card.append(empf, textWrap, btn, status);
    return card;
  }

  rerender();
  return el;
}

export { renderTeam };
