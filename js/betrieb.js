// ============================================================================
// betrieb.js – Welcher Betrieb läuft hier?
//
// Dieselbe App bedient zwei Betriebe: das Café (frnds) und Rolla Costa mit Zimtschnecken. Beide
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
      produktion: false, // im Café wird gezählt, nicht chargenweise produziert
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
    // Heisst im Code weiter "popup" – daran haengen der Speicher auf dem Geraet, die Sitzungen und die
    // Adressen der Seiten. Den Namen ändert man, die ID nicht: sonst findet das Tablet seine Daten nicht mehr.
    id: "popup",
    name: "Rolla Costa",
    kurz: "🧁 Rolla Costa",
    speicher: "popupapp_v1",
    funktionen: {
      reservierungen: false,
      tische: false,
      events: false,
      kueche: true, // Produktionsküche: Rezepte und Hinweise an die nächste Schicht
      produktion: true, // Chargen, Behälter und automatische Produktionsaufträge
      bestellliste: true, // was eingekauft werden muss – getrennt von dem, was selbst produziert wird
      social: false,
      storeManagement: false,
      verkauf: true,
      kennzahlen: true,
      schichtenEditierbar: true,
      beta: false, // im Pop-up nichts zum Ausprobieren – der Laden laeuft drei Monate
      einrichtung: true, // ein neuer Betrieb startet bei null und braucht einen Startpunkt
    },
    // Verkauf und Produktionsküche sind zwei verschiedene Arbeitsplätze mit zwei verschiedenen Listen –
    // wer in der Küche steht, will nicht die Theken-Aufgaben sehen und umgekehrt.
    rollen: ["service", "kueche"],
    // Die drei Sachen, die verkauft werden. Preise ändert man im Admin.
    produkte: [
      { id: "zimtschnecke", name: "Zimtschnecke", preis: 4.5, gebacken: true },
      { id: "matcha", name: "Matcha", preis: 5.0, gebacken: false },
      { id: "kaffee", name: "Kaffee", preis: 3.5, gebacken: false },
    ],
    // Zwei Bestände: was vorne an der Theke steht und was im Lager liegt. Zählen darf beides jeder –
    // im Pop-up steht selten mehr als eine Person.
    bestandBereiche: [
      { id: "theke", label: "Theke", symbol: "🧁", rollen: ["service"] },
      // Eingekaufte Ware – Mehl, Butter, Becher. Zählen beide: der Verkauf sieht, was vorne fehlt, die
      // Küche, was zum Produzieren fehlt.
      { id: "lager", label: "Lager", symbol: "📦", rollen: ["service", "kueche"] },
      // Was selbst hergestellt wird. Hier wird nicht gezählt, sondern produziert: der Bestand ist die
      // Summe der nicht leeren Behälter.
      { id: "produktion", label: "Produktion", symbol: "👨‍🍳", rollen: ["kueche"] },
    ],
    // Startpunkt für die Schichten. Im Pop-up sind sie im Admin änderbar – die Zeiten stehen am Anfang
    // nie fest, und dafür jedes Mal den Code zu ändern wäre albern.
    schichten: {
      service: [
        { id: "frueh1", label: "Früh", from: "07:30", to: "13:30" },
        { id: "spaet1", label: "Spät", from: "13:00", to: "19:00" },
      ],
      // Die Produktionsküche fängt frueher an als der Verkauf – was morgens in der Auslage liegt,
      // muss vorher gemacht sein. Änderbar im Admin wie die anderen.
      kueche: [
        { id: "frueh1", label: "Produktion früh", from: "06:00", to: "12:00" },
        { id: "spaet1", label: "Produktion spät", from: "12:00", to: "18:00" },
      ],
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
