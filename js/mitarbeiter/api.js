// ============================================================================
// mitarbeiter/api.js – Verbindung der Handy-Ansicht zum Cloudflare Worker.
//
// Diese Ansicht bekommt bewusst NUR die eigenen Daten: der Server filtert, nicht
// die Anzeige. Der Zugriffsschlüssel des iPads taucht hier nirgends auf – damit
// könnte man sonst die Löhne aller Kollegen lesen.
// ============================================================================

const LS_SESSION = "cafeapp_ma_session";
const LS_URL = "cafeapp_ma_workerurl";

let session = (() => {
  try {
    return JSON.parse(localStorage.getItem(LS_SESSION)) || null;
  } catch {
    return null;
  }
})();

const getSession = () => session;
const getWorkerUrl = () => localStorage.getItem(LS_URL) || "";
const setWorkerUrl = (url) => localStorage.setItem(LS_URL, url.replace(/\/+$/, ""));

function clearSession() {
  session = null;
  localStorage.removeItem(LS_SESSION);
}

async function call(path, { method = "GET", body } = {}) {
  const base = getWorkerUrl();
  if (!base) throw new Error("Zugang noch nicht eingerichtet.");
  const headers = {};
  if (session?.token) headers.Authorization = `Bearer ${session.token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";

  let res;
  try {
    res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new Error("Keine Verbindung. Bist du online?");
  }
  if (res.status === 401) {
    clearSession();
    throw new Error("Bitte neu anmelden.");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Fehler ${res.status}`);
  return data;
}

async function login(pin) {
  const base = getWorkerUrl();
  if (!base) throw new Error("Zugang noch nicht eingerichtet.");
  let res;
  try {
    res = await fetch(base + "/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin }),
    });
  } catch {
    throw new Error("Keine Verbindung. Bist du online?");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Anmeldung fehlgeschlagen.");
  if (data.role !== "employee") throw new Error("Das ist der Chef-Zugang. Bitte deinen eigenen PIN benutzen.");
  session = { token: data.token, name: data.name };
  localStorage.setItem(LS_SESSION, JSON.stringify(session));
  return session;
}

const getMe = () => call("/me");
const markNotificationsRead = (ids) => call("/me/notifications/read", { method: "POST", body: { ids } });
const sendAvailability = (weekStart, days) => call("/me/availability", { method: "POST", body: { weekStart, days } });
const reportSick = (from, to, note) => call("/me/sick", { method: "POST", body: { from, to, note } });

export { getSession, clearSession, getWorkerUrl, setWorkerUrl, login, getMe, sendAvailability, reportSick, markNotificationsRead };
