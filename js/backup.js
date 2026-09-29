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

function utf8ToBase64(str) {
  return btoa(unescape(encodeURIComponent(str)));
}

function ghUrl(cfg, path) {
  return `https://api.github.com/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}/contents/${path}`;
}

/** Führt ein Backup jetzt durch (z.B. für den "Jetzt testen"-Button). Wirft bei Fehlern. */
async function performBackup() {
  const cfg = store.getGithubBackupConfig();
  if (!cfg.owner || !cfg.repo || !cfg.token) {
    throw new Error("Bitte GitHub-Nutzername, Repository und Token eintragen.");
  }
  const date = todayStr();
  const path = `backups/backup-${date}.json`;
  const content = utf8ToBase64(store.exportJSON());
  const kopf = { Authorization: `Bearer ${cfg.token}`, Accept: "application/vnd.github+json", "Content-Type": "application/json" };

  // Gibt es die Datei von heute schon, wird sie überschrieben – dafür braucht GitHub ihre sha.
  let sha = null;
  const vorhanden = await fetch(ghUrl(cfg, path), { headers: kopf });
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

  store.updateGithubBackupConfig({ lastBackupDate: date, lastBackupAt: new Date().toISOString(), lastError: null });
  return { aktualisiert: !!sha };
}

/** Die vorhandenen Sicherungen auflisten (neueste zuerst) – Grundlage fürs Wiederherstellen. */
async function listBackups() {
  const cfg = store.getGithubBackupConfig();
  if (!cfg.owner || !cfg.repo || !cfg.token) throw new Error("Backup ist nicht eingerichtet.");
  const res = await fetch(ghUrl(cfg, "backups"), { headers: { Authorization: `Bearer ${cfg.token}`, Accept: "application/vnd.github+json" } });
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
  const res = await fetch(ghUrl(cfg, `backups/${datei.name}`), {
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
