// ============================================================================
// pages/employees.js – Mitarbeiterverwaltung
// ============================================================================
import { store } from "../store.js";
import { ROLE_LABEL } from "../calc.js";
import { euro, escapeHtml } from "../format.js";
import { confirmDialog, alertDialog } from "../dialog.js";

function renderEmployees() {
  const container = document.createElement("div");
  container.className = "page";

  // Überlebt Rerenders: inaktive Mitarbeiter starten eingeklappt (werden selten gebraucht).
  let showInactive = false;

  function rerender() {
    container.innerHTML = "";
    container.appendChild(build());
  }

  function buildRow(emp) {
    const row = document.createElement("div");
    row.className = "employee-row" + (emp.active ? "" : " inactive");
    row.innerHTML = `
      <div class="employee-main">
        <b>${escapeHtml(emp.name)}</b>
        <span class="muted small">${ROLE_LABEL[emp.role]} · ${euro(emp.hourlyWage)}/Std.${emp.isMinijob ? ` · Minijob (Grenze ${euro(emp.minijobLimit)}/Monat)` : ""}</span>
        <span class="muted small">PIN: ${emp.pin ? escapeHtml(emp.pin) : "– nicht vergeben –"}</span>
      </div>
    `;
    const actions = document.createElement("div");
    actions.className = "employee-actions";
    const editBtn = document.createElement("button");
    editBtn.className = "btn btn-secondary";
    editBtn.textContent = "Bearbeiten";
    editBtn.onclick = () => openForm(emp);
    actions.appendChild(editBtn);
    if (emp.active) {
      const deactivateBtn = document.createElement("button");
      deactivateBtn.className = "btn btn-secondary";
      deactivateBtn.textContent = "Deaktivieren";
      deactivateBtn.title = "Vorübergehend ausblenden – alte Tage bleiben unverändert erhalten";
      deactivateBtn.onclick = async () => {
        if (await confirmDialog(`${escapeHtml(emp.name)} deaktivieren? Vergangene Tage bleiben unverändert erhalten, aber ${escapeHtml(emp.name)} taucht bei neuen Schichten nicht mehr in der Auswahl auf.`, { danger: true, okLabel: "Deaktivieren" })) {
          store.removeEmployee(emp.id);
          rerender();
        }
      };
      actions.appendChild(deactivateBtn);
    } else {
      const reactivateBtn = document.createElement("button");
      reactivateBtn.className = "btn btn-secondary";
      reactivateBtn.textContent = "Aktivieren";
      reactivateBtn.onclick = () => {
        store.updateEmployee(emp.id, { active: true });
        rerender();
      };
      actions.appendChild(reactivateBtn);
    }

    const deleteBtn = document.createElement("button");
    deleteBtn.className = "btn btn-icon-danger";
    deleteBtn.textContent = "✕";
    deleteBtn.title = "Endgültig löschen";
    deleteBtn.onclick = async () => {
      if (store.employeeHasHistory(emp.id)) {
        await alertDialog(
          `${escapeHtml(emp.name)} hat bereits erfasste Schichten und kann deshalb nicht endgültig gelöscht werden – das würde vergangene Abrechnungen verfälschen. Bitte stattdessen deaktivieren, dann verschwindet die Person aus der Auswahl für neue Tage.`,
          { title: "Löschen nicht möglich" }
        );
        return;
      }
      if (await confirmDialog(`${escapeHtml(emp.name)} endgültig löschen? Das kann nicht rückgängig gemacht werden.`, { danger: true, okLabel: "Endgültig löschen" })) {
        store.deleteEmployee(emp.id);
        rerender();
      }
    };
    actions.appendChild(deleteBtn);

    row.appendChild(actions);
    return row;
  }

  function build() {
    const frag = document.createElement("div");
    frag.innerHTML = `<h1>Mitarbeiter</h1><p class="muted">Name, Rolle, Stundenlohn und PIN festlegen – der PIN wird zum Ein-/Ausstempeln am Kiosk-Bildschirm gebraucht.</p>`;

    const all = store.getEmployees(true).sort((a, b) => a.name.localeCompare(b.name));
    const active = all.filter((e) => e.active);
    const inactive = all.filter((e) => !e.active);

    const missingPin = active.filter((e) => !e.pin);
    if (missingPin.length > 0) {
      const warn = document.createElement("div");
      warn.className = "callout callout-warn";
      warn.textContent = `${missingPin.length} Mitarbeiter ohne PIN: ${missingPin.map((e) => e.name).join(", ")} – können sich noch nicht am Kiosk-Bildschirm einstempeln.`;
      frag.appendChild(warn);
    }

    const list = document.createElement("div");
    list.className = "employee-list";
    for (const emp of active) list.appendChild(buildRow(emp));
    frag.appendChild(list);

    const addBtn = document.createElement("button");
    addBtn.className = "btn btn-primary btn-huge";
    addBtn.textContent = "＋ Mitarbeiter hinzufügen";
    addBtn.onclick = () => openForm(null);
    frag.appendChild(addBtn);

    if (inactive.length > 0) {
      const headerBtn = document.createElement("button");
      headerBtn.className = "group-header" + (showInactive ? " open" : "");
      headerBtn.style.marginTop = "16px";
      headerBtn.innerHTML = `
        <span class="group-header-chevron">▶</span>
        <span class="group-header-name">Inaktive Mitarbeiter</span>
        <span class="group-header-meta">${inactive.length}</span>
      `;
      headerBtn.onclick = () => {
        showInactive = !showInactive;
        rerender();
      };
      frag.appendChild(headerBtn);
      if (showInactive) {
        const body = document.createElement("div");
        body.className = "group-body";
        const inactiveList = document.createElement("div");
        inactiveList.className = "employee-list";
        for (const emp of inactive) inactiveList.appendChild(buildRow(emp));
        body.appendChild(inactiveList);
        frag.appendChild(body);
      }
    }

    return frag;
  }

  function openForm(emp) {
    const isEdit = !!emp;
    const overlay = document.createElement("div");
    overlay.className = "overlay";
    overlay.innerHTML = `
      <div class="dialog">
        <h2>${isEdit ? "Mitarbeiter bearbeiten" : "Neuer Mitarbeiter"}</h2>
        <label class="field"><span>Name</span><input type="text" id="f-name" value="${emp ? escapeHtml(emp.name) : ""}" /></label>
        <label class="field"><span>Rolle</span>
          <select id="f-role">
            <option value="service" ${emp?.role === "service" ? "selected" : ""}>Service</option>
            <option value="kueche" ${emp?.role === "kueche" ? "selected" : ""}>Küche</option>
            <option value="bar" ${emp?.role === "bar" ? "selected" : ""}>Bar</option>
          </select>
        </label>
        <label class="field"><span>Stundenlohn (€)</span><input type="number" step="0.01" min="0" id="f-wage" value="${emp ? emp.hourlyWage : 12.82}" /></label>
        <label class="field"><span>PIN (mind. 4 Zeichen, zum Ein-/Ausstempeln)</span><input type="text" inputmode="numeric" id="f-pin" value="${emp?.pin ? escapeHtml(emp.pin) : ""}" placeholder="z.B. 4711" /></label>
        <label class="field-checkbox"><input type="checkbox" id="f-minijob" ${emp?.isMinijob ? "checked" : ""} /> Minijob (Verdienstgrenze überwachen)</label>
        <label class="field" id="f-limit-wrap" style="display:${emp?.isMinijob ? "block" : "none"}">
          <span>Minijob-Grenze pro Monat (€)</span><input type="number" step="1" min="0" id="f-limit" value="${emp ? emp.minijobLimit : 556}" />
        </label>
        <div class="dialog-actions">
          <button class="btn btn-secondary" id="f-cancel">Abbrechen</button>
          <button class="btn btn-primary" id="f-save">Speichern</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    overlay.querySelector("#f-minijob").onchange = (e) => {
      overlay.querySelector("#f-limit-wrap").style.display = e.target.checked ? "block" : "none";
    };
    overlay.querySelector("#f-cancel").onclick = () => overlay.remove();
    overlay.querySelector("#f-save").onclick = async () => {
      const name = overlay.querySelector("#f-name").value.trim();
      if (!name) {
        await alertDialog("Bitte einen Namen eintragen.");
        return;
      }
      const pinRaw = overlay.querySelector("#f-pin").value.trim();
      if (pinRaw && pinRaw.length < 4) {
        await alertDialog("Der PIN sollte mindestens 4 Zeichen haben.");
        return;
      }
      if (pinRaw && store.isPinTaken(pinRaw, emp?.id)) {
        await alertDialog("Dieser PIN wird schon von einer anderen Person (oder dem Admin-PIN) benutzt. Bitte einen anderen wählen.");
        return;
      }
      const payload = {
        name,
        role: overlay.querySelector("#f-role").value,
        hourlyWage: Number(overlay.querySelector("#f-wage").value) || 0,
        pin: pinRaw || null,
        isMinijob: overlay.querySelector("#f-minijob").checked,
        minijobLimit: Number(overlay.querySelector("#f-limit").value) || 556,
      };
      if (isEdit) {
        store.updateEmployee(emp.id, payload);
      } else {
        store.addEmployee(payload);
      }
      overlay.remove();
      rerender();
    };
  }

  rerender();
  return container;
}

export { renderEmployees };
