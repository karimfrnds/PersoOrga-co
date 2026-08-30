// ============================================================================
// nameMatch.js – Produktnamen zusammenführen.
//
// Wird von der iPad-Datenhaltung (store.js) UND der Laptop-Ansicht (chef/stock.js) gebraucht: beide
// müssen dieselbe Frage beantworten, nämlich ob zwei unterschiedlich geschriebene Namen dasselbe
// Produkt meinen. Bewusst eine gemeinsame Datei statt zweier Kopien – die liefen sonst mit der Zeit
// auseinander und lägen bei derselben Frage unterschiedlich richtig.
// ============================================================================

// Dasselbe Produkt heißt auf dem Lieferschein anders als im Kassenbericht:
//   METRO:  "Paulaner Hefe-Weissbier naturtrüb 0,5l 20er"
//   SumUp:  "Paulaner Hefeweizen"
// Weder ist Teil des anderen, und "Weissbier" und "Hefeweizen" sind verschiedene Wörter. Ähnlichkeit
// allein löst das nie zuverlässig – deshalb kann sich das System eine einmal bestätigte Zuordnung als
// Zweitname merken (aliases). Beim ersten Mal fragt es, danach trifft es sofort.

/** Vereinheitlicht einen Produktnamen: klein, ohne Umlaute, ohne Sonderzeichen. */
function normalisiereProduktname(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Wörter, die nichts über das Produkt aussagen: Mengen, Gebinde, Werbebegriffe. Bleiben sie drin,
// gelten "0,5l" und "20er" als Übereinstimmung und zwei völlig verschiedene Getränke sehen ähnlich aus.
const NAME_FUELLWOERTER = new Set([
  "l", "ml", "cl", "kg", "g", "stk", "st", "stueck", "x",
  "fl", "flasche", "flaschen", "dose", "dosen", "kasten", "kiste", "karton", "pack", "packung", "beutel", "btl",
  "bio", "naturtrueb", "naturtrueb", "gekuehlt", "frisch", "neu", "gross", "klein", "der", "die", "das", "und", "mit",
]);

/** Bedeutungstragende Wortteile eines Namens. Mengenangaben wie "0,5l" oder "20er" fliegen raus. */
function nameWoerter(s) {
  return normalisiereProduktname(s)
    .split(" ")
    .filter((w) => w.length >= 2)
    .filter((w) => !NAME_FUELLWOERTER.has(w))
    .filter((w) => !/^\d+$/.test(w))
    .filter((w) => !/^\d+(er|l|ml|cl|kg|g)$/.test(w));
}

/** Ähnlichkeit zweier Namen, 0 bis 1.
 *
 * Gewertet werden gemeinsame Wörter, längere stärker als kurze: "paulaner" sagt viel mehr aus als "hefe".
 * Ein Wort zählt auch, wenn es im anderen Namen steckt ("hefeweizen" enthält "hefe") – so kommen
 * unterschiedlich zusammengeschriebene Namen noch zueinander.
 */
function nameAehnlichkeit(a, b) {
  const wa = nameWoerter(a);
  const wb = nameWoerter(b);
  if (wa.length === 0 || wb.length === 0) return 0;
  const gewicht = (w) => Math.min(w.length, 10);
  let treffer = 0;
  for (const w of wa) {
    // Nur längere Wörter dürfen als Teilstück zählen – sonst passt "ei" in alles Mögliche.
    const passt = wb.some((v) => v === w || (w.length >= 5 && v.includes(w)) || (v.length >= 5 && w.includes(v)));
    if (passt) treffer += gewicht(w);
  }
  const gesamt = Math.max(
    wa.reduce((s, w) => s + gewicht(w), 0),
    wb.reduce((s, w) => s + gewicht(w), 0)
  );
  return gesamt === 0 ? 0 : treffer / gesamt;
}

/** Alle Namen, unter denen ein Eintrag bekannt ist: sein eigener plus gemerkte Zweitnamen. */
function alleNamen(eintrag, feld) {
  return [eintrag[feld], ...(Array.isArray(eintrag.aliases) ? eintrag.aliases : [])].filter(Boolean);
}

function bewerteKandidaten(liste, feld, gesucht) {
  const norm = normalisiereProduktname(gesucht);
  if (!norm) return [];
  return liste
    .map((eintrag) => ({
      eintrag,
      punkte: Math.max(...alleNamen(eintrag, feld).map((n) => nameAehnlichkeit(n, gesucht)), 0),
    }))
    .filter((k) => k.punkte > 0.2)
    .sort((a, b) => b.punkte - a.punkte);
}

/** Sucht einen Eintrag zu einem Produktnamen – aber nur, wenn die Zuordnung eindeutig genug ist.
 *
 * Lieber gar keinen Treffer als den falschen: ein falsch zugeordnetes Produkt bucht stillschweigend vom
 * Bestand eines anderen Artikels ab, und das fällt erst auf, wenn die Zahlen nicht mehr stimmen.
 * Deshalb muss der beste Kandidat deutlich besser sein als der zweitbeste.
 */
function findeNachName(liste, feld, gesucht) {
  const norm = normalisiereProduktname(gesucht);
  if (!norm) return null;

  // 1. Exakt (auch über einen gemerkten Zweitnamen)
  const exakt = liste.find((e) => alleNamen(e, feld).some((n) => normalisiereProduktname(n) === norm));
  if (exakt) return exakt;

  // 2. Ein Name steckt vollständig im anderen ("Hefeweizen 0,5" -> "Hefeweizen")
  const enthalten = liste.filter((e) =>
    alleNamen(e, feld).some((n) => {
      const nn = normalisiereProduktname(n);
      return nn.length >= 4 && (nn.includes(norm) || norm.includes(nn));
    })
  );
  if (enthalten.length === 1) return enthalten[0];

  // 3. Ähnlichkeit – nur bei klarem Abstand zum Zweitplatzierten.
  const kandidaten = bewerteKandidaten(liste, feld, gesucht);
  if (kandidaten.length === 0) return null;
  const bester = kandidaten[0];
  const zweiter = kandidaten[1];
  if (bester.punkte >= 0.7 && (!zweiter || bester.punkte - zweiter.punkte >= 0.2)) return bester.eintrag;
  return null;
}


export { normalisiereProduktname, nameWoerter, nameAehnlichkeit, alleNamen, bewerteKandidaten, findeNachName };
