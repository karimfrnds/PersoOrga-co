// ============================================================================
// social/api.js – Verbindung des Social-Bereichs zum Cloudflare Worker.
//
// Anders als iPad, Laptop und Handy liest dieser Bereich nicht vom iPad mit: die Daten liegen
// ausschliesslich im Worker. Chef und Betreuung schreiben beide direkt hinein – nur so ist ein
// geteilter Kalender wirklich geteilt und nicht davon abhaengig, dass ein Geraet im Café angeht.
// ============================================================================

const LS_SESSION = "cafeapp_social_session";
const LS_URL = "cafeapp_social_workerurl";

function loadSession() {
  try {
    return JSON.parse(localStorage.getItem(LS_SESSION)) || null;
  } catch {
    return null;
  }
}

let session = loadSession();

const getSession = () => session;
const getWorkerUrl = () => session?.workerUrl || localStorage.getItem(LS_URL) || "";
const setWorkerUrl = (url) => localStorage.setItem(LS_URL, String(url).replace(/\/+$/, ""));

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
    throw new Error("Keine Verbindung. Internet prüfen.");
  }
  if (res.status === 401) {
    clearSession();
    throw new Error("Sitzung abgelaufen. Bitte neu anmelden.");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Fehler ${res.status}`);
  return data;
}

async function login(pin) {
  const base = getWorkerUrl();
  if (!base) throw new Error("Bitte zuerst die Adresse eintragen.");
  let res;
  try {
    res = await fetch(base + "/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin }),
    });
  } catch {
    throw new Error("Keine Verbindung. Internet und Adresse prüfen.");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Anmeldung fehlgeschlagen.");
  if (data.role !== "social" && data.role !== "boss") {
    throw new Error("Dieser Zugang ist nicht für den Social-Bereich. Bitte den Social-PIN verwenden.");
  }
  session = { token: data.token, name: data.name, role: data.role, workerUrl: base };
  localStorage.setItem(LS_SESSION, JSON.stringify(session));
  return session;
}

const getOverview = () => call("/social/overview");
const postAction = (body) => call("/social/post", { method: "POST", body });
const shootingAction = (body) => call("/social/shooting", { method: "POST", body });
const terminAction = (body) => call("/social/termin", { method: "POST", body });
const listeAction = (body) => call("/social/liste", { method: "POST", body });
const accountAction = (body) => call("/social/account", { method: "POST", body });
const configAction = (body) => call("/social/config", { method: "POST", body });

export {
  getSession,
  clearSession,
  getWorkerUrl,
  setWorkerUrl,
  login,
  getOverview,
  postAction,
  shootingAction,
  terminAction,
  listeAction,
  accountAction,
  configAction,
};
