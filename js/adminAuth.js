// ============================================================================
// adminAuth.js – Gemeinsamer Entsperrt-Zustand für den Admin-Bereich.
// Wird sowohl von admin.js (Bereich betreten) als auch von day.js (nachträgliches
// Bearbeiten abgeschlossener Tage) verwendet, damit ein einmaliges Entsperren
// pro Sitzung überall reicht.
// ============================================================================
import { store } from "./store.js";
import { promptDialog, alertDialog } from "./dialog.js";

let unlocked = false;

function isUnlocked() {
  return unlocked;
}
function unlockDirect() {
  unlocked = true;
}
function lock() {
  unlocked = false;
}

/**
 * Stellt sicher, dass Admin-Rechte vorliegen; fragt bei Bedarf den PIN ab.
 * Gibt true zurück, wenn (danach) entsperrt ist, sonst false.
 */
async function requireUnlock() {
  if (!store.hasAdminPin()) return true; // noch kein PIN eingerichtet -> nicht blockieren
  if (unlocked) return true;
  const pin = await promptDialog("Nur der Admin darf abgeschlossene Tage nachträglich ändern.", {
    title: "Admin-PIN erforderlich",
    type: "password",
    okLabel: "Entsperren",
  });
  if (pin === null) return false;
  if (store.checkAdminPin(pin)) {
    unlocked = true;
    return true;
  }
  await alertDialog("PIN ist falsch.");
  return false;
}

export { isUnlocked, unlockDirect, lock, requireUnlock };
