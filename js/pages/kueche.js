// ============================================================================
// pages/kueche.js – Die Küchen-Karten im persönlichen Fenster am iPad.
//
// Keine eigene Seite: wer in der Küche arbeitet, stempelt ein und hat es dann vor sich. Eine eigene
// Seite in der Leiste hiesse, dass jede und jeder sie öffnen kann, ohne dass klar ist, wer gerade zählt –
// und dass die Küche einen Umweg geht, um an ihr eigenes Werkzeug zu kommen.
//
// Zwei Karten:
//
//   KÜCHE. Oben, was die vorige Schicht mitgeben wollte ("Gurken fehlen für morgen"), und darunter die
//   Vorbereitungen: wie viel da ist, gegen das Soll. Die gehende Schicht trägt eine Zahl ein, die kommende
//   liest sie ab, statt in jeden Behälter zu schauen.
//
//   REZEPTE. Dieselbe Vorbereitung, immer gleich gemacht – ohne dass jemand fragen muss.
//
// Die Karten zeichnen sich nach einer Änderung über onChange() neu (das ist das Neuzeichnen des
// Kiosks). Was dabei nicht verloren gehen darf – eingetippte, noch nicht gespeicherte Zahlen und die
// Suche – liegt deshalb hier auf Modulebene statt in der Karte.
// ============================================================================
import { store } from "../store.js";
import { escapeHtml, todayStr } from "../format.js";
import { confirmDialog, alertDialog } from "../dialog.js";

const STATUS = {
  leer: { label: "leer", klasse: "bestand-leer", rang: 0 },
  knapp: { label: "unter Soll", klasse: "bestand-knapp", rang: 1 },
  unbekannt: { label: "nicht gezählt", klasse: "bestand-bestellt", rang: 2 },
  ok: { label: "genug", klasse: "bestand-ok", rang: 3 },
};
const WOCHENTAGE = ["Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag", "Sonntag"];

// Überlebt das Neuzeichnen des Kiosks. Gehört zu genau einer Person: meldet sich jemand anderes an,
// fängt sie mit einer leeren Eingabe an, statt die halbe Zählung der vorigen zu speichern.
const zustand = { fuer: null, entwurf: new Map(), suche: "", notizTag: 1 };
function zustandFuer(emp) {
  if (zustand.fuer !== emp.id) {
    zustand.fuer = emp.id;
    zustand.entwurf = new Map();
    zustand.suche = "";
    zustand.notizTag = 1;
  }
  return zustand;
}

// ---------------------------------------------------------------------
// Kleinkram
// ---------------------------------------------------------------------
function el(tag, klasse, html) {
  const n = document.createElement(tag);
  if (klasse) n.className = klasse;
  if (html !== undefined && html !== null) n.innerHTML = html;
  return n;
}
function feld(label, node, hinweis) {
  const l = document.createElement("label");
  l.className = "field";
  l.innerHTML = `<span>${label}</span>`;
  l.appendChild(node);
  if (hinweis) l.appendChild(el("p", "muted small", hinweis));
  return l;
}
function eingabe(typ, wert, platzhalter) {
  const i = document.createElement("input");
  i.type = typ;
  i.value = wert === null || wert === undefined ? "" : String(wert);
  if (platzhalter) i.placeholder = platzhalter;
  return i;
}
function mehrzeilig(zeilen, platzhalter) {
  const t = document.createElement("textarea");
  t.rows = 5;
  t.value = (zeilen || []).join("\n");
  t.placeholder = platzhalter;
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
function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}
function wochentag(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return WOCHENTAGE[wd === 0 ? 6 : wd - 1];
}
function uhrzeit(iso) {
  return new Date(iso).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
}

/** „vor 20 Min", „14:20 Uhr", „Sa, 12.09., 14:20 Uhr" – eine Uhrzeit allein sagt nicht, ob die Zahl von
 * heute ist. */
function wannText(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const min = Math.round((Date.now() - d.getTime()) / 60000);
  if (min < 2) return "gerade eben";
  if (min < 60) return `vor ${min} Min`;
  // Ortszeit vergleichen, nicht UTC: sonst gilt eine Zählung von gestern 23:30 als "heute".
  const lokal = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  if (lokal === todayStr()) return `${uhrzeit(iso)} Uhr`;
  return `${d.toLocaleDateString("de-DE", { weekday: "short", day: "2-digit", month: "2-digit" })}, ${uhrzeit(iso)} Uhr`;
}

/** "von 3 Schale" liest sich falsch. Nur die zwei Einheiten, bei denen der Plural anders ist. */
const PLURAL = { Schale: "Schalen", Blech: "Bleche" };
function einheitText(einheit, menge) {
  return menge === 1 ? einheit : PLURAL[einheit] || einheit;
}
function zahlText(n) {
  return Number.isInteger(n) ? String(n) : String(n).replace(".", ",");
}

// =====================================================================
// Karte: Küche (Hinweise an die nächste Schicht + Vorbereitungen)
// =====================================================================
function buildKuecheKarte(emp, { onChange }) {
  const z = zustandFuer(emp);
  const card = el("section", "card");
  card.appendChild(el("h2", null, "🍳 Küche"));
  card.appendChild(buildNotizen(emp, z, onChange));
  card.appendChild(buildVorbereitungen(emp, z, onChange));
  return card;
}

// ---- Hinweise an die nächste Schicht ----
function buildNotizen(emp, z, onChange) {
  const wrap = el("div", "kueche-abschnitt");
  wrap.appendChild(el("p", "muted small res-bereich", "<b>Für die nächste Schicht</b>"));

  const heute = todayStr();
  const notizen = store.getKuechenNotizen(heute);
  if (notizen.length === 0) {
    wrap.appendChild(el("p", "muted small", "Nichts offen. Fehlt etwas oder muss die nächste Schicht etwas wissen? Hier eintragen."));
  } else {
    const liste = el("div", "task-list");
    for (const n of notizen) {
      const row = el("label", "task-row" + (n.erledigtAm ? " done" : n.fuer <= heute ? " kueche-notiz-heute" : ""));
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = !!n.erledigtAm;
      cb.onchange = () => {
        store.toggleKuechenNotiz(n.id, emp.name);
        onChange();
      };
      row.appendChild(cb);

      const wann =
        n.fuer < heute
          ? `seit ${wochentag(n.fuer)} offen`
          : n.fuer === heute
            ? "für heute"
            : n.fuer === addDays(heute, 1)
              ? "für morgen"
              : `für ${wochentag(n.fuer)}`;
      const meta = n.erledigtAm
        ? `✓ erledigt von ${n.erledigtVon || "?"}, ${uhrzeit(n.erledigtAm)} Uhr`
        : `${wann} · ${n.von || "?"}, ${wannText(n.at)}`;
      row.appendChild(
        el("div", "task-row-text", `<span>${escapeHtml(n.text)}</span><span class="muted small task-row-meta">${escapeHtml(meta)}</span>`)
      );

      // Löschen nur für die eigene Notiz: sonst verschwindet ein Hinweis, den jemand anderes aus gutem
      // Grund geschrieben hat. Abhaken darf jeder – das ist ja der Sinn.
      if (!n.erledigtAm && n.von === emp.name) {
        const weg = el("button", "btn btn-link", "✕");
        weg.type = "button";
        weg.title = "Eigenen Hinweis löschen";
        weg.onclick = (e) => {
          e.preventDefault();
          store.removeKuechenNotiz(n.id);
          onChange();
        };
        row.appendChild(weg);
      }
      liste.appendChild(row);
    }
    wrap.appendChild(liste);
  }

  // Eingabe: Text, dann für welchen Tag. Vorausgewählt "morgen", weil das der häufigste Fall ist –
  // wer heute merkt, dass etwas fehlt, meint fast immer die nächste Schicht.
  const zeile = el("div", "task-add-row");
  const text = eingabe("text", "", "z.B. Gurken fehlen");
  const add = el("button", "btn btn-primary", "＋");
  add.type = "button";
  const absenden = () => {
    if (!text.value.trim()) {
      text.focus();
      return;
    }
    store.addKuechenNotiz(text.value, addDays(heute, z.notizTag), emp.name);
    onChange();
  };
  add.onclick = absenden;
  text.addEventListener("keydown", (e) => {
    if (e.key === "Enter") absenden();
  });
  zeile.append(text, add);
  wrap.appendChild(zeile);

  const tage = el("div", "handoff-days kueche-tage");
  [
    [0, "Heute"],
    [1, "Morgen"],
    [2, "Übermorgen"],
  ].forEach(([n, label]) => {
    const b = el("button", "btn " + (z.notizTag === n ? "btn-primary" : "btn-secondary"), label);
    b.type = "button";
    b.onclick = () => {
      z.notizTag = n;
      // Nur die Knöpfe umfärben, nicht die Karte neu zeichnen – sonst wäre der halb getippte Text weg.
      [...tage.children].forEach((x, i) => (x.className = "btn " + (i === n ? "btn-primary" : "btn-secondary")));
    };
    tage.appendChild(b);
  });
  wrap.appendChild(tage);
  return wrap;
}

// ---- Vorbereitungen ----
function buildVorbereitungen(emp, z, onChange) {
  const wrap = el("div", "kueche-abschnitt");
  wrap.appendChild(el("p", "muted small res-bereich", "<b>Vorbereitungen</b>"));
  const preps = store.getPreps();

  if (preps.length === 0) {
    wrap.appendChild(
      el("p", "muted small", "Noch keine Vorbereitung angelegt. Trag ein, was immer vorbereitet sein muss – z.B. Tomatensauce, Aioli, geschnittene Zwiebeln.")
    );
    wrap.appendChild(neuKnopf(onChange));
    return wrap;
  }

  wrap.appendChild(buildZusammenfassung(preps));

  const liste = el("div", "prep-list");
  // Was fehlt, steht oben: leer, dann unter Soll, dann nie gezählt, dann der Rest.
  const sortiert = [...preps].sort(
    (a, b) => STATUS[store.prepStatus(a)].rang - STATUS[store.prepStatus(b)].rang || (a.sort || 0) - (b.sort || 0)
  );
  const fuss = el("div", "prep-fuss");
  const zeichneFuss = () => {
    fuss.innerHTML = "";
    const anzahl = z.entwurf.size;
    if (anzahl === 0) {
      fuss.appendChild(el("p", "muted small", "Zahlen eintragen, dann hier einmal speichern."));
      return;
    }
    const btn = el("button", "btn btn-primary btn-huge", `✓ ${anzahl} ${anzahl === 1 ? "Zahl" : "Zahlen"} eintragen`);
    btn.onclick = () => {
      for (const [id, menge] of z.entwurf) store.setPrepBestand(id, menge, emp.name);
      z.entwurf.clear();
      onChange();
    };
    const weg = el("button", "btn btn-link", "Eingaben verwerfen");
    weg.onclick = () => {
      z.entwurf.clear();
      onChange();
    };
    fuss.append(btn, weg);
  };
  for (const p of sortiert) liste.appendChild(buildPrepRow(p, z, zeichneFuss, onChange));
  wrap.appendChild(liste);
  zeichneFuss();
  wrap.appendChild(fuss);
  wrap.appendChild(neuKnopf(onChange));
  return wrap;
}

function buildZusammenfassung(preps) {
  const leer = preps.filter((p) => store.prepStatus(p) === "leer");
  const knapp = preps.filter((p) => store.prepStatus(p) === "knapp");
  const unbekannt = preps.filter((p) => store.prepStatus(p) === "unbekannt");
  const box = document.createElement("div");
  if (leer.length === 0 && knapp.length === 0) {
    box.className = "callout";
    box.textContent = unbekannt.length > 0 ? `Alles über Soll – ${unbekannt.length} noch nie gezählt.` : "Alles über Soll.";
    return box;
  }
  box.className = "callout callout-warn";
  const teile = [];
  if (leer.length > 0) teile.push(`<b>leer:</b> ${leer.map((p) => escapeHtml(p.name)).join(", ")}`);
  if (knapp.length > 0) teile.push(`<b>unter Soll:</b> ${knapp.map((p) => escapeHtml(p.name)).join(", ")}`);
  box.innerHTML = teile.join("<br>");
  return box;
}

function buildPrepRow(p, z, zeichneFuss, onChange) {
  const status = store.prepStatus(p);
  const row = el("div", "prep-row " + STATUS[status].klasse);
  const vorschau = (menge) => store.prepStatus({ ...p, bestand: { menge } });

  const kopf = el("div", "prep-row-kopf");
  const titel = el("div", "prep-row-titel", `<b>${escapeHtml(p.name)}</b>`);
  titel.appendChild(
    el("span", "muted small", escapeHtml(p.bestand ? `zuletzt ${wannText(p.bestand.at)}${p.bestand.by ? " · " + p.bestand.by : ""}` : "noch nie gezählt"))
  );
  if (p.notiz) titel.appendChild(el("span", "muted small", escapeHtml(p.notiz)));
  kopf.appendChild(titel);
  kopf.appendChild(el("span", "prep-chip", STATUS[status].label));
  row.appendChild(kopf);

  // −, Zahl, +. Die Zahl ist auch tippbar, weil „17 Portionen" sonst siebzehn Tipper wären.
  const zaehl = el("div", "prep-zaehl");
  const wert = () => (z.entwurf.has(p.id) ? z.entwurf.get(p.id) : p.bestand ? p.bestand.menge : null);
  const minus = el("button", "btn btn-secondary prep-step", "−");
  const plus = el("button", "btn btn-secondary prep-step", "＋");
  minus.type = plus.type = "button";
  // Bewusst KEIN type="number": dort ändert das Mausrad die Zahl still, ohne dass die Seite es merkt.
  // inputmode="decimal" bringt auf dem iPad trotzdem die Zifferntastatur.
  const input = eingabe("text", wert() === null ? "" : zahlText(wert()), "?");
  input.inputMode = "decimal";
  input.className = "prep-input";
  const faerben = (menge) => {
    row.className = "prep-row " + STATUS[vorschau(menge)].klasse;
  };
  const setze = (n) => {
    const zahl = Math.max(0, Math.round(n * 2) / 2);
    z.entwurf.set(p.id, zahl);
    input.value = zahlText(zahl);
    faerben(zahl);
    zeichneFuss();
  };
  minus.onclick = () => setze((wert() ?? 0) - 1);
  plus.onclick = () => setze((wert() ?? 0) + 1);
  input.oninput = () => {
    const roh = input.value.trim();
    if (roh === "") {
      z.entwurf.delete(p.id);
      zeichneFuss();
      return;
    }
    const zahl = Number(roh.replace(",", ".")); // "1,5" ist die Schreibweise, die hier jemand tippt
    if (!Number.isFinite(zahl) || zahl < 0) return;
    z.entwurf.set(p.id, zahl);
    faerben(zahl);
    zeichneFuss();
  };
  zaehl.append(minus, input, plus);
  zaehl.appendChild(
    el(
      "span",
      "prep-soll",
      p.soll > 0 ? `von ${zahlText(p.soll)} ${escapeHtml(einheitText(p.einheit, p.soll))}` : escapeHtml(einheitText(p.einheit, 2))
    )
  );
  row.appendChild(zaehl);

  const akt = el("div", "employee-actions");
  const rezept = p.rezeptId ? store.getRecipe(p.rezeptId) : null;
  if (rezept) {
    const b = el("button", "btn btn-link", "📖 Rezept");
    b.onclick = () => zeigeRezept(rezept, onChange);
    akt.appendChild(b);
  }
  const aendern = el("button", "btn btn-link", "Ändern");
  aendern.onclick = () => openPrepForm(p, z, onChange);
  akt.appendChild(aendern);
  row.appendChild(akt);
  return row;
}

function neuKnopf(onChange) {
  const btn = el("button", "btn btn-secondary", "＋ Vorbereitung");
  btn.onclick = () => openPrepForm(null, zustand, onChange);
  return btn;
}

function openPrepForm(vorhanden, z, onChange) {
  const overlay = el("div", "overlay");
  const box = el("div", "dialog");
  box.appendChild(el("h2", null, vorhanden ? "Vorbereitung ändern" : "Neue Vorbereitung"));

  const name = eingabe("text", vorhanden?.name || "", "z.B. Tomatensauce");
  const soll = eingabe("text", vorhanden ? zahlText(vorhanden.soll) : "", "z.B. 4");
  soll.inputMode = "decimal";
  const einheit = auswahl(store.PREP_EINHEITEN.map((e) => [e, e]), vorhanden?.einheit || "Behälter");
  const notiz = eingabe("text", vorhanden?.notiz || "", "z.B. im großen Kühlschrank unten");
  const rezepte = store.getRecipes();
  const rezept = auswahl([["", "– kein Rezept –"], ...rezepte.map((r) => [r.id, r.name])], vorhanden?.rezeptId || "");

  box.appendChild(feld("Was wird vorbereitet?", name));
  const reihe = el("div", "res-form-row");
  reihe.append(feld("Soll (mindestens)", soll), feld("Einheit", einheit));
  box.appendChild(reihe);
  box.appendChild(feld("Rezept", rezept, rezepte.length === 0 ? "Noch keine Rezepte – die kommen in die Karte „Rezepte“." : ""));
  box.appendChild(feld("Notiz", notiz, "Wo es steht, worauf zu achten ist."));

  const akt = el("div", "dialog-actions");
  const abbrechen = el("button", "btn btn-secondary", "Abbrechen");
  abbrechen.onclick = () => overlay.remove();
  const speichern = el("button", "btn btn-primary", "Speichern");
  speichern.onclick = async () => {
    if (!name.value.trim()) {
      await alertDialog("Bitte einen Namen eintragen.");
      return;
    }
    const daten = {
      name: name.value.trim(),
      soll: Number(soll.value.replace(",", ".")) || 0,
      einheit: einheit.value,
      notiz: notiz.value.trim(),
      rezeptId: rezept.value || null,
    };
    if (vorhanden) store.updatePrep(vorhanden.id, daten);
    else store.addPrep(daten);
    overlay.remove();
    onChange();
  };
  akt.append(abbrechen, speichern);
  box.appendChild(akt);

  if (vorhanden) {
    const unten = el("div", "res-dialog-danger");
    const weg = el("button", "btn btn-link", "Löschen");
    weg.onclick = async () => {
      if (!(await confirmDialog(`„${escapeHtml(vorhanden.name)}“ aus der Liste nehmen?`, { danger: true, okLabel: "Löschen" }))) return;
      store.removePrep(vorhanden.id);
      z.entwurf.delete(vorhanden.id);
      overlay.remove();
      onChange();
    };
    unten.appendChild(weg);
    box.appendChild(unten);
  }
  overlay.appendChild(box);
  document.body.appendChild(overlay);
  name.focus();
}

// =====================================================================
// Karte: Rezepte
// =====================================================================
function buildRezepteKarte(emp, { onChange }) {
  const z = zustandFuer(emp);
  const card = el("section", "card");
  card.appendChild(el("h2", null, "📖 Rezepte"));

  const alle = store.getRecipes();
  if (alle.length === 0) {
    card.appendChild(el("p", "muted small", "Noch keine Rezepte. Hier anlegen – oder mit „Rezepte übernehmen“ aus einer anderen App einfügen."));
  } else {
    // Die Suche zeichnet nur die Liste neu, nicht die Karte: sonst verlöre das Feld nach jedem Buchstaben
    // den Fokus und die Tastatur ginge zu.
    const such = eingabe("search", z.suche, "Rezept suchen…");
    card.appendChild(such);
    const liste = el("div", "rezept-liste");
    const zeichne = () => {
      liste.innerHTML = "";
      const q = z.suche.trim().toLowerCase();
      const treffer = alle.filter((r) => !q || r.name.toLowerCase().includes(q) || r.zutaten.join(" ").toLowerCase().includes(q));
      if (treffer.length === 0) {
        liste.appendChild(el("p", "muted small", "Kein Rezept gefunden."));
        return;
      }
      for (const r of treffer) {
        const b = el("button", "rezept-zeile");
        b.type = "button";
        const teile = [
          r.ergibt ? `ergibt ${r.ergibt}` : null,
          `${r.zutaten.length} ${r.zutaten.length === 1 ? "Zutat" : "Zutaten"}`,
          `${r.schritte.length} ${r.schritte.length === 1 ? "Schritt" : "Schritte"}`,
        ].filter(Boolean);
        b.innerHTML = `<b>${escapeHtml(r.name)}</b><span class="muted small">${escapeHtml(teile.join(" · "))}</span>`;
        b.onclick = () => zeigeRezept(r, onChange);
        liste.appendChild(b);
      }
    };
    such.oninput = () => {
      z.suche = such.value;
      zeichne();
    };
    zeichne();
    card.appendChild(liste);
  }

  const akt = el("div", "employee-actions");
  const neu = el("button", "btn btn-secondary", "＋ Rezept");
  neu.onclick = () => openRezeptForm(null, emp, onChange);
  const imp = el("button", "btn btn-link", "📥 Rezepte übernehmen");
  imp.onclick = () => openImport(onChange);
  akt.append(neu, imp);
  card.appendChild(akt);
  return card;
}

/** Das Rezept zum Kochen: Zutaten und Schritte getrennt, Schritte abhakbar. Das Abhaken ist bewusst
 * flüchtig – ein Rezept ist keine Aufgabe, beim nächsten Mal wird wieder von vorn gekocht. */
function zeigeRezept(r, onChange) {
  const overlay = el("div", "overlay");
  const box = el("div", "dialog dialog-gross");
  box.appendChild(el("h2", null, escapeHtml(r.name)));
  if (r.ergibt) box.appendChild(el("p", "muted small", "Ergibt " + escapeHtml(r.ergibt)));

  if (r.zutaten.length > 0) {
    box.appendChild(el("p", "muted small res-bereich", "<b>Zutaten</b>"));
    const ul = el("div", "task-list");
    for (const zt of r.zutaten) ul.appendChild(el("div", "task-row", `<div class="task-row-text"><span>${escapeHtml(zt)}</span></div>`));
    box.appendChild(ul);
  }
  if (r.schritte.length > 0) {
    box.appendChild(el("p", "muted small res-bereich", "<b>So geht's</b>"));
    const ol = el("div", "task-list");
    r.schritte.forEach((sch, i) => {
      const row = el("label", "task-row");
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.onchange = () => row.classList.toggle("done", cb.checked);
      row.appendChild(cb);
      row.appendChild(el("div", "task-row-text", `<span><b>${i + 1}.</b> ${escapeHtml(sch)}</span>`));
      ol.appendChild(row);
    });
    box.appendChild(ol);
  }
  if (r.notiz) box.appendChild(el("p", "callout", escapeHtml(r.notiz)));
  if (r.quelle) box.appendChild(el("p", "muted small", "Übernommen aus: " + escapeHtml(r.quelle)));

  const akt = el("div", "dialog-actions");
  const aendern = el("button", "btn btn-secondary", "Ändern");
  aendern.onclick = () => {
    overlay.remove();
    openRezeptForm(r, null, onChange);
  };
  const zu = el("button", "btn btn-primary", "Schließen");
  zu.onclick = () => overlay.remove();
  akt.append(aendern, zu);
  box.appendChild(akt);
  overlay.appendChild(box);
  document.body.appendChild(overlay);
}

function openRezeptForm(vorhanden, emp, onChange) {
  const overlay = el("div", "overlay");
  const box = el("div", "dialog dialog-gross");
  box.appendChild(el("h2", null, vorhanden ? "Rezept ändern" : "Neues Rezept"));

  const name = eingabe("text", vorhanden?.name || "", "z.B. Aioli");
  const ergibt = eingabe("text", vorhanden?.ergibt || "", "z.B. 2 Behälter");
  const zutaten = mehrzeilig(vorhanden?.zutaten || [], "Eine Zutat pro Zeile:\n500 g Tomaten\n2 EL Olivenöl");
  const schritte = mehrzeilig(vorhanden?.schritte || [], "Ein Schritt pro Zeile:\nTomaten würfeln\n20 Minuten köcheln");
  const notiz = eingabe("text", vorhanden?.notiz || "", "z.B. hält 3 Tage");

  const reihe = el("div", "res-form-row");
  reihe.append(feld("Name", name), feld("Ergibt", ergibt));
  box.append(reihe, feld("Zutaten", zutaten, "Eine pro Zeile."), feld("Schritte", schritte, "Einer pro Zeile."), feld("Notiz", notiz));

  const akt = el("div", "dialog-actions");
  const abbrechen = el("button", "btn btn-secondary", "Abbrechen");
  abbrechen.onclick = () => overlay.remove();
  const speichern = el("button", "btn btn-primary", "Speichern");
  speichern.onclick = async () => {
    if (!name.value.trim()) {
      await alertDialog("Bitte einen Namen eintragen.");
      return;
    }
    const daten = {
      name: name.value.trim(),
      ergibt: ergibt.value.trim(),
      zutaten: zutaten.value,
      schritte: schritte.value,
      notiz: notiz.value.trim(),
      updatedBy: emp?.name || vorhanden?.updatedBy || null,
    };
    if (vorhanden) store.updateRecipe(vorhanden.id, daten);
    else store.addRecipe(daten);
    overlay.remove();
    onChange();
  };
  akt.append(abbrechen, speichern);
  box.appendChild(akt);

  if (vorhanden) {
    const unten = el("div", "res-dialog-danger");
    const weg = el("button", "btn btn-link", "Löschen");
    weg.onclick = async () => {
      if (!(await confirmDialog(`Rezept „${escapeHtml(vorhanden.name)}“ löschen?`, { danger: true, okLabel: "Löschen" }))) return;
      store.removeRecipe(vorhanden.id);
      overlay.remove();
      onChange();
    };
    unten.appendChild(weg);
    box.appendChild(unten);
  }
  overlay.appendChild(box);
  document.body.appendChild(overlay);
  name.focus();
}

// ---------------------------------------------------------------------
// Rezepte aus einer anderen App übernehmen
//
// Zwei Formate, weil beide vorkommen: die Datei, die eine App ausgibt (JSON), und das, was man von Hand
// zusammenkopiert (Text). Gleiche Namen werden ersetzt statt verdoppelt.
// ---------------------------------------------------------------------
function openImport(onChange) {
  const overlay = el("div", "overlay");
  const box = el("div", "dialog dialog-gross");
  box.appendChild(el("h2", null, "Rezepte übernehmen"));
  box.appendChild(
    el(
      "p",
      "muted small",
      `Entweder die Export-Datei einer anderen App hier hineinkopieren (JSON) – oder die Rezepte als Text in dieser Form:<br><br>
       <code># Aioli<br>Ergibt: 2 Behälter<br>Zutaten:<br>- 3 Knoblauchzehen<br>- 250 ml Öl<br>Schritte:<br>- alles mixen<br>---<br># Nächstes Rezept</code>`
    )
  );
  const feldText = document.createElement("textarea");
  feldText.rows = 12;
  feldText.placeholder = "Hier einfügen…";
  box.appendChild(feld("Inhalt", feldText));
  const status = el("p", "muted small");
  box.appendChild(status);

  const akt = el("div", "dialog-actions");
  const abbrechen = el("button", "btn btn-secondary", "Abbrechen");
  abbrechen.onclick = () => overlay.remove();
  const los = el("button", "btn btn-primary", "Übernehmen");
  los.onclick = async () => {
    const roh = feldText.value.trim();
    if (!roh) {
      status.className = "res-warn small";
      status.textContent = "Bitte etwas einfügen.";
      return;
    }
    let liste;
    try {
      liste = leseRezepte(roh);
    } catch (e) {
      status.className = "callout callout-warn";
      status.textContent = e.message;
      return;
    }
    if (liste.length === 0) {
      status.className = "callout callout-warn";
      status.textContent = "Darin war kein Rezept zu erkennen. Prüf bitte das Format.";
      return;
    }
    const ergebnis = store.importRecipes(liste, "Import");
    overlay.remove();
    await alertDialog(
      `${ergebnis.neu} neu übernommen, ${ergebnis.aktualisiert} aktualisiert (gleicher Name).` +
        (ergebnis.verknuepft > 0
          ? ` ${ergebnis.verknuepft} ${ergebnis.verknuepft === 1 ? "Vorbereitung hat" : "Vorbereitungen haben"} dadurch ein Rezept bekommen.`
          : ""),
      { title: "Rezepte übernommen" }
    );
    onChange();
  };
  akt.append(abbrechen, los);
  box.appendChild(akt);
  overlay.appendChild(box);
  document.body.appendChild(overlay);
  feldText.focus();
}

/** Erkennt Rezepte in eingefügtem JSON oder Text. Exportiert, damit sich das Erkennen prüfen lässt,
 * ohne eine Oberfläche zu bedienen. */
function leseRezepte(roh) {
  const text = String(roh || "").trim();
  if (!text) return [];

  if (text.startsWith("{") || text.startsWith("[")) {
    let daten;
    try {
      daten = JSON.parse(text);
    } catch {
      throw new Error("Das sieht nach JSON aus, lässt sich aber nicht lesen. Vermutlich fehlt ein Stück am Anfang oder Ende.");
    }
    const liste = findeRezeptListe(daten);
    if (!liste) throw new Error("In dieser Datei war keine Liste von Rezepten zu finden.");
    return liste.map(ausObjekt).filter((r) => r.name);
  }

  // Textform: Blöcke, getrennt durch "---" oder eine Zeile, die mit # beginnt.
  const bloecke = text
    .split(/\n\s*---+\s*\n/)
    .flatMap((b) => (b.includes("\n#") ? b.split(/\n(?=#\s)/) : [b]))
    .map((b) => b.trim())
    .filter(Boolean);
  return bloecke.map(ausText).filter((r) => r.name);
}

/** Sucht in einem beliebigen JSON-Gebilde die erste Liste, die nach Rezepten aussieht. Apps verpacken
 * ihre Daten unterschiedlich tief ({recipes: [...]}, {data: {items: [...]}}). */
function findeRezeptListe(daten, tiefe = 0) {
  if (tiefe > 4 || !daten) return null;
  if (Array.isArray(daten)) {
    return daten.some((x) => x && typeof x === "object" && (x.name || x.title || x.titel)) ? daten : null;
  }
  if (typeof daten !== "object") return null;
  for (const key of ["recipes", "rezepte", "items", "data", "list", "entries"]) {
    if (daten[key]) {
      const treffer = findeRezeptListe(daten[key], tiefe + 1);
      if (treffer) return treffer;
    }
  }
  for (const wert of Object.values(daten)) {
    const treffer = findeRezeptListe(wert, tiefe + 1);
    if (treffer) return treffer;
  }
  return null;
}

/** Ein Rezept-Objekt aus einer fremden App auf unsere Felder abbilden. */
function ausObjekt(o) {
  const zeilen = (v) => {
    if (Array.isArray(v)) {
      return v
        .map((x) => {
          if (typeof x === "string") return x;
          if (!x || typeof x !== "object") return "";
          const teile = [x.menge ?? x.amount ?? x.quantity, x.einheit ?? x.unit, x.name ?? x.text ?? x.zutat ?? x.ingredient];
          return teile.filter((t) => t !== undefined && t !== null && String(t).trim() !== "").join(" ");
        })
        .filter(Boolean);
    }
    return String(v || "")
      .split("\n")
      .map((zl) => zl.replace(/^\s*[-*•]\s*/, "").trim())
      .filter(Boolean);
  };
  return {
    name: String(o?.name ?? o?.title ?? o?.titel ?? "").trim(),
    ergibt: String(o?.ergibt ?? o?.yield ?? o?.servings ?? o?.portionen ?? "").trim(),
    zutaten: zeilen(o?.zutaten ?? o?.ingredients ?? o?.zutatenliste),
    schritte: zeilen(o?.schritte ?? o?.steps ?? o?.instructions ?? o?.zubereitung ?? o?.method),
    notiz: String(o?.notiz ?? o?.note ?? o?.notes ?? o?.description ?? "").trim(),
  };
}

/** Ein Textblock -> Rezept. Erkennt "Zutaten:" und "Schritte:"/"Zubereitung:" als Abschnitte; steht
 * nichts davon drin, gilt alles ab der zweiten Zeile als Zutaten. */
function ausText(block) {
  const zeilen = block.split("\n").map((zl) => zl.trim());
  const name = (zeilen.shift() || "").replace(/^#+\s*/, "").trim();
  const r = { name, ergibt: "", zutaten: [], schritte: [], notiz: "" };
  let abschnitt = "zutaten";
  for (const zl of zeilen) {
    if (!zl) continue;
    const klein = zl.toLowerCase();
    if (/^(ergibt|menge|yield|portionen)\s*:/.test(klein)) {
      r.ergibt = zl.split(":").slice(1).join(":").trim();
      continue;
    }
    if (/^(zutaten|ingredients)\s*:?$/.test(klein)) {
      abschnitt = "zutaten";
      continue;
    }
    if (/^(schritte|zubereitung|so geht.s|steps|anleitung)\s*:?$/.test(klein)) {
      abschnitt = "schritte";
      continue;
    }
    if (/^(notiz|hinweis|note)\s*:/.test(klein)) {
      r.notiz = zl.split(":").slice(1).join(":").trim();
      continue;
    }
    r[abschnitt].push(zl.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim());
  }
  return r;
}

export { buildKuecheKarte, buildRezepteKarte, leseRezepte };
