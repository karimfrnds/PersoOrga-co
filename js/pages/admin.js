// ============================================================================
// pages/admin.js – Geschützter Bereich: Mitarbeiter, Stunden, Berichte, Einstellungen, Beta.
// PIN ist kein echter Passwortschutz (alles läuft lokal im Browser), sondern nur
// ein Schutz gegen versehentliche Änderungen auf einem gemeinsam genutzten Gerät.
// ============================================================================
import { store } from "../store.js";
import { renderAdminDays } from "./adminDays.js";
import { renderEmployees } from "./employees.js";
import { renderTasksAdmin } from "./tasksAdmin.js";
import { renderStockAdmin } from "./stockAdmin.js";
import { renderTablesAdmin } from "./tablesAdmin.js";
import { renderInventur } from "./inventur.js";
import { renderShiftPlanningAdmin } from "./shiftPlanningAdmin.js";
import { renderSettings } from "./settings.js";
import { renderExport } from "./exportpage.js";
import { renderHours } from "./hours.js";
import { renderBeta } from "./beta.js";
import { alertDialog, confirmDialog } from "../dialog.js";
import { isUnlocked, unlockDirect, lock } from "../adminAuth.js";
import { todayStr } from "../format.js";
import { buildPinDots, buildPinKeypad } from "../pinpad.js";

function renderAdmin(navigate) {
  const container = document.createElement("div");
  container.className = "page admin-page";
  let activeTab = "days";
  let lockPin = "";
  let lockError = "";

  const TABS = [
    { id: "days", label: "Tage", render: () => renderAdminDays(navigate) },
    { id: "employees", label: "Mitarbeiter", render: () => renderEmployees() },
    { id: "tasks", label: "Aufgaben", render: () => renderTasksAdmin() },
    { id: "planning", label: "Schichtplanung", render: () => renderShiftPlanningAdmin() },
    { id: "stock", label: "Vorräte", render: () => renderStockAdmin() },
    { id: "inventur", label: "Inventur", render: () => renderInventur() },
    { id: "tables", label: "Tische", render: () => renderTablesAdmin() },
    { id: "hours", label: "Stunden", render: () => renderHours(navigate) },
    { id: "export", label: "Berichte", render: () => renderExport() },
    { id: "beta", label: "🧪 Beta", render: () => renderBeta(navigate) },
    { id: "settings", label: "Einstellungen", render: () => renderSettings() },
  ];

  function rerender() {
    container.innerHTML = "";
    container.appendChild(build());
  }

  function build() {
    if (!store.hasAdminPin()) return buildSetupPin();
    if (!isUnlocked()) return buildLockScreen();
    return buildAdminHome();
  }

  function buildSetupPin() {
    const wrap = document.createElement("div");
    wrap.innerHTML = `
      <h1>Admin-Bereich einrichten</h1>
      <div class="card">
        <p>Bevor ihr diesen Bereich zum ersten Mal nutzt, legt einen PIN fest. Er schützt vor versehentlichen
        Änderungen an Mitarbeitern, Einstellungen und Berichten – kein echter Passwortschutz, aber genug,
        damit nicht jeder aus Versehen etwas verstellt.</p>
        <label class="field"><span>PIN (mind. 4 Zeichen)</span><input type="text" inputmode="numeric" id="setup-pin" /></label>
        <label class="field"><span>Wiederholen</span><input type="text" inputmode="numeric" id="setup-pin-repeat" /></label>
        <button class="btn btn-primary btn-huge" id="setup-save">PIN festlegen</button>
      </div>
    `;
    wrap.querySelector("#setup-save").onclick = async () => {
      const p1 = wrap.querySelector("#setup-pin").value.trim();
      const p2 = wrap.querySelector("#setup-pin-repeat").value.trim();
      if (p1.length < 4) {
        await alertDialog("Der PIN sollte mindestens 4 Zeichen haben.");
        return;
      }
      if (p1 !== p2) {
        await alertDialog("Die beiden Eingaben stimmen nicht überein.");
        return;
      }
      store.setAdminPin(p1);
      unlockDirect();
      rerender();
    };
    return wrap;
  }

  function buildLockScreen() {
    const wrap = document.createElement("div");
    wrap.className = "kiosk-wrap";
    wrap.innerHTML = `<h1>🔒 Admin-Bereich</h1><p class="muted">PIN eingeben</p>`;

    wrap.appendChild(buildPinDots(lockPin));

    if (lockError) {
      const errBox = document.createElement("div");
      errBox.className = "callout callout-warn kiosk-error";
      errBox.textContent = lockError;
      wrap.appendChild(errBox);
    }

    wrap.appendChild(buildPinKeypad(handleLockKey));

    const forgotBtn = document.createElement("button");
    forgotBtn.className = "btn btn-link";
    forgotBtn.textContent = "PIN vergessen?";
    forgotBtn.onclick = async () => {
      if (
        await confirmDialog(
          "Der PIN kann nicht wiederhergestellt werden, nur zurückgesetzt werden – ihr müsst danach direkt einen neuen festlegen. Eure Mitarbeiter- und Tagesdaten bleiben dabei unangetastet. Jetzt zurücksetzen?",
          { danger: true, okLabel: "PIN zurücksetzen", title: "PIN zurücksetzen" }
        )
      ) {
        store.clearAdminPin();
        lockPin = "";
        lockError = "";
        rerender();
      }
    };
    wrap.appendChild(forgotBtn);
    return wrap;
  }

  function handleLockKey(key) {
    lockError = "";
    if (key === "⌫") {
      lockPin = lockPin.slice(0, -1);
      rerender();
      return;
    }
    if (key === "✓") {
      tryUnlock();
      return;
    }
    if (lockPin.length < 8) lockPin += key;
    rerender();
  }

  function tryUnlock() {
    if (lockPin.length === 0) return;
    if (store.checkAdminPin(lockPin)) {
      unlockDirect();
      lockPin = "";
      lockError = "";
      rerender();
    } else {
      lockError = "PIN ist falsch.";
      lockPin = "";
      rerender();
    }
  }

  function buildAdminHome() {
    const wrap = document.createElement("div");
    const head = document.createElement("div");
    head.className = "admin-head";
    head.innerHTML = `<h1>Admin-Bereich</h1>`;
    const lockBtn = document.createElement("button");
    lockBtn.className = "btn btn-secondary";
    lockBtn.textContent = "🔒 Sperren";
    lockBtn.onclick = () => {
      lock();
      rerender();
    };
    head.appendChild(lockBtn);
    wrap.appendChild(head);

    const ghCfg = store.getGithubBackupConfig();
    if (!ghCfg.enabled) {
      const w = document.createElement("div");
      w.className = "callout callout-warn";
      w.innerHTML = `Kein automatisches Backup eingerichtet – eure Daten liegen nur in diesem Browser. Empfohlen unter <b>Einstellungen → Automatisches Tages-Backup</b>.`;
      wrap.appendChild(w);
    } else if (ghCfg.lastError) {
      const w = document.createElement("div");
      w.className = "callout callout-warn";
      w.innerHTML = `⚠ Letztes automatisches Backup fehlgeschlagen: ${ghCfg.lastError} – bitte unter <b>Einstellungen</b> prüfen.`;
      wrap.appendChild(w);
    } else if (ghCfg.lastBackupDate !== todayStr()) {
      const w = document.createElement("div");
      w.className = "callout";
      w.textContent = `Heute noch kein Backup gelaufen (letztes: ${ghCfg.lastBackupDate || "nie"}) – läuft automatisch beim nächsten Öffnen der App.`;
      wrap.appendChild(w);
    }

    const tabNav = document.createElement("div");
    tabNav.className = "admin-tabs";
    for (const tab of TABS) {
      const btn = document.createElement("button");
      btn.className = "admin-tab" + (tab.id === activeTab ? " active" : "");
      btn.textContent = tab.label;
      btn.onclick = () => {
        activeTab = tab.id;
        rerender();
      };
      tabNav.appendChild(btn);
    }
    wrap.appendChild(tabNav);

    const activeRender = TABS.find((t) => t.id === activeTab)?.render || TABS[0].render;
    wrap.appendChild(activeRender());
    return wrap;
  }

  rerender();
  return container;
}

export { renderAdmin };
