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

export { performTaskSync, maybeSyncPendingTasks, sendNoteToBoss };
