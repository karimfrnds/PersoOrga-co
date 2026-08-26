// ============================================================================
// store.js – Datenhaltung (localStorage). Ein Gerät, keine Cloud, kein Login.
// ============================================================================

import { todayStr } from "./format.js";

const STORAGE_KEY = "cafeapp_v1";

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
      cashWagePayout: true, // wird Lohn bar aus der Kasse ausgezahlt?
      adminPin: null, // schützt Mitarbeiter/Einstellungen/Berichte – null = noch nicht eingerichtet
      taskTemplates: [], // Aufgaben-Vorlagen, werden beim Anlegen eines Tages in day.tasks kopiert
      // Feste Schicht-Zeitfenster für die Verfügbarkeits-Abfrage im Kiosk. "service" gilt auch für "bar".
      shiftSlots: {
        service: [
          { id: "frueh1", label: "Früh1", from: "08:30", to: "16:00" },
          { id: "frueh2", label: "Früh2", from: "09:30", to: "17:00" },
          { id: "mittel", label: "Mittel", from: "10:00", to: "14:00" },
          { id: "spaet1", label: "Spät1", from: "15:30", to: "23:00" },
          { id: "spaet2", label: "Spät2", from: "18:00", to: "23:00" },
        ],
        kueche: [
          { id: "frueh1", label: "Früh1", from: "08:00", to: "15:30" },
          { id: "frueh2", label: "Früh2", from: "10:00", to: "16:00" },
          { id: "mittel", label: "Mittel", from: "10:00", to: "14:00" },
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
      },
    },
    // { id, date, status, shifts[], plannedShifts[], tasks[], kassenabschluss{}, stornos[], auditLog[], closedAt }
    days: [],
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
    availability: (d.availability || []).map((a) => ({ confirmedSlotId: null, ...a, slotIds: Array.isArray(a.slotIds) ? a.slotIds : [] })),
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
        shiftSlots: parsed.settings?.shiftSlots ?? base.settings.shiftSlots,
      },
      days: (parsed.days ?? base.days).map(normalizeDay),
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

/** Rolle einer Person, für den Exklusivitäts-Vergleich ("wer konkurriert mit wem um dieselbe Schicht-ID").
 * Wichtig: Service und Küche haben beide z.B. eine Schicht mit der ID "frueh1", aber zu unterschiedlichen
 * Zeiten – das sind zwei verschiedene Schichten, die sich NICHT gegenseitig blockieren dürfen. */
function roleOf(employeeId) {
  return data.employees.find((e) => e.id === employeeId)?.role || null;
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
        const shift = { id: shiftId, employeeId: a.employeeId, from: slot.from, to: slot.to, note: "" };
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
  /** Feste Schicht-Zeitfenster für eine Rolle ("service" gilt auch für "bar"). */
  getShiftSlotsForRole(role) {
    return shiftSlotsForRole(role);
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
      submittedAt: new Date().toISOString(),
    };
    if (idx >= 0) d.availability[idx] = entry;
    else d.availability.push(entry);
    resolveDayAvailability(d);
    persist();
    return this.getAvailability(dayId, employeeId);
  },
  /** Chef legt per Bot explizit fest, welche Schicht eine Person bekommt (überstimmt alles, auch falls
   * jemand anderes sie gerade fest hatte – die verliert sie dann wieder). Stößt die Kaskade erneut an. */
  confirmAvailability(dayId, employeeId, slotId) {
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
    } else {
      d.availability.push({ id: uid(), employeeId, slotIds: [slotId], confirmedSlotId: slotId, submittedAt: new Date().toISOString() });
    }
    resolveDayAvailability(d);
    persist();
    return this.getAvailability(dayId, employeeId);
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
        shiftSlots: parsed.settings?.shiftSlots ?? base.settings.shiftSlots,
      },
      days: (parsed.days ?? []).map(normalizeDay),
    };
    persist();
  },
  wipeAll() {
    data = defaultData();
    persist();
  },
};

export { uid };
