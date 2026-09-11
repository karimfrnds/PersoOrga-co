// ============================================================================
// pages/tasksAdmin.js – Admin-Tab „Aufgaben": Vorlage für jeden Tag + Übersicht
// aller zugeordneten Einzelaufgaben (manuell oder per Telegram-Bot angelegt),
// mit Mitarbeiter, Tag und Priorität – hier auch anlegen/bearbeiten möglich.
// ============================================================================
import { store, AUFGABEN_PHASEN, PHASE_LABEL } from "../store.js";
import { todayStr, dateDe, escapeHtml } from "../format.js";
import { confirmDialog, alertDialog } from "../dialog.js";

const PRIORITY_LABEL = { niedrig: "🔵 Niedrig", normal: "Normal", hoch: "🔴 Hoch" };
const WOCHENTAGE_KURZ = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];
const SCHICHT_LABEL = { frueh: "Frühschicht", mittel: "Mittelschicht", spaet: "Spätschicht" };
const PRIORITY_ORDER = { hoch: 0, normal: 1, niedrig: 2 };

function renderTasksAdmin() {
  const container = document.createElement("div");
  container.className = "page";

  // Überlebt Rerenders: welche Mitarbeiter-Gruppe aktuell aufgeklappt ist ("unassigned" für "Alle").
  let expandedGroup = null;

  function rerender() {
    container.innerHTML = "";
    container.appendChild(build());
  }

  function build() {
    const frag = document.createElement("div");
    frag.innerHTML = `<h1>Aufgaben</h1>`;
    frag.appendChild(buildTemplateCard());
    frag.appendChild(buildOverviewCard());
    return frag;
  }

  // ---------------------------------------------------------------------
  // Standard-Aufgaben (Vorlagen)
  //
  // Eine Vorlage kann an einen Wochentag, eine Schicht und eine Uhrzeit gebunden sein. Das ist der
  // Unterschied zu vorher: eine Liste, die jedem Tag gleich mitgegeben wird, kann "donnerstags nimmt die
  // Mittelschicht die Lieferung an" nicht abbilden – und wer jeden Tag dieselben zehn Punkte sieht, von
  // denen sieben ihn nichts angehen, hakt irgendwann alles blind ab.
  // ---------------------------------------------------------------------
  function buildTemplateCard() {
    const card = document.createElement("section");
    card.className = "card";
    card.innerHTML = `
      <h2>Standard-Aufgaben</h2>
      <p class="muted small">
        Jede Standard-Aufgabe gehört in einen Abschnitt der Schicht: Schichtbeginn, während der Schicht
        oder Schichtende. Wer einstempelt, bekommt daraus seine eigene Liste – nur die Tage, Schichten
        und Bereiche, für die sie gilt. Ohne Angabe heißt: jeden Tag, jede Schicht, den ganzen Tag.
      </p>
    `;

    const vorlagen = store.getTaskTemplates();
    if (vorlagen.length === 0) {
      card.innerHTML += `<p class="muted small">Noch keine Standard-Aufgabe angelegt.</p>`;
    } else {
      // Nach Abschnitt gruppiert, in der Reihenfolge des Tages – so liest sich die Liste wie ein Ablauf
      // und nicht wie ein Haufen.
      for (const ph of AUFGABEN_PHASEN) {
        const gruppe = vorlagen.filter((v) => (AUFGABEN_PHASEN.includes(v.phase) ? v.phase : "schicht") === ph);
        if (gruppe.length === 0) continue;
        const kopf = document.createElement("p");
        kopf.className = "muted small res-bereich";
        kopf.innerHTML = `<b>${escapeHtml(PHASE_LABEL[ph])}</b> · ${gruppe.length}`;
        card.appendChild(kopf);

        const liste = document.createElement("div");
        liste.className = "task-list";
        for (const v of gruppe) {
          const row = document.createElement("div");
          row.className = "task-row";
          row.innerHTML = `<div class="task-row-text">
            <span>${v.priority === "hoch" ? "🔴 " : v.priority === "niedrig" ? "🔵 " : ""}<b>${escapeHtml(v.text)}</b></span>
            <span class="muted small task-row-meta">${escapeHtml(beschreibeVorlage(v))}</span></div>`;
          const akt = document.createElement("div");
          akt.className = "employee-actions";
          const bearbeiten = document.createElement("button");
          bearbeiten.className = "btn btn-secondary";
          bearbeiten.textContent = "Ändern";
          bearbeiten.onclick = () => openTemplateForm(v);
          const weg = document.createElement("button");
          weg.className = "btn btn-link";
          weg.textContent = "✕";
          weg.onclick = async () => {
            if (!(await confirmDialog(`Standard-Aufgabe „${v.text}“ löschen?`, { danger: true, okLabel: "Löschen" }))) return;
            store.removeTaskTemplate(v.id);
            rerender();
          };
          akt.append(bearbeiten, weg);
          row.appendChild(akt);
          liste.appendChild(row);
        }
        card.appendChild(liste);
      }
    }

    const addBtn = document.createElement("button");
    addBtn.className = "btn btn-primary";
    addBtn.textContent = "＋ Neue Standard-Aufgabe";
    addBtn.onclick = () => openTemplateForm(null);
    card.appendChild(addBtn);

    const hinweis = document.createElement("p");
    hinweis.className = "muted small";
    hinweis.textContent =
      "Gilt ab dem nächsten Einstempeln. Wer gerade im Dienst ist, bekommt sie beim nächsten Abgleich nachgetragen; abgeschlossene Tage bleiben, wie sie sind.";
    card.appendChild(hinweis);
    return card;
  }

  /** Eine Vorlage in einem Satz: an welchen Tagen, in welcher Schicht, ab wann. */
  function beschreibeVorlage(v) {
    const teile = [];
    teile.push(v.weekdays && v.weekdays.length > 0 ? v.weekdays.map((w) => WOCHENTAGE_KURZ[w]).join(", ") : "jeden Tag");
    if (v.schicht) teile.push(SCHICHT_LABEL[v.schicht]);
    if (v.bereich) teile.push(v.bereich === "kueche" ? "Küche" : "Service");
    if (v.time) teile.push("ab " + v.time + " Uhr");
    return teile.join(" · ");
  }

  /** Formular für eine Standard-Aufgabe. Bewusst mit Knöpfen statt Mehrfachauswahl-Liste: das läuft am
   * iPad mit dem Finger, eine <select multiple> ist dort kaum zu treffen. */
  function openTemplateForm(vorhanden) {
    const overlay = document.createElement("div");
    overlay.className = "overlay";
    const box = document.createElement("div");
    box.className = "dialog";
    box.innerHTML = `<h2>${vorhanden ? "Standard-Aufgabe ändern" : "Neue Standard-Aufgabe"}</h2>`;

    const entwurf = {
      text: vorhanden?.text || "",
      phase: vorhanden?.phase || "schicht",
      weekdays: [...(vorhanden?.weekdays || [])],
      schicht: vorhanden?.schicht || "",
      bereich: vorhanden?.bereich || "",
      time: vorhanden?.time || "",
      priority: vorhanden?.priority || "normal",
    };

    const feld = (label, el, hinweis) => {
      const l = document.createElement("label");
      l.className = "field";
      l.innerHTML = `<span>${label}</span>`;
      l.appendChild(el);
      if (hinweis) {
        const h = document.createElement("p");
        h.className = "muted small";
        h.textContent = hinweis;
        l.appendChild(h);
      }
      return l;
    };

    const textInput = document.createElement("input");
    textInput.type = "text";
    textInput.placeholder = "z.B. Lieferung entgegennehmen";
    textInput.value = entwurf.text;
    textInput.oninput = () => (entwurf.text = textInput.value);
    box.appendChild(feld("Aufgabe", textInput));

    // Der Abschnitt steht ganz oben, weil er die wichtigste Entscheidung ist: er bestimmt, wann die
    // Aufgabe in der Schicht auftaucht.
    const phase = document.createElement("select");
    for (const ph of AUFGABEN_PHASEN) {
      const o = document.createElement("option");
      o.value = ph;
      o.textContent = PHASE_LABEL[ph];
      phase.appendChild(o);
    }
    phase.value = entwurf.phase;
    phase.onchange = () => (entwurf.phase = phase.value);
    box.appendChild(
      feld("Wann in der Schicht?", phase, "Schichtbeginn steht beim Einstempeln oben, Schichtende erst gegen Feierabend.")
    );

    // Wochentage als Umschalter
    const tage = document.createElement("div");
    tage.className = "handoff-days";
    for (let i = 0; i < 7; i++) {
      const btn = document.createElement("button");
      btn.type = "button";
      const setze = () => {
        btn.className = "btn " + (entwurf.weekdays.includes(i) ? "btn-primary" : "btn-secondary");
      };
      btn.textContent = WOCHENTAGE_KURZ[i];
      btn.onclick = () => {
        entwurf.weekdays = entwurf.weekdays.includes(i) ? entwurf.weekdays.filter((x) => x !== i) : [...entwurf.weekdays, i].sort();
        setze();
        tageHinweis.textContent = entwurf.weekdays.length === 0 ? "Keiner ausgewählt = jeden Tag." : "";
      };
      setze();
      tage.appendChild(btn);
    }
    const tageWrap = feld("An welchen Tagen?", tage);
    const tageHinweis = document.createElement("p");
    tageHinweis.className = "muted small";
    tageHinweis.textContent = entwurf.weekdays.length === 0 ? "Keiner ausgewählt = jeden Tag." : "";
    tageWrap.appendChild(tageHinweis);
    box.appendChild(tageWrap);

    const schicht = document.createElement("select");
    for (const [wert, label] of [["", "Alle Schichten"], ["frueh", "Frühschicht"], ["mittel", "Mittelschicht"], ["spaet", "Spätschicht"]]) {
      const o = document.createElement("option");
      o.value = wert;
      o.textContent = label;
      schicht.appendChild(o);
    }
    schicht.value = entwurf.schicht;
    schicht.onchange = () => (entwurf.schicht = schicht.value);

    const bereich = document.createElement("select");
    for (const [wert, label] of [["", "Service und Küche"], ["service", "Nur Service"], ["kueche", "Nur Küche"]]) {
      const o = document.createElement("option");
      o.value = wert;
      o.textContent = label;
      bereich.appendChild(o);
    }
    bereich.value = entwurf.bereich;
    bereich.onchange = () => (entwurf.bereich = bereich.value);

    const zeit = document.createElement("input");
    zeit.type = "time";
    zeit.step = 300;
    zeit.value = entwurf.time;
    zeit.oninput = () => (entwurf.time = zeit.value);

    const prio = document.createElement("select");
    for (const [wert, label] of [["normal", "Normal"], ["hoch", "🔴 Hoch"], ["niedrig", "🔵 Niedrig"]]) {
      const o = document.createElement("option");
      o.value = wert;
      o.textContent = label;
      prio.appendChild(o);
    }
    prio.value = entwurf.priority;
    prio.onchange = () => (entwurf.priority = prio.value);

    const reihe = document.createElement("div");
    reihe.className = "res-form-row";
    reihe.append(feld("Welche Schicht?", schicht), feld("Bereich", bereich));
    box.appendChild(reihe);
    box.appendChild(feld("Ab wann fällig?", zeit, "Leer lassen, wenn es den ganzen Tag über erledigt werden kann. Mit Uhrzeit erscheint sie ab dann auf dem iPad-Bildschirm."));
    box.appendChild(feld("Priorität", prio));

    const fehler = document.createElement("p");
    fehler.className = "muted small";
    box.appendChild(fehler);

    const akt = document.createElement("div");
    akt.className = "dialog-actions";
    const abbrechen = document.createElement("button");
    abbrechen.className = "btn btn-secondary";
    abbrechen.textContent = "Abbrechen";
    abbrechen.onclick = () => overlay.remove();
    const speichern = document.createElement("button");
    speichern.className = "btn btn-primary";
    speichern.textContent = "Speichern";
    speichern.onclick = () => {
      if (!entwurf.text.trim()) {
        fehler.className = "res-warn small";
        fehler.textContent = "Bitte eine Aufgabe eintragen.";
        return;
      }
      if (vorhanden) store.updateTaskTemplate(vorhanden.id, entwurf);
      else store.addTaskTemplate(entwurf);
      overlay.remove();
      rerender();
    };
    akt.append(abbrechen, speichern);
    box.appendChild(akt);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    textInput.focus();
  }

  // ---------------------------------------------------------------------
  // Übersicht der zugeordneten Einzelaufgaben (heute + kommende Tage)
  // ---------------------------------------------------------------------
  function buildOverviewCard() {
    const card = document.createElement("section");
    card.className = "card";
    card.innerHTML = `
      <h2>Zugeordnete Aufgaben</h2>
      <p class="muted small">Alle Einzelaufgaben ab heute – manuell angelegt oder per Telegram-Bot eingetragen.</p>
    `;

    const addBtn = document.createElement("button");
    addBtn.className = "btn btn-primary";
    addBtn.textContent = "＋ Neue Aufgabe";
    addBtn.onclick = () => openTaskForm(null);
    card.appendChild(addBtn);

    const rows = store.getTasksFrom(todayStr()).sort((a, b) => {
      if (a.date !== b.date) return a.date < b.date ? -1 : 1;
      return (PRIORITY_ORDER[a.priority] ?? 1) - (PRIORITY_ORDER[b.priority] ?? 1);
    });

    if (rows.length === 0) {
      const empty = document.createElement("p");
      empty.className = "muted small";
      empty.textContent = "Keine Aufgaben ab heute.";
      card.appendChild(empty);
      return card;
    }

    const employees = store.getEmployees(true);
    // Nach Mitarbeiter gruppieren ("unassigned" = "Alle"-Aufgaben ohne Zuordnung).
    const groups = new Map();
    for (const row of rows) {
      const key = row.assignedTo || "unassigned";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    }
    // Reihenfolge: zugeordnete Mitarbeiter (alphabetisch), "Alle" zuletzt.
    const orderedKeys = [
      ...employees.map((e) => e.id).filter((id) => groups.has(id)),
      ...(groups.has("unassigned") ? ["unassigned"] : []),
    ];

    const groupList = document.createElement("div");
    groupList.className = "group-list";
    for (const key of orderedKeys) {
      const groupRows = groups.get(key);
      const employee = key === "unassigned" ? null : employees.find((e) => e.id === key);
      const label = employee ? employee.name : "Alle (nicht zugeordnet)";
      const openCount = groupRows.filter((r) => !r.done).length;
      const isOpen = expandedGroup === key;

      const groupWrap = document.createElement("div");
      const headerBtn = document.createElement("button");
      headerBtn.className = "group-header" + (isOpen ? " open" : "");
      headerBtn.innerHTML = `
        <span class="group-header-chevron">▶</span>
        <span class="group-header-name">${escapeHtml(label)}</span>
        <span class="group-header-meta">${openCount} offen · ${groupRows.length - openCount} erledigt</span>
      `;
      headerBtn.onclick = () => {
        expandedGroup = isOpen ? null : key;
        rerender();
      };
      groupWrap.appendChild(headerBtn);

      if (isOpen) {
        const body = document.createElement("div");
        body.className = "group-body";
        const list = document.createElement("div");
        list.className = "task-list";
        for (const row of groupRows) {
          list.appendChild(buildTaskRow(row));
        }
        body.appendChild(list);
        groupWrap.appendChild(body);
      }

      groupList.appendChild(groupWrap);
    }
    card.appendChild(groupList);
    return card;
  }

  function buildTaskRow(row) {
    const wrap = document.createElement("div");
    wrap.className = "task-row" + (row.done ? " done" : "");

    const textWrap = document.createElement("div");
    textWrap.className = "task-row-text";
    const header = document.createElement("span");
    header.innerHTML = `<b>${escapeHtml(dateDe(row.date))}</b>${row.priority !== "normal" ? ` · ${PRIORITY_LABEL[row.priority]}` : ""}`;
    textWrap.appendChild(header);
    const textSpan = document.createElement("span");
    textSpan.textContent = row.text;
    textWrap.appendChild(textSpan);
    if (row.done) {
      const doneMeta = document.createElement("span");
      doneMeta.className = "muted small task-row-meta";
      doneMeta.textContent = `✓ erledigt${row.doneBy ? " von " + row.doneBy : ""}`;
      textWrap.appendChild(doneMeta);
    }
    wrap.appendChild(textWrap);

    const actions = document.createElement("div");
    actions.className = "employee-actions";
    const editBtn = document.createElement("button");
    editBtn.className = "btn btn-secondary";
    editBtn.textContent = "Bearbeiten";
    editBtn.onclick = () => openTaskForm(row);
    actions.appendChild(editBtn);
    const delBtn = document.createElement("button");
    delBtn.className = "btn btn-icon-danger";
    delBtn.textContent = "✕";
    delBtn.onclick = async () => {
      if (await confirmDialog(`Aufgabe „${row.text}" endgültig löschen?`, { danger: true, okLabel: "Löschen" })) {
        store.removeDayTask(row.dayId, row.id);
        rerender();
      }
    };
    actions.appendChild(delBtn);
    wrap.appendChild(actions);
    return wrap;
  }

  function openTaskForm(existing) {
    const isEdit = !!existing;
    const employees = store.getEmployees(false);
    const overlay = document.createElement("div");
    overlay.className = "overlay";
    overlay.innerHTML = `
      <div class="dialog">
        <h2>${isEdit ? "Aufgabe bearbeiten" : "Neue Aufgabe"}</h2>
        <label class="field"><span>Aufgabe</span><input type="text" id="t-text" value="${existing ? escapeHtml(existing.text) : ""}" /></label>
        <label class="field"><span>Mitarbeiter</span>
          <select id="t-assignee">
            <option value="">– Alle –</option>
            ${employees.map((e) => `<option value="${e.id}" ${existing?.assignedTo === e.id ? "selected" : ""}>${escapeHtml(e.name)}</option>`).join("")}
          </select>
        </label>
        <label class="field"><span>Tag</span><input type="date" id="t-date" value="${existing ? existing.date : todayStr()}" /></label>
        <label class="field"><span>Priorität</span>
          <select id="t-priority">
            <option value="niedrig" ${existing?.priority === "niedrig" ? "selected" : ""}>🔵 Niedrig</option>
            <option value="normal" ${!existing || existing.priority === "normal" ? "selected" : ""}>Normal</option>
            <option value="hoch" ${existing?.priority === "hoch" ? "selected" : ""}>🔴 Hoch</option>
          </select>
        </label>
        <div class="dialog-actions">
          <button class="btn btn-secondary" id="t-cancel">Abbrechen</button>
          <button class="btn btn-primary" id="t-save">Speichern</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    overlay.querySelector("#t-cancel").onclick = () => overlay.remove();
    overlay.querySelector("#t-save").onclick = async () => {
      const text = overlay.querySelector("#t-text").value.trim();
      const assignedTo = overlay.querySelector("#t-assignee").value || null;
      const date = overlay.querySelector("#t-date").value;
      const priority = overlay.querySelector("#t-priority").value;
      if (!text) {
        await alertDialog("Bitte einen Aufgabentext eintragen.");
        return;
      }
      if (!date) {
        await alertDialog("Bitte einen Tag auswählen.");
        return;
      }
      if (isEdit) {
        store.updateTaskFields(existing.dayId, existing.id, { text, assignedTo, priority });
        if (date !== existing.date) store.moveTaskToDay(existing.dayId, existing.id, date);
      } else {
        const day = store.getOrCreateDayByDate(date);
        store.addAdminTask(day.id, { text, assignedTo, priority });
      }
      overlay.remove();
      rerender();
    };
  }

  rerender();
  return container;
}

export { renderTasksAdmin };
