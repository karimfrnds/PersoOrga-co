// ============================================================================
// pages/tablesAdmin.js – Admin-Tab „Tische": die Tische des Cafés anlegen und
// pflegen, plus die Verweildauer für Reservierungen.
//
// Die Verweildauer steht hier und nicht bei den Reservierungen, weil sie eine
// Grundeinstellung des Hauses ist: sie entscheidet, ob 18:00 und 19:00 am selben
// Tisch als Konflikt gelten. Ohne diese Annahme kann das System Doppelbelegungen
// gar nicht erkennen.
// ============================================================================
import { store } from "../store.js";
import { escapeHtml } from "../format.js";
import { confirmDialog } from "../dialog.js";
import { buildTischplan } from "./tableplan.js";
import { todayStr } from "../format.js";

const WOCHENTAGE = ["Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag", "Sonntag"];

function renderTablesAdmin() {
  const container = document.createElement("div");
  container.className = "page";

  function rerender() {
    container.innerHTML = "";
    container.appendChild(build());
  }

  function build() {
    const frag = document.createElement("div");
    frag.innerHTML = `
      <h1>🪑 Tische</h1>
      <p class="muted">Grundlage für die Reservierungen: welche Tische es gibt, wie viele Plätze sie haben und
      ob sie drinnen oder draußen stehen. Unter <b>Steht neben</b> legst du fest, welche Tische
      zusammengeschoben werden können – daraus schlägt das System bei größeren Gruppen passende
      Kombinationen vor.</p>`;
    frag.appendChild(buildNeu());
    frag.appendChild(buildAnordnen());
    frag.appendChild(buildListe());
    frag.appendChild(buildEinstellungen());
    frag.appendChild(buildOeffnungszeiten());
    frag.appendChild(buildOnline());
    return frag;
  }

  function buildNeu() {
    const card = document.createElement("section");
    card.className = "card";
    card.innerHTML = `<h2>Neuer Tisch</h2>`;

    const reihe = document.createElement("div");
    reihe.className = "res-form-row";

    const feld = (label, el) => {
      const l = document.createElement("label");
      l.className = "field";
      l.innerHTML = `<span>${label}</span>`;
      l.appendChild(el);
      return l;
    };
    const name = document.createElement("input");
    name.type = "text";
    name.placeholder = "z.B. Tisch 1 oder T1";
    const plaetze = document.createElement("input");
    plaetze.type = "number";
    plaetze.min = "1";
    plaetze.value = "4";
    const bereich = document.createElement("select");
    bereich.innerHTML = `<option value="innen">Drinnen</option><option value="draussen">Draußen</option>`;
    reihe.append(feld("Name", name), feld("Plätze", plaetze), feld("Bereich", bereich));
    card.appendChild(reihe);

    const status = document.createElement("p");
    status.className = "muted small";

    const btn = document.createElement("button");
    btn.className = "btn btn-primary";
    btn.textContent = "＋ Hinzufügen";
    const anlegen = () => {
      if (!name.value.trim()) {
        status.className = "callout callout-warn";
        status.textContent = "Bitte einen Namen eintragen.";
        return;
      }
      store.addTable({ name: name.value, seats: plaetze.value, area: bereich.value });
      name.value = "";
      rerender();
      // Nach dem Anlegen gleich weiter tippen können – man legt selten nur einen Tisch an.
      container.querySelector("input[type=text]")?.focus();
    };
    btn.onclick = anlegen;
    name.addEventListener("keydown", (e) => {
      if (e.key === "Enter") anlegen();
    });

    card.append(btn, status);

    // Startsammlung: 12 Tische von Hand einzeln anzulegen ist mühsam.
    if (store.getTables(true).length === 0) {
      const schnell = document.createElement("div");
      schnell.className = "callout";
      schnell.innerHTML = `<b>Schnellstart:</b> Soll ich eine Grundausstattung anlegen? Namen und Plätze
        lassen sich danach einzeln anpassen.`;
      const btn8 = document.createElement("button");
      btn8.className = "btn btn-secondary";
      btn8.textContent = "10 drinnen + 6 draußen anlegen";
      btn8.onclick = () => {
        for (let i = 1; i <= 10; i++) store.addTable({ name: `Tisch ${i}`, seats: 4, area: "innen" });
        for (let i = 1; i <= 6; i++) store.addTable({ name: `T${i}`, seats: 4, area: "draussen" });
        rerender();
      };
      schnell.appendChild(btn8);
      card.appendChild(schnell);
    }
    return card;
  }

  /** Den Plan einrichten: Tische an die Stelle ziehen, an der sie im Raum wirklich stehen.
   * Bewusst hier im Admin und nicht auf der Reservierungs-Seite – im Betrieb soll niemand aus Versehen
   * den halben Plan verschieben. */
  function buildAnordnen() {
    const card = document.createElement("section");
    card.className = "card";
    card.innerHTML = `<h2>Plan anordnen</h2>
      <p class="muted small">Zieh die Tische dorthin, wo sie im Raum stehen. Diese Anordnung sehen alle
      später unter Reservierungen → Tischplan. Die Farben zeigen dort die Belegung – hier geht es nur ums
      Anordnen.</p>`;
    if (store.getTables().length === 0) {
      card.innerHTML += `<p class="muted small">Erst Tische anlegen.</p>`;
      return card;
    }
    // Neu aufbauen nach dem Ziehen wäre störend (der Finger ist noch unten) – die Position wird beim
    // Loslassen gespeichert, die Ansicht bleibt wie sie ist.
    card.appendChild(buildTischplan({ datum: todayStr(), zeit: "03:00", verschiebbar: true }));
    return card;
  }

  function buildListe() {
    const card = document.createElement("section");
    card.className = "card";
    const tische = store.getTables(true);
    card.innerHTML = `<h2>Alle Tische</h2>`;
    if (tische.length === 0) {
      card.innerHTML += `<p class="muted small">Noch keine Tische angelegt.</p>`;
      return card;
    }

    const innen = tische.filter((t) => t.area === "innen");
    const draussen = tische.filter((t) => t.area === "draussen");
    const summe = (list) => list.filter((t) => t.active !== false).reduce((s, t) => s + t.seats, 0);

    const zusammen = document.createElement("p");
    zusammen.className = "muted small";
    zusammen.textContent = `Drinnen: ${innen.length} Tische, ${summe(innen)} Plätze · Draußen: ${draussen.length} Tische, ${summe(
      draussen
    )} Plätze`;
    card.appendChild(zusammen);

    for (const [titel, liste] of [
      ["Drinnen", innen],
      ["Draußen", draussen],
    ]) {
      if (liste.length === 0) continue;
      const h = document.createElement("p");
      h.className = "muted small res-bereich";
      h.innerHTML = `<b>${titel}</b>`;
      card.appendChild(h);

      const scroll = document.createElement("div");
      scroll.style.overflowX = "auto";
      const table = document.createElement("table");
      table.className = "calc-table";
      table.innerHTML = `<thead><tr><th>Name</th><th>Plätze</th><th>Bereich</th><th>Steht neben</th><th></th></tr></thead>`;
      const tbody = document.createElement("tbody");
      for (const t of liste) {
        const tr = document.createElement("tr");
        if (t.active === false) tr.style.opacity = "0.5";

        const nameTd = document.createElement("td");
        const nameInp = document.createElement("input");
        nameInp.type = "text";
        nameInp.value = t.name;
        nameInp.style.width = "140px";
        nameInp.onchange = () => {
          store.updateTable(t.id, { name: nameInp.value });
          rerender();
        };
        nameTd.appendChild(nameInp);

        const plTd = document.createElement("td");
        const plInp = document.createElement("input");
        plInp.type = "number";
        plInp.min = "1";
        plInp.value = t.seats;
        plInp.style.width = "70px";
        plInp.onchange = () => {
          store.updateTable(t.id, { seats: plInp.value });
          rerender();
        };
        plTd.appendChild(plInp);

        const brTd = document.createElement("td");
        const brSel = document.createElement("select");
        brSel.innerHTML = `<option value="innen" ${t.area === "innen" ? "selected" : ""}>Drinnen</option><option value="draussen" ${
          t.area === "draussen" ? "selected" : ""
        }>Draußen</option>`;
        brSel.onchange = () => {
          store.updateTable(t.id, { area: brSel.value });
          rerender();
        };
        brTd.appendChild(brSel);

        const nachbarnTd = document.createElement("td");
        const nachbarn = (t.combinesWith || []).map((id) => store.getTable(id)?.name).filter(Boolean);
        const nbBtn = document.createElement("button");
        nbBtn.className = "btn btn-secondary";
        nbBtn.textContent = nachbarn.length ? `↔ ${nachbarn.join(", ")}` : "↔ festlegen";
        nbBtn.title = "Welche Tische stehen daneben und lassen sich zusammenschieben?";
        nbBtn.onclick = () => openNachbarn(t);
        nachbarnTd.appendChild(nbBtn);

        const aktTd = document.createElement("td");
        aktTd.className = "employee-actions";
        const um = document.createElement("button");
        um.className = "btn btn-secondary";
        um.textContent = t.active === false ? "Aktivieren" : "Deaktivieren";
        um.title = "Vorübergehend nicht nutzbar (z.B. defekt), ohne bestehende Reservierungen zu verlieren";
        um.onclick = () => {
          store.updateTable(t.id, { active: t.active === false });
          rerender();
        };
        const del = document.createElement("button");
        del.className = "btn btn-link";
        del.textContent = "✕";
        del.title = "Tisch löschen";
        del.onclick = async () => {
          if (await confirmDialog(`Tisch „${t.name}" löschen? Bestehende Zuweisungen auf diesen Tisch werden aufgehoben.`)) {
            store.removeTable(t.id);
            rerender();
          }
        };
        aktTd.append(um, del);

        tr.append(nameTd, plTd, brTd, nachbarnTd, aktTd);
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
      scroll.appendChild(table);
      card.appendChild(scroll);
    }
    return card;
  }

  /** Nachbarn eines Tisches auswählen. Nur Tische aus demselben Bereich – drinnen und draußen lassen
   * sich nicht zusammenschieben, und die Auswahl bliebe sonst unnötig lang. */
  function openNachbarn(t) {
    const andere = store.getTables(true).filter((x) => x.id !== t.id && x.area === t.area);
    const aktuell = new Set(t.combinesWith || []);

    const overlay = document.createElement("div");
    overlay.className = "overlay";
    overlay.innerHTML = `
      <div class="dialog">
        <h2>${escapeHtml(t.name)} steht neben…</h2>
        <p class="muted small">Welche Tische stehen direkt daneben und lassen sich zusammenschieben?
        Nur diese werden später als Kombination vorgeschlagen.</p>
      </div>`;
    const box = overlay.querySelector(".dialog");

    if (andere.length === 0) {
      const p = document.createElement("p");
      p.className = "muted small";
      p.textContent = "Es gibt keine weiteren Tische in diesem Bereich.";
      box.appendChild(p);
    } else {
      const liste = document.createElement("div");
      liste.className = "res-tische";
      for (const x of andere) {
        const btn = document.createElement("button");
        btn.className = "res-tisch-btn" + (aktuell.has(x.id) ? " gewaehlt" : "");
        btn.innerHTML = `<span class="res-tisch-name">${escapeHtml(x.name)}</span><span class="muted small">${x.seats} Pl.</span>`;
        btn.onclick = () => {
          if (aktuell.has(x.id)) aktuell.delete(x.id);
          else aktuell.add(x.id);
          btn.classList.toggle("gewaehlt", aktuell.has(x.id));
        };
        liste.appendChild(btn);
      }
      box.appendChild(liste);
    }

    const aktionen = document.createElement("div");
    aktionen.className = "dialog-actions";
    const abbrechen = document.createElement("button");
    abbrechen.className = "btn btn-secondary";
    abbrechen.textContent = "Abbrechen";
    abbrechen.onclick = () => overlay.remove();
    const speichern = document.createElement("button");
    speichern.className = "btn btn-primary";
    speichern.textContent = "Speichern";
    speichern.onclick = () => {
      store.setTableNeighbours(t.id, [...aktuell]);
      overlay.remove();
      rerender();
    };
    aktionen.append(abbrechen, speichern);
    box.appendChild(aktionen);
    document.body.appendChild(overlay);
  }

  function buildEinstellungen() {
    const card = document.createElement("section");
    card.className = "card";
    card.innerHTML = `<h2>Verweildauer</h2>`;

    const erklaerung = document.createElement("p");
    erklaerung.className = "muted small";
    erklaerung.textContent =
      "Wie lange ein Tisch pro Reservierung als belegt gilt. Daran erkennt das System, ob zwei Reservierungen am selben Tisch kollidieren – bei 2 Stunden ist ein Tisch um 18:00 und 19:00 doppelt belegt, um 18:00 und 20:00 nicht.";
    card.appendChild(erklaerung);

    const aktuell = Number(store.getSettings().reservation?.durationMinutes) || 120;
    const reihe = document.createElement("div");
    reihe.className = "handoff-days";
    for (const min of [60, 90, 120, 150, 180]) {
      const b = document.createElement("button");
      b.className = "btn " + (aktuell === min ? "btn-primary" : "btn-secondary");
      const std = Math.floor(min / 60);
      const rest = min % 60;
      b.textContent = std === 0 ? `${rest} Min` : `${std} Std${rest ? ` ${rest} Min` : ""}`;
      b.onclick = () => {
        store.updateSettings({ reservation: { ...store.getSettings().reservation, durationMinutes: min } });
        rerender();
      };
      reihe.appendChild(b);
    }
    card.appendChild(reihe);

    const gesperrt = store.getSettings().reservation?.terraceClosedDates || [];
    if (gesperrt.length > 0) {
      const p = document.createElement("p");
      p.className = "muted small";
      p.textContent = `Terrasse gesperrt an: ${gesperrt.slice(-10).join(", ")} (umschalten auf der Reservierungs-Seite).`;
      card.appendChild(p);
    }
    return card;
  }

  /** Öffnungszeiten – Grundlage für die Online-Buchung. Ohne sie könnte ein Gast für 3 Uhr nachts oder
   * für einen Ruhetag reservieren. Gelten NUR für die Buchung; die Schichtzeiten der Mitarbeiter sind
   * davon unberührt. */
  function buildOeffnungszeiten() {
    const card = document.createElement("section");
    card.className = "card";
    card.innerHTML = `<h2>Öffnungszeiten</h2>
      <p class="muted small">Innerhalb dieser Zeiten können Gäste online reservieren. An einem Ruhetag geht
      gar nichts. Die Schichtzeiten der Mitarbeiter ändern sich dadurch nicht.</p>`;

    const zeiten = store.getSettings().reservation?.openingHours || [];
    const speichern = (index, patch) => {
      const neu = zeiten.map((z, i) => (i === index ? { ...z, ...patch } : z));
      store.updateSettings({ reservation: { ...store.getSettings().reservation, openingHours: neu } });
      rerender();
    };

    for (let i = 0; i < 7; i++) {
      const z = zeiten[i] || { closed: false, from: "09:00", to: "22:00" };
      const zeile = document.createElement("div");
      zeile.className = "oeffnung-zeile";

      const tag = document.createElement("span");
      tag.className = "oeffnung-tag";
      tag.textContent = WOCHENTAGE[i];

      const zu = document.createElement("button");
      zu.className = "btn " + (z.closed ? "btn-primary" : "btn-secondary");
      zu.textContent = z.closed ? "Ruhetag" : "Geöffnet";
      zu.onclick = () => speichern(i, { closed: !z.closed });

      zeile.append(tag, zu);

      if (!z.closed) {
        const von = document.createElement("input");
        von.type = "time";
        von.step = "900";
        von.value = z.from;
        von.onchange = () => speichern(i, { from: von.value });
        const bis = document.createElement("input");
        bis.type = "time";
        bis.step = "900";
        bis.value = z.to;
        bis.onchange = () => speichern(i, { to: bis.value });
        const strich = document.createElement("span");
        strich.textContent = "–";
        zeile.append(von, strich, bis);

        if (z.to <= z.from) {
          const warn = document.createElement("span");
          warn.className = "res-warn";
          warn.textContent = "Ende liegt vor dem Anfang";
          zeile.appendChild(warn);
        }
      }
      card.appendChild(zeile);
    }
    return card;
  }

  /** Regeln für die Online-Buchung auf der Website. */
  function buildOnline() {
    const card = document.createElement("section");
    card.className = "card";
    card.innerHTML = `<h2>Online-Reservierung</h2>`;
    const r = store.getSettings().reservation || {};
    const setzen = (patch) => {
      store.updateSettings({ reservation: { ...store.getSettings().reservation, ...patch } });
      rerender();
    };

    const an = document.createElement("button");
    an.className = "btn " + (r.onlineEnabled === false ? "btn-secondary" : "btn-primary");
    an.textContent = r.onlineEnabled === false ? "❌ Online-Buchung ist aus" : "✅ Online-Buchung ist an";
    an.title = "Schaltet das Formular auf der Website ab, ohne es entfernen zu müssen";
    an.onclick = () => setzen({ onlineEnabled: r.onlineEnabled === false });
    card.appendChild(an);

    const reihe = document.createElement("div");
    reihe.className = "res-form-row";
    const feld = (label, hinweis, el) => {
      const l = document.createElement("label");
      l.className = "field";
      l.innerHTML = `<span>${label}</span>`;
      l.appendChild(el);
      const h = document.createElement("span");
      h.className = "muted small";
      h.textContent = hinweis;
      l.appendChild(h);
      return l;
    };
    const zahl = (wert, min, max, onChange) => {
      const i = document.createElement("input");
      i.type = "number";
      i.min = String(min);
      i.max = String(max);
      i.value = String(wert);
      i.onchange = () => onChange(Math.min(max, Math.max(min, Number(i.value) || min)));
      return i;
    };

    reihe.append(
      feld("Größte Gruppe online", "Größere Gruppen sollen anrufen", zahl(r.maxGuestsOnline ?? 8, 1, 50, (v) => setzen({ maxGuestsOnline: v }))),
      feld("Vorlauf in Minuten", "So kurzfristig geht es noch", zahl(r.minLeadMinutes ?? 60, 0, 1440, (v) => setzen({ minLeadMinutes: v }))),
      feld("Wie viele Tage im Voraus", "Weiter in die Zukunft geht nicht", zahl(r.maxDaysAhead ?? 60, 1, 365, (v) => setzen({ maxDaysAhead: v })))
    );
    card.appendChild(reihe);

    const hinweis = document.createElement("p");
    hinweis.className = "muted small";
    hinweis.textContent =
      `Gast-Buchungen kommen ohne Tisch herein und stehen unter Reservierungen als „ohne Tisch" – den Tisch vergibst du wie gewohnt selbst.`;
    card.appendChild(hinweis);
    return card;
  }

  rerender();
  return container;
}

export { renderTablesAdmin };
