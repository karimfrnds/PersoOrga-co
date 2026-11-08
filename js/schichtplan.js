// ============================================================================
// schichtplan.js – welche Schichten an welchem Tag gelten.
//
// Der Schichtplan ist nicht in Stein gemeißelt: er liegt als Liste datierter Pläne vor ("ab": ab
// wann der Plan gilt) und wird im Chef-Bereich bearbeitet. Alte Wochen sehen dadurch weiterhin so
// aus, wie sie wirklich waren, und kommende Wochen schon so, wie sie sein werden.
//
// Bewusst ein eigenes, winziges Modul ohne Abhängigkeiten: iPad (store.js), Laptop, Handy und – als
// nachgebaute Zwillinge – der Worker müssen hier dasselbe rechnen. Sonst zeigt eine Ansicht
// Schichten, die es an dem Tag nicht gibt, oder verschweigt welche.
//
// Drei Bereiche: Service, Küche und Bar. Bar ist optional. Solange kein einziger Plan eigene
// Bar-Schichten hat, arbeitet die Bar nach dem Service-Plan – so war es immer, und so bleibt es,
// bis jemand der Bar eigene Schichten gibt.
// ============================================================================

export const BEREICHE = ["service", "kueche", "bar"];
export const BEREICH_LABEL = { service: "Service", kueche: "Küche", bar: "Bar" };

/** Zu welchem Schicht-Bereich gehört eine Mitarbeiter-Rolle? Alles Unbekannte ist Service. */
export function bereichVonRolle(rolle) {
  if (rolle === "kueche") return "kueche";
  if (rolle === "bar") return "bar";
  return "service";
}

/** Ab wann ist die Bar ein eigener Bereich? Das ist der Stichtag des ERSTEN Plans mit eigenen
 *  Bar-Schichten – davor läuft die Bar im Service mit, danach hat sie ihren eigenen Plan.
 *
 *  Bewusst an ein Datum gebunden und nicht an ein Ja/Nein über alle Pläne: legt man eine Bar-Schicht
 *  an, die erst in zwei Wochen gilt, wäre die Bar sonst ab sofort ein eigener Bereich mit leerem
 *  Plan – zwei Wochen lang hätte niemand an der Bar eine Schicht. Und weil der Stichtag nur nach
 *  vorn wandern kann, bleibt die Zuordnung für einen Tag immer dieselbe. */
export function barEigenAb(plaene) {
  const mit = (Array.isArray(plaene) ? plaene : [])
    .filter((p) => Array.isArray(p?.bar) && p.bar.length > 0)
    .map((p) => String(p.ab || ""))
    .sort();
  return mit[0] || null;
}
/** Ist die Bar an diesem Tag ein eigener Bereich? */
export function barEigenAm(plaene, dateStr) {
  const ab = barEigenAb(plaene);
  return !!ab && String(dateStr || "") >= ab;
}
/** In welchem Schicht-Bereich arbeitet diese Rolle an diesem Tag? Der einzige Ort, an dem die
 *  Bar-Rückfallregel entschieden wird – Anzeige und Konkurrenz-Pool fragen beide hier. */
export function bereichFuerRolleAm(plaene, rolle, dateStr) {
  const bereich = bereichVonRolle(rolle);
  return bereich === "bar" && !barEigenAm(plaene, dateStr) ? "service" : bereich;
}
/** Welche Bereiche gibt es an diesem Tag? */
export function bereicheAm(plaene, dateStr) {
  return barEigenAm(plaene, dateStr) ? ["service", "kueche", "bar"] : ["service", "kueche"];
}

/** Die Schichten eines (bereits aufgelösten) Bereichs aus einem einzelnen Plan. */
export function slotsAusPlan(plan, bereich) {
  if (!plan) return [];
  if (bereich === "kueche") return plan.kueche || [];
  if (bereich === "bar") return plan.bar || [];
  return plan.service || [];
}

/** Der Plan, der an `dateStr` gilt – der jüngste, dessen "ab" nicht in der Zukunft liegt. */
export function planFuer(plaene, dateStr, fallback = null) {
  if (!Array.isArray(plaene) || plaene.length === 0) return fallback;
  const tag = String(dateStr || "");
  const passend = plaene
    .filter((p) => p && String(p.ab || "") <= tag)
    .sort((a, b) => String(a.ab).localeCompare(String(b.ab)));
  return passend[passend.length - 1] || plaene[0] || fallback;
}

/** Die Schichten eines Bereichs an einem Tag – mit der Bar-Rückfallregel dieses Tages. */
export function slotsFuerTag(plaene, dateStr, rolleOderBereich, fallback = null) {
  const plan = planFuer(plaene, dateStr, fallback);
  if (!plan) return [];
  return slotsAusPlan(plan, bereichFuerRolleAm(plaene, rolleOderBereich, dateStr));
}

/** Datum + n Tage, als ISO-Text. Eigene Mini-Fassung, damit dieses Modul nichts importieren muss. */
function plusTage(dateStr, n) {
  const d = new Date(dateStr + "T12:00:00");
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * Die Schichten einer ganzen Woche als Tabellenzeilen.
 *
 * Eine Woche kann den Stichtag in der Mitte haben. Darum wird hier Tag für Tag geschaut und
 * zusammengelegt: jede Schicht kommt genau einmal vor, mit `allowedWeekdays` auf die Tage
 * begrenzt, an denen es sie in DIESER Woche wirklich gibt. Die Ansichten grauen Tage außerhalb
 * ohnehin schon aus – sie brauchen dafür also keine neue Logik.
 *
 * Ändert eine Schicht mit dem Stichtag ihren Namen oder ihre Zeit, entstehen zwei Zeilen
 * (die alte bis Sonntag davor, die neue ab Montag) – das ist ehrlicher als eine Zeile, die je
 * nach Spalte etwas anderes bedeutet.
 */
export function slotsFuerWoche(plaene, montagStr, rolleOderBereich, fallback = null) {
  const zeilen = new Map();
  for (let i = 0; i < 7; i++) {
    const tag = plusTage(montagStr, i);
    for (const slot of slotsFuerTag(plaene, tag, rolleOderBereich, fallback)) {
      if (!slot) continue;
      if (slot.allowedWeekdays && !slot.allowedWeekdays.includes(i)) continue;
      const schluessel = JSON.stringify([slot.id, slot.label, slot.from, slot.to, slot.nurFest || false, slot.weekdayOverrides || null]);
      if (!zeilen.has(schluessel)) zeilen.set(schluessel, { ...slot, allowedWeekdays: [] });
      zeilen.get(schluessel).allowedWeekdays.push(i);
    }
  }
  return [...zeilen.values()];
}
