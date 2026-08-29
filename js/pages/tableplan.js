// ============================================================================
// pages/tableplan.js – Der visuelle Tischplan.
//
// Beantwortet im Vorbeigehen die eine Frage, die im Service ständig gestellt wird:
// "Wo kann ich die hinsetzen?" Deshalb ist der Zustand an der FARBE erkennbar und
// nicht am Text – lesen kostet zu viel Zeit, wenn Gäste in der Tür stehen.
//
//   grün  = frei
//   gelb  = frei, aber später reserviert (mit Uhrzeit und Name)
//   rot   = jemand sitzt dort
//
// Die Uhrzeit oben ist einstellbar: so lässt sich vorher anschauen, wie es um
// 19:00 aussieht, ohne selbst zu rechnen.
//
// Angeordnet werden die Tische unter Admin -> Tische. Bewusst getrennt: im Betrieb
// soll niemand aus Versehen den halben Plan verschieben.
// ============================================================================
import { store } from "../store.js";
import { escapeHtml } from "../format.js";

/** Standard-Anordnung, solange ein Tisch noch nicht von Hand platziert wurde: ein einfaches Raster.
 * So ist der Plan sofort benutzbar, auch bevor jemand ihn eingerichtet hat. */
function rasterPosition(index) {
  const proReihe = 5;
  return { x: 4 + (index % proReihe) * 19, y: 6 + Math.floor(index / proReihe) * 26 };
}
function position(tisch, index) {
  if (typeof tisch.x === "number" && typeof tisch.y === "number") return { x: tisch.x, y: tisch.y };
  return rasterPosition(index);
}

/**
 * @param datum      Tag, der gezeigt wird (YYYY-MM-DD)
 * @param zeit       Uhrzeit, für die die Belegung gilt (HH:MM)
 * @param onTisch    Wird mit dem Tisch aufgerufen, wenn jemand darauf tippt
 * @param verschiebbar  true = Tische lassen sich ziehen (nur im Admin)
 * @param onBewegt   Rückmeldung nach dem Verschieben
 */
function buildTischplan({ datum, zeit, onTisch, verschiebbar = false, onBewegt = null }) {
  const wrap = document.createElement("div");
  wrap.className = "plan-wrap";

  for (const bereich of ["innen", "draussen"]) {
    const tische = store.getTables().filter((t) => t.area === bereich);
    if (tische.length === 0) continue;

    const titel = document.createElement("div");
    titel.className = "plan-titel";
    const terrasseZu = bereich === "draussen" && store.isTerraceClosed(datum);
    titel.innerHTML = `<b>${bereich === "innen" ? "🏠 Drinnen" : "☀️ Draußen"}</b>` + (terrasseZu ? ' <span class="res-warn">– heute gesperrt</span>' : "");
    wrap.appendChild(titel);

    const flaeche = document.createElement("div");
    flaeche.className = "plan-flaeche" + (terrasseZu ? " plan-gesperrt" : "");
    // Höhe wächst mit der Anzahl der Reihen, damit nichts abgeschnitten wird.
    const reihen = Math.ceil(tische.length / 5);
    flaeche.style.minHeight = `${Math.max(1, reihen) * 120}px`;

    tische.forEach((t, i) => {
      const { x, y } = position(t, i);
      const { belegt, naechste } = store.getTableOccupancy(t.id, datum, zeit);

      const el = document.createElement("button");
      el.className = "plan-tisch " + (belegt ? "plan-besetzt" : naechste ? "plan-reserviert" : "plan-frei");
      el.style.left = x + "%";
      el.style.top = y + "%";
      el.dataset.tableId = t.id;

      const zeileUnten = belegt
        ? `${escapeHtml(belegt.name)}${belegt.status === "da" ? "" : ` ab ${escapeHtml(belegt.time)}`}`
        : naechste
        ? `ab ${escapeHtml(naechste.time)} ${escapeHtml(naechste.name)}`
        : "frei";
      el.innerHTML =
        `<span class="plan-name">${escapeHtml(t.name)}</span>` +
        `<span class="plan-plaetze">${t.seats} Pl.</span>` +
        `<span class="plan-info">${zeileUnten}</span>`;

      if (verschiebbar) {
        macheVerschiebbar(el, flaeche, t, onBewegt);
        el.title = "Zum Anordnen ziehen";
      } else if (onTisch) {
        el.onclick = () => onTisch(t);
      }
      flaeche.appendChild(el);
    });

    wrap.appendChild(flaeche);
  }

  if (store.getTables().length === 0) {
    const leer = document.createElement("p");
    leer.className = "muted small";
    leer.textContent = "Noch keine Tische angelegt (Admin → Tische).";
    wrap.appendChild(leer);
  }
  return wrap;
}

/** Ziehen per Finger oder Maus. Pointer-Ereignisse decken beides ab, damit es auf dem iPad genauso
 * funktioniert wie am Laptop. */
function macheVerschiebbar(el, flaeche, tisch, onBewegt) {
  el.style.touchAction = "none"; // sonst scrollt die Seite statt den Tisch zu bewegen
  let aktiv = false;
  let versatzX = 0;
  let versatzY = 0;

  el.addEventListener("pointerdown", (e) => {
    aktiv = true;
    el.setPointerCapture(e.pointerId);
    el.classList.add("plan-zieht");
    const box = el.getBoundingClientRect();
    versatzX = e.clientX - box.left;
    versatzY = e.clientY - box.top;
    e.preventDefault();
  });

  el.addEventListener("pointermove", (e) => {
    if (!aktiv) return;
    const flaecheBox = flaeche.getBoundingClientRect();
    const x = ((e.clientX - versatzX - flaecheBox.left) / flaecheBox.width) * 100;
    const y = ((e.clientY - versatzY - flaecheBox.top) / flaecheBox.height) * 100;
    el.style.left = Math.min(96, Math.max(0, x)) + "%";
    el.style.top = Math.min(94, Math.max(0, y)) + "%";
  });

  const beenden = () => {
    if (!aktiv) return;
    aktiv = false;
    el.classList.remove("plan-zieht");
    store.setTablePosition(tisch.id, parseFloat(el.style.left), parseFloat(el.style.top));
    onBewegt?.();
  };
  el.addEventListener("pointerup", beenden);
  el.addEventListener("pointercancel", beenden);
}

export { buildTischplan };
