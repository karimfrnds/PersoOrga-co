// ============================================================================
// worker/telegram-bot.js – Cloudflare Worker: nimmt Telegram-Nachrichten des
// Admins entgegen. Liest zuerst den aktuellen Stand (data/state-snapshot.json,
// von der App geschrieben) und lässt Claude daraus bestimmen, ob Aufgaben
// angelegt, gelöscht oder aufgelistet werden sollen:
//   - "add"    -> ein oder mehrere neue Aufgaben in data/pending-tasks.json ablegen
//   - "delete" -> Lösch-Befehle (dayId/taskId aus dem Snapshot) in derselben Datei ablegen
//   - "list"   -> Antwort wird direkt aus dem Snapshot gebaut (keine KI-Erfindung)
// Die App (js/taskSync.js) holt pending-tasks.json ab und schreibt den Snapshot.
//
// Wird NICHT automatisch deployed – dieses Skript in einen Cloudflare Worker
// einfügen. Genaue Schritte: worker/README.md.
//
// Erwartete Secrets/Variablen im Worker (Cloudflare Dashboard → Settings → Variables):
//   TELEGRAM_BOT_TOKEN  – Token von @BotFather
//   WEBHOOK_SECRET      – frei erfundener String, beim Setzen des Telegram-Webhooks mitgeben
//   GITHUB_TOKEN        – Fine-grained PAT, "Contents: Read and write" nur für dieses Repo
//   GITHUB_OWNER        – GitHub-Nutzername
//   GITHUB_REPO         – Repository-Name
//   OWNER_CHAT_ID       – Telegram-Chat-ID des Admins (anfangs leer lassen, siehe README)
//   ANTHROPIC_API_KEY   – API-Key von console.anthropic.com, fürs Verstehen der Nachrichten
// ============================================================================

const PENDING_PATH = "data/pending-tasks.json";
const SNAPSHOT_PATH = "data/state-snapshot.json";
const MAX_PENDING_ITEMS = 50; // Sicherheitsnetz, falls die App mal länger nicht abruft
const PRIORITIES = ["niedrig", "normal", "hoch"];

function utf8ToBase64(str) {
  return btoa(unescape(encodeURIComponent(str)));
}
function base64ToUtf8(b64) {
  return decodeURIComponent(escape(atob(b64)));
}
function todayBerlin() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}
function formatDateDe(iso) {
  const [y, m, d] = iso.split("-");
  return `${d}.${m}.${y}`;
}

async function sendTelegramMessage(env, chatId, text) {
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  }).catch(() => {});
}

function githubHeaders(env) {
  return {
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "PersoApp-Telegram-Worker",
  };
}
function contentsUrl(env, path) {
  return `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${path}`;
}

/** Liest den von der App geschriebenen Stand (Aufgaben ab heute + aktive Mitarbeiter). */
async function readSnapshot(env) {
  const res = await fetch(contentsUrl(env, SNAPSHOT_PATH), { headers: githubHeaders(env) });
  if (res.status !== 200) return { updatedAt: null, employees: [], tasks: [] };
  const body = await res.json();
  try {
    return JSON.parse(base64ToUtf8(body.content));
  } catch {
    return { updatedAt: null, employees: [], tasks: [] };
  }
}

async function appendPendingItems(env, newItems) {
  const url = contentsUrl(env, PENDING_PATH);
  const headers = githubHeaders(env);
  const getRes = await fetch(url, { headers });
  let items = [];
  let sha;
  if (getRes.status === 200) {
    const body = await getRes.json();
    sha = body.sha;
    try {
      const parsed = JSON.parse(base64ToUtf8(body.content));
      if (Array.isArray(parsed.items)) items = parsed.items;
    } catch {
      items = [];
    }
  } else if (getRes.status !== 404) {
    throw new Error(`GitHub GET ${getRes.status}`);
  }

  items.push(...newItems);
  if (items.length > MAX_PENDING_ITEMS) items = items.slice(items.length - MAX_PENDING_ITEMS);

  const putRes = await fetch(url, {
    method: "PUT",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({
      message: `${newItems.length} Befehl(e) per Telegram`,
      content: utf8ToBase64(JSON.stringify({ items })),
      ...(sha ? { sha } : {}),
    }),
  });
  if (!putRes.ok) throw new Error(`GitHub PUT ${putRes.status}`);
}

// ---------------------------------------------------------------------
// Claude entscheiden lassen, was die Nachricht will: Aufgaben anlegen,
// löschen, oder die aktuelle Liste zeigen. Bekommt dafür den echten
// aktuellen Stand (Snapshot) als Kontext, damit Löschen/Liste stimmen.
// ---------------------------------------------------------------------
async function interpretMessage(env, text, today, snapshot) {
  const tool = {
    name: "handle_message",
    description: "Interpretiert eine Nachricht des Café-Betreibers ans Team-Aufgaben-System.",
    input_schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["add", "delete", "list", "other"] },
        tasks_to_add: {
          type: "array",
          description: "Nur bei action=add. Jede einzelne neue Aufgabe als eigener Eintrag, niemals mehrere Themen zusammenfassen.",
          items: {
            type: "object",
            properties: {
              text: { type: "string", description: "Kurze, klare Aufgabenbeschreibung auf Deutsch. Ohne Namen und ohne Datumsangabe." },
              assignedToName: { type: "string", description: "Name der Person aus der Mitarbeiterliste, falls erkennbar. Sonst leerer String." },
              targetDate: { type: "string", description: "Datum YYYY-MM-DD falls ein Tag genannt wurde, sonst leerer String." },
              priority: { type: "string", enum: PRIORITIES },
            },
            required: ["text", "priority"],
          },
        },
        tasks_to_delete: {
          type: "array",
          description: "Nur bei action=delete. Exakt aus der unten gelisteten aktuellen Aufgaben-Liste übernehmen (dayId/taskId).",
          items: {
            type: "object",
            properties: { dayId: { type: "string" }, taskId: { type: "string" } },
            required: ["dayId", "taskId"],
          },
        },
      },
      required: ["action"],
    },
  };

  const taskLines = snapshot.tasks.length
    ? snapshot.tasks
        .map((t) => `- [${t.dayId}/${t.taskId}] ${t.date} · ${t.assignedToName || "Allgemein"} · ${t.done ? "erledigt" : "offen"}: ${t.text}`)
        .join("\n")
    : "(aktuell keine)";

  const system = `Heute ist ${today} (Europe/Berlin). Bekannte aktive Mitarbeiter: ${snapshot.employees.join(", ") || "(keine hinterlegt)"}.

Aktuelle Aufgaben (ab heute), zum Nachschlagen für "delete" und "list":
${taskLines}

Bestimme die Absicht der Nachricht:
- "add": eine oder mehrere NEUE Aufgaben anlegen. Enthält die Nachricht mehrere Aufgaben oder mehrere Personen (getrennt durch "und", Komma, Zeilenumbruch, Aufzählung, mehrere Sätze), IMMER als mehrere einzelne Einträge in tasks_to_add auflisten – NIEMALS den ganzen Nachrichtentext als einen Eintrag kopieren oder mehrere Themen zusammenfassen. assignedToName nur setzen, wenn ein Name aus der Mitarbeiterliste eindeutig zuzuordnen ist. Wochentage/relative Angaben ("morgen", "Montag", ...) in ein absolutes Datum auflösen (nächstes Vorkommen ab heute).
- "delete": eine oder mehrere der oben gelisteten Aufgaben sollen entfernt werden (Nutzer beschreibt sie in eigenen Worten, ggf. mit Person). Nur eindeutige, klar erkennbare Treffer übernehmen.
- "list": der Nutzer will die aktuelle Liste/Übersicht sehen (z.B. "was steht an", "liste mir alles auf", "was ist offen").
- "other": nichts davon eindeutig, z.B. Small Talk oder unklare Nachricht.`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1536,
      system,
      tools: [tool],
      tool_choice: { type: "tool", name: "handle_message" },
      messages: [{ role: "user", content: text }],
    }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Anthropic API ${res.status}${errText ? ": " + errText.slice(0, 300) : ""}`);
  }
  const data = await res.json();
  const toolUse = (data.content || []).find((b) => b.type === "tool_use");
  if (!toolUse?.input?.action) throw new Error("Keine verwertbare Antwort erhalten");
  return toolUse.input;
}

function buildListReply(snapshot, today) {
  if (snapshot.tasks.length === 0) return "📋 Aktuell keine Aufgaben hinterlegt.";
  const byDate = {};
  for (const t of snapshot.tasks) {
    (byDate[t.date] ||= []).push(t);
  }
  const dates = Object.keys(byDate).sort();
  const lines = ["📋 Aktuelle Aufgaben:"];
  for (const date of dates) {
    lines.push(`\n${date === today ? "Heute" : formatDateDe(date)}:`);
    for (const t of byDate[date]) {
      const who = t.assignedToName || "Allgemein";
      const prio = t.priority === "hoch" ? " 🔴" : t.priority === "niedrig" ? " 🔵" : "";
      lines.push(`${t.done ? "✅" : "⬜"} ${who}: ${t.text}${prio}`);
    }
  }
  if (snapshot.updatedAt) {
    const t = new Date(snapshot.updatedAt);
    lines.push(`\n(Stand: ${t.toLocaleDateString("de-DE")} ${t.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })} Uhr)`);
  }
  return lines.join("\n");
}

function buildAddReply(items, today) {
  const lines = items.map((item, i) => {
    const who = item.assignedToName || "Alle";
    const dateSuffix = item.targetDate && item.targetDate !== today ? ` · ${formatDateDe(item.targetDate)}` : "";
    const prioSuffix = item.priority === "hoch" ? " · 🔴 hoch" : item.priority === "niedrig" ? " · 🔵 niedrig" : "";
    return `${i + 1}. ${who} – ${item.text}${dateSuffix}${prioSuffix}`;
  });
  const heading = items.length === 1 ? "✅ Notiert:" : `✅ ${items.length} Aufgaben notiert:`;
  return [heading, ...lines].join("\n");
}

function buildDeleteReply(matched, snapshot) {
  const lines = matched.map((m) => {
    const found = snapshot.tasks.find((t) => t.dayId === m.dayId && t.taskId === m.taskId);
    return found ? `- ${found.assignedToName || "Allgemein"}: ${found.text}` : "- (unbekannte Aufgabe)";
  });
  return ["🗑 Entfernt:", ...lines].join("\n");
}

export default {
  async fetch(request, env) {
    if (request.method !== "POST") return new Response("ok", { status: 200 });

    const secretHeader = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
    if (!env.WEBHOOK_SECRET || secretHeader !== env.WEBHOOK_SECRET) {
      return new Response("forbidden", { status: 403 });
    }

    let update;
    try {
      update = await request.json();
    } catch {
      return new Response("bad request", { status: 400 });
    }

    const message = update.message;
    const text = message?.text;
    const chatId = message?.chat?.id;
    if (!text || chatId === undefined) return new Response("ok", { status: 200 });

    if (!env.OWNER_CHAT_ID) {
      await sendTelegramMessage(env, chatId, `Setup: Deine Chat-ID ist ${chatId}. Bitte als OWNER_CHAT_ID-Secret im Worker hinterlegen.`);
      return new Response("ok", { status: 200 });
    }
    if (String(chatId) !== String(env.OWNER_CHAT_ID)) {
      return new Response("ok", { status: 200 });
    }

    const today = todayBerlin();

    try {
      const snapshot = await readSnapshot(env);

      if (!env.ANTHROPIC_API_KEY) {
        await sendTelegramMessage(env, chatId, "⚠ ANTHROPIC_API_KEY fehlt im Worker – ich kann Nachrichten gerade nicht verstehen.");
        return new Response("ok", { status: 200 });
      }

      const result = await interpretMessage(env, text, today, snapshot);

      if (result.action === "list") {
        await sendTelegramMessage(env, chatId, buildListReply(snapshot, today));
      } else if (result.action === "delete") {
        const candidates = Array.isArray(result.tasks_to_delete) ? result.tasks_to_delete : [];
        const matched = candidates.filter((c) => snapshot.tasks.some((t) => t.dayId === c.dayId && t.taskId === c.taskId));
        if (matched.length === 0) {
          await sendTelegramMessage(env, chatId, `Habe dazu keine passende Aufgabe in der aktuellen Liste gefunden. Schick mir „liste" für die Übersicht.`);
        } else {
          await appendPendingItems(
            env,
            matched.map((m) => ({ id: crypto.randomUUID(), action: "delete", dayId: m.dayId, taskId: m.taskId, createdAt: new Date().toISOString() }))
          );
          await sendTelegramMessage(env, chatId, buildDeleteReply(matched, snapshot));
        }
      } else if (result.action === "add") {
        const tasks = (Array.isArray(result.tasks_to_add) ? result.tasks_to_add : [])
          .map((t) => ({
            text: String(t.text || "").trim(),
            assignedToName: t.assignedToName ? String(t.assignedToName).trim() : null,
            targetDate: /^\d{4}-\d{2}-\d{2}$/.test(t.targetDate) ? t.targetDate : null,
            priority: PRIORITIES.includes(t.priority) ? t.priority : "normal",
          }))
          .filter((t) => t.text);
        if (tasks.length === 0) {
          await sendTelegramMessage(env, chatId, "Konnte daraus keine Aufgabe erkennen. Magst du es anders formulieren?");
        } else {
          const items = tasks.map((t) => ({ id: crypto.randomUUID(), action: "add", ...t, createdAt: new Date().toISOString() }));
          await appendPendingItems(env, items);
          await sendTelegramMessage(env, chatId, buildAddReply(items, today));
        }
      } else {
        await sendTelegramMessage(
          env,
          chatId,
          `Das habe ich nicht eindeutig verstanden. Du kannst mir z.B. schreiben:\n„Anna soll die Kasse zählen"\n„liste" für die aktuelle Übersicht\n„lösch die Aufgabe Kasse zählen bei Anna"`
        );
      }
    } catch (e) {
      await sendTelegramMessage(env, chatId, `⚠ Fehler: ${e.message}`);
    }

    return new Response("ok", { status: 200 });
  },
};
