// ============================================================================
// kueche/api.js – Verbindung des Küchen-Tablets zum Worker.
//
// Hier gibt es ZWEI Anmeldungen, und der Unterschied ist der ganze Punkt:
//
//   DAS GERÄT meldet sich einmal an, mit dem Zugang des Küchen-Tablets, und bleibt angemeldet. Nur
//   deshalb kann der Leerlauf-Bildschirm überhaupt zeigen, wer im Dienst ist – ohne das müsste sich
//   erst jemand anmelden, damit das Tablet etwas anzeigt, und dann wäre es keine Stempelstation.
//
//   DIE PERSON meldet sich mit ihrem eigenen PIN an, wenn sie ihr Fenster öffnet, und ist wieder weg,
//   sobald sie "Zurück" tippt. Auf einem Gerät, an dem fünf Leute vorbeikommen, darf die letzte Person
//   nicht die sein, auf deren Namen die nächste Schicht gebucht wird.
//
// Deshalb überlebt nur die Geräte-Anmeldung das Neuladen, die persönliche nicht.
// ============================================================================
import { speicherSchluessel } from "../betrieb.js";

const LS_URL = speicherSchluessel("cafeapp_kueche_workerurl");
const LS_GERAET = speicherSchluessel("cafeapp_kueche_geraet");

let geraet = (() => {
  try {
    return JSON.parse(localStorage.getItem(LS_GERAET)) || null;
  } catch {
    return null;
  }
})();
let person = null; // bewusst nur im Speicher

const getGeraet = () => geraet;
const getPerson = () => person;
const getWorkerUrl = () => localStorage.getItem(LS_URL) || "";
const setWorkerUrl = (url) => localStorage.setItem(LS_URL, String(url).trim().replace(/\/+$/, ""));

function clearGeraet() {
  geraet = null;
  try {
    localStorage.removeItem(LS_GERAET);
  } catch {}
}
const clearPerson = () => {
  person = null;
};

async function call(path, token, { method = "GET", body } = {}) {
  const base = getWorkerUrl();
  if (!base) throw new Error("Adresse noch nicht eingetragen.");
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";

  let res;
  try {
    res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new Error("Keine Verbindung. Hängt das WLAN?");
  }
  if (res.status === 401) {
    const e = new Error("Die Anmeldung ist abgelaufen.");
    e.abgemeldet = true;
    // Welche der beiden abgelaufen ist, weiss nur der Aufrufer – hier wird nichts geraten.
    throw e;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Fehler ${res.status}`);
  return data;
}

/** Rohe Anmeldung. Gibt zurück, welche Art von Zugang der PIN ist. */
async function anmelden(pin) {
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
  return data;
}

/** Das Gerät einrichten – einmalig, mit dem Zugang des Küchen-Tablets. */
async function geraetAnmelden(pin) {
  const data = await anmelden(pin);
  if (data.role !== "kuechenstation") throw new Error("Das ist nicht der Zugang des Küchen-Tablets.");
  geraet = { token: data.token };
  try {
    localStorage.setItem(LS_GERAET, JSON.stringify(geraet));
  } catch {}
  return geraet;
}

/** Eine Person öffnet ihr Fenster – oder die Küchenleitung ihren Pflege-Bereich.
 * Welche der beiden es war, steht in `rolle`; der Aufrufer entscheidet, was er damit macht. */
async function personAnmelden(pin) {
  const data = await anmelden(pin);
  if (data.role !== "employee" && data.role !== "kuechenleitung") throw new Error("Das ist kein Mitarbeiter-PIN.");
  person = { token: data.token, name: data.name, rolle: data.role };
  return person;
}

const getStation = () => call("/kueche/station", geraet?.token);
/** Der Hub: Auswertung der Küche. Mit dem Geräte-Zugang lesbar – wer vorbeigeht, soll sehen, wie es
 * steht, ohne sich anzumelden. Mit dem Zugang der Küchenleitung kommt das Pflegen dazu. */
const getHub = (alsLeitung = false) => call("/kueche/hub", alsLeitung ? person?.token : geraet?.token);
/** Stammdaten pflegen – nur die Küchenleitung. art: "produkt" | "behaelter" | "auftrag". */
const sendeStamm = (daten) => call("/kueche/stamm", person?.token, { method: "POST", body: daten });
const getOverview = () => call("/kueche/overview", person?.token);
/** kind: "in" | "out" */
const stempeln = (kind) => call("/kueche/clock", person?.token, { method: "POST", body: { kind } });
const sendeCharge = (daten) => call("/kueche/produktion", person?.token, { method: "POST", body: { kind: "charge", ...daten } });
const sendeLeer = (chargeId) => call("/kueche/produktion", person?.token, { method: "POST", body: { kind: "leer", chargeId } });
const sendeAuftragWeg = (auftragId) => call("/kueche/produktion", person?.token, { method: "POST", body: { kind: "auftrag-weg", auftragId } });

export {
  getGeraet,
  getPerson,
  clearGeraet,
  clearPerson,
  getWorkerUrl,
  setWorkerUrl,
  geraetAnmelden,
  personAnmelden,
  getStation,
  getHub,
  sendeStamm,
  getOverview,
  stempeln,
  sendeCharge,
  sendeLeer,
  sendeAuftragWeg,
};
