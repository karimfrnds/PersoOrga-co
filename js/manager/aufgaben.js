// ============================================================================
// manager/aufgaben.js – Aufgaben im Laden.
//
// Zwei Dinge, als Umschalter oben:
//   Im Laden  – die Aufgaben eines Tages: wer hat was, was ist offen. Anlegen, jemandem geben, abhaken.
//   Standard  – die Regeln, aus denen beim Einstempeln die Listen entstehen ("Mittelschicht donnerstags
//               Lieferung annehmen"). Anlegen, ändern, löschen.
// ============================================================================
import { taskAction, templateAction } from "./api.js";
import {
  el,
  text,
  knopf,
  feld,
  eingabe,
  auswahl,
  wochentagWahl,
  segmente,
  blatt,
  toast,
  ausfuehren,
  addDays,
  tagName,
  WT,
  PHASEN,
} from "./ui.js";

let ansicht = "laden";
let tag = null;

const SCHICHTEN = [
  ["", "Alle Schichten"],
  ["frueh", "Frühschicht"],
  ["mittel", "Mittelschicht"],
  ["spaet", "Spätschicht"],
];
const BEREICH = [
  ["", "Service und Küche"],
  ["service", "Nur Service"],
  ["kueche", "Nur Küche"],
];
const PRIO = [
  ["normal", "Normal"],
  ["hoch", "🔴 Hoch"],
  ["niedrig", "🔵 Niedrig"],
];

function renderAufgaben(daten, { neuLaden }) {
  const wrap = el("div");
  const neu = () => wrap.replaceWith(renderAufgaben(daten, { neuLaden }));
  wrap.appendChild(
    segmente(
      [
        ["laden", "Im Laden"],
        ["standard", "Standard"],
      ],
      ansicht,
      (id) => {
        ansicht = id;
        neu();
      }
    )
  );
  wrap.appendChild(ansicht === "laden" ? buildLaden(daten, neuLaden, neu) : buildStandard(daten, neuLaden));
  return wrap;
}

// ---------------------------------------------------------------------
// Im Laden
// ---------------------------------------------------------------------
function buildLaden(daten, neuLaden, neu) {
  const heute = daten.heute;
  if (!tag || tag < heute) tag = heute;
  const box = el("div");

  const tage = el("div", "mg-chips mg-tagwahl");
  for (let i = 0; i < 7; i++) {
    const d = addDays(heute, i);
    const anzahl = (daten.tasks || []).filter((t) => t.date === d && !t.done).length;
    const b = knopf(`${tagName(d, heute)}${anzahl ? ` · ${anzahl}` : ""}`, "mg-chip" + (d === tag ? " an" : ""), () => {
      tag = d;
      neu();
    });
    tage.appendChild(b);
  }
  box.appendChild(tage);

  box.appendChild(knopf("＋ Aufgabe für diesen Tag", "btn btn-primary", () => aufgabeBlatt(daten, null, tag, neuLaden)));

  const liste = (daten.tasks || []).filter((t) => t.date === tag);
  const offen = liste.filter((t) => !t.done);
  const erledigt = liste.filter((t) => t.done);
  const card = el("section", "card");
  card.appendChild(text("h2", null, `${tagName(tag, heute)} · ${offen.length} offen`));
  if (liste.length === 0) {
    card.appendChild(
      text(
        "p",
        "muted small",
        tag === heute
          ? "Noch keine Aufgaben. Die Standard-Aufgaben entstehen, wenn jemand einstempelt."
          : "Noch nichts eingetragen. Standard-Aufgaben kommen dazu, sobald jemand an dem Tag einstempelt."
      )
    );
  }
  const l = el("div", "mg-liste");
  for (const t of [...offen, ...erledigt]) l.appendChild(aufgabeZeile(daten, t, neuLaden));
  card.appendChild(l);
  box.appendChild(card);
  return box;
}

const PHASE_KURZ = { beginn: "Beginn", schicht: "Während", ende: "Ende" };

function aufgabeZeile(daten, t, neuLaden) {
  const z = el("div", "mg-aufgabe" + (t.done ? " erledigt" : ""));
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = !!t.done;
  cb.onchange = async () => {
    cb.disabled = true;
    const ok = await ausfuehren(null, () => taskAction({ kind: "toggle", taskId: t.id, done: cb.checked }));
    if (ok) neuLaden();
    else {
      cb.checked = !cb.checked;
      cb.disabled = false;
    }
  };
  z.appendChild(cb);
  const mitte = knopf("", "mg-aufgabe-text", () => aufgabeBlatt(daten, t, t.date, neuLaden));
  const meta = [t.assignedToName || "für alle", t.phase ? PHASE_KURZ[t.phase] : null, t.time ? `ab ${t.time}` : null].filter(Boolean).join(" · ");
  mitte.innerHTML = `<span></span><span class="muted small"></span>`;
  mitte.firstChild.textContent = (t.priority === "hoch" ? "🔴 " : t.priority === "niedrig" ? "🔵 " : "") + t.text;
  mitte.lastChild.textContent = meta;
  z.appendChild(mitte);
  return z;
}

function aufgabeBlatt(daten, vorhanden, datum, neuLaden) {
  blatt(vorhanden ? "Aufgabe ändern" : "Neue Aufgabe", (box, schliessen) => {
    const was = eingabe("text", vorhanden?.text, "z.B. Kühlschrank abtauen");
    const wann = eingabe("date", vorhanden?.date || datum);
    wann.min = daten.heute;
    const namen = [...(daten.employees || [])].sort((a, b) => a.localeCompare(b));
    const wer = auswahl([["", "Niemandem fest"], ...namen.map((n) => [n, n])], vorhanden?.assignedToName || "");
    const zeit = eingabe("time", vorhanden?.time || "");
    zeit.step = 300;
    const prio = auswahl(PRIO, vorhanden?.priority || "normal");

    box.appendChild(feld("Was?", was));
    const r = el("div", "mg-reihe");
    r.append(feld("Tag", wann), feld("Ab wann?", zeit));
    box.appendChild(r);
    box.appendChild(feld("Wer?", wer, "Mit Namen steht die Aufgabe bei der Person im eigenen Fenster am iPad."));
    box.appendChild(feld("Priorität", prio));

    box.appendChild(
      knopf("Speichern", "btn btn-primary btn-huge", async (e) => {
        if (!was.value.trim()) return toast("Bitte eintragen, was zu tun ist.", true);
        const felder = { text: was.value.trim(), date: wann.value || datum, assignedToName: wer.value, time: zeit.value, priority: prio.value };
        const ok = await ausfuehren(
          e.currentTarget,
          () => taskAction(vorhanden ? { kind: "update", taskId: vorhanden.id, ...felder } : { kind: "create", ...felder }),
          "Gespeichert"
        );
        if (ok) {
          schliessen();
          neuLaden();
        }
      })
    );
    if (vorhanden) {
      box.appendChild(
        knopf("Aufgabe löschen", "btn btn-link", async (e) => {
          if (!confirm(`„${vorhanden.text}“ löschen?`)) return;
          if (await ausfuehren(e.currentTarget, () => taskAction({ kind: "delete", taskId: vorhanden.id }), "Gelöscht")) {
            schliessen();
            neuLaden();
          }
        })
      );
    }
    was.focus();
  });
}

// ---------------------------------------------------------------------
// Standard-Aufgaben
// ---------------------------------------------------------------------
function buildStandard(daten, neuLaden) {
  const box = el("div");
  box.appendChild(
    text("p", "muted small", "Daraus entsteht beim Einstempeln die eigene Liste jeder Person – nur für die Tage, Schichten und Bereiche, für die eine Regel gilt.")
  );
  box.appendChild(knopf("＋ Standard-Aufgabe", "btn btn-primary", () => vorlageBlatt(null, neuLaden)));
  const vorlagen = daten.taskTemplates || [];
  for (const [ph, label] of PHASEN) {
    const teil = vorlagen.filter((v) => (v.phase || "schicht") === ph);
    if (teil.length === 0) continue;
    const card = el("section", "card");
    card.appendChild(text("h2", null, `${label} · ${teil.length}`));
    const l = el("div", "mg-liste");
    for (const v of teil) {
      const z = knopf("", "mg-zeile mg-zeile-knopf", () => vorlageBlatt(v, neuLaden));
      z.innerHTML = `<span></span><span class="muted small"></span>`;
      z.firstChild.textContent = (v.priority === "hoch" ? "🔴 " : "") + v.text;
      z.lastChild.textContent = beschreibe(v);
      l.appendChild(z);
    }
    card.appendChild(l);
    box.appendChild(card);
  }
  if (vorlagen.length === 0) box.appendChild(text("p", "muted", "Noch keine Standard-Aufgaben."));
  return box;
}

function beschreibe(v) {
  const teile = [Array.isArray(v.weekdays) && v.weekdays.length ? v.weekdays.map((w) => WT[w]).join(", ") : "jeden Tag"];
  if (v.schicht) teile.push(SCHICHTEN.find((s) => s[0] === v.schicht)?.[1]);
  if (v.bereich) teile.push(v.bereich === "kueche" ? "Küche" : "Service");
  if (v.time) teile.push(`ab ${v.time}`);
  if (v.bestandBereich) teile.push(`🧮 ${v.bestandBereich === "bar" ? "Bar" : "Küche"} zählen`);
  return teile.filter(Boolean).join(" · ");
}

function vorlageBlatt(v, neuLaden) {
  blatt(v ? "Standard-Aufgabe ändern" : "Neue Standard-Aufgabe", (box, schliessen) => {
    const vorlaeufig = v && String(v.id).startsWith("vorlaeufig-");
    const was = eingabe("text", v?.text, "z.B. Lieferung entgegennehmen");
    const phase = auswahl(PHASEN, v?.phase || "schicht");
    const tage = wochentagWahl(v?.weekdays || []);
    const schicht = auswahl(SCHICHTEN, v?.schicht || "");
    const bereich = auswahl(BEREICH, v?.bereich || "");
    const zeit = eingabe("time", v?.time || "");
    zeit.step = 300;
    const prio = auswahl(PRIO, v?.priority || "normal");
    const bestand = auswahl(
      [
        ["", "– nein –"],
        ["kueche", "🍳 Küche zählen"],
        ["bar", "🍸 Bar zählen"],
      ],
      v?.bestandBereich || ""
    );

    box.appendChild(feld("Was?", was));
    box.appendChild(feld("Wann in der Schicht?", phase));
    box.appendChild(feld("An welchen Tagen?", tage.node, "Keiner gewählt = jeden Tag."));
    const r = el("div", "mg-reihe");
    r.append(feld("Schicht", schicht), feld("Bereich", bereich));
    box.appendChild(r);
    const r2 = el("div", "mg-reihe");
    r2.append(feld("Ab wann?", zeit), feld("Priorität", prio));
    box.appendChild(r2);
    box.appendChild(feld("Mit Bestand verknüpft", bestand, "Für den Zähltag: erledigt, sobald jemand die Zählung abschließt."));
    if (vorlaeufig) box.appendChild(text("p", "callout", "Noch nicht am iPad angekommen – ändern geht nach dem nächsten Abgleich."));

    const speichern = knopf("Speichern", "btn btn-primary btn-huge", async (e) => {
      if (!was.value.trim()) return toast("Bitte eintragen, was zu tun ist.", true);
      const felder = {
        text: was.value.trim(),
        phase: phase.value,
        weekdays: tage.werte(),
        schicht: schicht.value,
        bereich: bereich.value,
        time: zeit.value,
        priority: prio.value,
        bestandBereich: bestand.value,
      };
      const ok = await ausfuehren(
        e.currentTarget,
        () => templateAction(v ? { kind: "update", templateId: v.id, ...felder } : { kind: "create", ...felder }),
        "Gespeichert – gilt ab dem nächsten Einstempeln"
      );
      if (ok) {
        schliessen();
        neuLaden();
      }
    });
    speichern.disabled = !!vorlaeufig;
    box.appendChild(speichern);
    if (v && !vorlaeufig) {
      box.appendChild(
        knopf("Standard-Aufgabe löschen", "btn btn-link", async (e) => {
          if (!confirm(`„${v.text}“ als Standard-Aufgabe löschen? Bereits entstandene Aufgaben von heute bleiben stehen.`)) return;
          if (await ausfuehren(e.currentTarget, () => templateAction({ kind: "delete", templateId: v.id }), "Gelöscht")) {
            schliessen();
            neuLaden();
          }
        })
      );
    }
    was.focus();
  });
}

export { renderAufgaben };
