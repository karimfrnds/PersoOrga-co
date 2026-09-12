// ============================================================================
// store.js – Datenhaltung (localStorage). Ein Gerät, keine Cloud, kein Login.
// ============================================================================

import { todayStr, dateDe } from "./format.js";
import { normalisiereProduktname, findeNachName, bewerteKandidaten } from "./nameMatch.js";

const STORAGE_KEY = "cafeapp_v1";

/** Rundet auf 2 Nachkommastellen (Mengen/Beträge), vermeidet Float-Reste wie 0.1+0.2=0.30000000000000004. */
function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/** Rundung für EINZELPREISE. Zwei Nachkommastellen reichen dafür nicht: Milch kostet rund 0,001 €/ml
 * und Mehl 0,0008 €/g – auf Cent gerundet wären beide schlicht null, und der Wareneinsatz fiele
 * stillschweigend unter den Tisch. */

function uid() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return "id-" + Date.now() + "-" + Math.random().toString(16).slice(2);
}

/** Aktuelle Uhrzeit als HH:MM in Ortszeit (für automatisch erzeugte Ein-/Ausstempelzeiten). */
function hhmmLocal(date) {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function defaultData() {
  return {
    employees: [], // { id, name, role, hourlyWage, isMinijob, minijobLimit, active, pin }
    settings: {
      tipSplit: { service: 70, kueche: 20, bar: 10 }, // Gewichtung (Punkte/Std.) pro Rolle
      roundingMinutes: 15, // Rundung der Arbeitszeit
      // Arbeitgeber-Lohnnebenkosten (Sozialversicherung etc.) als Pauschal-Prozentsatz vom Bruttolohn –
      // Schätzwerte, echte Sätze (v.a. Berufsgenossenschaft) variieren, bei Bedarf hier anpassen.
      lohnnebenkostenProzent: { minijob: 30, festangestellt: 21 },
      cashWagePayout: true, // wird Lohn bar aus der Kasse ausgezahlt?
      adminPin: null, // schützt Mitarbeiter/Einstellungen/Berichte – null = noch nicht eingerichtet
      // Eigener Zugang für die Social-Media-Betreuung. Damit kommt sie AUSSCHLIESSLICH an den
      // Social-Bereich – nicht an Löhne, Kennzahlen, Gastdaten oder den Schichtplan. null = kein Zugang.
      socialPin: null,
      // Aufgaben-Vorlagen, werden beim Anlegen eines Tages nach day.tasks kopiert – aber nur die, die an
      // diesem Wochentag gelten. { id, text, weekdays[], schicht, bereich, time, priority }
      //   weekdays: [] = jeden Tag, sonst 0=Mo..6=So
      //   schicht:  "" = alle, sonst "frueh" | "mittel" | "spaet"
      //   bereich:  "" = alle, sonst "service" | "kueche"
      //   time:     "" = den ganzen Tag, sonst "HH:MM" – ab dann wird die Aufgabe als fällig angezeigt
      taskTemplates: [],
      // Reservierungen: wie lange ein Tisch pro Reservierung als belegt gilt. Ohne so einen Wert liesse
      // sich gar nicht sagen, ob 18:00 und 19:00 am selben Tisch ein Konflikt sind.
      reservation: {
        durationMinutes: 120,
        // Öffnungszeiten pro Wochentag (0=Mo .. 6=So). Braucht es für die Online-Buchung: ohne sie
        // könnte jemand für 3 Uhr nachts oder für einen Ruhetag reservieren.
        // closed=true -> an dem Tag gar keine Buchung möglich.
        openingHours: [
          { closed: false, from: "09:00", to: "22:00" }, // Mo
          { closed: false, from: "09:00", to: "22:00" }, // Di
          { closed: false, from: "09:00", to: "23:00" }, // Mi
          { closed: false, from: "09:00", to: "23:00" }, // Do
          { closed: false, from: "09:00", to: "23:00" }, // Fr
          { closed: false, from: "09:00", to: "23:00" }, // Sa
          { closed: false, from: "09:00", to: "22:00" }, // So
        ],
        // Wie weit im Voraus Gäste online buchen dürfen, und wie kurzfristig noch.
        maxDaysAhead: 60,
        minLeadMinutes: 60,
        // Ab dieser Gruppengröße nicht mehr online buchbar – große Gruppen wollen abgesprochen sein.
        maxGuestsOnline: 8,
        onlineEnabled: true,
        // Tage, an denen draussen nicht bedient wird (Regen). "YYYY-MM-DD"[] – der Tischplan zeigt die
        // Terrassentische an dem Tag dann als nicht nutzbar an.
        terraceClosedDates: [],
      },
      // Bingo-Abend: was auf der Anmeldeseite steht. Die Termine selbst stehen in data.events – hier nur,
      // was für jeden Termin gleich bleibt, damit man es einmal schreibt und nicht bei jedem Abend neu.
      event: {
        title: "frnds. Bingo Night",
        // Der Fließtext auf der Anmeldeseite. Absätze durch Leerzeile getrennt.
        intro:
          "Ein Abend, an dem gegessen, getrunken und gespielt wird – und am Ende ruft irgendwer viel zu laut „Bingo“.\n\n" +
          "Wir starten um 18 Uhr, gegen halb sieben kommen die Tapas auf den Tisch. Gespielt wird, sobald alle satt sind: " +
          "ganz normales Bingo, und auf jedem Zettel stecken zwei Shot-Felder, die genau das bedeuten, wonach sie klingen. " +
          "Meistens läuft danach noch eine zweite Runde. Gegen 22, 23 Uhr ist Schluss.",
        // Was im Preis steckt – eine Zeile pro Punkt.
        included: ["Eine Runde Bingo", "Welcome Drink", "Kleine Auswahl spanischer Tapas", "10 € Gutschein"],
        // Wein, Bier, zwei Cocktails und Alkoholfreies gibt es an dem Abend – aber extra.
        hinweis: "Wein, Bier, zwei Cocktails und alkoholfreie Getränke gibt es den ganzen Abend an der Bar.",
        onlineEnabled: true,
      },
      // Feste Schicht-Zeitfenster für die Verfügbarkeits-Abfrage im Kiosk. "service" gilt auch für "bar"
      // (teilen sich einen Plan, blockieren sich gegenseitig). allowedWeekdays: 0=Mo..6=So, fehlt = alle Tage.
      // "mittel" braucht IMMER eine explizite Chef-Bestätigung, auch wenn sie automatisch fest wird.
      // Namen und Zeiten entsprechen dem Papier-Schichtplan des Cafés.
      // weekdayOverrides: abweichende Zeiten an einzelnen Wochentagen (0=Mo).
      shiftSlots: {
        service: [
          { id: "frueh1", label: "Service 1", from: "08:30", to: "16:00", weekdayOverrides: { 0: { to: "17:00" }, 1: { to: "17:00" }, 6: { to: "17:00" } } }, // Mo/Di/So bis 17:00
          { id: "frueh2", label: "Service 2", from: "09:00", to: "17:00", allowedWeekdays: [5, 6], weekdayOverrides: { 6: { to: "17:30" } } }, // nur Sa/So, So bis 17:30
          { id: "mittel", label: "Service Mitte", from: "10:00", to: "14:00" },
          { id: "spaet1", label: "Service Abend 1", from: "15:30", to: "23:00", allowedWeekdays: [2, 3, 4, 5] }, // Mi-Sa
          { id: "spaet2", label: "Service Abend 2", from: "18:00", to: "23:00", allowedWeekdays: [2, 3, 4, 5] }, // Mi-Sa
        ],
        kueche: [
          { id: "frueh1", label: "Küche 1", from: "08:00", to: "15:30" },
          { id: "mittel", label: "Küche Mitte", from: "10:00", to: "14:00" },
          { id: "frueh2", label: "Küche 2", from: "10:00", to: "16:00", allowedWeekdays: [4, 5, 6] }, // Fr/Sa/So
        ],
      },
      githubBackup: {
        enabled: false,
        owner: "", // GitHub-Nutzername/Organisation
        repo: "", // Repository-Name
        token: "", // Fine-grained Personal Access Token, nur "Contents: Read and write" für dieses eine Repo
        lastBackupDate: null, // YYYY-MM-DD des letzten erfolgreichen automatischen Backups
        lastError: null, // Fehlermeldung des letzten fehlgeschlagenen Versuchs, für Warnhinweis im Admin
      },
      // Telegram-Aufgaben-Inbox: Abgleich mit dem Cloudflare Worker (worker/telegram-bot.js), der die
      // Aufgaben in einem KV-Speicher hält – so kennt der Bot den Stand auch, wenn das iPad gerade aus ist.
      taskInbox: {
        enabled: false,
        workerUrl: "", // z.B. https://cafe-telegram-bot.deinname.workers.dev
        workerSecret: "", // derselbe Wert wie WEBHOOK_SECRET im Worker
        shareFinancials: false, // separat opt-in: Umsatz/Lohn/Stunden-Historie für Kennzahlen-Abfragen im Bot freigeben
        lastSyncAt: null, // ISO-Timestamp des letzten erfolgreichen Abgleichs
        lastError: null,
        // Was wir beim letzten Abgleich selbst in die Cloud geschrieben haben: {id, done}[] (gedeckelt).
        // Weicht der nächste Cloud-Stand davon ab (z.B. Bot hat "erledigt" gesetzt oder eine Aufgabe entfernt),
        // wird das als Änderung von außen erkannt und lokal übernommen statt beim nächsten Push überschrieben.
        knownRemoteState: [],
        // IDs vom Bot per Wochenplan-Nachricht anhand des Schicht-Namens (nicht Uhrzeit) zugewiesener
        // Schichten, die schon per confirmAvailability() übernommen wurden (gedeckelt) – verhindert, dass
        // eine spätere eigene Änderung am nächsten Sync wieder von der (weiter in der Cloud stehenden)
        // alten Bot-Zuweisung überschrieben wird.
        appliedShiftAssignmentIds: [],
        // IDs vom Bot per freier Nachricht ("notify") an Mitarbeiter geschickter Nachrichten, die schon als
        // Pop-up-Benachrichtigung angelegt wurden (gedeckelt) – verhindert doppelte Zustellung bei erneutem Sync.
        appliedMessageIds: [],
        // IDs vom Bot per "reject_shift" abgelehnter Schichten, die schon per rejectAvailability()
        // übernommen wurden (gedeckelt) – verhindert doppelte Anwendung bei erneutem Sync.
        appliedRejectionIds: [],
        // IDs von per Lieferschein-Foto erkannten Lieferungen, die schon als Verlauf übernommen wurden.
        appliedDeliveryIds: [],
        // IDs der per SumUp-Verkaufsbericht erkannten Verkäufe, die schon in die Statistik eingegangen sind.
        appliedSaleIds: [],
        // IDs von Krankmeldungen (vom Handy), die schon als Krank-Tage übernommen wurden.
        appliedSickIds: [],
        // "Woche|Name|Zeitstempel" der Verfügbarkeits-Einreichungen vom Handy, die schon übernommen wurden.
        appliedAvailabilityKeys: [],
        // IDs der vom Laptop eingereichten Artikel-Änderungen, die schon übernommen wurden.
        appliedStockChangeIds: [],
        appliedEmployeeChangeIds: [],
        // IDs der am Laptop abgeschlossenen (bzw. wieder geöffneten) Wochenpläne, die schon übernommen wurden.
        appliedPublicationIds: [],
        // IDs der Online-Reservierungen von der Website, die schon übernommen wurden.
        appliedReservationIds: [],
      },
    },
    // { id, date, status, shifts[], plannedShifts[], tasks[], kassenabschluss{}, stornos[], auditLog[], closedAt }
    days: [],
    // Kurze System-Nachrichten an einzelne Mitarbeiter (z.B. "Schicht vom Chef bestätigt"), erscheinen als
    // Pop-up beim nächsten Öffnen ihres Kiosk-Fensters. { id, employeeId, text, createdAt, readAt }
    notifications: [],
    // Vorräte – reine Bestell-Liste, keine Mengen.
    // { id, name, status, bereich, lieferant, bestellmenge, wochenmenge, lastOrderedAt, lastDeliveredAt }
    stock: [],
    // Abwesenheiten (kommen vom Handy der Mitarbeiter über den Worker herein, ein Eintrag pro Tag).
    // { id, employeeId, date, art: "urlaub"|"krank"|"kind"|"sonstiges", note, reportedAt }
    absences: [],
    // Verkaufte Produkte je Tag, aus den Kassenberichten. Grundlage für "was läuft, was nicht" und
    // (mit dem Verkaufspreis) für den Deckungsbeitrag. Bewusst eine eigene Liste: der Verbrauchsverlauf
    // am Artikel ist auf 20 Einträge begrenzt und kennt nur Zutaten, nicht die verkauften Produkte.
    // { id, date, productName, quantity, salePrice, revenue }
    productSales: [],
    // Inventuren: was tatsächlich gezählt wurde, gegen den Soll-Bestand.
    // { id, date, bereich, entries: [{stockItemId, name, soll, ist, differenz, wert}], differenzWert, createdAt }
    stocktakes: [],
    // Wochen, deren Schichtplan der Chef abgeschlossen hat: [{ weekStart, publishedAt }].
    // Solange eine Woche hier nicht steht, erfahren die Mitarbeiter nichts über Zu- oder Absagen.
    publishedWeeks: [],
    // Tische des Cafés. { id, name, seats, area: "innen"|"draussen", active, sort }
    tables: [],
    // Reservierungen. Aktuell von Hand am iPad eingetragen; später kommen Gast-Buchungen von der Website
    // über dieselbe Struktur dazu (source: "web").
    // { id, code, date, time, name, phone, guests, area, note, tableIds[], status, source, createdAt, arrivedAt }
    // status: "offen" (noch kein Tisch) | "zugewiesen" | "da" | "weg" | "storniert" | "noshow"
    reservations: [],
    // Küche: was immer vorbereitet sein muss ("mise en place"). Der Bestand ist eine Zahl, die jede
    // Schicht beim Gehen neu einträgt – damit die nächste Schicht sieht, was da ist, ohne nachzusehen.
    // soll = was mindestens dastehen sollte. { id, name, einheit, soll, notiz, rezeptId, aktiv, sort,
    //                                          bestand: { menge, at, by } | null, verlauf: [{menge, at, by}] }
    preps: [],
    // Rezepte zu den Vorbereitungen. Bewusst frei als Zeilen, nicht als gerechnete Zutatenliste:
    // in der Küche wird abgelesen, nicht gerechnet. { id, name, ergibt, zutaten[], schritte[], notiz,
    //                                                 updatedAt, updatedBy, quelle }
    recipes: [],
    // Veranstaltungen mit Anmeldung (Bingo-Abend). Bewusst NICHT als Reservierung geführt: hier wird pro
    // Person gezählt und kassiert, der Termin steht fest, und die Tische verteilt man erst am Abend.
    // { id, date, time, price, capacity, note, active, createdAt }
    events: [],
    // Anmeldungen dazu. { id, eventId, name, contact, guests, note, code, source, createdAt,
    //                     status: "offen"|"da"|"abgesagt", paid }
    eventSignups: [],
  };
}

/** Migration der Bingo-Texte.
 *
 * Titel und die Liste "im Preis enthalten" kann der Chef selbst bearbeiten. Steht dort aber noch WORTGLEICH
 * der alte Vorgabewert, hat er sie nie angefasst – dann soll die neue Vorgabe greifen, statt dass er
 * dieselbe Änderung von Hand nachtragen muss. Ein selbst geschriebener Text bleibt unangetastet.
 */
const ALTE_EVENT_VORGABEN = {
  title: "Bingo Drink Night",
  included: ["Eine Runde Bingo", "Welcome Drink", "Kleine Auswahl spanischer Tapas"],
};
function migrateEventSettings(gemischt, vorgabe) {
  const e = { ...gemischt };
  if (e.title === ALTE_EVENT_VORGABEN.title) e.title = vorgabe.title;
  if (JSON.stringify(e.included) === JSON.stringify(ALTE_EVENT_VORGABEN.included)) e.included = [...vorgabe.included];
  return e;
}

const PRIORITIES = ["niedrig", "normal", "hoch"];

/** Die drei Abschnitte einer Schicht. Jede Standard-Aufgabe gehoert in genau einen davon: was beim
 * Ankommen zu tun ist, was waehrend des Betriebs laeuft, was vor dem Gehen erledigt sein muss.
 * So denkt man im Betrieb ohnehin – und in dieser Reihenfolge stehen die Listen auf dem iPad. */
const AUFGABEN_PHASEN = ["beginn", "schicht", "ende"];
const PHASE_LABEL = { beginn: "Schichtbeginn", schicht: "Während der Schicht", ende: "Schichtende" };

/** Woerter, an denen sich eine alte Vorlage ohne Abschnitt erkennen laesst. */
const PHASE_WORTE = {
  ende: ["abschluss", "abschlie", "zusperr", "abrechn", "kasse z", "aufr", "müll", "muell", "spülmaschine", "spuelmaschine",
    "putz", "reinig", "wischen", "runterfahren", "ausschalten", "abstuhl", "abbauen", "wegr", "leeren"],
  beginn: ["aufsperr", "aufschlie", "öffn", "oeffn", "hochfahren", "wechselgeld", "kasse vorbereiten", "stühle raus",
    "terrasse", "aufstuhl", "anmachen", "einschalten", "teelicht", "vorbereiten", "aufbauen", "rausstellen"],
};
/** Zu welchem Abschnitt gehoert eine Vorlage, die noch keinen hat?
 *
 * Geraten wird nur, solange es niemand selbst gesagt hat – sobald ein Abschnitt einmal gespeichert ist,
 * kommt diese Funktion nicht mehr zum Zug. Im Zweifel "Waehrend der Schicht": das ist der Abschnitt, der
 * niemanden aufhaelt, wenn die Zuordnung daneben liegt.
 */
function ratePhase(text) {
  const t = String(text || "").toLowerCase();
  for (const p of ["ende", "beginn"]) {
    if (PHASE_WORTE[p].some((w) => t.includes(w))) return p;
  }
  return "schicht";
}

function uhrzeitJetzt() {
  return new Date().toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit", hour12: false });
}
function minutenAusUhrzeit(hhmm) {
  const [h, m] = String(hhmm || "0:0").split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
}

/** Migration: Vorlagen waren frueher blosse Textzeilen. Sie werden zu Objekten, die zusaetzlich wissen,
 * an welchem Wochentag, in welcher Schicht und ab welcher Uhrzeit sie gelten. Ohne Angabe heisst das:
 * jeden Tag, jede Schicht, den ganzen Tag – also genau das Verhalten von vorher. */
function normalizeTaskTemplate(v) {
  if (typeof v === "string") {
    return { id: uid(), text: v.trim(), weekdays: [], schicht: "", bereich: "", time: "", priority: "normal", phase: ratePhase(v) };
  }
  return {
    id: v?.id || uid(),
    text: String(v?.text || "").trim(),
    weekdays: Array.isArray(v?.weekdays) ? v.weekdays.map(Number).filter((n) => n >= 0 && n <= 6) : [],
    schicht: ["frueh", "mittel", "spaet"].includes(v?.schicht) ? v.schicht : "",
    bereich: ["service", "kueche"].includes(v?.bereich) ? v.bereich : "",
    time: /^\d{2}:\d{2}$/.test(v?.time || "") ? v.time : "",
    priority: PRIORITIES.includes(v?.priority) ? v.priority : "normal",
    phase: AUFGABEN_PHASEN.includes(v?.phase) ? v.phase : ratePhase(v?.text),
  };
}
function normalizeTaskTemplates(list) {
  return (Array.isArray(list) ? list : []).map(normalizeTaskTemplate).filter((t) => t.text);
}

/** Migration: alte Beta-Checklisten-Vorlagen (fruh/mittel/spaet) in die neue flache taskTemplates-Liste überführen. */
function migrateTaskTemplates(oldSettings) {
  const legacy = oldSettings?.checklistTemplates;
  if (!legacy) return null;
  const merged = [...(legacy.fruh || []), ...(legacy.mittel || []), ...(legacy.spaet || [])];
  return [...new Set(merged.map((s) => s.trim()).filter(Boolean))];
}

/** Die Vorlagen, die an diesem Datum gelten. Leere Wochentagsliste heisst: jeden Tag. */
function templatesForWeekday(dateStr) {
  const wd = weekdayIndexOfDate(dateStr);
  return data.settings.taskTemplates.filter((v) => !v.weekdays || v.weekdays.length === 0 || v.weekdays.includes(wd));
}

function normalizeDay(d) {
  return {
    ...d,
    shifts: (d.shifts || []).map((s) => ({ source: "manual", ...s })),
    plannedShifts: d.plannedShifts || [],
    // Vorsichtshalber Einträge im alten Kann/Kann-nicht-Format (available/from/to) auf das neue
    // Slot-Modell normalisieren, statt beim ersten Zugriff auf ein fehlendes slotIds zu crashen.
    availability: (d.availability || []).map((a) => ({
      confirmedSlotId: null,
      bossConfirmed: false,
      ...a,
      slotIds: Array.isArray(a.slotIds) ? a.slotIds : [],
    })),
    // Aufgaben aus der Zeit vor Schicht/Uhrzeit: die Felder ergaenzen, damit nirgends auf undefined
    // geprueft werden muss. Leer heisst ueberall "gilt fuer alle / den ganzen Tag".
    tasks: (d.tasks || []).map((t) => ({ priority: "normal", schicht: "", bereich: "", time: "", phase: "", ...t })),
    // Wareneinsatz des Tages (Summe der verbrauchten Waren zum Einkaufspreis).
    materialkosten: Number(d.materialkosten) || 0,
  };
}

/** Einheiten, die in der Kueche vorkommen. Frei tippbar waere hier schlechter: "Behälter", "Behaelter"
 * und "Beh." nebeneinander machen die Liste unlesbar. */
const PREP_EINHEITEN = ["Behälter", "Schale", "Blech", "Beutel", "kg", "g", "Liter", "Stück", "Portionen"];

function normalizePrep(v) {
  const bestand = v?.bestand && Number.isFinite(Number(v.bestand.menge))
    ? { menge: Number(v.bestand.menge), at: v.bestand.at || null, by: v.bestand.by || null }
    : null;
  return {
    id: v?.id || uid(),
    name: String(v?.name || "").trim(),
    einheit: String(v?.einheit || "Behälter"),
    soll: Math.max(0, Number(v?.soll) || 0),
    notiz: String(v?.notiz || ""),
    rezeptId: v?.rezeptId || null,
    aktiv: v?.aktiv === undefined ? true : !!v.aktiv,
    sort: Number(v?.sort) || 0,
    bestand,
    // Nur die letzten Zaehlungen: mehr braucht niemand, und die Liste soll nicht unbegrenzt wachsen.
    verlauf: Array.isArray(v?.verlauf) ? v.verlauf.slice(-30) : [],
  };
}

function normalizeRecipe(v) {
  const zeilen = (x) => (Array.isArray(x) ? x : String(x || "").split("\n")).map((z) => String(z).trim()).filter(Boolean);
  return {
    id: v?.id || uid(),
    name: String(v?.name || "").trim(),
    ergibt: String(v?.ergibt || ""),
    zutaten: zeilen(v?.zutaten),
    schritte: zeilen(v?.schritte),
    notiz: String(v?.notiz || ""),
    quelle: String(v?.quelle || ""),
    updatedAt: v?.updatedAt || null,
    updatedBy: v?.updatedBy || null,
  };
}

/** Feste Schichten einer Person: an welchem Wochentag sie immer welche Schicht hat.
 * [{ weekday: 0..6, slotId }] – hoechstens ein Eintrag pro Wochentag. */
function normalizeFesteSchichten(list) {
  const proTag = new Map();
  for (const f of Array.isArray(list) ? list : []) {
    const wd = Number(f?.weekday);
    const slotId = String(f?.slotId || "").trim();
    if (!Number.isInteger(wd) || wd < 0 || wd > 6 || !slotId) continue;
    proTag.set(wd, { weekday: wd, slotId });
  }
  return [...proTag.values()].sort((a, b) => a.weekday - b.weekday);
}

function load() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return defaultData();
  try {
    const parsed = JSON.parse(raw);
    const base = defaultData();
    const migratedTemplates = migrateTaskTemplates(parsed.settings);
    return {
      employees: (parsed.employees ?? base.employees).map((e) => ({ ...e, festeSchichten: normalizeFesteSchichten(e.festeSchichten) })),
      settings: {
        ...base.settings,
        ...(parsed.settings ?? {}),
        taskTemplates: normalizeTaskTemplates(parsed.settings?.taskTemplates ?? migratedTemplates ?? base.settings.taskTemplates),
        githubBackup: { ...base.settings.githubBackup, ...(parsed.settings?.githubBackup ?? {}) },
        taskInbox: { ...base.settings.taskInbox, ...(parsed.settings?.taskInbox ?? {}) },
        reservation: { ...base.settings.reservation, ...(parsed.settings?.reservation ?? {}) },
        event: migrateEventSettings({ ...base.settings.event, ...(parsed.settings?.event ?? {}) }, base.settings.event),
        shiftSlots: base.settings.shiftSlots, // rein code-gesteuert (keine Bearbeiten-UI) -> immer aktuelle Definition, nie aus localStorage "einfrieren"
      },
      days: (parsed.days ?? base.days).map(normalizeDay),
      notifications: parsed.notifications ?? base.notifications,
      // Artikel aus der Zeit der Mengenfuehrung: die alten Felder (unit, currentAmount, Preise,
      // Verbrauchslog) werden nicht uebernommen – sie werden nirgends mehr gelesen und wuerden nur
      // vortaeuschen, dass es die Rechnung noch gibt.
      stock: (parsed.stock ?? base.stock).map((s) => ({
        id: s.id,
        name: s.name,
        status: ["ok", "knapp", "leer", "bestellt"].includes(s.status) ? s.status : "ok",
        updatedAt: s.updatedAt ?? null,
        updatedBy: s.updatedBy ?? null,
        needsReview: !!s.needsReview,
        bereich: s.bereich === "bar" ? "bar" : "kueche",
        aliases: s.aliases ?? [],
        notSameAs: s.notSameAs ?? [],
        lieferant: s.lieferant ?? "",
        bestellmenge: s.bestellmenge ?? "",
        wochenmenge: Math.max(0, Number(s.wochenmenge) || 0),
        lastOrderedAt: s.lastOrderedAt ?? null,
        lastDeliveredAt: s.lastDeliveredAt ?? null,
      })),
      // Frueher hiess das sickDays und kannte nur Krankheit. Beim Uebernehmen bekommt alles die Art
      // "krank" – was in Wahrheit Urlaub war, laesst sich in der Uebersicht umstellen.
      absences: (parsed.absences ?? (parsed.sickDays || []).map((s) => ({ ...s, art: "krank" })) ?? base.absences).map((s) => ({
        art: "krank",
        note: "",
        ...s,
      })),
      publishedWeeks: parsed.publishedWeeks ?? base.publishedWeeks,
      productSales: parsed.productSales ?? base.productSales,
      stocktakes: parsed.stocktakes ?? base.stocktakes,
      tables: parsed.tables ?? base.tables,
      reservations: parsed.reservations ?? base.reservations,
      events: parsed.events ?? base.events,
      eventSignups: parsed.eventSignups ?? base.eventSignups,
      preps: (parsed.preps ?? base.preps).map(normalizePrep),
      recipes: (parsed.recipes ?? base.recipes).map(normalizeRecipe),
    };
  } catch (e) {
    console.error("Fehler beim Laden der Daten, starte mit leerer Datenbank.", e);
    return defaultData();
  }
}

let data = load();

function persist() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

/** Feste Schicht-Zeitfenster für eine Rolle ("service" gilt auch für "bar"). */
function shiftSlotsForRole(role) {
  return role === "kueche" ? data.settings.shiftSlots.kueche : data.settings.shiftSlots.service;
}

/** Schicht mit den Zeiten, die an DIESEM Wochentag gelten. Manche Schichten enden an einzelnen Tagen
 * später (z.B. Service 1 Mo/Di bis 17:00) – diese Ausnahme wird hier an einer Stelle aufgelöst, damit sie
 * nicht in jeder Anzeige einzeln nachgebaut werden muss. */
function slotForDate(slot, dateStr) {
  const ov = slot?.weekdayOverrides?.[weekdayIndexOfDate(dateStr)];
  return ov ? { ...slot, ...ov } : slot;
}

/** 0=Montag..6=Sonntag, reiner Kalendertag. */
function weekdayIndexOfDate(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0=So..6=Sa
  return wd === 0 ? 6 : wd - 1;
}

/** "mittel" braucht in JEDEM Fall eine explizite Chef-Bestätigung, auch wenn sie automatisch (durch
 * Einzelauswahl oder Kaskade) fest zugeteilt wurde – alle anderen Schichten gelten sofort als bestätigt. */
/** Tage auf ein ISO-Datum addieren (auch negativ). Klein gehalten, damit der Store keine fremde
 * Datums-Hilfe braucht. */
function addDaysISOStore(dateStr, n) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

function autoConfirmsWithoutBoss(slotId) {
  return slotId !== "mittel";
}

/** Konkurrenz-Pool einer Person, für den Exklusivitäts-Vergleich ("wer konkurriert mit wem um dieselbe
 * Schicht-ID"). Service und Bar teilen sich einen Plan (blockieren sich gegenseitig), Küche hat einen
 * eigenen – deren Schicht "frueh1" ist zeitlich eine ganz andere als die von Service/Bar, darf die also
 * nicht blockieren. Entspricht genau der Aufteilung von shiftSlotsForRole(). */
function roleOf(employeeId) {
  const role = data.employees.find((e) => e.id === employeeId)?.role || null;
  return role === "kueche" ? "kueche" : role === null ? null : "service";
}

/**
 * Löst Verfügbarkeits-Konflikte eines Tages auf (Kaskade): eine Person mit genau einer noch freien
 * Kandidaten-Schicht wird automatisch darauf festgelegt; das kann wiederum bei anderen Personen eine
 * Schicht wegfallen lassen, also wird das wiederholt, bis sich nichts mehr ändert. Läuft danach immer
 * über die geplanten Schichten drüber, damit "Deine Schichten" und der Bot den aktuellen Stand zeigen.
 */
function resolveDayAvailability(d) {
  let changed = true;
  while (changed) {
    changed = false;
    const taken = new Map(); // "rolle:slotId" -> employeeId, wer diese Schicht gerade fest hat
    for (const a of d.availability) {
      if (a.confirmedSlotId) taken.set(roleOf(a.employeeId) + ":" + a.confirmedSlotId, a.employeeId);
    }
    for (const a of d.availability) {
      if (a.confirmedSlotId) continue;
      const role = roleOf(a.employeeId);
      const open = a.slotIds.filter((id) => !taken.has(role + ":" + id));
      if (open.length === 1) {
        a.confirmedSlotId = open[0];
        a.bossConfirmed = autoConfirmsWithoutBoss(open[0]);
        taken.set(role + ":" + open[0], a.employeeId);
        changed = true;
      }
    }
  }
  materializePlannedShiftsFromAvailability(d);
}

/** Bildet jede fest zugeteilte Verfügbarkeit als geplante Schicht ab (stabile ID "avail-<id>", damit
 * wiederholtes Auflösen nichts verdoppelt) und entfernt sie wieder, falls die Zuteilung wegfällt. */
function materializePlannedShiftsFromAvailability(d) {
  // Zuerst aufraeumen: eine geplante Schicht, deren Verfuegbarkeit es gar nicht mehr gibt (weggenommene
  // feste Schicht, geloeschter Eintrag), wuerde von der Schleife unten nie erreicht – und bliebe fuer
  // immer im Plan stehen, obwohl niemand mehr dahintersteckt.
  const bekannt = new Set(d.availability.map((a) => "avail-" + a.id));
  d.plannedShifts = d.plannedShifts.filter((s) => !String(s.id).startsWith("avail-") || bekannt.has(s.id));

  for (const a of d.availability) {
    const shiftId = "avail-" + a.id;
    const idx = d.plannedShifts.findIndex((s) => s.id === shiftId);
    if (a.confirmedSlotId) {
      const emp = data.employees.find((e) => e.id === a.employeeId);
      const slot = emp ? shiftSlotsForRole(emp.role).find((s) => s.id === a.confirmedSlotId) : null;
      if (slot) {
        // Zeiten für den konkreten Wochentag auflösen (z.B. Service 1 endet Mo/Di später).
        const s = slotForDate(slot, d.date);
        // note kommt aus der Verfügbarkeit, nicht aus der Schicht selbst: diese Funktion baut die Schicht bei
        // jeder Auflösung neu, eine direkt an der Schicht gespeicherte Notiz wäre dabei jedes Mal weg.
        const shift = { id: shiftId, employeeId: a.employeeId, from: s.from, to: s.to, note: a.note || "", bossConfirmed: !!a.bossConfirmed };
        if (idx >= 0) d.plannedShifts[idx] = shift;
        else d.plannedShifts.push(shift);
      }
    } else if (idx >= 0) {
      d.plannedShifts.splice(idx, 1);
    }
  }
}

export const store = {
  // ---- roh ----
  get data() {
    return data;
  },

  // ---- Mitarbeiter ----
  getEmployees(includeInactive = true) {
    return data.employees.filter((e) => includeInactive || e.active);
  },
  getEmployee(id) {
    return data.employees.find((e) => e.id === id);
  },
  addEmployee(emp) {
    const e = {
      id: uid(),
      name: emp.name,
      role: emp.role,
      hourlyWage: Number(emp.hourlyWage) || 0,
      isMinijob: !!emp.isMinijob,
      minijobLimit: Number(emp.minijobLimit) || 556,
      active: true,
      pin: emp.pin ? String(emp.pin) : null,
      // Wochentage, an denen diese Person immer dieselbe Schicht hat – dann muss sie sich nicht
      // jede Woche neu eintragen.
      festeSchichten: normalizeFesteSchichten(emp.festeSchichten),
    };
    data.employees.push(e);
    persist();
    return e;
  },
  updateEmployee(id, patch) {
    const e = this.getEmployee(id);
    if (!e) return;
    Object.assign(e, patch);
    if (patch.festeSchichten !== undefined) e.festeSchichten = normalizeFesteSchichten(patch.festeSchichten);
    persist();
  },
  /** true, wenn der PIN schon von einem anderen aktiven Mitarbeiter oder dem Admin-PIN benutzt wird. */
  isPinTaken(pin, excludingEmployeeId) {
    const p = String(pin);
    if (data.settings.adminPin === p) return true;
    return data.employees.some((e) => e.active && e.id !== excludingEmployeeId && e.pin === p);
  },
  /** Findet den aktiven Mitarbeiter zu einem eingegebenen PIN (fürs Ein-/Ausstempeln am Kiosk). */
  findEmployeeByPin(pin) {
    const p = String(pin);
    return data.employees.find((e) => e.active && e.pin && e.pin === p);
  },
  removeEmployee(id) {
    // Soft-delete: bleibt für alte Tage erhalten, verschwindet aus Auswahllisten
    this.updateEmployee(id, { active: false });
  },
  /** true, wenn der Mitarbeiter in irgendeinem Tag (auch abgeschlossenen) eine Schicht hat. */
  employeeHasHistory(id) {
    return data.days.some((d) => d.shifts.some((s) => s.employeeId === id));
  },
  /** Endgültiges Löschen – nur erlaubt, wenn keine Vergangenheit vorhanden ist (schützt alte Abrechnungen). */
  deleteEmployee(id) {
    if (this.employeeHasHistory(id)) {
      return { ok: false, reason: "Mitarbeiter hat bereits erfasste Schichten und kann daher nicht endgültig gelöscht werden. Bitte stattdessen deaktivieren." };
    }
    data.employees = data.employees.filter((e) => e.id !== id);
    persist();
    return { ok: true };
  },

  // ---- Einstellungen ----
  getSettings() {
    return data.settings;
  },
  getGithubBackupConfig() {
    return data.settings.githubBackup;
  },
  updateGithubBackupConfig(patch) {
    Object.assign(data.settings.githubBackup, patch);
    persist();
  },
  updateSettings(patch) {
    Object.assign(data.settings, patch);
    persist();
  },

  // ---- Admin-PIN (Schutz vor versehentlichen Änderungen, keine echte Sicherheit) ----
  hasAdminPin() {
    return !!data.settings.adminPin;
  },
  hasSocialPin() {
    return !!data.settings.socialPin;
  },
  /** PIN für den Social-Bereich setzen oder (mit leerem Wert) den Zugang wieder entziehen. */
  setSocialPin(pin) {
    const p = String(pin || "").trim();
    data.settings.socialPin = p || null;
    persist();
    return data.settings.socialPin;
  },
  setAdminPin(pin) {
    data.settings.adminPin = String(pin);
    persist();
  },
  checkAdminPin(pin) {
    return !!data.settings.adminPin && String(pin) === data.settings.adminPin;
  },
  clearAdminPin() {
    data.settings.adminPin = null;
    persist();
  },

  // ---- Tage ----
  getDays() {
    return [...data.days].sort((a, b) => (a.date < b.date ? 1 : -1));
  },
  getDay(id) {
    return data.days.find((d) => d.id === id);
  },
  getDayByDate(dateStr) {
    return data.days.find((d) => d.date === dateStr);
  },
  createDay(dateStr) {
    const d = {
      id: uid(),
      date: dateStr,
      status: "offen",
      shifts: [],
      plannedShifts: [],
      availability: [],
      // Ein frischer Tag ist leer. Die Standard-Aufgaben entstehen erst beim Einstempeln, und zwar fuer
      // die Person, die einstempelt – siehe ergaenzeSchichtaufgaben(). Vorher weiss niemand, wer kommt;
      // eine Liste, die keinem gehoert, hakt am Ende auch keiner ab.
      // Welche Vorlagen fuer wen schon angelegt wurden ("mitarbeiterId:vorlagenId").
      appliedShiftTemplateIds: [],
      tasks: [],
      kassenabschluss: { umsatzGesamt: 0, umsatzBar: 0, umsatz7: 0, umsatz19: 0, trinkgeldKarte: 0, trinkgeldBar: 0 },
      stornos: [],
      auditLog: [{ timestamp: new Date().toISOString(), action: "erstellt", detail: `Tag ${dateStr} angelegt` }],
      closedAt: null,
    };
    data.days.push(d);
    persist();
    return d;
  },
  /** Holt den heutigen Tag oder legt ihn an. */
  getOrCreateDayByDate(dateStr) {
    return this.getDayByDate(dateStr) || this.createDay(dateStr);
  },
  logAudit(dayId, action, detail) {
    const d = this.getDay(dayId);
    if (!d) return;
    d.auditLog.push({ timestamp: new Date().toISOString(), action, detail });
  },
  updateDay(id, patch, auditDetail) {
    const d = this.getDay(id);
    if (!d) return;
    Object.assign(d, patch);
    if (auditDetail) this.logAudit(id, "geändert", auditDetail);
    persist();
  },
  closeDay(id) {
    const d = this.getDay(id);
    if (!d) return;
    d.status = "abgeschlossen";
    d.closedAt = new Date().toISOString();
    this.logAudit(id, "abgeschlossen", "Tag wurde abgeschlossen");
    persist();
  },
  reopenDay(id, reason) {
    const d = this.getDay(id);
    if (!d) return;
    d.status = "offen";
    this.logAudit(id, "wieder geöffnet", reason || "kein Grund angegeben");
    persist();
  },
  deleteDay(id) {
    data.days = data.days.filter((d) => d.id !== id);
    persist();
  },

  // Schichten
  addShift(dayId, shift) {
    const d = this.getDay(dayId);
    if (!d) return;
    const s = { id: uid(), employeeId: shift.employeeId, from: shift.from, to: shift.to, note: shift.note || "", source: shift.source || "manual" };
    d.shifts.push(s);
    this.logAudit(dayId, "Schicht hinzugefügt", `${s.from}-${s.to}`);
    persist();
    return s;
  },
  updateShift(dayId, shiftId, patch) {
    const d = this.getDay(dayId);
    if (!d) return;
    const s = d.shifts.find((x) => x.id === shiftId);
    if (!s) return;
    Object.assign(s, patch);
    this.logAudit(dayId, "Schicht geändert", JSON.stringify(patch));
    persist();
  },
  removeShift(dayId, shiftId) {
    const d = this.getDay(dayId);
    if (!d) return;
    d.shifts = d.shifts.filter((s) => s.id !== shiftId);
    this.logAudit(dayId, "Schicht entfernt", shiftId);
    persist();
  },

  // ---- Stempeluhr (PIN-Ein-/Ausstempeln am Kiosk) ----
  /** Offene (noch nicht ausgestempelte) PIN-Schicht eines Mitarbeiters heute, falls vorhanden. */
  getOpenShiftForEmployeeToday(employeeId, dateStr) {
    const d = this.getDayByDate(dateStr || todayStr());
    if (!d) return null;
    return d.shifts.find((s) => s.employeeId === employeeId && s.source === "pin" && !s.clockOutAt) || null;
  },
  /** Alle aktuell offenen PIN-Schichten heute (um zu erkennen, ob gerade jemand sonst noch da ist). */
  getOpenShiftsToday(dateStr) {
    const d = this.getDayByDate(dateStr || todayStr());
    if (!d) return [];
    return d.shifts.filter((s) => s.source === "pin" && !s.clockOutAt);
  },
  /** Mitarbeiter stempelt ein: legt (bei Bedarf) den heutigen Tag an und startet eine offene Schicht. */
  clockIn(employeeId) {
    const dateStr = todayStr();
    const d = this.getOrCreateDayByDate(dateStr);
    const already = this.getOpenShiftForEmployeeToday(employeeId, dateStr);
    if (already) {
      // Auch beim zweiten Blick nachtragen: eine Vorlage, die seit dem Einstempeln dazugekommen ist,
      // soll nicht bis morgen warten.
      this.ergaenzeSchichtaufgaben(employeeId, dateStr);
      return { day: d, shift: already };
    }
    const now = new Date();
    const s = { id: uid(), employeeId, from: hhmmLocal(now), to: null, note: "", source: "pin", clockInAt: now.toISOString(), clockOutAt: null };
    d.shifts.push(s);
    this.logAudit(d.id, "eingestempelt", `${this.getEmployee(employeeId)?.name || employeeId} um ${s.from} Uhr`);
    persist();
    // Erst jetzt, nachdem die Schicht steht: daraus ergibt sich, ob es die Frueh-, Mittel- oder
    // Spaetschicht ist – und damit, welche Standard-Aufgaben diese Person heute bekommt.
    this.ergaenzeSchichtaufgaben(employeeId, dateStr);
    return { day: d, shift: s };
  },
  /** Mitarbeiter stempelt aus: schließt die offene Schicht mit der aktuellen Uhrzeit ab. */
  clockOut(dayId, shiftId) {
    const d = this.getDay(dayId);
    if (!d) return;
    const s = d.shifts.find((x) => x.id === shiftId);
    if (!s) return;
    const now = new Date();
    s.clockOutAt = now.toISOString();
    s.to = hhmmLocal(now);
    this.logAudit(dayId, "ausgestempelt", `${this.getEmployee(s.employeeId)?.name || s.employeeId} um ${s.to} Uhr`);
    persist();
    return s;
  },

  // ---- Geplante Schichten (Wochenplan/CSV/Telegram-Bot) – reine Planung, zählt NICHT als gearbeitete Zeit ----
  /** Optionales `id` (z.B. vom Bot-Abgleich vorgegeben), damit ein Sync dieselbe Schicht nicht doppelt anlegt. */
  addPlannedShift(dayId, shift) {
    const d = this.getDay(dayId);
    if (!d) return;
    const s = { id: shift.id || uid(), employeeId: shift.employeeId, from: shift.from, to: shift.to, note: shift.note || "" };
    d.plannedShifts.push(s);
    persist();
    return s;
  },
  removePlannedShift(dayId, shiftId) {
    const d = this.getDay(dayId);
    if (!d) return;
    d.plannedShifts = d.plannedShifts.filter((s) => s.id !== shiftId);
    persist();
  },
  /** true, wenn irgendein Tag bereits eine geplante Schicht mit dieser (vom Bot vergebenen) ID enthält. */
  hasPlannedShiftId(shiftId) {
    return data.days.some((d) => d.plannedShifts.some((s) => s.id === shiftId));
  },
  /** Alle geplanten Schichten eines Mitarbeiters ab (inkl.) einem Datum – für die "Deine Schichten"-Ansicht im Kiosk. */
  getPlannedShiftsFrom(employeeId, dateStr) {
    const rows = [];
    for (const d of this.getDays()) {
      if (d.date < dateStr) continue;
      for (const s of d.plannedShifts) {
        if (s.employeeId === employeeId) rows.push({ ...s, date: d.date });
      }
    }
    rows.sort((a, b) => (a.date === b.date ? (a.from < b.from ? -1 : 1) : a.date < b.date ? -1 : 1));
    return rows;
  },

  // ---- Verfügbarkeit (Mitarbeiter tragen im Kiosk ein, für welche Schichten sie in der kommenden Woche
  // bereitstehen würden). Wählt jemand genau EINE Schicht, ist die sofort fest und für alle anderen
  // ausgegraut. Wählt jemand mehrere ("keine Präferenz"), bleibt das offen (keine ausgegraut), bis der
  // Chef entscheidet oder sich die Auswahl durch anderweitige Vergabe automatisch auf eine reduziert. ----
  /** Feste Schicht-Zeitfenster für eine Rolle ("service" gilt auch für "bar"). Mit dateStr nur die an
   * diesem Wochentag tatsächlich angebotenen Schichten – und mit den Zeiten, die an dem Tag gelten
   * (z.B. Service 1 endet Mo/Di später). Ohne dateStr die Grunddefinition. */
  getShiftSlotsForRole(role, dateStr) {
    const all = shiftSlotsForRole(role);
    if (!dateStr) return all;
    const wd = weekdayIndexOfDate(dateStr);
    return all.filter((s) => !s.allowedWeekdays || s.allowedWeekdays.includes(wd)).map((s) => slotForDate(s, dateStr));
  },
  getAvailability(dayId, employeeId) {
    const d = this.getDay(dayId);
    if (!d) return null;
    return d.availability.find((a) => a.employeeId === employeeId) || null;
  },
  /** true, wenn diese Schicht an diesem Tag bereits einer ANDEREN Person DERSELBEN Rolle fest zugeteilt
   * ist (fürs Ausgrauen) – Rollen-Vergleich, weil z.B. Service und Küche beide eine Schicht "frueh1"
   * haben, aber zu unterschiedlichen Zeiten, sich also nicht gegenseitig blockieren dürfen. */
  isSlotTaken(dayId, slotId, excludingEmployeeId) {
    const d = this.getDay(dayId);
    if (!d) return false;
    const role = roleOf(excludingEmployeeId);
    return d.availability.some((a) => a.employeeId !== excludingEmployeeId && a.confirmedSlotId === slotId && roleOf(a.employeeId) === role);
  },
  /** Reine Zwischenspeicherung während der Eingabe im Kiosk (noch nicht "abgeschickt") – löst noch
   * keine Kaskade/Ausgraue-Wirkung für andere aus, das passiert erst bei commitAvailability. */
  setAvailabilityDraft(dayId, employeeId, slotIds) {
    const d = this.getDay(dayId);
    if (!d) return;
    const idx = d.availability.findIndex((a) => a.employeeId === employeeId);
    const clean = Array.isArray(slotIds) ? [...new Set(slotIds)] : [];
    if (idx >= 0) {
      d.availability[idx].slotIds = clean;
    } else {
      d.availability.push({ id: uid(), employeeId, slotIds: clean, confirmedSlotId: null, submittedAt: null });
    }
    persist();
  },
  /** "An den Chef senden": macht die Auswahl verbindlich (1 Schicht -> sofort fest + ausgegraut für
   * andere, mehrere -> offene Kandidaten) und stößt die Kaskaden-Auflösung an. Bereits anderweitig fest
   * vergebene Schichten werden dabei aus der eigenen Auswahl entfernt (Sicherheitsnetz). */
  /** Verfügbarkeit einer Person für einen Tag festhalten.
   *
   * submittedAt: Wird eine Einreichung vom Server übernommen, MUSS deren Zeitstempel mitgegeben werden.
   * Sonst bekäme der Eintrag hier einen neuen, das iPad schickte den wieder hoch, und beim nächsten
   * Abgleich hielte es dieselbe Einreichung für eine neue – und wendete sie endlos wieder an. Dabei fiel
   * jedes Mal eine Chef-Bestätigung weg. Aufgefallen ist das nur bei der Mittelschicht: alle anderen
   * Schichten bestätigen sich bei nur einer Auswahl selbst, die Mittelschicht braucht immer den Chef.
   */
  commitAvailability(dayId, employeeId, slotIds, submittedAt) {
    const d = this.getDay(dayId);
    if (!d) return;
    const role = roleOf(employeeId);
    const takenByOthers = new Set(
      d.availability.filter((a) => a.employeeId !== employeeId && a.confirmedSlotId && roleOf(a.employeeId) === role).map((a) => a.confirmedSlotId)
    );
    const clean = [...new Set(Array.isArray(slotIds) ? slotIds : [])].filter((id) => !takenByOthers.has(id));
    const idx = d.availability.findIndex((a) => a.employeeId === employeeId);
    const vorher = idx >= 0 ? d.availability[idx] : null;
    // Eine bereits erteilte Chef-Bestätigung bleibt bestehen, solange die bestätigte Schicht weiterhin
    // zur Auswahl gehört. Sonst würde jede erneute Übernahme die Entscheidung des Chefs wegwerfen.
    const bestaetigungBleibt = !!vorher?.bossConfirmed && vorher.confirmedSlotId && clean.includes(vorher.confirmedSlotId);
    const entry = {
      id: vorher ? vorher.id : uid(),
      employeeId,
      slotIds: clean,
      confirmedSlotId: bestaetigungBleibt ? vorher.confirmedSlotId : clean.length === 1 ? clean[0] : null,
      bossConfirmed: bestaetigungBleibt ? true : clean.length === 1 ? autoConfirmsWithoutBoss(clean[0]) : false,
      note: vorher?.note || "",
      submittedAt: submittedAt || new Date().toISOString(),
    };
    if (idx >= 0) d.availability[idx] = entry;
    else d.availability.push(entry);
    resolveDayAvailability(d);
    persist();
    return this.getAvailability(dayId, employeeId);
  },
  /** Chef legt per Bot explizit fest, welche Schicht eine Person bekommt (überstimmt alles, auch falls
   * jemand anderes sie gerade fest hatte – die verliert sie dann wieder). Zählt IMMER als Chef-Bestätigung
   * (auch für "mittel", die sonst nie automatisch bestätigt wird) und schickt der Person eine Nachricht,
   * die beim nächsten Öffnen ihres Kiosk-Fensters als Pop-up erscheint. Stößt die Kaskade erneut an. */
  /** note ist optional: eine kurze Info zur Schicht ("bitte Lieferung annehmen"), die der Person unter
   * "Deine Schichten" angezeigt wird und in der Benachrichtigung mitkommt. Wird an der Verfügbarkeit
   * gespeichert, weil die geplante Schicht bei jeder Auflösung neu gebaut wird. */
  confirmAvailability(dayId, employeeId, slotId, note) {
    const d = this.getDay(dayId);
    if (!d) return;
    const role = roleOf(employeeId);
    for (const a of d.availability) {
      if (a.employeeId !== employeeId && a.confirmedSlotId === slotId && roleOf(a.employeeId) === role) a.confirmedSlotId = null;
    }
    const idx = d.availability.findIndex((a) => a.employeeId === employeeId);
    if (idx >= 0) {
      const a = d.availability[idx];
      if (!a.slotIds.includes(slotId)) a.slotIds.push(slotId);
      a.confirmedSlotId = slotId;
      a.bossConfirmed = true;
      // Nur überschreiben, wenn wirklich eine Notiz mitkam – sonst würde eine erneute Bestätigung
      // (z.B. beim Umplanen) eine vorhandene Info stillschweigend löschen.
      if (note !== undefined && note !== null) a.note = String(note).trim();
    } else {
      d.availability.push({
        id: uid(),
        employeeId,
        slotIds: [slotId],
        confirmedSlotId: slotId,
        bossConfirmed: true,
        note: note ? String(note).trim() : "",
        submittedAt: new Date().toISOString(),
      });
    }
    resolveDayAvailability(d);
    persist();

    const slotRaw = shiftSlotsForRole(role).find((s) => s.id === slotId);
    const slotDef = slotRaw ? slotForDate(slotRaw, d.date) : null;
    const noteText = note ? String(note).trim() : "";
    this.addNotification(
      employeeId,
      `✅ Deine Schicht am ${dateDe(d.date)}${slotDef ? ` (${slotDef.label}, ${slotDef.from}–${slotDef.to} Uhr)` : ""} ist vom Chef bestätigt.${
        noteText ? `\n📝 ${noteText}` : ""
      }`
    );

    return this.getAvailability(dayId, employeeId);
  },
  /** Chef lehnt eine gemeldete oder gehaltene Schicht ab: Slot wird aus der Auswahl der Person entfernt
   * (fällt weg, taucht bei ihr nicht mehr auf und kann nicht wieder automatisch zurückfallen), eine
   * eventuelle feste Zuteilung wird aufgehoben (Schicht damit für andere wieder frei) und die Person
   * bekommt eine Nachricht, dass sie sich neu entscheiden muss. Stößt die Kaskade erneut an, falls
   * dadurch bei jemand anderem eine offene Auswahl auf die letzte freie Option zusammenfällt. */
  rejectAvailability(dayId, employeeId, slotId) {
    const d = this.getDay(dayId);
    if (!d) return;
    const idx = d.availability.findIndex((a) => a.employeeId === employeeId);
    if (idx < 0) return;
    const a = d.availability[idx];
    a.slotIds = a.slotIds.filter((id) => id !== slotId);
    if (a.confirmedSlotId === slotId) {
      a.confirmedSlotId = null;
      a.bossConfirmed = false;
    }
    resolveDayAvailability(d);
    persist();

    const role = roleOf(employeeId);
    const slotDef = shiftSlotsForRole(role).find((s) => s.id === slotId);
    this.addNotification(
      employeeId,
      `❌ Deine Schicht am ${dateDe(d.date)}${slotDef ? ` (${slotDef.label})` : ""} wurde vom Chef abgelehnt. Bitte im Kiosk eine andere Schicht wählen.`
    );

    return this.getAvailability(dayId, employeeId);
  },

  // ---- Feste Schichten ----
  //
  // Manche arbeiten immer dieselben Tage. Die sollen sich nicht jede Woche neu eintragen – das ist
  // Arbeit fuer nichts, und vergisst es jemand, steht der Tag ploetzlich leer da. Eine feste Schicht ist
  // deshalb eine Regel an der Person ("Timm: Mo, Di, Mi jeweils Kueche 1"), aus der das System die
  // Verfuegbarkeit selbst eintraegt – fest zugeteilt und vom Chef bestaetigt, denn er hat sie ja gesetzt.
  //
  // Drei Dinge, die dabei Vorrang haben und eine feste Schicht NICHT ueberschreibt:
  //   Was die Person selbst schon eingetragen hat. Eine Ausnahme von der Regel ist eine Entscheidung.
  //   Eine Abwesenheit. Wer Urlaub hat, arbeitet auch montags nicht.
  //   Eine Schicht, die schon jemand anderes fest hat.
  getFesteSchichten(employeeId) {
    return this.getEmployee(employeeId)?.festeSchichten || [];
  },
  /** Die feste Schicht dieser Person an diesem Datum, oder null. */
  festeSchichtAm(employeeId, dateStr) {
    const wd = weekdayIndexOfDate(dateStr);
    return this.getFesteSchichten(employeeId).find((f) => f.weekday === wd) || null;
  },
  /** Setzt die festen Schichten einer Person neu.
   *
   * Wichtig ist das Aufraeumen danach: nimmt der Chef "Timm montags" wieder heraus, muessen die daraus
   * schon erzeugten Eintraege der kommenden Wochen weg. Sonst aendert er die Regel und im Plan steht
   * weiter das Alte – und niemand versteht, warum.
   */
  setFesteSchichten(employeeId, list) {
    const emp = this.getEmployee(employeeId);
    if (!emp) return null;
    emp.festeSchichten = normalizeFesteSchichten(list);
    const heute = todayStr();
    for (const d of data.days) {
      if (d.date < heute || d.status !== "offen") continue;
      const soll = emp.festeSchichten.find((f) => f.weekday === weekdayIndexOfDate(d.date));
      const idx = d.availability.findIndex((a) => a.employeeId === employeeId);
      const eintrag = idx >= 0 ? d.availability[idx] : null;
      // Nur selbst erzeugte Eintraege anfassen – von Hand Eingetragenes gehoert der Person.
      if (eintrag?.quelle === "fest" && (!soll || soll.slotId !== eintrag.confirmedSlotId)) {
        d.availability.splice(idx, 1);
        resolveDayAvailability(d);
      }
      if (Array.isArray(d.festeSchichtenAngewandt)) {
        d.festeSchichtenAngewandt = d.festeSchichtenAngewandt.filter((id) => id !== employeeId);
      }
    }
    persist();
    this.ergaenzeFesteSchichten();
    return emp.festeSchichten;
  },
  /** Traegt die festen Schichten fuer die naechsten Tage ein. Laeuft beim Abgleich und beim Oeffnen der
   * Schichtplanung mit. Jede Person bekommt pro Tag nur EINMAL einen Eintrag (festeSchichtenAngewandt):
   * wer ihn danach loescht oder umplant, hat das so gemeint. */
  ergaenzeFesteSchichten(tage = 28) {
    const mitFesten = data.employees.filter((e) => e.active && (e.festeSchichten || []).length > 0);
    if (mitFesten.length === 0) return 0;
    const heute = todayStr();
    let gesamt = 0;
    for (let i = 0; i <= tage; i++) {
      const dateStr = addDaysISOStore(heute, i);
      const wd = weekdayIndexOfDate(dateStr);
      const dran = mitFesten.filter((e) => e.festeSchichten.some((f) => f.weekday === wd));
      if (dran.length === 0) continue;
      // Erst jetzt einen Tag anlegen: sonst entstuenden leere Tage fuer Wochentage, an denen niemand
      // eine feste Schicht hat.
      const d = this.getOrCreateDayByDate(dateStr);
      if (d.status !== "offen") continue;
      if (!Array.isArray(d.festeSchichtenAngewandt)) d.festeSchichtenAngewandt = [];
      let neuAmTag = 0;
      for (const e of dran) {
        if (d.festeSchichtenAngewandt.includes(e.id)) continue;
        // Abwesenheit macht den Eintrag NICHT dauerhaft unmoeglich: wird der Urlaub zurueckgezogen,
        // soll die feste Schicht wieder greifen. Deshalb hier nicht als "angewandt" vermerken.
        if (this.isAbsent(e.id, dateStr)) continue;
        const f = e.festeSchichten.find((x) => x.weekday === wd);
        if (!this.getShiftSlotsForRole(e.role, dateStr).some((sl) => sl.id === f.slotId)) continue;
        if (d.availability.some((a) => a.employeeId === e.id)) {
          d.festeSchichtenAngewandt.push(e.id); // eigener Eintrag gewinnt, und zwar dauerhaft
          continue;
        }
        if (this.isSlotTaken(d.id, f.slotId, e.id)) continue;
        d.availability.push({
          id: uid(),
          employeeId: e.id,
          slotIds: [f.slotId],
          confirmedSlotId: f.slotId,
          bossConfirmed: true,
          note: "",
          quelle: "fest",
          submittedAt: new Date().toISOString(),
        });
        d.festeSchichtenAngewandt.push(e.id);
        neuAmTag++;
      }
      if (neuAmTag > 0) {
        resolveDayAvailability(d);
        gesamt += neuAmTag;
      }
    }
    if (gesamt > 0) persist();
    return gesamt;
  },

  // ---- Nachrichten an Mitarbeiter (Pop-up beim nächsten Öffnen des Kiosk-Fensters) ----
  addNotification(employeeId, text) {
    const n = { id: uid(), employeeId, text, createdAt: new Date().toISOString(), readAt: null };
    data.notifications.push(n);
    persist();
    return n;
  },
  getUnreadNotifications(employeeId) {
    return data.notifications.filter((n) => n.employeeId === employeeId && !n.readAt);
  },
  markNotificationRead(id) {
    const n = data.notifications.find((x) => x.id === id);
    if (!n) return;
    n.readAt = new Date().toISOString();
    persist();
  },

  // ---- Vorräte: nur noch Bestellung, keine Mengen ----
  //
  // Frueher wurde hier mitgezaehlt: Einheit, aktueller Bestand, Warnschwelle, Verbrauch aus Rezepten,
  // Preise vom Lieferschein, Inventur. Das ist alles raus. Der Grund ist nicht, dass es falsch gerechnet
  // haette, sondern dass es nur stimmt, solange jede Lieferung und jeder Verbrauch erfasst wird – und
  // das passiert im Betrieb nie vollstaendig. Eine Zahl, der man nicht trauen kann, ist schlechter als
  // gar keine: man schaut trotzdem hin und entscheidet falsch.
  //
  // Geblieben ist, was fuer eine Bestellung wirklich gebraucht wird:
  //   status        – genug / wird knapp / leer / bestellt, vom Team im Vorbeigehen getippt
  //   lieferant     – bei wem bestellt wird
  //   bestellmenge  – in welcher Einheit ("1 Kasten")
  //   wochenmenge   – wie viele davon in einer normalen Woche gebraucht werden
  //
  // Aus wochenmenge entsteht die Standard-Bestellliste: was jede Woche ohnehin geordert wird, steht
  // schon fertig da und muss nur noch angepasst werden.
  getStockItems() {
    return [...data.stock].sort((a, b) => a.name.localeCompare(b.name));
  },
  addStockItem(name, opts = {}) {
    const item = {
      id: uid(),
      name: String(name || "").trim(),
      status: "ok",
      updatedAt: null,
      updatedBy: null,
      // true = automatisch aus einem Beleg angelegt und noch nicht bestaetigt.
      needsReview: !!opts.needsReview,
      bereich: opts.bereich === "bar" ? "bar" : "kueche",
      // Artikel, von denen der Chef ausdruecklich gesagt hat, dass sie etwas anderes sind.
      notSameAs: [],
      lieferant: String(opts.lieferant || "").trim(),
      bestellmenge: String(opts.bestellmenge || "").trim(),
      // Wie viele "bestellmenge" pro Woche. 0 = keine Standardbestellung, kommt nur auf die Liste,
      // wenn es jemand als knapp oder leer meldet.
      wochenmenge: Math.max(0, Number(opts.wochenmenge) || 0),
      lastOrderedAt: null,
      lastDeliveredAt: null,
    };
    if (!item.name) return null;
    data.stock.push(item);
    persist();
    return item;
  },
  /** Zwei Artikel zusammenfuehren: der alte Name wird als Zweitname gemerkt, der Doppelgaenger
   * verschwindet. Ohne Mengen ist das jetzt eine reine Namenssache – nichts zu verrechnen. */
  mergeStockItem(vonId, aufId) {
    const von = data.stock.find((s) => s.id === vonId);
    const auf = data.stock.find((s) => s.id === aufId);
    if (!von || !auf || vonId === aufId) return null;
    this.addNameAlias("artikel", aufId, von.name);
    for (const a of von.aliases || []) this.addNameAlias("artikel", aufId, a);
    // Was am Doppelgaenger gepflegt war und beim Ziel fehlt, wandert mit – sonst geht die Zuordnung
    // zum Lieferanten beim Zusammenfuehren verloren.
    if (!auf.lieferant && von.lieferant) auf.lieferant = von.lieferant;
    if (!auf.bestellmenge && von.bestellmenge) auf.bestellmenge = von.bestellmenge;
    if (!auf.wochenmenge && von.wochenmenge) auf.wochenmenge = von.wochenmenge;
    // "Ist nicht dasselbe wie ..." uebernehmen und den Verschwundenen ueberall austragen.
    for (const id of von.notSameAs || []) {
      if (id === aufId) continue;
      if (!Array.isArray(auf.notSameAs)) auf.notSameAs = [];
      if (!auf.notSameAs.includes(id)) auf.notSameAs.push(id);
    }
    data.stock = data.stock.filter((s) => s.id !== vonId);
    for (const s of data.stock) {
      if (Array.isArray(s.notSameAs)) s.notSameAs = s.notSameAs.map((id) => (id === vonId ? aufId : id)).filter((id) => id !== s.id);
    }
    persist();
    return { artikel: auf };
  },
  /** Mehrere Artikel auf einmal loeschen.
   *
   * Braucht man nach einem missratenen Import: einzeln waere das bei fuenfzig Eintraegen eine Qual.
   * Die Verkaufshistorie bleibt unangetastet – das ist Vergangenheit und darf sich nicht rueckwirkend
   * aendern.
   */
  clearStockData({ artikel = false, nurUngeprueft = false } = {}) {
    if (!artikel) return { geloeschteArtikel: 0 };
    const vorher = data.stock.length;
    data.stock = nurUngeprueft ? data.stock.filter((s) => !s.needsReview) : [];
    persist();
    return { geloeschteArtikel: vorher - data.stock.length };
  },
  removeStockItem(id) {
    data.stock = data.stock.filter((s) => s.id !== id);
    persist();
  },
  /** Artikel bearbeiten: Name, Bereich, Lieferant, Bestellmenge, Wochenbedarf. */
  updateStockItem(id, patch) {
    const item = data.stock.find((s) => s.id === id);
    if (!item) return null;
    if (patch.name !== undefined && String(patch.name).trim()) item.name = String(patch.name).trim();
    if (patch.bereich !== undefined) item.bereich = patch.bereich === "bar" ? "bar" : "kueche";
    if (patch.lieferant !== undefined) item.lieferant = String(patch.lieferant).trim();
    if (patch.bestellmenge !== undefined) item.bestellmenge = String(patch.bestellmenge).trim();
    if (patch.wochenmenge !== undefined) item.wochenmenge = Math.max(0, Number(patch.wochenmenge) || 0);
    item.updatedAt = new Date().toISOString();
    persist();
    return item;
  },
  /** Vorrats-Artikel per Name. Sucht zuerst exakt, dann über gemerkte Zweitnamen, dann über Ähnlichkeit. */
  getStockItemByName(name) {
    return findeNachName(data.stock, "name", name);
  },
  /** Kandidaten für einen Namen, der keinem Artikel sicher zuzuordnen war – beste zuerst. */
  getNameVorschlaege(name, limit = 4) {
    return bewerteKandidaten(data.stock, "name", name)
      .map((k) => ({ ...k, art: "artikel" }))
      .slice(0, limit);
  },
  /** Hält fest, dass zwei Artikel AUSDRÜCKLICH NICHT dasselbe sind.
   *
   * Ohne das schlägt die Ähnlichkeitssuche dieselbe falsche Paarung bei jedem Aufruf wieder vor –
   * "Erdbeeren" und "Erdbeermarmelade" ähneln sich nun mal. Die Entscheidung des Menschen muss das
   * System sich merken können, sonst nervt es genau die Person, die es besser weiß.
   * Wird beidseitig gespeichert, damit die Reihenfolge egal ist.
   */
  markNotSame(idA, idB) {
    const a = data.stock.find((s) => s.id === idA);
    const b = data.stock.find((s) => s.id === idB);
    if (!a || !b || idA === idB) return null;
    for (const [x, y] of [[a, idB], [b, idA]]) {
      if (!Array.isArray(x.notSameAs)) x.notSameAs = [];
      if (!x.notSameAs.includes(y)) x.notSameAs.push(y);
    }
    persist();
    return true;
  },
  /** Gilt dieses Paar als "geklärt: verschieden"? */
  istAlsVerschiedenMarkiert(idA, idB) {
    const a = data.stock.find((s) => s.id === idA);
    return !!a && Array.isArray(a.notSameAs) && a.notSameAs.includes(idB);
  },
  /** Merkt sich, dass ein Name zu einem Artikel gehört. Ab dann trifft er sofort.
   * Das ist der eigentliche Lernschritt: Ähnlichkeit allein wird bei Namen wie "Paulaner Hefe-Weissbier
   * 0,5l" und "Paulaner Hefeweizen" nie zuverlässig sein. */
  addNameAlias(art, id, alias) {
    const eintrag = data.stock.find((x) => x.id === id);
    const sauber = String(alias || "").trim();
    if (!eintrag || !sauber) return null;
    if (!Array.isArray(eintrag.aliases)) eintrag.aliases = [];
    const norm = normalisiereProduktname(sauber);
    if (!eintrag.aliases.some((a) => normalisiereProduktname(a) === norm)) eintrag.aliases.push(sauber);
    persist();
    return eintrag;
  },
  removeNameAlias(art, id, alias) {
    const eintrag = data.stock.find((x) => x.id === id);
    if (!eintrag || !Array.isArray(eintrag.aliases)) return null;
    const norm = normalisiereProduktname(alias);
    eintrag.aliases = eintrag.aliases.filter((a) => normalisiereProduktname(a) !== norm);
    persist();
    return eintrag;
  },
  /** Der Chef hat einen automatisch angelegten Artikel angeschaut – Hinweis verschwindet. */
  markStockItemReviewed(id) {
    const item = data.stock.find((s) => s.id === id);
    if (!item) return null;
    item.needsReview = false;
    persist();
    return item;
  },

  // ---- Bestellliste ----
  //
  // Der Bestand wird NICHT mehr in Mengen gefuehrt. Der Grund ist Erfahrung: eine Mengenfuehrung stimmt
  // nur, solange jede Lieferung und jeder Verbrauch eingetragen wird, und das passiert im Betrieb nie
  // vollstaendig. Danach ist die Zahl falsch, man traut ihr nicht mehr, und die Pflege war umsonst.
  //
  // Was wirklich gebraucht wird, ist die Bestellung. Dafuer reichen vier Zustaende, die jeder im
  // Vorbeigehen tippen kann, und pro Artikel die Angabe, bei WEM und in welcher Einheit bestellt wird.
  //
  //   ok        – genug da
  //   knapp     – reicht noch, muss aber auf die naechste Bestellung
  //   leer      – ist aus, dringend
  //   bestellt  – ist raus, wartet auf Lieferung (damit es nicht weiter als "leer" schreit)
  //
  /** Die Bestellliste, nach Lieferant gruppiert.
   *
   * Zwei Quellen, und beide gehoeren dazu:
   *   die STANDARDBESTELLUNG – alles mit einer Wochenmenge, also das, was ohnehin jede Woche geordert
   *   wird. Das ist die eigentliche Liste: sie steht schon fertig da, man muss sie nur durchgehen.
   *   die MELDUNGEN – was jemand als knapp oder leer getippt hat. Das ist die Abweichung von der Regel
   *   und faellt in der Liste auf.
   *
   * standard=false blendet die reine Standardbestellung aus, wenn man nur wissen will, was gemeldet wurde.
   */
  getBestellliste({ bereich = "", mitBestellten = true, standard = true } = {}) {
    const offen = data.stock.filter(
      (s) =>
        ["knapp", "leer"].includes(s.status) ||
        (mitBestellten && s.status === "bestellt") ||
        (standard && Number(s.wochenmenge) > 0)
    );
    const gefiltert = bereich ? offen.filter((s) => (s.bereich || "kueche") === bereich) : offen;
    const gruppen = new Map();
    for (const s of gefiltert) {
      const key = s.lieferant || "";
      if (!gruppen.has(key)) gruppen.set(key, []);
      gruppen.get(key).push(s);
    }
    const RANG = { leer: 0, knapp: 1, ok: 2, bestellt: 3 };
    return [...gruppen.entries()]
      .map(([lieferant, artikel]) => ({
        lieferant,
        artikel: artikel.sort((a, b) => (RANG[a.status] ?? 2) - (RANG[b.status] ?? 2) || a.name.localeCompare(b.name)),
        dringend: artikel.filter((a) => a.status === "leer").length,
        gemeldet: artikel.filter((a) => ["knapp", "leer"].includes(a.status)).length,
        offen: artikel.filter((a) => a.status !== "bestellt").length,
      }))
      // Artikel ohne Lieferant IMMER ganz nach unten – auch wenn dort etwas dringend ist: die kann man
      // gar nicht bestellen, die muss man erst zuordnen. Darunter dann die Lieferanten mit dringenden
      // Sachen zuerst.
      .sort(
        (a, b) =>
          (a.lieferant === "" ? 1 : 0) - (b.lieferant === "" ? 1 : 0) ||
          b.dringend - a.dringend ||
          a.lieferant.localeCompare(b.lieferant)
      );
  },
  /** Alle bekannten Lieferanten, fuer die Auswahl beim Anlegen eines Artikels. */
  getLieferanten() {
    return [...new Set(data.stock.map((s) => s.lieferant).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  },
  /** Bestellung raus: die Artikel gelten als bestellt, bis die Lieferung kommt. */
  markiereBestellt(ids, changedBy) {
    const zeit = new Date().toISOString();
    let anzahl = 0;
    for (const id of ids) {
      const item = data.stock.find((s) => s.id === id);
      if (!item) continue;
      item.status = "bestellt";
      item.lastOrderedAt = zeit;
      item.updatedAt = zeit;
      item.updatedBy = changedBy || null;
      anzahl++;
    }
    if (anzahl > 0) persist();
    return anzahl;
  },
  /** Lieferung angekommen: wieder genug da. */
  markiereGeliefert(ids, changedBy) {
    const zeit = new Date().toISOString();
    let anzahl = 0;
    for (const id of ids) {
      const item = data.stock.find((s) => s.id === id);
      if (!item) continue;
      item.status = "ok";
      item.lastDeliveredAt = zeit;
      item.updatedAt = zeit;
      item.updatedBy = changedBy || null;
      anzahl++;
    }
    if (anzahl > 0) persist();
    return anzahl;
  },
  /** Naechster Zustand beim Antippen: ok -> knapp -> leer -> ok.
   * "bestellt" ist in diesem Kreis NICHT dabei – das setzt man beim Bestellen, nicht im Vorbeigehen.
   * Wer einen bestellten Artikel antippt, meint meistens "ist jetzt da". */
  naechsterStockStatus(status) {
    if (status === "bestellt") return "ok";
    if (status === "ok") return "knapp";
    if (status === "knapp") return "leer";
    return "ok";
  },
  /** Artikel nach Bereich, fuer die Melde-Ansicht. Was fehlt, steht oben. */
  getStockNachBereich(bereich) {
    const RANG = { leer: 0, knapp: 1, bestellt: 2, ok: 3 };
    return data.stock
      .filter((s) => (s.bereich || "kueche") === bereich)
      .sort((a, b) => (RANG[a.status] ?? 3) - (RANG[b.status] ?? 3) || a.name.localeCompare(b.name));
  },
  /** Team (unter "Bestand") oder Chef (per Laptop) aendern den Zustand eines Artikels. */
  setStockStatus(id, status, changedBy) {
    const item = data.stock.find((s) => s.id === id);
    if (!item) return;
    item.status = status;
    item.updatedAt = new Date().toISOString();
    item.updatedBy = changedBy || null;
    persist();
    return item;
  },
  // ---- Abwesenheiten (kommen vom Handy der Mitarbeiter herein) ----
  //
  // Frueher hiess das "Krankmeldung" und konnte nur eins. Wer Urlaub eintragen wollte, hat ihn als
  // Krankheit gemeldet, weil es nichts anderes gab – und danach stand im System etwas, das nicht stimmt.
  // Deshalb jetzt eine Abwesenheit MIT Art. Die Meldung selbst bleibt so einfach wie vorher: von, bis,
  // Art, optional eine Notiz.
  ABWESENHEIT_ARTEN: [
    { id: "urlaub", label: "Urlaub", symbol: "🏖" },
    { id: "krank", label: "Krankheit", symbol: "🤒" },
    { id: "kind", label: "Kind krank", symbol: "🧒" },
    { id: "sonstiges", label: "Sonstiges", symbol: "📌" },
  ],
  getAbwesenheitArt(id) {
    return this.ABWESENHEIT_ARTEN.find((a) => a.id === id) || this.ABWESENHEIT_ARTEN[1];
  },
  /** Legt einen Abwesenheitstag an. Doppelte (gleiche Person, gleicher Tag) werden nicht verdoppelt –
   * ein erneuter Abgleich oder eine zweite Meldung fuer denselben Tag darf nichts vermehren. Eine
   * spaetere Meldung mit anderer Art ueberschreibt die alte: wer nachtraegt "das war Urlaub", hat recht. */
  addAbsence(employeeId, date, art = "krank", note = "") {
    if (!employeeId || !date) return null;
    const gueltig = this.ABWESENHEIT_ARTEN.some((a) => a.id === art) ? art : "krank";
    const vorhanden = data.absences.find((s) => s.employeeId === employeeId && s.date === date);
    if (vorhanden) {
      vorhanden.art = gueltig;
      if (note) vorhanden.note = note;
      persist();
      return vorhanden;
    }
    const entry = { id: uid(), employeeId, date, art: gueltig, note: note || "", reportedAt: new Date().toISOString() };
    data.absences.push(entry);
    this.loeseFesteSchichtAuf(employeeId, date);
    persist();
    return entry;
  },
  /** Eine automatisch gesetzte feste Schicht wieder wegnehmen – z.B. weil Urlaub gemeldet wurde.
   * Von Hand Eingetragenes bleibt stehen: das hat jemand entschieden, das loescht das System nicht. */
  loeseFesteSchichtAuf(employeeId, date) {
    const d = this.getDayByDate(date);
    if (!d || d.status !== "offen") return false;
    const idx = d.availability.findIndex((a) => a.employeeId === employeeId && a.quelle === "fest");
    if (idx < 0) return false;
    d.availability.splice(idx, 1);
    // Marke ebenfalls entfernen: wird der Urlaub zurueckgezogen, soll die feste Schicht wiederkommen.
    if (Array.isArray(d.festeSchichtenAngewandt)) {
      d.festeSchichtenAngewandt = d.festeSchichtenAngewandt.filter((id) => id !== employeeId);
    }
    resolveDayAvailability(d);
    persist();
    return true;
  },
  /** Abwesenheiten in einem Zeitraum (beide Grenzen inklusive), aufsteigend nach Datum. */
  getAbsences(from, to) {
    return data.absences
      .filter((s) => (!from || s.date >= from) && (!to || s.date <= to))
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  },
  /** Die Abwesenheit einer Person an einem Tag, oder null. */
  getAbsence(employeeId, date) {
    return data.absences.find((s) => s.employeeId === employeeId && s.date === date) || null;
  },
  isAbsent(employeeId, date) {
    return !!this.getAbsence(employeeId, date);
  },
  updateAbsence(id, patch) {
    const a = data.absences.find((s) => s.id === id);
    if (!a) return null;
    if (patch.art !== undefined && this.ABWESENHEIT_ARTEN.some((x) => x.id === patch.art)) a.art = patch.art;
    if (patch.note !== undefined) a.note = String(patch.note).trim();
    persist();
    return a;
  },
  removeAbsence(id) {
    data.absences = data.absences.filter((s) => s.id !== id);
    persist();
  },
  /** Zusammenhaengende Tage derselben Art zu einem Block zusammenfassen.
   *
   * Zehn einzelne Urlaubstage sind fuer den Menschen EIN Urlaub. Als zehn Zeilen liest das niemand, und
   * in einer Uebersicht will man "24.–28.11., Urlaub" sehen, nicht fuenf Eintraege untereinander.
   */
  getAbsenceBloecke(employeeId, from, to) {
    const tage = this.getAbsences(from, to).filter((s) => !employeeId || s.employeeId === employeeId);
    const bloecke = [];
    for (const t of tage) {
      const letzter = bloecke[bloecke.length - 1];
      const passtDazu =
        letzter &&
        letzter.employeeId === t.employeeId &&
        letzter.art === t.art &&
        addDaysISOStore(letzter.bis, 1) === t.date;
      if (passtDazu) {
        letzter.bis = t.date;
        letzter.tage++;
        if (t.note && !letzter.note) letzter.note = t.note;
      } else {
        bloecke.push({ ids: [], employeeId: t.employeeId, art: t.art, von: t.date, bis: t.date, tage: 1, note: t.note || "" });
      }
      bloecke[bloecke.length - 1].ids.push(t.id);
    }
    return bloecke.sort((a, b) => (a.von < b.von ? -1 : a.von > b.von ? 1 : 0));
  },

  // ---- Tische ----
  addTable({ name, seats, area }) {
    const t = {
      id: uid(),
      name: String(name || "").trim(),
      seats: Math.max(1, Number(seats) || 2),
      area: area === "draussen" ? "draussen" : "innen",
      active: true,
      sort: data.tables.length,
      // Tische, die physisch daneben stehen und zusammengeschoben werden können.
      // Wird immer beidseitig gepflegt (siehe setTableNeighbours), sonst kämen widersprüchliche
      // Angaben heraus: Tisch 1 wüsste von Tisch 2, aber nicht umgekehrt.
      combinesWith: [],
    };
    if (!t.name) return null;
    data.tables.push(t);
    persist();
    return t;
  },
  updateTable(id, patch) {
    const t = data.tables.find((x) => x.id === id);
    if (!t) return null;
    if (patch.name !== undefined && String(patch.name).trim()) t.name = String(patch.name).trim();
    if (patch.seats !== undefined) t.seats = Math.max(1, Number(patch.seats) || 1);
    if (patch.area !== undefined) t.area = patch.area === "draussen" ? "draussen" : "innen";
    if (patch.active !== undefined) t.active = !!patch.active;
    persist();
    return t;
  },
  /** Nachbarn eines Tisches setzen – immer beidseitig, damit die Angaben nie auseinanderlaufen. */
  setTableNeighbours(id, neighbourIds) {
    const t = data.tables.find((x) => x.id === id);
    if (!t) return null;
    // Nur echte, andere Tische; ein Tisch ist nie sein eigener Nachbar.
    const gueltig = [...new Set(neighbourIds)].filter((n) => n !== id && data.tables.some((x) => x.id === n));
    t.combinesWith = gueltig;
    for (const other of data.tables) {
      if (other.id === id) continue;
      const liste = new Set(other.combinesWith || []);
      if (gueltig.includes(other.id)) liste.add(id);
      else liste.delete(id);
      other.combinesWith = [...liste];
    }
    persist();
    return t;
  },
  removeTable(id) {
    data.tables = data.tables.filter((t) => t.id !== id);
    // Auch aus den Nachbarschafts-Listen der anderen entfernen, sonst zeigen die auf einen Geistertisch.
    for (const t of data.tables) {
      if (t.combinesWith?.includes(id)) t.combinesWith = t.combinesWith.filter((x) => x !== id);
    }
    // Zuweisungen auf diesen Tisch lösen sich auf, sonst zeigt die Reservierung auf einen Tisch,
    // den es nicht mehr gibt.
    for (const r of data.reservations) {
      if (!r.tableIds?.includes(id)) continue;
      r.tableIds = r.tableIds.filter((x) => x !== id);
      if (r.tableIds.length === 0 && r.status === "zugewiesen") r.status = "offen";
    }
    persist();
  },
  getTables(includeInactive = false) {
    return data.tables.filter((t) => includeInactive || t.active !== false).sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0));
  },
  getTable(id) {
    return data.tables.find((t) => t.id === id) || null;
  },

  // ---- Reservierungen ----
  /** Kurze, gut vorlesbare Nummer. Nur Zeichen, die am Telefon nicht zu verwechseln sind (kein 0/O, 1/I). */
  makeReservationCode() {
    const alphabet = "ACDEFGHJKLMNPQRSTUVWXYZ23456789";
    for (let versuch = 0; versuch < 50; versuch++) {
      let code = "";
      for (let i = 0; i < 5; i++) code += alphabet[Math.floor(Math.random() * alphabet.length)];
      if (!data.reservations.some((r) => r.code === code)) return code;
    }
    return "R" + Date.now().toString(36).toUpperCase().slice(-5);
  },
  addReservation({ date, time, name, phone, guests, area, note, source = "manuell", tableIds = [] }) {
    const r = {
      id: uid(),
      code: this.makeReservationCode(),
      date: String(date || "").trim(),
      time: String(time || "").trim(),
      name: String(name || "").trim(),
      phone: String(phone || "").trim(),
      guests: Math.max(1, Number(guests) || 1),
      area: area === "draussen" ? "draussen" : area === "egal" ? "egal" : "innen",
      note: String(note || "").trim(),
      tableIds: [...tableIds],
      status: tableIds.length > 0 ? "zugewiesen" : "offen",
      source,
      createdAt: new Date().toISOString(),
      arrivedAt: null,
      // Absage: Grund, Freitext, wann und ob der Gast Bescheid weiss.
      cancelReason: null,
      cancelNote: "",
      cancelledAt: null,
      cancelledBy: "",
      cancelNotified: false,
    };
    if (!r.date || !r.time || !r.name) return null;
    data.reservations.push(r);
    persist();
    return r;
  },
  // ---- Absagen ----
  //
  // Eine Absage ist mehr als ein Status. Man will spaeter wissen, WARUM abgesagt wurde – ob wir selbst
  // absagen mussten (ueberbucht, geschlossen) oder der Gast von sich aus. Das ist ein Unterschied, der
  // ueber Monate etwas ueber den Laden sagt, und er geht verloren, wenn nur "storniert" dasteht.
  //
  // Ausserdem gehoert dazu, ob der Gast Bescheid weiss. Eine Absage, von der niemand erfahren hat, ist
  // keine Absage, sondern ein Tisch, vor dem gleich jemand steht.
  ABSAGE_GRUENDE: [
    { id: "geschlossen", label: "Wir haben an dem Tag geschlossen", wirSagenAb: true },
    { id: "ausgebucht", label: "Kein Tisch mehr frei", wirSagenAb: true },
    { id: "privat", label: "Privatveranstaltung im Laden", wirSagenAb: true },
    { id: "krank", label: "Personalausfall", wirSagenAb: true },
    { id: "gast", label: "Der Gast hat selbst abgesagt", wirSagenAb: false },
    { id: "sonstiges", label: "Anderer Grund", wirSagenAb: true },
  ],
  getAbsageGrund(id) {
    return this.ABSAGE_GRUENDE.find((g) => g.id === id) || null;
  },
  /** Reservierung absagen. Der Tisch wird frei, der Grund bleibt.
   *
   * benachrichtigt: ob dem Gast eine Nachricht geschickt wurde. Bewusst ein eigenes Feld und nicht aus
   * dem Grund abgeleitet – eine Nummer kann fehlen, oder man erreicht jemanden nicht.
   */
  cancelReservation(id, { grund = "sonstiges", freitext = "", benachrichtigt = false, by = "" } = {}) {
    const r = data.reservations.find((x) => x.id === id);
    if (!r) return null;
    r.status = "storniert";
    r.tableIds = [];
    r.arrivedAt = null;
    r.cancelReason = String(grund || "sonstiges");
    r.cancelNote = String(freitext || "").trim();
    r.cancelledAt = new Date().toISOString();
    r.cancelledBy = String(by || "").trim();
    r.cancelNotified = !!benachrichtigt;
    persist();
    return r;
  },
  /** Nachtragen, dass der Gast doch noch Bescheid bekommen hat. */
  markReservationNotified(id) {
    const r = data.reservations.find((x) => x.id === id);
    if (!r) return null;
    r.cancelNotified = true;
    persist();
    return r;
  },
  /** Eine Absage zuruecknehmen – der Gast kommt doch. Ohne Tisch, den vergibt man neu. */
  undoCancelReservation(id) {
    const r = data.reservations.find((x) => x.id === id);
    if (!r || r.status !== "storniert") return null;
    r.status = "offen";
    r.cancelReason = null;
    r.cancelNote = "";
    r.cancelledAt = null;
    r.cancelNotified = false;
    persist();
    return r;
  },

  /** Laufkundschaft: jemand steht da und wird gesetzt. Kein Name, keine Telefonnummer, keine Rückfrage –
   * es zählt nur, dass der Tisch ab jetzt besetzt ist. Gilt sofort als angekommen, denn die Gäste sind ja da. */
  addWalkIn({ date, time, guests, tableIds = [] }) {
    const r = this.addReservation({ date, time, name: "Laufkundschaft", guests, area: "innen", source: "walkin", tableIds });
    if (!r) return null;
    r.status = "da";
    r.arrivedAt = new Date().toISOString();
    // Der Bereich ergibt sich aus dem Tisch, an dem sie sitzen – nicht aus einem Wunsch, den niemand geäußert hat.
    const ersterTisch = tableIds.map((id) => this.getTable(id)).find(Boolean);
    if (ersterTisch) r.area = ersterTisch.area;
    persist();
    return r;
  },
  updateReservation(id, patch) {
    const r = data.reservations.find((x) => x.id === id);
    if (!r) return null;
    for (const key of ["date", "time", "name", "phone", "note", "area"]) {
      if (patch[key] !== undefined) r[key] = String(patch[key]).trim();
    }
    if (patch.guests !== undefined) r.guests = Math.max(1, Number(patch.guests) || 1);
    if (patch.tableIds !== undefined) {
      r.tableIds = [...patch.tableIds];
      // Status folgt der Zuweisung – aber nur solange der Gast noch nicht da ist, sonst würde ein
      // Umsetzen an einen anderen Tisch das "ist da" wieder zurücksetzen.
      if (r.status === "offen" && r.tableIds.length > 0) r.status = "zugewiesen";
      else if (r.status === "zugewiesen" && r.tableIds.length === 0) r.status = "offen";
    }
    if (patch.status !== undefined) {
      r.status = patch.status;
      if (patch.status === "da" && !r.arrivedAt) r.arrivedAt = new Date().toISOString();
      if (patch.status !== "da" && patch.status !== "weg") r.arrivedAt = null;
    }
    persist();
    return r;
  },
  /** Was sich mit einem Produkt verkauft: Menge, Umsatz und an wie vielen Tagen. Grundlage fuer
   * "was laeuft". Ohne Rezepte gibt es dazu keine Materialkosten mehr – die Zahl kam aus einer
   * Rechnung, die nur stimmte, solange jedes Rezept und jeder Einkaufspreis gepflegt war. */
  getProductStats(from, to) {
    const nachProdukt = new Map();
    for (const v of data.productSales) {
      if ((from && v.date < from) || (to && v.date > to)) continue;
      const key = v.productName;
      const e = nachProdukt.get(key) || { productName: key, menge: 0, umsatz: 0, mitPreis: 0, materialkosten: 0, tage: new Set() };
      e.menge += v.quantity;
      if (v.revenue != null) {
        e.umsatz = round2(e.umsatz + v.revenue);
        e.mitPreis += v.quantity;
      }
      e.tage.add(v.date);
      nachProdukt.set(key, e);
    }
    for (const e of nachProdukt.values()) e.tage = e.tage.size;
    return [...nachProdukt.values()].sort((a, b) => b.menge - a.menge);
  },

  /** Reservierungen zu Tageszahlen verdichtet – ohne Namen und Telefonnummern. */
  getReservationStats(from, to) {
    const nachTag = new Map();
    for (const r of data.reservations) {
      if ((from && r.date < from) || (to && r.date > to)) continue;
      const e = nachTag.get(r.date) || { date: r.date, anzahl: 0, gaeste: 0, walkins: 0, walkinGaeste: 0,
                                         storniert: 0, erschienen: 0, offen: 0, zeiten: [] };
      if (r.source === "walkin") {
        e.walkins++;
        e.walkinGaeste += r.guests;
      } else {
        e.anzahl++;
        e.gaeste += r.guests;
        if (r.status === "storniert") e.storniert++;
        else if (r.status === "da" || r.status === "weg") e.erschienen++;
        else e.offen++;
        e.zeiten.push(r.time);
      }
      nachTag.set(r.date, e);
    }
    return [...nachTag.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
  },

  // ---- Bingo-Abend: Termine und Anmeldungen ----
  //
  // Getrennt von den Reservierungen, weil es eine andere Sache ist: nicht ein Tisch zu einer Uhrzeit,
  // sondern eine feste Anzahl Plätze an einem festen Abend, pro Person bezahlt. Ein Termin ist erst
  // online anmeldbar, wenn er angelegt UND aktiv ist – so lässt sich der nächste Abend in Ruhe
  // vorbereiten, ohne dass schon jemand bucht.
  getEventSettings() {
    return { ...data.settings.event };
  },
  updateEventSettings(patch) {
    Object.assign(data.settings.event, patch);
    persist();
  },
  getEvents() {
    return [...data.events].sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  },
  /** Termine, für die man sich heute noch anmelden kann. Der Tag selbst zählt noch dazu – wer mittags
   * fragt, ob abends noch was frei ist, soll nicht vor einer leeren Seite stehen. */
  getUpcomingEvents() {
    const heute = todayStr();
    return this.getEvents().filter((e) => e.active !== false && e.date >= heute);
  },
  getEvent(id) {
    return data.events.find((e) => e.id === id) || null;
  },
  addEvent({ date, time = "18:00", price = 15, capacity = 40, note = "" }) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ""))) return null;
    const eintrag = {
      id: uid(),
      date,
      time,
      price: Number(price) || 0,
      capacity: Math.max(0, Number(capacity) || 0),
      note: String(note || "").trim(),
      active: true,
      createdAt: new Date().toISOString(),
    };
    data.events.push(eintrag);
    persist();
    return eintrag;
  },
  updateEvent(id, patch) {
    const e = data.events.find((x) => x.id === id);
    if (!e) return null;
    if (patch.date !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(patch.date)) e.date = patch.date;
    if (patch.time !== undefined) e.time = String(patch.time);
    if (patch.price !== undefined) e.price = Number(patch.price) || 0;
    if (patch.capacity !== undefined) e.capacity = Math.max(0, Number(patch.capacity) || 0);
    if (patch.note !== undefined) e.note = String(patch.note).trim();
    if (patch.active !== undefined) e.active = !!patch.active;
    persist();
    return e;
  },
  /** Termin löschen. Die Anmeldungen verschwinden mit – sie ergeben ohne ihren Abend keinen Sinn. */
  removeEvent(id) {
    data.events = data.events.filter((e) => e.id !== id);
    data.eventSignups = data.eventSignups.filter((s) => s.eventId !== id);
    persist();
  },
  getEventSignups(eventId) {
    return data.eventSignups
      .filter((s) => s.eventId === eventId)
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  },
  /** Wie voll ist der Abend? Abgesagte zählen nicht mit – sonst blockiert eine Absage einen Platz,
   * den es längst wieder gibt. */
  getEventBelegung(eventId) {
    const e = this.getEvent(eventId);
    const angemeldet = this.getEventSignups(eventId)
      .filter((s) => s.status !== "abgesagt")
      .reduce((sum, s) => sum + (Number(s.guests) || 0), 0);
    const kapazitaet = e ? e.capacity : 0;
    return { angemeldet, kapazitaet, frei: Math.max(0, kapazitaet - angemeldet), voll: kapazitaet > 0 && angemeldet >= kapazitaet };
  },
  addEventSignup({ eventId, name, contact, guests, note = "", source = "manuell", code = null }) {
    const e = this.getEvent(eventId);
    if (!e || !String(name || "").trim()) return null;
    const eintrag = {
      id: uid(),
      eventId,
      name: String(name).trim(),
      contact: String(contact || "").trim(),
      guests: Math.max(1, Number(guests) || 1),
      note: String(note || "").trim(),
      code: code || String(Math.floor(1000 + Math.random() * 9000)),
      source,
      status: "offen",
      paid: false,
      createdAt: new Date().toISOString(),
    };
    data.eventSignups.push(eintrag);
    persist();
    return eintrag;
  },
  updateEventSignup(id, patch) {
    const s = data.eventSignups.find((x) => x.id === id);
    if (!s) return null;
    if (patch.name !== undefined) s.name = String(patch.name).trim();
    if (patch.contact !== undefined) s.contact = String(patch.contact).trim();
    if (patch.guests !== undefined) s.guests = Math.max(1, Number(patch.guests) || 1);
    if (patch.note !== undefined) s.note = String(patch.note).trim();
    if (patch.status !== undefined) s.status = patch.status;
    if (patch.paid !== undefined) s.paid = !!patch.paid;
    persist();
    return s;
  },
  removeEventSignup(id) {
    data.eventSignups = data.eventSignups.filter((s) => s.id !== id);
    persist();
  },

  /** Hält einen verkauften Posten aus einem Kassenbericht fest (für "Renner & Penner"). */
  addProductSale({ date, productName, quantity, salePrice }) {
    const menge = Number(quantity) || 0;
    const name = String(productName || "").trim();
    if (!date || !name || menge <= 0) return null;
    const preis = Number.isFinite(Number(salePrice)) && Number(salePrice) > 0 ? round2(salePrice) : null;
    const eintrag = { id: uid(), date, productName: name, quantity: menge, salePrice: preis,
      revenue: preis === null ? null : round2(preis * menge) };
    data.productSales.push(eintrag);
    // Gedeckelt, damit der Speicher des iPads nicht unbegrenzt wächst – ein Jahr reicht für jede Auswertung.
    if (data.productSales.length > 8000) data.productSales = data.productSales.slice(-8000);
    persist();
    return eintrag;
  },
  getProductSales(from, to) {
    return data.productSales.filter((s) => (!from || s.date >= from) && (!to || s.date <= to));
  },

  /** Alle Reservierungen (für den Abgleich mit der Cloud). */
  getReservations() {
    return [...data.reservations];
  },
  /** Übernimmt die Nummer, die der Gast online schon auf dem Bildschirm gesehen hat. Sonst könnte er
   * sie am Telefon nennen und niemand fände die Reservierung wieder. */
  updateReservationCode(id, code) {
    const r = data.reservations.find((x) => x.id === id);
    if (!r || !code) return null;
    r.code = String(code).trim().toUpperCase();
    persist();
    return r;
  },
  removeReservation(id) {
    data.reservations = data.reservations.filter((r) => r.id !== id);
    persist();
  },
  getReservation(id) {
    return data.reservations.find((r) => r.id === id) || null;
  },
  /** Alle Reservierungen eines Tages, nach Uhrzeit sortiert. Abgesagte bleiben drin (ausgegraut anzeigen),
   * damit man sieht, dass da mal etwas war – wichtig, wenn jemand doch auftaucht. */
  getReservationsByDate(date) {
    return data.reservations
      .filter((r) => r.date === date)
      .sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : a.name.localeCompare(b.name)));
  },
  /** Ist die Terrasse an dem Tag gesperrt (Regen)? */
  isTerraceClosed(date) {
    return (data.settings.reservation?.terraceClosedDates || []).includes(date);
  },
  setTerraceClosed(date, closed) {
    const list = data.settings.reservation.terraceClosedDates || [];
    data.settings.reservation.terraceClosedDates = closed ? [...new Set([...list, date])] : list.filter((d) => d !== date);
    persist();
  },

  /** Welche Reservierungen belegen diesen Tisch zur gegebenen Zeit?
   *
   * Zwei Reservierungen kollidieren, wenn sich ihre Zeitfenster überschneiden. Das Fenster ist die Uhrzeit
   * plus die eingestellte Verweildauer. Ohne diese Annahme liesse sich gar nicht sagen, ob 18:00 und 19:00
   * am selben Tisch ein Problem sind. Abgesagte und No-Shows blockieren nichts mehr.
   */
  getTableConflicts(tableId, date, time, exceptReservationId = null) {
    const dauer = Number(data.settings.reservation?.durationMinutes) || 120;
    const minuten = (t) => {
      const [h, m] = String(t || "").split(":").map(Number);
      return (Number(h) || 0) * 60 + (Number(m) || 0);
    };
    const startA = minuten(time);
    const endeA = startA + dauer;
    return data.reservations.filter((r) => {
      if (r.id === exceptReservationId) return false;
      if (r.date !== date) return false;
      if (!r.tableIds?.includes(tableId)) return false;
      if (["storniert", "noshow", "weg"].includes(r.status)) return false;
      const startB = minuten(r.time);
      return startA < startB + dauer && startB < endeA;
    });
  },
  /** Position eines Tisches im Plan, in Prozent der Planfläche (0–100). Prozent statt Pixel, damit der
   * Plan auf iPad und Laptop gleich aussieht. */
  setTablePosition(id, x, y) {
    const t = data.tables.find((x2) => x2.id === id);
    if (!t) return null;
    t.x = Math.min(96, Math.max(0, Number(x) || 0));
    t.y = Math.min(94, Math.max(0, Number(y) || 0));
    persist();
    return t;
  },

  /** Wie ist es um einen Tisch zu einer bestimmten Uhrzeit bestellt?
   *
   * belegt   = eine Reservierung läuft gerade auf diesem Tisch
   * naechste = die nächste, die später an dem Tag noch kommt
   *
   * Beides zusammen beantwortet die Frage, die im Service wirklich gestellt wird: "Kann ich da jemanden
   * hinsetzen, und wenn ja, bis wann?"
   */
  getTableOccupancy(tableId, date, time) {
    const dauer = Number(data.settings.reservation?.durationMinutes) || 120;
    const minuten = (t) => {
      const [h, m] = String(t || "").split(":").map(Number);
      return (Number(h) || 0) * 60 + (Number(m) || 0);
    };
    const jetzt = minuten(time);
    const amTisch = data.reservations
      .filter((r) => r.date === date && r.tableIds?.includes(tableId) && !["storniert", "noshow"].includes(r.status))
      .sort((a, b) => (a.time < b.time ? -1 : 1));

    // "weg" heißt: Gäste sind gegangen, der Tisch ist wieder frei – auch wenn das Zeitfenster noch läuft.
    const belegt =
      amTisch.find((r) => r.status !== "weg" && minuten(r.time) <= jetzt && jetzt < minuten(r.time) + dauer) || null;
    const naechste = amTisch.find((r) => r.status !== "weg" && minuten(r.time) > jetzt) || null;
    return { belegt, naechste, alle: amTisch };
  },

  /** Stehen diese Tische so, dass man sie zu EINER Tafel zusammenschieben kann?
   *
   * Es reicht nicht, dass jeder Tisch irgendeinen Nachbarn in der Auswahl hat – die ganze Auswahl muss
   * zusammenhängen. Bei einer Reihe 1–2–3 sind 1+2 und 2+3 in Ordnung, 1+3 dagegen nicht: dazwischen
   * stünde Tisch 2 im Weg. Geprüft wird das, indem man von einem Tisch aus über die Nachbarschaften
   * läuft und schaut, ob man alle anderen erreicht.
   */
  areTablesCombinable(tableIds) {
    const ids = [...new Set(tableIds)].filter((id) => data.tables.some((t) => t.id === id));
    if (ids.length <= 1) return true;
    // Über zwei Bereiche hinweg geht nie – drinnen und draußen lassen sich nicht zusammenschieben.
    const bereiche = new Set(ids.map((id) => data.tables.find((t) => t.id === id).area));
    if (bereiche.size > 1) return false;

    const inAuswahl = new Set(ids);
    const erreicht = new Set([ids[0]]);
    const warteschlange = [ids[0]];
    while (warteschlange.length > 0) {
      const aktuell = warteschlange.shift();
      const tisch = data.tables.find((t) => t.id === aktuell);
      for (const n of tisch?.combinesWith || []) {
        if (!inAuswahl.has(n) || erreicht.has(n)) continue;
        erreicht.add(n);
        warteschlange.push(n);
      }
    }
    return erreicht.size === ids.length;
  },

  /** Passende Tische bzw. Tisch-Kombinationen für eine Reservierung, beste zuerst.
   *
   * Reihenfolge: möglichst wenige Tische, dann möglichst wenig verschenkte Plätze. Ein einzelner
   * Vierer ist also besser als zwei Zweier, und zwei Zweier sind besser als ein Sechser.
   * Kombiniert wird nur, was laut Nachbarschaft auch wirklich zusammengeschoben werden kann.
   */
  getCombinationSuggestions(date, time, guests, area, exceptReservationId = null, maxTische = 3) {
    const personen = Math.max(1, Number(guests) || 1);
    let frei = this.getFreeTables(date, time, exceptReservationId);
    // Bereichswunsch beachten – "egal" lässt beides zu.
    if (area === "innen" || area === "draussen") frei = frei.filter((t) => t.area === area);
    if (frei.length === 0) return [];

    const vorschlaege = [];
    const gesehen = new Set();
    const merken = (tische) => {
      const plaetze = tische.reduce((s, t) => s + t.seats, 0);
      if (plaetze < personen) return;
      const key = tische.map((t) => t.id).sort().join("|");
      if (gesehen.has(key)) return;
      gesehen.add(key);
      vorschlaege.push({ tableIds: tische.map((t) => t.id), names: tische.map((t) => t.name), seats: plaetze, count: tische.length });
    };

    // Einzelne Tische
    for (const t of frei) merken([t]);

    // Kombinationen: nur über echte Nachbarschaften, deshalb von jedem Tisch aus die Nachbarn ablaufen.
    // Die Suche ist auf maxTische begrenzt, sonst wüchse sie bei vielen Tischen ins Uferlose.
    const freiIds = new Set(frei.map((t) => t.id));
    const erweitern = (gruppe) => {
      if (gruppe.length >= maxTische) return;
      const kandidaten = new Set();
      for (const t of gruppe) {
        for (const n of t.combinesWith || []) {
          if (!freiIds.has(n) || gruppe.some((g) => g.id === n)) continue;
          kandidaten.add(n);
        }
      }
      for (const id of kandidaten) {
        const neu = [...gruppe, frei.find((t) => t.id === id)];
        merken(neu);
        erweitern(neu);
      }
    };
    for (const t of frei) erweitern([t]);

    vorschlaege.sort((a, b) => a.count - b.count || a.seats - b.seats || a.names.join().localeCompare(b.names.join()));
    return vorschlaege;
  },

  /** Tische, die zu dieser Zeit frei sind. Terrassentische fallen bei gesperrter Terrasse ganz raus. */
  getFreeTables(date, time, exceptReservationId = null) {
    const terrasseZu = this.isTerraceClosed(date);
    return this.getTables().filter((t) => {
      if (t.area === "draussen" && terrasseZu) return false;
      return this.getTableConflicts(t.id, date, time, exceptReservationId).length === 0;
    });
  },

  // ---- Abgeschlossene Schichtpläne (der Chef gibt eine Woche am Laptop frei) ----
  /** Merkt sich, dass eine Woche abgeschlossen ist. Erneutes Abschließen aktualisiert nur den Zeitpunkt,
   * damit ein zweiter Abgleich keinen doppelten Eintrag anlegt. */
  setWeekPublished(weekStart, publishedAt) {
    if (!weekStart) return;
    const vorhanden = data.publishedWeeks.find((w) => w.weekStart === weekStart);
    if (vorhanden) vorhanden.publishedAt = publishedAt || vorhanden.publishedAt;
    else data.publishedWeeks.push({ weekStart, publishedAt: publishedAt || new Date().toISOString() });
    persist();
  },
  setWeekUnpublished(weekStart) {
    data.publishedWeeks = data.publishedWeeks.filter((w) => w.weekStart !== weekStart);
    persist();
  },
  getPublishedWeeks() {
    return [...data.publishedWeeks];
  },

  // ---- Vergessenes Ausstempeln erkennen (für die Bot-Erinnerung) ----
  /** PIN-Schichten, die an einem VERGANGENEN Tag begonnen haben und noch offen sind (Ausstempeln vergessen).
   * Betrachtet nur die letzten paar Tage, damit uralte/kaputte Daten nicht ewig als "offen" auftauchen. */
  getStaleOpenShifts() {
    const today = todayStr();
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 3);
    const cutoffStr = cutoff.toISOString().slice(0, 10);
    const rows = [];
    for (const d of data.days) {
      if (d.date >= today || d.date < cutoffStr) continue;
      for (const s of d.shifts) {
        if (s.source === "pin" && !s.clockOutAt) {
          rows.push({ date: d.date, employeeName: this.getEmployee(s.employeeId)?.name || "?", from: s.from });
        }
      }
    }
    return rows;
  },

  // Stornos
  addStorno(dayId, storno) {
    const d = this.getDay(dayId);
    if (!d) return;
    const s = {
      id: uid(),
      amount: Number(storno.amount) || 0,
      reason: storno.reason || "",
      cashAffected: storno.cashAffected !== false,
      time: new Date().toISOString(),
    };
    d.stornos.push(s);
    this.logAudit(dayId, "Storno erfasst", `${s.amount} € – ${s.reason}`);
    persist();
    return s;
  },
  removeStorno(dayId, stornoId) {
    const d = this.getDay(dayId);
    if (!d) return;
    d.stornos = d.stornos.filter((s) => s.id !== stornoId);
    this.logAudit(dayId, "Storno entfernt", stornoId);
    persist();
  },

  // ---- Küche: Vorbereitungen und Rezepte ----
  //
  // Die Frage am Anfang jeder Schicht ist immer dieselbe: Was ist noch da? Bisher hiess die Antwort
  // nachsehen – in jeden Behaelter, jedes Mal. Hier traegt die Schicht beim Gehen eine Zahl ein, und die
  // naechste liest sie ab. Daneben steht das Soll: was mindestens dastehen sollte. Der Unterschied
  // zwischen "3 Behaelter" und "3 von 5" ist der ganze Sinn der Sache.
  PREP_EINHEITEN,
  getPreps(nurAktive = true) {
    return data.preps
      .filter((p) => !nurAktive || p.aktiv)
      .sort((a, b) => (a.sort || 0) - (b.sort || 0) || a.name.localeCompare(b.name));
  },
  getPrep(id) {
    return data.preps.find((p) => p.id === id) || null;
  },
  addPrep(v) {
    const p = normalizePrep({ ...v, sort: v?.sort ?? (data.preps.length + 1) * 10 });
    if (!p.name) return null;
    data.preps.push(p);
    persist();
    return p;
  },
  updatePrep(id, patch) {
    const i = data.preps.findIndex((p) => p.id === id);
    if (i < 0) return null;
    // bestand und verlauf bewusst nicht ueber diesen Weg: die aendert nur setPrepBestand().
    const { bestand, verlauf, ...rest } = patch || {};
    data.preps[i] = normalizePrep({ ...data.preps[i], ...rest, id });
    persist();
    return data.preps[i];
  },
  removePrep(id) {
    data.preps = data.preps.filter((p) => p.id !== id);
    persist();
  },
  /** Was gerade da ist. menge darf 0 sein ("nichts mehr da") – das ist etwas anderes als "nicht gezaehlt". */
  setPrepBestand(id, menge, by) {
    const p = this.getPrep(id);
    if (!p) return null;
    const zahl = Math.max(0, Number(menge));
    if (!Number.isFinite(zahl)) return null;
    p.bestand = { menge: zahl, at: new Date().toISOString(), by: by || null };
    p.verlauf = [...(p.verlauf || []), { menge: zahl, at: p.bestand.at, by: by || null }].slice(-30);
    persist();
    return p;
  },
  /** "leer" | "knapp" | "ok" | "unbekannt" – "unbekannt" heisst: seit dem Anlegen nie gezaehlt. */
  prepStatus(p) {
    if (!p?.bestand) return "unbekannt";
    if (p.bestand.menge <= 0) return "leer";
    if (p.soll > 0 && p.bestand.menge < p.soll) return "knapp";
    return "ok";
  },
  /** Wie alt ist die Zaehlung, in Stunden? null, wenn nie gezaehlt. */
  prepAlterStunden(p) {
    if (!p?.bestand?.at) return null;
    return Math.max(0, (Date.now() - new Date(p.bestand.at).getTime()) / 3600000);
  },

  getRecipes() {
    return [...data.recipes].sort((a, b) => a.name.localeCompare(b.name));
  },
  getRecipe(id) {
    return data.recipes.find((r) => r.id === id) || null;
  },
  addRecipe(v) {
    const r = normalizeRecipe({ ...v, updatedAt: new Date().toISOString() });
    if (!r.name) return null;
    data.recipes.push(r);
    persist();
    return r;
  },
  updateRecipe(id, patch) {
    const i = data.recipes.findIndex((r) => r.id === id);
    if (i < 0) return null;
    data.recipes[i] = normalizeRecipe({ ...data.recipes[i], ...patch, id, updatedAt: new Date().toISOString() });
    persist();
    return data.recipes[i];
  },
  removeRecipe(id) {
    data.recipes = data.recipes.filter((r) => r.id !== id);
    for (const p of data.preps) if (p.rezeptId === id) p.rezeptId = null;
    persist();
  },
  /** Rezepte aus einer anderen App uebernehmen.
   *
   * Gleiche Namen werden ueberschrieben statt verdoppelt: wer zweimal importiert, will nicht jedes Rezept
   * zweimal in der Liste haben. Gibt zurueck, was passiert ist – ein Import, der nur "fertig" sagt, laesst
   * einen im Unklaren, ob ueberhaupt etwas angekommen ist.
   */
  importRecipes(liste, quelle = "") {
    const eingang = Array.isArray(liste) ? liste : [];
    let neu = 0;
    let aktualisiert = 0;
    for (const roh of eingang) {
      const r = normalizeRecipe({ ...roh, quelle: roh?.quelle || quelle, updatedAt: new Date().toISOString() });
      if (!r.name) continue;
      const vorhanden = data.recipes.find((x) => x.name.toLowerCase() === r.name.toLowerCase());
      if (vorhanden) {
        Object.assign(vorhanden, { ...r, id: vorhanden.id });
        aktualisiert++;
      } else {
        data.recipes.push(r);
        neu++;
      }
    }
    // Gleicher Name = gemeint ist dasselbe: eine Vorbereitung ohne Rezept bekommt es jetzt automatisch
    // angehaengt. Sonst muesste man nach dem Import jede Zeile von Hand zuordnen, obwohl die Zuordnung
    // offensichtlich ist.
    let verknuepft = 0;
    for (const pr of data.preps) {
      if (pr.rezeptId) continue;
      const treffer = data.recipes.find((r) => r.name.toLowerCase() === pr.name.toLowerCase());
      if (treffer) {
        pr.rezeptId = treffer.id;
        verknuepft++;
      }
    }
    persist();
    return { neu, aktualisiert, verknuepft, gesamt: eingang.length };
  },

  // ---- Aufgaben ----
  getTaskTemplates() {
    return data.settings.taskTemplates;
  },
  /** Ersetzt die ganze Liste. Nimmt auch blosse Textzeilen an – der Bot und aeltere Aufrufer schicken
   * teils noch Strings, und daran soll nichts zerbrechen. */
  setTaskTemplates(items) {
    data.settings.taskTemplates = normalizeTaskTemplates(items);
    persist();
  },
  addTaskTemplate(v) {
    const t = normalizeTaskTemplate(v);
    if (!t.text) return null;
    data.settings.taskTemplates.push(t);
    persist();
    return t;
  },
  updateTaskTemplate(id, patch) {
    const i = data.settings.taskTemplates.findIndex((t) => t.id === id);
    if (i < 0) return null;
    data.settings.taskTemplates[i] = normalizeTaskTemplate({ ...data.settings.taskTemplates[i], ...patch, id });
    persist();
    return data.settings.taskTemplates[i];
  },
  removeTaskTemplate(id) {
    data.settings.taskTemplates = data.settings.taskTemplates.filter((t) => t.id !== id);
    persist();
  },
  /** Die Standard-Aufgaben, die diese Person an diesem Tag bekommt.
   *
   * Gefiltert wird dreifach: Wochentag, Schicht und Bereich. Was ohne Angabe dasteht, gilt fuer alle –
   * so wie bisher. Sortiert nach Abschnitt (Beginn, waehrend, Ende) und darin nach Uhrzeit, damit die
   * Reihenfolge auf dem iPad die Reihenfolge des Abends ist.
   */
  vorlagenFuerSchicht(dateStr, { schichtGruppe, rolle }) {
    return templatesForWeekday(dateStr)
      .filter((v) => this.aufgabeGehoertZu(v, { schichtGruppe, rolle }))
      .sort(
        (a, b) =>
          AUFGABEN_PHASEN.indexOf(a.phase || "schicht") - AUFGABEN_PHASEN.indexOf(b.phase || "schicht") ||
          (a.time || "99:99").localeCompare(b.time || "99:99")
      );
  },

  /** Die Standard-Aufgaben fuer eine Person anlegen, die gerade eingestempelt hat.
   *
   * Frueher hingen die Vorlagen am Tag: eine Liste, die niemandem gehoerte. Jetzt bekommt jede Person
   * beim Einstempeln ihre eigene – sonst ist nach einer Schicht nicht mehr zu sehen, wer was gemacht
   * hat, und bei zwei Leuten im Haus fuehlt sich fuer keine Aufgabe jemand zustaendig.
   *
   * Jede Vorlage entsteht pro Person und Tag nur EINMAL (appliedShiftTemplateIds). Wer eine Aufgabe
   * loescht, hat das so gemeint – sie darf nicht beim naechsten Blick wieder dastehen.
   *
   * Gibt die Zahl der angelegten Aufgaben zurueck.
   */
  ergaenzeSchichtaufgaben(employeeId, dateStr = todayStr()) {
    const d = this.getDayByDate(dateStr);
    if (!d || d.status !== "offen") return 0;
    const emp = this.getEmployee(employeeId);
    if (!emp) return 0;

    const gruppe = this.getSchichtGruppeFuer(employeeId, dateStr);
    const vorlagen = this.vorlagenFuerSchicht(dateStr, { schichtGruppe: gruppe, rolle: emp.role });
    if (!Array.isArray(d.appliedShiftTemplateIds)) d.appliedShiftTemplateIds = [];

    // Uebergang vom alten System: Vorlagen-Aufgaben, die dem Tag als Ganzes mitgegeben wurden, gehoeren
    // ab jetzt einer Person. Die alten, noch offenen Kopien fliegen beim ersten Einstempeln raus –
    // sonst stuende alles doppelt da. Erledigtes und Weitergegebenes bleibt unangetastet, das ist Historie.
    if (!d.schichtaufgabenMigriert) {
      d.tasks = d.tasks.filter((t) => !(t.source === "template" && !t.assignedTo && !t.done && !t.handoffFrom));
      d.schichtaufgabenMigriert = true;
    }

    const schon = new Set(d.appliedShiftTemplateIds);
    let neu = 0;
    for (const v of vorlagen) {
      const schluessel = `${employeeId}:${v.id}`;
      if (schon.has(schluessel)) continue;
      d.tasks.push({
        id: uid(),
        text: v.text,
        done: false,
        doneBy: null,
        doneAt: null,
        source: "template",
        templateId: v.id,
        addedBy: null,
        assignedTo: employeeId,
        priority: v.priority || "normal",
        schicht: v.schicht || gruppe || "",
        bereich: v.bereich || "",
        time: v.time || "",
        phase: v.phase || "schicht",
      });
      d.appliedShiftTemplateIds.push(schluessel);
      neu++;
    }
    if (neu > 0 || d.schichtaufgabenMigriert) persist();
    return neu;
  },

  /** Dasselbe fuer alle, die heute gerade im Dienst sind. Laeuft beim Abgleich mit – so greift eine neu
   * angelegte Vorlage spaetestens nach 90 Sekunden auch bei denen, die schon eingestempelt sind. */
  ergaenzeSchichtaufgabenFuerOffene(dateStr = todayStr()) {
    let neu = 0;
    for (const s of this.getOpenShiftsToday(dateStr)) neu += this.ergaenzeSchichtaufgaben(s.employeeId, dateStr);
    return neu;
  },

  /** Aufgaben nach Abschnitt sortiert: { beginn: [...], schicht: [...], ende: [...] }.
   * Eine Aufgabe ohne Abschnitt (Einzelaufgabe, per Bot angelegt) zaehlt zu "waehrend der Schicht". */
  aufgabenNachPhase(tasks) {
    const nach = { beginn: [], schicht: [], ende: [] };
    for (const t of tasks || []) nach[AUFGABEN_PHASEN.includes(t.phase) ? t.phase : "schicht"].push(t);
    return nach;
  },

  /** Welche Vorlagen gelten an diesem Datum? Fuer die Vorschau in der Verwaltung. */
  getTaskTemplatesForDate(dateStr) {
    return templatesForWeekday(dateStr);
  },

  /** Zu welcher Schicht-Gruppe gehoert eine Schicht-ID?
   *
   * Die Schichten heissen je nach Bereich anders (frueh1/frueh2 im Service, frueh1/frueh2 in der Kueche),
   * aber fuer Aufgaben zaehlt nur: Frueh, Mitte oder Spaet. Genau so denkt man im Betrieb auch darueber.
   */
  schichtGruppe(slotId) {
    const id = String(slotId || "");
    if (id.startsWith("frueh")) return "frueh";
    if (id.startsWith("mittel")) return "mittel";
    if (id.startsWith("spaet")) return "spaet";
    return "";
  },
  /** Die Schicht-Gruppe, in der jemand an diesem Tag steckt.
   *
   * Zwei Wege, weil der erste oft fehlt: die bestaetigte Schicht aus der Verfuegbarkeit ist die saubere
   * Antwort, aber nicht jeder Tag wird geplant. Deshalb sonst ueber die Anfangszeit – wer um 8:35
   * einstempelt, ist in der Frueh, egal ob das jemand eingetragen hat. Lieber aus der Uhrzeit erschlossen
   * als gar keine Zuordnung: sonst saehe niemand seine Schicht-Aufgaben.
   */
  getSchichtGruppeFuer(employeeId, dateStr = todayStr()) {
    const d = this.getDayByDate(dateStr);
    if (!d) return "";
    const verf = (d.availability || []).find((a) => a.employeeId === employeeId);
    if (verf?.confirmedSlotId) return this.schichtGruppe(verf.confirmedSlotId);

    // Die GEPLANTE Schicht zuerst: sie ist das, was der Chef zugeteilt hat. Die Einstempelzeit ist nur
    // der Ersatz fuer den Fall, dass niemand geplant hat – wer eine halbe Stunde zu spaet kommt, waere
    // sonst ploetzlich in einer anderen Schicht.
    const geplant = (d.plannedShifts || []).find((s) => s.employeeId === employeeId);
    const laufend = (d.shifts || []).find((s) => s.employeeId === employeeId);
    const beginn = geplant?.from || laufend?.from || "";
    if (!beginn) return "";
    const slots = this.getShiftSlotsForRole(this.getEmployee(employeeId)?.role, dateStr);
    if (slots.length === 0) return "";
    // Die Schicht, die zu dieser Zeit LAEUFT: die letzte, die schon begonnen hat. Nicht die zeitlich
    // naechste – wer um 18:05 kommt, ist in der Spaetschicht, auch wenn die um 15:30 angefangen hat.
    const sortiert = [...slots].sort((x, y) => minutenAusUhrzeit(x.from) - minutenAusUhrzeit(y.from));
    let treffer = sortiert[0];
    for (const slot of sortiert) {
      if (minutenAusUhrzeit(slot.from) <= minutenAusUhrzeit(beginn)) treffer = slot;
    }
    return this.schichtGruppe(treffer.id);
  },
  /** Gehoert diese Aufgabe zu dieser Person? Ohne Schicht/Bereich gilt sie fuer alle. */
  aufgabeGehoertZu(task, { schichtGruppe, rolle }) {
    if (task.schicht && task.schicht !== schichtGruppe) return false;
    if (task.bereich && task.bereich !== (rolle === "kueche" ? "kueche" : "service")) return false;
    return true;
  },
  /** Ist eine Aufgabe mit Uhrzeit jetzt dran? Ohne Uhrzeit: immer.
   * jetzt = "HH:MM", damit sich das ohne Systemuhr testen laesst. */
  istFaellig(task, jetzt = uhrzeitJetzt()) {
    if (!task.time) return true;
    return jetzt >= task.time;
  },
  /** Wie lange ist sie ueberfaellig, in Minuten? 0, wenn sie noch nicht dran ist oder keine Zeit hat. */
  ueberfaelligSeit(task, jetzt = uhrzeitJetzt()) {
    if (!task.time || jetzt < task.time) return 0;
    return minutenAusUhrzeit(jetzt) - minutenAusUhrzeit(task.time);
  },
  toggleDayTask(dayId, taskId, employeeName) {
    const d = this.getDay(dayId);
    if (!d) return;
    const t = d.tasks.find((x) => x.id === taskId);
    if (!t) return;
    t.done = !t.done;
    t.doneBy = t.done ? employeeName || null : null;
    t.doneAt = t.done ? new Date().toISOString() : null;
    persist();
  },
  /** Explizit setzen statt umschalten (z.B. beim Cloud-Abgleich, wenn der Bot "erledigt" gesetzt hat). */
  setDayTaskDone(dayId, taskId, done, doneBy) {
    const d = this.getDay(dayId);
    if (!d) return;
    const t = d.tasks.find((x) => x.id === taskId);
    if (!t) return;
    t.done = done;
    t.doneBy = done ? doneBy || null : null;
    t.doneAt = done ? new Date().toISOString() : null;
    persist();
  },
  /** Zentrale Aufgaben-Erstellung – alle anderen addXDayTask-Methoden sind dünne Wrapper darum.
   * Optionales `id` (z.B. vom Cloud-Abgleich vorgegeben), damit beide Seiten dieselbe ID für dieselbe
   * Aufgabe verwenden. */
  addTask(dayId, { id, text, assignedTo = null, priority = "normal", source = "adhoc", addedBy = null, schicht = "", bereich = "", time = "" }) {
    const d = this.getDay(dayId);
    if (!d) return;
    const t = { id: id || uid(), text, done: false, doneBy: null, doneAt: null, source, addedBy, assignedTo, priority, schicht, bereich, time };
    d.tasks.push(t);
    persist();
    return t;
  },
  addAdhocDayTask(dayId, text, employeeName) {
    return this.addTask(dayId, { text, addedBy: employeeName || null, source: "adhoc" });
  },
  /** Aufgabe aus dem Cloud-Abgleich (taskSync.js) – optional einem Mitarbeiter/einer Priorität zugeordnet. */
  addRemoteDayTask(dayId, { id, text, assignedTo = null, priority = "normal", addedBy = "Telegram", schicht = "", bereich = "", time = "" }) {
    return this.addTask(dayId, { id, text, assignedTo, priority, addedBy, source: "remote", schicht, bereich, time });
  },
  /** Vom Admin manuell angelegte Aufgabe (Admin → Aufgaben). */
  addAdminTask(dayId, { text, assignedTo = null, priority = "normal", schicht = "", bereich = "", time = "" }) {
    return this.addTask(dayId, { text, assignedTo, priority, addedBy: "Admin", source: "admin", schicht, bereich, time });
  },
  /** Bearbeiten (Text/Zuordnung/Priorität) einer bestehenden Aufgabe, unabhängig von der Quelle. */
  updateTaskFields(dayId, taskId, patch) {
    const d = this.getDay(dayId);
    if (!d) return;
    const t = d.tasks.find((x) => x.id === taskId);
    if (!t) return;
    Object.assign(t, patch);
    persist();
    return t;
  },
  /** Mitarbeiter gibt eine Aufgabe an eine andere Person weiter (z.B. schafft er sie nicht mehr in der Schicht). */
  handoffTask(dayId, taskId, toEmployeeId, fromEmployeeName) {
    const d = this.getDay(dayId);
    if (!d) return;
    const t = d.tasks.find((x) => x.id === taskId);
    if (!t) return;
    t.assignedTo = toEmployeeId;
    t.handoffFrom = fromEmployeeName;
    t.handoffAt = new Date().toISOString();
    persist();
    return t;
  },
  /** Aufgabe auf einen anderen Tag verschieben (z.B. beim Bearbeiten das Datum ändern). */
  moveTaskToDay(fromDayId, taskId, toDateStr) {
    const from = this.getDay(fromDayId);
    if (!from) return;
    const t = from.tasks.find((x) => x.id === taskId);
    if (!t) return;
    if (from.date === toDateStr) return t;
    from.tasks = from.tasks.filter((x) => x.id !== taskId);
    const to = this.getOrCreateDayByDate(toDateStr);
    const moved = { ...t };
    to.tasks.push(moved);
    persist();
    return moved;
  },
  removeDayTask(dayId, taskId) {
    const d = this.getDay(dayId);
    if (!d) return;
    d.tasks = d.tasks.filter((t) => t.id !== taskId);
    persist();
  },
  /** Alle Aufgaben ab (inkl.) einem Datum, über alle Tage hinweg – für die Admin-Übersicht. */
  getTasksFrom(dateStr) {
    const rows = [];
    for (const d of this.getDays()) {
      if (d.date < dateStr) continue;
      for (const t of d.tasks) rows.push({ ...t, dayId: d.id, date: d.date });
    }
    rows.sort((a, b) => (a.date === b.date ? 0 : a.date < b.date ? -1 : 1));
    return rows;
  },

  // ---- Telegram-Aufgaben-Inbox (Abgleich mit dem Cloudflare-Worker/KV-Speicher) ----
  getTaskInboxConfig() {
    return data.settings.taskInbox;
  },
  updateTaskInboxConfig(patch) {
    Object.assign(data.settings.taskInbox, patch);
    persist();
  },

  // ---- Backup ----
  /**
   * Der eigene GitHub-Token darf NIE Teil der gesicherten Daten sein – sonst committet das automatische
   * Backup den Token, mit dem es selbst schreibt, ins Repo (GitHub blockiert das zurecht als Secret-Leak,
   * s. Fehler "Secret detected in content"). Beim Wiederherstellen wird der Token ohnehin manuell neu
   * eingetragen (ohne ihn hättet ihr die Sicherung gar nicht erst abrufen können).
   */
  exportJSON() {
    const redacted = { ...data, settings: { ...data.settings, githubBackup: { ...data.settings.githubBackup, token: "" } } };
    return JSON.stringify(redacted, null, 2);
  },
  importJSON(json) {
    const parsed = JSON.parse(json);
    const base = defaultData();
    const migratedTemplates = migrateTaskTemplates(parsed.settings);
    data = {
      employees: (parsed.employees ?? []).map((e) => ({ ...e, festeSchichten: normalizeFesteSchichten(e.festeSchichten) })),
      settings: {
        ...base.settings,
        ...(parsed.settings ?? {}),
        taskTemplates: normalizeTaskTemplates(parsed.settings?.taskTemplates ?? migratedTemplates ?? base.settings.taskTemplates),
        githubBackup: { ...base.settings.githubBackup, ...(parsed.settings?.githubBackup ?? {}) },
        taskInbox: { ...base.settings.taskInbox, ...(parsed.settings?.taskInbox ?? {}) },
        reservation: { ...base.settings.reservation, ...(parsed.settings?.reservation ?? {}) },
        event: migrateEventSettings({ ...base.settings.event, ...(parsed.settings?.event ?? {}) }, base.settings.event),
        shiftSlots: base.settings.shiftSlots, // rein code-gesteuert (keine Bearbeiten-UI) -> immer aktuelle Definition, nie aus localStorage "einfrieren"
      },
      days: (parsed.days ?? []).map(normalizeDay),
      notifications: parsed.notifications ?? [],
      stock: parsed.stock ?? [],
      absences: parsed.absences ?? (parsed.sickDays || []).map((s) => ({ ...s, art: "krank" })),
      publishedWeeks: parsed.publishedWeeks ?? [],
      productSales: parsed.productSales ?? [],
      stocktakes: parsed.stocktakes ?? [],
      tables: parsed.tables ?? [],
      reservations: parsed.reservations ?? [],
      events: parsed.events ?? [],
      eventSignups: parsed.eventSignups ?? [],
      preps: (parsed.preps ?? []).map(normalizePrep),
      recipes: (parsed.recipes ?? []).map(normalizeRecipe),
    };
    persist();
  },
  wipeAll() {
    data = defaultData();
    persist();
  },
};

export { uid, AUFGABEN_PHASEN, PHASE_LABEL };
