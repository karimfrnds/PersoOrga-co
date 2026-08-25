// ============================================================================
// pinpad.js – Wiederverwendbare Bausteine für PIN-Eingabe per Ziffernblock
// (Punkte-Anzeige + Tastenraster), genutzt vom Kiosk-Bildschirm (kiosk.js)
// und der Admin-Sperre (admin.js), damit beide gleich aussehen/bedienen.
// ============================================================================

function buildPinDots(pin, minDots = 4) {
  const dots = document.createElement("div");
  dots.className = "pin-dots";
  const shown = Math.max(pin.length, minDots);
  for (let i = 0; i < shown; i++) {
    const dot = document.createElement("span");
    dot.className = "pin-dot" + (i < pin.length ? " filled" : "");
    dots.appendChild(dot);
  }
  return dots;
}

/** onKey(key) wird mit "0".."9", "⌫" (löschen) oder "✓" (bestätigen) aufgerufen. */
function buildPinKeypad(onKey) {
  const grid = document.createElement("div");
  grid.className = "pinpad-grid";
  const keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "⌫", "0", "✓"];
  for (const key of keys) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "pinpad-key" + (key === "✓" ? " pinpad-key-ok" : key === "⌫" ? " pinpad-key-del" : "");
    btn.textContent = key;
    btn.onclick = () => onKey(key);
    grid.appendChild(btn);
  }
  return grid;
}

export { buildPinDots, buildPinKeypad };
