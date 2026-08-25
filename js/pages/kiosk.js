// ============================================================================
// pages/kiosk.js – Startbildschirm des gemeinsamen Geräts: für jede aktuell
// eingestempelte Person ein eigenes Panel mit ihren zugeordneten Aufgaben.
// Mehrere Personen können gleichzeitig eingestempelt sein und unabhängig
// voneinander abhaken/ausstempeln. Ausstempeln ist erst möglich, wenn die
// eigenen Aufgaben erledigt oder weitergegeben wurden. Ein-/Ausstempeln läuft
// über ein kleines PIN-Overlay (nur zum Einstempeln nötig – Ausstempeln
// passiert direkt im eigenen Panel). Der Admin-Bereich ist über einen eigenen
// Button erreichbar.
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

  // Neue Telegram-Aufgaben sofort abholen und danach im Leerlauf regelmäßig weiter prüfen, Übersicht
  // danach neu zeichnen. Vorheriges Intervall (von einem früheren Kiosk-Aufruf) beenden.
  if (activeSyncInterval) clearInterval(activeSyncInterval);
  const syncTick = () => maybeSyncPendingTasks().then(rerender, rerender);
  syncTick();
  activeSyncInterval = setInterval(syncTick, TASK_SYNC_INTERVAL_MS);

  function rerender() {
    container.innerHTML = "";
    container.appendChild(buildPage());
  }

  function buildPage() {
    const wrap = document.createElement("div");

    const now = new Date();
    const hour = now.getHours();
    const greeting = hour < 11 ? "Guten Morgen" : hour < 18 ? "Hallo" : "Guten Abend";
    const head = document.createElement("div");
    head.innerHTML = `<p class="muted small kiosk-greeting">${greeting} ☕</p><h1>Aktuelle Schicht</h1>`;
    wrap.appendChild(head);

    const pinBtn = document.createElement("button");
    pinBtn.className = "btn btn-primary btn-huge";
    pinBtn.textContent = "🔢 PIN eingeben zum Einstempeln";
    pinBtn.onclick = () => openPinOverlay();
    wrap.appendChild(pinBtn);

    const today = store.getDayByDate(todayStr());
    const openShifts = store.getOpenShiftsToday();

    if (openShifts.length === 0) {
      const empty = document.createElement("div");
      empty.className = "empty-state";
      empty.textContent = "Aktuell niemand eingestempelt.";
      wrap.appendChild(empty);
    } else {
      for (const shift of openShifts) {
        wrap.appendChild(buildPersonPanel(today, shift));
      }
    }

    const adminBtn = document.createElement("button");
    adminBtn.className = "btn btn-link kiosk-admin-link";
    adminBtn.textContent = "🔒 Admin";
    adminBtn.onclick = () => navigate("admin");
    wrap.appendChild(adminBtn);

    return wrap;
  }

  // ---------------------------------------------------------------------
  // Ein Panel pro eingestempelter Person: ihre zugeordneten Aufgaben (müssen
  // erledigt/weitergegeben sein, bevor sie ausstempeln kann) + allgemeine
  // Aufgaben (jeder kann abhaken, blockiert das Ausstempeln nicht).
  // ---------------------------------------------------------------------
  function buildPersonPanel(day, shift) {
    const emp = store.getEmployee(shift.employeeId);
    const card = document.createElement("section");
    card.className = "card card-highlight";
    card.innerHTML = `<h2>👤 ${escapeHtml(emp?.name || "?")} <span class="muted small">· seit ${escapeHtml(shift.from)} Uhr</span></h2>`;

    const mine = day.tasks.filter((t) => t.assignedTo === emp.id);
    const general = day.tasks.filter((t) => !t.assignedTo);

    if (mine.length > 0) {
      const mineHead = document.createElement("p");
      mineHead.className = "muted small";
      mineHead.style.margin = "0";
      mineHead.innerHTML = "<b>Deine Aufgaben</b>";
      card.appendChild(mineHead);
      card.appendChild(buildTaskList(day, mine, emp, true));
    }

    if (general.length > 0) {
      const genHead = document.createElement("p");
      genHead.className = "muted small";
      genHead.style.margin = "0";
      genHead.innerHTML = "<b>Allgemeine Aufgaben</b>";
      card.appendChild(genHead);
      card.appendChild(buildTaskList(day, general, emp, false));
    }

    if (mine.length === 0 && general.length === 0) {
      const empty = document.createElement("p");
      empty.className = "muted small";
      empty.textContent = "Keine Aufgaben.";
      card.appendChild(empty);
    }

    const openMine = mine.filter((t) => !t.done);
    const endBtn = document.createElement("button");
    endBtn.className = "btn btn-primary btn-huge";
    endBtn.disabled = openMine.length > 0;
    endBtn.textContent = openMine.length > 0 ? `Noch ${openMine.length} eigene Aufgabe(n) offen` : "🚪 Schicht beenden";
    endBtn.onclick = () => clockOutFlow(day, emp, shift);
    card.appendChild(endBtn);
    if (openMine.length > 0) {
      const hint = document.createElement("p");
      hint.className = "muted small";
      hint.textContent = "Erst abhaken oder weitergeben, dann kannst du dich ausstempeln.";
      card.appendChild(hint);
    }

    return card;
  }

  function buildTaskList(day, tasks, viewerEmp, allowHandoff) {
    const list = document.createElement("div");
    list.className = "task-list";
    const priorityOrder = { hoch: 0, normal: 1, niedrig: 2 };
    const sorted = [...tasks].sort((a, b) => (priorityOrder[a.priority] ?? 1) - (priorityOrder[b.priority] ?? 1));
    for (const task of sorted) {
      const row = document.createElement("label");
      row.className = "task-row" + (task.done ? " done" : "");
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = task.done;
      cb.onchange = () => {
        store.toggleDayTask(day.id, task.id, task.done ? null : viewerEmp.name);
        rerender();
      };
      row.appendChild(cb);
      const textWrap = document.createElement("div");
      textWrap.className = "task-row-text";
      const span = document.createElement("span");
      span.textContent = (task.priority === "hoch" ? "🔴 " : task.priority === "niedrig" ? "🔵 " : "") + task.text;
      textWrap.appendChild(span);
      if (task.handoffFrom) {
        const tag = document.createElement("span");
        tag.className = "muted small task-row-meta";
        tag.textContent = `↩ übergeben von ${task.handoffFrom}`;
        textWrap.appendChild(tag);
      }
      if (task.done && task.doneBy) {
        const meta = document.createElement("span");
        meta.className = "muted small task-row-meta";
        meta.textContent = `✓ erledigt von ${task.doneBy}${task.doneAt ? ", " + new Date(task.doneAt).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" }) + " Uhr" : ""}`;
        textWrap.appendChild(meta);
      }
      row.appendChild(textWrap);
      if (allowHandoff && !task.done) {
        const handoffBtn = document.createElement("button");
        handoffBtn.type = "button";
        handoffBtn.className = "btn btn-secondary task-row-handoff";
        handoffBtn.textContent = "↪ Weitergeben";
        handoffBtn.onclick = (e) => {
          e.preventDefault();
          e.stopPropagation();
          openHandoffPicker(day, task, viewerEmp);
        };
        row.appendChild(handoffBtn);
      }
      list.appendChild(row);
    }
    return list;
  }

  function openHandoffPicker(day, task, fromEmp) {
    const others = store.getEmployees(false).filter((e) => e.id !== fromEmp.id);
    const overlay = document.createElement("div");
    overlay.className = "overlay";
    const box = document.createElement("div");
    box.className = "dialog";
    box.innerHTML = `<h2>Weitergeben an?</h2><p class="muted small">„${escapeHtml(task.text)}" wird der ausgewählten Person zugeordnet.</p>`;
    if (others.length === 0) {
      const empty = document.createElement("p");
      empty.className = "muted small";
      empty.textContent = "Keine anderen aktiven Mitarbeiter vorhanden.";
      box.appendChild(empty);
    } else {
      const list = document.createElement("div");
      list.className = "employee-list";
      for (const other of others) {
        const btn = document.createElement("button");
        btn.className = "btn btn-secondary btn-huge";
        btn.textContent = other.name;
        btn.onclick = () => {
          store.handoffTask(day.id, task.id, other.id, fromEmp.name);
          overlay.remove();
          rerender();
        };
        list.appendChild(btn);
      }
      box.appendChild(list);
    }
    const cancelBtn = document.createElement("button");
    cancelBtn.className = "btn btn-link";
    cancelBtn.textContent = "Abbrechen";
    cancelBtn.onclick = () => overlay.remove();
    box.appendChild(cancelBtn);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
  }

  async function clockOutFlow(day, emp, shift) {
    const stillOpenMine = day.tasks.filter((t) => t.assignedTo === emp.id && !t.done);
    if (stillOpenMine.length > 0) return; // Sicherheitsnetz, Button ist eigentlich schon disabled
    store.clockOut(day.id, shift.id);
    rerender();
    const stillOpen = store.getOpenShiftsToday();
    if (stillOpen.length > 0 || day.status === "abgeschlossen") return;

    // Letzte Person raus -> Tagesabschluss anbieten
    if (!store.allTasksDone(day.id)) {
      await alertDialog(
        "Alle sind ausgestempelt, aber es sind noch allgemeine Aufgaben offen. Der Tag bleibt vorerst offen, bis die Aufgaben erledigt sind."
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

  // ---------------------------------------------------------------------
  // PIN-Overlay: nur zum Einstempeln. Ausstempeln passiert direkt im eigenen Panel.
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
        error = `${emp.name} ist schon im Dienst – siehe eigenes Panel oben.`;
        renderBox();
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
        overlay.remove();
        rerender();
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

    renderBox();
  }

  rerender();
  return container;
}

export { renderKiosk };
