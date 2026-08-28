// ============================================================================
// store.js – Datenhaltung (localStorage). Ein Gerät, keine Cloud, kein Login.
// ============================================================================

import { todayStr, dateDe } from "./format.js";

const STORAGE_KEY = "cafeapp_v1";

/** Rundet auf 2 Nachkommastellen (Mengen/Beträge), vermeidet Float-Reste wie 0.1+0.2=0.30000000000000004. */
function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
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
        shiftSlots: base.settings.shiftSlots, // rein code-gesteuert (keine Bearbeiten-UI) -> immer aktuelle Definition, nie aus localStorage "einfrieren"
      },
      days: (parsed.days ?? base.days).map(normalizeDay),
      notifications: parsed.notifications ?? base.notifications,
      stock: parsed.stock ?? base.stock,
      recipes: parsed.recipes ?? base.recipes,
      sickDays: parsed.sickDays ?? base.sickDays,
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
  commitAvailability(dayId, employeeId, slotIds) {
    const d = this.getDay(dayId);
    if (!d) return;
    const role = roleOf(employeeId);
    const takenByOthers = new Set(
      d.availability.filter((a) => a.employeeId !== employeeId && a.confirmedSlotId && roleOf(a.employeeId) === role).map((a) => a.confirmedSlotId)
    );
    const clean = [...new Set(Array.isArray(slotIds) ? slotIds : [])].filter((id) => !takenByOthers.has(id));
    const idx = d.availability.findIndex((a) => a.employeeId === employeeId);
    const entry = {
      id: idx >= 0 ? d.availability[idx].id : uid(),
      employeeId,
      slotIds: clean,
      confirmedSlotId: clean.length === 1 ? clean[0] : null,
      bossConfirmed: clean.length === 1 ? autoConfirmsWithoutBoss(clean[0]) : false,
      submittedAt: new Date().toISOString(),
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
    };
    if (!item.name) return null;
    if (unit) recomputeStockStatus(item);
    data.stock.push(item);
    persist();
    return item;
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
  addRecipe(productName, ingredients = []) {
    const recipe = { id: uid(), productName: String(productName || "").trim(), ingredients: [...ingredients] };
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
  getRecipeByProductName(name) {
    const needle = String(name || "").trim().toLowerCase();
    if (!needle) return null;
    return (
      data.recipes.find((r) => r.productName.trim().toLowerCase() === needle) ||
      data.recipes.find((r) => r.productName.trim().toLowerCase().includes(needle) || needle.includes(r.productName.trim().toLowerCase())) ||
      null
    );
  },
  /** Verrechnet einen Verkauf (aus einem SumUp-Verkaufsbericht) gegen die Zutaten des Rezepts: zieht die
   * jeweilige Menge × Verkaufsanzahl von jedem Zutat-Artikel ab und berechnet dessen Ampel neu. */
  applyProductSale(recipeId, quantitySold, date) {
    const recipe = data.recipes.find((r) => r.id === recipeId);
    if (!recipe) return;
    const qty = Number(quantitySold) || 0;
    for (const ing of recipe.ingredients) {
      const item = data.stock.find((s) => s.id === ing.stockItemId);
      if (!item || !item.unit) continue;
      const consumed = round2((Number(ing.amount) || 0) * qty);
      item.currentAmount = round2((Number(item.currentAmount) || 0) - consumed);
      recomputeStockStatus(item);
      if (!Array.isArray(item.consumptionLog)) item.consumptionLog = [];
      item.consumptionLog.unshift({ id: uid(), date: date || todayStr(), productName: recipe.productName, quantitySold: qty, consumed });
      item.consumptionLog = item.consumptionLog.slice(0, 20);
    }
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
        shiftSlots: base.settings.shiftSlots, // rein code-gesteuert (keine Bearbeiten-UI) -> immer aktuelle Definition, nie aus localStorage "einfrieren"
      },
      days: (parsed.days ?? []).map(normalizeDay),
      notifications: parsed.notifications ?? [],
      stock: parsed.stock ?? [],
      recipes: parsed.recipes ?? [],
      sickDays: parsed.sickDays ?? [],
    };
    persist();
  },
  wipeAll() {
    data = defaultData();
    persist();
  },
};

export { uid };
