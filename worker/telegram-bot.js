// ============================================================================
// worker/telegram-bot.js – Cloudflare Worker mit mehreren Aufgaben:
//
//  1) Telegram-Webhook (POST /): nimmt Nachrichten des Admins entgegen, lässt
//     Claude bestimmen was gewünscht ist (Aufgaben anlegen/löschen/als erledigt
//     markieren, aktuelle Liste zeigen, wer im Dienst ist) – arbeitet direkt auf
//     dem KV-Speicher, der IMMER aktuell ist, unabhängig davon ob das iPad an ist.
//  2) /state-Endpunkt (GET+POST): die App (js/taskSync.js) liest/schreibt hier
//     den aktuellen Stand (Aufgaben + wer im Dienst ist), um mit dem iPad abzugleichen.
//  3) /note-Endpunkt (POST): Mitarbeiter können darüber (aus ihrem Kiosk-Fenster)
//     eine kurze Notiz direkt an den Chef schicken (Telegram-Nachricht).
//  4) scheduled (Cron): schickt morgens/abends automatisch eine kurze Erinnerung,
//     falls Cron Triggers im Worker eingerichtet sind (optional, siehe README).
//
// Braucht eine an den Worker gebundene KV-Namespace mit dem Namen TASKS_KV
// (Cloudflare Dashboard → Worker → Settings → Bindings → KV-Namespace-Binding
// hinzufügen). Wird NICHT automatisch deployed – dieses Skript in einen
// Cloudflare Worker einfügen. Genaue Schritte: worker/README.md.
//
// Erwartete Secrets im Worker (Settings → Variables and Secrets):
//   TELEGRAM_BOT_TOKEN  – Token von @BotFather
//   WEBHOOK_SECRET      – frei erfundener String; dreifach genutzt: zur Prüfung des
//                          Telegram-Webhooks, als Zugriffsschlüssel für /state UND /note
//   OWNER_CHAT_ID       – Telegram-Chat-ID des Admins (anfangs leer lassen, siehe README)
//   ANTHROPIC_API_KEY   – API-Key von console.anthropic.com, fürs Verstehen der Nachrichten
// ============================================================================

const PRIORITIES = ["niedrig", "normal", "hoch"];
const STATE_KEY = "state";
const MORNING_HOUR = 8; // Europe/Berlin, Ortszeit
const EVENING_HOUR = 19; // Europe/Berlin, Ortszeit
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function todayBerlin() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}
function berlinHour() {
  return Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Berlin", hour: "2-digit", hour12: false }).format(new Date()));
}
function formatDateDe(iso) {
  const [y, m, d] = iso.split("-");
  return `${d}.${m}.${y}`;
}

async function getState(env) {
  const raw = await env.TASKS_KV.get(STATE_KEY);
  if (!raw) return { updatedAt: null, employees: [], tasks: [], shiftsInService: [] };
  try {
    const parsed = JSON.parse(raw);
    return {
      updatedAt: parsed.updatedAt || null,
      employees: Array.isArray(parsed.employees) ? parsed.employees : [],
      tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
      shiftsInService: Array.isArray(parsed.shiftsInService) ? parsed.shiftsInService : [],
    };
  } catch {
    return { updatedAt: null, employees: [], tasks: [], shiftsInService: [] };
  }
}
async function putState(env, employees, tasks, shiftsInService) {
  const current = await getState(env);
  await env.TASKS_KV.put(
    STATE_KEY,
    JSON.stringify({
      updatedAt: new Date().toISOString(),
      employees,
      tasks,
      shiftsInService: shiftsInService !== undefined ? shiftsInService : current.shiftsInService,
    })
  );
}

async function sendTelegramMessage(env, chatId, text) {
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  }).catch(() => {});
}

// ---------------------------------------------------------------------
// Claude entscheiden lassen, was die Nachricht will. Bekommt dafür den
// echten aktuellen Stand (aus dem KV-Speicher) als Kontext.
// ---------------------------------------------------------------------
async function interpretMessage(env, text, today, state) {
  const tool = {
    name: "handle_message",
    description: "Interpretiert eine Nachricht des Café-Betreibers ans Team-Aufgaben-System.",
    input_schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["add", "delete", "complete", "list", "who", "other"] },
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
        task_ids_to_delete: {
          type: "array",
          description: "Nur bei action=delete. IDs exakt aus der unten gelisteten aktuellen Aufgaben-Liste übernehmen.",
          items: { type: "string" },
        },
        task_ids_to_complete: {
          type: "array",
          description: "Nur bei action=complete. IDs exakt aus der unten gelisteten aktuellen Aufgaben-Liste übernehmen.",
          items: { type: "string" },
        },
      },
      required: ["action"],
    },
  };

  const taskLines = state.tasks.length
    ? state.tasks.map((t) => `- [${t.id}] ${t.date} · ${t.assignedToName || "Allgemein"} · ${t.done ? "erledigt" : "offen"}: ${t.text}`).join("\n")
    : "(aktuell keine)";

  const system = `Heute ist ${today} (Europe/Berlin). Bekannte aktive Mitarbeiter: ${state.employees.join(", ") || "(keine hinterlegt)"}.

Aktuelle Aufgaben (ab heute), zum Nachschlagen für "delete"/"complete"/"list":
${taskLines}

Bestimme die Absicht der Nachricht:
- "add": eine oder mehrere NEUE Aufgaben anlegen. Enthält die Nachricht mehrere Aufgaben oder mehrere Personen (getrennt durch "und", Komma, Zeilenumbruch, Aufzählung, mehrere Sätze), IMMER als mehrere einzelne Einträge in tasks_to_add auflisten – NIEMALS den ganzen Nachrichtentext als einen Eintrag kopieren oder mehrere Themen zusammenfassen. assignedToName nur setzen, wenn ein Name aus der Mitarbeiterliste eindeutig zuzuordnen ist. Wochentage/relative Angaben ("morgen", "Montag", ...) in ein absolutes Datum auflösen (nächstes Vorkommen ab heute).
- "delete": eine oder mehrere der oben gelisteten Aufgaben sollen komplett entfernt werden.
- "complete": eine oder mehrere der oben gelisteten (noch offenen) Aufgaben sind erledigt und sollen als erledigt markiert werden (z.B. "Kasse zählen ist erledigt", "hab die Vitrine geputzt") – NICHT löschen, nur abhaken.
- "list": der Nutzer will die aktuelle Aufgaben-Liste/Übersicht sehen.
- "who": der Nutzer will wissen, wer gerade im Café im Dienst ist (z.B. "wer ist da", "wer arbeitet gerade").
- "other": nichts davon eindeutig, z.B. Small Talk oder unklare Nachricht.
Bei "delete" und "complete" die [id] exakt aus der Liste oben in task_ids_to_delete bzw. task_ids_to_complete übernehmen, nur bei eindeutigen Treffern.`;

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

function buildListReply(state, today) {
  if (state.tasks.length === 0) return "📋 Aktuell keine Aufgaben hinterlegt.";
  const byDate = {};
  for (const t of state.tasks) (byDate[t.date] ||= []).push(t);
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
  if (state.updatedAt) {
    const t = new Date(state.updatedAt);
    lines.push(`\n(Stand: ${t.toLocaleDateString("de-DE")} ${t.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })} Uhr)`);
  }
  return lines.join("\n");
}

function buildAddReply(items, today) {
  const lines = items.map((item, i) => {
    const who = item.assignedToName || "Alle";
    const dateSuffix = item.date && item.date !== today ? ` · ${formatDateDe(item.date)}` : "";
    const prioSuffix = item.priority === "hoch" ? " · 🔴 hoch" : item.priority === "niedrig" ? " · 🔵 niedrig" : "";
    return `${i + 1}. ${who} – ${item.text}${dateSuffix}${prioSuffix}`;
  });
  const heading = items.length === 1 ? "✅ Notiert:" : `✅ ${items.length} Aufgaben notiert:`;
  return [heading, ...lines].join("\n");
}

function buildDeleteReply(removed) {
  if (removed.length === 0) return `Habe dazu keine passende Aufgabe in der aktuellen Liste gefunden. Schick mir „liste" für die Übersicht.`;
  const lines = removed.map((t) => `- ${t.assignedToName || "Allgemein"}: ${t.text}`);
  return ["🗑 Entfernt:", ...lines].join("\n");
}

function buildCompleteReply(completed) {
  if (completed.length === 0) return `Habe dazu keine passende offene Aufgabe gefunden. Schick mir „liste" für die Übersicht.`;
  const lines = completed.map((t) => `- ${t.assignedToName || "Allgemein"}: ${t.text}`);
  return ["✅ Als erledigt markiert:", ...lines].join("\n");
}

function buildWhoReply(state) {
  if (!state.shiftsInService || state.shiftsInService.length === 0) return "Aktuell ist niemand eingestempelt.";
  const lines = state.shiftsInService.map((s) => `- ${s.name} (seit ${s.since} Uhr)`);
  return ["👥 Im Dienst:", ...lines].join("\n");
}

async function handleTelegram(request, env) {
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
    const state = await getState(env);

    if (!env.ANTHROPIC_API_KEY) {
      await sendTelegramMessage(env, chatId, "⚠ ANTHROPIC_API_KEY fehlt im Worker – ich kann Nachrichten gerade nicht verstehen.");
      return new Response("ok", { status: 200 });
    }

    const result = await interpretMessage(env, text, today, state);

    if (result.action === "list") {
      await sendTelegramMessage(env, chatId, buildListReply(state, today));
    } else if (result.action === "who") {
      await sendTelegramMessage(env, chatId, buildWhoReply(state));
    } else if (result.action === "delete") {
      const ids = Array.isArray(result.task_ids_to_delete) ? result.task_ids_to_delete : [];
      const removed = state.tasks.filter((t) => ids.includes(t.id));
      if (removed.length > 0) {
        const remaining = state.tasks.filter((t) => !ids.includes(t.id));
        await putState(env, state.employees, remaining);
      }
      await sendTelegramMessage(env, chatId, buildDeleteReply(removed));
    } else if (result.action === "complete") {
      const ids = Array.isArray(result.task_ids_to_complete) ? result.task_ids_to_complete : [];
      const completed = state.tasks.filter((t) => ids.includes(t.id) && !t.done);
      if (completed.length > 0) {
        const updated = state.tasks.map((t) => (ids.includes(t.id) ? { ...t, done: true } : t));
        await putState(env, state.employees, updated);
      }
      await sendTelegramMessage(env, chatId, buildCompleteReply(completed));
    } else if (result.action === "add") {
      const newTasks = (Array.isArray(result.tasks_to_add) ? result.tasks_to_add : [])
        .map((t) => ({
          id: crypto.randomUUID(),
          date: /^\d{4}-\d{2}-\d{2}$/.test(t.targetDate) ? t.targetDate : today,
          text: String(t.text || "").trim(),
          assignedToName: t.assignedToName ? String(t.assignedToName).trim() : null,
          priority: PRIORITIES.includes(t.priority) ? t.priority : "normal",
          done: false,
        }))
        .filter((t) => t.text);
      if (newTasks.length === 0) {
        await sendTelegramMessage(env, chatId, "Konnte daraus keine Aufgabe erkennen. Magst du es anders formulieren?");
      } else {
        await putState(env, state.employees, [...state.tasks, ...newTasks]);
        await sendTelegramMessage(env, chatId, buildAddReply(newTasks, today));
      }
    } else {
      await sendTelegramMessage(
        env,
        chatId,
        `Das habe ich nicht eindeutig verstanden. Du kannst mir z.B. schreiben:\n„Anna soll die Kasse zählen"\n„liste"\n„wer ist da"\n„Kasse zählen ist erledigt"\n„lösch die Aufgabe Kasse zählen bei Anna"`
      );
    }
  } catch (e) {
    await sendTelegramMessage(env, chatId, `⚠ Fehler: ${e.message}`);
  }

  return new Response("ok", { status: 200 });
}

async function handleState(request, env) {
  const auth = request.headers.get("Authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "");
  if (!env.WEBHOOK_SECRET || token !== env.WEBHOOK_SECRET) {
    return new Response("forbidden", { status: 403, headers: CORS_HEADERS });
  }

  if (request.method === "GET") {
    const state = await getState(env);
    return new Response(JSON.stringify(state), { headers: { "Content-Type": "application/json", ...CORS_HEADERS } });
  }
  if (request.method === "POST") {
    let body;
    try {
      body = await request.json();
    } catch {
      return new Response("bad request", { status: 400, headers: CORS_HEADERS });
    }
    const employees = Array.isArray(body.employees) ? body.employees : [];
    const tasks = Array.isArray(body.tasks) ? body.tasks : [];
    const shiftsInService = Array.isArray(body.shiftsInService) ? body.shiftsInService : undefined;
    await putState(env, employees, tasks, shiftsInService);
    return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json", ...CORS_HEADERS } });
  }
  return new Response("method not allowed", { status: 405, headers: CORS_HEADERS });
}

/** Mitarbeiter schicken darüber (aus ihrem Kiosk-Fenster) eine kurze Notiz direkt an den Chef. */
async function handleNote(request, env) {
  const auth = request.headers.get("Authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "");
  if (!env.WEBHOOK_SECRET || token !== env.WEBHOOK_SECRET) {
    return new Response("forbidden", { status: 403, headers: CORS_HEADERS });
  }
  if (request.method !== "POST") return new Response("method not allowed", { status: 405, headers: CORS_HEADERS });

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response("bad request", { status: 400, headers: CORS_HEADERS });
  }
  const employeeName = String(body.employeeName || "Unbekannt").trim();
  const text = String(body.text || "").trim();
  if (!text) return new Response("bad request", { status: 400, headers: CORS_HEADERS });

  if (env.OWNER_CHAT_ID) {
    await sendTelegramMessage(env, env.OWNER_CHAT_ID, `📝 Notiz von ${employeeName}:\n${text}`);
  }
  return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json", ...CORS_HEADERS } });
}

/** Cron Trigger (optional, siehe README): morgens/abends eine kurze Erinnerung schicken. */
async function handleScheduled(env) {
  if (!env.OWNER_CHAT_ID) return;
  const hour = berlinHour();
  if (hour !== MORNING_HOUR && hour !== EVENING_HOUR) return;

  const today = todayBerlin();
  const state = await getState(env);
  const todaysTasks = state.tasks.filter((t) => t.date === today);
  const open = todaysTasks.filter((t) => !t.done);

  if (hour === MORNING_HOUR) {
    const text =
      todaysTasks.length === 0
        ? "☀️ Guten Morgen! Keine besonderen Aufgaben für heute hinterlegt."
        : `☀️ Guten Morgen! ${todaysTasks.length} Aufgabe(n) für heute, davon ${open.length} noch offen.\n\n${buildListReply({ ...state, tasks: todaysTasks }, today)}`;
    await sendTelegramMessage(env, env.OWNER_CHAT_ID, text);
  } else if (hour === EVENING_HOUR && open.length > 0) {
    const text = `🌙 Heute Abend noch offen (${open.length}):\n\n${buildListReply({ ...state, tasks: open }, today)}`;
    await sendTelegramMessage(env, env.OWNER_CHAT_ID, text);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/state") {
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
      return handleState(request, env);
    }
    if (url.pathname === "/note") {
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
      return handleNote(request, env);
    }

    if (request.method === "POST") return handleTelegram(request, env);
    return new Response("ok", { status: 200 });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(handleScheduled(env));
  },
};
