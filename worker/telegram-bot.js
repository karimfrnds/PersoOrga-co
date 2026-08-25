// ============================================================================
// worker/telegram-bot.js – Cloudflare Worker: nimmt Telegram-Nachrichten des
// Admins entgegen und legt sie als Aufgabe in data/pending-tasks.json im
// GitHub-Repo ab. Die App (js/taskSync.js) holt sie von dort ab.
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
// ============================================================================

const PENDING_PATH = "data/pending-tasks.json";
const MAX_PENDING_ITEMS = 50; // Sicherheitsnetz, falls die App mal länger nicht abruft

function utf8ToBase64(str) {
  return btoa(unescape(encodeURIComponent(str)));
}
function base64ToUtf8(b64) {
  return decodeURIComponent(escape(atob(b64)));
}

const WEEKDAYS = ["sonntag", "montag", "dienstag", "mittwoch", "donnerstag", "freitag", "samstag"]; // Index = JS getUTCDay()

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

/** Erkennt "heute"/"morgen"/"übermorgen" oder einen Wochentagsnamen irgendwo im Text -> Ziel-Datum (YYYY-MM-DD) oder null. */
function extractTargetDate(text) {
  const lower = text.toLowerCase();
  const today = todayBerlin();
  if (/\bheute\b/.test(lower)) return today;
  if (/\bübermorgen\b/.test(lower)) return addDaysISO(today, 2);
  if (/\bmorgen\b/.test(lower)) return addDaysISO(today, 1);
  for (let i = 0; i < WEEKDAYS.length; i++) {
    if (lower.includes(WEEKDAYS[i])) {
      const todayDow = new Date(today + "T12:00:00Z").getUTCDay();
      let diff = i - todayDow;
      if (diff < 0) diff += 7; // nächstes Vorkommen dieses Wochentags (heute zählt, falls Wochentag = heute)
      return addDaysISO(today, diff);
    }
  }
  return null;
}

function parseMessage(text) {
  const trimmed = text.trim();
  const targetDate = extractTargetDate(trimmed);
  // "Timm: Kasse nachzählen" oder "Timm - Kasse nachzählen"
  let m = trimmed.match(/^([\p{L} ]{1,30})\s*[:\-–]\s*(.+)$/su);
  if (m) return { assignedToName: m[1].trim(), text: m[2].trim(), targetDate };
  // "Arianna soll die Vitrine putzen" / "Anna soll dran denken, ..."
  m = trimmed.match(/^([\p{Lu}][\p{L}]*(?:\s[\p{Lu}][\p{L}]*)?)\s+soll\s+(.+)$/su);
  if (m) return { assignedToName: m[1].trim(), text: m[2].trim(), targetDate };
  return { assignedToName: null, text: trimmed, targetDate };
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

async function githubHeaders(env) {
  return {
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "PersoApp-Telegram-Worker",
  };
}

async function appendPendingTask(env, item) {
  const url = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${PENDING_PATH}`;
  const headers = await githubHeaders(env);

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

  items.push(item);
  if (items.length > MAX_PENDING_ITEMS) items = items.slice(items.length - MAX_PENDING_ITEMS);

  const putRes = await fetch(url, {
    method: "PUT",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({
      message: `Aufgabe per Telegram: ${item.text.slice(0, 60)}`,
      content: utf8ToBase64(JSON.stringify({ items })),
      ...(sha ? { sha } : {}),
    }),
  });
  if (!putRes.ok) throw new Error(`GitHub PUT ${putRes.status}`);
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

    const { assignedToName, text: taskText, targetDate } = parseMessage(text);
    const item = {
      id: crypto.randomUUID(),
      text: taskText,
      assignedToName,
      targetDate,
      createdAt: new Date().toISOString(),
    };

    try {
      await appendPendingTask(env, item);
      const today = todayBerlin();
      const dateSuffix = targetDate && targetDate !== today ? ` (${formatDateDe(targetDate)})` : "";
      const who = assignedToName ? ` für ${assignedToName}` : "";
      await sendTelegramMessage(env, chatId, `✅ Notiert${who}${dateSuffix}`);
    } catch (e) {
      await sendTelegramMessage(env, chatId, `⚠ Fehler beim Speichern: ${e.message}`);
    }

    return new Response("ok", { status: 200 });
  },
};
