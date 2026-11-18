// ============================================================================
// backup.js – Automatisches Backup nach GitHub (optional, in Einstellungen konfigurierbar).
// Läuft rein im Browser über die GitHub-API, kein eigener Server nötig.
//
// Eine Datei pro Kalendertag: backups/backup-YYYY-MM-DD.json. Sie wird im Lauf des Tages AKTUALISIERT,
// nicht nur einmal angelegt. Vorher enthielt das Tages-Backup immer nur den Stand vom ersten Öffnen –
// der Kassenabschluss vom Abend stand in keiner Sicherung, und genau der fehlt, wenn etwas schiefgeht.
// ============================================================================
import { store } from "./store.js";
import { todayStr } from "./format.js";
import { betrieb } from "./betrieb.js";

/** In welchem Ordner die Sicherungen dieses Betriebs liegen.
 *
 * frnds bleibt bei "backups/" – dort liegt die gesamte Historie, und ein Umbenennen würde sie aus der
 * Wiederherstellung verschwinden lassen. Jeder weitere Betrieb bekommt einen eigenen Unterordner.
 *
 * Ohne diese Trennung schreiben zwei Betriebe mit demselben Repository in DIESELBE Datei
 * (backup-YYYY-MM-DD.json) und überschreiben sich gegenseitig – alle drei Stunden, weil die Datei im
 * Lauf des Tages aktualisiert wird. Am Ende stünde in der Sicherung des einen der Stand des anderen:
 * derselbe Schaden wie im September, nur im Rettungsnetz selbst.
 */
function backupOrdner() {
  return betrieb.id === "frnds" ? "backups" : `backups/${betrieb.id}`;
}

function utf8ToBase64(str) {
  return btoa(unescape(encodeURIComponent(str)));
}

function ghUrl(cfg, path) {
  return `https://api.github.com/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}/contents/${path}`;
}

/** Die kleine Marke neben den Sicherungen: wessen Stand liegt dort, und von wann ist er?
 *
 * Bewusst eine EIGENE, winzige Datei statt der Sicherung selbst – sonst müsste vor jedem Schreiben
 * eine 4-MB-Datei geladen werden, nur um ein Datum abzulesen.
 */
const MARKE = "_stand.json";

async function leseMarke(cfg, kopf) {
  try {
    const res = await fetch(ghUrl(cfg, `${backupOrdner()}/${MARKE}`), {
      headers: { ...kopf, Accept: "application/vnd.github.raw" },
      cache: "no-store",
    });
    if (!res.ok) return null;
    return JSON.parse(await res.text());
  } catch {
    return null; // Keine Marke lesbar: dann eben ohne – ein fehlender Wächter darf das Sichern nicht verhindern.
  }
}

async function schreibeMarke(cfg, kopf, inhalt) {
  try {
    let sha = null;
    const vorhanden = await fetch(ghUrl(cfg, `${backupOrdner()}/${MARKE}`), { headers: kopf, cache: "no-store" });
    if (vorhanden.ok) sha = (await vorhanden.json().catch(() => ({}))).sha || null;
    await fetch(ghUrl(cfg, `${backupOrdner()}/${MARKE}`), {
      method: "PUT",
      headers: kopf,
      body: JSON.stringify({
        message: `Sicherungsmarke ${inhalt.zuletztGespeichert}`,
        content: utf8ToBase64(JSON.stringify(inhalt, null, 2)),
        ...(sha ? { sha } : {}),
      }),
    });
  } catch {
    // Die Marke ist eine Hilfe, kein Muss. Schlägt sie fehl, bleibt die Sicherung trotzdem gültig.
  }
}

/** Führt ein Backup jetzt durch (z.B. für den "Jetzt testen"-Button). Wirft bei Fehlern. */
async function performBackup({ erzwingen = false } = {}) {
  const cfg = store.getGithubBackupConfig();
  if (!cfg.owner || !cfg.repo || !cfg.token) {
    throw new Error("Bitte GitHub-Nutzername, Repository und Token eintragen.");
  }
  // Ein Gerät, das selbst nichts mehr speichern kann, arbeitet mit einem eingefrorenen Stand. Es darf
  // auf keinen Fall die Sicherung überschreiben – sonst zerstört ausgerechnet das Rettungsnetz die
  // Daten. Genau das ist im November passiert: ein zweites Gerät hat tagelang seinen Stand vom 14.11.
  // über die guten Sicherungen geschrieben.
  const zustand = store.speicherZustand();
  if (!zustand.ok) {
    throw new Error("Dieses Gerät kann gerade nichts speichern – es sichert deshalb auch nichts, damit es keine gute Sicherung überschreibt.");
  }
  const date = todayStr();
  const path = `${backupOrdner()}/backup-${date}.json`;
  const content = utf8ToBase64(store.exportJSON());
  const kopf = { Authorization: `Bearer ${cfg.token}`, Accept: "application/vnd.github+json", "Content-Type": "application/json" };

  // Liegt dort schon ein NEUERER Stand als unserer? Dann sind wir das veraltete Gerät und halten
  // die Finger davon. Verglichen wird, wann zuletzt wirklich gespeichert wurde – nicht, wann dieses
  // Backup läuft: ein eingefrorenes Gerät startet auch heute noch Sicherungen.
  const meinStand = store.zuletztGespeichert();
  const marke = await leseMarke(cfg, kopf);
  if (!erzwingen && marke?.zuletztGespeichert && meinStand && marke.zuletztGespeichert > meinStand) {
    throw new Error(
      `Die vorhandene Sicherung ist neuer (${marke.zuletztGespeichert.slice(0, 16).replace("T", " ")}, Gerät ${
        marke.geraet || "?"
      }) als der Stand dieses Geräts (${meinStand.slice(0, 16).replace("T", " ")}). Es wird nichts überschrieben.`
    );
  }

  // Gibt es die Datei von heute schon, wird sie überschrieben – dafür braucht GitHub ihre sha.
  let sha = null;
  const vorhanden = await fetch(ghUrl(cfg, path), { headers: kopf, cache: "no-store" });
  if (vorhanden.ok) sha = (await vorhanden.json().catch(() => ({}))).sha || null;

  const res = await fetch(ghUrl(cfg, path), {
    method: "PUT",
    headers: kopf,
    body: JSON.stringify({ message: `Automatisches Backup ${date}`, content, ...(sha ? { sha } : {}) }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GitHub antwortete mit ${res.status}${body ? ": " + body.slice(0, 200) : ""}`);
  }

  await schreibeMarke(cfg, kopf, { zuletztGespeichert: meinStand, geraet: store.geraeteKennung(), gesichertAm: new Date().toISOString() });
  store.updateGithubBackupConfig({ lastBackupDate: date, lastBackupAt: new Date().toISOString(), lastError: null });
  return { aktualisiert: !!sha };
}

/** Die vorhandenen Sicherungen auflisten (neueste zuerst) – Grundlage fürs Wiederherstellen. */
async function listBackups() {
  const cfg = store.getGithubBackupConfig();
  if (!cfg.owner || !cfg.repo || !cfg.token) throw new Error("Backup ist nicht eingerichtet.");
  const res = await fetch(ghUrl(cfg, backupOrdner()), { headers: { Authorization: `Bearer ${cfg.token}`, Accept: "application/vnd.github+json" } });
  if (!res.ok) throw new Error(`GitHub antwortete mit ${res.status}`);
  const liste = await res.json();
  return (Array.isArray(liste) ? liste : [])
    .filter((f) => f.name?.startsWith("backup-") && f.name.endsWith(".json"))
    .map((f) => ({ name: f.name, datum: f.name.slice(7, -5), groesseKB: Math.round((f.size || 0) / 1024), url: f.download_url }))
    .sort((a, b) => (a.datum < b.datum ? 1 : -1));
}

/** Den Inhalt einer Sicherung holen – zum Ansehen, bevor man sie einspielt. */
async function fetchBackup(datei) {
  const cfg = store.getGithubBackupConfig();
  const res = await fetch(ghUrl(cfg, `${backupOrdner()}/${datei.name}`), {
    headers: { Authorization: `Bearer ${cfg.token}`, Accept: "application/vnd.github.raw" },
  });
  if (!res.ok) throw new Error(`GitHub antwortete mit ${res.status}`);
  return res.text();
}

/** Beim App-Start und danach regelmäßig aufrufen. Gesichert wird, wenn heute noch nichts gesichert wurde
 * ODER die letzte Sicherung älter ist als ein paar Stunden – so steht am Abend nicht mehr nur der
 * Morgen-Stand in der Sicherung. */
const BACKUP_ABSTAND_STUNDEN = 3;
async function maybeRunDailyBackup() {
  const cfg = store.getGithubBackupConfig();
  if (!cfg.enabled) return;
  const alterStunden = cfg.lastBackupAt ? (Date.now() - new Date(cfg.lastBackupAt).getTime()) / 3600000 : Infinity;
  if (cfg.lastBackupDate === todayStr() && alterStunden < BACKUP_ABSTAND_STUNDEN) return;
  try {
    await performBackup();
  } catch (e) {
    store.updateGithubBackupConfig({ lastError: String(e.message || e) });
  }
}

/** Alle paar Stunden im Hintergrund sichern, solange die App offen ist – und einmal, wenn das Fenster
 * wieder in den Vordergrund kommt (am iPad steht die App oft tagelang offen). */
function starteBackupWache() {
  setInterval(() => maybeRunDailyBackup(), 30 * 60 * 1000);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) maybeRunDailyBackup();
  });
}

/** Wie es um die Sicherung steht – für den Warnhinweis im Admin-Bereich. */
function backupStatus() {
  const cfg = store.getGithubBackupConfig();
  const alterStunden = cfg.lastBackupAt ? (Date.now() - new Date(cfg.lastBackupAt).getTime()) / 3600000 : null;
  return {
    eingerichtet: !!(cfg.enabled && cfg.owner && cfg.repo && cfg.token),
    fehler: cfg.lastError || null,
    letztes: cfg.lastBackupDate || null,
    alterStunden,
    veraltet: cfg.enabled && (alterStunden === null || alterStunden > 36),
  };
}

export { performBackup, maybeRunDailyBackup, starteBackupWache, backupStatus, listBackups, fetchBackup };
