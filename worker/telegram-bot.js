// ============================================================================
// worker/telegram-bot.js – Cloudflare Worker: nimmt Telegram-Nachrichten des
// Admins entgegen, lässt sie von Claude in einzelne Aufgaben zerlegen (Name,
// Tag, Priorität) und legt sie in data/pending-tasks.json im GitHub-Repo ab.
// Die App (js/taskSync.js) holt sie von dort ab.
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
//   ANTHROPIC_API_KEY   – API-Key von console.anthropic.com, fürs Zerlegen der Nachrichten
// ============================================================================

const PENDING_PATH = "data/pending-tasks.json";
const MAX_PENDING_ITEMS = 50; // Sicherheitsnetz, falls die App mal länger nicht abruft
const PRIORITIES = ["niedrig", "normal", "hoch"];
const WEEKDAYS = ["sonntag", "montag", "dienstag", "mittwoch", "donnerstag", "freitag", "samstag"]; // Index = JS getUTCDay()

function utf8ToBase64(str) {
  return btoa(unescape(encodeURIComponent(str)));
}
function base64ToUtf8(b64) {
  return decodeURIComponent(escape(atob(b64)));
}

/** Heutiges Datum in Berlin-Ortszeit als YYYY-MM-DD (Cloudflare Workers laufen sonst in UTC). */
function todayBerlin() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}
function addDaysISO(dateStr, n) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}
function formatDateDe(iso) {
  const [y, m, d] = iso.split("-");
  return `${d}.${m}.${y}`;
}

// ---------------------------------------------------------------------
// Nachricht per Claude in einzelne Aufgaben zerlegen (Name/Tag/Priorität je
// Aufgabe erkennen, auch wenn mehrere Aufgaben in einer Nachricht stecken).
// ---------------------------------------------------------------------
async function splitTasksWithAI(env, text, today) {
  const tool = {
    name: "record_tasks",
    description: "Zerlegt eine Nachricht des Café-Betreibers in einzelne Aufgaben für sein Team.",
    input_schema: {
      type: "object",
      properties: {
        tasks: {
          type: "array",
          items: {
            type: "object",
            properties: {
              text: { type: "string", description: "Kurze, klare Aufgabenbeschreibung auf Deutsch. Ohne Namen und ohne Datumsangabe (die stehen in den anderen Feldern)." },
              assignedToName: { type: ["string", "null"], description: "Vorname der Person, falls die Aufgabe für jemand Bestimmtes ist, sonst null." },
              targetDate: { type: ["string", "null"], description: "Datum im Format YYYY-MM-DD, falls ein Tag genannt wurde (Wochentag, 'morgen', explizites Datum, ...), sonst null." },
              priority: { type: "string", enum: PRIORITIES, description: "'hoch' bei erkennbarer Dringlichkeit/Priorisierung, 'niedrig' wenn explizit unwichtig/kann warten, sonst 'normal'." },
            },
            required: ["text", "priority"],
          },
        },
      },
      required: ["tasks"],
    },
  };

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1024,
      system: `Heute ist ${today} (Europe/Berlin), das ist auch das Format für targetDate. Zerlege die Nachricht eines Café-Betreibers in einzelne Aufgaben für sein Team – wenn mehrere Aufgaben/Personen in einer Nachricht genannt werden (z.B. durch "und", Komma, Zeilenumbruch getrennt), jede als eigenen Eintrag auflisten, nicht zusammenfassen. Wochentage/relative Angaben ("morgen", "Montag", ...) in ein absolutes Datum auflösen (nächstes Vorkommen ab heute, heute zählt falls der genannte Wochentag heute ist).`,
      tools: [tool],
      tool_choice: { type: "tool", name: "record_tasks" },
      messages: [{ role: "user", content: text }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic API ${res.status}`);
  const data = await res.json();
  const toolUse = (data.content || []).find((b) => b.type === "tool_use");
  const tasks = toolUse?.input?.tasks;
  if (!Array.isArray(tasks) || tasks.length === 0) throw new Error("Keine Aufgaben erkannt");
  return tasks.map((t) => ({
    text: String(t.text || "").trim(),
    assignedToName: t.assignedToName ? String(t.assignedToName).trim() : null,
    targetDate: /^\d{4}-\d{2}-\d{2}$/.test(t.targetDate) ? t.targetDate : null,
    priority: PRIORITIES.includes(t.priority) ? t.priority : "normal",
  })).filter((t) => t.text);
}

// ---------------------------------------------------------------------
// Rückfall-Erkennung per Textmuster, falls die KI-Anfrage fehlschlägt
// (kein ANTHROPIC_API_KEY gesetzt, API nicht erreichbar, o.ä.) – damit der
// Bot nie einfach stumm bleibt, nur weniger schlau zerlegt.
// ---------------------------------------------------------------------
function extractTargetDateFallback(text, today) {
  const lower = text.toLowerCase();
  if (/\bheute\b/.test(lower)) return today;
  if (/\bübermorgen\b/.test(lower)) return addDaysISO(today, 2);
  if (/\bmorgen\b/.test(lower)) return addDaysISO(today, 1);
  for (let i = 0; i < WEEKDAYS.length; i++) {
    if (lower.includes(WEEKDAYS[i])) {
      const todayDow = new Date(today + "T12:00:00Z").getUTCDay();
      let diff = i - todayDow;
      if (diff < 0) diff += 7;
      return addDaysISO(today, diff);
    }
  }
  return null;
}
function splitTasksFallback(text, today) {
  const trimmed = text.trim();
  const targetDate = extractTargetDateFallback(trimmed, today);
  const priority = /\b(dringend|wichtig|priorisier\w*|prio)\b/i.test(trimmed) ? "hoch" : /\b(niedrig|unwichtig|kann warten)\b/i.test(trimmed) ? "niedrig" : "normal";
  let m = trimmed.match(/^([\p{L} ]{1,30})\s*[:\-–]\s*(.+)$/su);
  if (m) return [{ assignedToName: m[1].trim(), text: m[2].trim(), targetDate, priority }];
  m = trimmed.match(/^([\p{Lu}][\p{L}]*(?:\s[\p{Lu}][\p{L}]*)?)\s+soll\s+(.+)$/su);
  if (m) return [{ assignedToName: m[1].trim(), text: m[2].trim(), targetDate, priority }];
  return [{ assignedToName: null, text: trimmed, targetDate, priority }];
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

async function appendPendingTasks(env, newItems) {
  const url = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${PENDING_PATH}`;
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
      message: `${newItems.length} Aufgabe(n) per Telegram`,
      content: utf8ToBase64(JSON.stringify({ items })),
      ...(sha ? { sha } : {}),
    }),
  });
  if (!putRes.ok) throw new Error(`GitHub PUT ${putRes.status}`);
}

function buildReply(items, today) {
  const lines = items.map((item, i) => {
    const who = item.assignedToName ? item.assignedToName : "Alle";
    const dateSuffix = item.targetDate && item.targetDate !== today ? ` · ${formatDateDe(item.targetDate)}` : "";
    const prioSuffix = item.priority === "hoch" ? " · 🔴 hoch" : item.priority === "niedrig" ? " · 🔵 niedrig" : "";
    return `${i + 1}. ${who} – ${item.text}${dateSuffix}${prioSuffix}`;
  });
  const heading = items.length === 1 ? "✅ Notiert:" : `✅ ${items.length} Aufgaben notiert:`;
  return [heading, ...lines].join("\n");
}

export default {
  async fetch(request, env) {
    if (request.method !== "POST") return new Response("ok", { status: 200 });

    // Nur echte Telegram-Aufrufe akzeptieren (Secret-Header, beim Webhook-Setup mitgegeben).
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

    // Solange OWNER_CHAT_ID noch nicht gesetzt ist: nur die eigene Chat-ID zurückgeben, nichts verarbeiten.
    if (!env.OWNER_CHAT_ID) {
      await sendTelegramMessage(env, chatId, `Setup: Deine Chat-ID ist ${chatId}. Bitte als OWNER_CHAT_ID-Secret im Worker hinterlegen.`);
      return new Response("ok", { status: 200 });
    }

    // Nachrichten von allen anderen Chats stillschweigend ignorieren.
    if (String(chatId) !== String(env.OWNER_CHAT_ID)) {
      return new Response("ok", { status: 200 });
    }

    const today = todayBerlin();
    let tasks;
    try {
      if (!env.ANTHROPIC_API_KEY) throw new Error("kein ANTHROPIC_API_KEY gesetzt");
      tasks = await splitTasksWithAI(env, text, today);
    } catch {
      tasks = splitTasksFallback(text, today); // Rückfall: einfache Textmuster statt KI
    }

    const items = tasks.map((t) => ({ id: crypto.randomUUID(), ...t, createdAt: new Date().toISOString() }));

    try {
      await appendPendingTasks(env, items);
      await sendTelegramMessage(env, chatId, buildReply(items, today));
    } catch (e) {
      await sendTelegramMessage(env, chatId, `⚠ Fehler beim Speichern: ${e.message}`);
    }

    return new Response("ok", { status: 200 });
  },
};
