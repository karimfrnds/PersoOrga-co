// ============================================================================
// chef/api.js – Verbindung der Laptop-Ansicht zum Cloudflare Worker.
//
// Wichtig: diese Ansicht benutzt bewusst NICHT js/store.js. Der Store ist die
// lokale Datenhaltung des iPads – das iPad bleibt die Zentrale, das hier ist
// nur ein Client, der über den Worker mitliest und Änderungen einreicht.
//
// Änderungen (Schicht bestätigen, Lieferung erfassen …) gehen in dieselben
// Warteschlangen, die auch der Telegram-Bot nutzt: der iPad arbeitet sie beim
// nächsten Abgleich ab und bleibt maßgeblich.
// ============================================================================

const LS_KEY = "cafeapp_chef_session";

function loadSession() {
  try {
    return JSON.parse(localStorage.getItem(LS_KEY)) || null;
  } catch {
    return null;
  }
}

let session = loadSession();

function getSession() {
  return session;
}

/** Worker-URL wird einmal beim Einrichten hinterlegt und bleibt gespeichert. */
function getWorkerUrl() {
  return session?.workerUrl || localStorage.getItem("cafeapp_chef_workerurl") || "";
}

function setWorkerUrl(url) {
  localStorage.setItem("cafeapp_chef_workerurl", url.replace(/\/+$/, ""));
}

function clearSession() {
  session = null;
  localStorage.removeItem(LS_KEY);
}

async function request(path, { method = "GET", body } = {}) {
  const base = getWorkerUrl();
  if (!base) throw new Error("Bitte zuerst die Worker-Adresse eintragen.");
  const headers = {};
  if (session?.token) headers.Authorization = `Bearer ${session.token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";

  let res;
  try {
    res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new Error("Keine Verbindung zum Server. Internet prüfen.");
  }
  if (res.status === 401) {
    // Sitzung abgelaufen oder ungültig -> zurück zum Login statt kaputter Ansicht.
    clearSession();
    throw new Error("Sitzung abgelaufen. Bitte neu anmelden.");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Fehler ${res.status}`);
  return data;
}

async function login(pin) {
  const base = getWorkerUrl();
  if (!base) throw new Error("Bitte zuerst die Worker-Adresse eintragen.");
  let res;
  try {
    res = await fetch(base + "/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin }),
    });
  } catch {
    throw new Error("Keine Verbindung zum Server. Internet und Worker-Adresse prüfen.");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Anmeldung fehlgeschlagen.");
  if (data.role !== "boss") throw new Error("Dieser Zugang ist nicht der Chef-Zugang. Bitte den Admin-PIN verwenden.");
  session = { token: data.token, name: data.name, role: data.role, workerUrl: base };
  localStorage.setItem(LS_KEY, JSON.stringify(session));
  return session;
}

const getOverview = () => request("/admin/overview");

const decideShift = (employeeName, date, slotLabel, decision, note) =>
  request("/admin/shift-decision", { method: "POST", body: { employeeName, date, slotLabel, decision, note } });

const markRestocked = (itemName) => request("/admin/stock", { method: "POST", body: { kind: "restock", itemName } });

const recordDelivery = (itemName, quantity, unit, date) =>
  request("/admin/stock", { method: "POST", body: { kind: "delivery", itemName, quantity, unit, date } });

/** Beleg (PDF/Foto) auswerten lassen. Die Datei wird als Base64 geschickt – der Worker gibt sie an die
 * Bilderkennung weiter und schreibt das Erkannte in dieselbe Warteschlange wie beim Telegram-Upload. */
async function uploadDocument(file) {
  const dataBase64 = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
    reader.onerror = () => reject(new Error("Datei konnte nicht gelesen werden."));
    reader.readAsDataURL(file);
  });
  return request("/admin/document", { method: "POST", body: { mimeType: file.type, dataBase64, caption: "" } });
}

const stockItemAction = (body) => request("/admin/stock-item", { method: "POST", body });
const recipeAction = (body) => request("/admin/recipe", { method: "POST", body });

export {
  getSession,
  clearSession,
  getWorkerUrl,
  setWorkerUrl,
  login,
  getOverview,
  decideShift,
  markRestocked,
  recordDelivery,
  uploadDocument,
  stockItemAction,
  recipeAction,
};
