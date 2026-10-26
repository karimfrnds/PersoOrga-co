// ============================================================================
// kueche/api.js – Verbindung des Küchen-Tablets zum Worker.
//
// Zwei Unterschiede zum Handy, beide folgen daraus, dass hier ein GETEILTES Gerät steht:
//
//   Die Sitzung überlebt das Neuladen NICHT. Auf dem Handy bleibt man angemeldet, weil es einem selbst
//   gehört. In der Küche kommen fünf Leute vorbei – wer als Letztes dran war, darf nicht die Person
//   sein, auf deren Namen die nächste Schicht gebucht wird.
//
//   Die Adresse des Workers bleibt dagegen schon gespeichert: die trägt man einmal ein, nicht fünfmal
//   am Tag.
// ============================================================================
import { speicherSchluessel } from "../betrieb.js";

const LS_URL = speicherSchluessel("cafeapp_kueche_workerurl");

let session = null; // bewusst nur im Speicher, nicht in localStorage

const getSession = () => session;
const getWorkerUrl = () => localStorage.getItem(LS_URL) || "";
const setWorkerUrl = (url) => localStorage.setItem(LS_URL, String(url).trim().replace(/\/+$/, ""));
const clearSession = () => {
  session = null;
};

async function call(path, { method = "GET", body } = {}) {
  const base = getWorkerUrl();
  if (!base) throw new Error("Adresse noch nicht eingetragen.");
  const headers = {};
  if (session?.token) headers.Authorization = `Bearer ${session.token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";

  let res;
  try {
    res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new Error("Keine Verbindung. Hängt das WLAN?");
  }
  if (res.status === 401) {
    clearSession();
    const e = new Error("Die Anmeldung ist abgelaufen. Bitte PIN neu eingeben.");
    e.abgemeldet = true;
    throw e;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Fehler ${res.status}`);
  return data;
}

async function login(pin) {
  const base = getWorkerUrl();
  if (!base) throw new Error("Adresse noch nicht eingetragen.");
  let res;
  try {
    res = await fetch(base + "/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pin }) });
  } catch {
    throw new Error("Keine Verbindung. Hängt das WLAN?");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "PIN nicht erkannt.");
  if (data.role !== "employee") throw new Error("Das ist kein Mitarbeiter-PIN.");
  session = { token: data.token, name: data.name };
  return session;
}

const getOverview = () => call("/kueche/overview");
/** kind: "in" | "out" */
const stempeln = (kind) => call("/kueche/clock", { method: "POST", body: { kind } });
/** Produktion eintragen. auftragId optional – dann gilt der Auftrag als erledigt. */
const sendeCharge = (daten) => call("/kueche/produktion", { method: "POST", body: { kind: "charge", ...daten } });
const sendeLeer = (chargeId) => call("/kueche/produktion", { method: "POST", body: { kind: "leer", chargeId } });
const sendeAuftragWeg = (auftragId) => call("/kueche/produktion", { method: "POST", body: { kind: "auftrag-weg", auftragId } });

export { getSession, clearSession, getWorkerUrl, setWorkerUrl, login, getOverview, stempeln, sendeCharge, sendeLeer, sendeAuftragWeg };
