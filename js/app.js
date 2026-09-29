// ============================================================================
// app.js – Router & Navigation
// ============================================================================
import { renderKiosk } from "./pages/kiosk.js";
import { renderDay } from "./pages/day.js";
import { renderReservations } from "./pages/reservations.js";
import { renderAdmin } from "./pages/admin.js";
import { kann } from "./betrieb.js";
import { store } from "./store.js";
import { maybeRunDailyBackup, starteBackupWache } from "./backup.js";

// Wird bei jeder Änderung hochgezählt und oben in der Leiste angezeigt. Damit ist auf einen Blick
// erkennbar, ob das iPad schon die neue Fassung geladen hat oder noch eine gespeicherte: GitHub Pages
// erlaubt dem Browser, die Dateien 10 Minuten zu behalten. Steht hier nach einer Änderung noch die alte
// Nummer, ist es der Zwischenspeicher – und kein fehlender Upload.
const APP_VERSION = "2026-09-29.2";

const outlet = document.getElementById("outlet");
const versionEl = document.getElementById("app-version");
if (versionEl) versionEl.textContent = APP_VERSION;
const navLinks = document.querySelectorAll(".nav-link");

function navigate(hash) {
  location.hash = "#/" + hash;
}

function currentRoute() {
  return (location.hash || "#/").slice(2); // strip "#/"
}

function setActiveNav(route) {
  const top = route.split("/")[0];
  navLinks.forEach((link) => {
    link.classList.toggle("active", link.dataset.route === top || (top === "" && link.dataset.route === "start") || (top === "day" && link.dataset.route === "start"));
  });
}

function render() {
  const route = currentRoute();
  outlet.innerHTML = "";
  setActiveNav(route);

  if (route === "" || route === "start") {
    outlet.appendChild(renderKiosk(navigate));
  } else if (route.startsWith("day/")) {
    const id = route.slice(4);
    outlet.appendChild(renderDay(id, navigate));
  } else if (route === "reservierungen" && kann("reservierungen")) {
    outlet.appendChild(renderReservations());
  } else if (route.startsWith("admin")) {
    outlet.appendChild(renderAdmin(navigate));
  } else {
    outlet.appendChild(renderKiosk(navigate));
  }
  window.scrollTo(0, 0);
}

navLinks.forEach((link) => {
  link.addEventListener("click", (e) => {
    e.preventDefault();
    navigate(link.dataset.route === "start" ? "" : link.dataset.route);
  });
});

window.addEventListener("hashchange", render);
render();
maybeRunDailyBackup(); // still im Hintergrund, blockiert das Rendern nicht
starteBackupWache(); // und danach alle paar Stunden, damit auch der Abend gesichert ist

// ---------------------------------------------------------------------
// Schutz der Daten auf dem Gerät
//
// Alles liegt als ein Block im Browser-Speicher. Zwei Gefahren gibt es dabei, und beide sind schon
// eingetreten: eine zweite, veraltete Ansicht überschreibt den neuen Stand – oder das Speichern geht
// nicht mehr (Speicher voll) und niemand merkt es, bis alles weg ist. Beides wird hier laut.
// ---------------------------------------------------------------------
function zeigeSperre(titel, text, knopf, aktion) {
  document.querySelector(".daten-sperre")?.remove();
  const overlay = document.createElement("div");
  overlay.className = "overlay daten-sperre";
  const box = document.createElement("div");
  box.className = "dialog";
  const h = document.createElement("h2");
  h.textContent = titel;
  const p = document.createElement("p");
  p.textContent = text;
  const b = document.createElement("button");
  b.className = "btn btn-primary btn-huge";
  b.textContent = knopf;
  b.onclick = aktion;
  box.append(h, p, b);
  overlay.appendChild(box);
  document.body.appendChild(overlay);
}

// Wann hat zuletzt jemand das Gerät angefasst? Steht das iPad unbeaufsichtigt und der Hintergrund-Abgleich
// stösst auf einen neueren Stand, soll es sich still neu laden – ein Hinweisfenster über dem PIN-Feld
// würde sonst stundenlang dastehen.
let letzteEingabe = Date.now();
for (const ereignis of ["pointerdown", "keydown", "touchstart"]) {
  window.addEventListener(ereignis, () => (letzteEingabe = Date.now()), { passive: true });
}

store.aufSpeicherProblem((grund) => {
  if (grund === "schreibfehler") {
    const z = store.speicherZustand();
    zeigeSperre(
      "Speichern nicht möglich",
      `Der Browser lässt nichts mehr speichern (${z.schreibFehler || "unbekannt"}). Ab jetzt wird nichts mehr gesichert – bitte nichts weiter eintragen und Karim Bescheid geben. Gespeicherter Stand: ${z.groesseKB} KB.`,
      "Seite neu laden",
      () => location.reload()
    );
    return;
  }
  if (Date.now() - letzteEingabe > 60000) {
    location.reload();
    return;
  }
  zeigeSperre(
    "Die App war doppelt offen",
    "Diese Ansicht hatte einen älteren Stand. Damit nichts überschrieben wird, wird jetzt der aktuelle Stand geladen. Die letzte Eingabe musst du erneut machen.",
    "Aktuellen Stand laden",
    () => location.reload()
  );
});

// Kommt die Seite aus dem Hintergrund zurück (iOS friert sie ein) oder hat ein anderes Fenster
// geschrieben, wird sofort neu geladen – bevor hier jemand etwas eintippt, das den neueren Stand
// überschreiben würde.
function pruefeStand() {
  if (document.querySelector(".daten-sperre")) return;
  if (store.istVeraltet()) location.reload();
}
window.addEventListener("pageshow", (e) => {
  if (e.persisted) pruefeStand();
});
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) pruefeStand();
});
window.addEventListener("storage", (e) => {
  if (e.key && e.key.endsWith("__rev")) pruefeStand();
});
