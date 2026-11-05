// ============================================================================
// schichtplan.js – welche Schichten an welchem Tag gelten.
//
// Der Schichtplan ist nicht in Stein gemeißelt: zum 16.11.2026 hat frnds den Plan umgestellt.
// Damit alte Wochen weiterhin so aussehen, wie sie wirklich waren, und kommende Wochen schon
// so, wie sie sein werden, liegt in betrieb.js eine Liste datierter Plaene ("ab": wann der Plan
// greift). Dieses Modul beantwortet daraus die einzige Frage, die alle Ansichten haben:
// welche Schichten gelten an DIESEM Tag?
//
// Bewusst ein eigenes, winziges Modul ohne Abhaengigkeiten: iPad (store.js), Laptop und Handy
// muessen hier dasselbe rechnen, sonst zeigt eine Ansicht Schichten, die es an dem Tag nicht
// gibt – oder verschweigt welche. Genau das war der Fehler, den es hier zu beheben galt.
// ============================================================================

/** Der Plan, der an `dateStr` gilt – der juengste, dessen "ab" nicht in der Zukunft liegt. */
export function planFuer(plaene, dateStr, fallback = null) {
  if (!Array.isArray(plaene) || plaene.length === 0) return fallback;
  const tag = String(dateStr || "");
  const passend = plaene
    .filter((p) => p && String(p.ab || "") <= tag)
    .sort((a, b) => String(a.ab).localeCompare(String(b.ab)));
  return passend[passend.length - 1] || plaene[0] || fallback;
}

/** Die Schichten einer Rolle an einem Tag. */
export function slotsFuerTag(plaene, dateStr, rolle, fallback = null) {
  const plan = planFuer(plaene, dateStr, fallback);
  if (!plan) return [];
  return (rolle === "kueche" ? plan.kueche : plan.service) || [];
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
 * Eine Woche kann den Stichtag in der Mitte haben. Darum wird hier Tag fuer Tag geschaut und
 * zusammengelegt: jede Schicht kommt genau einmal vor, mit `allowedWeekdays` auf die Tage
 * begrenzt, an denen es sie in DIESER Woche wirklich gibt. Die Ansichten grauen Tage ausserhalb
 * ohnehin schon aus – sie brauchen dafuer also keine neue Logik.
 *
 * Aendert eine Schicht mit dem Stichtag ihren Namen oder ihre Zeit, entstehen zwei Zeilen
 * (die alte bis Sonntag davor, die neue ab Montag) – das ist ehrlicher als eine Zeile, die je
 * nach Spalte etwas anderes bedeutet.
 */
export function slotsFuerWoche(plaene, montagStr, rolle, fallback = null) {
  const zeilen = new Map();
  for (let i = 0; i < 7; i++) {
    const tag = plusTage(montagStr, i);
    for (const slot of slotsFuerTag(plaene, tag, rolle, fallback)) {
      if (!slot) continue;
      if (slot.allowedWeekdays && !slot.allowedWeekdays.includes(i)) continue;
      const schluessel = JSON.stringify([slot.id, slot.label, slot.from, slot.to, slot.nurFest || false, slot.weekdayOverrides || null]);
      if (!zeilen.has(schluessel)) zeilen.set(schluessel, { ...slot, allowedWeekdays: [] });
      zeilen.get(schluessel).allowedWeekdays.push(i);
    }
  }
  return [...zeilen.values()];
}
