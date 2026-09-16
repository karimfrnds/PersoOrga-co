// ============================================================================
// manager/api.js – Verbindung des Store-Managements zum Cloudflare Worker.
//
// Die Übersicht kommt aus /manager/overview: dieselben Daten wie am Laptop, aber ohne Löhne, Umsätze, Kosten
// und Gastdaten – gefiltert im Worker, nicht erst hier in der Anzeige. Änderungen gehen über dieselben
// Wege wie beim Chef (Warteschlangen an den iPad).
// ============================================================================

const LS_SESSION = "cafeapp_manager_session";
const LS_URL = "cafeapp_manager_workerurl";

let session = (() => {
  try {
    return JSON.parse(localStorage.getItem(LS_SESSION)) || null;
  } catch {
    return null;
  }
})();

const getSession = () => session;
const getWorkerUrl = () => localStorage.getItem(LS_URL) || "";
const setWorkerUrl = (url) => localStorage.setItem(LS_URL, String(url).trim().replace(/\/+$/, ""));

function clearSession() {
  session = null;
  localStorage.removeItem(LS_SESSION);
}

async function call(path, { method = "GET", body } = {}) {
  const base = getWorkerUrl();
  if (!base) throw new Error("Bitte zuerst die Adresse eintragen.");
  const headers = {};
  if (session?.token) headers.Authorization = `Bearer ${session.token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  let res;
  try {
    res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new Error("Keine Verbindung. Bist du online?");
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    clearSession();
    const e = new Error(data.error || "Bitte neu anmelden.");
    e.abgemeldet = true;
    throw e;
  }
  if (!res.ok) throw new Error(data.error || `Fehler ${res.status}`);
  return data;
}

async function login(pin) {
  const base = getWorkerUrl();
  if (!base) throw new Error("Bitte zuerst die Adresse eintragen.");
  let res;
  try {
    res = await fetch(base + "/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pin }) });
  } catch {
    throw new Error("Keine Verbindung. Bist du online?");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Anmeldung fehlgeschlagen.");
  // Der Chef darf auch hinein (er gibt ihr hier Aufgaben), alle anderen Zugänge nicht.
  if (data.role !== "manager" && data.role !== "boss") throw new Error("Mit diesem PIN geht es hier nicht hinein.");
  session = { token: data.token, role: data.role, name: data.name };
  localStorage.setItem(LS_SESSION, JSON.stringify(session));
  return session;
}

const getOverview = () => call("/manager/overview");
const bestandAction = (body) => call("/admin/bestand", { method: "POST", body });
const taskAction = (body) => call("/admin/task", { method: "POST", body });
const templateAction = (body) => call("/admin/task-template", { method: "POST", body });
const employeeAction = (body) => call("/admin/employee", { method: "POST", body });
const sendMessage = (body) => call("/admin/message", { method: "POST", body });
const decideShift = (employeeName, date, slotLabel, decision, note = "") =>
  call("/admin/shift-decision", { method: "POST", body: { employeeName, date, slotLabel, decision, note } });
const publishWeek = (weekStart, action = "publish") => call("/admin/publish-week", { method: "POST", body: { weekStart, action } });
const aufgabeAction = (body) => call("/manager/aufgabe", { method: "POST", body });
const notizAction = (body) => call("/manager/notiz", { method: "POST", body });
const fotoHochladen = (dataUrl) => call("/manager/foto", { method: "POST", body: { dataUrl } });
const fotoLaden = (id) => call("/manager/foto?id=" + encodeURIComponent(id));

export {
  getSession,
  clearSession,
  getWorkerUrl,
  setWorkerUrl,
  login,
  getOverview,
  bestandAction,
  taskAction,
  templateAction,
  employeeAction,
  sendMessage,
  decideShift,
  publishWeek,
  aufgabeAction,
  notizAction,
  fotoHochladen,
  fotoLaden,
};
