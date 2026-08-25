// ============================================================================
// taskSync.js – Zwei-Wege-Abgleich mit dem Telegram-Bot (siehe worker/telegram-bot.js),
// über kleine JSON-Dateien im GitHub-Repo (dieselbe Verbindung wie backup.js):
//
//  data/pending-tasks.json  – vom Bot geschrieben, hier gelesen+geleert: neue Aufgaben
//                              (action "add", Standard) oder Lösch-Befehle (action "delete").
//  data/state-snapshot.json – hier geschrieben, vom Bot gelesen: aktuelle Aufgaben + bekannte
//                              Mitarbeiter, damit der Bot z.B. "liste mir alles auf" oder
//                              "lösch die Aufgabe X bei Anna" beantworten kann.
//
// Läuft rein im Browser über die GitHub-API, kein eigener Server nötig.
// ============================================================================
import { store } from "./store.js";
import { todayStr } from "./format.js";

const PENDING_PATH = "data/pending-tasks.json";
const SNAPSHOT_PATH = "data/state-snapshot.json";

function utf8ToBase64(str) {
  return btoa(unescape(encodeURIComponent(str)));
}
function base64ToUtf8(b64) {
  return decodeURIComponent(escape(atob(b64)));
}

function githubHeaders(cfg) {
  return { Authorization: `Bearer ${cfg.token}`, Accept: "application/vnd.github+json" };
}
function contentsUrl(cfg, path) {
  return `https://api.github.com/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}/contents/${path}`;
}

/** Aktuelle Aufgaben (ab heute) + aktive Mitarbeiter nach GitHub schreiben, damit der Bot sie kennt. */
async function publishStateSnapshot(cfg) {
  const url = contentsUrl(cfg, SNAPSHOT_PATH);
  const headers = githubHeaders(cfg);
  const getRes = await fetch(url, { headers });
  const sha = getRes.status === 200 ? (await getRes.json()).sha : undefined;

  const tasks = store.getTasksFrom(todayStr()).map((t) => ({
    dayId: t.dayId,
    taskId: t.id,
    date: t.date,
    text: t.text,
    assignedToName: t.assignedTo ? store.getEmployee(t.assignedTo)?.name || null : null,
    priority: t.priority,
    done: t.done,
  }));
  const employees = store.getEmployees(false).map((e) => e.name);

  await fetch(url, {
    method: "PUT",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({
      message: "Status aktualisiert",
      content: utf8ToBase64(JSON.stringify({ updatedAt: new Date().toISOString(), employees, tasks })),
      ...(sha ? { sha } : {}),
    }),
  });
}

/** Führt den Abruf jetzt durch (z.B. für den "Jetzt abrufen"-Button). Wirft bei echten Fehlern. */
async function performTaskSync() {
  const cfg = store.getGithubBackupConfig();
  if (!cfg.owner || !cfg.repo || !cfg.token) {
    throw new Error("Bitte zuerst GitHub-Nutzername, Repository und Token beim Backup weiter oben eintragen.");
  }
  const url = contentsUrl(cfg, PENDING_PATH);
  const headers = githubHeaders(cfg);

  const res = await fetch(url, { headers });
  let applied = 0;
  if (res.status === 200) {
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
      for (const item of unapplied) {
        if (item.action === "delete") {
          if (item.dayId && item.taskId) store.removeDayTask(item.dayId, item.taskId);
          continue;
        }
        // action "add" (Standard): targetDate (vom Bot erkannt, z.B. "...ist am Montag") -> Aufgabe
        // landet auf dem jeweiligen Tag, nicht zwingend heute. Ohne erkanntes Datum: heutiger Tag.
        const day = store.getOrCreateDayByDate(item.targetDate || todayStr());
        const match = item.assignedToName
          ? employees.find((e) => e.name.trim().toLowerCase() === String(item.assignedToName).trim().toLowerCase())
          : null;
        const priority = ["niedrig", "normal", "hoch"].includes(item.priority) ? item.priority : "normal";
        store.addRemoteDayTask(day.id, { text: item.text, assignedTo: match ? match.id : null, priority, addedBy: "Telegram" });
      }
      store.markTaskInboxIdsApplied(unapplied.map((i) => i.id));
      applied = unapplied.length;
    }

    // Verarbeitete Datei leeren, damit sie nicht unbegrenzt wächst. Schlägt das fehl (z.B. zwischenzeitlich
    // neue Nachricht angehängt -> sha stimmt nicht mehr), ist das kein Drama: appliedIds verhindert
    // Duplikate, der nächste Abruf holt neue Einträge und versucht das Leeren erneut.
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
  } else if (res.status !== 404) {
    const errBody = await res.text().catch(() => "");
    throw new Error(`GitHub antwortete mit ${res.status}${errBody ? ": " + errBody.slice(0, 200) : ""}`);
  }

  // Aktuellen Stand hochladen, damit der Bot bei der nächsten Nachricht weiß, was es schon gibt.
  // Schlägt nur das fehl, soll der eigentliche Abruf oben trotzdem als Erfolg zählen.
  try {
    await publishStateSnapshot(cfg);
  } catch {
    // beim nächsten Sync erneut versucht
  }

  store.updateTaskInboxConfig({ lastSyncAt: new Date().toISOString(), lastError: null });
  return { applied };
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
