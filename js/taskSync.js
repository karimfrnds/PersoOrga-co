// ============================================================================
// taskSync.js – Holt Aufgaben ab, die per Telegram-Bot (siehe worker/telegram-bot.js)
// in data/pending-tasks.json im GitHub-Repo abgelegt wurden, und trägt sie in den
// heutigen Tag ein. Nutzt dieselbe GitHub-Verbindung (owner/repo/token) wie backup.js.
// Läuft rein im Browser über die GitHub-API, kein eigener Server nötig.
// ============================================================================
import { store } from "./store.js";
import { todayStr } from "./format.js";

const PENDING_PATH = "data/pending-tasks.json";

function utf8ToBase64(str) {
  return btoa(unescape(encodeURIComponent(str)));
}
function base64ToUtf8(b64) {
  return decodeURIComponent(escape(atob(b64)));
}

/** Führt den Abruf jetzt durch (z.B. für den "Jetzt abrufen"-Button). Wirft bei echten Fehlern. */
async function performTaskSync() {
  const cfg = store.getGithubBackupConfig();
  if (!cfg.owner || !cfg.repo || !cfg.token) {
    throw new Error("Bitte zuerst GitHub-Nutzername, Repository und Token beim Backup weiter oben eintragen.");
  }
  const url = `https://api.github.com/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}/contents/${PENDING_PATH}`;
  const headers = { Authorization: `Bearer ${cfg.token}`, Accept: "application/vnd.github+json" };

  const res = await fetch(url, { headers });
  if (res.status === 404) {
    // Noch keine Datei -> nichts zu tun, gilt als Erfolg.
    store.updateTaskInboxConfig({ lastSyncAt: new Date().toISOString(), lastError: null });
    return { applied: 0 };
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GitHub antwortete mit ${res.status}${body ? ": " + body.slice(0, 200) : ""}`);
  }
  const body = await res.json();
  let parsed;
  try {
    parsed = JSON.parse(base64ToUtf8(body.content));
  } catch {
    throw new Error("pending-tasks.json ist kein gültiges JSON.");
  }
  const items = Array.isArray(parsed.items) ? parsed.items : [];
  const unapplied = items.filter((i) => i.id && !store.isTaskInboxIdApplied(i.id));

  if (unapplied.length > 0) {
    const employees = store.getEmployees(false);
    const day = store.getOrCreateDayByDate(todayStr());
    for (const item of unapplied) {
      const match = item.assignedToName
        ? employees.find((e) => e.name.trim().toLowerCase() === String(item.assignedToName).trim().toLowerCase())
        : null;
      store.addRemoteDayTask(day.id, { text: item.text, assignedTo: match ? match.id : null, addedBy: "Telegram" });
    }
    store.markTaskInboxIdsApplied(unapplied.map((i) => i.id));
  }

  // Verarbeitete Datei leeren, damit sie nicht unbegrenzt wächst. Schlägt das fehl (z.B. zwischenzeitlich
  // neue Nachricht angehängt -> sha stimmt nicht mehr), ist das kein Drama: appliedIds verhindert Duplikate,
  // der nächste Abruf holt neue Einträge und versucht das Leeren erneut.
  if (items.length > 0) {
    try {
      await fetch(url, {
        method: "PUT",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({
          message: "Aufgaben übernommen",
          content: utf8ToBase64(JSON.stringify({ items: [] })),
          sha: body.sha,
        }),
      });
    } catch {
      // ignorieren, siehe Kommentar oben
    }
  }

  store.updateTaskInboxConfig({ lastSyncAt: new Date().toISOString(), lastError: null });
  return { applied: unapplied.length };
}

/** Beim App-Start / im Leerlauf aufrufen: holt still im Hintergrund neue Aufgaben ab, wenn aktiviert. */
async function maybeSyncPendingTasks() {
  const cfg = store.getTaskInboxConfig();
  if (!cfg.enabled) return;
  try {
    await performTaskSync();
  } catch (e) {
    store.updateTaskInboxConfig({ lastError: String(e.message || e) });
  }
}

export { performTaskSync, maybeSyncPendingTasks };
