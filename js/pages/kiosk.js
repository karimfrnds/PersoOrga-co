// ============================================================================
// pages/kiosk.js – Startbildschirm des gemeinsamen Geräts: PIN-Pad zum
// Ein-/Ausstempeln. Erkennt die App den PIN eines Mitarbeiters, wird direkt
// in die Session-Ansicht (session.js) gewechselt. Der Admin-Bereich ist über
// einen eigenen Button erreichbar (PIN-Abfrage passiert dort wie gewohnt).
// ============================================================================
import { store } from "../store.js";
import { escapeHtml, todayStr } from "../format.js";
import { renderSession } from "./session.js";

function renderKiosk(navigate) {
  const container = document.createElement("div");
  container.className = "page kiosk-page";

  let pin = "";
  let error = "";
  let greetEmployee = null; // Mitarbeiter, der gerade erkannt wurde und noch bestätigen muss

  function rerender() {
    container.innerHTML = "";
    container.appendChild(build());
  }

  function build() {
    if (greetEmployee) return buildGreet();
    return buildPad();
  }

  function buildPad() {
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

    const dots = document.createElement("div");
    dots.className = "pin-dots";
    renderDots(dots);
    wrap.appendChild(dots);

    if (error) {
      const errBox = document.createElement("div");
      errBox.className = "callout callout-warn kiosk-error";
      errBox.textContent = error;
      wrap.appendChild(errBox);
    }

    wrap.appendChild(buildKeypad());

    const adminBtn = document.createElement("button");
    adminBtn.className = "btn btn-link kiosk-admin-link";
    adminBtn.textContent = "🔒 Admin";
    adminBtn.onclick = () => navigate("admin");
    wrap.appendChild(adminBtn);

    return wrap;
  }

  function renderDots(dots) {
    dots.innerHTML = "";
    const shown = Math.max(pin.length, 4);
    for (let i = 0; i < shown; i++) {
      const dot = document.createElement("span");
      dot.className = "pin-dot" + (i < pin.length ? " filled" : "");
      dots.appendChild(dot);
    }
  }

  function buildKeypad() {
    const grid = document.createElement("div");
    grid.className = "pinpad-grid";
    const keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "⌫", "0", "✓"];
    for (const key of keys) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "pinpad-key" + (key === "✓" ? " pinpad-key-ok" : key === "⌫" ? " pinpad-key-del" : "");
      btn.textContent = key;
      btn.onclick = () => handleKey(key);
      grid.appendChild(btn);
    }
    return grid;
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
      goToSession(emp);
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
      store.clockIn(emp.id);
      goToSession(emp);
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

  function goToSession(employee) {
    container.innerHTML = "";
    container.appendChild(renderSession(employee, navigate));
  }

  rerender();
  return container;
}

export { renderKiosk };
