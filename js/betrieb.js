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
      schichtenEditierbar: false, // einfache Schichtliste im iPad-Admin – im Café läuft das über den Chef-Bereich
      beta: true, // Testbereich im Admin (Wochenplan-CSV)
      einrichtung: false, // laeuft seit Jahren – nichts mehr einzurichten
    },
    rollen: ["service", "kueche", "bar"],
    produkte: [],
    // Die Schichten des Cafés – als Folge von Plänen mit Stichtag, nicht als eine Liste.
    //
    // Ein Schichtplan gilt ab einem Datum und bis der nächste anfängt. Vorher gab es nur eine Liste:
    // änderte man sie, galt die Änderung rückwirkend auch für die Wochen davor, und ein bereits
    // eingeteilter Montag stand plötzlich unter einer Schicht, die es damals nicht gab.
    //
    // "ab" ist der erste Tag, an dem der Plan gilt. Der älteste Plan braucht ein Datum weit in der
    // Vergangenheit, damit auch alte Tage einen Plan haben.
    // Startbelegung der Schichtzeiten. Ab dem ersten Start leben sie in den Daten und werden im
    // Chef-Bereich unter "Schichtzeiten" gepflegt – was hier steht, ist nur noch die Saat.
    schichtPlaene: [
      {
        ab: "2000-01-01",
        service: [
          // Hieß bis 09/2026 "Service 1". Die ID bleibt, damit alle bisherigen Einträge weiter passen.
          { id: "frueh1", label: "Bar", from: "08:30", to: "16:00", weekdayOverrides: { 0: { to: "17:00" }, 1: { to: "17:00" }, 6: { to: "17:00" } } }, // Mo/Di/So bis 17:00
          { id: "frueh2", label: "Service 2", from: "09:00", to: "17:00", allowedWeekdays: [5, 6], weekdayOverrides: { 6: { to: "17:30" } } }, // nur Sa/So, So bis 17:30
          // Unter der Woche macht das die Store-Managerin (siehe "frueh3") – die Mittelschicht gibt es nur noch am Wochenende.
          { id: "mittel", label: "Service Mitte", from: "10:00", to: "14:00", allowedWeekdays: [5, 6] },
          // Die Schicht der Store-Managerin, Mo–Fr. nurFest: wird ausschließlich über eine feste Schicht vergeben
          // und taucht deshalb in keiner Verfügbarkeits-Abfrage auf – sonst könnten andere sie auswählen.
          { id: "frueh3", label: "Store-Management", from: "08:00", to: "14:00", allowedWeekdays: [0, 1, 2, 3, 4], nurFest: true },
          { id: "spaet1", label: "Service Abend 1", from: "15:30", to: "23:00", allowedWeekdays: [2, 3, 4, 5] }, // Mi-Sa
          { id: "spaet2", label: "Service Abend 2", from: "18:00", to: "23:00", allowedWeekdays: [2, 3, 4, 5] }, // Mi-Sa
        ],
        kueche: [
          { id: "frueh1", label: "Küche 1", from: "08:00", to: "15:30" },
          { id: "mittel", label: "Küche Mitte", from: "10:00", to: "14:00" },
          { id: "frueh2", label: "Küche 2", from: "10:00", to: "16:00", allowedWeekdays: [4, 5, 6] }, // Fr/Sa/So
        ],
      },
      {
        // Der Plan ab Montag, 16.11.2026. Abendschichten und die Store-Management-Schicht fallen weg.
        ab: "2026-11-16",
        service: [
          { id: "frueh1", label: "Schicht 1", from: "08:30", to: "16:00" },
          // Die Schicht, die abends zumacht – deshalb "spaet": daran hängt, wer die Schichtende-Aufgaben bekommt.
          { id: "spaet1", label: "Schicht 2", from: "11:00", to: "18:30" },
          { id: "mittel1", label: "Springer", from: "09:00", to: "14:00", allowedWeekdays: [5, 6] }, // Sa/So
        ],
        kueche: [
          { id: "frueh1", label: "Küche 1", from: "08:00", to: "15:00" },
          { id: "frueh2", label: "Küche 2", from: "08:00", to: "14:00", allowedWeekdays: [0, 1, 3, 4] }, // Mo/Di/Do/Fr
          { id: "mittel1", label: "Küche lang", from: "09:00", to: "17:00", allowedWeekdays: [5, 6] }, // Sa/So
          { id: "spaet1", label: "Küche Spät", from: "12:00", to: "18:00", allowedWeekdays: [4, 5, 6] }, // Fr/Sa/So
        ],
      },
    ],
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
