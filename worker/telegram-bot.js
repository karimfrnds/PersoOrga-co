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
function addDaysISO(dateStr, n) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}
function mondayOf(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const day = dt.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day;
  dt.setUTCDate(dt.getUTCDate() + diff);
  return dt.toISOString().slice(0, 10);
}
/** Montag der Woche NACH der aktuellen – Default-Zielwoche für Wochenplan/Verfügbarkeit. */
function nextMondayFrom(dateStr) {
  return addDaysISO(mondayOf(dateStr), 7);
}
/** 0=Sonntag..6=Samstag, reiner Kalendertag (keine Zeitzonen-Feinheiten nötig). */
function weekdayOf(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}
const WEEKDAY_LABELS_DE = ["Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag", "Sonntag"];

/** Nachsichtiger Vergleich für Schicht-Namen, exakt wie js/taskSync.js normalizeSlotLabel() – nur damit der
 * Bot schon beim Absenden warnen kann, falls slotLabel nicht zu einer der bekannten Schichten passt (der
 * Worker kennt die Zeiten selbst nicht, aber die 5 möglichen Namen sind fix genug für diese Vorprüfung).
 * MUSS bei Änderungen synchron zu js/taskSync.js normalizeSlotLabel() bleiben. */
function normalizeSlotLabelCheck(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .replace(/[^a-z0-9]/g, "");
}
const KNOWN_SLOT_LABELS = new Set(["Früh1", "Früh2", "Mittel", "Spät1", "Spät2"].map(normalizeSlotLabelCheck));
const REMINDER_WEEKDAY = 5; // Freitag – Erinnerung an alle, die für nächste Woche noch nichts eingetragen haben
/** Wandelt ein per Telegram heruntergeladenes Foto (ArrayBuffer) in Base64 um, für die Anthropic Vision-API.
 * In Chunks, damit String.fromCharCode bei großen Fotos nicht am Funktions-Argument-Limit scheitert. */
function arrayBufferToBase64(buffer) {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function euro(n) {
  return (Number(n) || 0).toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " €";
}
function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

const EMPTY_STATE = {
  updatedAt: null,
  employees: [],
  tasks: [],
  shiftsInService: [],
  financials: [],
  plannedShifts: [],
  availability: {},
  employeeMessages: [],
  shiftRejections: [],
  employeeMeta: [], // [{name, isMinijob, minijobLimit}] – nur für die Minijob-Grenzen-Warnung
  staleOpenShifts: [], // [{date, employeeName, from}] – vergessenes Ausstempeln
  stock: [], // [{name, status}] – Vorräte-Ampel
  stockRestocks: [], // [{id, itemName}] – Chef sagt per Bot "X ist wieder da"
  stockDeliveries: [], // [{id, itemName, quantity, unit, date}] – per Lieferschein-Foto erkannte Lieferungen
  stockSales: [], // [{id, productName, quantitySold, date}] – per SumUp-Verkaufsbericht-Foto erkannte Verkäufe
  employeeNotes: [], // [{id, date, employeeName, text}] – gesammelte Mitarbeiter-Notizen, per "nachrichten" abrufbar
  minijobWarned: {}, // "YYYY-MM:Name" -> true, verhindert tägliches Wiederholen derselben Warnung
  staleShiftWarned: {}, // "YYYY-MM-DD:Name" -> true, dito für vergessenes Ausstempeln
};

async function getState(env) {
  const raw = await env.TASKS_KV.get(STATE_KEY);
  if (!raw) return { ...EMPTY_STATE };
  try {
    const parsed = JSON.parse(raw);
    return {
      updatedAt: parsed.updatedAt || null,
      employees: Array.isArray(parsed.employees) ? parsed.employees : [],
      tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
      shiftsInService: Array.isArray(parsed.shiftsInService) ? parsed.shiftsInService : [],
      financials: Array.isArray(parsed.financials) ? parsed.financials : [],
      plannedShifts: Array.isArray(parsed.plannedShifts) ? parsed.plannedShifts : [],
      availability: parsed.availability && typeof parsed.availability === "object" ? parsed.availability : {},
      employeeMessages: Array.isArray(parsed.employeeMessages) ? parsed.employeeMessages : [],
      shiftRejections: Array.isArray(parsed.shiftRejections) ? parsed.shiftRejections : [],
      employeeMeta: Array.isArray(parsed.employeeMeta) ? parsed.employeeMeta : [],
      staleOpenShifts: Array.isArray(parsed.staleOpenShifts) ? parsed.staleOpenShifts : [],
      stock: Array.isArray(parsed.stock) ? parsed.stock : [],
      stockRestocks: Array.isArray(parsed.stockRestocks) ? parsed.stockRestocks : [],
      stockDeliveries: Array.isArray(parsed.stockDeliveries) ? parsed.stockDeliveries : [],
      stockSales: Array.isArray(parsed.stockSales) ? parsed.stockSales : [],
      employeeNotes: Array.isArray(parsed.employeeNotes) ? parsed.employeeNotes : [],
      minijobWarned: parsed.minijobWarned && typeof parsed.minijobWarned === "object" ? parsed.minijobWarned : {},
      staleShiftWarned: parsed.staleShiftWarned && typeof parsed.staleShiftWarned === "object" ? parsed.staleShiftWarned : {},
    };
  } catch {
    return { ...EMPTY_STATE };
  }
}
/** Schreibt nur die übergebenen Felder, alles andere bleibt unverändert (Merge auf den aktuellen Stand). */
async function patchState(env, patch) {
  const current = await getState(env);
  const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
  await env.TASKS_KV.put(STATE_KEY, JSON.stringify(next));
  return next;
}

/** Merged die Einträge EINER Zielwoche in die bestehende Verfügbarkeit ein (App-Sync nach Chef-Zuweisung/
 * -Ablehnung, damit "wer kann wann" aktuell bleibt) – überschreibt nur die genannten Personen dieser einen
 * Woche, lässt andere Wochen und das notifiedComplete-Flag (steuert die "alle da"-Meldung) unangetastet. */
function mergeAvailabilityWeek(currentAvailability, weekStart, entries) {
  const bucket = currentAvailability[weekStart] || { entries: {}, notifiedComplete: false };
  const nextBucket = { ...bucket, entries: { ...bucket.entries, ...entries } };
  return { ...currentAvailability, [weekStart]: nextBucket };
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
        action: {
          type: "string",
          enum: ["add", "delete", "complete", "list", "who", "stats", "availability", "plan_shifts", "reject_shift", "notify", "stock_list", "restock", "notes", "other"],
        },
        stats_period: {
          type: "string",
          enum: ["today", "yesterday", "week", "lastweek", "month"],
          description: "Nur bei action=stats: welcher Zeitraum gewünscht ist. Ohne klaren Hinweis: 'today'.",
        },
        stats_employee_name: {
          type: "string",
          description:
            "Nur bei action=stats: Name der Person aus der Mitarbeiterliste, falls sich die Frage auf eine bestimmte Person bezieht (z.B. 'wie viele Stunden hat Anna diese Woche gemacht'). Sonst leerer String für die Gesamt-Kennzahlen des Cafés.",
        },
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
        shifts_to_add: {
          type: "array",
          description: "Nur bei action=plan_shifts. Jede einzelne geplante Schicht als eigener Eintrag, niemals mehrere Personen/Tage zusammenfassen.",
          items: {
            type: "object",
            properties: {
              employeeName: { type: "string", description: "Name der Person, muss zu einem der unten genannten aktiven Mitarbeiter passen." },
              date: { type: "string", description: "Datum YYYY-MM-DD, aus Wochentag/Datum relativ zur unten genannten Zielwoche aufgelöst." },
              slotLabel: {
                type: "string",
                enum: ["", "Früh1", "Früh2", "Mittel", "Spät1", "Spät2"],
                description:
                  "Bevorzugt: Name der Schicht wie sie die Mitarbeiter im Kiosk sehen, falls der Chef so eine benennt (z.B. 'Anna bekommt Montag Früh1'). Dann from/to leer lassen. Muss EXAKT einer dieser Werte sein, keine Abwandlung – sonst leerer String und stattdessen from/to nutzen.",
              },
              from: { type: "string", description: "Nur falls KEIN slotLabel genannt wurde und stattdessen eine konkrete Uhrzeit: Beginn HH:MM." },
              to: { type: "string", description: "Nur falls KEIN slotLabel genannt wurde: Ende HH:MM." },
            },
            required: ["employeeName", "date"],
          },
        },
        messages_to_send: {
          type: "array",
          description:
            "Nur bei action=notify. Jede Nachricht an eine Person als eigener Eintrag, auch bei mehreren Empfängern (z.B. bei 'sag allen...' für jede bekannte aktive Person einen Eintrag).",
          items: {
            type: "object",
            properties: {
              employeeName: { type: "string", description: "Name der Person aus der Mitarbeiterliste." },
              text: { type: "string", description: "Der Nachrichtentext, so wie er der Person angezeigt werden soll (kurz, klar, auf Deutsch)." },
            },
            required: ["employeeName", "text"],
          },
        },
        shifts_to_reject: {
          type: "array",
          description: "Nur bei action=reject_shift. Jede abgelehnte Schicht als eigener Eintrag.",
          items: {
            type: "object",
            properties: {
              employeeName: { type: "string", description: "Name der Person aus der Mitarbeiterliste." },
              date: { type: "string", description: "Datum YYYY-MM-DD, aus Wochentag/Datum relativ zur oben genannten Zielwoche aufgelöst." },
              slotLabel: {
                type: "string",
                enum: ["Früh1", "Früh2", "Mittel", "Spät1", "Spät2"],
                description: "Name der Schicht wie im Kiosk. Muss EXAKT einer dieser Werte sein.",
              },
            },
            required: ["employeeName", "date", "slotLabel"],
          },
        },
        items_to_restock: {
          type: "array",
          description: "Nur bei action=restock. Jeder wieder aufgefüllte Artikel als eigener Eintrag, auch bei mehreren auf einmal.",
          items: {
            type: "object",
            properties: {
              itemName: { type: "string", description: "Name des Artikels, wie ihn der Chef genannt hat (muss nicht exakt zur Liste passen)." },
            },
            required: ["itemName"],
          },
        },
      },
      required: ["action"],
    },
  };

  const taskLines = state.tasks.length
    ? state.tasks.map((t) => `- [${t.id}] ${t.date} · ${t.assignedToName || "Allgemein"} · ${t.done ? "erledigt" : "offen"}: ${t.text}`).join("\n")
    : "(aktuell keine)";

  const nextWeekStart = nextMondayFrom(today);
  const nextWeekEnd = addDaysISO(nextWeekStart, 6);
  const system = `Heute ist ${today} (Europe/Berlin). Bekannte aktive Mitarbeiter: ${state.employees.join(", ") || "(keine hinterlegt)"}.

Die nächste Woche (Ziel für Wochenplan und Verfügbarkeits-Fragen) beginnt am ${nextWeekStart} (Montag) und endet am
${nextWeekEnd} (Sonntag). Wochentage im Zusammenhang mit Schichtplan/Verfügbarkeit beziehen sich per Default auf
diese Woche, außer ein anderer Zeitraum ist klar genannt.

Aktuelle Aufgaben (ab heute), zum Nachschlagen für "delete"/"complete"/"list":
${taskLines}

Bestimme die Absicht der Nachricht:
- "add": eine oder mehrere NEUE Aufgaben anlegen. Enthält die Nachricht mehrere Aufgaben oder mehrere Personen (getrennt durch "und", Komma, Zeilenumbruch, Aufzählung, mehrere Sätze), IMMER als mehrere einzelne Einträge in tasks_to_add auflisten – NIEMALS den ganzen Nachrichtentext als einen Eintrag kopieren oder mehrere Themen zusammenfassen. assignedToName nur setzen, wenn ein Name aus der Mitarbeiterliste eindeutig zuzuordnen ist. Wochentage/relative Angaben ("morgen", "Montag", ...) in ein absolutes Datum auflösen (nächstes Vorkommen ab heute).
- "delete": eine oder mehrere der oben gelisteten Aufgaben sollen komplett entfernt werden.
- "complete": eine oder mehrere der oben gelisteten (noch offenen) Aufgaben sind erledigt und sollen als erledigt markiert werden (z.B. "Kasse zählen ist erledigt", "hab die Vitrine geputzt") – NICHT löschen, nur abhaken.
- "list": der Nutzer will die aktuelle Aufgaben-Liste/Übersicht sehen.
- "who": der Nutzer will wissen, wer gerade im Café im Dienst ist (z.B. "wer ist da", "wer arbeitet gerade").
- "stats": der Nutzer will Kennzahlen/Zusammenfassung (Umsatz, Lohnkosten, Stunden, Umschlag) sehen, z.B. "wie war der Umsatz heute", "kennzahlen", "wie lief die Woche", "wie war letzte Woche", "Zusammenfassung diesen Monat". stats_period entsprechend setzen (lastweek = die Woche VOR der aktuellen). Bezieht sich die Frage auf eine einzelne Person und deren Arbeitsstunden/Lohn (z.B. "wie viele Stunden hat Anna diese Woche gemacht", "was hat Timm im August gearbeitet"), zusätzlich stats_employee_name auf den erkannten Namen setzen.
- "stock_list": der Chef will wissen, was an Vorräten fehlt oder knapp ist, z.B. "was fehlt", "einkaufsliste", "was müssen wir nachkaufen".
- "restock": der Chef meldet, dass ein oder mehrere Artikel wieder aufgefüllt/vorhanden sind, z.B. "Kaffeebohnen sind wieder da", "Milch und Servietten sind nachgefüllt" (zwei Einträge in items_to_restock).
- "notes": der Chef will die gesammelten Mitarbeiter-Notizen sehen, z.B. "nachrichten", "was haben die Mitarbeiter geschrieben", "zeig mir die Notizen".
- "plan_shifts": der Chef legt fest, wer wann arbeitet – entweder den ganzen Wochenplan auf einmal ("Wochenplan: Montag Anna 10-18, Dienstag Timm 9-17") oder gezielt EINER Person eine ihrer gemeldeten Verfügbarkeiten zuweisen ("Anna bekommt Montag Früh1", "Timm soll Mittwoch die Spät2 machen"). Nennt der Chef den Schicht-NAMEN statt einer Uhrzeit, slotLabel setzen und from/to leer lassen – slotLabel MUSS exakt einer dieser fünf Werte sein: "Früh1", "Früh2", "Mittel", "Spät1", "Spät2" (keine anderen Varianten, keine Uhrzeiten, keine Rollenbezeichnung erfinden – bei Unsicherheit lieber nachfragen als raten) – das sorgt dafür, dass die Zuweisung korrekt mit der Verfügbarkeits-Auswahl der Person verrechnet wird (inkl. Ausgrauen für andere). Nur bei expliziter Uhrzeitangabe from/to statt slotLabel nutzen. "Mittel"-Schichten werden NIE automatisch bestätigt, egal was die Person ausgewählt hat – wenn der Chef eine Bestätigung ausspricht ("bestätige Annas Mittel-Schicht am Montag", "Anna bekommt Montag Mittel"), ganz normal als plan_shifts mit slotLabel="Mittel" behandeln, das markiert sie dann als bestätigt. IMMER jede einzelne Schicht als eigenen Eintrag in shifts_to_add auflisten, niemals mehrere zusammenfassen. Wochentage ohne explizites Datum beziehen sich auf die oben genannte Zielwoche.
- "availability": der Chef will die gesammelten Verfügbarkeiten der Mitarbeiter für die kommende Woche sehen, z.B. "wer kann wann", "verfügbarkeiten", "wie sieht die Verfügbarkeit für nächste Woche aus".
- "reject_shift": der Chef lehnt eine gemeldete oder bereits gehaltene Schicht einer Person ab, z.B. "lehn Annas Mittel-Schicht am Montag ab", "Anna kann die Spät2 am Mittwoch nicht bekommen", "Timms Früh1 am Montag geht nicht". Person bekommt die Schicht entzogen (bei anderen wieder frei) und eine Nachricht, dass sie sich neu entscheiden muss.
- "notify": der Chef will einer oder mehreren Personen eine freie Nachricht schicken, die im Kiosk als Pop-up erscheint, z.B. "Sag Anna, sie soll morgen 30 Min früher kommen", "Schreib Timm: Danke für die Vertretung gestern!", "Richte allen aus, dass am Montag Inventur ist" (dann für JEDE bekannte aktive Person einen eigenen Eintrag in messages_to_send anlegen). IMMER jede Nachricht als eigenen Eintrag, auch bei mehreren Empfängern.
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

function buildPlanShiftsReply(items) {
  const lines = items.map((s, i) => `${i + 1}. ${s.employeeName} – ${formatDateDe(s.date)} · ${s.slotLabel || `${s.from}-${s.to}`}`);
  const heading = items.length === 1 ? "✅ Schicht eingetragen:" : `✅ ${items.length} Schichten eingetragen:`;
  return [heading, ...lines].join("\n");
}

function buildNotifyReply(items) {
  const lines = items.map((m, i) => `${i + 1}. ${m.employeeName}: „${m.text}"`);
  const heading = items.length === 1 ? "✅ Wird zugestellt, sobald sich die Person im Kiosk anmeldet:" : `✅ ${items.length} Nachrichten werden zugestellt:`;
  return [heading, ...lines].join("\n");
}

function buildRejectReply(items) {
  const lines = items.map((r, i) => `${i + 1}. ${r.employeeName} – ${formatDateDe(r.date)} · ${r.slotLabel}`);
  const heading = items.length === 1 ? "❌ Abgelehnt:" : `❌ ${items.length} Schichten abgelehnt:`;
  return [heading, ...lines].join("\n");
}

function buildStockListReply(state) {
  const stock = state.stock || [];
  const missing = stock.filter((s) => s.status !== "ok");
  if (missing.length === 0) return "✅ Laut Kiosk ist aktuell alles ausreichend vorhanden.";
  const leer = missing.filter((s) => s.status === "leer");
  const knapp = missing.filter((s) => s.status === "knapp");
  const lines = ["🛒 Einkaufsliste:"];
  if (leer.length > 0) lines.push(`Leer: ${leer.map((s) => s.name).join(", ")}`);
  if (knapp.length > 0) lines.push(`Wird knapp: ${knapp.map((s) => s.name).join(", ")}`);
  return lines.join("\n");
}

function buildRestockReply(items) {
  const lines = items.map((i, idx) => `${idx + 1}. ${i.itemName}`);
  const heading = items.length === 1 ? "✅ Als wieder aufgefüllt markiert:" : `✅ ${items.length} Artikel als wieder aufgefüllt markiert:`;
  return [heading, ...lines].join("\n");
}

function buildDeliveryReply(items) {
  const lines = items.map((it, i) => `${i + 1}. ${it.itemName} – ${it.quantity != null ? `${it.quantity} ${it.unit || ""}`.trim() : "(Menge unklar)"}`);
  const heading = items.length === 1 ? "📦 Lieferung erkannt und geloggt:" : `📦 ${items.length} Artikel erkannt und geloggt:`;
  return [heading, ...lines].join("\n");
}

function buildSalesReply(items) {
  const lines = items.map((it, i) => `${i + 1}. ${it.productName} – ${it.quantitySold}x`);
  const heading = items.length === 1 ? "🧾 Verkauf erkannt und mit dem Bestand verrechnet:" : `🧾 ${items.length} Produkte erkannt und mit dem Bestand verrechnet:`;
  return [heading, ...lines].join("\n");
}

/** Liest ein Foto per Claude Vision aus und erkennt dabei selbst, ob es ein Lieferschein/eine Rechnung
 * (gelieferte Artikel + Menge) oder ein SumUp-Verkaufsbericht (verkaufte Produkte + Anzahl) ist. Wirft bei
 * echten Fehlern (Anthropic nicht erreichbar o.ä.). */
async function extractStockDocument(env, imageBase64, mimeType, caption, today) {
  const tool = {
    name: "extract_stock_document",
    description:
      "Erkennt die Art eines Beleg-Fotos (Lieferschein/Rechnung ODER SumUp-Verkaufsbericht) und extrahiert die jeweils relevanten Positionen.",
    input_schema: {
      type: "object",
      properties: {
        documentType: {
          type: "string",
          enum: ["lieferschein", "verkaufsbericht"],
          description: "'lieferschein' für Lieferschein/Rechnung (Wareneingang), 'verkaufsbericht' für einen SumUp-Verkaufs-/Kassenbericht (Warenausgang).",
        },
        items: {
          type: "array",
          description: "Nur tatsächlich auf dem Beleg erkennbare Positionen, nichts erfinden.",
          items: {
            type: "object",
            properties: {
              itemName: { type: "string", description: "Nur bei documentType=lieferschein: Artikelname, wie auf dem Beleg (kurz, ohne Mengenangabe)." },
              quantity: { type: "number", description: "Nur bei documentType=lieferschein: gelieferte Menge als Zahl (z.B. 5, 2, 10)." },
              unit: { type: "string", description: "Nur bei documentType=lieferschein: Einheit der Menge, z.B. 'kg', 'l', 'Stück', 'Kisten'." },
              productName: { type: "string", description: "Nur bei documentType=verkaufsbericht: Produktname, wie im Bericht (z.B. 'Cappuccino')." },
              quantitySold: { type: "number", description: "Nur bei documentType=verkaufsbericht: verkaufte Anzahl als Zahl." },
            },
          },
        },
        date: { type: "string", description: "Datum auf dem Beleg als YYYY-MM-DD, falls erkennbar, sonst leerer String." },
      },
      required: ["documentType", "items"],
    },
  };
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1536,
      tools: [tool],
      tool_choice: { type: "tool", name: "extract_stock_document" },
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mimeType, data: imageBase64 } },
            {
              type: "text",
              text: `Heute ist ${today} (Europe/Berlin). Das ist ein Foto für ein Café: entweder ein Lieferschein/eine Rechnung (Wareneingang) oder ein SumUp-Verkaufs-/Kassenbericht (Warenausgang, zeigt verkaufte Produkte mit Stückzahl).${
                caption ? ` Nachricht des Chefs dazu: "${caption}".` : ""
              } Bestimme zuerst documentType, extrahiere dann die passenden Positionen.`,
            },
          ],
        },
      ],
    }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Anthropic API ${res.status}${errText ? ": " + errText.slice(0, 300) : ""}`);
  }
  const data = await res.json();
  const toolUse = (data.content || []).find((b) => b.type === "tool_use");
  if (!toolUse?.input) throw new Error("Konnte den Beleg nicht auswerten.");
  return toolUse.input;
}

/** Lädt das größte verfügbare Foto einer Telegram-Nachricht herunter, lässt es per Vision auswerten und
 * verarbeitet es je nach erkanntem Dokument-Typ als Lieferung (Bestand rauf) oder Verkaufsbericht (Bestand
 * über die Rezept-Zutaten runter). */
async function handleStockPhoto(env, chatId, photoSizes, caption, today, state) {
  try {
    const largest = photoSizes[photoSizes.length - 1]; // Telegram sortiert aufsteigend nach Auflösung
    const fileRes = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getFile?file_id=${largest.file_id}`);
    const fileData = await fileRes.json();
    const filePath = fileData?.result?.file_path;
    if (!filePath) throw new Error("Konnte das Foto nicht von Telegram laden.");
    const imgRes = await fetch(`https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${filePath}`);
    if (!imgRes.ok) throw new Error("Konnte das Foto nicht herunterladen.");
    const buffer = await imgRes.arrayBuffer();
    const base64 = arrayBufferToBase64(buffer);
    const mimeType = filePath.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg";

    const extracted = await extractStockDocument(env, base64, mimeType, caption, today);
    const date = /^\d{4}-\d{2}-\d{2}$/.test(extracted.date) ? extracted.date : today;

    if (extracted.documentType === "verkaufsbericht") {
      const items = (Array.isArray(extracted.items) ? extracted.items : [])
        .map((it) => ({ id: crypto.randomUUID(), productName: String(it.productName || "").trim(), quantitySold: Number(it.quantitySold) || 0, date }))
        .filter((it) => it.productName && it.quantitySold > 0);
      if (items.length === 0) {
        await sendTelegramMessage(env, chatId, "Konnte im Verkaufsbericht keine Produkte erkennen.");
        return;
      }
      await patchState(env, { stockSales: [...(state.stockSales || []), ...items] });
      await sendTelegramMessage(env, chatId, buildSalesReply(items));
    } else {
      const items = (Array.isArray(extracted.items) ? extracted.items : [])
        .map((it) => ({
          id: crypto.randomUUID(),
          itemName: String(it.itemName || "").trim(),
          quantity: Number.isFinite(Number(it.quantity)) ? Number(it.quantity) : null,
          unit: String(it.unit || "").trim(),
          date,
        }))
        .filter((it) => it.itemName);

      if (items.length === 0) {
        await sendTelegramMessage(env, chatId, "Konnte auf dem Foto keine Artikel erkennen. Ist es ein Lieferschein/eine Rechnung?");
        return;
      }

      await patchState(env, { stockDeliveries: [...(state.stockDeliveries || []), ...items] });

      const stock = state.stock || [];
      const unresolved = items.filter((it) => {
        const needle = it.itemName.toLowerCase();
        return !stock.some((s) => s.name.trim().toLowerCase() === needle || s.name.trim().toLowerCase().includes(needle));
      });
      let reply = buildDeliveryReply(items);
      if (unresolved.length > 0) {
        reply += `\n\n⚠ Diese Artikel kenne ich nicht aus der Vorräte-Liste (Admin → Vorräte), bitte manuell prüfen: ${unresolved.map((it) => it.itemName).join(", ")}`;
      }
      await sendTelegramMessage(env, chatId, reply);
    }
  } catch (e) {
    await sendTelegramMessage(env, chatId, `⚠ Fehler beim Verarbeiten des Fotos: ${e.message}`);
  }
}

/** Zeigt, wer sich für welche Schicht an welchem Tag der Zielwoche bereit erklärt hat (keine Buchung –
 * mehrere Namen pro Schicht möglich, der Chef wählt selbst aus), plus wer noch gar nichts eingetragen hat. */
function buildAvailabilityReply(state, today) {
  const weekStart = nextMondayFrom(today);
  const activeNames = state.employees || [];
  const bucket = (state.availability || {})[weekStart];
  const entries = bucket?.entries || {};
  const submittedNames = Object.keys(entries);
  if (submittedNames.length === 0) {
    return `Für die Woche ab ${formatDateDe(weekStart)} hat noch niemand seine Verfügbarkeit eingetragen.`;
  }
  const lines = [`📅 Verfügbarkeit ab ${formatDateDe(weekStart)}:`];
  for (let i = 0; i < 7; i++) {
    const date = addDaysISO(weekStart, i);
    // slotId -> { label, from, to, names[] } – Reihenfolge/Zeiten kommen direkt aus den Einreichungen,
    // der Worker kennt die Schicht-Definitionen selbst nicht (die leben nur in der App).
    const slots = new Map();
    for (const name of submittedNames) {
      const dayEntry = (entries[name].days || []).find((d) => d.date === date);
      for (const s of dayEntry?.slots || []) {
        if (!slots.has(s.id)) slots.set(s.id, { label: s.label, from: s.from, to: s.to, names: [] });
        const isConfirmedHere = dayEntry.confirmedSlotId === s.id;
        const marker = !isConfirmedHere ? "" : dayEntry.bossConfirmed ? " ✅fest" : " 🔶wartet auf Bestätigung";
        slots.get(s.id).names.push(`${name}${marker}`);
      }
    }
    lines.push(`\n${WEEKDAY_LABELS_DE[i]}, ${formatDateDe(date)}:`);
    if (slots.size === 0) {
      lines.push("  – niemand bereit gemeldet –");
    } else {
      for (const s of slots.values()) {
        lines.push(`  ${s.label} (${s.from}-${s.to}): ${s.names.join(", ")}`);
      }
    }
  }
  const missing = activeNames.filter((n) => !submittedNames.includes(n));
  if (missing.length > 0) lines.push(`\n⚠ Noch offen: ${missing.join(", ")}`);
  return lines.join("\n");
}

function periodRange(period, today) {
  if (period === "yesterday") {
    const d = addDaysISO(today, -1);
    return { from: d, to: d };
  }
  if (period === "week") return { from: mondayOf(today), to: today };
  if (period === "lastweek") {
    const thisMonday = mondayOf(today);
    return { from: addDaysISO(thisMonday, -7), to: addDaysISO(thisMonday, -1) };
  }
  if (period === "month") return { from: today.slice(0, 7) + "-01", to: today };
  return { from: today, to: today };
}
const PERIOD_LABEL = { today: "Heute", yesterday: "Gestern", week: "Diese Woche", lastweek: "Letzte Woche", month: "Dieser Monat" };

function buildEmployeeStatsReply(rows, employeeName, label, allFinancials) {
  const needle = employeeName.trim().toLowerCase();
  let hours = 0;
  let lohn = 0;
  let lohnnebenkosten = 0;
  let days = 0;
  let matchedName = null;
  for (const r of rows) {
    for (const pe of r.perEmployee || []) {
      if (pe.name.trim().toLowerCase() === needle) {
        hours += Number(pe.hours) || 0;
        lohn += Number(pe.lohn) || 0;
        lohnnebenkosten += Number(pe.lohnnebenkosten) || 0;
        days++;
        matchedName = pe.name;
      }
    }
  }
  if (!matchedName) {
    const knownNames = new Set();
    for (const r of allFinancials) for (const pe of r.perEmployee || []) knownNames.add(pe.name);
    if (![...knownNames].some((n) => n.toLowerCase() === needle)) {
      return `Kenne niemanden namens "${employeeName}" in den Kennzahlen der letzten Wochen.`;
    }
    return `${label}: ${employeeName} hat in diesem Zeitraum keine Stunden erfasst.`;
  }
  hours = round2(hours);
  lohn = round2(lohn);
  lohnnebenkosten = round2(lohnnebenkosten);
  return [
    `📊 ${label} – ${matchedName}`,
    `Stunden: ${hours.toFixed(2).replace(".", ",")} h`,
    `Lohn: ${euro(lohn)}`,
    `Lohnnebenkosten (Arbeitgeber, geschätzt): ${euro(lohnnebenkosten)}`,
    `Lohnkosten gesamt: ${euro(round2(lohn + lohnnebenkosten))}`,
    `(${days} Tag${days === 1 ? "" : "e"} mit Schicht)`,
  ].join("\n");
}

function buildStatsReply(state, period, today, employeeName) {
  const financials = state.financials || [];
  if (financials.length === 0) {
    return `Noch keine Kennzahlen freigegeben oder synchronisiert. Unter Admin → Einstellungen bei „Telegram-Aufgaben abgleichen" die Kennzahlen-Freigabe aktivieren, danach einmal die App öffnen.`;
  }
  const { from, to } = periodRange(period, today);
  const rows = financials.filter((r) => r.date >= from && r.date <= to);
  const label = PERIOD_LABEL[period] || "Heute";
  if (employeeName) return buildEmployeeStatsReply(rows, employeeName, label, financials);
  if (rows.length === 0) {
    return `${label}: für diesen Zeitraum liegen noch keine Daten vor (letzter Abgleich: ${financials[financials.length - 1]?.date || "-"}).`;
  }
  const sum = (key) => round2(rows.reduce((s, r) => s + (Number(r[key]) || 0), 0));
  const umsatz = sum("umsatzGesamt");
  const lohn = sum("totalLohn");
  const lohnnebenkosten = sum("totalLohnnebenkosten");
  const lohnGesamt = round2(lohn + lohnnebenkosten);
  const stunden = sum("totalHours");
  const umschlag = sum("umschlag");
  const trinkgeld = sum("trinkgeldGesamt");
  const lohnquote = umsatz > 0 ? round2((lohnGesamt / umsatz) * 100) : 0;
  const openNote = rows.some((r) => r.status !== "abgeschlossen") ? " (inkl. heute, noch nicht final abgeschlossen)" : "";

  return [
    `📊 ${label}${openNote}`,
    `Umsatz: ${euro(umsatz)}`,
    `Trinkgeld: ${euro(trinkgeld)}`,
    `Lohn: ${euro(lohn)}`,
    `Lohnnebenkosten (Arbeitgeber, geschätzt): ${euro(lohnnebenkosten)}`,
    `Lohnkosten gesamt: ${euro(lohnGesamt)} (${String(lohnquote).replace(".", ",")}% vom Umsatz)`,
    `Stunden: ${stunden.toFixed(2).replace(".", ",")} h`,
    `Umschlag: ${euro(umschlag)}`,
  ].join("\n");
}

/** Kurze, rein datenbasierte Beobachtungen (keine Finanz-/Steuerberatung) – optional, wenn genug Historie da ist. */
async function generateInsights(env, financials) {
  if (!Array.isArray(financials) || financials.length < 3 || !env.ANTHROPIC_API_KEY) return null;
  const recent = financials.slice(-14);
  const lines = recent
    .map(
      (r) =>
        `${r.date}: Umsatz ${round2(r.umsatzGesamt)}€, Lohn ${round2(r.totalLohn)}€, Stunden ${round2(r.totalHours)}h, Umschlag ${round2(r.umschlag)}€${
          r.status !== "abgeschlossen" ? " (offen)" : ""
        }`
    )
    .join("\n");
  const prompt = `Tageszahlen eines Cafés, letzte ${recent.length} Tage:\n${lines}\n\nGib 2-3 kurze, konkrete Beobachtungen auf Deutsch (z.B. Muster nach Wochentag, Lohnquote im Verhältnis zum Umsatz, auffällige Tage/Trends). Nur was aus den Zahlen tatsächlich erkennbar ist, nichts erfinden. Keine Finanz-, Steuer- oder Rechtsberatung, nur nüchterne Beobachtungen. Je Punkt maximal ein Satz, als Aufzählung mit "-", ohne Einleitung.`;
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 400, messages: [{ role: "user", content: prompt }] }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const block = (data.content || []).find((b) => b.type === "text");
    return block?.text?.trim() || null;
  } catch {
    return null;
  }
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
  const photo = Array.isArray(message?.photo) && message.photo.length > 0 ? message.photo : null;
  const chatId = message?.chat?.id;
  if ((!text && !photo) || chatId === undefined) return new Response("ok", { status: 200 });

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
      await sendTelegramMessage(env, chatId, "⚠ ANTHROPIC_API_KEY fehlt im Worker – ich kann Nachrichten/Fotos gerade nicht verstehen.");
      return new Response("ok", { status: 200 });
    }

    if (photo) {
      await handleStockPhoto(env, chatId, photo, message.caption, today, state);
      return new Response("ok", { status: 200 });
    }

    const result = await interpretMessage(env, text, today, state);

    if (result.action === "list") {
      await sendTelegramMessage(env, chatId, buildListReply(state, today));
    } else if (result.action === "who") {
      await sendTelegramMessage(env, chatId, buildWhoReply(state));
    } else if (result.action === "stats") {
      const period = ["today", "yesterday", "week", "lastweek", "month"].includes(result.stats_period) ? result.stats_period : "today";
      const employeeName = result.stats_employee_name ? String(result.stats_employee_name).trim() : "";
      let reply = buildStatsReply(state, period, today, employeeName);
      if (!employeeName) {
        const insights = await generateInsights(env, state.financials);
        if (insights) reply += `\n\n💡 ${insights}`;
      }
      await sendTelegramMessage(env, chatId, reply);
    } else if (result.action === "delete") {
      const ids = Array.isArray(result.task_ids_to_delete) ? result.task_ids_to_delete : [];
      const removed = state.tasks.filter((t) => ids.includes(t.id));
      if (removed.length > 0) {
        await patchState(env, { tasks: state.tasks.filter((t) => !ids.includes(t.id)) });
      }
      await sendTelegramMessage(env, chatId, buildDeleteReply(removed));
    } else if (result.action === "complete") {
      const ids = Array.isArray(result.task_ids_to_complete) ? result.task_ids_to_complete : [];
      const completed = state.tasks.filter((t) => ids.includes(t.id) && !t.done);
      if (completed.length > 0) {
        await patchState(env, { tasks: state.tasks.map((t) => (ids.includes(t.id) ? { ...t, done: true } : t)) });
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
        await patchState(env, { tasks: [...state.tasks, ...newTasks] });
        await sendTelegramMessage(env, chatId, buildAddReply(newTasks, today));
      }
    } else if (result.action === "availability") {
      await sendTelegramMessage(env, chatId, buildAvailabilityReply(state, today));
    } else if (result.action === "plan_shifts") {
      const knownNames = new Set(state.employees.map((n) => n.toLowerCase()));
      const newShifts = (Array.isArray(result.shifts_to_add) ? result.shifts_to_add : [])
        .map((s) => ({
          id: crypto.randomUUID(),
          employeeName: String(s.employeeName || "").trim(),
          date: /^\d{4}-\d{2}-\d{2}$/.test(s.date) ? s.date : "",
          slotLabel: String(s.slotLabel || "").trim(),
          from: String(s.from || "").trim(),
          to: String(s.to || "").trim(),
        }))
        .filter((s) => s.employeeName && s.date && (s.slotLabel || (s.from && s.to)));
      if (newShifts.length === 0) {
        await sendTelegramMessage(env, chatId, `Konnte daraus keinen Schichtplan erkennen. Magst du es anders formulieren (z.B. „Anna bekommt Montag Früh1")?`);
      } else {
        await patchState(env, { plannedShifts: [...(state.plannedShifts || []), ...newShifts] });
        const unresolved = newShifts.filter((s) => !knownNames.has(s.employeeName.toLowerCase()));
        const badLabels = newShifts.filter((s) => s.slotLabel && !KNOWN_SLOT_LABELS.has(normalizeSlotLabelCheck(s.slotLabel)));
        let reply = buildPlanShiftsReply(newShifts);
        if (unresolved.length > 0) {
          reply += `\n\n⚠ Kenne diese Namen nicht als aktive Mitarbeiter, bitte prüfen: ${unresolved.map((s) => s.employeeName).join(", ")}`;
        }
        if (badLabels.length > 0) {
          reply += `\n\n⚠ Diese Schicht-Namen erkenne ich nicht (erwarte Früh1/Früh2/Mittel/Spät1/Spät2), kommt so NICHT im System an – bitte korrigieren: ${badLabels.map((s) => `${s.employeeName}: „${s.slotLabel}"`).join(", ")}`;
        }
        await sendTelegramMessage(env, chatId, reply);
      }
    } else if (result.action === "notify") {
      const knownNames = new Set(state.employees.map((n) => n.toLowerCase()));
      const newMessages = (Array.isArray(result.messages_to_send) ? result.messages_to_send : [])
        .map((m) => ({
          id: crypto.randomUUID(),
          employeeName: String(m.employeeName || "").trim(),
          text: String(m.text || "").trim(),
        }))
        .filter((m) => m.employeeName && m.text);
      if (newMessages.length === 0) {
        await sendTelegramMessage(env, chatId, "Konnte daraus keine Nachricht erkennen. Für wen war die gedacht, und was soll drinstehen?");
      } else {
        await patchState(env, { employeeMessages: [...(state.employeeMessages || []), ...newMessages] });
        const unresolved = newMessages.filter((m) => !knownNames.has(m.employeeName.toLowerCase()));
        let reply = buildNotifyReply(newMessages);
        if (unresolved.length > 0) {
          reply += `\n\n⚠ Kenne diese Namen nicht als aktive Mitarbeiter, bitte prüfen: ${unresolved.map((m) => m.employeeName).join(", ")}`;
        }
        await sendTelegramMessage(env, chatId, reply);
      }
    } else if (result.action === "reject_shift") {
      const knownNames = new Set(state.employees.map((n) => n.toLowerCase()));
      const newRejections = (Array.isArray(result.shifts_to_reject) ? result.shifts_to_reject : [])
        .map((r) => ({
          id: crypto.randomUUID(),
          employeeName: String(r.employeeName || "").trim(),
          date: /^\d{4}-\d{2}-\d{2}$/.test(r.date) ? r.date : "",
          slotLabel: String(r.slotLabel || "").trim(),
        }))
        .filter((r) => r.employeeName && r.date && r.slotLabel);
      if (newRejections.length === 0) {
        await sendTelegramMessage(env, chatId, `Konnte daraus keine Ablehnung erkennen. Magst du es anders formulieren (z.B. „Annas Mittel-Schicht am Montag ablehnen")?`);
      } else {
        await patchState(env, { shiftRejections: [...(state.shiftRejections || []), ...newRejections] });
        const unresolved = newRejections.filter((r) => !knownNames.has(r.employeeName.toLowerCase()));
        const badLabels = newRejections.filter((r) => !KNOWN_SLOT_LABELS.has(normalizeSlotLabelCheck(r.slotLabel)));
        let reply = buildRejectReply(newRejections);
        if (unresolved.length > 0) {
          reply += `\n\n⚠ Kenne diese Namen nicht als aktive Mitarbeiter, bitte prüfen: ${unresolved.map((r) => r.employeeName).join(", ")}`;
        }
        if (badLabels.length > 0) {
          reply += `\n\n⚠ Diese Schicht-Namen erkenne ich nicht (erwarte Früh1/Früh2/Mittel/Spät1/Spät2), kommt so NICHT im System an – bitte korrigieren: ${badLabels.map((r) => `${r.employeeName}: „${r.slotLabel}"`).join(", ")}`;
        }
        await sendTelegramMessage(env, chatId, reply);
      }
    } else if (result.action === "stock_list") {
      await sendTelegramMessage(env, chatId, buildStockListReply(state));
    } else if (result.action === "restock") {
      const newRestocks = (Array.isArray(result.items_to_restock) ? result.items_to_restock : [])
        .map((i) => ({ id: crypto.randomUUID(), itemName: String(i.itemName || "").trim() }))
        .filter((i) => i.itemName);
      if (newRestocks.length === 0) {
        await sendTelegramMessage(env, chatId, "Konnte daraus keinen Artikel erkennen. Welcher Artikel ist wieder da?");
      } else {
        await patchState(env, { stockRestocks: [...(state.stockRestocks || []), ...newRestocks] });
        await sendTelegramMessage(env, chatId, buildRestockReply(newRestocks));
      }
    } else if (result.action === "notes") {
      await sendTelegramMessage(env, chatId, buildNotesDigestReply(state));
    } else {
      await sendTelegramMessage(
        env,
        chatId,
        `Das habe ich nicht eindeutig verstanden. Du kannst mir z.B. schreiben:\n„Anna soll die Kasse zählen"\n„liste"\n„wer ist da"\n„Kasse zählen ist erledigt"\n„lösch die Aufgabe Kasse zählen bei Anna"\n„kennzahlen" / „wie war der Umsatz heute"\n„wie viele Stunden hat Anna diese Woche gemacht"\n„Wochenplan: Montag Anna 10-18, Dienstag Timm 9-17"\n„wer kann wann"\n„Sag Anna, sie soll morgen früher kommen"\n„Annas Mittel-Schicht am Montag ablehnen"\n„was fehlt" / „Kaffeebohnen sind wieder da"\n„nachrichten"`
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
    const financials = Array.isArray(body.financials) ? body.financials : undefined;
    const employeeMeta = Array.isArray(body.employeeMeta) ? body.employeeMeta : undefined;
    const staleOpenShifts = Array.isArray(body.staleOpenShifts) ? body.staleOpenShifts : undefined;
    const stock = Array.isArray(body.stock) ? body.stock : undefined;
    const patch = { employees, tasks, shiftsInService, financials, employeeMeta, staleOpenShifts, stock };
    const au = body.availabilityUpdate;
    if (au && typeof au === "object" && au.weekStart && au.entries && typeof au.entries === "object") {
      const current = await getState(env);
      patch.availability = mergeAvailabilityWeek(current.availability, au.weekStart, au.entries);
    }
    await patchState(env, patch);
    return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json", ...CORS_HEADERS } });
  }
  return new Response("method not allowed", { status: 405, headers: CORS_HEADERS });
}

/** Mitarbeiter senden darüber (aus ihrem Kiosk-Fenster) ihre Verfügbarkeit für die kommende Woche.
 * Wird still gesammelt (state.availability), keine Einzel-Benachrichtigung pro Person – der Chef bekommt
 * nur eine Nachricht, sobald ALLE aktiven Mitarbeiter für die Zielwoche eingetragen haben (siehe unten),
 * und kann den Stand jederzeit per Chat abfragen ("wer kann wann"). */
async function handleAvailability(request, env) {
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
  const employeeName = String(body.employeeName || "").trim();
  const weekStart = String(body.weekStart || "");
  const days = Array.isArray(body.days) ? body.days : [];
  if (!employeeName || !/^\d{4}-\d{2}-\d{2}$/.test(weekStart) || days.length === 0) {
    return new Response("bad request", { status: 400, headers: CORS_HEADERS });
  }

  const current = await getState(env);
  const bucket = current.availability[weekStart] || { entries: {}, notifiedComplete: false };
  bucket.entries = { ...bucket.entries, [employeeName]: { submittedAt: new Date().toISOString(), days } };
  const activeNames = current.employees || [];
  const allSubmitted = activeNames.length > 0 && activeNames.every((n) => bucket.entries[n]);
  const justCompleted = allSubmitted && !bucket.notifiedComplete;
  if (justCompleted) bucket.notifiedComplete = true;

  await patchState(env, { availability: { ...current.availability, [weekStart]: bucket } });

  if (justCompleted && env.OWNER_CHAT_ID) {
    await sendTelegramMessage(
      env,
      env.OWNER_CHAT_ID,
      `✅ Alle ${activeNames.length} Mitarbeiter haben ihre Verfügbarkeit für die Woche ab ${formatDateDe(weekStart)} eingetragen. Schick mir „verfügbarkeiten" für die Übersicht.`
    );
  }

  return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json", ...CORS_HEADERS } });
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

  // Zusätzlich sammeln, damit "nachrichten" später eine Übersicht aller Notizen zeigen kann.
  const current = await getState(env);
  const note = { id: crypto.randomUUID(), date: todayBerlin(), employeeName, text };
  const employeeNotes = [...(current.employeeNotes || []), note].slice(-100);
  await patchState(env, { employeeNotes });

  return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json", ...CORS_HEADERS } });
}

/** Nimmt System-Events entgegen (Ein-/Ausstempeln, Kassenabschluss) und meldet sie sofort, statt auf den
 * nächsten regulären Sync zu warten. Reine Weiterleitung, kein State nötig außer beim Kassenabschluss (der
 * teilt sich die Kennzahlen-Freigabe-Regel mit den übrigen Finanzdaten – App entscheidet das bereits vorher). */
async function handleEvent(request, env) {
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

  if (env.OWNER_CHAT_ID) {
    if (body.type === "clock_in") {
      await sendTelegramMessage(env, env.OWNER_CHAT_ID, `🟢 ${body.employeeName} hat sich eingestempelt (${body.time} Uhr).`);
    } else if (body.type === "clock_out") {
      await sendTelegramMessage(env, env.OWNER_CHAT_ID, `🔴 ${body.employeeName} hat sich ausgestempelt (${body.time} Uhr).`);
    } else if (body.type === "day_closed") {
      await sendTelegramMessage(env, env.OWNER_CHAT_ID, buildDayClosedReply(body));
    }
  }

  return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json", ...CORS_HEADERS } });
}

function buildDayClosedReply(d) {
  const lohnGesamt = round2((Number(d.totalLohn) || 0) + (Number(d.totalLohnnebenkosten) || 0));
  const lines = [
    `✅ Kassenabschluss ${formatDateDe(d.date)}`,
    `Umsatz gesamt: ${euro(d.umsatzGesamt)}`,
    `davon bar: ${euro(d.umsatzBar)}`,
    `Trinkgeld: ${euro(d.trinkgeldGesamt)}`,
    `Lohn: ${euro(d.totalLohn)}`,
    `Lohnnebenkosten (geschätzt): ${euro(d.totalLohnnebenkosten)}`,
    `Lohnkosten gesamt: ${euro(lohnGesamt)}`,
    `Stunden: ${round2(d.totalHours).toFixed(2).replace(".", ",")} h`,
    `Umschlag: ${euro(d.umschlag)}`,
  ];
  if (Array.isArray(d.perEmployee) && d.perEmployee.length > 0) {
    lines.push("", "Pro Person:");
    for (const p of d.perEmployee) {
      lines.push(`- ${p.name}: ${round2(p.hours).toFixed(2).replace(".", ",")} h · ${euro(p.lohn)}${p.tip ? ` · Trinkgeld ${euro(p.tip)}` : ""}`);
    }
  }
  return lines.join("\n");
}

function buildNotesDigestReply(state) {
  const notes = state.employeeNotes || [];
  if (notes.length === 0) return "📭 Keine Mitarbeiter-Notizen vorhanden.";
  const recent = notes.slice(-20);
  const lines = recent.map((n) => `${formatDateDe(n.date)} · ${n.employeeName}: ${n.text}`);
  return ["📋 Mitarbeiter-Notizen (letzte 20):", ...lines].join("\n");
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

    if (weekdayOf(today) === REMINDER_WEEKDAY) {
      await remindMissingAvailability(env, state, today);
    }
    if (weekdayOf(today) === 1) {
      await sendWeeklySummary(env, state, today);
    }
    await warnMinijobLimits(env, state, today);
    await warnStaleOpenShifts(env, state);
  } else if (hour === EVENING_HOUR && open.length > 0) {
    const text = `🌙 Heute Abend noch offen (${open.length}):\n\n${buildListReply({ ...state, tasks: open }, today)}`;
    await sendTelegramMessage(env, env.OWNER_CHAT_ID, text);
  }
}

/** Freitags-Erinnerung: wer hat für die kommende Woche noch keine Verfügbarkeit eingetragen? Meldet sich nur,
 * wenn tatsächlich noch jemand fehlt (sonst kam schon die "alle da"-Meldung beim letzten Eintrag). */
async function remindMissingAvailability(env, state, today) {
  const activeNames = state.employees || [];
  if (activeNames.length === 0) return;
  const weekStart = nextMondayFrom(today);
  const bucket = (state.availability || {})[weekStart];
  const submitted = new Set(Object.keys(bucket?.entries || {}));
  const missing = activeNames.filter((n) => !submitted.has(n));
  if (missing.length === 0) return;
  await sendTelegramMessage(
    env,
    env.OWNER_CHAT_ID,
    `📋 Diese Personen haben noch keine Verfügbarkeit für die Woche ab ${formatDateDe(weekStart)} eingetragen: ${missing.join(", ")}.`
  );
}

/** Montagmorgen: kurzer Rückblick auf die vergangene Woche (nur wenn Kennzahlen freigegeben sind, sonst
 * still übersprungen statt jede Woche mit einer "nicht verfügbar"-Nachricht zu nerven). */
async function sendWeeklySummary(env, state, today) {
  if (!state.financials || state.financials.length === 0) return;
  let reply = buildStatsReply(state, "lastweek", today);
  const insights = await generateInsights(env, state.financials);
  if (insights) reply += `\n\n💡 ${insights}`;
  await sendTelegramMessage(env, env.OWNER_CHAT_ID, `📅 Wochenrückblick\n\n${reply}`);
}

/** Warnt einmalig pro Person und Monat, sobald ein Minijobber diesen Monat 85% seiner Verdienstgrenze
 * erreicht hat (nur wenn Kennzahlen freigegeben sind, sonst kennt der Worker die Lohnsummen nicht). */
async function warnMinijobLimits(env, state, today) {
  const minijobbers = (state.employeeMeta || []).filter((m) => m.isMinijob);
  if (minijobbers.length === 0) return;
  const monthKey = today.slice(0, 7);
  const monthRows = (state.financials || []).filter((r) => r.date.startsWith(monthKey));
  const warned = { ...(state.minijobWarned || {}) };
  let changed = false;
  const warnings = [];
  for (const m of minijobbers) {
    const key = `${monthKey}:${m.name}`;
    if (warned[key]) continue;
    let lohn = 0;
    for (const row of monthRows) {
      const pe = (row.perEmployee || []).find((p) => p.name === m.name);
      if (pe) lohn += Number(pe.lohn) || 0;
    }
    lohn = round2(lohn);
    const limit = Number(m.minijobLimit) || 556;
    if (limit > 0 && lohn >= limit * 0.85) {
      warnings.push(`${m.name}: ${euro(lohn)} von ${euro(limit)} (${round2((lohn / limit) * 100)}%)`);
      warned[key] = true;
      changed = true;
    }
  }
  if (changed) await patchState(env, { minijobWarned: warned });
  if (warnings.length > 0) {
    await sendTelegramMessage(env, env.OWNER_CHAT_ID, `⚠️ Minijob-Grenze rückt näher (dieser Monat):\n${warnings.join("\n")}`);
  }
}

/** Warnt einmalig pro Person und Tag, wenn eine PIN-Schicht aus einem vergangenen Tag noch offen ist
 * (vermutlich vergessenes Ausstempeln). */
async function warnStaleOpenShifts(env, state) {
  const stale = state.staleOpenShifts || [];
  if (stale.length === 0) return;
  const warned = { ...(state.staleShiftWarned || {}) };
  const toWarn = [];
  let changed = false;
  for (const s of stale) {
    const key = `${s.date}:${s.employeeName}`;
    if (warned[key]) continue;
    toWarn.push(s);
    warned[key] = true;
    changed = true;
  }
  if (changed) await patchState(env, { staleShiftWarned: warned });
  if (toWarn.length > 0) {
    const lines = toWarn.map((s) => `- ${s.employeeName}: seit ${formatDateDe(s.date)} ${s.from} Uhr noch eingestempelt`);
    await sendTelegramMessage(env, env.OWNER_CHAT_ID, `⏰ Vergessenes Ausstempeln?\n${lines.join("\n")}`);
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
    if (url.pathname === "/event") {
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
      return handleEvent(request, env);
    }
    if (url.pathname === "/availability") {
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
      return handleAvailability(request, env);
    }

    if (request.method === "POST") return handleTelegram(request, env);
    return new Response("ok", { status: 200 });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(handleScheduled(env));
  },
};
