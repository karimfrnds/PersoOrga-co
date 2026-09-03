// ============================================================================
// pages/events.js – Admin-Tab „Bingo": Termine festlegen und sehen, wer sich angemeldet hat.
//
// Der Abend hat eine andere Logik als eine Reservierung: es gibt eine feste Zahl Plätze, es wird pro
// Person kassiert, und die Tische verteilt man erst, wenn alle da sind. Deshalb steht hier die
// Personenzahl im Mittelpunkt und nicht der Tisch.
//
// Der Text, den die Gäste auf der Anmeldeseite lesen, wird ebenfalls hier gepflegt – sonst müsste
// jemand in den Code, sobald sich am Ablauf etwas ändert.
// ============================================================================
import { store } from "../store.js";
import { escapeHtml, todayStr, dateDe, euro } from "../format.js";
import { confirmDialog } from "../dialog.js";

function renderEvents() {
  const container = document.createElement("div");
  container.className = "page";

  // Welcher Termin gerade offen ist. null = der nächste.
  let gewaehlt = null;

  function rerender() {
    container.innerHTML = "";
    container.appendChild(build());
  }

  function build() {
    const frag = document.createElement("div");
    frag.innerHTML = `
      <h1>🎱 Bingo-Abend</h1>
      <p class="muted">Termine festlegen und sehen, wer sich über die Website angemeldet hat. Die
      Anmeldeseite zeigt immer nur Termine, die hier angelegt und freigegeben sind.</p>`;

    frag.appendChild(buildTermine());
    const alle = store.getEvents();
    const offen = gewaehlt ? store.getEvent(gewaehlt) : store.getUpcomingEvents()[0] || alle[alle.length - 1] || null;
    if (offen) frag.appendChild(buildAnmeldungen(offen));
    frag.appendChild(buildSeitentext());
    return frag;
  }

  // ---- Termine ----
  function buildTermine() {
    const card = document.createElement("section");
    card.className = "card";
    card.innerHTML = `<h2>Termine</h2>`;

    const alle = store.getEvents();
    const heute = todayStr();
    if (alle.length === 0) {
      card.innerHTML += `<p class="muted small">Noch kein Termin angelegt. Bis dahin sagt die Anmeldeseite
        den Gästen ehrlich, dass gerade nichts ansteht – besser als ein Formular ins Leere.</p>`;
    } else {
      const liste = document.createElement("div");
      liste.className = "task-list";
      for (const e of [...alle].reverse()) {
        const b = store.getEventBelegung(e.id);
        const vorbei = e.date < heute;
        const row = document.createElement("div");
        row.className = "task-row";
        const zustand = vorbei
          ? "vorbei"
          : e.active === false
          ? "🔒 nicht freigegeben"
          : b.voll
          ? "🔴 ausgebucht"
          : `${b.frei} Plätze frei`;
        row.innerHTML = `<div class="task-row-text">
          <span><b>${escapeHtml(dateDe(e.date))}</b> · ab ${escapeHtml(e.time)} Uhr</span>
          <span class="muted small task-row-meta">${b.angemeldet} von ${e.capacity} Plätzen · ${escapeHtml(
            String(e.price)
          )} € p.P. · ${zustand}</span></div>`;

        const akt = document.createElement("div");
        akt.className = "employee-actions";

        const zeigen = document.createElement("button");
        zeigen.className = "btn btn-secondary";
        zeigen.textContent = "Anmeldungen";
        zeigen.onclick = () => {
          gewaehlt = e.id;
          rerender();
        };
        akt.appendChild(zeigen);

        if (!vorbei) {
          const frei = document.createElement("button");
          frei.className = "btn " + (e.active === false ? "btn-primary" : "btn-secondary");
          frei.textContent = e.active === false ? "Freigeben" : "Sperren";
          frei.title =
            e.active === false
              ? "Erst danach können sich Gäste online anmelden"
              : "Der Termin bleibt bestehen, ist online aber nicht mehr buchbar";
          frei.onclick = () => {
            store.updateEvent(e.id, { active: e.active === false });
            rerender();
          };
          akt.appendChild(frei);
        }

        const bearbeiten = document.createElement("button");
        bearbeiten.className = "btn btn-link";
        bearbeiten.textContent = "Ändern";
        bearbeiten.onclick = () => {
          bearbeite(e, card);
        };
        akt.appendChild(bearbeiten);

        const weg = document.createElement("button");
        weg.className = "btn btn-link";
        weg.textContent = "✕";
        weg.title = "Termin löschen";
        weg.onclick = async () => {
          const anz = store.getEventSignups(e.id).length;
          const frage =
            `Termin am ${dateDe(e.date)} löschen?` +
            (anz > 0 ? `\n\nDie ${anz} Anmeldungen dazu verschwinden mit – sie ergeben ohne den Abend keinen Sinn.` : "");
          if (!(await confirmDialog(frage, { title: "Termin löschen?", okLabel: "Löschen", danger: true }))) return;
          store.removeEvent(e.id);
          if (gewaehlt === e.id) gewaehlt = null;
          rerender();
        };
        akt.appendChild(weg);

        row.appendChild(akt);
        liste.appendChild(row);
      }
      card.appendChild(liste);
    }

    card.appendChild(buildNeuerTermin());
    return card;
  }

  function buildNeuerTermin() {
    const box = document.createElement("div");
    box.className = "res-form";
    const titel = document.createElement("p");
    titel.className = "muted small";
    titel.innerHTML = "<b>Neuer Termin</b>";
    box.appendChild(titel);

    const feld = (label, el) => {
      const l = document.createElement("label");
      l.className = "field";
      l.innerHTML = `<span>${label}</span>`;
      l.appendChild(el);
      return l;
    };
    const datum = document.createElement("input");
    datum.type = "date";
    datum.min = todayStr();
    const zeit = document.createElement("input");
    zeit.type = "time";
    zeit.step = 900;
    zeit.value = "18:00";
    const preis = document.createElement("input");
    preis.type = "number";
    preis.inputMode = "decimal";
    preis.min = "0";
    preis.value = "15";
    const plaetze = document.createElement("input");
    plaetze.type = "number";
    plaetze.inputMode = "numeric";
    plaetze.min = "1";
    // Vorschlag aus dem Tischplan: so viele Leute passen überhaupt rein. Ändern kann man es trotzdem.
    const sitze = store.getTables().reduce((s, t) => s + (t.active !== false ? Number(t.seats) || 0 : 0), 0);
    plaetze.value = String(sitze > 0 ? sitze : 40);

    const reihe = document.createElement("div");
    reihe.className = "res-form-row";
    reihe.append(feld("Datum", datum), feld("Beginn", zeit), feld("Preis pro Person (€)", preis), feld("Plätze", plaetze));
    box.appendChild(reihe);

    const hinweis = document.createElement("p");
    hinweis.className = "muted small";
    hinweis.textContent =
      sitze > 0
        ? `Vorgeschlagen sind ${sitze} Plätze – so viele Sitze hat der Tischplan insgesamt.`
        : "Sobald Tische angelegt sind, wird die Platzzahl daraus vorgeschlagen.";
    box.appendChild(hinweis);

    const knopf = document.createElement("button");
    knopf.className = "btn btn-primary btn-huge";
    knopf.textContent = "Termin anlegen";
    knopf.onclick = () => {
      if (!datum.value) {
        hinweis.className = "res-warn small";
        hinweis.textContent = "Bitte ein Datum wählen.";
        return;
      }
      const neu = store.addEvent({
        date: datum.value,
        time: zeit.value || "18:00",
        price: preis.value,
        capacity: plaetze.value,
      });
      if (neu) gewaehlt = neu.id;
      rerender();
    };
    box.appendChild(knopf);
    return box;
  }

  /** Termin ändern – als Formular direkt in der Karte, damit man Datum und Platzzahl nebeneinander sieht. */
  function bearbeite(e, card) {
    const alt = card.querySelector(".event-edit");
    if (alt) alt.remove();
    const box = document.createElement("div");
    box.className = "res-form event-edit";
    const feld = (label, el) => {
      const l = document.createElement("label");
      l.className = "field";
      l.innerHTML = `<span>${label}</span>`;
      l.appendChild(el);
      return l;
    };
    const datum = document.createElement("input");
    datum.type = "date";
    datum.value = e.date;
    const zeit = document.createElement("input");
    zeit.type = "time";
    zeit.step = 900;
    zeit.value = e.time;
    const preis = document.createElement("input");
    preis.type = "number";
    preis.value = String(e.price);
    const plaetze = document.createElement("input");
    plaetze.type = "number";
    plaetze.value = String(e.capacity);
    const notiz = document.createElement("input");
    notiz.type = "text";
    notiz.value = e.note || "";
    notiz.placeholder = "z.B. Motto oder ein Hinweis für die Gäste";

    const reihe = document.createElement("div");
    reihe.className = "res-form-row";
    reihe.append(feld("Datum", datum), feld("Beginn", zeit), feld("Preis (€)", preis), feld("Plätze", plaetze));
    box.append(reihe, feld("Zusatz auf der Anmeldeseite", notiz));

    const belegt = store.getEventBelegung(e.id).angemeldet;
    const warnung = document.createElement("p");
    warnung.className = "muted small";
    box.appendChild(warnung);

    const speichern = document.createElement("button");
    speichern.className = "btn btn-primary";
    speichern.textContent = "Speichern";
    speichern.onclick = () => {
      if (Number(plaetze.value) < belegt) {
        warnung.className = "res-warn small";
        warnung.textContent = `Es sind schon ${belegt} Personen angemeldet – weniger Plätze als das geht nicht.`;
        return;
      }
      store.updateEvent(e.id, {
        date: datum.value,
        time: zeit.value,
        price: preis.value,
        capacity: plaetze.value,
        note: notiz.value,
      });
      rerender();
    };
    const abbrechen = document.createElement("button");
    abbrechen.className = "btn btn-link";
    abbrechen.textContent = "Abbrechen";
    abbrechen.onclick = () => box.remove();
    const akt = document.createElement("div");
    akt.className = "employee-actions";
    akt.append(speichern, abbrechen);
    box.appendChild(akt);
    card.appendChild(box);
    box.scrollIntoView({ block: "nearest" });
  }

  // ---- Anmeldungen eines Termins ----
  function buildAnmeldungen(e) {
    const card = document.createElement("section");
    card.className = "card";
    const b = store.getEventBelegung(e.id);
    card.innerHTML = `<h2>Anmeldungen · ${escapeHtml(dateDe(e.date))}</h2>
      <p class="muted small">${b.angemeldet} von ${e.capacity} Plätzen vergeben${
        b.voll ? " – ausgebucht" : ` · ${b.frei} frei`
      } · voraussichtlich ${escapeHtml(euro(b.angemeldet * e.price))} Eintritt.</p>`;

    const signups = store.getEventSignups(e.id);
    if (signups.length === 0) {
      card.innerHTML += `<p class="muted small">Noch niemand angemeldet.</p>`;
    } else {
      const liste = document.createElement("div");
      liste.className = "task-list";
      for (const s of signups) {
        const row = document.createElement("div");
        row.className = "task-row" + (s.status === "abgesagt" ? " task-row-done" : "");
        const meta = [
          `${s.guests} ${s.guests === 1 ? "Person" : "Personen"}`,
          s.contact,
          s.source === "web" ? "über die Website" : "von Hand",
          `Nr. ${s.code}`,
        ]
          .filter(Boolean)
          .join(" · ");
        row.innerHTML = `<div class="task-row-text">
          <span><b>${escapeHtml(s.name)}</b>${s.status === "da" ? " ✅" : ""}${
            s.status === "abgesagt" ? " (abgesagt)" : ""
          }${s.paid ? " · bezahlt" : ""}</span>
          <span class="muted small task-row-meta">${escapeHtml(meta)}</span>
          ${s.note ? `<span class="muted small task-row-meta">📝 ${escapeHtml(s.note)}</span>` : ""}</div>`;

        const akt = document.createElement("div");
        akt.className = "employee-actions";
        if (s.status !== "abgesagt") {
          const da = document.createElement("button");
          da.className = "btn " + (s.status === "da" ? "btn-secondary" : "btn-primary");
          da.textContent = s.status === "da" ? "Doch nicht da" : "Ist da";
          da.onclick = () => {
            store.updateEventSignup(s.id, { status: s.status === "da" ? "offen" : "da" });
            rerender();
          };
          const bezahlt = document.createElement("button");
          bezahlt.className = "btn btn-secondary";
          bezahlt.textContent = s.paid ? "Zahlung zurücknehmen" : "Bezahlt";
          bezahlt.onclick = () => {
            store.updateEventSignup(s.id, { paid: !s.paid });
            rerender();
          };
          akt.append(da, bezahlt);
        }
        const absage = document.createElement("button");
        absage.className = "btn btn-link";
        absage.textContent = s.status === "abgesagt" ? "Doch dabei" : "Abgesagt";
        absage.title = "Abgesagte Plätze werden sofort wieder frei";
        absage.onclick = () => {
          store.updateEventSignup(s.id, { status: s.status === "abgesagt" ? "offen" : "abgesagt" });
          rerender();
        };
        akt.appendChild(absage);
        row.appendChild(akt);
        liste.appendChild(row);
      }
      card.appendChild(liste);
    }

    card.appendChild(buildAnmeldungVonHand(e));
    return card;
  }

  /** Anmeldung von Hand – für alle, die anrufen oder im Laden fragen. Ohne das wäre die Liste nur die
   * halbe Wahrheit, und die Platzzahl stimmte nie. */
  function buildAnmeldungVonHand(e) {
    const box = document.createElement("div");
    box.className = "res-form";
    const titel = document.createElement("p");
    titel.className = "muted small";
    titel.innerHTML = "<b>Von Hand eintragen</b> – für Anrufe und Gäste im Laden";
    box.appendChild(titel);

    const feld = (label, el) => {
      const l = document.createElement("label");
      l.className = "field";
      l.innerHTML = `<span>${label}</span>`;
      l.appendChild(el);
      return l;
    };
    const name = document.createElement("input");
    name.type = "text";
    name.placeholder = "Name";
    const kontakt = document.createElement("input");
    kontakt.type = "text";
    kontakt.placeholder = "Handy oder E-Mail";
    const anzahl = document.createElement("input");
    anzahl.type = "number";
    anzahl.min = "1";
    anzahl.value = "2";
    const notiz = document.createElement("input");
    notiz.type = "text";
    notiz.placeholder = "Allergien, Wünsche…";

    const reihe = document.createElement("div");
    reihe.className = "res-form-row";
    reihe.append(feld("Name", name), feld("Kontakt", kontakt), feld("Personen", anzahl));
    box.append(reihe, feld("Notiz", notiz));

    const hinweis = document.createElement("p");
    hinweis.className = "muted small";
    box.appendChild(hinweis);

    const knopf = document.createElement("button");
    knopf.className = "btn btn-primary";
    knopf.textContent = "Eintragen";
    knopf.onclick = () => {
      if (!name.value.trim()) {
        hinweis.className = "res-warn small";
        hinweis.textContent = "Bitte einen Namen eintragen.";
        return;
      }
      const b = store.getEventBelegung(e.id);
      const wunsch = Math.max(1, Number(anzahl.value) || 1);
      if (e.capacity > 0 && wunsch > b.frei) {
        hinweis.className = "res-warn small";
        hinweis.textContent = `Es sind nur noch ${b.frei} Plätze frei. Wenn es trotzdem passen soll, erhöh oben die Platzzahl.`;
        return;
      }
      store.addEventSignup({
        eventId: e.id,
        name: name.value,
        contact: kontakt.value,
        guests: wunsch,
        note: notiz.value,
        source: "manuell",
      });
      rerender();
    };
    box.appendChild(knopf);
    return box;
  }

  // ---- Was auf der Anmeldeseite steht ----
  function buildSeitentext() {
    const card = document.createElement("section");
    card.className = "card";
    const s = store.getEventSettings();
    card.innerHTML = `<h2>Anmeldeseite</h2>
      <p class="muted small">Was die Gäste zu lesen bekommen. Gilt für alle Termine – hier steht, worum es
      geht, nicht wann.</p>`;

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
    const titel = document.createElement("input");
    titel.type = "text";
    titel.value = s.title || "";
    const intro = document.createElement("textarea");
    intro.rows = 7;
    intro.value = s.intro || "";
    const drin = document.createElement("textarea");
    drin.rows = 3;
    drin.value = (s.included || []).join("\n");
    const hinweisText = document.createElement("input");
    hinweisText.type = "text";
    hinweisText.value = s.hinweis || "";

    card.append(
      feld("Überschrift", titel),
      feld("Text über den Abend", intro, "Eine Leerzeile macht einen neuen Absatz."),
      feld("Im Preis enthalten", drin, "Eine Zeile pro Punkt."),
      feld("Hinweis darunter", hinweisText)
    );

    const anKnopf = document.createElement("button");
    anKnopf.className = "btn " + (s.onlineEnabled === false ? "btn-primary" : "btn-secondary");
    anKnopf.textContent = s.onlineEnabled === false ? "Anmeldung öffnen" : "Anmeldung schließen";
    anKnopf.title = "Schließt die Seite für alle Termine auf einmal";
    anKnopf.onclick = () => {
      store.updateEventSettings({ onlineEnabled: s.onlineEnabled === false });
      rerender();
    };

    const status = document.createElement("p");
    status.className = "muted small";
    status.textContent =
      s.onlineEnabled === false
        ? "Die Anmeldung ist geschlossen – Gäste sehen einen Hinweis statt des Formulars."
        : "Die Anmeldung ist offen.";

    const speichern = document.createElement("button");
    speichern.className = "btn btn-primary";
    speichern.textContent = "Text speichern";
    speichern.onclick = () => {
      store.updateEventSettings({
        title: titel.value.trim() || "Bingo Drink Night",
        intro: intro.value,
        included: drin.value
          .split("\n")
          .map((z) => z.trim())
          .filter(Boolean),
        hinweis: hinweisText.value.trim(),
      });
      status.className = "callout";
      status.textContent = "Gespeichert. Auf der Website steht es nach dem nächsten Abgleich (spätestens 90 Sekunden).";
    };

    const akt = document.createElement("div");
    akt.className = "employee-actions";
    akt.append(speichern, anKnopf);
    card.append(akt, status);
    return card;
  }

  rerender();
  return container;
}

export { renderEvents };
