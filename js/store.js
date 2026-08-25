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
      githubBackup: {
        enabled: false,
        owner: "", // GitHub-Nutzername/Organisation
        repo: "", // Repository-Name
        token: "", // Fine-grained Personal Access Token, nur "Contents: Read and write" für dieses eine Repo
        lastBackupDate: null, // YYYY-MM-DD des letzten erfolgreichen automatischen Backups
        lastError: null, // Fehlermeldung des letzten fehlgeschlagenen Versuchs, für Warnhinweis im Admin
      },
      // Telegram-Aufgaben-Inbox: nutzt dieselbe GitHub-Verbindung (owner/repo/token) wie githubBackup oben.
      taskInbox: {
        enabled: false,
        lastSyncAt: null, // ISO-Timestamp des letzten erfolgreichen Abrufs
        lastError: null,
        appliedIds: [], // zuletzt übernommene Nachrichten-IDs, verhindert doppeltes Anlegen (gedeckelt auf 200)
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
    tasks: d.tasks || [],
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
      tasks: data.settings.taskTemplates.map((text) => ({ id: uid(), text, done: false, doneBy: null, doneAt: null, source: "template", assignedTo: null })),
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

  // ---- Geplante Schichten (Wochenplan/CSV) – reine Planung, zählt NICHT als gearbeitete Zeit ----
  addPlannedShift(dayId, shift) {
    const d = this.getDay(dayId);
    if (!d) return;
    const s = { id: uid(), employeeId: shift.employeeId, from: shift.from, to: shift.to, note: shift.note || "" };
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
  addAdhocDayTask(dayId, text, employeeName) {
    const d = this.getDay(dayId);
    if (!d) return;
    const t = { id: uid(), text, done: false, doneBy: null, doneAt: null, source: "adhoc", addedBy: employeeName || null, assignedTo: null };
    d.tasks.push(t);
    persist();
    return t;
  },
  /** Aufgabe aus der Telegram-Inbox (taskSync.js) – optional einem Mitarbeiter zugeordnet. */
  addRemoteDayTask(dayId, { text, assignedTo = null, addedBy = "Telegram" }) {
    const d = this.getDay(dayId);
    if (!d) return;
    const t = { id: uid(), text, done: false, doneBy: null, doneAt: null, source: "remote", addedBy, assignedTo };
    d.tasks.push(t);
    persist();
    return t;
  },
  removeDayTask(dayId, taskId) {
    const d = this.getDay(dayId);
    if (!d) return;
    d.tasks = d.tasks.filter((t) => t.id !== taskId);
    persist();
  },

  // ---- Telegram-Aufgaben-Inbox (nutzt githubBackup-Zugangsdaten) ----
  getTaskInboxConfig() {
    return data.settings.taskInbox;
  },
  updateTaskInboxConfig(patch) {
    Object.assign(data.settings.taskInbox, patch);
    persist();
  },
  /** Merkt sich verarbeitete Nachrichten-IDs (gedeckelt), damit nichts doppelt übernommen wird. */
  markTaskInboxIdsApplied(ids) {
    const cfg = data.settings.taskInbox;
    cfg.appliedIds = [...cfg.appliedIds, ...ids].slice(-200);
    persist();
  },
  isTaskInboxIdApplied(id) {
    return data.settings.taskInbox.appliedIds.includes(id);
  },

  // ---- Backup ----
  exportJSON() {
    return JSON.stringify(data, null, 2);
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
