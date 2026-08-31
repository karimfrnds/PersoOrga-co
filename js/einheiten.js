// ============================================================================
// einheiten.js – Mengeneinheiten und ihre Umrechnung.
//
// Bewusst ein eigenes Modul und nicht in store.js versteckt: iPad (store.js) und Laptop (chef/stock.js)
// müssen beide beantworten können, was passiert, wenn "20 Flaschen" und "10000 ml" zusammengelegt werden.
// Zwei Kopien derselben Tabelle wären zwei Kopien, die auseinanderlaufen – und dann rechnet ein Gerät
// anders als das andere, ohne dass es jemandem auffällt.
// ============================================================================

const EINHEITEN = {
  g: { basis: "g", faktor: 1 }, gramm: { basis: "g", faktor: 1 },
  kg: { basis: "g", faktor: 1000 }, kilo: { basis: "g", faktor: 1000 }, kilogramm: { basis: "g", faktor: 1000 },
  ml: { basis: "ml", faktor: 1 }, milliliter: { basis: "ml", faktor: 1 },
  cl: { basis: "ml", faktor: 10 },
  l: { basis: "ml", faktor: 1000 }, liter: { basis: "ml", faktor: 1000 },
  stueck: { basis: "stk", faktor: 1 }, stück: { basis: "stk", faktor: 1 }, stk: { basis: "stk", faktor: 1 },
  st: { basis: "stk", faktor: 1 }, x: { basis: "stk", faktor: 1 },
};

const rund2 = (n) => Math.round(n * 100) / 100;

function einheitInfo(u) {
  return EINHEITEN[String(u || "").trim().toLowerCase().replace(/\.$/, "")] || null;
}

/** Vereinheitlicht eine Einheit aus einem Rezept auf die Schreibweise, die im System üblich ist. */
function normalisiereEinheit(u) {
  const info = einheitInfo(u);
  if (!info) return String(u || "").trim();
  return info.basis === "stk" ? "Stück" : info.basis;
}

/** Rechnet eine Menge von einer Einheit in eine andere um. null, wenn das nicht geht – dann wird die
 * Zutat lieber ausgelassen als mit einer geratenen Zahl übernommen. */
function rechneEinheitUm(menge, von, nach) {
  const a = einheitInfo(von);
  const b = einheitInfo(nach);
  // Gleiche Schreibweise (oder beide unbekannt, aber identisch) – dann direkt übernehmen.
  if (String(von || "").trim().toLowerCase() === String(nach || "").trim().toLowerCase()) return rund2(menge);
  if (!a || !b || a.basis !== b.basis) return null;
  return rund2((menge * a.faktor) / b.faktor);
}

/** Wie viel von der Einheit des Zielartikels steckt in EINER Einheit des verschwindenden Artikels?
 *
 * Beantwortet die Frage, die beim Zusammenführen offen bleibt. Vier Fälle, nach Verlässlichkeit sortiert:
 *   "gleich"       – dieselbe Einheit, nichts zu rechnen.
 *   "automatisch"  – ml/l/g/kg lassen sich exakt umrechnen, da gibt es nichts zu raten.
 *   "gebinde"      – die hinterlegte Gebindegröße (Kasten à 20) als VORSCHLAG. Geraten, nicht sicher:
 *                    deshalb wird der Wert vorgeschlagen und nicht still angewandt.
 *   "unbekannt"    – der Faktor muss von Hand kommen. Raten wäre hier schlimmer als fragen.
 *   "ohne-einheit" – mindestens einer der beiden wird gar nicht mengengeführt.
 *
 * `von` und `auf` sind einfache Objekte mit {unit, currentAmount, packSize} – damit funktioniert das
 * sowohl auf den Store-Artikeln des iPads als auch auf den Zeilen, die der Laptop vom Worker bekommt.
 */
function umrechnungFuer(von, auf) {
  if (!von || !auf) return null;
  const menge = Number(von.currentAmount) || 0;
  const fertig = (art, faktor) => ({
    art,
    faktor,
    vonEinheit: von.unit || "",
    aufEinheit: auf.unit || "",
    menge,
    ergebnis: faktor === null ? null : rund2(menge * faktor),
    zielMenge: Number(auf.currentAmount) || 0,
  });
  if (!von.unit || !auf.unit) return fertig("ohne-einheit", null);
  const auto = rechneEinheitUm(1, von.unit, auf.unit);
  if (auto !== null) return fertig(auto === 1 ? "gleich" : "automatisch", auto);
  if (Number(von.packSize) > 1) return fertig("gebinde", Number(von.packSize));
  return fertig("unbekannt", null);
}

export { EINHEITEN, einheitInfo, normalisiereEinheit, rechneEinheitUm, umrechnungFuer };
