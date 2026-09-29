// ============================================================================
// betrieb.js – Welcher Betrieb läuft hier?
//
// Dieselbe App bedient zwei Betriebe: das Café (frnds) und den Pop-up-Store mit Zimtschnecken. Beide
// brauchen dasselbe Grundgerüst – Einstempeln, Aufgaben, Bestand, Schichtplan – aber nicht denselben
// Zuschnitt: ein Pop-up hat keine Tische, keine Reservierungen und keinen Bingo-Abend, dafür Backmengen.
//
// Ein Betrieb steckt NICHT in einer Kopie des Codes, sondern hier in einer Beschreibung. Zwei Kopien
// würden bedeuten, dass jede Verbesserung zweimal gebaut und jeder Fehler zweimal behoben werden muss –
// und nach vier Wochen wäre eine der beiden veraltet.
//
// Getrennt ist dafür alles, was Daten sind: eigener Speicher auf dem Gerät, eigener Worker, eigene
// Anmeldung. Die beiden Betriebe können sich nicht vermischen.
//
// Welcher Betrieb gilt, sagt die HTML-Seite (window.__BETRIEB__). Ohne Angabe ist es frnds – so bleibt
// jede bestehende Adresse und jedes Lesezeichen genau das, was es vorher war.
// ============================================================================

const BETRIEBE = {
  frnds: {
    id: "frnds",
    name: "frnds Café & Kitchen",
    kurz: "☕ Café Verwaltung",
    speicher: "cafeapp_v1",
    // Was es in diesem Betrieb gibt. Alles, was hier fehlt, taucht nirgends auf – keine leeren Tabs.
    funktionen: {
      reservierungen: true,
      tische: true,
      events: true, // Bingo-Abend
      kueche: true, // Küchen-Karte mit Hinweisen und Rezepten
      bestellliste: true, // Vorräte/Lieferanten + Bestellliste am Laptop
      social: true,
      storeManagement: true,
      verkauf: false, // Stückzahlen je Produkt
      kennzahlen: true, // Umsatz, Umschlag, Wareneinsatz
      schichtenEditierbar: false, // Schichtzeiten stehen im Code
      beta: true, // Testbereich im Admin (Wochenplan-CSV)
      einrichtung: false, // laeuft seit Jahren – nichts mehr einzurichten
    },
    rollen: ["service", "kueche", "bar"],
    produkte: [],
  },

  popup: {
    id: "popup",
    name: "Pop-up Store",
    kurz: "🧁 Pop-up",
    speicher: "popupapp_v1",
    funktionen: {
      reservierungen: false,
      tische: false,
      events: false,
      kueche: false,
      bestellliste: false,
      social: false,
      storeManagement: false,
      verkauf: true,
      kennzahlen: true,
      schichtenEditierbar: true,
      beta: false, // im Pop-up nichts zum Ausprobieren – der Laden laeuft drei Monate
      einrichtung: true, // ein neuer Betrieb startet bei null und braucht einen Startpunkt
    },
    // Ein Pop-up-Team ist klein und macht alles: eine Rolle genügt, und sie hält den Schichtplan einfach.
    rollen: ["service"],
    // Die drei Sachen, die verkauft werden. Preise ändert man im Admin.
    produkte: [
      { id: "zimtschnecke", name: "Zimtschnecke", preis: 4.5, gebacken: true },
      { id: "matcha", name: "Matcha", preis: 5.0, gebacken: false },
      { id: "kaffee", name: "Kaffee", preis: 3.5, gebacken: false },
    ],
    // Zwei Bestände: was vorne an der Theke steht und was im Lager liegt. Zählen darf beides jeder –
    // im Pop-up steht selten mehr als eine Person.
    bestandBereiche: [
      { id: "theke", label: "Theke", symbol: "🧁", rollen: ["service", "kueche", "bar"] },
      { id: "lager", label: "Lager", symbol: "📦", rollen: ["service", "kueche", "bar"] },
    ],
    // Startpunkt für die Schichten. Im Pop-up sind sie im Admin änderbar – die Zeiten stehen am Anfang
    // nie fest, und dafür jedes Mal den Code zu ändern wäre albern.
    schichten: {
      service: [
        { id: "frueh1", label: "Früh", from: "07:30", to: "13:30" },
        { id: "spaet1", label: "Spät", from: "13:00", to: "19:00" },
      ],
      kueche: [],
    },
  },
};

const gewaehlt = typeof window !== "undefined" && window.__BETRIEB__ ? String(window.__BETRIEB__) : "frnds";
const betrieb = BETRIEBE[gewaehlt] || BETRIEBE.frnds;

/** Gibt es das in diesem Betrieb? */
function kann(funktion) {
  return !!betrieb.funktionen[funktion];
}

/** Schlüssel für Browser-Speicher, je Betrieb getrennt. Ohne das läge der Pop-up im selben Speicher wie
 * das Café, sobald jemand beides auf einem Gerät öffnet. */
function speicherSchluessel(name) {
  return betrieb.id === "frnds" ? name : `${name}__${betrieb.id}`;
}

export { betrieb, kann, speicherSchluessel, BETRIEBE };
