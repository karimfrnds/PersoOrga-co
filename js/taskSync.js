// ============================================================================
// taskSync.js – Gleicht Aufgaben mit dem Cloudflare Worker (worker/telegram-bot.js)
// ab, der sie in einem KV-Speicher hält. Der Worker ist immer erreichbar (nicht
// vom iPad abhängig) – so kann der Telegram-Bot jederzeit die aktuelle Liste
// zeigen/ändern (auch "erledigt" markieren), auch wenn das iPad gerade aus ist.
// Das iPad übernimmt bei jedem Sync neue/entfernte/erledigte Cloud-Aufgaben und
// lädt danach seinen eigenen (jetzt abgeglichenen) Stand wieder hoch, inkl. wer
// gerade im Dienst ist – so bleiben beide Seiten in Sync.
// ============================================================================
import { store } from "./store.js";
import { todayStr } from "./format.js";
import { computeDay } from "./calc.js";

const FINANCIALS_DAYS = 35; // ca. 5 Wochen zurück, für Wochen-/Monatsvergleiche im Bot

function workerUrl(cfg, path) {
  return `${cfg.workerUrl.replace(/\/+$/, "")}${path}`;
}

function isoDaysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

/** Nachsichtiger Vergleich für Schicht-Namen ("Früh1" vs "früh 1" vs "fruh1"), damit eine per Bot-Chat
 * eingetippte Schicht trotz kleiner Tippabweichungen zum richtigen Slot passt. */
function normalizeSlotLabel(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/** Kompakte Tages-Kennzahlen der letzten Wochen (nur wenn der Nutzer das freigegeben hat). */
function buildFinancialsPayload() {
  const settings = store.getSettings();
  const employees = store.getEmployees();
  const from = isoDaysAgo(FINANCIALS_DAYS);
  const rows = [];
  for (const day of store.getDays()) {
    if (day.date < from) continue;
    const b = computeDay(day, employees, settings);
    rows.push({
      date: day.date,
      status: day.status,
      umsatzGesamt: Number(day.kassenabschluss?.umsatzGesamt) || 0,
      umsatzBar: Number(day.kassenabschluss?.umsatzBar) || 0,
      trinkgeldGesamt: b.tipPool,
      totalLohn: b.totalLohn,
      totalHours: b.totalHours,
      umschlag: b.umschlag,
      perEmployee: b.perEmployee.map((r) => ({ name: r.employee.name, hours: r.hours, lohn: r.lohn })),
    });
  }
  rows.sort((a, b) => (a.date < b.date ? -1 : 1));
  return rows;
}

async function fetchRemoteState(cfg) {
  const res = await fetch(workerUrl(cfg, "/state"), {
    headers: { Authorization: `Bearer ${cfg.workerSecret}` },
  });
  if (!res.ok) throw new Error(`Worker antwortete mit ${res.status} (URL/Zugriffsschlüssel prüfen)`);
  return res.json();
}

async function pushLocalState(cfg, employees, tasks, shiftsInService, financials) {
  const res = await fetch(workerUrl(cfg, "/state"), {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.workerSecret}`, "Content-Type": "application/json" },
    body: JSON.stringify({ employees, tasks, shiftsInService, financials }),
  });
  if (!res.ok) throw new Error(`Worker antwortete mit ${res.status} beim Hochladen`);
}

/** Sendet eine kurze Notiz eines Mitarbeiters an den Chef (Telegram). Wirft bei echten Fehlern. */
async function sendNoteToBoss(employeeName, text) {
  const cfg = store.getTaskInboxConfig();
  if (!cfg.workerUrl || !cfg.workerSecret) {
    throw new Error("Telegram-Aufgaben-Abgleich ist nicht eingerichtet (siehe Admin → Einstellungen).");
  }
  const res = await fetch(workerUrl(cfg, "/note"), {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.workerSecret}`, "Content-Type": "application/json" },
    body: JSON.stringify({ employeeName, text }),
  });
  if (!res.ok) throw new Error(`Worker antwortete mit ${res.status}`);
}

/** Sendet die Verfügbarkeit eines Mitarbeiters für eine Zielwoche (Montag-Datum) an den Bot.
 * Der Worker sammelt das im Hintergrund und meldet sich beim Chef erst, wenn alle aktiven
 * Mitarbeiter eingetragen haben (kein Spam pro einzelner Person). Wirft bei echten Fehlern. */
async function pushAvailability(employeeName, weekStart, days) {
  const cfg = store.getTaskInboxConfig();
  if (!cfg.workerUrl || !cfg.workerSecret) {
    throw new Error("Telegram-Aufgaben-Abgleich ist nicht eingerichtet (siehe Admin → Einstellungen).");
  }
  const res = await fetch(workerUrl(cfg, "/availability"), {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.workerSecret}`, "Content-Type": "application/json" },
    body: JSON.stringify({ employeeName, weekStart, days }),
  });
  if (!res.ok) throw new Error(`Worker antwortete mit ${res.status}`);
}

/** Führt den Abgleich jetzt durch (z.B. für den "Jetzt abgleichen"-Button). Wirft bei echten Fehlern. */
async function performTaskSync() {
  const cfg = store.getTaskInboxConfig();
  if (!cfg.workerUrl || !cfg.workerSecret) {
    throw new Error("Bitte zuerst Worker-URL und Zugriffsschlüssel eintragen.");
  }

  const remote = await fetchRemoteState(cfg);
  const remoteTasks = Array.isArray(remote.tasks) ? remote.tasks : [];
  const remoteById = new Map(remoteTasks.map((t) => [t.id, t]));
  const knownState = new Map((cfg.knownRemoteState || []).map((k) => [k.id, k.done]));

  const localRows = store.getTasksFrom(todayStr());
  const localIds = new Set(localRows.map((r) => r.id));
  const employees = store.getEmployees(false);

  let applied = 0;

  // Vom Bot per Wochenplan-Nachricht angelegte geplante Schichten -> lokal übernehmen.
  // Zwei Formen: freie Uhrzeit (from/to, per rs.id dedupliziert wie bisher) ODER Zuweisung anhand des
  // Schicht-Namens (slotLabel, z.B. "Früh1" – der Chef sagt dem Bot "Anna bekommt Montag Früh1"). Letztere
  // läuft über confirmAvailability(), damit Kaskade/Ausgrauen für andere korrekt greifen; dafür braucht es
  // eine eigene Dedup-Liste (appliedShiftAssignmentIds), weil dabei keine Schicht mit exakt rs.id entsteht.
  const remotePlanned = Array.isArray(remote.plannedShifts) ? remote.plannedShifts : [];
  const appliedAssignmentIds = new Set(cfg.appliedShiftAssignmentIds || []);
  let newAssignmentIds = false;
  for (const rs of remotePlanned) {
    if (!rs.id) continue;
    if (rs.slotLabel) {
      if (appliedAssignmentIds.has(rs.id)) continue;
      const match = employees.find((e) => e.name.trim().toLowerCase() === String(rs.employeeName || "").trim().toLowerCase());
      if (match && rs.date) {
        const slot = store.getShiftSlotsForRole(match.role).find((s) => normalizeSlotLabel(s.label) === normalizeSlotLabel(rs.slotLabel));
        if (slot) {
          const day = store.getOrCreateDayByDate(rs.date);
          store.confirmAvailability(day.id, match.id, slot.id);
        }
      }
      appliedAssignmentIds.add(rs.id);
      newAssignmentIds = true;
    } else {
      if (store.hasPlannedShiftId(rs.id)) continue;
      const match = employees.find((e) => e.name.trim().toLowerCase() === String(rs.employeeName || "").trim().toLowerCase());
      if (!match || !rs.date || !rs.from || !rs.to) continue;
      const day = store.getOrCreateDayByDate(rs.date);
      store.addPlannedShift(day.id, { id: rs.id, employeeId: match.id, from: rs.from, to: rs.to });
    }
  }
  if (newAssignmentIds) {
    store.updateTaskInboxConfig({ appliedShiftAssignmentIds: [...appliedAssignmentIds].slice(-300) });
  }

  // Freie Nachrichten vom Chef ("notify" per Bot) -> als System-Benachrichtigung anlegen, die im Kiosk
  // beim nächsten Öffnen des persönlichen Fensters als Pop-up erscheint. Eigene Dedup-Liste, damit ein
  // erneuter Sync dieselbe Nachricht nicht nochmal zustellt.
  const remoteMessages = Array.isArray(remote.employeeMessages) ? remote.employeeMessages : [];
  const appliedMessageIds = new Set(cfg.appliedMessageIds || []);
  let newMessageIds = false;
  for (const m of remoteMessages) {
    if (!m.id || appliedMessageIds.has(m.id)) continue;
    const match = employees.find((e) => e.name.trim().toLowerCase() === String(m.employeeName || "").trim().toLowerCase());
    if (match && m.text) store.addNotification(match.id, `💬 ${m.text}`);
    appliedMessageIds.add(m.id);
    newMessageIds = true;
  }
  if (newMessageIds) {
    store.updateTaskInboxConfig({ appliedMessageIds: [...appliedMessageIds].slice(-300) });
  }

  // Vom Chef per Bot abgelehnte Schichten ("reject_shift") -> Slot bei der Person entfernen (fällt für
  // andere wieder frei) und sie per Pop-up informieren. Eigene Dedup-Liste wie bei den Zuweisungen.
  const remoteRejections = Array.isArray(remote.shiftRejections) ? remote.shiftRejections : [];
  const appliedRejectionIds = new Set(cfg.appliedRejectionIds || []);
  let newRejectionIds = false;
  for (const r of remoteRejections) {
    if (!r.id || appliedRejectionIds.has(r.id)) continue;
    const match = employees.find((e) => e.name.trim().toLowerCase() === String(r.employeeName || "").trim().toLowerCase());
    if (match && r.date) {
      const slot = store.getShiftSlotsForRole(match.role).find((s) => normalizeSlotLabel(s.label) === normalizeSlotLabel(r.slotLabel));
      if (slot) {
        const day = store.getOrCreateDayByDate(r.date);
        store.rejectAvailability(day.id, match.id, slot.id);
      }
    }
    appliedRejectionIds.add(r.id);
    newRejectionIds = true;
  }
  if (newRejectionIds) {
    store.updateTaskInboxConfig({ appliedRejectionIds: [...appliedRejectionIds].slice(-300) });
  }

  // Neu in der Cloud (z.B. per Telegram angelegt) -> lokal übernehmen
  for (const rt of remoteTasks) {
    if (localIds.has(rt.id)) continue;
    const day = store.getOrCreateDayByDate(rt.date || todayStr());
    const match = rt.assignedToName
      ? employees.find((e) => e.name.trim().toLowerCase() === String(rt.assignedToName).trim().toLowerCase())
      : null;
    const t = store.addRemoteDayTask(day.id, {
      id: rt.id,
      text: rt.text,
      assignedTo: match ? match.id : null,
      priority: ["niedrig", "normal", "hoch"].includes(rt.priority) ? rt.priority : "normal",
    });
    if (rt.done && t) store.setDayTaskDone(day.id, t.id, true, "Telegram");
    applied++;
  }

  // Schon lokal bekannt, aber der Erledigt-Status in der Cloud weicht vom letzten bekannten Stand ab
  // (z.B. der Bot hat "ist erledigt" verarbeitet) -> lokal übernehmen, statt beim Hochladen zu überschreiben.
  for (const row of localRows) {
    const rt = remoteById.get(row.id);
    if (!rt) continue;
    const knownDone = knownState.get(row.id);
    if (knownDone !== undefined && rt.done !== knownDone && rt.done !== row.done) {
      store.setDayTaskDone(row.dayId, row.id, rt.done, rt.done ? "Telegram" : null);
    }
  }

  // War beim letzten Abgleich noch in der Cloud, jetzt nicht mehr (z.B. per Telegram gelöscht) -> lokal auch entfernen
  for (const id of knownState.keys()) {
    if (remoteById.has(id)) continue;
    const row = localRows.find((r) => r.id === id);
    if (row) store.removeDayTask(row.dayId, row.id);
  }

  // Jetzt vollständig abgeglichenen lokalen Stand hochladen, damit die Cloud auch lokale
  // Änderungen (abgehakt, manuell angelegt/gelöscht/bearbeitet) und wer im Dienst ist kennt.
  const freshRows = store.getTasksFrom(todayStr());
  const pushTasks = freshRows.map((r) => ({
    id: r.id,
    date: r.date,
    text: r.text,
    assignedToName: r.assignedTo ? store.getEmployee(r.assignedTo)?.name || null : null,
    priority: r.priority,
    done: r.done,
  }));
  const shiftsInService = store.getOpenShiftsToday().map((s) => ({
    name: store.getEmployee(s.employeeId)?.name || "?",
    since: s.from,
  }));
  const financials = cfg.shareFinancials ? buildFinancialsPayload() : [];
  await pushLocalState(cfg, employees.map((e) => e.name), pushTasks, shiftsInService, financials);

  store.updateTaskInboxConfig({
    lastSyncAt: new Date().toISOString(),
    lastError: null,
    knownRemoteState: pushTasks.map((t) => ({ id: t.id, done: t.done })).slice(-300),
  });
  return { applied };
}

/** Beim App-Start / im Leerlauf aufrufen: gleicht still im Hintergrund ab, wenn aktiviert. */
async function maybeSyncPendingTasks() {
  const cfg = store.getTaskInboxConfig();
  if (!cfg.enabled) return;
  try {
    await performTaskSync();
  } catch (e) {
    store.updateTaskInboxConfig({ lastError: String(e.message || e) });
  }
}

export { performTaskSync, maybeSyncPendingTasks, sendNoteToBoss, pushAvailability };
