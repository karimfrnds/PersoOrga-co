// ============================================================================
// social/gemeinsam.js – Begriffe und kleine Helfer, die alle Ansichten des Social-Bereichs brauchen.
//
// Vor allem die Status-Kette. Sie ist das Herz eines Redaktionsplans: ohne sie sieht man nur, WAS
// geplant ist, aber nicht, was davon schon fertig, was noch offen und was gefährdet ist. Die Reihenfolge
// ist bewusst eine Kette und kein freies Feld – jeder Schritt hat einen nächsten.
// ============================================================================

const STATUS = {
  idee: { label: "Idee", kurz: "Idee", farbe: "#6b7280", naechster: "inArbeit", naechsterLabel: "In Arbeit nehmen" },
  inArbeit: { label: "In Arbeit", kurz: "In Arbeit", farbe: "#c9720b", naechster: "freigabe", naechsterLabel: "Zur Freigabe" },
  freigabe: { label: "Wartet auf Freigabe", kurz: "Freigabe", farbe: "#7c3aed", naechster: "geplant", naechsterLabel: "Freigeben" },
  geplant: { label: "Freigegeben & geplant", kurz: "Geplant", farbe: "#1f6f54", naechster: "veroeffentlicht", naechsterLabel: "Ist raus" },
  veroeffentlicht: { label: "Veröffentlicht", kurz: "Raus", farbe: "#1c1e21", naechster: null, naechsterLabel: "" },
  verworfen: { label: "Verworfen", kurz: "Verworfen", farbe: "#9ca3af", naechster: "idee", naechsterLabel: "Wieder aufnehmen" },
};
const STATUS_REIHE = ["idee", "inArbeit", "freigabe", "geplant", "veroeffentlicht", "verworfen"];

const WOCHENTAGE = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];
const MONATE = [
  "Januar", "Februar", "März", "April", "Mai", "Juni",
  "Juli", "August", "September", "Oktober", "November", "Dezember",
];

function addDaysISO(dateStr, n) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}
/** 0 = Montag … 6 = Sonntag. */
function weekdayIndex(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return wd === 0 ? 6 : wd - 1;
}
const dateDeShort = (s) => (s ? `${s.slice(8, 10)}.${s.slice(5, 7)}.` : "");
const dateDeLang = (s) =>
  s ? `${WOCHENTAGE[weekdayIndex(s)]}, ${Number(s.slice(8, 10))}. ${MONATE[Number(s.slice(5, 7)) - 1]}` : "";
const monatLabel = (jahr, monat) => `${MONATE[monat]} ${jahr}`;

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const zahl = (n) => (n === null || n === undefined ? "–" : new Intl.NumberFormat("de-DE").format(n));
const prozent = (n) => (n === null || n === undefined ? "–" : `${String(Math.round(n * 10) / 10).replace(".", ",")} %`);

/** Alle Interaktionen eines Posts zusammen. null, wenn gar nichts erfasst ist – eine 0 wäre eine
 * Aussage ("lief nicht"), ein leeres Feld ist "noch nicht abgelesen". Der Unterschied ist wichtig,
 * sonst zieht ein nicht gepflegter Post den Schnitt nach unten. */
function interaktionen(p) {
  const s = p?.statistik;
  if (!s) return null;
  const teile = [s.likes, s.kommentare, s.saves, s.shares].filter((x) => x !== null && x !== undefined);
  if (teile.length === 0) return null;
  return teile.reduce((a, b) => a + b, 0);
}

/** Interaktionsrate: Interaktionen geteilt durch Reichweite. Die eine Zahl, die sagt, ob ein Beitrag
 * die Leute erreicht hat, die ihn gesehen haben – unabhängig davon, wie groß der Account ist. */
function interaktionsrate(p) {
  const i = interaktionen(p);
  const r = p?.statistik?.reichweite;
  if (i === null || !r) return null;
  return (i / r) * 100;
}

/** Ein Element bauen, ohne jedes Mal drei Zeilen zu schreiben. */
function el(tag, klasse, inhalt) {
  const n = document.createElement(tag);
  if (klasse) n.className = klasse;
  if (inhalt !== undefined) n.innerHTML = inhalt;
  return n;
}

function feld(label, node, hinweis) {
  const l = el("label", "field", `<span>${label}</span>`);
  l.appendChild(node);
  if (hinweis) l.appendChild(el("p", "muted small", escapeHtml(hinweis)));
  return l;
}

function auswahl(werte, gewaehlt) {
  const sel = document.createElement("select");
  for (const w of werte) {
    const o = document.createElement("option");
    o.value = typeof w === "string" ? w : w.wert;
    o.textContent = typeof w === "string" ? w : w.label;
    sel.appendChild(o);
  }
  sel.value = gewaehlt ?? "";
  return sel;
}

export {
  STATUS,
  STATUS_REIHE,
  WOCHENTAGE,
  MONATE,
  addDaysISO,
  weekdayIndex,
  dateDeShort,
  dateDeLang,
  monatLabel,
  escapeHtml,
  zahl,
  prozent,
  interaktionen,
  interaktionsrate,
  el,
  feld,
  auswahl,
};
