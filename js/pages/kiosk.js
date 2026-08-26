// ============================================================================
// pages/kiosk.js – Startbildschirm des gemeinsamen Geräts.
//
// Leerlauf: einfaches PIN-Feld zum Einstempeln + darunter, wer gerade im
// Dienst ist. Tippt man auf eine im Dienst stehende Person, muss deren PIN
// noch einmal eingegeben werden – dann öffnet sich ihr eigenes Fenster
// (Stunden/Trinkgeld-Übersicht + Aufgaben + Ausstempeln). Über "Zurück"
// schließt sich dieses Fenster wieder, ohne auszustempeln, und man landet
// wieder auf dem Leerlauf-Bildschirm.
//
// Ausstempeln ist erst möglich, wenn die eigenen zugeordneten Aufgaben
// abgehakt/weitergegeben sind. Ist man zusätzlich die letzte im Dienst
// verbliebene Person, müssen auch alle allgemeinen Aufgaben erledigt sein –
// danach geht es automatisch weiter zum Kassenabschluss.
// ============================================================================
import { store } from "../store.js";
import { escapeHtml, todayStr, euro, hours } from "../format.js";
import { buildPinDots, buildPinKeypad } from "../pinpad.js";
import { maybeSyncPendingTasks, sendNoteToBoss, pushAvailability } from "../taskSync.js";
import { alertDialog } from "../dialog.js";
import { computeRange } from "../calc.js";

const TASK_SYNC_INTERVAL_MS = 90 * 1000;
let activeSyncInterval = null; // es darf immer nur ein Leerlauf-Sync-Intervall gleichzeitig laufen

const WEEKDAY_LABELS = ["Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag", "Sonntag"];

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
  return `${d}.${m}.${y}`;
}
function weekdayIndexOf(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0=So..6=Sa
  return wd === 0 ? 6 : wd - 1; // Mo=0..So=6
}

function renderKiosk(navigate) {
  const container = document.createElement("div");
  container.className = "page kiosk-page";

  let view = "idle"; // "idle" | "personal"
  let personalEmployee = null;
  let pin = "";
  let error = "";
  let greetEmployee = null; // erkannt am Leerlauf-Pad, wartet auf "Schicht starten?"-Bestätigung
  const wantsToEditWeek = new Set(); // "empId:weekStart", die nach "Chef anfragen" nochmal bearbeiten wollen

  // Neue Telegram-Aufgaben abholen, Leerlauf-Bildschirm danach neu zeichnen (falls gerade sichtbar).
  // Vorheriges Intervall (von einem früheren Kiosk-Aufruf) beenden, damit sich nichts aufsummiert.
  if (activeSyncInterval) clearInterval(activeSyncInterval);
  const syncTick = () => maybeSyncPendingTasks().then(rerenderIfIdle, rerenderIfIdle);
  syncTick();
  activeSyncInterval = setInterval(syncTick, TASK_SYNC_INTERVAL_MS);

  function rerender() {
    container.innerHTML = "";
    container.appendChild(view === "personal" && personalEmployee ? buildPersonalWindow(personalEmployee) : buildIdle());
  }
  function rerenderIfIdle() {
    if (view === "idle") rerender();
  }

  // ---------------------------------------------------------------------
  // Leerlauf-Bildschirm: PIN-Feld + wer im Dienst ist
  // ---------------------------------------------------------------------
  function buildIdle() {
    if (greetEmployee) return buildGreet();

    const wrap = document.createElement("div");
    wrap.className = "kiosk-wrap";

    const now = new Date();
    const hour = now.getHours();
    const greeting = hour < 11 ? "Guten Morgen" : hour < 18 ? "Hallo" : "Guten Abend";
    wrap.innerHTML = `
      <div class="kiosk-head">
        <div class="kiosk-greeting">${greeting} ☕</div>
        <h1>PIN eingeben zum Ein-/Ausstempeln</h1>
      </div>
    `;

    wrap.appendChild(buildPinDots(pin));

    if (error) {
      const errBox = document.createElement("div");
      errBox.className = "callout callout-warn kiosk-error";
      errBox.textContent = error;
      wrap.appendChild(errBox);
    }

    wrap.appendChild(buildPinKeypad(handleKey));

    const openShifts = store.getOpenShiftsToday();
    const shiftCard = document.createElement("section");
    shiftCard.className = "card kiosk-inservice-card";
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
        if (!emp) continue;
        const btn = document.createElement("button");
        btn.className = "employee-row kiosk-inservice-row";
        btn.innerHTML = `<div class="employee-main"><b>${escapeHtml(emp.name)}</b><span class="muted small">seit ${escapeHtml(shift.from)} Uhr</span></div>`;
        btn.onclick = () => openVerifyOverlay(emp);
        list.appendChild(btn);
      }
      shiftCard.appendChild(list);
    }
    wrap.appendChild(shiftCard);

    const adminBtn = document.createElement("button");
    adminBtn.className = "btn btn-link kiosk-admin-link";
    adminBtn.textContent = "🔒 Admin";
    adminBtn.onclick = () => navigate("admin");
    wrap.appendChild(adminBtn);

    return wrap;
  }

  function handleKey(key) {
    error = "";
    if (key === "⌫") {
      pin = pin.slice(0, -1);
      rerender();
      return;
    }
    if (key === "✓") {
      submitPin();
      return;
    }
    if (pin.length < 8) pin += key;
    rerender();
  }

  function submitPin() {
    if (pin.length === 0) return;
    const emp = store.findEmployeeByPin(pin);
    if (!emp) {
      error = "PIN nicht erkannt. Bitte noch einmal versuchen.";
      pin = "";
      rerender();
      return;
    }
    pin = "";
    error = "";
    const openShift = store.getOpenShiftForEmployeeToday(emp.id);
    if (openShift) {
      openPersonal(emp);
      return;
    }
    const today = store.getDayByDate(todayStr());
    if (today && today.status === "abgeschlossen") {
      error = "Der heutige Tag ist bereits abgeschlossen (Kassenabschluss erledigt). Bitte an den Admin wenden.";
      rerender();
      return;
    }
    greetEmployee = emp;
    rerender();
  }

  function buildGreet() {
    const wrap = document.createElement("div");
    wrap.className = "kiosk-wrap";
    wrap.innerHTML = `
      <div class="kiosk-greet-card card card-highlight">
        <div class="kiosk-greet-emoji">👋</div>
        <h1>Hallo ${escapeHtml(greetEmployee.name)}!</h1>
        <p class="muted">Schicht jetzt starten?</p>
      </div>
    `;
    const startBtn = document.createElement("button");
    startBtn.className = "btn btn-primary btn-huge";
    startBtn.textContent = "▶ Schicht starten";
    startBtn.onclick = () => {
      const emp = greetEmployee;
      greetEmployee = null;
      store.clockIn(emp.id);
      openPersonal(emp);
    };
    wrap.appendChild(startBtn);

    const cancelBtn = document.createElement("button");
    cancelBtn.className = "btn btn-link";
    cancelBtn.textContent = "← Abbrechen";
    cancelBtn.onclick = () => {
      greetEmployee = null;
      rerender();
    };
    wrap.appendChild(cancelBtn);

    return wrap;
  }

  function openPersonal(emp) {
    personalEmployee = emp;
    view = "personal";
    rerender();
    showUnreadNotifications(emp); // absichtlich nicht awaited, läuft als Pop-up-Kette über der Ansicht
  }

  /** Zeigt neue Nachrichten vom Chef (z.B. "Schicht bestätigt") als Pop-up, einmal pro Öffnen des Fensters. */
  async function showUnreadNotifications(emp) {
    const unread = store.getUnreadNotifications(emp.id);
    for (const n of unread) {
      await alertDialog(n.text, { title: "📬 Nachricht vom Chef" });
      store.markNotificationRead(n.id);
    }
  }

  // ---------------------------------------------------------------------
  // Kleines PIN-Overlay, um Zugriff auf das eigene Fenster einer bereits
  // eingestempelten Person zu bestätigen (Tippen auf den Namen reicht nicht).
  // ---------------------------------------------------------------------
  function openVerifyOverlay(emp) {
    let vpin = "";
    let verr = "";

    const overlay = document.createElement("div");
    overlay.className = "overlay";
    const box = document.createElement("div");
    box.className = "dialog pin-dialog";
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    function renderBox() {
      box.innerHTML = "";
      box.innerHTML = `<h2>PIN von ${escapeHtml(emp.name)}</h2>`;
      box.appendChild(buildPinDots(vpin));
      if (verr) {
        const err = document.createElement("div");
        err.className = "callout callout-warn kiosk-error";
        err.textContent = verr;
        box.appendChild(err);
      }
      box.appendChild(buildPinKeypad(handleVerifyKey));
      const cancelBtn = document.createElement("button");
      cancelBtn.className = "btn btn-link";
      cancelBtn.textContent = "Abbrechen";
      cancelBtn.onclick = () => overlay.remove();
      box.appendChild(cancelBtn);
    }

    function handleVerifyKey(key) {
      verr = "";
      if (key === "⌫") {
        vpin = vpin.slice(0, -1);
        renderBox();
        return;
      }
      if (key === "✓") {
        if (String(vpin) === String(emp.pin)) {
          overlay.remove();
          openPersonal(emp);
        } else {
          verr = "PIN stimmt nicht überein.";
          vpin = "";
          renderBox();
        }
        return;
      }
      if (vpin.length < 8) vpin += key;
      renderBox();
    }

    renderBox();
  }

  // ---------------------------------------------------------------------
  // Eigenes Fenster einer eingestempelten Person: Übersicht + Aufgaben + Ausstempeln
  // ---------------------------------------------------------------------
  function buildPersonalWindow(emp) {
    const wrap = document.createElement("div");
    const day = store.getDayByDate(todayStr());
    const shift = store.getOpenShiftForEmployeeToday(emp.id);

    if (!day || !shift) {
      // Kann eigentlich nicht passieren (nur erreichbar über eingestempelte Person) – Sicherheitsnetz.
      view = "idle";
      return buildIdle();
    }

    const head = document.createElement("div");
    head.className = "session-head";
    const backBtn = document.createElement("button");
    backBtn.className = "btn btn-link";
    backBtn.textContent = "← Zurück";
    backBtn.onclick = () => {
      view = "idle";
      personalEmployee = null;
      rerender();
    };
    head.appendChild(backBtn);
    const h1 = document.createElement("h1");
    h1.textContent = `Hallo ${emp.name}`;
    head.appendChild(h1);
    wrap.appendChild(head);

    // ---- Persönliche Übersicht ----
    const overviewCard = document.createElement("section");
    overviewCard.className = "card";
    const elapsedMin = Math.max(0, Math.round((Date.now() - new Date(shift.clockInAt).getTime()) / 60000));
    const elapsedLabel = `${Math.floor(elapsedMin / 60)} Std ${elapsedMin % 60} Min`;
    const settings = store.getSettings();
    const weekStart = mondayOf(todayStr());
    const weekRange = computeRange(store.getDays(), store.getEmployees(), settings, weekStart, todayStr());
    const myWeek = weekRange.rows.find((r) => r.employee.id === emp.id);
    const monthStart = todayStr().slice(0, 7) + "-01";
    const monthRange = computeRange(store.getDays(), store.getEmployees(), settings, monthStart, todayStr());
    const myMonth = monthRange.rows.find((r) => r.employee.id === emp.id);
    overviewCard.innerHTML = `
      <h2>Deine Übersicht</h2>
      <div class="summary-line"><span>Im Dienst seit</span><span>${escapeHtml(shift.from)} Uhr (${elapsedLabel})</span></div>
      <div class="summary-line"><span>Diese Woche · Stunden</span><span>${hours(myWeek?.hours || 0)}</span></div>
      <div class="summary-line"><span>Diese Woche · Lohn</span><span>${euro(myWeek?.lohn || 0)}</span></div>
      <div class="summary-line"><span>Diese Woche · Trinkgeld</span><span>${euro(myWeek?.tip || 0)}</span></div>
      <div class="summary-line"><span>Dieser Monat · Stunden</span><span>${hours(myMonth?.hours || 0)}</span></div>
      <div class="summary-line"><span>Dieser Monat · Lohn</span><span>${euro(myMonth?.lohn || 0)}</span></div>
      ${
        emp.isMinijob
          ? `<div class="summary-line"><span>Noch bis zur Minijob-Grenze</span><span>${euro(Math.max(0, (emp.minijobLimit || 556) - (myMonth?.lohn || 0)))}</span></div>`
          : ""
      }
    `;
    wrap.appendChild(overviewCard);

    // ---- Aufgaben ----
    const mine = day.tasks.filter((t) => t.assignedTo === emp.id);
    const general = day.tasks.filter((t) => !t.assignedTo);

    const tasksCard = document.createElement("section");
    tasksCard.className = "card";
    tasksCard.innerHTML = `<h2>📋 Aufgaben heute</h2>`;
    if (mine.length === 0 && general.length === 0) {
      const empty = document.createElement("p");
      empty.className = "muted small";
      empty.textContent = "Keine Aufgaben für heute.";
      tasksCard.appendChild(empty);
    } else {
      if (mine.length > 0) {
        const subHead = document.createElement("p");
        subHead.className = "muted small";
        subHead.style.margin = "0";
        subHead.innerHTML = "<b>Deine Aufgaben</b>";
        tasksCard.appendChild(subHead);
        tasksCard.appendChild(buildTaskList(day, mine, emp, true));
      }
      if (general.length > 0) {
        const subHead = document.createElement("p");
        subHead.className = "muted small";
        subHead.style.margin = "0";
        subHead.innerHTML = "<b>Allgemeine Aufgaben</b>";
        tasksCard.appendChild(subHead);
        tasksCard.appendChild(buildTaskList(day, general, emp, false));
      }
    }
    wrap.appendChild(tasksCard);

    // ---- Deine Schichten (Wochenplan) ----
    wrap.appendChild(buildShiftsCard(emp));

    // ---- Vorräte ----
    wrap.appendChild(buildStockCard(emp));

    const inboxCfg = store.getTaskInboxConfig();
    const inboxUsable = inboxCfg.enabled && inboxCfg.workerUrl && inboxCfg.workerSecret;

    // ---- Verfügbarkeit für nächste Woche (nur wenn Telegram-Abgleich eingerichtet, sonst käme sie nirgends an) ----
    if (inboxUsable) {
      const weekStart = addDaysISO(mondayOf(todayStr()), 7);
      const editKey = emp.id + ":" + weekStart;
      const alreadySubmitted = weekHasSubmission(emp, weekStart);
      wrap.appendChild(
        alreadySubmitted && !wantsToEditWeek.has(editKey) ? buildAvailabilitySummaryCollapsed(emp, weekStart) : buildAvailabilityCard(emp)
      );
    }

    // ---- Notiz an den Chef ----
    if (inboxUsable) {
      const noteCard = document.createElement("section");
      noteCard.className = "card";
      noteCard.innerHTML = `<h2>📝 Notiz an den Chef</h2><p class="muted small">Geht direkt per Telegram raus, z.B. "Minze bestellen".</p>`;
      const noteRow = document.createElement("div");
      noteRow.className = "task-add-row";
      const noteInput = document.createElement("input");
      noteInput.type = "text";
      noteInput.placeholder = "Nachricht…";
      const noteBtn = document.createElement("button");
      noteBtn.className = "btn btn-secondary";
      noteBtn.textContent = "Senden";
      const sendNote = async () => {
        const text = noteInput.value.trim();
        if (!text) return;
        noteBtn.disabled = true;
        try {
          await sendNoteToBoss(emp.name, text);
          noteInput.value = "";
          await alertDialog("Notiz gesendet.");
        } catch (e) {
          await alertDialog("Konnte nicht gesendet werden: " + e.message, { title: "Fehler" });
        }
        noteBtn.disabled = false;
      };
      noteBtn.onclick = sendNote;
      noteInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") sendNote();
      });
      noteRow.appendChild(noteInput);
      noteRow.appendChild(noteBtn);
      noteCard.appendChild(noteRow);
      wrap.appendChild(noteCard);
    }

    // ---- Ausstempeln ----
    const openMine = mine.filter((t) => !t.done);
    const otherOpenShifts = store.getOpenShiftsToday().filter((s) => s.id !== shift.id);
    const wouldBeLast = otherOpenShifts.length === 0;
    const allDone = store.allTasksDone(day.id);
    const blocked = openMine.length > 0 || (wouldBeLast && !allDone);

    const endBtn = document.createElement("button");
    endBtn.className = "btn btn-primary btn-huge";
    endBtn.disabled = blocked;
    endBtn.textContent = "🚪 Schicht beenden";
    endBtn.onclick = () => endShift(day, emp, shift, wouldBeLast);
    wrap.appendChild(endBtn);

    if (blocked) {
      const hint = document.createElement("p");
      hint.className = "muted small";
      hint.textContent =
        openMine.length > 0
          ? "Erst deine Aufgaben abhaken oder weitergeben, dann kannst du dich ausstempeln."
          : "Du bist die Letzte/der Letzte im Dienst – erst müssen alle Aufgaben erledigt sein, bevor es zum Kassenabschluss geht.";
      wrap.appendChild(hint);
    }

    return wrap;
  }

  // ---------------------------------------------------------------------
  // Vorräte: einfache Ampel pro Artikel (kein Mengen-Tracking) – jede Person kann während der Schicht
  // melden, wenn etwas knapp wird oder leer ist. Landet beim nächsten Sync als Einkaufsliste beim Chef.
  // ---------------------------------------------------------------------
  const STOCK_STATUS_LABEL = { ok: "Ok", knapp: "Wird knapp", leer: "Leer" };
  function buildStockCard(emp) {
    const items = store.getStockItems();
    const card = document.createElement("section");
    card.className = "card";
    card.innerHTML = `<h2>📦 Vorräte</h2>`;
    if (items.length === 0) {
      const empty = document.createElement("p");
      empty.className = "muted small";
      empty.textContent = "Noch keine Artikel hinterlegt (Admin → Vorräte).";
      card.appendChild(empty);
      return card;
    }
    const list = document.createElement("div");
    list.className = "stock-list";
    for (const item of items) {
      const row = document.createElement("div");
      row.className = "stock-row";
      const label = document.createElement("div");
      label.className = "stock-name";
      label.textContent = item.name;
      row.appendChild(label);
      const toggles = document.createElement("div");
      toggles.className = "stock-toggle";
      for (const status of ["ok", "knapp", "leer"]) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = `stock-status-btn stock-${status}` + (item.status === status ? " active" : "");
        btn.textContent = STOCK_STATUS_LABEL[status];
        btn.onclick = () => {
          store.setStockStatus(item.id, status, emp.name);
          rerender();
        };
        toggles.appendChild(btn);
      }
      row.appendChild(toggles);
      list.appendChild(row);
    }
    card.appendChild(list);
    return card;
  }

  // ---------------------------------------------------------------------
  // Deine Schichten: geplante Schichten (aus CSV-Upload oder vom Bot per
  // Wochenplan-Nachricht eingetragen) für die kommenden Tage – reine Anzeige.
  // ---------------------------------------------------------------------
  function buildShiftsCard(emp) {
    const card = document.createElement("section");
    card.className = "card";
    card.innerHTML = `<h2>📅 Deine Schichten</h2>`;
    const upcoming = store.getPlannedShiftsFrom(emp.id, todayStr()).slice(0, 14);
    if (upcoming.length === 0) {
      const empty = document.createElement("p");
      empty.className = "muted small";
      empty.textContent = "Für die kommenden Tage sind noch keine Schichten für dich eingetragen.";
      card.appendChild(empty);
    } else {
      const list = document.createElement("div");
      list.className = "task-list";
      for (const s of upcoming) {
        const row = document.createElement("div");
        row.className = "summary-line";
        const label = s.date === todayStr() ? "Heute" : `${WEEKDAY_LABELS[weekdayIndexOf(s.date)]}, ${dateDeShort(s.date)}`;
        const statusTag = s.bossConfirmed === true ? " ✅ bestätigt" : s.bossConfirmed === false ? " ⏳ wartet auf Bestätigung" : "";
        row.innerHTML = `<span>${escapeHtml(label)}</span><span>${escapeHtml(s.from)}–${escapeHtml(s.to)} Uhr${statusTag}</span>`;
        list.appendChild(row);
      }
      card.appendChild(list);
    }
    return card;
  }

  /** true, wenn für diese Zielwoche schon mindestens ein Tag "abgeschickt" wurde. */
  function weekHasSubmission(emp, weekStart) {
    for (let i = 0; i < 7; i++) {
      const date = addDaysISO(weekStart, i);
      const dayObj = store.getDayByDate(date);
      const entry = dayObj ? store.getAvailability(dayObj.id, emp.id) : null;
      if (entry?.submittedAt) return true;
    }
    return false;
  }

  /** Kompakte Ansicht, sobald für die Woche schon gesendet wurde – die große Auswahl bleibt zu, damit man
   * sie nicht aus Versehen nochmal verändert. Änderungswunsch geht ausdrücklich über eine Anfrage an den Chef. */
  function buildAvailabilitySummaryCollapsed(emp, weekStart) {
    const card = document.createElement("section");
    card.className = "card";
    card.innerHTML = `<h2>🗓 Verfügbarkeit für nächste Woche</h2><p class="muted small">Gesendet – deine Schichten dazu stehen oben bei „Deine Schichten". Möchtest du noch etwas ändern, frag den Chef.</p>`;
    const btn = document.createElement("button");
    btn.className = "btn btn-secondary";
    btn.textContent = "💬 Chef anfragen für Schichtänderung";
    btn.onclick = async () => {
      btn.disabled = true;
      // Auswahl öffnet sich in jedem Fall wieder (sonst hängt die Person fest, falls die Nachricht mal
      // nicht rausgeht) – nur die Erfolgs-/Fehlermeldung zur Chef-Benachrichtigung unterscheidet sich.
      wantsToEditWeek.add(emp.id + ":" + weekStart);
      try {
        await sendNoteToBoss(emp.name, `Möchte die Verfügbarkeit für die Woche ab ${dateDeShort(weekStart)} noch ändern.`);
        rerender();
      } catch (e) {
        rerender();
        await alertDialog("Auswahl ist wieder offen, aber die Nachricht an den Chef kam nicht durch: " + e.message, { title: "Fehler" });
      }
    };
    card.appendChild(btn);
    return card;
  }

  // ---------------------------------------------------------------------
  // Verfügbarkeit für die kommende Woche: pro Tag beliebig viele Schichten antippen,
  // für die man bereitstehen würde. Genau EINE Schicht ausgewählt = sofort fest (für
  // alle anderen ab da ausgegraut); mehrere = "keine Präferenz", bleibt offen, bis der
  // Chef entscheidet oder sich die Auswahl durch anderweitige Vergabe automatisch auf
  // eine reduziert. Auswahl passiert erst als Entwurf (nur lokal sichtbar), verbindlich
  // wird sie erst mit "An den Chef senden". Manche Schichten gelten nur an bestimmten
  // Wochentagen (z.B. Spät nur Mi-Sa) – pro Tag wird daher neu ermittelt, was angeboten wird.
  // ---------------------------------------------------------------------
  function buildAvailabilityCard(emp) {
    const weekStart = addDaysISO(mondayOf(todayStr()), 7);
    const weekEnd = addDaysISO(weekStart, 6);
    const allSlotDefs = store.getShiftSlotsForRole(emp.role); // ungefiltert, für Namen-Nachschlagen egal an welchem Tag
    const slotById = new Map(allSlotDefs.map((s) => [s.id, s]));

    const card = document.createElement("section");
    card.className = "card";
    card.innerHTML = `
      <h2>🗓 Verfügbarkeit für nächste Woche</h2>
      <p class="muted small">${escapeHtml(dateDeShort(weekStart))} – ${escapeHtml(dateDeShort(weekEnd))}. Für jede Schicht antippen, die du übernehmen könntest (bei keiner Präferenz einfach alle). Wählst du nur eine, ist sie sofort fest deine – bei mehreren entscheidet der Chef.</p>
    `;

    const list = document.createElement("div");
    list.className = "avail-list";
    for (let i = 0; i < 7; i++) {
      const date = addDaysISO(weekStart, i);
      const dayDefSlots = store.getShiftSlotsForRole(emp.role, date); // an diesem Wochentag angebotene Schichten
      const dayObj = store.getDayByDate(date);
      const entry = dayObj ? store.getAvailability(dayObj.id, emp.id) : null;
      const draftSelected = new Set(entry?.slotIds || []);
      const selectableSlots = dayDefSlots.filter((s) => !(dayObj && store.isSlotTaken(dayObj.id, s.id, emp.id)));
      const allSelected = selectableSlots.length > 0 && selectableSlots.every((s) => draftSelected.has(s.id));

      const row = document.createElement("div");
      row.className = "avail-row-col";

      const head = document.createElement("div");
      head.className = "avail-day-head";
      const label = document.createElement("div");
      label.className = "avail-day-label";
      label.textContent = `${WEEKDAY_LABELS[i]}, ${dateDeShort(date)}`;
      head.appendChild(label);
      const allBtn = document.createElement("button");
      allBtn.type = "button";
      allBtn.className = "btn btn-link avail-all-btn";
      if (selectableSlots.length === 0) {
        allBtn.textContent = "Alle vergeben";
        allBtn.disabled = true;
      } else {
        allBtn.textContent = allSelected ? "Keine auswählen" : "Alle auswählen";
        allBtn.onclick = () => {
          const d = store.getOrCreateDayByDate(date);
          store.setAvailabilityDraft(d.id, emp.id, allSelected ? [] : selectableSlots.map((s) => s.id));
          rerender();
        };
      }
      head.appendChild(allBtn);
      row.appendChild(head);

      const slotList = document.createElement("div");
      slotList.className = "avail-slot-list";
      if (dayDefSlots.length === 0) {
        const none = document.createElement("p");
        none.className = "muted small";
        none.textContent = "An diesem Tag gibt es für deine Rolle keine dieser Schichten.";
        slotList.appendChild(none);
      }
      for (const slot of dayDefSlots) {
        const takenByOther = dayObj ? store.isSlotTaken(dayObj.id, slot.id, emp.id) : false;
        const slotBtn = document.createElement("button");
        slotBtn.type = "button";
        slotBtn.className = "avail-slot-btn" + (draftSelected.has(slot.id) ? " active" : "") + (takenByOther ? " taken" : "");
        slotBtn.disabled = takenByOther;
        slotBtn.innerHTML =
          `<b>${escapeHtml(slot.label)}</b><span>${escapeHtml(slot.from)}–${escapeHtml(slot.to)}</span>` +
          (takenByOther ? `<span class="avail-taken-tag">vergeben</span>` : "");
        if (!takenByOther) {
          slotBtn.onclick = () => {
            const d = store.getOrCreateDayByDate(date);
            const current = new Set(store.getAvailability(d.id, emp.id)?.slotIds || []);
            if (current.has(slot.id)) current.delete(slot.id);
            else current.add(slot.id);
            store.setAvailabilityDraft(d.id, emp.id, [...current]);
            rerender();
          };
        }
        slotList.appendChild(slotBtn);
      }
      row.appendChild(slotList);

      // Status der zuletzt abgeschickten Verfügbarkeit für diesen Tag (bis zum nächsten Absenden).
      if (entry?.submittedAt) {
        const status = document.createElement("p");
        status.className = "muted small avail-status";
        if (entry.confirmedSlotId) {
          const slot = slotById.get(entry.confirmedSlotId);
          if (slot) {
            status.innerHTML = entry.bossConfirmed
              ? `✅ <b>${escapeHtml(slot.label)}</b> (${escapeHtml(slot.from)}–${escapeHtml(slot.to)}) ist fest deine Schicht.`
              : `🔶 <b>${escapeHtml(slot.label)}</b> (${escapeHtml(slot.from)}–${escapeHtml(slot.to)}) ist deine Schicht, wartet aber noch auf Bestätigung vom Chef.`;
          }
        } else if (entry.slotIds.length > 1) {
          const labels = entry.slotIds.map((id) => slotById.get(id)?.label).filter(Boolean).join(", ");
          status.textContent = `🕓 Gesendet: ${labels} – noch offen, der Chef entscheidet.`;
        }
        if (status.textContent || status.innerHTML) row.appendChild(status);
      }

      list.appendChild(row);
    }
    card.appendChild(list);

    const submitBtn = document.createElement("button");
    submitBtn.className = "btn btn-primary";
    submitBtn.textContent = "An den Chef senden";
    submitBtn.onclick = () => submitAvailability(weekStart, emp, allSlotDefs, submitBtn);
    card.appendChild(submitBtn);

    return card;
  }

  async function submitAvailability(weekStart, emp, slotDefs, btn) {
    const slotById = new Map(slotDefs.map((s) => [s.id, s]));
    const summaryLines = [];
    const pushDays = [];
    for (let i = 0; i < 7; i++) {
      const date = addDaysISO(weekStart, i);
      const dayObj = store.getDayByDate(date);
      const draftEntry = dayObj ? store.getAvailability(dayObj.id, emp.id) : null;
      if (!draftEntry || draftEntry.slotIds.length === 0) continue;
      const d = store.getOrCreateDayByDate(date);
      const committed = store.commitAvailability(d.id, emp.id, draftEntry.slotIds);
      const dayLabel = `${WEEKDAY_LABELS[i]}, ${dateDeShort(date)}`;
      if (committed.confirmedSlotId) {
        const slot = slotById.get(committed.confirmedSlotId);
        summaryLines.push(
          committed.bossConfirmed
            ? `${dayLabel}: ✅ ${slot.label} (${slot.from}–${slot.to}) fest`
            : `${dayLabel}: 🔶 ${slot.label} (${slot.from}–${slot.to}) – wartet noch auf Bestätigung vom Chef`
        );
      } else if (committed.slotIds.length > 1) {
        const labels = committed.slotIds.map((id) => slotById.get(id)?.label).filter(Boolean).join(", ");
        summaryLines.push(`${dayLabel}: 🕓 ${labels} – noch offen, Chef entscheidet`);
      } else {
        summaryLines.push(`${dayLabel}: leider inzwischen vergeben, bitte andere Schicht wählen`);
      }
      if (committed.slotIds.length > 0) {
        const slots = committed.slotIds.map((id) => slotById.get(id)).filter(Boolean).map((s) => ({ id: s.id, label: s.label, from: s.from, to: s.to }));
        pushDays.push({ date, slots, confirmedSlotId: committed.confirmedSlotId || null, bossConfirmed: !!committed.bossConfirmed });
      }
    }
    if (summaryLines.length === 0) {
      await alertDialog("Bitte für mindestens einen Tag mindestens eine Schicht antippen.");
      return;
    }
    btn.disabled = true;
    let pushError = null;
    try {
      await pushAvailability(emp.name, weekStart, pushDays);
    } catch (e) {
      pushError = e;
    }
    wantsToEditWeek.delete(emp.id + ":" + weekStart); // nach erfolgreichem Senden wieder einklappen
    rerender();
    if (pushError) {
      await alertDialog(["Lokal gespeichert, aber nicht an den Chef gesendet (" + pushError.message + "):", ...summaryLines].join("\n"), { title: "Fehler beim Senden" });
    } else {
      await alertDialog(["Verfügbarkeit gesendet:", ...summaryLines].join("\n"));
    }
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

  function endShift(day, emp, shift, wouldBeLast) {
    store.clockOut(day.id, shift.id);
    if (wouldBeLast && day.status !== "abgeschlossen") {
      navigate(`day/${day.id}`);
      return;
    }
    view = "idle";
    personalEmployee = null;
    rerender();
  }

  rerender();
  return container;
}

export { renderKiosk };
