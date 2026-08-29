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
// Zentrale Modell-Wahl für alle Claude-Aufrufe (Nachrichten verstehen, Fotos/PDFs auswerten, freie Fragen
// beantworten) – an einer Stelle austauschbar. Sonnet 5 versteht Nuancen/komplexere Formulierungen spürbar
// besser als Haiku, kostet aber etwa das Doppelte pro Nachricht (bei diesem Nachrichtenvolumen weiterhin
// im Cent-Bereich pro Monat).
const AI_MODEL = "claude-sonnet-5";
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
// Rückfall-Liste für den Fall, dass das iPad seine Schicht-Definitionen noch nicht hochgeladen hat.
const KNOWN_SLOT_LABELS = new Set(["Früh1", "Früh2", "Mittel", "Spät1", "Spät2"].map(normalizeSlotLabelCheck));

/** Gültige Schicht-Namen: bevorzugt die vom iPad gelieferten Definitionen, damit ein Umbenennen der
 * Schichten dort nicht dazu führt, dass hier plötzlich alles abgelehnt wird. Nur solange noch nichts
 * synchronisiert wurde, greift die fest hinterlegte Liste. */
function knownSlotLabels(state) {
  const slots = state?.shiftSlots;
  const aus = [...(slots?.service || []), ...(slots?.kueche || [])].map((s) => normalizeSlotLabelCheck(s.label));
  return aus.length > 0 ? new Set(aus) : KNOWN_SLOT_LABELS;
}
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
  stockSales: [], // [{id, productName, quantitySold, kind, date}] – per SumUp-Verkaufsbericht erkannte Verkäufe
  employeeNotes: [], // [{id, date, employeeName, text}] – gesammelte Mitarbeiter-Notizen, per "nachrichten" abrufbar
  minijobWarned: {}, // "YYYY-MM:Name" -> true, verhindert tägliches Wiederholen derselben Warnung
  staleShiftWarned: {}, // "YYYY-MM-DD:Name" -> true, dito für vergessenes Ausstempeln
  // Letzte Chat-Nachrichten (nur Text-Nachrichten, keine Foto/PDF-Auswertungen), damit der Bot bei
  // Rückfragen ("und letzte Woche?") den Zusammenhang kennt. [{role:"user"|"assistant", text}], gedeckelt
  // auf die letzten 20 Einträge (~10 Austausche), damit KV-Größe und Tokenkosten begrenzt bleiben.
  conversationHistory: [],
  // Krankmeldungen vom Handy: [{id, employeeName, from, to, note, createdAt}] – Warteschlange, die der iPad
  // abarbeitet (wie stockDeliveries & Co.), damit sein eigener Stand die Quelle der Wahrheit bleibt.
  sickReports: [],
  // Vom iPad gelieferte PIN-Hashes für den Handy-/Laptop-Login. NIEMALS an einen Client ausliefern.
  authPins: [], // [{name, pinHash}]
  adminPinHash: null,
  // Rollen + Schicht-Definitionen vom iPad, damit die Laptop-Ansicht weiß, welche Schichten es für wen gibt.
  employeeRoles: [], // [{name, role}]
  shiftSlots: null, // { service: [{id,label,from,to,allowedWeekdays?}], kueche: [...] }
  // Kurznachrichten an einzelne Mitarbeiter für die HANDY-Ansicht (Schicht zugesagt/abgelehnt o.ä.).
  // Bewusst getrennt von den Kiosk-Benachrichtigungen: die entstehen lokal auf dem iPad und kämen hier
  // sonst nie an. [{id, employeeName, text, createdAt, readAt}]
  employeeNotifications: [],
  // Rezepte vom iPad (nur zum Anzeigen/Bearbeiten am Laptop) + Warteschlangen für Änderungen, die der
  // Laptop anstößt. Wie überall gilt: der iPad arbeitet sie ab und bleibt die maßgebliche Instanz.
  recipes: [], // [{id, productName, ingredients:[{stockItemId, amount}]}]
  stockChanges: [], // [{id, kind:"create"|"update"|"delete"|"setAmount", ...}]
  recipeChanges: [], // [{id, kind:"create"|"update"|"delete", ...}]
  // Mitarbeiter-Stammdaten vom iPad für die Laptop-Verwaltung. Bewusst OHNE PIN – der wird weiterhin nur
  // am iPad vergeben, damit kein PIN im Klartext das Gerät verlässt.
  employeeDetails: [], // [{id, name, role, hourlyWage, isMinijob, minijobLimit, active, hasPin}]
  employeeChanges: [], // [{id, kind:"create"|"update"|"deactivate"|"activate", ...}]
  // Wochen, deren Schichtplan der Chef abgeschlossen hat: [{weekStart, publishedAt}].
  // Das ist der Schalter für ALLE Schicht-Benachrichtigungen: Solange eine Woche hier nicht steht, erfährt
  // niemand, ob er zu- oder abgesagt wurde. Erst beim Abschließen geht die Info gebündelt raus.
  publishedWeeks: [],
  // Warteschlange dazu für den iPad (wie stockDeliveries & Co.): [{id, weekStart, action, at}]
  weekPublications: [],
  // --- Online-Reservierung ---
  // Tische vom iPad, damit der Worker selbst prüfen kann, ob überhaupt noch etwas frei ist.
  // [{id, name, seats, area, active, combinesWith}]
  tables: [],
  // Belegte Zeitfenster vom iPad – BEWUSST OHNE Namen und Telefonnummern. Für die Frage "ist noch etwas
  // frei?" braucht es die nicht, und Gästedaten haben in der Cloud nichts verloren, solange sie dort
  // keinen Zweck erfüllen. [{date, time, tableIds, guests}]
  reservationSlots: [],
  // Öffnungszeiten + Regeln für die Online-Buchung, ebenfalls vom iPad.
  reservationConfig: null,
  // Warteschlange der Gast-Buchungen, die der iPad abholt.
  // [{id, date, time, name, phone, guests, area, note, code, createdAt}]
  reservationRequests: [],
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
      conversationHistory: Array.isArray(parsed.conversationHistory) ? parsed.conversationHistory : [],
      sickReports: Array.isArray(parsed.sickReports) ? parsed.sickReports : [],
      authPins: Array.isArray(parsed.authPins) ? parsed.authPins : [],
      adminPinHash: typeof parsed.adminPinHash === "string" ? parsed.adminPinHash : null,
      employeeRoles: Array.isArray(parsed.employeeRoles) ? parsed.employeeRoles : [],
      shiftSlots: parsed.shiftSlots && typeof parsed.shiftSlots === "object" ? parsed.shiftSlots : null,
      employeeNotifications: Array.isArray(parsed.employeeNotifications) ? parsed.employeeNotifications : [],
      recipes: Array.isArray(parsed.recipes) ? parsed.recipes : [],
      stockChanges: Array.isArray(parsed.stockChanges) ? parsed.stockChanges : [],
      recipeChanges: Array.isArray(parsed.recipeChanges) ? parsed.recipeChanges : [],
      employeeDetails: Array.isArray(parsed.employeeDetails) ? parsed.employeeDetails : [],
      employeeChanges: Array.isArray(parsed.employeeChanges) ? parsed.employeeChanges : [],
      publishedWeeks: Array.isArray(parsed.publishedWeeks) ? parsed.publishedWeeks : [],
      weekPublications: Array.isArray(parsed.weekPublications) ? parsed.weekPublications : [],
      tables: Array.isArray(parsed.tables) ? parsed.tables : [],
      reservationSlots: Array.isArray(parsed.reservationSlots) ? parsed.reservationSlots : [],
      reservationConfig: parsed.reservationConfig && typeof parsed.reservationConfig === "object" ? parsed.reservationConfig : null,
      reservationRequests: Array.isArray(parsed.reservationRequests) ? parsed.reservationRequests : [],
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

// ---------------------------------------------------------------------
// Anmeldung für Handy (Mitarbeiter) und Laptop (Chef).
//
// Bewusst KOMPLETT getrennt vom WEBHOOK_SECRET: das nutzen weiterhin nur iPad und Telegram-Bot. Ein
// Mitarbeiter-Handy darf dieses Secret nie bekommen, denn damit könnte man den gesamten Stand inklusive
// der Löhne ALLER Kollegen auslesen. Stattdessen: PIN -> serverseitig geprüfte Sitzung, und jeder Endpunkt
// liefert nur das, was die jeweilige Rolle sehen darf.
//
// Zur Einordnung: 4-stellige PINs sind über das Internet erreichbar nur schwach. Der eigentliche Schutz ist
// deshalb die Sperre nach wenigen Fehlversuchen (siehe unten).
// ---------------------------------------------------------------------
const SESSION_TTL_SECONDS = 30 * 24 * 3600; // 30 Tage, danach muss man sich am Handy neu anmelden
const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_LOCK_SECONDS = 15 * 60;

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...CORS_HEADERS } });
}

function toHex(bytes) {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return toHex(bytes);
}

/** Muss Zeichen für Zeichen identisch zu hashPin() in js/taskSync.js sein, sonst schlägt jeder Login fehl.
 * Das Worker-Secret dient als "Pfeffer", damit im Speicher keine blanken PIN-Hashes liegen. */
async function hashPin(secret, pin) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${secret}:${pin}`));
  return toHex(digest);
}

/** Vergleich ohne frühen Abbruch, damit die Antwortzeit nichts über den richtigen Wert verrät. */
function sameHash(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function clientKey(request) {
  return request.headers.get("CF-Connecting-IP") || "unbekannt";
}

async function isLockedOut(env, key) {
  const raw = await env.TASKS_KV.get(`lock:${key}`);
  return Number(raw) >= LOGIN_MAX_ATTEMPTS;
}

async function noteFailedLogin(env, key) {
  const current = Number(await env.TASKS_KV.get(`lock:${key}`)) || 0;
  // TTL bei jedem Fehlversuch neu setzen: wer weiter probiert, verlängert die eigene Sperre.
  await env.TASKS_KV.put(`lock:${key}`, String(current + 1), { expirationTtl: LOGIN_LOCK_SECONDS });
}

async function clearFailedLogins(env, key) {
  await env.TASKS_KV.delete(`lock:${key}`);
}

async function createSession(env, payload) {
  const token = randomToken();
  await env.TASKS_KV.put(`session:${token}`, JSON.stringify(payload), { expirationTtl: SESSION_TTL_SECONDS });
  return token;
}

/** Prüft Sitzung und Rolle an EINER Stelle – hier hängt der Schutz der Lohndaten dran. Rollen werden exakt
 * verlangt (kein "Chef darf auch /me"), damit es keine Grauzone gibt. Gibt {session} oder {error} zurück. */
async function requireSession(request, env, role) {
  const token = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return { error: jsonResponse({ error: "Nicht angemeldet." }, 401) };
  const raw = await env.TASKS_KV.get(`session:${token}`);
  if (!raw) return { error: jsonResponse({ error: "Sitzung abgelaufen. Bitte neu anmelden." }, 401) };
  let session;
  try {
    session = JSON.parse(raw);
  } catch {
    return { error: jsonResponse({ error: "Sitzung ungültig. Bitte neu anmelden." }, 401) };
  }
  if (session.role !== role) return { error: jsonResponse({ error: "Keine Berechtigung." }, 403) };
  return { session };
}

// ============================================================================
// Online-Reservierung für Gäste (öffentlich erreichbar, ohne Anmeldung).
//
// Der Worker entscheidet SELBST, ob noch etwas frei ist – Gäste buchen nachts und am Ruhetag, da ist
// das iPad aus. Grundlage sind Tische, belegte Zeitfenster und Öffnungszeiten, die das iPad ohnehin
// bei jedem Abgleich mitschickt. Die Buchung landet dann in einer Warteschlange, die der iPad abholt:
// er bleibt die maßgebliche Instanz, hier wird nichts endgültig entschieden.
//
// Der Tisch wird bewusst NICHT automatisch vergeben. Der Worker garantiert nur, dass Kapazität da ist;
// wer wohin kommt, entscheidet der Chef am iPad. Das ist auch der Grund, warum ein theoretisch mögliches
// gleichzeitiges Buchen des letzten Tisches nicht schlimm ist: dann steht eine Reservierung mehr in der
// Liste "ohne Tisch", statt dass zwei Gäste denselben Tisch zugesagt bekommen.
// ============================================================================

// Pro Stunde und Anschluss. Gezählt werden nur ERFOLGREICHE Buchungen: nur die belegen Plätze.
// Nicht zu knapp gewählt, weil sich mehrere Gäste eine Adresse teilen können (z.B. wenn sie aus dem
// WLAN des Cafés buchen) – die Bremse soll Bots stoppen, nicht echte Gäste.
const BUCHUNG_MAX_PRO_IP = 10;
const BUCHUNG_LOCK_SECONDS = 3600;
const REQUEST_AUFBEWAHRUNG_TAGE = 60; // danach werden Gästedaten in der Warteschlange gelöscht

function minutenAusZeit(t) {
  const [h, m] = String(t || "").split(":").map(Number);
  return (Number(h) || 0) * 60 + (Number(m) || 0);
}
function zeitAusMinuten(min) {
  return `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
}
function wochentagIndexIso(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return wd === 0 ? 6 : wd - 1;
}

/** Zusammengefasste Regeln, mit Standardwerten falls das iPad noch nichts geschickt hat. */
function buchungsConfig(state) {
  const c = state.reservationConfig || {};
  return {
    durationMinutes: Number(c.durationMinutes) || 120,
    openingHours: Array.isArray(c.openingHours) ? c.openingHours : [],
    maxDaysAhead: Number(c.maxDaysAhead) || 60,
    minLeadMinutes: Number.isFinite(Number(c.minLeadMinutes)) ? Number(c.minLeadMinutes) : 60,
    maxGuestsOnline: Number(c.maxGuestsOnline) || 8,
    onlineEnabled: c.onlineEnabled !== false,
    terraceClosedDates: Array.isArray(c.terraceClosedDates) ? c.terraceClosedDates : [],
    cafeName: String(c.cafeName || "").trim(),
  };
}

/** Welche Tische sind zu dieser Zeit belegt? Berücksichtigt auch die Buchungen, die schon in der
 * Warteschlange stehen und vom iPad noch nicht abgeholt wurden – sonst würde dieselbe Kapazität
 * mehrfach vergeben, solange das iPad aus ist. */
function belegteTische(state, cfg, date, time) {
  const start = minutenAusZeit(time);
  const ende = start + cfg.durationMinutes;
  const belegt = new Set();
  for (const slot of state.reservationSlots || []) {
    if (slot.date !== date) continue;
    const s = minutenAusZeit(slot.time);
    if (!(start < s + cfg.durationMinutes && s < ende)) continue;
    for (const id of slot.tableIds || []) belegt.add(id);
  }
  return belegt;
}

/** Reicht die noch freie Kapazität für so viele Personen?
 *
 * Geprüft wird dieselbe Regel wie in der App: ein einzelner freier Tisch mit genug Plätzen, oder
 * mehrere Tische, die laut Nachbarschaft zusammengeschoben werden können.
 *
 * Buchungen aus der Warteschlange haben noch keinen Tisch. Sie werden deshalb über ihre Personenzahl
 * berücksichtigt: die dafür nötigen Plätze gelten als vergeben.
 */
function istFrei(state, cfg, date, time, guests, area) {
  const belegt = belegteTische(state, cfg, date, time);
  const terrasseZu = cfg.terraceClosedDates.includes(date);
  const start = minutenAusZeit(time);

  let frei = (state.tables || []).filter((t) => t.active !== false && !belegt.has(t.id));
  if (terrasseZu) frei = frei.filter((t) => t.area !== "draussen");
  if (area === "innen" || area === "draussen") frei = frei.filter((t) => t.area === area);
  if (frei.length === 0) return false;

  // Noch nicht zugewiesene Buchungen aus der Warteschlange: ihre Personenzahl blockiert Plätze.
  // Die größten zuerst wegnehmen, sonst käme man auf ein zu günstiges Ergebnis.
  const wartend = (state.reservationRequests || [])
    .filter((r) => r.date === date && Math.abs(minutenAusZeit(r.time) - start) < cfg.durationMinutes)
    .sort((a, b) => b.guests - a.guests);
  const uebrig = [...frei].sort((a, b) => b.seats - a.seats);
  for (const w of wartend) {
    const idx = uebrig.findIndex((t) => t.seats >= w.guests);
    if (idx >= 0) uebrig.splice(idx, 1);
    else uebrig.shift(); // passt nirgends allein – trotzdem einen Tisch als verbraucht ansehen
  }
  if (uebrig.length === 0) return false;

  // Ein einzelner Tisch reicht?
  if (uebrig.some((t) => t.seats >= guests)) return true;

  // Sonst: gibt es eine zusammenhängende Kombination mit genug Plätzen?
  const freiIds = new Set(uebrig.map((t) => t.id));
  const byId = new Map(uebrig.map((t) => [t.id, t]));
  for (const start2 of uebrig) {
    // Von diesem Tisch aus über die Nachbarschaften laufen und Plätze aufsummieren (höchstens 3 Tische).
    const besucht = new Set([start2.id]);
    let plaetze = start2.seats;
    let grenze = [start2];
    while (besucht.size < 3) {
      let naechster = null;
      for (const t of grenze) {
        for (const n of t.combinesWith || []) {
          if (freiIds.has(n) && !besucht.has(n) && byId.get(n).area === start2.area) {
            naechster = byId.get(n);
            break;
          }
        }
        if (naechster) break;
      }
      if (!naechster) break;
      besucht.add(naechster.id);
      plaetze += naechster.seats;
      grenze = [...besucht].map((id) => byId.get(id));
      if (plaetze >= guests) return true;
    }
  }
  return false;
}

/** Buchbare Uhrzeiten eines Tages: im Viertelstunden-Takt innerhalb der Öffnungszeiten, und nur
 * solche, für die auch wirklich noch Platz ist. */
function freieZeiten(state, cfg, date, guests, area, jetztISO) {
  const wd = wochentagIndexIso(date);
  const tag = cfg.openingHours[wd];
  if (!tag || tag.closed) return { zeiten: [], grund: "ruhetag" };

  const von = minutenAusZeit(tag.from);
  // Die letzte Buchung soll noch sitzen können: Ende minus Verweildauer wäre streng, das würde bei
  // 2 Stunden fast den halben Abend sperren. Stattdessen bis eine Stunde vor Schluss.
  const bis = Math.max(von, minutenAusZeit(tag.to) - 60);

  // Kurzfristigkeit: heute erst ab jetzt + Vorlauf.
  const heute = jetztISO.slice(0, 10);
  const jetztMin = Number(jetztISO.slice(11, 13)) * 60 + Number(jetztISO.slice(14, 16));
  const frueheste = date === heute ? jetztMin + cfg.minLeadMinutes : -1;

  const zeiten = [];
  for (let m = von; m <= bis; m += 15) {
    if (m < frueheste) continue;
    if (istFrei(state, cfg, date, zeitAusMinuten(m), guests, area)) zeiten.push(zeitAusMinuten(m));
  }
  return { zeiten, grund: zeiten.length === 0 ? "ausgebucht" : null };
}

/** Kurze, am Telefon gut vorlesbare Nummer – ohne Zeichen, die man verwechseln kann (0/O, 1/I). */
function buchungsCode() {
  const alphabet = "ACDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  const bytes = crypto.getRandomValues(new Uint8Array(5));
  for (const b of bytes) code += alphabet[b % alphabet.length];
  return code;
}

/** Freie Uhrzeiten für einen Tag. Öffentlich, ohne Anmeldung – gibt bewusst NUR Uhrzeiten zurück,
 * keine Tische, keine Namen, keine Auslastung. Wer wann bei euch sitzt, geht Fremde nichts an. */
async function handleBookingSlots(request, env) {
  const url = new URL(request.url);
  const date = String(url.searchParams.get("date") || "");
  const guests = Math.max(1, Math.min(99, Number(url.searchParams.get("guests")) || 2));
  const area = ["innen", "draussen", "egal"].includes(url.searchParams.get("area")) ? url.searchParams.get("area") : "egal";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return jsonResponse({ error: "Bitte ein gültiges Datum wählen." }, 400);

  const state = await getState(env);
  const cfg = buchungsConfig(state);
  if (!cfg.onlineEnabled) return jsonResponse({ zeiten: [], grund: "aus" });
  if ((state.tables || []).length === 0) return jsonResponse({ zeiten: [], grund: "nicht_eingerichtet" });
  if (guests > cfg.maxGuestsOnline) return jsonResponse({ zeiten: [], grund: "zu_gross", maxGuests: cfg.maxGuestsOnline });

  const heute = todayBerlin();
  if (date < heute) return jsonResponse({ zeiten: [], grund: "vergangen" });
  if (date > addDaysISO(heute, cfg.maxDaysAhead)) return jsonResponse({ zeiten: [], grund: "zu_weit" });

  const jetztISO = new Date().toLocaleString("sv-SE", { timeZone: "Europe/Berlin" }).replace(" ", "T");
  return jsonResponse(freieZeiten(state, cfg, date, guests, area, jetztISO));
}

/** Gast schickt eine Buchung ab. Landet in einer Warteschlange – der iPad holt sie ab und legt daraus
 * eine echte Reservierung an. Ein Tisch wird hier NICHT vergeben, das macht der Chef. */
async function handleBookingCreate(request, env) {
  if (request.method !== "POST") return jsonResponse({ error: "method not allowed" }, 405);

  // Missbrauchsschutz: begrenzt, wie oft von derselben Stelle gebucht werden kann. Fängt vor allem
  // versehentliches Mehrfach-Absenden und stumpfe Bots ab.
  const kennung = "book:" + clientKey(request);
  const bisher = Number((await env.TASKS_KV.get(kennung)) || 0);
  if (bisher >= BUCHUNG_MAX_PRO_IP) {
    return jsonResponse({ error: "Von hier wurden gerade sehr viele Reservierungen gesendet. Bitte ruft uns kurz an." }, 429);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "bad request" }, 400);
  }

  // Honeypot: ein für Menschen unsichtbares Feld. Ist es ausgefüllt, war ein Bot am Werk. Antwort
  // bewusst wie ein Erfolg, damit der Bot nichts dazulernt.
  if (String(body?.website || "").trim()) return jsonResponse({ ok: true, code: buchungsCode() });

  const name = String(body?.name || "").trim().slice(0, 80);
  const phone = String(body?.phone || "").trim().slice(0, 40);
  const note = String(body?.note || "").trim().slice(0, 300);
  const date = String(body?.date || "");
  const time = String(body?.time || "");
  const guests = Math.max(1, Math.min(99, Number(body?.guests) || 0));
  const area = ["innen", "draussen", "egal"].includes(body?.area) ? body.area : "egal";

  if (!name) return jsonResponse({ error: "Bitte einen Namen angeben." }, 400);
  if (!phone) return jsonResponse({ error: "Bitte eine Telefonnummer angeben, damit wir euch erreichen können." }, 400);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) {
    return jsonResponse({ error: "Bitte Datum und Uhrzeit wählen." }, 400);
  }

  const state = await getState(env);
  const cfg = buchungsConfig(state);
  if (!cfg.onlineEnabled) return jsonResponse({ error: "Online-Reservierung ist gerade nicht möglich. Bitte ruft uns an." }, 503);
  if (guests > cfg.maxGuestsOnline) {
    return jsonResponse({ error: `Ab ${cfg.maxGuestsOnline + 1} Personen sprechen wir das lieber persönlich ab – bitte ruft uns an.` }, 400);
  }
  const heute = todayBerlin();
  if (date < heute || date > addDaysISO(heute, cfg.maxDaysAhead)) {
    return jsonResponse({ error: "Für diesen Tag können wir online leider nichts annehmen." }, 400);
  }

  // Noch einmal prüfen, ob wirklich frei: zwischen dem Laden der Zeiten und dem Absenden kann Zeit
  // vergangen sein, in der jemand anderes gebucht hat.
  const jetztISO = new Date().toLocaleString("sv-SE", { timeZone: "Europe/Berlin" }).replace(" ", "T");
  const { zeiten } = freieZeiten(state, cfg, date, guests, area, jetztISO);
  if (!zeiten.includes(time)) {
    return jsonResponse({ error: "Diese Uhrzeit ist inzwischen leider vergeben. Bitte wählt eine andere." }, 409);
  }

  const code = buchungsCode();
  const eintrag = { id: crypto.randomUUID(), code, date, time, name, phone, guests, area, note, createdAt: new Date().toISOString() };

  // Alte Einträge aufräumen: Gästedaten sollen nicht unbegrenzt in der Cloud liegen. Der iPad hat sie
  // längst abgeholt, hier werden sie nur zwischengelagert.
  const grenze = addDaysISO(heute, -REQUEST_AUFBEWAHRUNG_TAGE);
  const bestand = (state.reservationRequests || []).filter((r) => (r.date || "") >= grenze);

  await patchState(env, { reservationRequests: [...bestand, eintrag].slice(-500) });
  await env.TASKS_KV.put(kennung, String(bisher + 1), { expirationTtl: BUCHUNG_LOCK_SECONDS });

  if (env.OWNER_CHAT_ID) {
    const bereich = area === "innen" ? "drinnen" : area === "draussen" ? "draußen" : "egal";
    await sendTelegramMessage(
      env,
      env.OWNER_CHAT_ID,
      `🍽 Neue Online-Reservierung\n${formatDateDe(date)} um ${time} Uhr\n${name} · ${guests} ${
        guests === 1 ? "Person" : "Personen"
      } · ${bereich}\n📞 ${phone}${note ? `\n📝 ${note}` : ""}\nNr. ${code}`
    );
  }
  return jsonResponse({ ok: true, code });
}

/** Die Buchungsseite selbst. Wird auf der Website in einen Rahmen eingebettet, läuft aber komplett
 * hier – so muss im Website-Baukasten nichts weiter eingerichtet werden als ein HTML-Element. */
async function handleBookingPage(env) {
  const state = await getState(env);
  const cfg = buchungsConfig(state);
  const name = cfg.cafeName || "Reservierung";
  const html = `<!doctype html>
<html lang="de"><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${escapeHtmlWorker(name)}</title>
<style>
  :root { --gruen:#1f6f54; --gruen-d:#16543f; --hell:#e7f4ee; --rand:#e2e4e8; --text:#1c1f23; --grau:#6b7280; }
  @media (prefers-color-scheme: dark) {
    :root { --hell:#133326; --rand:#33363c; --text:#e9eaec; --grau:#9aa0a8; --gruen:#3fa585; --gruen-d:#2c8069; }
    body { background:#16181c; }
  }
  * { box-sizing:border-box; }
  body { margin:0; padding:16px; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
         color:var(--text); font-size:16px; line-height:1.45; }
  h1 { font-size:22px; margin:0 0 4px; }
  .hint { color:var(--grau); font-size:14px; margin:0 0 16px; }
  label { display:block; margin-bottom:12px; }
  label > span { display:block; font-size:14px; font-weight:600; margin-bottom:4px; }
  input, select, textarea { width:100%; padding:11px 12px; font-size:16px; font-family:inherit;
    border:1px solid var(--rand); border-radius:10px; background:transparent; color:var(--text); }
  textarea { resize:vertical; min-height:64px; }
  .reihe { display:flex; gap:10px; flex-wrap:wrap; }
  .reihe > label { flex:1 1 130px; }
  .zaehler { display:flex; gap:6px; }
  .zaehler input { text-align:center; }
  .zbtn { flex:0 0 46px; font-size:22px; font-weight:700; border:1px solid var(--rand); border-radius:10px;
          background:transparent; color:var(--text); cursor:pointer; }
  .zbtn:disabled { opacity:.35; cursor:not-allowed; }
  .zeiten { display:flex; flex-wrap:wrap; gap:8px; margin:4px 0 12px; }
  .zeit { padding:10px 14px; border:2px solid var(--rand); border-radius:10px; background:transparent;
          color:var(--text); font-size:16px; font-family:inherit; cursor:pointer; }
  .zeit[aria-pressed="true"] { border-color:var(--gruen); background:var(--hell); color:var(--gruen-d); font-weight:700; }
  button.senden { width:100%; padding:15px; font-size:17px; font-weight:700; border:none; border-radius:12px;
                  background:var(--gruen); color:#fff; cursor:pointer; font-family:inherit; }
  button.senden:disabled { opacity:.5; cursor:not-allowed; }
  .melde { padding:12px 14px; border-radius:10px; background:var(--hell); margin:12px 0; font-size:15px; }
  .fehler { background:#fdf0dd; color:#8a5a00; }
  @media (prefers-color-scheme: dark) { .fehler { background:#3a2a12; color:#e2952f; } }
  .datenschutz { color:var(--grau); font-size:12px; margin-top:14px; }
  .erfolg { text-align:center; padding:24px 8px; }
  .code { font-size:30px; font-weight:800; letter-spacing:3px; margin:10px 0; color:var(--gruen-d); }
  .versteckt { position:absolute; left:-9999px; width:1px; height:1px; overflow:hidden; }
</style></head>
<body>
<div id="app"></div>
<script>
const MAX_GUESTS = ${cfg.maxGuestsOnline};
const MAX_TAGE = ${cfg.maxDaysAhead};
const app = document.getElementById("app");
const heute = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Berlin" });
const spaetestens = new Date(Date.now() + MAX_TAGE * 86400000).toLocaleDateString("sv-SE", { timeZone: "Europe/Berlin" });
let daten = { date: heute, guests: 2, area: "egal", time: "" };

const GRUND_TEXT = {
  ruhetag: "An diesem Tag haben wir geschlossen.",
  ausgebucht: "Für diesen Tag ist online leider nichts mehr frei. Ruft uns gerne an – manchmal geht doch noch etwas.",
  zu_gross: "Für so viele Personen sprechen wir das lieber persönlich ab. Bitte ruft uns an.",
  zu_weit: "So weit im Voraus nehmen wir online noch keine Reservierungen an.",
  vergangen: "Dieser Tag liegt in der Vergangenheit.",
  aus: "Online-Reservierung ist gerade nicht möglich. Bitte ruft uns an.",
  nicht_eingerichtet: "Online-Reservierung ist gerade nicht möglich. Bitte ruft uns an.",
};

function el(html) { const d = document.createElement("div"); d.innerHTML = html.trim(); return d.firstElementChild; }

function zeichne() {
  app.innerHTML = "";
  app.appendChild(el('<h1>Tisch reservieren</h1>'));
  app.appendChild(el('<p class="hint">Wir melden uns nur, falls es ein Problem gibt.</p>'));

  const reihe = el('<div class="reihe"></div>');

  const datum = el('<label><span>Tag</span><input type="date" id="f-date"></label>');
  const dInput = datum.querySelector("input");
  dInput.min = heute; dInput.max = spaetestens; dInput.value = daten.date;
  dInput.onchange = () => { daten.date = dInput.value; daten.time = ""; ladeZeiten(); };
  reihe.appendChild(datum);

  const pers = el('<label><span>Personen</span><div class="zaehler"><button type="button" class="zbtn" id="f-minus">−</button><input type="number" id="f-guests" min="1" inputmode="numeric"><button type="button" class="zbtn" id="f-plus">+</button></div></label>');
  const gInput = pers.querySelector("#f-guests");
  gInput.value = daten.guests;
  gInput.max = MAX_GUESTS;
  const setG = (n) => { daten.guests = Math.min(MAX_GUESTS, Math.max(1, n)); gInput.value = daten.guests; daten.time = ""; ladeZeiten(); };
  pers.querySelector("#f-minus").onclick = () => setG(daten.guests - 1);
  pers.querySelector("#f-plus").onclick = () => setG(daten.guests + 1);
  gInput.onchange = () => setG(Number(gInput.value) || 1);
  reihe.appendChild(pers);

  const bereich = el('<label><span>Wo möchtet ihr sitzen?</span><select id="f-area"><option value="egal">Egal</option><option value="innen">Drinnen</option><option value="draussen">Draußen</option></select></label>');
  const aSel = bereich.querySelector("select");
  aSel.value = daten.area;
  aSel.onchange = () => { daten.area = aSel.value; daten.time = ""; ladeZeiten(); };
  reihe.appendChild(bereich);

  app.appendChild(reihe);
  app.appendChild(el('<span style="display:block;font-size:14px;font-weight:600;margin-bottom:4px">Uhrzeit</span>'));
  app.appendChild(el('<div class="zeiten" id="f-zeiten"><span class="hint">Lade freie Zeiten…</span></div>'));

  const rest = el('<div id="f-rest"></div>');
  rest.appendChild(el('<label><span>Name</span><input type="text" id="f-name" autocomplete="name" maxlength="80"></label>'));
  rest.appendChild(el('<label><span>Telefon</span><input type="tel" id="f-phone" autocomplete="tel" maxlength="40"></label>'));
  rest.appendChild(el('<label><span>Anmerkung (optional)</span><textarea id="f-note" maxlength="300" placeholder="z.B. Kinderstuhl, Geburtstag, Rollstuhl"></textarea></label>'));
  rest.appendChild(el('<label class="versteckt"><span>Website</span><input type="text" id="f-website" tabindex="-1" autocomplete="off"></label>'));
  rest.appendChild(el('<div id="f-melde"></div>'));
  rest.appendChild(el('<button class="senden" id="f-senden" disabled>Reservierung anfragen</button>'));
  rest.appendChild(el('<p class="datenschutz">Wir speichern Name, Telefonnummer und eure Angaben nur, um die Reservierung zu bearbeiten, und löschen sie danach wieder. Weitergegeben wird nichts.</p>'));
  app.appendChild(rest);

  document.getElementById("f-senden").onclick = senden;
  ladeZeiten();
}

async function ladeZeiten() {
  const box = document.getElementById("f-zeiten");
  if (!box) return;
  aktualisiereSendeKnopf();
  box.innerHTML = '<span class="hint">Lade freie Zeiten…</span>';
  try {
    const res = await fetch("slots?date=" + daten.date + "&guests=" + daten.guests + "&area=" + daten.area);
    const d = await res.json();
    box.innerHTML = "";
    if (!d.zeiten || d.zeiten.length === 0) {
      box.appendChild(el('<div class="melde fehler">' + (GRUND_TEXT[d.grund] || "Für diesen Tag ist leider nichts frei.") + '</div>'));
    } else {
      for (const z of d.zeiten) {
        const b = el('<button type="button" class="zeit">' + z + '</button>');
        b.setAttribute("aria-pressed", daten.time === z ? "true" : "false");
        b.onclick = () => { daten.time = z; zeichneZeiten(d.zeiten); aktualisiereSendeKnopf(); };
        box.appendChild(b);
      }
    }
  } catch {
    box.innerHTML = '<div class="melde fehler">Keine Verbindung. Bitte später nochmal versuchen.</div>';
  }
  aktualisiereSendeKnopf();
}

function zeichneZeiten(zeiten) {
  const box = document.getElementById("f-zeiten");
  [...box.querySelectorAll(".zeit")].forEach((b) => b.setAttribute("aria-pressed", b.textContent === daten.time ? "true" : "false"));
}

function aktualisiereSendeKnopf() {
  const b = document.getElementById("f-senden");
  if (!b) return;
  const name = (document.getElementById("f-name")?.value || "").trim();
  const phone = (document.getElementById("f-phone")?.value || "").trim();
  b.disabled = !(daten.time && name && phone);
}
document.addEventListener("input", aktualisiereSendeKnopf);

async function senden() {
  const b = document.getElementById("f-senden");
  const melde = document.getElementById("f-melde");
  b.disabled = true;
  melde.innerHTML = '<div class="melde">Wird gesendet…</div>';
  try {
    const res = await fetch("", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        date: daten.date, time: daten.time, guests: daten.guests, area: daten.area,
        name: document.getElementById("f-name").value,
        phone: document.getElementById("f-phone").value,
        note: document.getElementById("f-note").value,
        website: document.getElementById("f-website").value,
      }),
    });
    const d = await res.json();
    if (!res.ok) {
      melde.innerHTML = '<div class="melde fehler">' + (d.error || "Das hat leider nicht geklappt.") + '</div>';
      b.disabled = false;
      if (res.status === 409) ladeZeiten();
      return;
    }
    const datumText = new Date(daten.date + "T12:00:00").toLocaleDateString("de-DE", { weekday: "long", day: "2-digit", month: "long" });
    app.innerHTML = "";
    app.appendChild(el(
      '<div class="erfolg"><h1>Danke!</h1>' +
      '<p>Wir haben eure Reservierung für <b>' + datumText + ' um ' + daten.time + ' Uhr</b> (' + daten.guests + ' Personen) notiert.</p>' +
      '<p class="hint">Eure Reservierungsnummer:</p><div class="code">' + d.code + '</div>' +
      '<p class="hint">Am besten kurz notieren. Wir melden uns nur, falls es ein Problem gibt.</p></div>'
    ));
  } catch {
    melde.innerHTML = '<div class="melde fehler">Keine Verbindung. Bitte später nochmal versuchen.</div>';
    b.disabled = false;
  }
}

zeichne();
</script>
</body></html>`;
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      // Kurz zwischenspeichern lassen: die Seite ändert sich selten, die freien Zeiten holt sie ohnehin frisch.
      "Cache-Control": "public, max-age=300",
      ...CORS_HEADERS,
    },
  });
}

/** Kleine HTML-Maskierung für die Buchungsseite (der Worker hat sonst keine). */
function escapeHtmlWorker(s) {
  return String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

async function handleAuthLogin(request, env) {
  if (request.method !== "POST") return jsonResponse({ error: "method not allowed" }, 405);
  if (!env.WEBHOOK_SECRET) return jsonResponse({ error: "Worker ist noch nicht fertig eingerichtet." }, 503);

  const key = clientKey(request);
  // Absichtlich dieselbe Formulierung wie bei falschem PIN: verrät nicht, ob ein PIN existiert.
  const rejection = jsonResponse({ error: "PIN nicht erkannt oder zu viele Fehlversuche. Bitte später erneut versuchen." }, 401);
  if (await isLockedOut(env, key)) return rejection;

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "bad request" }, 400);
  }
  const pin = String(body?.pin || "").trim();
  if (!pin) return jsonResponse({ error: "Bitte PIN eingeben." }, 400);

  const state = await getState(env);

  // Sonderfall Ersteinrichtung: der Worker kennt noch überhaupt keine PINs, weil das iPad seit dem Update
  // noch nicht abgeglichen hat. Das ist kein Geheimnis (verrät nichts über gültige PINs), deshalb hier
  // bewusst eine klare Ansage statt der neutralen Ablehnung – sonst sucht man ewig am falschen Ende.
  if (!state.adminPinHash && (state.authPins || []).length === 0) {
    return jsonResponse(
      {
        error:
          "Dieser Zugang ist noch nicht eingerichtet: Das iPad hat seine PINs noch nicht übermittelt. Bitte einmal die App auf dem iPad öffnen (Telegram-Abgleich muss unter Einstellungen aktiv sein) und es danach erneut versuchen.",
      },
      503
    );
  }

  const hash = await hashPin(env.WEBHOOK_SECRET, pin);

  let session = null;
  if (state.adminPinHash && sameHash(hash, state.adminPinHash)) {
    session = { role: "boss", name: "Chef" };
  } else {
    const match = (state.authPins || []).find((p) => sameHash(hash, p.pinHash));
    if (match) session = { role: "employee", name: match.name };
  }

  if (!session) {
    await noteFailedLogin(env, key);
    return rejection;
  }
  await clearFailedLogins(env, key);
  const token = await createSession(env, session);
  return jsonResponse({ token, role: session.role, name: session.name });
}

/** Mitarbeiter-Ansicht: ausschließlich die EIGENEN Daten. Lohnnebenkosten bleiben bewusst draußen (reine
 * Arbeitgeber-Größe), ebenso alles, was andere Personen betrifft. */
async function handleMe(request, env) {
  const guard = await requireSession(request, env, "employee");
  if (guard.error) return guard.error;
  const name = guard.session.name;
  const needle = name.trim().toLowerCase();
  const state = await getState(env);

  const tage = [];
  for (const r of state.financials || []) {
    const mine = (r.perEmployee || []).find((pe) => String(pe.name || "").trim().toLowerCase() === needle);
    if (mine) tage.push({ date: r.date, stunden: round2(mine.hours), lohn: round2(mine.lohn), trinkgeld: round2(mine.tip || 0) });
  }
  const summe = (von, bis) => {
    const rows = tage.filter((t) => t.date >= von && t.date <= bis);
    return {
      stunden: round2(rows.reduce((s, t) => s + t.stunden, 0)),
      lohn: round2(rows.reduce((s, t) => s + t.lohn, 0)),
      trinkgeld: round2(rows.reduce((s, t) => s + t.trinkgeld, 0)),
    };
  };
  const today = todayBerlin();

  const meineSchichten = (state.plannedShifts || [])
    .filter((s) => String(s.employeeName || "").trim().toLowerCase() === needle)
    .map((s) => ({ date: s.date, schicht: s.slotLabel || (s.from && s.to ? `${s.from}-${s.to}` : "") }));

  const meineVerfuegbarkeit = {};
  for (const [weekStart, bucket] of Object.entries(state.availability || {})) {
    const entry = Object.entries(bucket?.entries || {}).find(([n]) => n.trim().toLowerCase() === needle);
    if (entry) meineVerfuegbarkeit[weekStart] = entry[1];
  }

  // Schichten, die für die eigene Rolle angeboten werden (Service und Bar teilen sich einen Plan).
  const meineRolle = (state.employeeRoles || []).find((r) => String(r.name || "").trim().toLowerCase() === needle)?.role || null;
  const meineSchichtarten = state.shiftSlots ? (meineRolle === "kueche" ? state.shiftSlots.kueche : state.shiftSlots.service) || [] : [];

  // Welche Schichten im eigenen Konkurrenz-Pool schon FEST an jemand anderen vergeben sind – damit die
  // Person sie gar nicht erst auswählt. Bewusst OHNE Namen: wer die Schicht hat, geht sie nichts an.
  const belegteSchichten = {};
  for (const bucket of Object.values(state.availability || {})) {
    for (const [otherName, entry] of Object.entries(bucket?.entries || {})) {
      if (otherName.trim().toLowerCase() === needle) continue;
      const otherRole = (state.employeeRoles || []).find((r) => String(r.name || "").trim().toLowerCase() === otherName.trim().toLowerCase())?.role;
      const samePool = (otherRole === "kueche") === (meineRolle === "kueche");
      if (!samePool) continue;
      for (const day of entry?.days || []) {
        if (!day.confirmedSlotId) continue;
        (belegteSchichten[day.date] ||= []).push(day.confirmedSlotId);
      }
    }
  }

  // Fertige Wochenpläne: nur Wochen, die der Chef abgeschlossen hat, und nur ab der laufenden Woche.
  // Hier stehen ausdrücklich die Namen der Kollegen drin – das ist der Sinn der Sache: jeder soll sehen,
  // mit wem er arbeitet und wen er im Zweifel wegen eines Tauschs fragen kann. In der noch offenen Planung
  // (belegteSchichten oben) bleiben die Namen dagegen weiterhin verborgen.
  const aktuellerMontag = mondayOf(today);
  const wochenplaene = (state.publishedWeeks || [])
    .filter((w) => w.weekStart >= aktuellerMontag)
    .sort((a, b) => (a.weekStart < b.weekStart ? -1 : 1))
    .slice(0, 4)
    .map((w) => ({ ...buildWochenplan(state, w.weekStart), publishedAt: w.publishedAt }));

  return jsonResponse({
    name,
    heute: today,
    wochenplaene,
    kennzahlenFreigegeben: (state.financials || []).length > 0,
    dieseWoche: summe(mondayOf(today), today),
    dieserMonat: summe(today.slice(0, 7) + "-01", today),
    tage: tage.slice(-90),
    meineSchichten,
    meineVerfuegbarkeit,
    meineSchichtarten,
    belegteSchichten,
    // Ungelesene Kurznachrichten für diese Person (Schicht zugesagt/abgelehnt) – erscheinen als Pop-up.
    neueNachrichten: (state.employeeNotifications || [])
      .filter((n) => !n.readAt && String(n.employeeName || "").trim().toLowerCase() === needle)
      .map((n) => ({ id: n.id, text: n.text, createdAt: n.createdAt })),
    // Postfach: auch schon gelesene Nachrichten, damit man sie nachlesen kann.
    postfach: (state.employeeNotifications || [])
      .filter((n) => String(n.employeeName || "").trim().toLowerCase() === needle)
      .slice(-50)
      .reverse()
      .map((n) => ({ id: n.id, text: n.text, createdAt: n.createdAt, gelesen: !!n.readAt })),
  });
}

/** Pop-up wurde gesehen -> Nachrichten als gelesen markieren, damit sie nicht erneut erscheinen. */
async function handleMeNotificationsRead(request, env) {
  if (request.method !== "POST") return jsonResponse({ error: "method not allowed" }, 405);
  const guard = await requireSession(request, env, "employee");
  if (guard.error) return guard.error;
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "bad request" }, 400);
  }
  const ids = new Set(Array.isArray(body?.ids) ? body.ids : []);
  if (ids.size === 0) return jsonResponse({ ok: true });
  const needle = guard.session.name.trim().toLowerCase();
  const state = await getState(env);
  const now = new Date().toISOString();
  // Nur eigene Nachrichten dürfen markiert werden – eine fremde ID soll nichts bewirken.
  const next = (state.employeeNotifications || []).map((n) =>
    ids.has(n.id) && String(n.employeeName || "").trim().toLowerCase() === needle && !n.readAt ? { ...n, readAt: now } : n
  );
  await patchState(env, { employeeNotifications: next });
  return jsonResponse({ ok: true });
}

/** Verfügbarkeit vom Handy. Der Name kommt IMMER aus der Sitzung, nie aus dem Request – sonst könnte
 * jemand Verfügbarkeiten im Namen von Kollegen eintragen. */
async function handleMeAvailability(request, env) {
  if (request.method !== "POST") return jsonResponse({ error: "method not allowed" }, 405);
  const guard = await requireSession(request, env, "employee");
  if (guard.error) return guard.error;
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "bad request" }, 400);
  }
  const weekStart = String(body?.weekStart || "");
  const days = Array.isArray(body?.days) ? body.days : [];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) return jsonResponse({ error: "weekStart fehlt oder ist ungültig." }, 400);

  const state = await getState(env);
  const entries = { [guard.session.name]: { submittedAt: new Date().toISOString(), days } };
  await patchState(env, { availability: mergeAvailabilityWeek(state.availability, weekStart, entries) });
  return jsonResponse({ ok: true });
}

/** Krankmeldung vom Handy: geht als Warteschlangen-Eintrag rein, den der iPad übernimmt. Der Chef bekommt
 * sofort eine Telegram-Nachricht, damit er nicht auf den nächsten iPad-Abgleich warten muss. */
async function handleMeSick(request, env) {
  if (request.method !== "POST") return jsonResponse({ error: "method not allowed" }, 405);
  const guard = await requireSession(request, env, "employee");
  if (guard.error) return guard.error;
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "bad request" }, 400);
  }
  const from = String(body?.from || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) return jsonResponse({ error: "Bitte ein gültiges Datum angeben." }, 400);
  const to = /^\d{4}-\d{2}-\d{2}$/.test(body?.to) && body.to >= from ? body.to : from;
  const note = String(body?.note || "").trim().slice(0, 300);

  const state = await getState(env);
  const report = { id: crypto.randomUUID(), employeeName: guard.session.name, from, to, note, createdAt: new Date().toISOString() };
  await patchState(env, { sickReports: [...(state.sickReports || []), report] });

  if (env.OWNER_CHAT_ID) {
    const zeitraum = from === to ? formatDateDe(from) : `${formatDateDe(from)} – ${formatDateDe(to)}`;
    await sendTelegramMessage(env, env.OWNER_CHAT_ID, `🤒 Krankmeldung: ${guard.session.name} (${zeitraum})${note ? `\n„${note}"` : ""}`);
  }
  return jsonResponse({ ok: true });
}

/** Chef-Ansicht (Laptop): voller Stand – aber ohne die PIN-Hashes und ohne den Chat-Verlauf, die gehören
 * in keine Client-Antwort. */
async function handleAdminOverview(request, env) {
  const guard = await requireSession(request, env, "boss");
  if (guard.error) return guard.error;
  const { authPins, adminPinHash, conversationHistory, ...safe } = await getState(env);
  return jsonResponse(safe);
}

/** Spiegelt eine Schicht-Entscheidung sofort in state.availability, damit der Chef am Laptop direkt sieht,
 * dass sie angekommen ist. Bewusst NUR für die betroffene Person: welche Schichten sich gegenseitig
 * blockieren (Service und Bar teilen sich einen Plan, Küche nicht) und die Kaskade daraus kennt allein der
 * iPad – diese Logik wird nicht doppelt gepflegt, sonst laufen beide Seiten irgendwann auseinander. Der iPad
 * korrigiert beim nächsten Abgleich ohnehin auf den maßgeblichen Stand. */
function applyShiftDecisionPreview(availability, employeeName, date, slotLabel, decision, note, state) {
  const needle = employeeName.trim().toLowerCase();
  const next = { ...availability };
  for (const [weekStart, bucket] of Object.entries(availability || {})) {
    const entryKey = Object.keys(bucket?.entries || {}).find((n) => n.trim().toLowerCase() === needle);
    if (!entryKey) continue;
    const entry = bucket.entries[entryKey];
    const dayIdx = (entry.days || []).findIndex((d) => d.date === date);
    if (dayIdx < 0) continue;
    const day = entry.days[dayIdx];
    const slot = (day.slots || []).find((s) => (s.label || "").trim().toLowerCase() === slotLabel.trim().toLowerCase());
    if (!slot) continue;

    const updatedDay =
      decision === "confirm"
        ? { ...day, confirmedSlotId: slot.id, bossConfirmed: true }
        : // Ablehnen: Schicht fällt aus der Auswahl und eine feste Zuteilung wird aufgehoben.
          {
            ...day,
            slots: (day.slots || []).filter((s) => s.id !== slot.id),
            confirmedSlotId: day.confirmedSlotId === slot.id ? null : day.confirmedSlotId,
            bossConfirmed: day.confirmedSlotId === slot.id ? false : day.bossConfirmed,
          };

    const days = [...entry.days];
    days[dayIdx] = { ...updatedDay, note: note !== undefined ? note : day.note };
    next[weekStart] = { ...bucket, entries: { ...bucket.entries, [entryKey]: { ...entry, days } } };
    return next;
  }

  // Kein passender Eintrag vorhanden: der Chef trägt jemanden von Hand ein, der sich für diesen Tag gar
  // nicht gemeldet hat. Beim iPad geht das über confirmAvailability(), das den Eintrag selbst anlegt –
  // hier wird er nur für die Sofort-Anzeige nachgebildet. Bei einer Ablehnung gibt es dagegen nichts
  // anzulegen, da hört die Vorschau auf.
  if (decision !== "confirm") return next;
  const slotDef = findSlotDefinition(state, employeeName, slotLabel);
  if (!slotDef) return next;
  const weekStart = mondayOf(date);
  const bucket = next[weekStart] || { entries: {}, notifiedComplete: false };
  const entryKey = Object.keys(bucket.entries || {}).find((n) => n.trim().toLowerCase() === needle) || employeeName;
  const entry = bucket.entries?.[entryKey] || { submittedAt: new Date().toISOString(), days: [] };
  const days = [...(entry.days || [])];
  const dayIdx = days.findIndex((d) => d.date === date);
  const newDay = {
    date,
    slots: [slotDef],
    confirmedSlotId: slotDef.id,
    bossConfirmed: true,
    note: note || "",
  };
  if (dayIdx >= 0) days[dayIdx] = { ...days[dayIdx], ...newDay, slots: days[dayIdx].slots?.length ? days[dayIdx].slots : [slotDef] };
  else days.push(newDay);
  next[weekStart] = { ...bucket, entries: { ...(bucket.entries || {}), [entryKey]: { ...entry, days } } };
  return next;
}

/** Hängt eine Kurznachricht für die Handy-Ansicht einer Person an (gedeckelt, damit der Speicher nicht
 * unbegrenzt wächst). Gibt die neue Liste zurück, die per patchState geschrieben wird. */
function withEmployeeNotification(state, employeeName, text) {
  const list = Array.isArray(state.employeeNotifications) ? state.employeeNotifications : [];
  return [...list, { id: crypto.randomUUID(), employeeName, text, createdAt: new Date().toISOString(), readAt: null }].slice(-300);
}

/** Ist der Schichtplan dieser Woche abgeschlossen?
 *
 * Das ist der Schalter für alle Schicht-Benachrichtigungen. Solange eine Woche NICHT abgeschlossen ist,
 * bekommt niemand eine Nachricht über Zu- oder Absagen: der Chef plant in Ruhe, schiebt Leute hin und her,
 * und das Team erfährt das Ergebnis erst gebündelt, wenn der Plan wirklich steht. Danach zählt jede weitere
 * Änderung als Änderung am fertigen Plan und geht sofort raus – sonst würde jemand umgeplant, ohne es zu
 * erfahren. */
function istWocheAbgeschlossen(state, datumOderWochenstart) {
  const weekStart = mondayOf(datumOderWochenstart);
  return (state.publishedWeeks || []).some((w) => w.weekStart === weekStart);
}

const kleinschreiben = (s) => String(s || "").trim().toLowerCase();

/** Der fertige Wochenplan einer Woche, so wie er auf Papier aussieht: pro Tag alle Schichten mit Zeiten und
 * der Person, die sie übernimmt. Bewusst inklusive der unbesetzten Schichten (name: null) – auch eine Lücke
 * ist eine Information. Gezeigt wird nur, was der Chef fest eingeteilt hat. */
function buildWochenplan(state, weekStart) {
  const rolleVon = (name) =>
    (state.employeeRoles || []).find((r) => kleinschreiben(r.name) === kleinschreiben(name))?.role || "service";

  // Wer hat an welchem Tag welche Schicht fest? Küche und Service haben eigene Schicht-IDs, die sich
  // überschneiden ("frueh1" gibt es in beiden) – deshalb gehört der Bereich mit in den Schlüssel.
  const zuteilung = new Map();
  const bucket = (state.availability || {})[weekStart];
  for (const [name, entry] of Object.entries(bucket?.entries || {})) {
    for (const day of entry?.days || []) {
      if (!day.confirmedSlotId || !day.bossConfirmed) continue;
      const bereich = rolleVon(name) === "kueche" ? "kueche" : "service";
      zuteilung.set(`${day.date}|${bereich}|${day.confirmedSlotId}`, { name, note: day.note || "" });
    }
  }

  const krankAm = (name, date) =>
    (state.sickReports || []).some(
      (r) => kleinschreiben(r.employeeName) === kleinschreiben(name) && r.from <= date && (r.to || r.from) >= date
    );

  const tage = [];
  for (let i = 0; i < 7; i++) {
    const date = addDaysISO(weekStart, i);
    const schichten = [];
    for (const bereich of ["service", "kueche"]) {
      for (const slot of state.shiftSlots?.[bereich] || []) {
        if (slot.allowedWeekdays && !slot.allowedWeekdays.includes(i)) continue;
        const zeiten = slot.weekdayOverrides?.[i] ? { ...slot, ...slot.weekdayOverrides[i] } : slot;
        const wer = zuteilung.get(`${date}|${bereich}|${slot.id}`);
        schichten.push({
          bereich,
          label: slot.label,
          from: zeiten.from,
          to: zeiten.to,
          name: wer?.name || null,
          krank: wer ? krankAm(wer.name, date) : false,
        });
      }
    }
    tage.push({ date, schichten });
  }
  return { weekStart, tage };
}

/** Die eigenen Schichten einer Person in einer Woche, als fertige Textzeilen für die Sammel-Nachricht. */
function eigeneSchichtenText(plan, name) {
  const zeilen = [];
  for (const tag of plan.tage) {
    for (const s of tag.schichten) {
      if (kleinschreiben(s.name) !== kleinschreiben(name)) continue;
      zeilen.push(`${WEEKDAY_LABELS_DE[wochentagIndex(tag.date)]}, ${formatDateDe(tag.date)}: ${s.label}, ${s.from}–${s.to} Uhr`);
    }
  }
  return zeilen;
}

function wochentagIndex(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return wd === 0 ? 6 : wd - 1;
}

/** Sucht die Schicht-Definition (Zeiten) passend zur Rolle der Person. Die Definitionen kommen vom iPad,
 * damit sie nicht doppelt gepflegt werden. Service und Bar teilen sich denselben Plan. */
function findSlotDefinition(state, employeeName, slotLabel) {
  const slots = state?.shiftSlots;
  if (!slots) return null;
  const needle = employeeName.trim().toLowerCase();
  const role = (state.employeeRoles || []).find((r) => String(r.name || "").trim().toLowerCase() === needle)?.role;
  const list = role === "kueche" ? slots.kueche : slots.service;
  const found = (list || []).find((s) => normalizeSlotLabelCheck(s.label) === normalizeSlotLabelCheck(slotLabel));
  return found ? { id: found.id, label: found.label, from: found.from, to: found.to } : null;
}

/** Chef entscheidet vom Laptop über eine Schicht. Der Eintrag geht in dieselbe Warteschlange, die auch der
 * Telegram-Bot nutzt – der iPad übernimmt ihn beim nächsten Abgleich und bleibt die maßgebliche Instanz. */
async function handleAdminShiftDecision(request, env) {
  if (request.method !== "POST") return jsonResponse({ error: "method not allowed" }, 405);
  const guard = await requireSession(request, env, "boss");
  if (guard.error) return guard.error;
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "bad request" }, 400);
  }
  const employeeName = String(body?.employeeName || "").trim();
  const date = String(body?.date || "");
  const slotLabel = String(body?.slotLabel || "").trim();
  const decision = body?.decision === "reject" ? "reject" : "confirm";
  if (!employeeName || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !slotLabel) {
    return jsonResponse({ error: "Mitarbeiter, Datum und Schicht werden benötigt." }, 400);
  }
  const note = String(body?.note || "").trim().slice(0, 200);
  const state = await getState(env);
  if (!knownSlotLabels(state).has(normalizeSlotLabelCheck(slotLabel))) {
    return jsonResponse({ error: `Unbekannte Schicht "${slotLabel}".` }, 400);
  }
  const entry = { id: crypto.randomUUID(), employeeName, date, slotLabel };
  const patch = { availability: applyShiftDecisionPreview(state.availability, employeeName, date, slotLabel, decision, note, state) };
  if (decision === "confirm") patch.plannedShifts = [...(state.plannedShifts || []), { ...entry, from: "", to: "", note }];
  else patch.shiftRejections = [...(state.shiftRejections || []), entry];

  // Benachrichtigt wird NUR, wenn der Plan dieser Woche schon abgeschlossen ist. Vorher plant der Chef in
  // Ruhe und niemand bekommt Zwischenstände mit – die Info geht gebündelt raus, wenn er die Woche abschließt.
  // Danach ist jede Änderung eine Änderung am fertigen Plan und muss sofort ankommen.
  if (istWocheAbgeschlossen(state, date)) {
    const slotDef = findSlotDefinition(state, employeeName, slotLabel);
    const zeit = slotDef ? `${slotDef.label}, ${slotDef.from}–${slotDef.to} Uhr` : slotLabel;
    patch.employeeNotifications = withEmployeeNotification(
      state,
      employeeName,
      decision === "confirm"
        ? `🔄 Änderung am Schichtplan: Du hast jetzt am ${formatDateDe(date)} die Schicht ${zeit}.${note ? `\n📝 ${note}` : ""}`
        : `🔄 Änderung am Schichtplan: Deine Schicht am ${formatDateDe(date)} (${zeit}) entfällt.`
    );
  }
  await patchState(env, patch);
  return jsonResponse({ ok: true, benachrichtigt: istWocheAbgeschlossen(state, date) });
}

/** Chef schließt den Schichtplan einer Woche ab: ab jetzt sieht das Team den fertigen Plan und bekommt
 * EINE gebündelte Nachricht mit den eigenen Schichten. Auch wer leer ausgegangen ist, wird informiert –
 * sonst wartet die Person weiter auf eine Antwort, die nie kommt.
 *
 * Der Eintrag geht zusätzlich in eine Warteschlange, die der iPad abarbeitet: er bleibt die maßgebliche
 * Instanz, würde die Freigabe sonst aber beim nächsten Abgleich wieder überschreiben. */
async function handleAdminPublishWeek(request, env) {
  if (request.method !== "POST") return jsonResponse({ error: "method not allowed" }, 405);
  const guard = await requireSession(request, env, "boss");
  if (guard.error) return guard.error;
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "bad request" }, 400);
  }
  const weekStart = String(body?.weekStart || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) return jsonResponse({ error: "Woche fehlt oder ist ungültig." }, 400);
  const montag = mondayOf(weekStart);
  const oeffnen = body?.action === "unpublish";
  const state = await getState(env);
  const jetzt = new Date().toISOString();

  if (oeffnen) {
    await patchState(env, {
      publishedWeeks: (state.publishedWeeks || []).filter((w) => w.weekStart !== montag),
      weekPublications: [...(state.weekPublications || []), { id: crypto.randomUUID(), weekStart: montag, action: "unpublish", at: jetzt }].slice(-100),
    });
    return jsonResponse({ ok: true, weekStart: montag, abgeschlossen: false, benachrichtigt: 0 });
  }

  const plan = buildWochenplan(state, montag);
  const wocheEnde = addDaysISO(montag, 6);
  const zeitraum = `${formatDateDe(montag)} – ${formatDateDe(wocheEnde)}`;

  // Wer muss Bescheid wissen? Alle mit einer Schicht – plus alle, die sich für diese Woche gemeldet haben
  // und nichts bekommen haben. Genau die warten sonst vergeblich auf eine Antwort.
  const eingeteilt = new Set();
  for (const tag of plan.tage) for (const s of tag.schichten) if (s.name) eingeteilt.add(s.name);
  const beworben = Object.keys((state.availability || {})[montag]?.entries || {});
  const empfaenger = new Set([...eingeteilt, ...beworben]);

  let notifs = state.employeeNotifications;
  for (const name of empfaenger) {
    const zeilen = eigeneSchichtenText(plan, name);
    const text =
      zeilen.length > 0
        ? `📋 Der Schichtplan für ${zeitraum} steht fest.\n\nDeine Schichten:\n${zeilen.map((z) => `• ${z}`).join("\n")}\n\nDen ganzen Plan siehst du unter „Schichtplan der Woche".`
        : `📋 Der Schichtplan für ${zeitraum} steht fest. Für dich ist diese Woche keine Schicht dabei.\n\nDen ganzen Plan siehst du unter „Schichtplan der Woche".`;
    notifs = withEmployeeNotification({ employeeNotifications: notifs }, name, text);
  }

  await patchState(env, {
    publishedWeeks: [...(state.publishedWeeks || []).filter((w) => w.weekStart !== montag), { weekStart: montag, publishedAt: jetzt }],
    weekPublications: [...(state.weekPublications || []), { id: crypto.randomUUID(), weekStart: montag, action: "publish", at: jetzt }].slice(-100),
    employeeNotifications: notifs,
  });
  return jsonResponse({ ok: true, weekStart: montag, abgeschlossen: true, benachrichtigt: empfaenger.size });
}

/** Vorräte vom Laptop: "wieder da" bzw. eine Lieferung erfassen – beides über die bestehenden
 * Warteschlangen, die der iPad schon abarbeitet. */
async function handleAdminStock(request, env) {
  if (request.method !== "POST") return jsonResponse({ error: "method not allowed" }, 405);
  const guard = await requireSession(request, env, "boss");
  if (guard.error) return guard.error;
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "bad request" }, 400);
  }
  const itemName = String(body?.itemName || "").trim();
  if (!itemName) return jsonResponse({ error: "Artikelname fehlt." }, 400);
  const state = await getState(env);

  if (body?.kind === "delivery") {
    const quantity = Number(body?.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) return jsonResponse({ error: "Bitte eine gültige Menge angeben." }, 400);
    const date = /^\d{4}-\d{2}-\d{2}$/.test(body?.date) ? body.date : todayBerlin();
    const delivery = { id: crypto.randomUUID(), itemName, quantity, unit: String(body?.unit || "").trim(), date };
    await patchState(env, { stockDeliveries: [...(state.stockDeliveries || []), delivery] });
  } else {
    await patchState(env, { stockRestocks: [...(state.stockRestocks || []), { id: crypto.randomUUID(), itemName }] });
  }
  return jsonResponse({ ok: true });
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
  // Schicht-Namen kommen vom iPad, damit ein Umbenennen dort nicht dazu führt, dass der Bot noch die alten
  // Namen anbietet. Doppelte (Service und Küche haben je eine "Mitte") werden zusammengefasst.
  const alleSchichtNamen = [
    ...new Set([...(state.shiftSlots?.service || []), ...(state.shiftSlots?.kueche || [])].map((s) => s.label).filter(Boolean)),
  ];
  if (alleSchichtNamen.length === 0) alleSchichtNamen.push("Früh1", "Früh2", "Mittel", "Spät1", "Spät2"); // noch nichts synchronisiert
  const schichtNamenText = alleSchichtNamen.map((n) => `"${n}"`).join(", ");
  // Schichten, die IMMER eine ausdrückliche Bestätigung brauchen (intern die ID "mittel").
  const mittelNamen =
    [...(state.shiftSlots?.service || []), ...(state.shiftSlots?.kueche || [])]
      .filter((s) => s.id === "mittel")
      .map((s) => s.label)
      .join(" / ") || "Mittel";
  const tool = {
    name: "handle_message",
    description: "Interpretiert eine Nachricht des Café-Betreibers ans Team-Aufgaben-System.",
    input_schema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["add", "delete", "complete", "list", "who", "stats", "availability", "plan_shifts", "reject_shift", "notify", "stock_list", "restock", "notes", "ask_anything", "other"],
        },
        stats_period: {
          type: "string",
          enum: ["today", "yesterday", "week", "lastweek", "month", "custom"],
          description:
            "Nur bei action=stats: welcher Zeitraum gewünscht ist. Ohne klaren Hinweis: 'today'. 'custom' setzen, wenn der Nutzer ein konkretes Start- und Enddatum nennt (z.B. 'vom 1. bis 5. August') – dann zusätzlich stats_from/stats_to setzen.",
        },
        stats_from: {
          type: "string",
          description: "Nur bei action=stats mit stats_period='custom': Start-Datum als YYYY-MM-DD.",
        },
        stats_to: {
          type: "string",
          description: "Nur bei action=stats mit stats_period='custom': End-Datum als YYYY-MM-DD (bei nur einem genannten Tag gleich stats_from).",
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
                enum: ["", ...alleSchichtNamen],
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
                enum: alleSchichtNamen,
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
- "stats": der Nutzer will Kennzahlen/Zusammenfassung (Umsatz, Lohnkosten, Stunden, Umschlag) sehen, z.B. "wie war der Umsatz heute", "kennzahlen", "wie lief die Woche", "wie war letzte Woche", "Zusammenfassung diesen Monat". stats_period entsprechend setzen (lastweek = die Woche VOR der aktuellen). Nennt der Nutzer ein konkretes Datum oder einen konkreten Zeitraum (z.B. "vom 1. bis 5. August", "am 12.08.", "zwischen dem 3. und 10. August"), stats_period="custom" setzen und stats_from/stats_to als YYYY-MM-DD auflösen (Jahr aus dem heutigen Datum ergänzen, falls nicht genannt). Bezieht sich die Frage auf eine einzelne Person und deren Arbeitsstunden/Lohn (z.B. "wie viele Stunden hat Anna diese Woche gemacht", "was hat Timm vom 1.-5. August gearbeitet"), zusätzlich stats_employee_name auf den erkannten Namen setzen.
- "stock_list": der Chef will wissen, was an Vorräten fehlt oder knapp ist, z.B. "was fehlt", "einkaufsliste", "was müssen wir nachkaufen".
- "restock": der Chef meldet, dass ein oder mehrere Artikel wieder aufgefüllt/vorhanden sind, z.B. "Kaffeebohnen sind wieder da", "Milch und Servietten sind nachgefüllt" (zwei Einträge in items_to_restock).
- "notes": der Chef will die gesammelten Mitarbeiter-Notizen sehen, z.B. "nachrichten", "was haben die Mitarbeiter geschrieben", "zeig mir die Notizen".
- "plan_shifts": der Chef legt fest, wer wann arbeitet – entweder den ganzen Wochenplan auf einmal ("Wochenplan: Montag Anna 10-18, Dienstag Timm 9-17") oder gezielt EINER Person eine ihrer gemeldeten Verfügbarkeiten zuweisen ("Anna bekommt Montag Früh1", "Timm soll Mittwoch die Spät2 machen"). Nennt der Chef den Schicht-NAMEN statt einer Uhrzeit, slotLabel setzen und from/to leer lassen – slotLabel MUSS exakt einer dieser Werte sein: ${schichtNamenText} (keine anderen Varianten, keine Uhrzeiten, keine Rollenbezeichnung erfinden – bei Unsicherheit lieber nachfragen als raten) – das sorgt dafür, dass die Zuweisung korrekt mit der Verfügbarkeits-Auswahl der Person verrechnet wird (inkl. Ausgrauen für andere). Nur bei expliziter Uhrzeitangabe from/to statt slotLabel nutzen. Mittelschichten (${mittelNamen}) werden NIE automatisch bestätigt, egal was die Person ausgewählt hat – wenn der Chef eine Bestätigung ausspricht ("bestätige Annas Mittel-Schicht am Montag", "Anna bekommt Montag Mittel"), ganz normal als plan_shifts mit dem passenden Mittelschicht-Namen behandeln, das markiert sie dann als bestätigt. IMMER jede einzelne Schicht als eigenen Eintrag in shifts_to_add auflisten, niemals mehrere zusammenfassen. Wochentage ohne explizites Datum beziehen sich auf die oben genannte Zielwoche.
- "availability": der Chef will die gesammelten Verfügbarkeiten der Mitarbeiter für die kommende Woche sehen, z.B. "wer kann wann", "verfügbarkeiten", "wie sieht die Verfügbarkeit für nächste Woche aus".
- "reject_shift": der Chef lehnt eine gemeldete oder bereits gehaltene Schicht einer Person ab, z.B. "lehn Annas Mittel-Schicht am Montag ab", "Anna kann die Spät2 am Mittwoch nicht bekommen", "Timms Früh1 am Montag geht nicht". Person bekommt die Schicht entzogen (bei anderen wieder frei) und eine Nachricht, dass sie sich neu entscheiden muss.
- "notify": der Chef will einer oder mehreren Personen eine freie Nachricht schicken, die im Kiosk als Pop-up erscheint, z.B. "Sag Anna, sie soll morgen 30 Min früher kommen", "Schreib Timm: Danke für die Vertretung gestern!", "Richte allen aus, dass am Montag Inventur ist" (dann für JEDE bekannte aktive Person einen eigenen Eintrag in messages_to_send anlegen). IMMER jede Nachricht als eigenen Eintrag, auch bei mehreren Empfängern.
- "ask_anything": eine Frage, Bitte um Einschätzung/Vergleich/Erklärung oder etwas Analytisches, das sich mit den vorhandenen Daten beantworten lässt, aber zu keiner der obigen festen Aktionen passt (z.B. "wieso war der Umschlag diese Woche schlechter", "vergleich diesen Monat mit letztem", "was denkst du, sollten wir mehr Personal am Wochenende einplanen", offene Rückfragen zu einer vorherigen Antwort). Auch nutzen, wenn eine der festen Aktionen zwar thematisch passen würde, die Frage aber offensichtlich mehr Kontext/Begründung will als die feste Antwort liefert.
- "other": wirklich nichts davon, z.B. Small Talk, Test-Nachricht, oder komplett unverständlich.
Bei "delete" und "complete" die [id] exakt aus der Liste oben in task_ids_to_delete bzw. task_ids_to_complete übernehmen, nur bei eindeutigen Treffern.`;

  // Letzte Nachrichten als Kontext mitgeben, damit Rückfragen ("und Timm?") richtig aufgelöst werden.
  const history = (state.conversationHistory || []).slice(-6).map((h) => ({ role: h.role, content: h.text }));
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: AI_MODEL,
      max_tokens: 1536,
      system,
      tools: [tool],
      tool_choice: { type: "tool", name: "handle_message" },
      messages: [...history, { role: "user", content: text }],
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
  const heading = items.length === 1 ? "🧾 Verkauf erkannt:" : `🧾 ${items.length} Produkte erkannt:`;
  // Bewusst kein "ist verrechnet": das passiert erst beim nächsten iPad-Abgleich, und für ein neu
  // angelegtes Rezept ohne Zutaten passiert es gar nicht, bis der Chef die Zutaten eingetragen hat.
  return [
    heading,
    ...lines,
    "",
    "Wird beim nächsten Abgleich mit dem Bestand verrechnet. Unbekannte Produkte lege ich automatisch an – die stehen dann am Laptop unter Bestand zum Einordnen.",
  ].join("\n");
}

/** Liest ein Foto per Claude Vision aus und erkennt dabei selbst, ob es ein Lieferschein/eine Rechnung
 * (gelieferte Artikel + Menge) oder ein SumUp-Verkaufsbericht (verkaufte Produkte + Anzahl) ist. Wirft bei
 * echten Fehlern (Anthropic nicht erreichbar o.ä.). */
async function extractStockDocument(env, imageBase64, mimeType, caption, today, state) {
  // Was das System schon kennt, wird mitgegeben: so bekommt "Capp. gross" dieselbe Einordnung wie das
  // bereits vorhandene "Cappuccino", statt beim naechsten Bericht anders zu landen.
  const bekannteProdukte = [
    ...(state?.recipes || []).map((r) => `- ${r.productName} = rezept`),
    ...(state?.stock || []).map((s) => `- ${s.name} = artikel`),
  ]
    .slice(0, 120)
    .join("\n");
  const tool = {
    name: "extract_stock_document",
    description:
      "Erkennt die Art eines Beleg-Fotos/PDFs (Lieferschein/Rechnung/Bestellung ODER SumUp-Verkaufsbericht) und extrahiert die jeweils relevanten Positionen.",
    input_schema: {
      type: "object",
      properties: {
        documentType: {
          type: "string",
          enum: ["lieferschein", "verkaufsbericht"],
          description:
            "'lieferschein' für Lieferschein/Rechnung/Bestellung/Auftragsbestätigung (Wareneingang, auch mehrseitig mit vielen Positionen), 'verkaufsbericht' für einen SumUp-Verkaufs-/Kassenbericht (Warenausgang).",
        },
        items: {
          type: "array",
          description:
            "Nur tatsächlich auf dem Beleg erkennbare Positionen, nichts erfinden. Bei langen Bestellungen/Lieferscheinen mit vielen Zeilen ALLE Positionen auflisten, keine auslassen oder zusammenfassen. Reine Pfand-/Leergut-Zeilen (z.B. 'MW LEERGUT') NICHT mit aufnehmen, das ist kein Vorrats-Artikel.",
          items: {
            type: "object",
            properties: {
              itemName: {
                type: "string",
                description:
                  "Nur bei documentType=lieferschein: Artikelname wie auf dem Beleg, inkl. Packungsgröße falls angegeben (z.B. '500g Alpensalz', '1l Milch') – ohne die Bestellmenge selbst.",
              },
              quantity: {
                type: "number",
                description:
                  "Nur bei documentType=lieferschein: die TATSÄCHLICH gelieferte Stückzahl der einzelnen Verkaufs-/Verbrauchseinheit (z.B. einzelne Flaschen, Beutel, Packungen) – NICHT einfach die rohe Bestell-Menge kopieren. Gibt der Beleg zusätzlich zur Menge ein Gebinde/eine Packungsgröße an (z.B. Spalte 'Gebinde' mit '20er', '12er', '6er' = Stück pro Kasten/Karton), dann Menge MAL Gebinde-Größe rechnen (z.B. Menge 4, Gebinde '20er' → quantity 80). Ohne erkennbares Gebinde (oder Gebinde '1er') einfach die Menge-Spalte direkt übernehmen. Das ist wichtig, damit die Zahl später 1:1 mit einzeln verkauften Stück (z.B. aus einem Kassenbericht) vergleichbar ist.",
              },
              unit: {
                type: "string",
                description:
                  "Nur bei documentType=lieferschein: die Einheit des EINZELNEN Stücks aus 'quantity' (z.B. 'Flasche', 'Stück', 'Packung', 'Beutel'), nicht die Bestell-/Liefer-Verpackung (also nicht 'Kasten'/'Karton'/'Kiste'). Nur 'kg'/'l'/'g'/'ml' verwenden, wenn der Beleg die Menge selbst direkt in dieser Einheit angibt (z.B. '50 kg Kaffeebohnen lose'), nicht wenn nur die Packungsgröße im Artikelnamen steht.",
              },
              productName: { type: "string", description: "Nur bei documentType=verkaufsbericht: Produktname, wie im Bericht (z.B. 'Cappuccino')." },
              quantitySold: { type: "number", description: "Nur bei documentType=verkaufsbericht: verkaufte Anzahl als Zahl." },
              kind: {
                type: "string",
                enum: ["artikel", "rezept"],
                description:
                  "Nur bei documentType=verkaufsbericht: Wird dieses Produkt so, wie es verkauft wird, auch EINGEKAUFT ('artikel', 1 Verkauf = 1 Stück weniger im Lager, z.B. Flaschengetränke, Dosen, zugekaufte Snacks), oder wird es im Café aus mehreren Zutaten ZUBEREITET ('rezept', z.B. Cappuccino aus Bohnen und Milch, Bowls, Cocktails)? Im Zweifel IMMER 'rezept' wählen: ein Rezept ohne Zutaten zieht nichts ab und richtet keinen Schaden an, ein falscher Artikel zieht dagegen von einem Lagerbestand ab, den es gar nicht gibt.",
              },
            },
          },
        },
        date: { type: "string", description: "Datum auf dem Beleg als YYYY-MM-DD, falls erkennbar, sonst leerer String." },
      },
      required: ["documentType", "items"],
    },
  };
  // PDFs gehen als "document"-Content-Block rein, Fotos als "image" – beides von Claude direkt unterstützt
  // (kein Beta-Header nötig, alle aktiven Modelle können PDFs visuell auswerten).
  const fileBlock =
    mimeType === "application/pdf"
      ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: imageBase64 } }
      : { type: "image", source: { type: "base64", media_type: mimeType, data: imageBase64 } };
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: AI_MODEL,
      // Großzügig bemessen: mehrseitige Lieferscheine/Bestellungen (z.B. Großhändler wie METRO) können
      // 40+ Positionen haben – bei zu knappem Limit bricht die Antwort mitten in der Artikel-Liste ab und
      // wirkt dann wie "nichts erkannt".
      max_tokens: 8192,
      tools: [tool],
      tool_choice: { type: "tool", name: "extract_stock_document" },
      messages: [
        {
          role: "user",
          content: [
            fileBlock,
            {
              type: "text",
              text: `Heute ist ${today} (Europe/Berlin). Das ist ein Beleg für ein Café (Foto oder PDF, ggf. auch mehrseitig): entweder ein Lieferschein/eine Rechnung/Bestellung/Auftragsbestätigung eines Großhändlers (Wareneingang) oder ein SumUp-Verkaufs-/Kassenbericht (Warenausgang, zeigt verkaufte Produkte mit Stückzahl).${
                caption ? ` Nachricht des Chefs dazu: "${caption}".` : ""
              } Bestimme zuerst documentType, extrahiere dann ALLE passenden Positionen von JEDER Seite, auch bei langen Listen. Achte bei Lieferungen besonders auf eine Gebinde-/Verpackungsspalte (z.B. "20er", "12er", "6er") und rechne sie in die tatsächliche Stückzahl der Verkaufseinheit (Flasche/Stück/Packung) um, NICHT die rohe Bestellmenge übernehmen – sonst passt der Bestand später nicht mehr zu einzeln verkauften Stück aus einem Kassenbericht.${
                bekannteProdukte ? `\n\nDiese Produkte kennt das System schon, mit ihrer jeweiligen Einordnung – halte dich bei gleichen oder sehr ähnlichen Namen unbedingt an dieselbe Einordnung:\n${bekannteProdukte}` : ""
              }`,
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

/** Lädt eine Foto- oder PDF-Datei einer Telegram-Nachricht (per file_id) herunter, lässt sie per Vision
 * auswerten und verarbeitet sie je nach erkanntem Dokument-Typ als Lieferung (Bestand rauf) oder
 * Verkaufsbericht (Bestand über die Rezept-Zutaten runter). knownMimeType kommt bei Dokumenten direkt von
 * Telegram mit; bei Fotos gibt es das nicht, dort wird die Endung der heruntergeladenen Datei geraten. */
async function handleStockDocument(env, chatId, fileId, knownMimeType, caption, today, state) {
  try {
    const fileRes = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getFile?file_id=${fileId}`);
    const fileData = await fileRes.json();
    const filePath = fileData?.result?.file_path;
    if (!filePath) throw new Error("Konnte die Datei nicht von Telegram laden.");
    const fileDownload = await fetch(`https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${filePath}`);
    if (!fileDownload.ok) throw new Error("Konnte die Datei nicht herunterladen.");
    const buffer = await fileDownload.arrayBuffer();
    const base64 = arrayBufferToBase64(buffer);
    const mimeType = knownMimeType || (filePath.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg");

    const ergebnis = await verarbeiteBeleg(env, base64, mimeType, caption, today, state);
    await sendTelegramMessage(env, chatId, ergebnis.text);
  } catch (e) {
    await sendTelegramMessage(env, chatId, `⚠ Fehler beim Verarbeiten der Datei: ${e.message}`);
  }
}

/** Wertet einen Beleg aus und schreibt das Erkannte in die passende Warteschlange. Von Telegram UND vom
 * Laptop-Upload genutzt, damit beide Wege exakt gleich funktionieren (und nicht mit der Zeit auseinanderlaufen).
 * Gibt den Antworttext plus die erkannten Positionen zurück, damit der Laptop sie anzeigen kann. */
async function verarbeiteBeleg(env, base64, mimeType, caption, today, state) {
  const extracted = await extractStockDocument(env, base64, mimeType, caption, today, state);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(extracted.date) ? extracted.date : today;

  if (extracted.documentType === "verkaufsbericht") {
    const items = (Array.isArray(extracted.items) ? extracted.items : [])
      .map((it) => ({
        id: crypto.randomUUID(),
        productName: String(it.productName || "").trim(),
        quantitySold: Number(it.quantitySold) || 0,
        // Vorschlag, ob das ein eingekaufter Artikel oder ein zubereitetes Rezept ist. Bewusst nur ein
        // Vorschlag – das iPad legt danach an, markiert aber als "bitte prüfen".
        kind: it.kind === "artikel" ? "artikel" : "rezept",
        date,
      }))
      .filter((it) => it.productName && it.quantitySold > 0);
    if (items.length === 0) return { art: "verkaufsbericht", items: [], text: "Konnte im Verkaufsbericht keine Produkte erkennen." };
    await patchState(env, { stockSales: [...(state.stockSales || []), ...items] });
    return { art: "verkaufsbericht", items, text: buildSalesReply(items) };
  }

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
    return { art: "lieferschein", items: [], text: "Konnte darauf keine Artikel erkennen. Ist es ein Lieferschein/eine Rechnung/Bestellung?" };
  }

  await patchState(env, { stockDeliveries: [...(state.stockDeliveries || []), ...items] });

  const stock = state.stock || [];
  const unresolved = items.filter((it) => {
    const needle = it.itemName.toLowerCase();
    return !stock.some((s) => s.name.trim().toLowerCase() === needle || s.name.trim().toLowerCase().includes(needle));
  });
  let text = buildDeliveryReply(items);
  if (unresolved.length > 0) {
    // Diese Artikel legt der iPad beim nächsten Abgleich selbst an – kein manueller Schritt nötig,
    // aber ein Blick lohnt sich (Schreibweise, Warnschwelle).
    text += `\n\nℹ Neu in der Vorräte-Liste, wird automatisch angelegt: ${unresolved
      .map((it) => it.itemName)
      .join(", ")}. Schau bei Gelegenheit unter Vorräte, ob Schreibweise und Warnschwelle passen.`;
  }
  return { art: "lieferschein", items, unresolved: unresolved.map((it) => it.itemName), text };
}

/** Artikel anlegen/bearbeiten/löschen bzw. Menge korrigieren – vom Laptop aus. Geht als Warteschlangen-
 * Eintrag rein, den der iPad abarbeitet (dort liegt die maßgebliche Vorräte-Liste). */
async function handleAdminStockItem(request, env) {
  if (request.method !== "POST") return jsonResponse({ error: "method not allowed" }, 405);
  const guard = await requireSession(request, env, "boss");
  if (guard.error) return guard.error;
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "bad request" }, 400);
  }
  const kind = body?.kind;
  if (!["create", "update", "delete", "setAmount", "reviewed"].includes(kind)) return jsonResponse({ error: "Unbekannte Aktion." }, 400);
  if (kind === "create" && !String(body?.name || "").trim()) return jsonResponse({ error: "Bitte einen Artikelnamen angeben." }, 400);
  if (kind !== "create" && !String(body?.itemId || "").trim()) return jsonResponse({ error: "Artikel fehlt." }, 400);
  if (kind === "setAmount" && !Number.isFinite(Number(body?.currentAmount))) return jsonResponse({ error: "Bitte eine gültige Menge angeben." }, 400);

  const eintrag = {
    id: crypto.randomUUID(),
    kind,
    itemId: String(body?.itemId || "") || null,
    name: String(body?.name || "").trim(),
    unit: body?.unit === undefined ? undefined : String(body.unit).trim(),
    lowThreshold: body?.lowThreshold === undefined ? undefined : Number(body.lowThreshold) || 0,
    currentAmount: body?.currentAmount === undefined ? undefined : Number(body.currentAmount) || 0,
  };
  const state = await getState(env);
  await patchState(env, { stockChanges: [...(state.stockChanges || []), eintrag] });
  return jsonResponse({ ok: true });
}

/** Rezepte anlegen/bearbeiten/löschen – vom Laptop aus, ebenfalls über eine Warteschlange. */
async function handleAdminRecipe(request, env) {
  if (request.method !== "POST") return jsonResponse({ error: "method not allowed" }, 405);
  const guard = await requireSession(request, env, "boss");
  if (guard.error) return guard.error;
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "bad request" }, 400);
  }
  const kind = body?.kind;
  if (!["create", "update", "delete", "reviewed"].includes(kind)) return jsonResponse({ error: "Unbekannte Aktion." }, 400);
  if (kind !== "create" && !String(body?.recipeId || "").trim()) return jsonResponse({ error: "Rezept fehlt." }, 400);
  if (!["delete", "reviewed"].includes(kind) && !String(body?.productName || "").trim()) return jsonResponse({ error: "Bitte einen Produktnamen angeben." }, 400);

  const zutaten = (Array.isArray(body?.ingredients) ? body.ingredients : [])
    .map((z) => ({ stockItemId: String(z?.stockItemId || ""), amount: Number(z?.amount) || 0 }))
    .filter((z) => z.stockItemId && z.amount > 0);

  const eintrag = {
    id: crypto.randomUUID(),
    kind,
    recipeId: String(body?.recipeId || "") || null,
    productName: String(body?.productName || "").trim(),
    ingredients: zutaten,
  };
  const state = await getState(env);
  await patchState(env, { recipeChanges: [...(state.recipeChanges || []), eintrag] });
  return jsonResponse({ ok: true });
}

/** Mitarbeiter anlegen/bearbeiten/deaktivieren – vom Laptop aus. Der PIN ist bewusst NICHT dabei: der wird
 * weiterhin nur am iPad vergeben, damit kein PIN im Klartext über das Netz geht oder hier zwischenliegt. */
async function handleAdminEmployee(request, env) {
  if (request.method !== "POST") return jsonResponse({ error: "method not allowed" }, 405);
  const guard = await requireSession(request, env, "boss");
  if (guard.error) return guard.error;
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "bad request" }, 400);
  }
  const kind = body?.kind;
  if (!["create", "update", "deactivate", "activate"].includes(kind)) return jsonResponse({ error: "Unbekannte Aktion." }, 400);
  if (kind !== "create" && !String(body?.employeeId || "").trim()) return jsonResponse({ error: "Mitarbeiter fehlt." }, 400);
  if (["create", "update"].includes(kind) && !String(body?.name || "").trim()) return jsonResponse({ error: "Bitte einen Namen angeben." }, 400);
  const rollen = ["service", "kueche", "bar"];
  if (["create", "update"].includes(kind) && !rollen.includes(body?.role)) return jsonResponse({ error: "Bitte eine gültige Rolle wählen." }, 400);

  const eintrag = {
    id: crypto.randomUUID(),
    kind,
    employeeId: String(body?.employeeId || "") || null,
    name: String(body?.name || "").trim(),
    role: body?.role,
    hourlyWage: Number(body?.hourlyWage) || 0,
    isMinijob: !!body?.isMinijob,
    minijobLimit: Number(body?.minijobLimit) || 556,
  };
  const state = await getState(env);
  await patchState(env, { employeeChanges: [...(state.employeeChanges || []), eintrag] });
  return jsonResponse({ ok: true });
}

/** Freie Nachricht an eine Person (oder alle) – landet im Postfach der Handy-Ansicht. */
async function handleAdminMessage(request, env) {
  if (request.method !== "POST") return jsonResponse({ error: "method not allowed" }, 405);
  const guard = await requireSession(request, env, "boss");
  if (guard.error) return guard.error;
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "bad request" }, 400);
  }
  const text = String(body?.text || "").trim().slice(0, 1000);
  if (!text) return jsonResponse({ error: "Bitte einen Text eingeben." }, 400);

  const state = await getState(env);
  const alle = state.employees || [];
  const empfaenger = body?.toAll ? alle : alle.filter((n) => n === String(body?.employeeName || "").trim());
  if (empfaenger.length === 0) return jsonResponse({ error: "Kein Empfänger gefunden." }, 400);

  let notifs = state.employeeNotifications;
  for (const name of empfaenger) notifs = withEmployeeNotification({ employeeNotifications: notifs }, name, `💬 ${text}`);
  // Zusätzlich als Pop-up im Kiosk am iPad, damit es auch dort ankommt.
  const kiosk = (Array.isArray(state.employeeMessages) ? state.employeeMessages : []).concat(
    empfaenger.map((name) => ({ id: crypto.randomUUID(), employeeName: name, text }))
  );
  await patchState(env, { employeeNotifications: notifs, employeeMessages: kiosk });
  return jsonResponse({ ok: true, empfaenger: empfaenger.length });
}

/** Beleg-Upload aus der Laptop-Ansicht (PDF oder Foto). Nutzt denselben Weg wie der Telegram-Upload. */
async function handleAdminDocument(request, env) {
  if (request.method !== "POST") return jsonResponse({ error: "method not allowed" }, 405);
  const guard = await requireSession(request, env, "boss");
  if (guard.error) return guard.error;
  if (!env.ANTHROPIC_API_KEY) return jsonResponse({ error: "ANTHROPIC_API_KEY fehlt im Worker." }, 503);

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "bad request" }, 400);
  }
  const mimeType = String(body?.mimeType || "");
  const base64 = String(body?.dataBase64 || "");
  const ERLAUBT = ["application/pdf", "image/jpeg", "image/png"];
  if (!ERLAUBT.includes(mimeType)) {
    return jsonResponse({ error: "Nur PDF, JPG oder PNG können ausgewertet werden." }, 400);
  }
  if (!base64) return jsonResponse({ error: "Keine Datei empfangen." }, 400);
  // Grobe Größenprüfung (Base64 ist ca. 4/3 der Dateigröße). Anthropic nimmt max. 32 MB pro Anfrage.
  if (base64.length > 24 * 1024 * 1024) {
    return jsonResponse({ error: "Die Datei ist zu groß (max. ca. 18 MB)." }, 400);
  }

  try {
    const state = await getState(env);
    const ergebnis = await verarbeiteBeleg(env, base64, mimeType, String(body?.caption || ""), todayBerlin(), state);
    return jsonResponse(ergebnis);
  } catch (e) {
    return jsonResponse({ error: e.message }, 502);
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
        // ✅fest = fertig entschieden, 🔶wartet auf Bestätigung = "Mittel", einzeln gewählt aber noch nicht
        // von dir bestätigt, 🕓Kandidat = Person hat mehrere Schichten zur Auswahl gemeldet, du musst noch
        // entscheiden wer von wem welche bekommt.
        const marker = isConfirmedHere ? (dayEntry.bossConfirmed ? " ✅fest" : " 🔶wartet auf Bestätigung") : " 🕓Kandidat";
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

/** customFrom/customTo (YYYY-MM-DD) nur bei period="custom" relevant – konkreter, vom Nutzer genannter
 * Zeitraum statt eines der festen Presets. */
function buildStatsReply(state, period, today, employeeName, customFrom, customTo) {
  const financials = state.financials || [];
  if (financials.length === 0) {
    return `Noch keine Kennzahlen freigegeben oder synchronisiert. Unter Admin → Einstellungen bei „Telegram-Aufgaben abgleichen" die Kennzahlen-Freigabe aktivieren, danach einmal die App öffnen.`;
  }
  let from, to, label;
  if (period === "custom" && /^\d{4}-\d{2}-\d{2}$/.test(customFrom)) {
    from = customFrom;
    to = /^\d{4}-\d{2}-\d{2}$/.test(customTo) && customTo >= customFrom ? customTo : customFrom;
    label = from === to ? `Am ${formatDateDe(from)}` : `${formatDateDe(from)} – ${formatDateDe(to)}`;
  } else {
    ({ from, to } = periodRange(period, today));
    label = PERIOD_LABEL[period] || "Heute";
  }
  const rows = financials.filter((r) => r.date >= from && r.date <= to);
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
async function generateInsights(env, financials, daysBack = 14) {
  if (!Array.isArray(financials) || financials.length < 3 || !env.ANTHROPIC_API_KEY) return null;
  const recent = financials.slice(-daysBack);
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
      body: JSON.stringify({ model: AI_MODEL, max_tokens: 400, messages: [{ role: "user", content: prompt }] }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const block = (data.content || []).find((b) => b.type === "text");
    return block?.text?.trim() || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------
// Freies Fragen & Antworten (action="ask_anything") – agentisch: statt einen festen Daten-Ausschnitt in
// jeden Prompt zu packen, bekommt Claude Werkzeuge und entscheidet SELBST, welche Daten es für die konkrete
// Frage braucht (auch mehrere Abfragen nacheinander, z.B. zwei Zeiträume zum Vergleichen). Erfindet/schätzt
// nichts, was die Werkzeuge nicht tatsächlich liefern – sagt stattdessen ehrlich, wenn Daten fehlen.
// ---------------------------------------------------------------------
const ASK_TOOLS = [
  {
    name: "get_financials",
    description: "Liefert Tageskennzahlen (Umsatz, Lohn, Lohnnebenkosten, Stunden, Umschlag) für einen Datumsbereich (bis zu ca. 6 Monate zurück).",
    input_schema: {
      type: "object",
      properties: {
        from: { type: "string", description: "YYYY-MM-DD, Start des Zeitraums. Ohne Angabe: ältester verfügbarer Tag." },
        to: { type: "string", description: "YYYY-MM-DD, Ende des Zeitraums. Ohne Angabe: neuester verfügbarer Tag." },
      },
    },
  },
  {
    name: "get_employee_summary",
    description: "Summiert Arbeitsstunden, Lohn und Lohnnebenkosten EINER Person über einen Zeitraum.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Name der Person aus der Mitarbeiterliste." },
        from: { type: "string", description: "YYYY-MM-DD, Start. Ohne Angabe: ältester verfügbarer Tag." },
        to: { type: "string", description: "YYYY-MM-DD, Ende. Ohne Angabe: neuester verfügbarer Tag." },
      },
      required: ["name"],
    },
  },
  {
    name: "get_tasks",
    description: "Listet Aufgaben.",
    input_schema: { type: "object", properties: { status: { type: "string", enum: ["open", "done", "all"], description: "Default: 'open'." } } },
  },
  {
    name: "get_stock",
    description: "Listet den aktuellen Vorräte-Stand (Ampel-Status, bei mengengeführten Artikeln auch Bestand/Einheit).",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "get_shift_plan",
    description:
      "Schichtplanung: wer arbeitet wann (fest eingeplante Schichten) und wer hätte sich für welche Schicht bereit gemeldet (Verfügbarkeiten inkl. Status: fest bestätigt / wartet auf Bestätigung / nur Kandidat unter mehreren).",
    input_schema: {
      type: "object",
      properties: {
        from: { type: "string", description: "YYYY-MM-DD, Start des Zeitraums. Ohne Angabe: alles Bekannte." },
        to: { type: "string", description: "YYYY-MM-DD, Ende des Zeitraums. Ohne Angabe: alles Bekannte." },
        name: { type: "string", description: "Optional: nur die Schichten/Verfügbarkeiten dieser Person." },
      },
    },
  },
  {
    name: "get_employees",
    description:
      "Liste der aktiven Mitarbeiter, inkl. Minijob-Status und Verdienstgrenze (soweit bekannt), wer aktuell eingestempelt ist und wo das Ausstempeln vergessen wurde.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "get_employee_notes",
    description: "Notizen/Nachrichten, die Mitarbeiter aus ihrem Kiosk-Fenster an den Chef geschickt haben (mit Datum und Name).",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Optional: nur Notizen dieser Person." },
        limit: { type: "number", description: "Wie viele der neuesten Notizen, Default 30." },
      },
    },
  },
  {
    name: "get_stock_movements",
    description:
      "Warenbewegungen: per Lieferschein/Bestellung erfasste Lieferungen (Wareneingang) und per Verkaufsbericht erfasste Verkäufe (Warenausgang), jeweils mit Datum und Menge.",
    input_schema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["deliveries", "sales", "all"], description: "Default: 'all'." },
        from: { type: "string", description: "YYYY-MM-DD, Start. Ohne Angabe: alles Bekannte." },
        to: { type: "string", description: "YYYY-MM-DD, Ende. Ohne Angabe: alles Bekannte." },
      },
    },
  },
];

function toolGetFinancials(state, input) {
  const financials = Array.isArray(state.financials) ? state.financials : [];
  if (financials.length === 0) return { error: "Keine Kennzahlen freigegeben oder noch nicht synchronisiert (siehe Admin → Einstellungen)." };
  const from = /^\d{4}-\d{2}-\d{2}$/.test(input?.from) ? input.from : financials[0].date;
  const to = /^\d{4}-\d{2}-\d{2}$/.test(input?.to) ? input.to : financials[financials.length - 1].date;
  const rows = financials
    .filter((r) => r.date >= from && r.date <= to)
    .map((r) => ({
      date: r.date,
      status: r.status,
      umsatzGesamt: round2(r.umsatzGesamt),
      totalLohn: round2(r.totalLohn),
      totalLohnnebenkosten: round2(r.totalLohnnebenkosten || 0),
      totalHours: round2(r.totalHours),
      umschlag: round2(r.umschlag),
    }));
  return { from, to, days: rows.length, rows: rows.slice(0, 200) };
}

function toolGetEmployeeSummary(state, input) {
  const financials = Array.isArray(state.financials) ? state.financials : [];
  if (financials.length === 0) return { error: "Keine Kennzahlen freigegeben oder noch nicht synchronisiert." };
  const from = /^\d{4}-\d{2}-\d{2}$/.test(input?.from) ? input.from : financials[0].date;
  const to = /^\d{4}-\d{2}-\d{2}$/.test(input?.to) ? input.to : financials[financials.length - 1].date;
  const needle = String(input?.name || "").trim().toLowerCase();
  let hours = 0,
    lohn = 0,
    lohnnebenkosten = 0,
    days = 0,
    matchedName = null;
  for (const r of financials) {
    if (r.date < from || r.date > to) continue;
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
  if (!matchedName) return { error: `Niemand namens "${input?.name}" im Zeitraum ${from} bis ${to} gefunden.` };
  return { name: matchedName, from, to, days, hours: round2(hours), lohn: round2(lohn), lohnnebenkosten: round2(lohnnebenkosten) };
}

function toolGetTasks(state, input) {
  const tasks = Array.isArray(state.tasks) ? state.tasks : [];
  const status = input?.status || "open";
  const filtered = status === "all" ? tasks : tasks.filter((t) => (status === "done" ? t.done : !t.done));
  return { count: filtered.length, tasks: filtered.slice(0, 100).map((t) => ({ date: t.date, assignedTo: t.assignedToName || "Allgemein", text: t.text, done: t.done })) };
}

function toolGetStock(state) {
  const stock = Array.isArray(state.stock) ? state.stock : [];
  return { count: stock.length, items: stock.map((s) => ({ name: s.name, status: s.status, unit: s.unit || null, currentAmount: s.unit ? s.currentAmount : null })) };
}

/** Kleiner Helfer für die Zeitraum-Filter der folgenden Werkzeuge (leere Grenze = unbegrenzt). */
function inRange(date, from, to) {
  if (from && date < from) return false;
  if (to && date > to) return false;
  return true;
}

function toolGetShiftPlan(state, input) {
  const from = /^\d{4}-\d{2}-\d{2}$/.test(input?.from) ? input.from : "";
  const to = /^\d{4}-\d{2}-\d{2}$/.test(input?.to) ? input.to : "";
  const needle = String(input?.name || "").trim().toLowerCase();

  const planned = (Array.isArray(state.plannedShifts) ? state.plannedShifts : [])
    .filter((s) => inRange(s.date || "", from, to))
    .filter((s) => !needle || String(s.employeeName || "").trim().toLowerCase() === needle)
    .map((s) => ({ date: s.date, name: s.employeeName, shift: s.slotLabel || (s.from && s.to ? `${s.from}-${s.to}` : "") }));

  // Verfügbarkeiten liegen pro Zielwoche (Montag) gebündelt: { weekStart: { entries: { Name: { days: [...] } } } }
  const availability = [];
  for (const [weekStart, bucket] of Object.entries(state.availability || {})) {
    for (const [name, entry] of Object.entries(bucket?.entries || {})) {
      if (needle && name.trim().toLowerCase() !== needle) continue;
      for (const day of entry?.days || []) {
        if (!inRange(day.date || "", from, to)) continue;
        const slots = (day.slots || []).map((s) => s.label || s.id);
        const confirmed = (day.slots || []).find((s) => s.id === day.confirmedSlotId);
        availability.push({
          date: day.date,
          weekStart,
          name,
          moeglicheSchichten: slots,
          status: day.confirmedSlotId
            ? day.bossConfirmed
              ? `fest: ${confirmed?.label || day.confirmedSlotId}`
              : `wartet auf Bestätigung: ${confirmed?.label || day.confirmedSlotId}`
            : slots.length > 1
              ? "mehrere Kandidaten, noch nicht entschieden"
              : "gemeldet, noch nicht zugeteilt",
        });
      }
    }
  }
  availability.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  if (planned.length === 0 && availability.length === 0) {
    return { error: "Für diesen Zeitraum/diese Person sind weder eingeplante Schichten noch gemeldete Verfügbarkeiten bekannt." };
  }
  return { geplanteSchichten: planned.slice(0, 150), verfuegbarkeiten: availability.slice(0, 150) };
}

function toolGetEmployees(state) {
  const meta = new Map((Array.isArray(state.employeeMeta) ? state.employeeMeta : []).map((m) => [String(m.name || "").trim().toLowerCase(), m]));
  const inService = new Map((Array.isArray(state.shiftsInService) ? state.shiftsInService : []).map((s) => [String(s.name || "").trim().toLowerCase(), s]));
  const employees = (Array.isArray(state.employees) ? state.employees : []).map((name) => {
    const m = meta.get(name.trim().toLowerCase());
    const s = inService.get(name.trim().toLowerCase());
    return {
      name,
      isMinijob: m ? !!m.isMinijob : null,
      minijobLimit: m?.isMinijob ? m.minijobLimit : null,
      aktuellImDienstSeit: s ? s.since : null,
    };
  });
  return {
    count: employees.length,
    employees,
    ausstempelnVergessen: (Array.isArray(state.staleOpenShifts) ? state.staleOpenShifts : []).map((s) => ({ date: s.date, name: s.employeeName, seit: s.from })),
  };
}

function toolGetEmployeeNotes(state, input) {
  const needle = String(input?.name || "").trim().toLowerCase();
  const limit = Number.isFinite(Number(input?.limit)) && Number(input.limit) > 0 ? Math.min(Number(input.limit), 100) : 30;
  const notes = (Array.isArray(state.employeeNotes) ? state.employeeNotes : []).filter(
    (n) => !needle || String(n.employeeName || "").trim().toLowerCase() === needle
  );
  if (notes.length === 0) return { error: needle ? `Keine Notizen von "${input?.name}" vorhanden.` : "Keine Mitarbeiter-Notizen vorhanden." };
  return { count: notes.length, notes: notes.slice(-limit).map((n) => ({ date: n.date, name: n.employeeName, text: n.text })) };
}

function toolGetStockMovements(state, input) {
  const kind = ["deliveries", "sales", "all"].includes(input?.kind) ? input.kind : "all";
  const from = /^\d{4}-\d{2}-\d{2}$/.test(input?.from) ? input.from : "";
  const to = /^\d{4}-\d{2}-\d{2}$/.test(input?.to) ? input.to : "";
  const result = {};
  if (kind === "deliveries" || kind === "all") {
    result.lieferungen = (Array.isArray(state.stockDeliveries) ? state.stockDeliveries : [])
      .filter((d) => inRange(d.date || "", from, to))
      .slice(-200)
      .map((d) => ({ date: d.date, artikel: d.itemName, menge: d.quantity, einheit: d.unit || null }));
  }
  if (kind === "sales" || kind === "all") {
    result.verkaeufe = (Array.isArray(state.stockSales) ? state.stockSales : [])
      .filter((s) => inRange(s.date || "", from, to))
      .slice(-200)
      .map((s) => ({ date: s.date, produkt: s.productName, anzahl: s.quantitySold }));
  }
  const empty = (result.lieferungen?.length ?? 0) === 0 && (result.verkaeufe?.length ?? 0) === 0;
  if (empty) return { error: "Für diesen Zeitraum sind keine Warenbewegungen erfasst." };
  return result;
}

/** Begrenzt ein Werkzeug-Ergebnis auf eine sinnvolle Größe. Wichtig: bei Überlänge NICHT stillschweigend
 * mitten im JSON abschneiden (Claude würde die unvollständigen Daten für vollständig halten), sondern
 * explizit sagen, dass gekürzt wurde und der Zeitraum enger gefasst werden muss. */
function capToolResult(result) {
  const json = JSON.stringify(result);
  const LIMIT = 8000;
  if (json.length <= LIMIT) return json;
  return JSON.stringify({
    error: "Zu viele Daten für eine Antwort – bitte den Zeitraum enger fassen oder gezielter nachfragen (z.B. einzelner Monat statt alles).",
    hinweis: `Das Ergebnis war ${json.length} Zeichen groß, erlaubt sind ${LIMIT}.`,
  });
}

function executeAskTool(state, name, input) {
  if (name === "get_financials") return toolGetFinancials(state, input);
  if (name === "get_employee_summary") return toolGetEmployeeSummary(state, input);
  if (name === "get_tasks") return toolGetTasks(state, input);
  if (name === "get_stock") return toolGetStock(state);
  if (name === "get_shift_plan") return toolGetShiftPlan(state, input);
  if (name === "get_employees") return toolGetEmployees(state);
  if (name === "get_employee_notes") return toolGetEmployeeNotes(state, input);
  if (name === "get_stock_movements") return toolGetStockMovements(state, input);
  return { error: "Unbekanntes Werkzeug." };
}

async function buildAskAnythingReply(env, state, text) {
  const system = `Du bist der Assistent für die Café-Verwaltung eines kleinen Cafés. Heute ist ${todayBerlin()} (Europe/Berlin).
Bekannte aktive Mitarbeiter: ${state.employees.join(", ") || "(keine hinterlegt)"}.

Du hast über Werkzeuge Zugriff auf ALLE Daten des Systems: Kennzahlen und Stunden/Lohn pro Person, Aufgaben,
Vorräte und Warenbewegungen (Lieferungen/Verkäufe), Schichtplanung und Verfügbarkeiten, die Mitarbeiterliste
(inkl. Minijob-Grenzen, wer eingestempelt ist, vergessenes Ausstempeln) sowie Notizen der Mitarbeiter.

Rufe GENAU die Daten ab, die du für die Antwort brauchst – nutze die Werkzeuge, statt zu raten, auch mehrfach
nacheinander (z.B. zwei Zeiträume zum Vergleichen, oder erst Kennzahlen dann Schichtplan). Antworte erst mit
Text, wenn du genug Daten hast oder ein Werkzeug einen Fehler zurückgibt, der die Frage beantwortet ("keine
Daten für X"). Nutze NUR was die Werkzeuge tatsächlich liefern – erfinde oder schätze nichts. Reichen die
Daten nicht, sag das ehrlich. Keine Finanz-, Steuer- oder Rechtsberatung, nur nüchterne Beobachtungen.
Antworte auf Deutsch, kurz und konkret, ohne Einleitung direkt zur Sache.`;

  const history = (state.conversationHistory || []).slice(-6).map((h) => ({ role: h.role, content: h.text }));
  let messages = [...history, { role: "user", content: text }];

  for (let round = 0; round < 4; round++) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: AI_MODEL, max_tokens: 1024, system, tools: ASK_TOOLS, messages }),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`Anthropic API ${res.status}${errText ? ": " + errText.slice(0, 300) : ""}`);
    }
    const data = await res.json();
    const content = data.content || [];
    const toolUses = content.filter((b) => b.type === "tool_use");
    if (toolUses.length === 0) {
      const block = content.find((b) => b.type === "text");
      return block?.text?.trim() || "Dazu konnte ich gerade keine Antwort finden.";
    }
    messages = [
      ...messages,
      { role: "assistant", content },
      {
        role: "user",
        content: toolUses.map((tu) => ({
          type: "tool_result",
          tool_use_id: tu.id,
          content: capToolResult(executeAskTool(state, tu.name, tu.input)),
        })),
      },
    ];
  }
  return "Konnte die Frage nach mehreren Rückfragen an die eigenen Daten nicht abschließend beantworten – bitte enger fassen oder anders formulieren.";
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
  const doc = message?.document || null; // z.B. als PDF oder "als Datei" verschicktes Foto
  const chatId = message?.chat?.id;
  if ((!text && !photo && !doc) || chatId === undefined) return new Response("ok", { status: 200 });

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
      await sendTelegramMessage(env, chatId, "⚠ ANTHROPIC_API_KEY fehlt im Worker – ich kann Nachrichten/Fotos/PDFs gerade nicht verstehen.");
      return new Response("ok", { status: 200 });
    }

    if (photo || doc) {
      const ACCEPTED_DOC_TYPES = ["application/pdf", "image/jpeg", "image/png"];
      if (doc && !ACCEPTED_DOC_TYPES.includes(doc.mime_type)) {
        await sendTelegramMessage(
          env,
          chatId,
          "⚠ Diese Datei kann ich nicht auswerten – bitte als Foto oder PDF schicken (Lieferschein/Rechnung oder SumUp-Verkaufsbericht)."
        );
        return new Response("ok", { status: 200 });
      }
      const fileId = photo ? photo[photo.length - 1].file_id : doc.file_id; // Telegram sortiert Fotos aufsteigend nach Auflösung
      const knownMimeType = doc ? doc.mime_type : null;
      await handleStockDocument(env, chatId, fileId, knownMimeType, message.caption, today, state);
      return new Response("ok", { status: 200 });
    }

    const result = await interpretMessage(env, text, today, state);
    let replyText = "";

    if (result.action === "list") {
      replyText = buildListReply(state, today);
    } else if (result.action === "who") {
      replyText = buildWhoReply(state);
    } else if (result.action === "stats") {
      const period = ["today", "yesterday", "week", "lastweek", "month", "custom"].includes(result.stats_period) ? result.stats_period : "today";
      const employeeName = result.stats_employee_name ? String(result.stats_employee_name).trim() : "";
      const customFrom = /^\d{4}-\d{2}-\d{2}$/.test(result.stats_from) ? result.stats_from : "";
      const customTo = /^\d{4}-\d{2}-\d{2}$/.test(result.stats_to) ? result.stats_to : "";
      replyText = buildStatsReply(state, period, today, employeeName, customFrom, customTo);
      if (!employeeName) {
        const insights = await generateInsights(env, state.financials);
        if (insights) replyText += `\n\n💡 ${insights}`;
      }
    } else if (result.action === "delete") {
      const ids = Array.isArray(result.task_ids_to_delete) ? result.task_ids_to_delete : [];
      const removed = state.tasks.filter((t) => ids.includes(t.id));
      if (removed.length > 0) {
        await patchState(env, { tasks: state.tasks.filter((t) => !ids.includes(t.id)) });
      }
      replyText = buildDeleteReply(removed);
    } else if (result.action === "complete") {
      const ids = Array.isArray(result.task_ids_to_complete) ? result.task_ids_to_complete : [];
      const completed = state.tasks.filter((t) => ids.includes(t.id) && !t.done);
      if (completed.length > 0) {
        await patchState(env, { tasks: state.tasks.map((t) => (ids.includes(t.id) ? { ...t, done: true } : t)) });
      }
      replyText = buildCompleteReply(completed);
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
        replyText = "Konnte daraus keine Aufgabe erkennen. Magst du es anders formulieren?";
      } else {
        await patchState(env, { tasks: [...state.tasks, ...newTasks] });
        replyText = buildAddReply(newTasks, today);
      }
    } else if (result.action === "availability") {
      replyText = buildAvailabilityReply(state, today);
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
        replyText = `Konnte daraus keinen Schichtplan erkennen. Magst du es anders formulieren (z.B. „Anna bekommt Montag Früh1")?`;
      } else {
        // Wie am Laptop: benachrichtigt wird nur, wenn der Plan dieser Woche schon abgeschlossen ist –
        // sonst plant der Chef weiter, ohne dass das Team Zwischenstände mitbekommt.
        let notifs = state.employeeNotifications;
        for (const s of newShifts) {
          if (!istWocheAbgeschlossen(state, s.date)) continue;
          const def = findSlotDefinition(state, s.employeeName, s.slotLabel);
          const zeit = def ? `${def.label}, ${def.from}–${def.to} Uhr` : s.slotLabel || `${s.from}–${s.to} Uhr`;
          notifs = withEmployeeNotification(
            { employeeNotifications: notifs },
            s.employeeName,
            `🔄 Änderung am Schichtplan: Du hast jetzt am ${formatDateDe(s.date)} die Schicht ${zeit}.`
          );
        }
        await patchState(env, { plannedShifts: [...(state.plannedShifts || []), ...newShifts], employeeNotifications: notifs });
        const unresolved = newShifts.filter((s) => !knownNames.has(s.employeeName.toLowerCase()));
        const gueltige = knownSlotLabels(state);
        const badLabels = newShifts.filter((s) => s.slotLabel && !gueltige.has(normalizeSlotLabelCheck(s.slotLabel)));
        replyText = buildPlanShiftsReply(newShifts);
        if (unresolved.length > 0) {
          replyText += `\n\n⚠ Kenne diese Namen nicht als aktive Mitarbeiter, bitte prüfen: ${unresolved.map((s) => s.employeeName).join(", ")}`;
        }
        if (badLabels.length > 0) {
          replyText += `\n\n⚠ Diese Schicht-Namen erkenne ich nicht (erwarte Früh1/Früh2/Mittel/Spät1/Spät2), kommt so NICHT im System an – bitte korrigieren: ${badLabels.map((s) => `${s.employeeName}: „${s.slotLabel}"`).join(", ")}`;
        }
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
        replyText = "Konnte daraus keine Nachricht erkennen. Für wen war die gedacht, und was soll drinstehen?";
      } else {
        await patchState(env, { employeeMessages: [...(state.employeeMessages || []), ...newMessages] });
        const unresolved = newMessages.filter((m) => !knownNames.has(m.employeeName.toLowerCase()));
        replyText = buildNotifyReply(newMessages);
        if (unresolved.length > 0) {
          replyText += `\n\n⚠ Kenne diese Namen nicht als aktive Mitarbeiter, bitte prüfen: ${unresolved.map((m) => m.employeeName).join(", ")}`;
        }
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
        replyText = `Konnte daraus keine Ablehnung erkennen. Magst du es anders formulieren (z.B. „Annas Mittel-Schicht am Montag ablehnen")?`;
      } else {
        let rejNotifs = state.employeeNotifications;
        for (const r of newRejections) {
          if (!istWocheAbgeschlossen(state, r.date)) continue; // vor dem Abschließen bleibt alles still
          const def = findSlotDefinition(state, r.employeeName, r.slotLabel);
          const zeit = def ? `${def.label}, ${def.from}–${def.to} Uhr` : r.slotLabel;
          rejNotifs = withEmployeeNotification(
            { employeeNotifications: rejNotifs },
            r.employeeName,
            `🔄 Änderung am Schichtplan: Deine Schicht am ${formatDateDe(r.date)} (${zeit}) entfällt.`
          );
        }
        await patchState(env, { shiftRejections: [...(state.shiftRejections || []), ...newRejections], employeeNotifications: rejNotifs });
        const unresolved = newRejections.filter((r) => !knownNames.has(r.employeeName.toLowerCase()));
        const gueltigeR = knownSlotLabels(state);
        const badLabels = newRejections.filter((r) => !gueltigeR.has(normalizeSlotLabelCheck(r.slotLabel)));
        replyText = buildRejectReply(newRejections);
        if (unresolved.length > 0) {
          replyText += `\n\n⚠ Kenne diese Namen nicht als aktive Mitarbeiter, bitte prüfen: ${unresolved.map((r) => r.employeeName).join(", ")}`;
        }
        if (badLabels.length > 0) {
          replyText += `\n\n⚠ Diese Schicht-Namen erkenne ich nicht (erwarte Früh1/Früh2/Mittel/Spät1/Spät2), kommt so NICHT im System an – bitte korrigieren: ${badLabels.map((r) => `${r.employeeName}: „${r.slotLabel}"`).join(", ")}`;
        }
      }
    } else if (result.action === "stock_list") {
      replyText = buildStockListReply(state);
    } else if (result.action === "restock") {
      const newRestocks = (Array.isArray(result.items_to_restock) ? result.items_to_restock : [])
        .map((i) => ({ id: crypto.randomUUID(), itemName: String(i.itemName || "").trim() }))
        .filter((i) => i.itemName);
      if (newRestocks.length === 0) {
        replyText = "Konnte daraus keinen Artikel erkennen. Welcher Artikel ist wieder da?";
      } else {
        await patchState(env, { stockRestocks: [...(state.stockRestocks || []), ...newRestocks] });
        replyText = buildRestockReply(newRestocks);
      }
    } else if (result.action === "notes") {
      replyText = buildNotesDigestReply(state);
    } else if (result.action === "ask_anything") {
      replyText = await buildAskAnythingReply(env, state, text);
    } else {
      replyText = `Das habe ich nicht eindeutig verstanden. Du kannst mir z.B. schreiben:\n„Anna soll die Kasse zählen"\n„liste"\n„wer ist da"\n„Kasse zählen ist erledigt"\n„lösch die Aufgabe Kasse zählen bei Anna"\n„kennzahlen" / „wie war der Umsatz heute"\n„wie viele Stunden hat Anna diese Woche gemacht"\n„Wochenplan: Montag Anna 10-18, Dienstag Timm 9-17"\n„wer kann wann"\n„Sag Anna, sie soll morgen früher kommen"\n„Annas Mittel-Schicht am Montag ablehnen"\n„was fehlt" / „Kaffeebohnen sind wieder da"\n„nachrichten"\nOder frag mich einfach direkt etwas, z.B. „wieso war der Umschlag diese Woche schlechter".`;
    }

    await sendTelegramMessage(env, chatId, replyText);

    // Verlauf merken (nur Text-Austausch, gedeckelt), damit Rückfragen den Zusammenhang kennen.
    const newHistory = [...(state.conversationHistory || []), { role: "user", text }, { role: "assistant", text: replyText }].slice(-20);
    await patchState(env, { conversationHistory: newHistory });
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
    // PIN-Hashes für den Handy-/Laptop-Login (kommen nur vom iPad, nie im Klartext). Nur setzen, wenn
    // wirklich mitgeschickt: sonst würde ein Push ohne diese Felder die gespeicherten Hashes löschen und
    // alle Handy-Logins wären auf einen Schlag tot.
    if (Array.isArray(body.authPins)) patch.authPins = body.authPins;
    if (typeof body.adminPinHash === "string") patch.adminPinHash = body.adminPinHash;
    if (Array.isArray(body.employeeRoles)) patch.employeeRoles = body.employeeRoles;
    if (body.shiftSlots && typeof body.shiftSlots === "object") patch.shiftSlots = body.shiftSlots;
    if (Array.isArray(body.recipes)) patch.recipes = body.recipes;
    if (Array.isArray(body.employeeDetails)) patch.employeeDetails = body.employeeDetails;
    // Abgeschlossene Wochen: das iPad hat die Freigaben aus der Warteschlange übernommen und schickt hier
    // seinen maßgeblichen Stand zurück. Nur setzen, wenn wirklich mitgeschickt – sonst würde ein älteres
    // iPad (noch ohne dieses Feld) die Freigaben löschen und alle Pläne wären wieder unveröffentlicht.
    if (Array.isArray(body.publishedWeeks)) patch.publishedWeeks = body.publishedWeeks;
    // Grundlage der Online-Buchung. Wie oben: nur setzen, wenn wirklich mitgeschickt – ein iPad ohne
    // diese Felder würde sonst die Buchungsseite lahmlegen.
    if (Array.isArray(body.tables)) patch.tables = body.tables;
    if (Array.isArray(body.reservationSlots)) patch.reservationSlots = body.reservationSlots;
    if (body.reservationConfig && typeof body.reservationConfig === "object") patch.reservationConfig = body.reservationConfig;
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
  // Breiterer Rückblick (bis zu ~2 Monate statt der sonst üblichen 14 Tage) für den wöchentlichen "Routine-Scan"
  // - hier darf es auch mal ein längerfristiges Muster sein, nicht nur der Blick auf die letzten zwei Wochen.
  const insights = await generateInsights(env, state.financials, 60);
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

    // Öffentliche Buchungsseite für Gäste – bewusst ohne jede Anmeldung, sie steht ja auf der Website.
    // Muss VOR dem Anmelde-Block stehen: der behandelt nur /auth/, /me und /admin/.
    if (url.pathname === "/booking" || url.pathname === "/booking/") {
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
      if (request.method === "POST") return handleBookingCreate(request, env);
      return handleBookingPage(env);
    }
    if (url.pathname === "/booking/slots") {
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
      return handleBookingSlots(request, env);
    }

    // Handy/Laptop – eigene Anmeldung, getrennt vom WEBHOOK_SECRET (siehe Kommentar bei requireSession).
    if (url.pathname.startsWith("/auth/") || url.pathname === "/me" || url.pathname.startsWith("/me/") || url.pathname.startsWith("/admin/")) {
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
      if (url.pathname === "/auth/login") return handleAuthLogin(request, env);
      if (url.pathname === "/me") return handleMe(request, env);
      if (url.pathname === "/me/availability") return handleMeAvailability(request, env);
      if (url.pathname === "/me/sick") return handleMeSick(request, env);
      if (url.pathname === "/me/notifications/read") return handleMeNotificationsRead(request, env);
      if (url.pathname === "/admin/overview") return handleAdminOverview(request, env);
      if (url.pathname === "/admin/shift-decision") return handleAdminShiftDecision(request, env);
      if (url.pathname === "/admin/publish-week") return handleAdminPublishWeek(request, env);
      if (url.pathname === "/admin/stock") return handleAdminStock(request, env);
      if (url.pathname === "/admin/document") return handleAdminDocument(request, env);
      if (url.pathname === "/admin/stock-item") return handleAdminStockItem(request, env);
      if (url.pathname === "/admin/recipe") return handleAdminRecipe(request, env);
      if (url.pathname === "/admin/employee") return handleAdminEmployee(request, env);
      if (url.pathname === "/admin/message") return handleAdminMessage(request, env);
      return jsonResponse({ error: "unbekannter Endpunkt" }, 404);
    }

    if (request.method === "POST") return handleTelegram(request, env);
    return new Response("ok", { status: 200 });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(handleScheduled(env));
  },
};
