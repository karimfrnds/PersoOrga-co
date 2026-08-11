// ============================================================================
// store.js – Datenhaltung (localStorage). Ein Gerät, keine Cloud, kein Login.
// ============================================================================

const STORAGE_KEY = "cafeapp_v1";

function uid() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return "id-" + Date.now() + "-" + Math.random().toString(16).slice(2);
}

function defaultData() {
  return {
    employees: [], // { id, name, role, hourlyWage, isMinijob, minijobLimit, active }
    settings: {
      tipSplit: { service: 70, kueche: 20, bar: 10 }, // Gewichtung (Punkte/Std.) pro Rolle
      roundingMinutes: 15, // Rundung der Arbeitszeit
      cashWagePayout: true, // wird Lohn bar aus der Kasse ausgezahlt?
      adminPin: null, // schützt Mitarbeiter/Einstellungen/Berichte – null = noch nicht eingerichtet
    },
    days: [], // { id, date, status, shifts[], kassenabschluss{}, stornos[], auditLog[], closedAt }
  };
}

function load() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return defaultData();
  try {
    const parsed = JSON.parse(raw);
    const base = defaultData();
    return {
      employees: parsed.employees ?? base.employees,
      settings: { ...base.settings, ...(parsed.settings ?? {}) },
      days: parsed.days ?? base.days,
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
      kassenabschluss: { umsatzGesamt: 0, umsatzBar: 0, umsatz7: 0, umsatz19: 0, trinkgeldKarte: 0, trinkgeldBar: 0 },
      stornos: [],
      auditLog: [{ timestamp: new Date().toISOString(), action: "erstellt", detail: `Tag ${dateStr} angelegt` }],
      closedAt: null,
    };
    data.days.push(d);
    persist();
    return d;
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
    const s = { id: uid(), employeeId: shift.employeeId, from: shift.from, to: shift.to, note: shift.note || "" };
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

  // ---- Backup ----
  exportJSON() {
    return JSON.stringify(data, null, 2);
  },
  importJSON(json) {
    const parsed = JSON.parse(json);
    data = {
      employees: parsed.employees ?? [],
      settings: { ...defaultData().settings, ...(parsed.settings ?? {}) },
      days: parsed.days ?? [],
    };
    persist();
  },
  wipeAll() {
    data = defaultData();
    persist();
  },
};

export { uid };
