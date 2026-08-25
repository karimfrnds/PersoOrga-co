// ============================================================================
// pages/kiosk.js – Startbildschirm des gemeinsamen Geräts: durchgehende
// Übersicht „Aktuelle Schicht" (wer ist gerade im Dienst + gemeinsame
// Tages-Aufgaben). Ein-/Ausstempeln läuft über ein kleines PIN-Overlay, ohne
// die Übersicht zu verlassen – so können mehrere Personen nacheinander (oder
// kurz hintereinander) ein-/ausstempeln, ohne dass eine Person "im Weg" ist.
// Der Admin-Bereich ist über einen eigenen Button erreichbar.
// ============================================================================
import { store } from "../store.js";
import { escapeHtml, todayStr } from "../format.js";
import { confirmDialog, alertDialog } from "../dialog.js";
import { buildPinDots, buildPinKeypad } from "../pinpad.js";
import { maybeSyncPendingTasks } from "../taskSync.js";

const TASK_SYNC_INTERVAL_MS = 90 * 1000;
let activeSyncInterval = null; // es darf immer nur ein Leerlauf-Sync-Intervall gleichzeitig laufen

function renderKiosk(navigate) {
  const container = document.createElement("div");
  container.className = "page kiosk-page";

  // Neue Telegram-Aufgaben sofort abholen und danach im Leerlauf regelmäßig weiter prüfen. Nach jedem
  // Abruf die Übersicht neu zeichnen, damit neue Aufgaben ohne Zutun sichtbar werden. Vorheriges
  // Intervall (von einem früheren Kiosk-Aufruf) beenden, damit sich nichts aufsummiert.
  if (activeSyncInterval) clearInterval(activeSyncInterval);
  const syncTick = () => maybeSyncPendingTasks().then(rerender, rerender);
  syncTick();
  activeSyncInterval = setInterval(syncTick, TASK_SYNC_INTERVAL_MS);

  function rerender() {
    container.innerHTML = "";
    container.appendChild(buildOverview());
  }

  function buildOverview() {
    const wrap = document.createElement("div");

    const now = new Date();
    const hour = now.getHours();
    const greeting = hour < 11 ? "Guten Morgen" : hour < 18 ? "Hallo" : "Guten Abend";
    const head = document.createElement("div");
    head.innerHTML = `<p class="muted small kiosk-greeting">${greeting} ☕</p><h1>Aktuelle Schicht</h1>`;
    wrap.appendChild(head);

    const today = store.getDayByDate(todayStr());
    const openShifts = store.getOpenShiftsToday();

    // ---- Im Dienst ----
    const shiftCard = document.createElement("section");
    shiftCard.className = "card";
    shiftCard.innerHTML = `<h2>Im Dienst</h2>`;
    if (openShifts.length === 0) {
      const empty = document.createElement("p");
      empty.className = "muted small";
      empty.textContent = "Aktuell niemand eingestempelt.";
      shiftCard.appendChild(empty);
    } else {
      const list = document.createElement("div");
      list.className = "employee-list";
      for (const shift of openShifts) {
        const emp = store.getEmployee(shift.employeeId);
        const row = document.createElement("div");
        row.className = "employee-row";
        row.innerHTML = `<div class="employee-main"><b>${escapeHtml(emp?.name || "?")}</b><span class="muted small">seit ${escapeHtml(shift.from)} Uhr</span></div>`;
        list.appendChild(row);
      }
      shiftCard.appendChild(list);
    }
    wrap.appendChild(shiftCard);

    const pinBtn = document.createElement("button");
    pinBtn.className = "btn btn-primary btn-huge";
    pinBtn.textContent = "🔢 PIN eingeben zum Ein-/Ausstempeln";
    pinBtn.onclick = () => openPinOverlay();
    wrap.appendChild(pinBtn);

    // ---- Aufgaben ----
    if (today) wrap.appendChild(buildTasksCard(today));

    const adminBtn = document.createElement("button");
    adminBtn.className = "btn btn-link kiosk-admin-link";
    adminBtn.textContent = "🔒 Admin";
    adminBtn.onclick = () => navigate("admin");
    wrap.appendChild(adminBtn);

    return wrap;
  }

  function buildTasksCard(day) {
    const card = document.createElement("section");
    card.className = "card";
    const openCount = day.tasks.filter((t) => !t.done).length;
    card.innerHTML = `<h2>📋 Aufgaben heute${day.tasks.length ? ` <span class="muted small">(${openCount} offen)</span>` : ""}</h2>`;
    if (day.tasks.length === 0) {
      const empty = document.createElement("p");
      empty.className = "muted small";
      empty.textContent = "Keine Aufgaben für heute.";
      card.appendChild(empty);
      return card;
    }
    const list = document.createElement("div");
    list.className = "task-list";
    const priorityOrder = { hoch: 0, normal: 1, niedrig: 2 };
    const sorted = [...day.tasks].sort((a, b) => (priorityOrder[a.priority] ?? 1) - (priorityOrder[b.priority] ?? 1));
    for (const task of sorted) {
      const row = document.createElement("label");
      row.className = "task-row" + (task.done ? " done" : "");
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = task.done;
      cb.onchange = () => toggleTask(day, task);
      row.appendChild(cb);
      const textWrap = document.createElement("div");
      textWrap.className = "task-row-text";
      const span = document.createElement("span");
      span.textContent = (task.priority === "hoch" ? "🔴 " : task.priority === "niedrig" ? "🔵 " : "") + task.text;
      textWrap.appendChild(span);
      if (task.assignedTo) {
        const assignee = store.getEmployee(task.assignedTo);
        if (assignee) {
          const tag = document.createElement("span");
          tag.className = "muted small task-row-meta";
          tag.textContent = `→ für ${assignee.name}${task.handoffFrom ? ` (übergeben von ${task.handoffFrom})` : ""}`;
          textWrap.appendChild(tag);
        }
      }
      if (task.done && task.doneBy) {
        const meta = document.createElement("span");
        meta.className = "muted small task-row-meta";
        meta.textContent = `✓ erledigt von ${task.doneBy}${task.doneAt ? ", " + new Date(task.doneAt).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" }) + " Uhr" : ""}`;
        textWrap.appendChild(meta);
      }
      row.appendChild(textWrap);
      list.appendChild(row);
    }
    card.appendChild(list);
    return card;
  }

  // Wenn genau eine Person im Dienst ist, wird ihr das Abhaken automatisch zugeschrieben. Sind es mehrere,
  // fragt ein kleiner Picker nach (kein PIN nötig, ist ja schon als im Dienst identifiziert).
  function toggleTask(day, task) {
    if (task.done) {
      store.toggleDayTask(day.id, task.id, null);
      rerender();
      return;
    }
    const openShifts = store.getOpenShiftsToday();
    if (openShifts.length > 1) {
      openWhoDialog(day, task, openShifts);
      return;
    }
    const emp = openShifts[0] ? store.getEmployee(openShifts[0].employeeId) : null;
    store.toggleDayTask(day.id, task.id, emp?.name || null);
    rerender();
  }

  function openWhoDialog(day, task, openShifts) {
    const overlay = document.createElement("div");
    overlay.className = "overlay";
    const box = document.createElement("div");
    box.className = "dialog";
    box.innerHTML = `<h2>Wer hat's erledigt?</h2><p class="muted small">„${escapeHtml(task.text)}"</p>`;
    const list = document.createElement("div");
    list.className = "employee-list";
    for (const shift of openShifts) {
      const emp = store.getEmployee(shift.employeeId);
      const btn = document.createElement("button");
      btn.className = "btn btn-secondary btn-huge";
      btn.textContent = emp?.name || "?";
      btn.onclick = () => {
        store.toggleDayTask(day.id, task.id, emp?.name || null);
        overlay.remove();
        rerender();
      };
      list.appendChild(btn);
    }
    box.appendChild(list);
    const cancelBtn = document.createElement("button");
    cancelBtn.className = "btn btn-link";
    cancelBtn.textContent = "Abbrechen";
    cancelBtn.onclick = () => overlay.remove();
    box.appendChild(cancelBtn);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
  }

  // ---------------------------------------------------------------------
  // PIN-Overlay: Ein-/Ausstempeln, ohne die Übersicht dahinter zu verlassen.
  // ---------------------------------------------------------------------
  function openPinOverlay() {
    let pin = "";
    let error = "";
    let greetEmployee = null; // erkannt, wartet noch auf "Schicht starten?"-Bestätigung

    const overlay = document.createElement("div");
    overlay.className = "overlay";
    const box = document.createElement("div");
    box.className = "dialog pin-dialog";
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    function renderBox() {
      box.innerHTML = "";
      box.appendChild(greetEmployee ? buildGreetBox() : buildPadBox());
    }

    function buildPadBox() {
      const frag = document.createElement("div");
      frag.innerHTML = `<h2>PIN eingeben</h2>`;
      frag.appendChild(buildPinDots(pin));
      if (error) {
        const err = document.createElement("div");
        err.className = "callout callout-warn kiosk-error";
        err.textContent = error;
        frag.appendChild(err);
      }
      frag.appendChild(buildPinKeypad(handleKey));
      const cancelBtn = document.createElement("button");
      cancelBtn.className = "btn btn-link";
      cancelBtn.textContent = "Abbrechen";
      cancelBtn.onclick = () => overlay.remove();
      frag.appendChild(cancelBtn);
      return frag;
    }

    function handleKey(key) {
      error = "";
      if (key === "⌫") {
        pin = pin.slice(0, -1);
        renderBox();
        return;
      }
      if (key === "✓") {
        submitPin();
        return;
      }
      if (pin.length < 8) pin += key;
      renderBox();
    }

    function submitPin() {
      if (pin.length === 0) return;
      const emp = store.findEmployeeByPin(pin);
      if (!emp) {
        error = "PIN nicht erkannt. Bitte noch einmal versuchen.";
        pin = "";
        renderBox();
        return;
      }
      pin = "";
      const openShift = store.getOpenShiftForEmployeeToday(emp.id);
      if (openShift) {
        clockOutFlow(emp);
        return;
      }
      const today = store.getDayByDate(todayStr());
      if (today && today.status === "abgeschlossen") {
        error = "Der heutige Tag ist bereits abgeschlossen (Kassenabschluss erledigt). Bitte an den Admin wenden.";
        renderBox();
        return;
      }
      greetEmployee = emp;
      renderBox();
    }

    function buildGreetBox() {
      const frag = document.createElement("div");
      frag.innerHTML = `<h2>👋 Hallo ${escapeHtml(greetEmployee.name)}!</h2><p class="muted">Schicht jetzt starten?</p>`;
      const startBtn = document.createElement("button");
      startBtn.className = "btn btn-primary btn-huge";
      startBtn.textContent = "▶ Schicht starten";
      startBtn.onclick = () => {
        store.clockIn(greetEmployee.id);
        showBye(greetEmployee.name, "Viel Erfolg im Dienst!");
      };
      frag.appendChild(startBtn);
      const cancelBtn = document.createElement("button");
      cancelBtn.className = "btn btn-link";
      cancelBtn.textContent = "← Abbrechen";
      cancelBtn.onclick = () => {
        greetEmployee = null;
        pin = "";
        renderBox();
      };
      frag.appendChild(cancelBtn);
      return frag;
    }

    async function clockOutFlow(emp) {
      const day = store.getDayByDate(todayStr());
      const shift = store.getOpenShiftForEmployeeToday(emp.id);
      store.clockOut(day.id, shift.id);
      const stillOpen = store.getOpenShiftsToday();
      overlay.remove();
      rerender();
      if (stillOpen.length > 0 || day.status === "abgeschlossen") return;

      // Letzte Person raus -> Tagesabschluss anbieten
      if (!store.allTasksDone(day.id)) {
        await alertDialog(
          "Alle sind ausgestempelt, aber es sind noch Aufgaben offen. Der Tag bleibt vorerst offen, bis die Aufgaben erledigt sind (auf der Übersicht abhaken, dann noch einmal einstempeln/ausstempeln)."
        );
        return;
      }
      const wantsClose = await confirmDialog("Alle sind jetzt ausgestempelt. Jetzt den Tag abschließen (Kassenabschluss)?", {
        title: "Tag abschließen?",
        okLabel: "Ja, abschließen",
        cancelLabel: "Später",
      });
      if (wantsClose) navigate(`day/${day.id}`);
    }

    function showBye(name, suffix) {
      box.innerHTML = `<h2>👋 ${escapeHtml(name)}</h2><p class="muted">${escapeHtml(suffix)}</p>`;
      rerender(); // Übersicht dahinter (z.B. "Im Dienst"-Liste) sofort aktualisieren
      setTimeout(() => overlay.remove(), 1200);
    }

    renderBox();
  }

  rerender();
  return container;
}

export { renderKiosk };
