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
function roundPreis(n) {
  return Math.round((Number(n) || 0) * 100000) / 100000;
}

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
      taskTemplates: [], // Aufgaben-Vorlagen, werden beim Anlegen eines Tages in day.tasks kopiert
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
      // Feste Schicht-Zeitfenster für die Verfügbarkeits-Abfrage im Kiosk. "service" gilt auch für "bar"
      // (teilen sich einen Plan, blockieren sich gegenseitig). allowedWeekdays: 0=Mo..6=So, fehlt = alle Tage.
      // "mittel" braucht IMMER eine explizite Chef-Bestätigung, auch wenn sie automatisch fest wird.
      // Namen und Zeiten entsprechen dem Papier-Schichtplan des Cafés.
      // weekdayOverrides: abweichende Zeiten an einzelnen Wochentagen (0=Mo).
      shiftSlots: {
        service: [
          { id: "frueh1", label: "Service 1", from: "08:30", to: "16:00", weekdayOverrides: { 0: { to: "17:00" }, 1: { to: "17:00" } } }, // Mo/Di bis 17:00
          { id: "frueh2", label: "Service 2", from: "09:30", to: "17:00", allowedWeekdays: [5, 6] }, // nur Sa/So
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
        // IDs vom Bot per "X ist wieder da" wiederaufgefüllter Vorräte, die schon übernommen wurden.
        appliedRestockIds: [],
        // IDs von per Lieferschein-Foto erkannten Lieferungen, die schon als Verlauf übernommen wurden.
        appliedDeliveryIds: [],
        // IDs von per SumUp-Verkaufsbericht-Foto erkannten Verkäufen, die schon gegen Rezepte verrechnet wurden.
        appliedSaleIds: [],
        // IDs von Krankmeldungen (vom Handy), die schon als Krank-Tage übernommen wurden.
        appliedSickIds: [],
        // "Woche|Name|Zeitstempel" der Verfügbarkeits-Einreichungen vom Handy, die schon übernommen wurden.
        appliedAvailabilityKeys: [],
        // IDs der vom Laptop eingereichten Artikel- bzw. Rezept-Änderungen, die schon übernommen wurden.
        appliedStockChangeIds: [],
        appliedRecipeChangeIds: [],
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
    // Vorräte – Ampel (ok/knapp/leer) für alle Artikel; optional mit echter Mengenführung (unit gesetzt),
    // dann wird die Ampel automatisch aus currentAmount berechnet. Admin verwaltet die Artikel-Liste.
    // { id, name, status, updatedAt, updatedBy, deliveries[], consumptionLog[], unit, currentAmount, lowThreshold }
    stock: [],
    // Rezepte: verknüpfen ein Verkaufsprodukt (wie es im SumUp-Bericht heißt) mit den Zutaten-Artikeln aus
    // "stock" und deren Verbrauch pro verkauftem Stück – Basis für die automatische Bestandsrechnung.
    // { id, productName, ingredients: [{ stockItemId, amount }] }
    recipes: [],
    // Krankmeldungen (kommen vom Handy der Mitarbeiter über den Worker herein, ein Eintrag pro Tag).
    // { id, employeeId, date, note, reportedAt }
    sickDays: [],
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
  };
}

/** Migration: alte Beta-Checklisten-Vorlagen (fruh/mittel/spaet) in die neue flache taskTemplates-Liste überführen. */
function migrateTaskTemplates(oldSettings) {
  const legacy = oldSettings?.checklistTemplates;
  if (!legacy) return null;
  const merged = [...(legacy.fruh || []), ...(legacy.mittel || []), ...(legacy.spaet || [])];
  return [...new Set(merged.map((s) => s.trim()).filter(Boolean))];
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
    tasks: (d.tasks || []).map((t) => ({ priority: "normal", ...t })),
    // Wareneinsatz des Tages (Summe der verbrauchten Waren zum Einkaufspreis).
    materialkosten: Number(d.materialkosten) || 0,
  };
}

function load() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return defaultData();
  try {
    const parsed = JSON.parse(raw);
    const base = defaultData();
    const migratedTemplates = migrateTaskTemplates(parsed.settings);
    return {
      employees: parsed.employees ?? base.employees,
      settings: {
        ...base.settings,
        ...(parsed.settings ?? {}),
        taskTemplates: parsed.settings?.taskTemplates ?? migratedTemplates ?? base.settings.taskTemplates,
        githubBackup: { ...base.settings.githubBackup, ...(parsed.settings?.githubBackup ?? {}) },
        taskInbox: { ...base.settings.taskInbox, ...(parsed.settings?.taskInbox ?? {}) },
        reservation: { ...base.settings.reservation, ...(parsed.settings?.reservation ?? {}) },
        shiftSlots: base.settings.shiftSlots, // rein code-gesteuert (keine Bearbeiten-UI) -> immer aktuelle Definition, nie aus localStorage "einfrieren"
      },
      days: (parsed.days ?? base.days).map(normalizeDay),
      notifications: parsed.notifications ?? base.notifications,
      stock: parsed.stock ?? base.stock,
      recipes: parsed.recipes ?? base.recipes,
      sickDays: parsed.sickDays ?? base.sickDays,
      publishedWeeks: parsed.publishedWeeks ?? base.publishedWeeks,
      productSales: parsed.productSales ?? base.productSales,
      stocktakes: parsed.stocktakes ?? base.stocktakes,
      tables: parsed.tables ?? base.tables,
      reservations: parsed.reservations ?? base.reservations,
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

/** Berechnet bei mengengeführten Vorräten (item.unit gesetzt) die Ampel automatisch aus currentAmount –
 * reine Ampel-Artikel (kein unit) bleiben unangetastet, deren Status wird weiter manuell gesetzt. */
function recomputeStockStatus(item) {
  if (!item.unit) return;
  const amount = Number(item.currentAmount) || 0;
  if (amount <= 0) item.status = "leer";
  else if (amount <= (Number(item.lowThreshold) || 0)) item.status = "knapp";
  else item.status = "ok";
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
    };
    data.employees.push(e);
    persist();
    return e;
  },
  updateEmployee(id, patch) {
    const e = this.getEmployee(id);
    if (!e) return;
    Object.assign(e, patch);
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
      tasks: data.settings.taskTemplates.map((text) => ({ id: uid(), text, done: false, doneBy: null, doneAt: null, source: "template", assignedTo: null, priority: "normal" })),
      kassenabschluss: { umsatzGesamt: 0, umsatzBar: 0, umsatz7: 0, umsatz19: 0, trinkgeldKarte: 0, trinkgeldBar: 0 },
      stornos: [],
      auditLog: [{ timestamp: new Date().toISOString(), action: "erstellt", detail: `Tag ${dateStr} angelegt` }],
      closedAt: null,
    };
    data.days.push(d);
    persist();
    return d;
  },
  /** Holt den heutigen Tag oder legt ihn an (inkl. Aufgaben aus den Vorlagen). */
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
    if (already) return { day: d, shift: already };
    const now = new Date();
    const s = { id: uid(), employeeId, from: hhmmLocal(now), to: null, note: "", source: "pin", clockInAt: now.toISOString(), clockOutAt: null };
    d.shifts.push(s);
    this.logAudit(d.id, "eingestempelt", `${this.getEmployee(employeeId)?.name || employeeId} um ${s.from} Uhr`);
    persist();
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

  // ---- Vorräte (Ampel: ok/knapp/leer, kein Mengen-Tracking) ----
  getStockItems() {
    return [...data.stock].sort((a, b) => a.name.localeCompare(b.name));
  },
  /** Admin legt einen neuen Artikel an (Status startet bei "ok"). */
  /** opts optional: { unit, currentAmount, lowThreshold } – nur mit "unit" wird der Artikel mengengeführt
   * (Status dann automatisch aus currentAmount berechnet), sonst bleibt es bei der reinen Ampel wie bisher. */
  addStockItem(name, opts = {}) {
    const unit = String(opts.unit || "").trim();
    const item = {
      id: uid(),
      name: String(name || "").trim(),
      status: "ok",
      updatedAt: null,
      updatedBy: null,
      deliveries: [],
      unit,
      currentAmount: unit ? Number(opts.currentAmount) || 0 : null,
      lowThreshold: unit ? Number(opts.lowThreshold) || 0 : null,
      consumptionLog: [],
      // true = automatisch aus einem Beleg angelegt und noch nicht vom Chef bestaetigt. Solange das steht,
      // taucht der Artikel oben in der Bestand-Ansicht zum Einordnen auf.
      needsReview: !!opts.needsReview,
      // Wo der Artikel gebraucht wird – trennt die Inventur und die Einkaufsliste nach Bereichen.
      bereich: opts.bereich === "bar" ? "bar" : "kueche",
      // Wie bestellt/geliefert wird: wie viele Einzelstücke in einem Gebinde stecken und wie das heisst.
      // Wichtig, weil auf dem Lieferschein Kästen stehen, im Kassenbericht aber einzelne Flaschen.
      packSize: Math.max(1, Number(opts.packSize) || 1),
      packLabel: String(opts.packLabel || "").trim(),
      // Einkaufspreis je EINZELNER Mengeneinheit (netto). Grundlage für den Wareneinsatz.
      // Kommt meist automatisch vom Lieferschein, lässt sich aber überschreiben.
      pricePerUnit: Number.isFinite(Number(opts.pricePerUnit)) ? roundPreis(opts.pricePerUnit) : null,
      priceUpdatedAt: null,
      priceSource: null, // "beleg" | "manuell"
    };
    if (!item.name) return null;
    if (unit) recomputeStockStatus(item);
    data.stock.push(item);
    persist();
    return item;
  },
  /** Führt ein irrtümlich doppelt angelegtes Produkt mit dem richtigen zusammen: der alte Name wird als
   * Zweitname gemerkt, ein etwaiger Bestand übernommen, der Doppelgänger verschwindet. */
  mergeStockItem(vonId, aufId) {
    const von = data.stock.find((s) => s.id === vonId);
    const auf = data.stock.find((s) => s.id === aufId);
    if (!von || !auf || vonId === aufId) return null;
    this.addNameAlias("artikel", aufId, von.name);
    for (const a of von.aliases || []) this.addNameAlias("artikel", aufId, a);
    // Der Doppelgänger wurde aus einem Verkauf angelegt und steht deshalb meist im Minus. Genau dieser
    // Verbrauch gehört zum richtigen Artikel – deshalb wird er übernommen, nicht verworfen.
    if (auf.unit && von.unit && Number.isFinite(Number(von.currentAmount))) {
      auf.currentAmount = round2((Number(auf.currentAmount) || 0) + (Number(von.currentAmount) || 0));
      recomputeStockStatus(auf);
    }
    if (Array.isArray(von.consumptionLog) && von.consumptionLog.length) {
      auf.consumptionLog = [...(auf.consumptionLog || []), ...von.consumptionLog].slice(0, 20);
    }
    data.stock = data.stock.filter((s) => s.id !== vonId);
    persist();
    return auf;
  },
  /** Dasselbe für ein doppelt angelegtes Rezept. */
  mergeRecipe(vonId, aufId) {
    const von = data.recipes.find((r) => r.id === vonId);
    const auf = data.recipes.find((r) => r.id === aufId);
    if (!von || !auf || vonId === aufId) return null;
    this.addNameAlias("rezept", aufId, von.productName);
    for (const a of von.aliases || []) this.addNameAlias("rezept", aufId, a);
    data.recipes = data.recipes.filter((r) => r.id !== vonId);
    persist();
    return auf;
  },
  removeStockItem(id) {
    data.stock = data.stock.filter((s) => s.id !== id);
    persist();
  },
  /** Artikel bearbeiten (Name, Einheit, Warnschwelle). Wird eine Einheit ergänzt, startet damit die
   * Mengenführung; wird sie entfernt, fällt der Artikel auf die reine Ampel zurück. */
  updateStockItem(id, patch) {
    const item = data.stock.find((s) => s.id === id);
    if (!item) return null;
    if (patch.name !== undefined && String(patch.name).trim()) item.name = String(patch.name).trim();
    if (patch.bereich !== undefined) item.bereich = patch.bereich === "bar" ? "bar" : "kueche";
    if (patch.packSize !== undefined) item.packSize = Math.max(1, Number(patch.packSize) || 1);
    if (patch.packLabel !== undefined) item.packLabel = String(patch.packLabel).trim();
    if (patch.pricePerUnit !== undefined) {
      const p = Number(patch.pricePerUnit);
      item.pricePerUnit = Number.isFinite(p) && p >= 0 ? roundPreis(p) : null;
      item.priceUpdatedAt = new Date().toISOString();
      item.priceSource = patch.priceSource || "manuell";
    }
    if (patch.unit !== undefined) {
      const unit = String(patch.unit).trim();
      item.unit = unit;
      if (unit) {
        if (item.currentAmount === null || item.currentAmount === undefined) item.currentAmount = 0;
        if (item.lowThreshold === null || item.lowThreshold === undefined) item.lowThreshold = 0;
      } else {
        item.currentAmount = null;
        item.lowThreshold = null;
      }
    }
    if (patch.lowThreshold !== undefined && item.unit) item.lowThreshold = Number(patch.lowThreshold) || 0;
    if (item.unit) recomputeStockStatus(item);
    item.updatedAt = new Date().toISOString();
    persist();
    return item;
  },
  /** Mitarbeiter (im Kiosk) oder Chef (per Bot) ändern den Status eines Artikels. */
  setStockStatus(id, status, changedBy) {
    const item = data.stock.find((s) => s.id === id);
    if (!item) return;
    item.status = status;
    item.updatedAt = new Date().toISOString();
    item.updatedBy = changedBy || null;
    persist();
    return item;
  },
  /** Manuelle Mengen-Korrektur (z.B. nach einer echten Nachzählung) für mengengeführte Artikel. */
  setStockAmount(id, amount, changedBy) {
    const item = data.stock.find((s) => s.id === id);
    if (!item || !item.unit) return;
    item.currentAmount = Number(amount) || 0;
    recomputeStockStatus(item);
    item.updatedAt = new Date().toISOString();
    item.updatedBy = changedBy || null;
    persist();
    return item;
  },
  /** Loggt eine Lieferung (z.B. aus einem per Bot hochgeladenen Lieferschein-Foto) – Historie ("wann wurde
   * wie viel geliefert") UND, falls der Artikel mengengeführt ist (unit gesetzt), Erhöhung von
   * currentAmount + automatische Status-Neuberechnung. Ist noch keine Einheit hinterlegt, aber die
   * Lieferung nennt eine, wird die Mengenführung damit automatisch "gebootstrapped". */
  addStockDelivery(id, { date, quantity, unit, note }) {
    const item = data.stock.find((s) => s.id === id);
    if (!item) return;
    if (!Array.isArray(item.deliveries)) item.deliveries = [];
    const qty = Number(quantity);
    item.deliveries.unshift({ id: uid(), date: date || todayStr(), quantity: Number.isFinite(qty) ? qty : null, unit: unit || "", note: note || "" });
    item.deliveries = item.deliveries.slice(0, 20); // Historie nicht unbegrenzt wachsen lassen
    if (Number.isFinite(qty) && unit) {
      if (!item.unit) item.unit = unit; // erste Lieferung mit Einheit -> Mengenführung startet automatisch
      if (item.unit.toLowerCase() === String(unit).toLowerCase()) {
        item.currentAmount = round2((Number(item.currentAmount) || 0) + qty);
        recomputeStockStatus(item);
      }
    }
    if (!item.unit) item.status = "ok"; // reine Ampel-Artikel: Lieferung angekommen -> nicht mehr knapp/leer
    item.updatedAt = new Date().toISOString();
    item.updatedBy = "Lieferschein";
    persist();
    return item;
  },

  // ---- Rezepte (Verkaufsprodukt -> Zutaten-Verbrauch) ----
  getRecipes() {
    return [...data.recipes].sort((a, b) => a.productName.localeCompare(b.productName));
  },
  addRecipe(productName, ingredients = [], opts = {}) {
    const recipe = {
      id: uid(),
      productName: String(productName || "").trim(),
      ingredients: [...ingredients],
      // wie bei Artikeln: automatisch angelegt und noch ohne Zutaten -> muss einmal angeschaut werden
      needsReview: !!opts.needsReview,
    };
    if (!recipe.productName) return null;
    data.recipes.push(recipe);
    persist();
    return recipe;
  },
  updateRecipe(id, patch) {
    const r = data.recipes.find((x) => x.id === id);
    if (!r) return;
    Object.assign(r, patch);
    persist();
    return r;
  },
  removeRecipe(id) {
    data.recipes = data.recipes.filter((r) => r.id !== id);
    persist();
  },
  /** Nachsichtiger Vergleich, damit ein per SumUp-Bericht erkannter Produktname (z.B. "Cappuccino Grande")
   * zum hinterlegten Rezept (z.B. "Cappuccino") passt. */
  /** Vorrats-Artikel per Name. Sucht zuerst exakt, dann über gemerkte Zweitnamen, dann über Ähnlichkeit. */
  getStockItemByName(name) {
    return findeNachName(data.stock, "name", name);
  },
  getRecipeByProductName(name) {
    return findeNachName(data.recipes, "productName", name);
  },
  /** Kandidaten für ein Produkt, das keinem Eintrag sicher zuzuordnen war – beste zuerst.
   * Grundlage für die Rückfrage "Gehört das zu …?" in der Bestand-Ansicht. */
  getNameVorschlaege(name, limit = 4) {
    const artikel = bewerteKandidaten(data.stock, "name", name).map((k) => ({ ...k, art: "artikel" }));
    const rezepte = bewerteKandidaten(data.recipes, "productName", name).map((k) => ({ ...k, art: "rezept" }));
    return [...artikel, ...rezepte].sort((a, b) => b.punkte - a.punkte).slice(0, limit);
  },
  /** Merkt sich, dass ein Produktname zu einem Artikel bzw. Rezept gehört. Ab dann trifft er sofort.
   * Das ist der eigentliche Lernschritt: Ähnlichkeit allein wird bei Namen wie "Paulaner Hefe-Weissbier
   * 0,5l" (Lieferschein) und "Paulaner Hefeweizen" (Kassenbericht) nie zuverlässig sein. */
  addNameAlias(art, id, alias) {
    const liste = art === "rezept" ? data.recipes : data.stock;
    const eintrag = liste.find((x) => x.id === id);
    const sauber = String(alias || "").trim();
    if (!eintrag || !sauber) return null;
    if (!Array.isArray(eintrag.aliases)) eintrag.aliases = [];
    const norm = normalisiereProduktname(sauber);
    if (!eintrag.aliases.some((a) => normalisiereProduktname(a) === norm)) eintrag.aliases.push(sauber);
    persist();
    return eintrag;
  },
  removeNameAlias(art, id, alias) {
    const liste = art === "rezept" ? data.recipes : data.stock;
    const eintrag = liste.find((x) => x.id === id);
    if (!eintrag || !Array.isArray(eintrag.aliases)) return null;
    const norm = normalisiereProduktname(alias);
    eintrag.aliases = eintrag.aliases.filter((a) => normalisiereProduktname(a) !== norm);
    persist();
    return eintrag;
  },
  /** Schreibt den Warenwert eines Verbrauchs auf den jeweiligen Tag.
   *
   * Bewusst als Tagessumme und nicht nur im Verbrauchsverlauf des Artikels: der ist auf die letzten
   * 20 Einträge begrenzt und taugt nicht für eine Monatsauswertung. Gerechnet wird mit dem Preis, der
   * ZUM ZEITPUNKT des Verkaufs hinterlegt war – eine spätere Preiserhöhung soll vergangene Tage nicht
   * rückwirkend teurer machen.
   */
  addMaterialCost(date, betrag) {
    const wert = round2(betrag);
    if (!date || !Number.isFinite(wert) || wert === 0) return;
    const d = this.getOrCreateDayByDate(date);
    d.materialkosten = round2((Number(d.materialkosten) || 0) + wert);
    // persist() macht der Aufrufer – so wird bei einem Verkauf mit zehn Zutaten nur einmal geschrieben.
  },

  /** Verkauf eines Produkts, das GENAU SO eingekauft wird (Flaschengetränke, zugekaufte Snacks): 1 verkauft
   * = 1 Stück weniger. Dafür braucht es kein Rezept mit einer einzigen Zutat "sich selbst". */
  applyDirectSale(stockItemId, quantitySold, date, productName) {
    const item = data.stock.find((s) => s.id === stockItemId);
    if (!item || !item.unit) return null;
    const qty = Number(quantitySold) || 0;
    item.currentAmount = round2((Number(item.currentAmount) || 0) - qty);
    recomputeStockStatus(item);
    if (!Array.isArray(item.consumptionLog)) item.consumptionLog = [];
    item.consumptionLog.unshift({ id: uid(), date: date || todayStr(), productName: productName || item.name, quantitySold: qty, consumed: qty });
    item.consumptionLog = item.consumptionLog.slice(0, 20);
    if (Number.isFinite(Number(item.pricePerUnit))) this.addMaterialCost(date || todayStr(), qty * Number(item.pricePerUnit));
    persist();
    return item;
  },
  /** Der Chef hat einen automatisch angelegten Artikel bzw. ein Rezept angeschaut – Hinweis verschwindet. */
  markStockItemReviewed(id) {
    const item = data.stock.find((s) => s.id === id);
    if (!item) return null;
    item.needsReview = false;
    persist();
    return item;
  },
  markRecipeReviewed(id) {
    const r = data.recipes.find((x) => x.id === id);
    if (!r) return null;
    r.needsReview = false;
    persist();
    return r;
  },
  /** Verrechnet einen Verkauf (aus einem SumUp-Verkaufsbericht) gegen die Zutaten des Rezepts: zieht die
   * jeweilige Menge × Verkaufsanzahl von jedem Zutat-Artikel ab und berechnet dessen Ampel neu. */
  applyProductSale(recipeId, quantitySold, date) {
    const recipe = data.recipes.find((r) => r.id === recipeId);
    if (!recipe) return;
    const qty = Number(quantitySold) || 0;
    let kosten = 0;
    for (const ing of recipe.ingredients) {
      const item = data.stock.find((s) => s.id === ing.stockItemId);
      if (!item || !item.unit) continue;
      const consumed = round2((Number(ing.amount) || 0) * qty);
      item.currentAmount = round2((Number(item.currentAmount) || 0) - consumed);
      recomputeStockStatus(item);
      if (!Array.isArray(item.consumptionLog)) item.consumptionLog = [];
      item.consumptionLog.unshift({ id: uid(), date: date || todayStr(), productName: recipe.productName, quantitySold: qty, consumed });
      item.consumptionLog = item.consumptionLog.slice(0, 20);
      if (Number.isFinite(Number(item.pricePerUnit))) kosten += consumed * Number(item.pricePerUnit);
    }
    if (kosten > 0) this.addMaterialCost(date || todayStr(), kosten);
    persist();
  },

  // ---- Krankmeldungen (kommen vom Handy der Mitarbeiter herein) ----
  /** Legt einen Krank-Tag an. Doppelte (gleiche Person, gleicher Tag) werden ignoriert, damit ein erneuter
   * Abgleich oder eine zweite Meldung für denselben Tag nichts verdoppelt. */
  addSickDay(employeeId, date, note) {
    if (!employeeId || !date) return null;
    const exists = data.sickDays.find((s) => s.employeeId === employeeId && s.date === date);
    if (exists) return exists;
    const entry = { id: uid(), employeeId, date, note: note || "", reportedAt: new Date().toISOString() };
    data.sickDays.push(entry);
    persist();
    return entry;
  },
  /** Krank-Tage in einem Zeitraum (beide Grenzen inklusive), aufsteigend nach Datum. */
  getSickDays(from, to) {
    return data.sickDays
      .filter((s) => (!from || s.date >= from) && (!to || s.date <= to))
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  },
  isSick(employeeId, date) {
    return data.sickDays.some((s) => s.employeeId === employeeId && s.date === date);
  },
  removeSickDay(id) {
    data.sickDays = data.sickDays.filter((s) => s.id !== id);
    persist();
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
    };
    if (!r.date || !r.time || !r.name) return null;
    data.reservations.push(r);
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
  // ---- Inventur ----
  /** Was bei einer Inventur zu zaehlen ist: alle mengengefuehrten Artikel eines Bereichs mit ihrem
   * Soll-Bestand. Artikel ohne Einheit (reine Ampel) tauchen nicht auf – da gibt es nichts zu zaehlen. */
  getStocktakeSheet(bereich) {
    return this.getStockItems()
      .filter((s) => s.unit && (!bereich || (s.bereich || "kueche") === bereich))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((s) => ({ stockItemId: s.id, name: s.name, unit: s.unit, soll: Number(s.currentAmount) || 0,
                     pricePerUnit: s.pricePerUnit ?? null }));
  },

  /** Inventur abschliessen: der gezaehlte Bestand wird der neue Stand, die Differenz festgehalten.
   *
   * Die Differenz ist die eigentliche Information – sie ist Bruch, Schwund, Fehlbuchung oder ein Rezept,
   * das nicht stimmt. Ohne sie faellt so etwas nie auf, weil der Bestand einfach ueberschrieben wuerde.
   * Artikel, bei denen nichts eingetragen wurde, bleiben unangetastet: nicht gezaehlt ist nicht dasselbe
   * wie null da.
   */
  saveStocktake({ date, bereich, counts }) {
    const tag = date || todayStr();
    const entries = [];
    let differenzWert = 0;
    for (const [stockItemId, istRoh] of Object.entries(counts || {})) {
      if (istRoh === "" || istRoh === null || istRoh === undefined) continue;
      const item = data.stock.find((s) => s.id === stockItemId);
      if (!item || !item.unit) continue;
      const ist = round2(Number(istRoh));
      if (!Number.isFinite(ist)) continue;
      const soll = round2(Number(item.currentAmount) || 0);
      const differenz = round2(ist - soll);
      const wert = item.pricePerUnit != null ? round2(differenz * item.pricePerUnit) : null;
      entries.push({ stockItemId, name: item.name, unit: item.unit, soll, ist, differenz, wert });
      if (wert !== null) differenzWert = round2(differenzWert + wert);
      item.currentAmount = ist;
      recomputeStockStatus(item);
    }
    if (entries.length === 0) return null;
    const inventur = { id: uid(), date: tag, bereich: bereich || null, entries, differenzWert,
                       createdAt: new Date().toISOString() };
    data.stocktakes.push(inventur);
    if (data.stocktakes.length > 60) data.stocktakes = data.stocktakes.slice(-60);
    persist();
    return inventur;
  },
  getStocktakes(limit = 12) {
    return [...data.stocktakes].sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, limit);
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

  /** Einkaufspreis aus einem Lieferschein übernehmen.
   *
   * Ein von Hand gesetzter Preis wird NICHT überschrieben: wer ihn selbst eingetragen hat, hat sich
   * dabei etwas gedacht (Sonderkondition, anderer Lieferant), und ein Beleg soll das nicht stillschweigend
   * wieder plattmachen. */
  setPriceFromDocument(id, pricePerUnit) {
    const item = data.stock.find((s) => s.id === id);
    const p = Number(pricePerUnit);
    if (!item || !Number.isFinite(p) || p <= 0) return null;
    if (item.priceSource === "manuell") return item;
    item.pricePerUnit = roundPreis(p);
    item.priceUpdatedAt = new Date().toISOString();
    item.priceSource = "beleg";
    persist();
    return item;
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

  // ---- Aufgaben ----
  getTaskTemplates() {
    return data.settings.taskTemplates;
  },
  setTaskTemplates(items) {
    data.settings.taskTemplates = items;
    persist();
  },
  /** Alle Aufgaben eines Tages erledigt? (leere Liste zählt als erledigt.) */
  allTasksDone(dayId) {
    const d = this.getDay(dayId);
    if (!d) return true;
    return d.tasks.every((t) => t.done);
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
  addTask(dayId, { id, text, assignedTo = null, priority = "normal", source = "adhoc", addedBy = null }) {
    const d = this.getDay(dayId);
    if (!d) return;
    const t = { id: id || uid(), text, done: false, doneBy: null, doneAt: null, source, addedBy, assignedTo, priority };
    d.tasks.push(t);
    persist();
    return t;
  },
  addAdhocDayTask(dayId, text, employeeName) {
    return this.addTask(dayId, { text, addedBy: employeeName || null, source: "adhoc" });
  },
  /** Aufgabe aus dem Cloud-Abgleich (taskSync.js) – optional einem Mitarbeiter/einer Priorität zugeordnet. */
  addRemoteDayTask(dayId, { id, text, assignedTo = null, priority = "normal", addedBy = "Telegram" }) {
    return this.addTask(dayId, { id, text, assignedTo, priority, addedBy, source: "remote" });
  },
  /** Vom Admin manuell angelegte Aufgabe (Admin → Aufgaben). */
  addAdminTask(dayId, { text, assignedTo = null, priority = "normal" }) {
    return this.addTask(dayId, { text, assignedTo, priority, addedBy: "Admin", source: "admin" });
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
      employees: parsed.employees ?? [],
      settings: {
        ...base.settings,
        ...(parsed.settings ?? {}),
        taskTemplates: parsed.settings?.taskTemplates ?? migratedTemplates ?? base.settings.taskTemplates,
        githubBackup: { ...base.settings.githubBackup, ...(parsed.settings?.githubBackup ?? {}) },
        taskInbox: { ...base.settings.taskInbox, ...(parsed.settings?.taskInbox ?? {}) },
        reservation: { ...base.settings.reservation, ...(parsed.settings?.reservation ?? {}) },
        shiftSlots: base.settings.shiftSlots, // rein code-gesteuert (keine Bearbeiten-UI) -> immer aktuelle Definition, nie aus localStorage "einfrieren"
      },
      days: (parsed.days ?? []).map(normalizeDay),
      notifications: parsed.notifications ?? [],
      stock: parsed.stock ?? [],
      recipes: parsed.recipes ?? [],
      sickDays: parsed.sickDays ?? [],
      publishedWeeks: parsed.publishedWeeks ?? [],
      productSales: parsed.productSales ?? [],
      stocktakes: parsed.stocktakes ?? [],
      tables: parsed.tables ?? [],
      reservations: parsed.reservations ?? [],
    };
    persist();
  },
  wipeAll() {
    data = defaultData();
    persist();
  },
};

export { uid };
