// ============================================================================
// pages/kiosk.js – Startbildschirm des gemeinsamen Geräts.
//
// Leerlauf: einfaches PIN-Feld zum Einstempeln + darunter, wer gerade im
// Dienst ist. Tippt man auf eine im Dienst stehende Person, muss deren PIN
// noch einmal eingegeben werden – dann öffnet sich ihr eigenes Fenster
// (Stunden/Trinkgeld-Übersicht + Ausstempeln). Über "Zurück" schließt sich
// dieses Fenster wieder, ohne auszustempeln.
//
// Der Kiosk macht bewusst NUR das Stempeln. Aufgabenlisten laufen im Laden
// auf Papier, Schichten werden geplant statt hier gewählt, und gezählt wird
// nicht mehr am Gerät. Alles davon gibt es weiterhin – im Chef-Bereich, am
// Handy und über den Bot –, nur nicht mehr auf dem Bildschirm, an dem jemand
// im Vorbeigehen seinen PIN eintippt.
//
// Entsprechend hält beim Ausstempeln nichts mehr auf: wer fertig ist, geht.
// Eine nicht gestempelte Schicht fehlt in der Abrechnung, und das wäre
// schlimmer als jeder offene Punkt.
// ============================================================================
import { store } from "../store.js";
import { escapeHtml, todayStr, euro, hours } from "../format.js";
import { buildPinDots, buildPinKeypad } from "../pinpad.js";
import { maybeSyncPendingTasks, sendNoteToBoss, sendClockEvent } from "../taskSync.js";
import { alertDialog } from "../dialog.js";
import { buildProduktionsKarten } from "./produktion.js";
import { kann } from "../betrieb.js";
import { computeRange } from "../calc.js";

const TASK_SYNC_INTERVAL_MS = 90 * 1000;

let activeSyncInterval = null; // es darf immer nur ein Leerlauf-Sync-Intervall gleichzeitig laufen


function mondayOf(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const day = dt.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day;
  dt.setUTCDate(dt.getUTCDate() + diff);
  return dt.toISOString().slice(0, 10);
}

function renderKiosk(navigate) {
  // Feste Schichten der kommenden Wochen eintragen, falls das seit dem letzten Abgleich noch niemand
  // getan hat – sonst stuende bei jemandem mit festem Montag "keine Schichten eingetragen".
  store.ergaenzeFesteSchichten();
  const container = document.createElement("div");
  container.className = "page kiosk-page";

  let view = "idle"; // "idle" | "personal"
  let personalEmployee = null;
  let pin = "";
  let error = "";
  let greetEmployee = null; // erkannt am Leerlauf-Pad, wartet auf "Schicht starten?"-Bestätigung
  // Welcher Aufgaben-Abschnitt aufgeklappt ist. undefined = automatisch (was gerade dran ist),

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
      const { shift } = store.clockIn(emp.id);
      sendClockEvent("clock_in", emp.name, shift.from);
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

    // ---- Aufgaben: hier bewusst keine ----
    //
    // Die Aufgabenlisten laufen im Laden wieder auf Papier. Am Kiosk steht deshalb nur noch, was
    // der Kiosk wirklich leisten muss: einstempeln, die eigenen Stunden sehen, ausstempeln.
    // Der Chef-Bereich und die Vorlagen bleiben unveraendert – dort wird weiter gepflegt, was
    // ueber den Bot und den Laptop laeuft.

    // ---- Produktion (nur Küche) ----
    // Bleibt bewusst stehen: das ist keine Aufgabenliste, sondern das Nachhalten, was hergestellt
    // wurde – in welchem Behälter, wie viel, von wem. Darauf laufen die Bestellvorschläge.
    if (kann("produktion") && emp.role === "kueche") {
      for (const karte of buildProduktionsKarten(emp, { onChange: rerender })) wrap.appendChild(karte);
    }

    // Bestand, Wochenplan und Verfuegbarkeit stehen hier bewusst NICHT mehr:
    // Das Einstempeln soll Einstempeln sein. Gezaehlt wird nicht mehr am Kiosk, die Schichten
    // werden geplant und nicht hier gewaehlt, und die Aufgaben laufen auf Papier.

    // ---- Notiz an den Chef ----
    // Nur, wenn der Telegram-Abgleich eingerichtet ist – sonst käme die Notiz nirgends an.
    const inboxCfg = store.getTaskInboxConfig();
    const inboxUsable = inboxCfg.enabled && inboxCfg.workerUrl && inboxCfg.workerSecret;
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
    //
    // Frueher hing das Schichtende daran, dass die eigenen Aufgaben abgehakt waren. Die Aufgaben
    // gibt es hier nicht mehr, also haelt auch nichts mehr auf: wer fertig ist, stempelt aus.
    // Das muss ohne Huerde gehen – eine nicht gestempelte Schicht fehlt in der Abrechnung, und das
    // ist schlimmer als jeder offene Punkt.
    const otherOpenShifts = store.getOpenShiftsToday().filter((s) => s.id !== shift.id);
    const wouldBeLast = otherOpenShifts.length === 0;

    const endBtn = document.createElement("button");
    endBtn.className = "btn btn-primary btn-huge";
    endBtn.textContent = "🚪 Schicht beenden";
    endBtn.onclick = () => endShift(day, emp, shift, wouldBeLast);
    wrap.appendChild(endBtn);

    return wrap;
  }







  /** Die Store-Managerin ändert eine Standard-Aufgabe direkt aus ihrer Liste. Geändert wird die Vorlage
   * (gilt ab dem nächsten Einstempeln für alle) und ihre eigene Aufgabe von heute gleich mit. */


  /** Karte "Meine Aufgaben" der Store-Managerin: was sie sich in ihrer App anlegt und was der Chef ihr gibt.
   * Die Aufgaben gehören dem Worker; abgehakt wird deshalb direkt dort, damit es in der App gleich stimmt. */


  /** Weitergeben: an WEN und auf WELCHEN TAG.
   *
   * Der Tag ist wichtig: bleibt die Aufgabe auf heute, obwohl die Person gar nicht mehr kommt, ist sie
   * weitergegeben an niemanden – sie steht abends nur als offener Punkt da. Deshalb ist "morgen"
   * vorausgewählt, sobald die Person heute nicht mehr im Dienst ist. */


  function endShift(day, emp, shift, wouldBeLast) {
    const closed = store.clockOut(day.id, shift.id);
    sendClockEvent("clock_out", emp.name, closed?.to || "");
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
