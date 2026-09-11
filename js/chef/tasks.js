// ============================================================================
// chef/tasks.js – Aufgaben am Laptop: Standard-Aufgaben pflegen und einzelne Aufgaben verteilen.
//
// Zwei Dinge, die zusammengehören, aber verschieden funktionieren:
//   Standard-Aufgaben sind die Regel ("donnerstags nimmt die Mittelschicht die Lieferung an"). Sie
//   gehören dem iPad, das daraus die Tage anlegt – der Laptop reicht Änderungen ein.
//   Einzelaufgaben sind die Ausnahme ("Anna soll heute den Kühlschrank abtauen"). Die liegen ohnehin
//   in derselben Liste, die auch der Bot füllt, und werden deshalb direkt geschrieben.
//
// Am Laptop tippt niemand mit dem Finger, deshalb hier dichter als am iPad: eine Tabelle statt Karten,
// alles auf einem Bildschirm.
// ============================================================================
import { escapeHtml, todayStr, dateDe } from "../format.js";
import { taskAction, taskTemplateAction } from "./api.js";

const WOCHENTAGE_KURZ = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];
const SCHICHT_LABEL = { frueh: "Frühschicht", mittel: "Mittelschicht", spaet: "Spätschicht" };
const PRIO_LABEL = { hoch: "🔴 Hoch", normal: "Normal", niedrig: "🔵 Niedrig" };
// Die drei Abschnitte einer Schicht – dieselbe Reihenfolge und dieselben Namen wie auf dem iPad.
const PHASEN = ["beginn", "schicht", "ende"];
const PHASE_LABEL = { beginn: "Schichtbeginn", schicht: "Während der Schicht", ende: "Schichtende" };
const phaseVon = (v) => (PHASEN.includes(v?.phase) ? v.phase : "schicht");

function addDaysISO(dateStr, n) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

function renderTasks(state, { onChanged }) {
  const el = document.createElement("div");
  // Überlebt das Neuzeichnen: welche Vorlage gerade bearbeitet wird ("neu" für eine neue).
  let bearbeite = null;

  function rerender() {
    el.innerHTML = "";
    el.appendChild(build());
  }

  function build() {
    const frag = document.createElement("div");
    frag.innerHTML = `
      <h1>📋 Aufgaben</h1>
      <p class="muted">Standard-Aufgaben sind die Regel: Wer einstempelt, bekommt sie als eigene Liste,
      geordnet nach Schichtbeginn, während der Schicht und Schichtende. Einzelaufgaben betreffen nur
      einen bestimmten Tag und eine bestimmte Person.</p>
    `;
    frag.appendChild(buildVorlagen());
    frag.appendChild(buildAufgaben());
    return frag;
  }

  // ---- Standard-Aufgaben ----
  function buildVorlagen() {
    const card = document.createElement("section");
    card.className = "card";
    const status = document.createElement("p");
    status.className = "muted small";

    card.innerHTML = `<h2>Standard-Aufgaben</h2>
      <p class="muted small">Jede Standard-Aufgabe gehört in einen Abschnitt der Schicht:
      <b>Schichtbeginn</b>, <b>während der Schicht</b> oder <b>Schichtende</b>. Wer einstempelt, bekommt
      daraus seine eigene Liste – nur die Tage, Schichten und Bereiche, für die sie gilt. Ohne Angabe:
      jeden Tag, jede Schicht, den ganzen Tag. Eine Uhrzeit sorgt dafür, dass die Aufgabe ab dann auf dem
      iPad-Bildschirm gemeldet wird. Neues gilt ab dem nächsten Einstempeln.</p>`;

    const vorlagen = Array.isArray(state.taskTemplates) ? state.taskTemplates : [];
    if (vorlagen.length === 0) {
      card.innerHTML += `<p class="muted small">Noch keine Standard-Aufgabe angelegt.</p>`;
    } else {
      const scroll = document.createElement("div");
      scroll.style.overflowX = "auto";
      const tabelle = document.createElement("table");
      tabelle.className = "calc-table";
      tabelle.innerHTML = `<thead><tr><th>Aufgabe</th><th>Tage</th><th>Schicht</th><th>Bereich</th><th>Ab</th><th>Priorität</th><th></th></tr></thead>`;
      const tbody = document.createElement("tbody");
      const sortiert = PHASEN.flatMap((ph) => vorlagen.filter((v) => phaseVon(v) === ph));
      let letztePhase = null;
      for (const v of sortiert) {
        if (phaseVon(v) !== letztePhase) {
          letztePhase = phaseVon(v);
          const kopfZeile = document.createElement("tr");
          kopfZeile.innerHTML = `<td colspan="7" class="muted small"><b>${escapeHtml(PHASE_LABEL[letztePhase])}</b></td>`;
          tbody.appendChild(kopfZeile);
        }
        const tr = document.createElement("tr");
        tr.innerHTML = `<td><b>${escapeHtml(v.text)}</b></td>
          <td>${v.weekdays && v.weekdays.length > 0 ? v.weekdays.map((w) => WOCHENTAGE_KURZ[w]).join(", ") : "<span class='muted'>jeden Tag</span>"}</td>
          <td>${v.schicht ? escapeHtml(SCHICHT_LABEL[v.schicht]) : "<span class='muted'>alle</span>"}</td>
          <td>${v.bereich ? (v.bereich === "kueche" ? "Küche" : "Service") : "<span class='muted'>alle</span>"}</td>
          <td>${v.time ? escapeHtml(v.time) : "<span class='muted'>–</span>"}</td>
          <td>${escapeHtml(PRIO_LABEL[v.priority] || "Normal")}</td>`;
        const td = document.createElement("td");
        const aendern = document.createElement("button");
        aendern.className = "btn btn-secondary";
        aendern.textContent = "Ändern";
        aendern.onclick = () => {
          bearbeite = v;
          rerender();
        };
        const weg = document.createElement("button");
        weg.className = "btn btn-link";
        weg.textContent = "✕";
        weg.title = "Standard-Aufgabe löschen";
        weg.onclick = () => {
          if (!confirm(`Standard-Aufgabe „${v.text}" löschen?`)) return;
          aktion(() => taskTemplateAction({ kind: "delete", templateId: v.id }), status);
        };
        td.append(aendern, weg);
        tr.appendChild(td);
        tbody.appendChild(tr);
      }
      tabelle.appendChild(tbody);
      scroll.appendChild(tabelle);
      card.appendChild(scroll);
    }

    if (bearbeite) {
      card.appendChild(buildVorlagenForm(bearbeite === "neu" ? null : bearbeite, status));
    } else {
      const neu = document.createElement("button");
      neu.className = "btn btn-primary";
      neu.textContent = "＋ Neue Standard-Aufgabe";
      neu.onclick = () => {
        bearbeite = "neu";
        rerender();
      };
      card.appendChild(neu);
    }
    card.appendChild(status);
    return card;
  }

  function buildVorlagenForm(vorhanden, status) {
    const box = document.createElement("div");
    box.className = "res-form";
    const entwurf = {
      text: vorhanden?.text || "",
      phase: phaseVon(vorhanden),
      weekdays: [...(vorhanden?.weekdays || [])],
      schicht: vorhanden?.schicht || "",
      bereich: vorhanden?.bereich || "",
      time: vorhanden?.time || "",
      priority: vorhanden?.priority || "normal",
    };

    const feld = (label, node, hinweis) => {
      const l = document.createElement("label");
      l.className = "field";
      l.innerHTML = `<span>${label}</span>`;
      l.appendChild(node);
      if (hinweis) {
        const h = document.createElement("p");
        h.className = "muted small";
        h.textContent = hinweis;
        l.appendChild(h);
      }
      return l;
    };
    const auswahl = (paare, wert) => {
      const sel = document.createElement("select");
      for (const [v, label] of paare) {
        const o = document.createElement("option");
        o.value = v;
        o.textContent = label;
        sel.appendChild(o);
      }
      sel.value = wert;
      return sel;
    };

    const textInput = document.createElement("input");
    textInput.type = "text";
    textInput.placeholder = "z.B. Lieferung entgegennehmen";
    textInput.value = entwurf.text;
    textInput.oninput = () => (entwurf.text = textInput.value);
    box.appendChild(feld("Aufgabe", textInput));

    const phase = auswahl(PHASEN.map((ph) => [ph, PHASE_LABEL[ph]]), entwurf.phase);
    phase.onchange = () => (entwurf.phase = phase.value);
    box.appendChild(
      feld("Wann in der Schicht?", phase, "Schichtbeginn steht beim Einstempeln oben, Schichtende erst gegen Feierabend.")
    );

    // Wochentage als Umschalter – schneller zu überblicken als eine Mehrfachauswahl-Liste.
    const tage = document.createElement("div");
    tage.className = "handoff-days";
    const tageHinweis = document.createElement("p");
    tageHinweis.className = "muted small";
    const setzeHinweis = () => {
      tageHinweis.textContent = entwurf.weekdays.length === 0 ? "Keiner ausgewählt = jeden Tag." : "";
    };
    for (let i = 0; i < 7; i++) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = WOCHENTAGE_KURZ[i];
      const male = () => (btn.className = "btn " + (entwurf.weekdays.includes(i) ? "btn-primary" : "btn-secondary"));
      btn.onclick = () => {
        entwurf.weekdays = entwurf.weekdays.includes(i)
          ? entwurf.weekdays.filter((x) => x !== i)
          : [...entwurf.weekdays, i].sort((a, b) => a - b);
        male();
        setzeHinweis();
      };
      male();
      tage.appendChild(btn);
    }
    const tageFeld = feld("An welchen Tagen?", tage);
    setzeHinweis();
    tageFeld.appendChild(tageHinweis);
    box.appendChild(tageFeld);

    const schicht = auswahl(
      [["", "Alle Schichten"], ["frueh", "Frühschicht"], ["mittel", "Mittelschicht"], ["spaet", "Spätschicht"]],
      entwurf.schicht
    );
    schicht.onchange = () => (entwurf.schicht = schicht.value);
    const bereich = auswahl([["", "Service und Küche"], ["service", "Nur Service"], ["kueche", "Nur Küche"]], entwurf.bereich);
    bereich.onchange = () => (entwurf.bereich = bereich.value);
    const zeit = document.createElement("input");
    zeit.type = "time";
    zeit.step = 300;
    zeit.value = entwurf.time;
    zeit.oninput = () => (entwurf.time = zeit.value);
    const prio = auswahl([["normal", "Normal"], ["hoch", "🔴 Hoch"], ["niedrig", "🔵 Niedrig"]], entwurf.priority);
    prio.onchange = () => (entwurf.priority = prio.value);

    const reihe = document.createElement("div");
    reihe.className = "res-form-row";
    reihe.append(
      feld("Welche Schicht?", schicht),
      feld("Bereich", bereich),
      feld("Ab wann fällig?", zeit),
      feld("Priorität", prio)
    );
    box.appendChild(reihe);
    const zeitHinweis = document.createElement("p");
    zeitHinweis.className = "muted small";
    zeitHinweis.textContent =
      "Uhrzeit leer lassen, wenn es den ganzen Tag über erledigt werden kann. Mit Uhrzeit erscheint die Aufgabe ab dann groß auf dem iPad-Bildschirm und wird nach 30 Minuten rot.";
    box.appendChild(zeitHinweis);

    const akt = document.createElement("div");
    akt.className = "employee-actions";
    const speichern = document.createElement("button");
    speichern.className = "btn btn-primary";
    speichern.textContent = "Speichern";
    speichern.onclick = () => {
      if (!entwurf.text.trim()) {
        status.className = "res-warn small";
        status.textContent = "Bitte eine Aufgabe eintragen.";
        return;
      }
      bearbeite = null;
      aktion(
        () => taskTemplateAction(vorhanden ? { kind: "update", templateId: vorhanden.id, ...entwurf } : { kind: "create", ...entwurf }),
        status
      );
    };
    const abbrechen = document.createElement("button");
    abbrechen.className = "btn btn-link";
    abbrechen.textContent = "Abbrechen";
    abbrechen.onclick = () => {
      bearbeite = null;
      rerender();
    };
    akt.append(speichern, abbrechen);
    box.appendChild(akt);
    return box;
  }

  // ---- Einzelaufgaben ----
  function buildAufgaben() {
    const card = document.createElement("section");
    card.className = "card";
    const status = document.createElement("p");
    status.className = "muted small";
    const heute = todayStr();

    card.innerHTML = `<h2>Aufgaben der nächsten Tage</h2>
      <p class="muted small">Alles ab heute – hier eingetragen, per Telegram angelegt oder beim
      Einstempeln aus einer Standard-Aufgabe entstanden. Für kommende Tage steht hier nur, was jemandem
      fest zugeteilt ist: die Standard-Aufgaben entstehen erst, wenn die Person einstempelt.</p>`;

    card.appendChild(buildNeueAufgabe(status));

    const alle = (Array.isArray(state.tasks) ? state.tasks : [])
      .filter((t) => (t.date || "") >= heute)
      .sort((a, b) => (a.date + (a.time || "99:99")).localeCompare(b.date + (b.time || "99:99")));

    if (alle.length === 0) {
      card.innerHTML += `<p class="muted small">Keine Aufgaben ab heute.</p>`;
      card.appendChild(status);
      return card;
    }

    const proTag = {};
    for (const t of alle) (proTag[t.date] ||= []).push(t);

    for (const datum of Object.keys(proTag).sort()) {
      const kopf = document.createElement("p");
      kopf.className = "muted small res-bereich";
      const offen = proTag[datum].filter((t) => !t.done).length;
      kopf.innerHTML = `<b>${escapeHtml(dateDe(datum))}</b> · ${proTag[datum].length} ${
        proTag[datum].length === 1 ? "Aufgabe" : "Aufgaben"
      }, ${offen} offen`;
      card.appendChild(kopf);

      const liste = document.createElement("div");
      liste.className = "task-list";
      for (const t of proTag[datum]) {
        const row = document.createElement("div");
        row.className = "task-row" + (t.done ? " done" : "");
        const merkmale = [
          t.phase ? PHASE_LABEL[t.phase] : null,
          t.assignedToName || null,
          t.schicht ? SCHICHT_LABEL[t.schicht] : null,
          t.bereich ? (t.bereich === "kueche" ? "Küche" : "Service") : null,
          t.time ? "ab " + t.time + " Uhr" : null,
        ].filter(Boolean);
        row.innerHTML = `<div class="task-row-text">
          <span>${t.priority === "hoch" ? "🔴 " : t.priority === "niedrig" ? "🔵 " : ""}${escapeHtml(t.text)}</span>
          <span class="muted small task-row-meta">${merkmale.length > 0 ? escapeHtml(merkmale.join(" · ")) : "für alle"}</span></div>`;

        const akt = document.createElement("div");
        akt.className = "employee-actions";
        const haken = document.createElement("button");
        haken.className = "btn " + (t.done ? "btn-secondary" : "btn-primary");
        haken.textContent = t.done ? "Wieder öffnen" : "Erledigt";
        haken.onclick = () => aktion(() => taskAction({ kind: "toggle", taskId: t.id, done: !t.done }), status);
        const weg = document.createElement("button");
        weg.className = "btn btn-link";
        weg.textContent = "✕";
        weg.onclick = () => {
          if (!confirm(`Aufgabe „${t.text}" löschen?`)) return;
          aktion(() => taskAction({ kind: "delete", taskId: t.id }), status);
        };
        akt.append(haken, weg);
        row.appendChild(akt);
        liste.appendChild(row);
      }
      card.appendChild(liste);
    }
    card.appendChild(status);
    return card;
  }

  function buildNeueAufgabe(status) {
    const box = document.createElement("div");
    box.className = "res-form";
    const titel = document.createElement("p");
    titel.className = "muted small";
    titel.innerHTML = "<b>Neue Aufgabe</b>";
    box.appendChild(titel);

    const feld = (label, node) => {
      const l = document.createElement("label");
      l.className = "field";
      l.innerHTML = `<span>${label}</span>`;
      l.appendChild(node);
      return l;
    };
    const text = document.createElement("input");
    text.type = "text";
    text.placeholder = "z.B. Kühlschrank abtauen";
    const datum = document.createElement("input");
    datum.type = "date";
    datum.value = todayStr();
    datum.min = todayStr();
    const person = document.createElement("select");
    const keiner = document.createElement("option");
    keiner.value = "";
    keiner.textContent = "Niemandem fest";
    person.appendChild(keiner);
    for (const name of Array.isArray(state.employees) ? state.employees : []) {
      const o = document.createElement("option");
      o.value = name;
      o.textContent = name;
      person.appendChild(o);
    }
    const zeit = document.createElement("input");
    zeit.type = "time";
    zeit.step = 300;

    const reihe = document.createElement("div");
    reihe.className = "res-form-row";
    reihe.append(feld("Aufgabe", text), feld("Tag", datum), feld("Wer?", person), feld("Ab wann?", zeit));
    box.appendChild(reihe);

    const knopf = document.createElement("button");
    knopf.className = "btn btn-primary";
    knopf.textContent = "Eintragen";
    knopf.onclick = () => {
      if (!text.value.trim()) {
        status.className = "res-warn small";
        status.textContent = "Bitte eine Aufgabe eintragen.";
        return;
      }
      aktion(
        () =>
          taskAction({
            kind: "create",
            text: text.value,
            date: datum.value || todayStr(),
            assignedToName: person.value,
            time: zeit.value,
          }),
        status
      );
    };
    box.appendChild(knopf);

    const hinweis = document.createElement("p");
    hinweis.className = "muted small";
    hinweis.textContent = `Ohne Tag wird es heute (${dateDe(todayStr())}). Bis übermorgen (${dateDe(addDaysISO(todayStr(), 2))}) ist alles planbar, was schon angelegt ist.`;
    box.appendChild(hinweis);
    return box;
  }

  /** Änderung einreichen und neu laden. Fehler landen als Hinweis in der jeweiligen Karte. */
  async function aktion(fn, statusEl) {
    statusEl.className = "muted small";
    statusEl.textContent = "Wird gespeichert…";
    try {
      await fn();
      await onChanged();
    } catch (e) {
      statusEl.className = "callout callout-warn";
      statusEl.textContent = e.message;
    }
  }

  rerender();
  return el;
}

export { renderTasks };
