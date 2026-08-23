// ============================================================================
// backup.js – Automatisches Tages-Backup nach GitHub (optional, in Einstellungen
// konfigurierbar). Läuft rein im Browser über die GitHub-API, kein eigener Server nötig.
// Legt einmal pro Kalendertag eine neue Datei backups/backup-YYYY-MM-DD.json im
// konfigurierten Repo an (nie überschrieben, daher kein Konflikt-Handling nötig).
// ============================================================================
import { store } from "./store.js";
import { todayStr } from "./format.js";

function utf8ToBase64(str) {
  return btoa(unescape(encodeURIComponent(str)));
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

  const res = await fetch(`https://api.github.com/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}/contents/${path}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      message: `Automatisches Backup ${date}`,
      content,
    }),
  });

  if (!res.ok) {
    // 422 = Datei für heute existiert schon (z.B. zweiter Versuch am selben Tag) -> zählt als Erfolg
    if (res.status === 422) {
      store.updateGithubBackupConfig({ lastBackupDate: date, lastError: null });
      return { alreadyExisted: true };
    }
    const body = await res.text().catch(() => "");
    throw new Error(`GitHub antwortete mit ${res.status}${body ? ": " + body.slice(0, 200) : ""}`);
  }

  store.updateGithubBackupConfig({ lastBackupDate: date, lastError: null });
  return { alreadyExisted: false };
}

/** Beim App-Start aufrufen: prüft, ob heute schon gesichert wurde, und sichert bei Bedarf still im Hintergrund. */
async function maybeRunDailyBackup() {
  const cfg = store.getGithubBackupConfig();
  if (!cfg.enabled) return;
  if (cfg.lastBackupDate === todayStr()) return; // heute schon erledigt
  try {
    await performBackup();
  } catch (e) {
    store.updateGithubBackupConfig({ lastError: String(e.message || e) });
  }
}

export { performBackup, maybeRunDailyBackup };
