// ============================================================================
// manager/ui.js – Bausteine für das Store-Management.
//
// Gebaut für das Handy zuerst: Formulare öffnen als Blatt von unten (dort, wo der Daumen ist), Listen sind
// antippbare Zeilen statt Tabellen, und jede Aktion sagt kurz, dass sie angekommen ist.
// ============================================================================
import { escapeHtml } from "../format.js";

const WT = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];
const WT_LANG = ["Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag", "Sonntag"];
const ROLLEN = { service: "Service", kueche: "Küche", bar: "Bar" };
const PHASEN = [
  ["beginn", "Schichtbeginn"],
  ["schicht", "Während der Schicht"],
  ["ende", "Schichtende"],
];

function el(tag, klasse, html) {
  const n = document.createElement(tag);
  if (klasse) n.className = klasse;
  if (html !== undefined && html !== null) n.innerHTML = html;
  return n;
}
function text(tag, klasse, inhalt) {
  const n = document.createElement(tag);
  if (klasse) n.className = klasse;
  n.textContent = inhalt;
  return n;
}
function knopf(beschriftung, klasse, onclick) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = klasse || "btn btn-secondary";
  b.textContent = beschriftung;
  if (onclick) b.onclick = onclick;
  return b;
}
function feld(label, node, hinweis) {
  const l = document.createElement("label");
  l.className = "field";
  l.appendChild(text("span", null, label));
  l.appendChild(node);
  if (hinweis) l.appendChild(text("p", "muted small", hinweis));
  return l;
}
function eingabe(typ, wert, platzhalter) {
  const i = document.createElement("input");
  i.type = typ;
  i.value = wert === null || wert === undefined ? "" : String(wert);
  if (platzhalter) i.placeholder = platzhalter;
  return i;
}
function textfeld(wert, platzhalter, zeilen = 4) {
  const t = document.createElement("textarea");
  t.rows = zeilen;
  t.value = wert || "";
  if (platzhalter) t.placeholder = platzhalter;
  return t;
}
function auswahl(paare, wert) {
  const sel = document.createElement("select");
  for (const [v, label] of paare) {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = label;
    sel.appendChild(o);
  }
  sel.value = wert;
  return sel;
}
function haken(label, an) {
  const l = document.createElement("label");
  l.className = "field-checkbox";
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = !!an;
  l.append(cb, document.createTextNode(" " + label));
  return { zeile: l, cb };
}

/** Wochentage als Umschalter. Gibt { node, werte() } zurück. */
function wochentagWahl(start = []) {
  let gewaehlt = [...start];
  const node = el("div", "mg-wt");
  WT.forEach((t, i) => {
    const b = knopf(t, "", () => {
      gewaehlt = gewaehlt.includes(i) ? gewaehlt.filter((x) => x !== i) : [...gewaehlt, i].sort((a, b) => a - b);
      male();
    });
    const male = () => (b.className = "mg-wt-btn" + (gewaehlt.includes(i) ? " an" : ""));
    male();
    node.appendChild(b);
  });
  return { node, werte: () => [...gewaehlt] };
}

/** Segment-Umschalter (z.B. "Im Laden | Standard-Aufgaben"). */
function segmente(paare, aktiv, onwahl) {
  const box = el("div", "mg-seg");
  for (const [id, label] of paare) {
    box.appendChild(knopf(label, "mg-seg-btn" + (id === aktiv ? " an" : ""), () => onwahl(id)));
  }
  return box;
}

/** Blatt von unten (auf dem iPad mittig). bauen(box, schliessen) füllt es. */
function blatt(titel, bauen) {
  const overlay = el("div", "overlay mg-overlay");
  const box = el("div", "dialog mg-blatt");
  const kopf = el("div", "mg-blatt-kopf");
  kopf.appendChild(text("h2", null, titel));
  const zu = knopf("✕", "mg-blatt-zu");
  kopf.appendChild(zu);
  box.appendChild(kopf);
  const schliessen = () => overlay.remove();
  zu.onclick = schliessen;
  overlay.onclick = (e) => {
    if (e.target === overlay) schliessen();
  };
  overlay.appendChild(box);
  document.body.appendChild(overlay);
  bauen(box, schliessen);
  return { box, schliessen };
}

let toastTimer = null;
function toast(nachricht, warnung = false) {
  document.querySelector(".mg-toast")?.remove();
  const t = text("div", "mg-toast" + (warnung ? " warn" : ""), nachricht);
  document.body.appendChild(t);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.remove(), warnung ? 6000 : 2600);
}

/** Aktion ausführen, Knopf währenddessen sperren, Fehler als Hinweis zeigen. Gibt true bei Erfolg. */
async function ausfuehren(knopfEl, fn, erfolg) {
  const alt = knopfEl?.textContent;
  if (knopfEl) {
    knopfEl.disabled = true;
    knopfEl.textContent = "…";
  }
  try {
    await fn();
    if (erfolg) toast(erfolg);
    return true;
  } catch (e) {
    toast("⚠ " + e.message, true);
    if (knopfEl) {
      knopfEl.disabled = false;
      knopfEl.textContent = alt;
    }
    return false;
  }
}

// ---- Datum ----
function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}
function wtIndex(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return wd === 0 ? 6 : wd - 1;
}
function mondayOf(dateStr) {
  return addDays(dateStr, -wtIndex(dateStr));
}
function datumKurz(dateStr) {
  const [, m, d] = dateStr.split("-");
  return `${d}.${m}.`;
}
function tagName(dateStr, heute) {
  if (dateStr === heute) return "Heute";
  if (dateStr === addDays(heute, 1)) return "Morgen";
  if (dateStr === addDays(heute, -1)) return "Gestern";
  return `${WT[wtIndex(dateStr)]}, ${datumKurz(dateStr)}`;
}
function wann(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const min = Math.round((Date.now() - d.getTime()) / 60000);
  if (min < 2) return "gerade eben";
  if (min < 60) return `vor ${min} Min`;
  if (min < 60 * 20) return `vor ${Math.round(min / 60)} Std`;
  return d.toLocaleString("de-DE", { weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}
const zahl = (n) => (n === null || n === undefined ? "–" : Number.isInteger(n) ? String(n) : String(n).replace(".", ","));
const gleicherName = (a, b) => String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase();

export {
  WT,
  WT_LANG,
  ROLLEN,
  PHASEN,
  el,
  text,
  knopf,
  feld,
  eingabe,
  textfeld,
  auswahl,
  haken,
  wochentagWahl,
  segmente,
  blatt,
  toast,
  ausfuehren,
  addDays,
  wtIndex,
  mondayOf,
  datumKurz,
  tagName,
  wann,
  zahl,
  gleicherName,
  escapeHtml,
};
