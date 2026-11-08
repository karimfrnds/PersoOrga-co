// ============================================================================
// chef/schichtzeiten.js – die Schichtzeiten selbst bearbeiten.
//
// Bis hierher standen die Schichten im Code: ändern hieß, mich zu fragen. Jetzt gehören sie den
// Daten und werden hier gepflegt – Service, Küche und Bar, mit Hinzufügen, Ändern und Löschen.
//
// Der wichtigste Gedanke der Seite ist das Datum oben: eine Änderung gilt AB EINEM TAG, nicht
// rückwirkend. Sonst sähe eine längst geplante und abgerechnete Woche plötzlich anders aus, als
// sie war. Voreingestellt ist der nächste Montag – damit eine laufende Woche nicht mitten im
// Betrieb umspringt. Wer "sofort" braucht, stellt das Datum auf heute.
//
// Geändert wird nie direkt: die neue Fassung geht in die Warteschlange des Workers, das iPad
// übernimmt sie beim nächsten Abgleich und schickt den maßgeblichen Stand zurück. Das ist überall
// so und hat einen Grund – nur ein Gerät besitzt die Daten.
// ============================================================================
import { saveSchichtplan } from "./api.js";
import { escapeHtml, dateDe } from "../format.js";
import { BEREICH_LABEL, barEigenAb } from "../schichtplan.js";

const WOCHENTAGE = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];
const BEREICHE_REIHENFOLGE = ["service", "kueche", "bar"];

// Ausserhalb der Ansicht: nach dem Speichern wird die ganze Chef-Ansicht neu aufgebaut. Laege die
// Meldung innen, waere die Bestaetigung im selben Moment wieder weg, in dem sie entsteht.
let letzteMeldung = null;

/** Nächster Montag – Vorgabe für "ab wann". */
function naechsterMontag(heute) {
  const d = new Date(heute + "T12:00:00");
  d.setDate(d.getDate() + ((8 - (d.getDay() || 7)) % 7 || 7));
  return d.toISOString().slice(0, 10);
}
function heuteStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Der Plan, der an einem Tag gilt – dieselbe Regel wie überall sonst. */
function planFuer(plaene, tag) {
  const passend = plaene.filter((p) => String(p.ab || "") <= tag).sort((a, b) => String(a.ab).localeCompare(String(b.ab)));
  return passend[passend.length - 1] || plaene[0] || null;
}

function tageText(slot) {
  if (!slot.allowedWeekdays || slot.allowedWeekdays.length === 0 || slot.allowedWeekdays.length === 7) return "täglich";
  return slot.allowedWeekdays.map((w) => WOCHENTAGE[w]).join(", ");
}

function renderSchichtzeiten(state, { onChanged }) {
  const el = document.createElement("div");

  // Arbeitsstand: wird erst beim Speichern eingereicht. Bis dahin kann man in Ruhe herumprobieren.
  const original = JSON.parse(JSON.stringify(state.schichtPlaene || []));
  let plaene = JSON.parse(JSON.stringify(original));
  let stichtag = naechsterMontag(state.heute || heuteStr());
  let busy = false;

  if (plaene.length === 0) plaene = [{ ab: "2000-01-01", service: [], kueche: [], bar: [] }];

  /** Der Plan, der ab dem Stichtag gilt – und zwar als eigener Eintrag. Gibt es für den Stichtag
   *  noch keinen Plan, wird der aktuell geltende kopiert. So bleibt alles davor unangetastet. */
  function arbeitsPlan() {
    let p = plaene.find((x) => x.ab === stichtag);
    if (!p) {
      const vorlage = planFuer(plaene, stichtag) || { service: [], kueche: [], bar: [] };
      p = JSON.parse(JSON.stringify({ ...vorlage, ab: stichtag }));
      plaene.push(p);
      plaene.sort((a, b) => a.ab.localeCompare(b.ab));
    }
    for (const b of BEREICHE_REIHENFOLGE) if (!Array.isArray(p[b])) p[b] = [];
    return p;
  }

  const geaendert = () => JSON.stringify(aufgeraeumt()) !== JSON.stringify(original);

  /** Pläne ohne den leeren Arbeitsplan: wer nichts ändert, soll auch keinen neuen Plan anlegen. */
  function aufgeraeumt() {
    return plaene.filter((p, i) => {
      if (p.ab === stichtag && !plaene.some((x) => x !== p && x.ab === p.ab)) {
        const vorher = planFuer(original, stichtag);
        if (vorher && JSON.stringify({ ...vorher, ab: null }) === JSON.stringify({ ...p, ab: null })) {
          // Unveränderte Kopie des geltenden Plans – die braucht niemand.
          return original.some((o) => o.ab === p.ab);
        }
      }
      return true;
    });
  }

  function rerender() {
    el.innerHTML = "";
    el.appendChild(build());
  }

  function build() {
    const frag = document.createElement("div");
    frag.innerHTML = `
      <h1>🕗 Schichtzeiten</h1>
      <p class="muted">Welche Schichten es gibt, wann sie anfangen und aufhören, und an welchen Tagen.
      Geändert wird hier – die Änderung geht auf das iPad, auf die Handys des Teams und in den
      Store-Zugang.</p>`;

    if (letzteMeldung) {
      const m = document.createElement("div");
      m.className = letzteMeldung.fehler ? "callout callout-warn" : "callout";
      m.textContent = letzteMeldung.text;
      frag.appendChild(m);
    }

    // --- Stichtag ---
    const kopf = document.createElement("section");
    kopf.className = "card";
    kopf.innerHTML = `<h2>Ab wann gilt die Änderung?</h2>
      <p class="muted small">Alles vor diesem Tag bleibt genau so, wie es war – geplante Wochen und
      Abrechnungen ändern sich nicht rückwirkend. Voreingestellt ist der nächste Montag.</p>`;
    const datumZeile = document.createElement("div");
    datumZeile.className = "employee-actions";
    const datum = document.createElement("input");
    datum.type = "date";
    datum.value = stichtag;
    datum.min = state.heute || heuteStr();
    datum.onchange = () => {
      if (!datum.value) return;
      stichtag = datum.value;
      rerender();
    };
    const sofort = document.createElement("button");
    sofort.className = "btn btn-secondary";
    sofort.textContent = "Ab heute";
    sofort.onclick = () => {
      stichtag = state.heute || heuteStr();
      rerender();
    };
    datumZeile.append(datum, sofort);
    kopf.appendChild(datumZeile);

    if (original.some((p) => p.ab < stichtag)) {
      const hinweis = document.createElement("p");
      hinweis.className = "muted small";
      hinweis.textContent = `Du bearbeitest den Plan ab ${dateDe(stichtag)}. Davor gilt weiterhin der bisherige.`;
      kopf.appendChild(hinweis);
    }
    // Es kann schon ein spaeterer Plan existieren (etwa die Umstellung zum 16.11.). Der wuerde die
    // Aenderung an seinem Stichtag wieder ueberschreiben – das muss dastehen, sonst wundert man sich
    // zwei Wochen spaeter, warum die neue Zeit wieder weg ist.
    const spaeter = original.filter((p) => p.ab > stichtag).map((p) => p.ab).sort()[0];
    if (spaeter) {
      const warn = document.createElement("div");
      warn.className = "callout callout-warn";
      warn.innerHTML = `<b>Achtung:</b> ab ${escapeHtml(dateDe(spaeter))} gilt bereits ein anderer Plan. Was du hier änderst, wirkt nur bis dahin.
        Soll die Änderung dauerhaft gelten, stelle das Datum oben auf ${escapeHtml(dateDe(spaeter))} oder später.`;
      kopf.appendChild(warn);
    }
    frag.appendChild(kopf);

    // --- Bereiche ---
    const plan = arbeitsPlan();
    const barEigen = (arbeitsPlan().bar || []).length > 0;
    for (const bereich of BEREICHE_REIHENFOLGE) {
      frag.appendChild(buildBereich(plan, bereich, barEigen));
    }

    // --- Speichern ---
    const fuss = document.createElement("section");
    fuss.className = "card";
    const anzahl = BEREICHE_REIHENFOLGE.reduce((n, b) => n + plan[b].length, 0);
    const info = document.createElement("p");
    info.className = "muted small";
    info.textContent = geaendert()
      ? `${anzahl} Schichten ab ${dateDe(stichtag)}. Das iPad übernimmt die Änderung beim nächsten Abgleich – das dauert höchstens zwei Minuten.`
      : "Noch nichts geändert.";
    fuss.appendChild(info);

    const aktionen = document.createElement("div");
    aktionen.className = "employee-actions";
    const speichern = document.createElement("button");
    speichern.className = "btn btn-primary";
    speichern.textContent = "Änderungen speichern";
    speichern.disabled = busy || !geaendert();
    speichern.onclick = () => absenden();
    const verwerfen = document.createElement("button");
    verwerfen.className = "btn btn-secondary";
    verwerfen.textContent = "Verwerfen";
    verwerfen.disabled = busy || !geaendert();
    verwerfen.onclick = () => {
      plaene = JSON.parse(JSON.stringify(original));
      letzteMeldung = null;
      rerender();
    };
    aktionen.append(speichern, verwerfen);
    fuss.appendChild(aktionen);
    frag.appendChild(fuss);
    return frag;
  }

  /** Wer hat diese Schicht als feste Schicht? Nur Leute des passenden Bereichs. */
  function festAufSchicht(bereich, slotId) {
    return (state.team || [])
      .filter((p) => p.active !== false)
      .filter((p) => (p.role === "kueche" ? "kueche" : p.role === "bar" ? "bar" : "service") === bereich)
      .filter((p) => (p.festeSchichten || []).some((f) => f.slotId === slotId && !f.bis))
      .map((p) => p.name);
  }

  /** Kleiner Rückfrage-Dialog – für Schritte, die man nicht versehentlich tun soll. */
  function frage(titel, text, weiter) {
    const overlay = document.createElement("div");
    overlay.className = "overlay";
    overlay.innerHTML = `
      <div class="dialog">
        <h2>${escapeHtml(titel)}</h2>
        <div class="callout callout-warn">${escapeHtml(text)}</div>
        <div class="dialog-actions">
          <button class="btn btn-secondary" id="q-no">Abbrechen</button>
          <button class="btn btn-primary" id="q-yes">Trotzdem löschen</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.querySelector("#q-no").onclick = () => overlay.remove();
    overlay.querySelector("#q-yes").onclick = () => {
      overlay.remove();
      weiter();
    };
  }

  function buildBereich(plan, bereich, barEigen) {
    const card = document.createElement("section");
    card.className = "card";
    const titel = document.createElement("h2");
    titel.textContent = BEREICH_LABEL[bereich];
    card.appendChild(titel);

    if (bereich === "bar" && !barEigen) {
      const p = document.createElement("p");
      p.className = "muted small";
      p.textContent =
        "Die Bar läuft im Service mit: Bar-Leute wählen aus den Service-Schichten. Sobald du hier die erste eigene Bar-Schicht anlegst, wird die Bar ein eigener Bereich mit eigenem Plan.";
      card.appendChild(p);
    }

    const liste = plan[bereich];
    if (liste.length === 0) {
      const p = document.createElement("p");
      p.className = "muted small";
      p.textContent = "Keine Schichten.";
      card.appendChild(p);
    } else {
      const scroll = document.createElement("div");
      scroll.style.overflowX = "auto";
      const table = document.createElement("table");
      table.className = "plan-table";
      table.innerHTML = `<thead><tr><th>Schicht</th><th>Von</th><th>Bis</th><th>Tage</th><th></th></tr></thead>`;
      const tbody = document.createElement("tbody");
      for (const slot of liste) {
        const tr = document.createElement("tr");
        tr.innerHTML = `<td><b>${escapeHtml(slot.label)}</b></td>
          <td>${escapeHtml(slot.from)}</td><td>${escapeHtml(slot.to)}</td>
          <td>${escapeHtml(tageText(slot))}</td>`;
        const td = document.createElement("td");
        const aktionen = document.createElement("div");
        aktionen.className = "employee-actions";
        const bearbeiten = document.createElement("button");
        bearbeiten.className = "btn btn-secondary";
        bearbeiten.textContent = "Ändern";
        bearbeiten.onclick = () => openDialog(plan, bereich, slot);
        const loeschen = document.createElement("button");
        loeschen.className = "btn btn-secondary";
        loeschen.textContent = "Löschen";
        loeschen.onclick = () => {
          const weg = () => {
            plan[bereich] = plan[bereich].filter((x) => x !== slot);
            letzteMeldung = null;
            rerender();
          };
          // Wer diese Schicht als feste Schicht hat, stünde danach ohne da – und zwar still, weil
          // eine feste Schicht auf eine Schicht, die es nicht gibt, einfach übergangen wird.
          const betroffen = festAufSchicht(bereich, slot.id);
          if (betroffen.length === 0) return weg();
          frage(
            `„${slot.label}“ löschen?`,
            `${betroffen.join(", ")} ${betroffen.length === 1 ? "hat" : "haben"} diese Schicht fest. Nach dem Löschen ${
              betroffen.length === 1 ? "steht diese Person" : "stehen diese Personen"
            } ab ${dateDe(stichtag)} nicht mehr automatisch im Plan – trage ${
              betroffen.length === 1 ? "ihr" : "ihnen"
            } unter Mitarbeiter eine andere Schicht ein.`,
            weg
          );
        };
        aktionen.append(bearbeiten, loeschen);
        td.appendChild(aktionen);
        tr.appendChild(td);
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
      scroll.appendChild(table);
      card.appendChild(scroll);
    }

    const neu = document.createElement("button");
    neu.className = "btn btn-secondary";
    neu.textContent = `＋ Schicht in ${BEREICH_LABEL[bereich]}`;
    neu.onclick = () => openDialog(plan, bereich, null);
    card.appendChild(neu);
    return card;
  }

  /** Ein Dialog für Anlegen und Ändern – es ist dieselbe Handvoll Felder. */
  function openDialog(plan, bereich, slot) {
    const istNeu = !slot;
    const entwurf = slot
      ? JSON.parse(JSON.stringify(slot))
      : { label: "", from: "09:00", to: "17:00", allowedWeekdays: [] };
    const overlay = document.createElement("div");
    overlay.className = "overlay";
    overlay.innerHTML = `
      <div class="dialog">
        <h2>${istNeu ? "Neue Schicht" : "Schicht ändern"} · ${escapeHtml(BEREICH_LABEL[bereich])}</h2>
        <label class="field"><span>Name</span><input type="text" id="s-label" maxlength="40" placeholder="z.B. Schicht 1"></label>
        <div class="employee-actions">
          <label class="field"><span>Von</span><input type="time" id="s-from"></label>
          <label class="field"><span>Bis</span><input type="time" id="s-to"></label>
        </div>
        <div class="field">
          <span>An welchen Tagen?</span>
          <p class="muted small">Nichts angekreuzt heißt: an jedem Tag.</p>
          <div id="s-tage" class="fest-liste"></div>
        </div>
        <p class="muted small" id="s-status"></p>
        <div class="dialog-actions">
          <button class="btn btn-secondary" id="s-cancel">Abbrechen</button>
          <button class="btn btn-primary" id="s-ok">${istNeu ? "Anlegen" : "Übernehmen"}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.querySelector("#s-label").value = entwurf.label;
    overlay.querySelector("#s-from").value = entwurf.from;
    overlay.querySelector("#s-to").value = entwurf.to;

    const tageBox = overlay.querySelector("#s-tage");
    const gewaehlt = new Set(entwurf.allowedWeekdays || []);
    for (let w = 0; w < 7; w++) {
      const l = document.createElement("label");
      l.className = "fest-zeile";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = gewaehlt.has(w);
      cb.onchange = () => (cb.checked ? gewaehlt.add(w) : gewaehlt.delete(w));
      const s = document.createElement("span");
      s.className = "fest-tag";
      s.textContent = WOCHENTAGE[w];
      l.append(cb, s);
      tageBox.appendChild(l);
    }

    overlay.querySelector("#s-cancel").onclick = () => overlay.remove();
    overlay.querySelector("#s-ok").onclick = () => {
      const status = overlay.querySelector("#s-status");
      const label = overlay.querySelector("#s-label").value.trim();
      const from = overlay.querySelector("#s-from").value;
      const to = overlay.querySelector("#s-to").value;
      if (!label) {
        status.className = "callout callout-warn";
        status.textContent = "Bitte einen Namen eintragen.";
        return;
      }
      if (!from || !to) {
        status.className = "callout callout-warn";
        status.textContent = "Bitte Anfang und Ende eintragen.";
        return;
      }
      if (plan[bereich].some((x) => x !== slot && x.label.toLowerCase() === label.toLowerCase())) {
        status.className = "callout callout-warn";
        status.textContent = "Eine Schicht mit diesem Namen gibt es hier schon.";
        return;
      }
      const tage = [...gewaehlt].sort((a, b) => a - b);
      const neu = {
        ...(slot?.id ? { id: slot.id } : {}),
        ...(slot?.weekdayOverrides ? { weekdayOverrides: slot.weekdayOverrides } : {}),
        ...(slot?.nurFest ? { nurFest: true } : {}),
        label,
        from,
        to,
        ...(tage.length > 0 && tage.length < 7 ? { allowedWeekdays: tage } : {}),
      };
      if (slot) plan[bereich] = plan[bereich].map((x) => (x === slot ? neu : x));
      else plan[bereich] = [...plan[bereich], neu];
      plan[bereich].sort((a, b) => a.from.localeCompare(b.from));
      overlay.remove();
      letzteMeldung = null;
      rerender();
    };
  }

  async function absenden() {
    busy = true;
    letzteMeldung = { text: "Wird gespeichert…" };
    rerender();
    try {
      await saveSchichtplan(aufgeraeumt(), stichtag);
      letzteMeldung = {
        text: `Gespeichert. Ab ${dateDe(stichtag)} gelten die neuen Zeiten – das iPad übernimmt sie beim nächsten Abgleich und gibt sie an die Handys weiter.`,
      };
      busy = false;
      rerender();
      // Danach die ganze Ansicht neu laden. Die Meldung liegt ausserhalb und bleibt dabei stehen.
      await onChanged();
    } catch (e) {
      busy = false;
      letzteMeldung = { fehler: true, text: "⚠ " + e.message };
      rerender();
    }
  }

  rerender();
  return el;
}

export { renderSchichtzeiten };
