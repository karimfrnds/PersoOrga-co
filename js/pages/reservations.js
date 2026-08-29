// ============================================================================
// pages/reservations.js – Reservierungen am iPad: Tagesliste, Tisch zuweisen,
// Ankunft abhaken.
//
// Diese Seite wird IM BETRIEB benutzt, mit vollen Händen und wenig Zeit. Deshalb:
// keine Dialoge für die häufigen Handgriffe (Tisch zuweisen, "ist da"), grosse
// Flächen, und der wichtigste Zustand ist an der Farbe erkennbar, ohne zu lesen.
//
// Ziel des Ganzen: die handgeschriebenen Tischschilder ersetzen. Die Zuweisung
// passiert vorher in Ruhe, im Service reicht ein Blick auf die Liste.
// ============================================================================
import { store } from "../store.js";
import { escapeHtml, todayStr, dateDe } from "../format.js";
import { confirmDialog } from "../dialog.js";
import { buildTischplan } from "./tableplan.js";

function addDaysISO(dateStr, n) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}
const AREA_LABEL = { innen: "🏠 Drinnen", draussen: "☀️ Draußen", egal: "egal" };

// Uhrzeiten im Viertelstunden-Takt. Am Telefon ist "halb acht" die Regel, minutengenaue Reservierungen
// gibt es praktisch nie – eine Liste ist damit schneller ausgewählt als ein Uhrzeit-Rad.
const ZEIT_VON = 8;
const ZEIT_BIS = 23;
function viertelstunden() {
  const liste = [];
  for (let h = ZEIT_VON; h <= ZEIT_BIS; h++) {
    for (const m of [0, 15, 30, 45]) liste.push(`${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`);
  }
  return liste;
}

/** Auswahlfeld für die Uhrzeit. Ein Wert außerhalb des Rasters (z.B. aus einer alten Reservierung oder
 * vom Web-Formular) wird zusätzlich aufgenommen, statt beim Öffnen still auf etwas anderes zu springen. */
function zeitAuswahl(wert) {
  const sel = document.createElement("select");
  const zeiten = viertelstunden();
  if (wert && !zeiten.includes(wert)) zeiten.push(wert);
  zeiten.sort();
  for (const z of zeiten) {
    const o = document.createElement("option");
    o.value = z;
    o.textContent = z + " Uhr";
    if (z === wert) o.selected = true;
    sel.appendChild(o);
  }
  return sel;
}

/** Personenzahl mit − und + daneben. Die meisten Reservierungen weichen nur um ein bis zwei Personen
 * vom Vorschlag ab; Tippen auf einer Zahlentastatur ist dafür der umständlichere Weg. */
function personenFeld(wert) {
  const box = document.createElement("div");
  box.className = "zaehler";
  const minus = document.createElement("button");
  minus.type = "button";
  minus.className = "zaehler-btn";
  minus.textContent = "−";
  const input = document.createElement("input");
  input.type = "number";
  input.min = "1";
  input.max = "99";
  input.inputMode = "numeric";
  input.value = String(Math.max(1, Number(wert) || 1));
  const plus = document.createElement("button");
  plus.type = "button";
  plus.className = "zaehler-btn";
  plus.textContent = "+";

  const setzen = (n) => {
    const neu = Math.min(99, Math.max(1, n));
    input.value = String(neu);
    minus.disabled = neu <= 1;
    // Ein change-Ereignis auslösen, damit es keinen Unterschied macht, ob der Wert getippt oder
    // über die Knöpfe gesetzt wurde – sonst würde ein späterer Zuhörer nur eine der beiden Arten sehen.
    input.dispatchEvent(new Event("change", { bubbles: true }));
  };
  minus.onclick = () => setzen(Number(input.value) - 1);
  plus.onclick = () => setzen(Number(input.value) + 1);
  input.addEventListener("blur", () => setzen(Number(input.value)));
  minus.disabled = Number(input.value) <= 1;

  box.append(minus, input, plus);
  box.wert = () => Math.max(1, Number(input.value) || 1);
  return box;
}

/** Aktuelle Uhrzeit, abgerundet auf die letzte Viertelstunde – passt damit ins selbe Raster wie die
 * Auswahlfelder. Abgerundet und nicht gerundet: um 18:50 will man sehen, wer JETZT sitzt, nicht wer
 * um 19:00 kommt. */
function jetztAufViertelstunde() {
  const d = new Date();
  const m = Math.floor(d.getMinutes() / 15) * 15;
  const h = Math.min(Math.max(d.getHours(), ZEIT_VON), ZEIT_BIS);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** Rückfrage, bevor ein belegter oder gesperrter Tisch trotzdem vergeben wird. Nennt den konkreten
 * Grund, damit die Entscheidung mit Wissen getroffen wird und nicht gegen eine Fehlermeldung. */
function trotzdemPlatzieren(tisch, konflikte, terrasseGesperrt) {
  // Der Text geht als HTML in den Dialog – Namen deshalb escapen, sonst zerlegt ein Name mit spitzen
  // Klammern die Anzeige.
  const gruende = [];
  if (terrasseGesperrt) gruende.push("🌧 Die Terrasse ist für diesen Tag gesperrt (Regen).");
  for (const k of konflikte) {
    gruende.push(`🕒 ${escapeHtml(k.time)} Uhr: <b>${escapeHtml(k.name)}</b> (${k.guests} ${k.guests === 1 ? "Person" : "Personen"})`);
  }
  return confirmDialog(
    `<b>${escapeHtml(tisch.name)}</b> ist nicht frei:<br/><br/>${gruende.join("<br/>")}<br/><br/>Trotzdem hierhin setzen?`,
    { title: "Trotzdem platzieren?", okLabel: "Trotzdem platzieren" }
  );
}

function renderReservations() {
  const container = document.createElement("div");
  container.className = "page";

  let datum = todayStr();
  // Welche Reservierung gerade einen Tisch bekommt (null = keine). Bewusst kein Dialog:
  // die Tischauswahl klappt direkt unter der Zeile auf, damit die Liste sichtbar bleibt.
  let zuweisenFuer = null;
  let ansicht = "plan"; // "plan" | "liste" – im Betrieb ist der Plan die häufigere Frage
  let planZeit = jetztAufViertelstunde();

  function rerender() {
    container.innerHTML = "";
    container.appendChild(build());
  }

  function build() {
    const frag = document.createElement("div");
    const tische = store.getTables();

    frag.innerHTML = `<h1>🍽 Reservierungen</h1>`;

    if (tische.length === 0) {
      const hinweis = document.createElement("div");
      hinweis.className = "callout callout-warn";
      hinweis.innerHTML =
        "<b>Es sind noch keine Tische angelegt.</b><br/>Reservierungen lassen sich erst einem Tisch zuordnen, wenn unter <b>Admin → Tische</b> die Tische eingetragen sind.";
      frag.appendChild(hinweis);
    }

    frag.appendChild(buildTagWahl());
    frag.appendChild(buildKopfzahlen());
    frag.appendChild(buildUmschalter());
    if (ansicht === "plan") frag.appendChild(buildPlan());
    else frag.appendChild(buildListe());
    frag.appendChild(buildNeu());
    return frag;
  }

  function buildTagWahl() {
    const card = document.createElement("section");
    card.className = "card res-daybar";

    const zurueck = document.createElement("button");
    zurueck.className = "btn btn-secondary";
    zurueck.textContent = "←";
    zurueck.onclick = () => {
      datum = addDaysISO(datum, -1);
      zuweisenFuer = null;
      rerender();
    };

    const label = document.createElement("div");
    label.className = "res-daylabel";
    const heute = todayStr();
    const zusatz = datum === heute ? " · heute" : datum === addDaysISO(heute, 1) ? " · morgen" : "";
    label.innerHTML = `<b>${dateDe(datum)}</b><span class="muted">${zusatz}</span>`;

    const vor = document.createElement("button");
    vor.className = "btn btn-secondary";
    vor.textContent = "→";
    vor.onclick = () => {
      datum = addDaysISO(datum, 1);
      zuweisenFuer = null;
      rerender();
    };

    const heuteBtn = document.createElement("button");
    heuteBtn.className = "btn btn-secondary";
    heuteBtn.textContent = "Heute";
    heuteBtn.onclick = () => {
      datum = todayStr();
      zuweisenFuer = null;
      rerender();
    };

    // Terrassen-Schalter: bei Regen fallen alle Außentische für diesen Tag raus.
    const terrasse = document.createElement("button");
    const zu = store.isTerraceClosed(datum);
    terrasse.className = "btn " + (zu ? "btn-primary" : "btn-secondary");
    terrasse.textContent = zu ? "🌧 Terrasse zu" : "☀️ Terrasse offen";
    terrasse.title = "Bei Regen: Außentische lassen sich dann nicht mehr zuweisen";
    terrasse.onclick = () => {
      store.setTerraceClosed(datum, !zu);
      rerender();
    };

    card.append(zurueck, label, vor, heuteBtn, terrasse);
    return card;
  }

  function buildKopfzahlen() {
    const card = document.createElement("section");
    card.className = "card";
    const alle = store.getReservationsByDate(datum).filter((r) => r.status !== "storniert");
    const gaeste = alle.reduce((s, r) => s + r.guests, 0);
    const offen = alle.filter((r) => r.status === "offen").length;
    const da = alle.filter((r) => r.status === "da" || r.status === "weg").length;

    const zeile = document.createElement("div");
    zeile.className = "res-stats";
    zeile.innerHTML = `
      <div><span class="res-stat-zahl">${alle.length}</span><span class="muted small">Reservierungen</span></div>
      <div><span class="res-stat-zahl">${gaeste}</span><span class="muted small">Personen</span></div>
      <div><span class="res-stat-zahl${offen > 0 ? " res-stat-warn" : ""}">${offen}</span><span class="muted small">ohne Tisch</span></div>
      <div><span class="res-stat-zahl">${da}</span><span class="muted small">angekommen</span></div>`;
    card.appendChild(zeile);

    if (offen > 0) {
      const hinweis = document.createElement("p");
      hinweis.className = "muted small";
      hinweis.textContent = `${offen} ${offen === 1 ? "Reservierung hat" : "Reservierungen haben"} noch keinen Tisch.`;
      card.appendChild(hinweis);
    }

    // Bei gesperrter Terrasse: wer sitzt noch draußen? Das sind die Gäste, die umgesetzt werden müssen.
    if (store.isTerraceClosed(datum)) {
      const betroffen = alle.filter(
        (r) => r.status !== "weg" && (r.tableIds || []).some((id) => store.getTable(id)?.area === "draussen")
      );
      const box = document.createElement("div");
      box.className = betroffen.length > 0 ? "callout callout-warn" : "callout";
      box.textContent =
        betroffen.length > 0
          ? `🌧 Terrasse ist gesperrt, aber ${betroffen.length} ${
              betroffen.length === 1 ? "Reservierung sitzt" : "Reservierungen sitzen"
            } noch draußen: ${betroffen.map((r) => `${r.time} ${r.name}`).join(", ")}`
          : "🌧 Terrasse ist für heute gesperrt. Außentische lassen sich nicht zuweisen.";
      card.appendChild(box);
    }
    return card;
  }

  function buildUmschalter() {
    const reihe = document.createElement("div");
    reihe.className = "handoff-days";
    for (const [id, label] of [
      ["plan", "🗺 Tischplan"],
      ["liste", "📋 Liste"],
    ]) {
      const b = document.createElement("button");
      b.className = "btn " + (ansicht === id ? "btn-primary" : "btn-secondary");
      b.textContent = label;
      b.onclick = () => {
        ansicht = id;
        zuweisenFuer = null;
        rerender();
      };
      reihe.appendChild(b);
    }
    return reihe;
  }

  function buildPlan() {
    const card = document.createElement("section");
    card.className = "card";

    // Zeitleiste: der Plan zeigt die Belegung zu EINER Uhrzeit. Damit lässt sich vorausschauen
    // ("wie sieht es um 19:00 aus?"), ohne selbst nachzurechnen.
    const kopf = document.createElement("div");
    kopf.className = "res-daybar plan-zeitleiste";
    const label = document.createElement("span");
    label.innerHTML = "<b>Belegung um</b>";
    const sel = zeitAuswahl(planZeit);
    sel.onchange = () => {
      planZeit = sel.value;
      rerender();
    };
    const jetztBtn = document.createElement("button");
    jetztBtn.className = "btn btn-secondary";
    jetztBtn.textContent = "Jetzt";
    jetztBtn.onclick = () => {
      planZeit = jetztAufViertelstunde();
      datum = todayStr();
      rerender();
    };
    kopf.append(label, sel, jetztBtn);
    card.appendChild(kopf);

    card.appendChild(buildTischplan({ datum, zeit: planZeit, onTisch: (t) => openTischDialog(t) }));

    const legende = document.createElement("p");
    legende.className = "muted small";
    legende.innerHTML =
      '<span class="plan-punkt plan-frei"></span> frei · ' +
      '<span class="plan-punkt plan-reserviert"></span> später reserviert · ' +
      '<span class="plan-punkt plan-besetzt"></span> besetzt · Tisch antippen zum Setzen';
    card.appendChild(legende);
    return card;
  }

  /** Antippen eines Tisches im Plan: zeigt, was darauf los ist, und bietet genau die Handgriffe an,
   * die an dieser Stelle sinnvoll sind – Walk-in setzen, Gast als da markieren, Tisch frei machen. */
  function openTischDialog(t) {
    const { belegt, naechste, alle } = store.getTableOccupancy(t.id, datum, planZeit);
    const overlay = document.createElement("div");
    overlay.className = "overlay";
    overlay.innerHTML = `
      <div class="dialog">
        <h2>${escapeHtml(t.name)}</h2>
        <p class="muted small">${t.seats} Plätze · ${t.area === "innen" ? "Drinnen" : "Draußen"} · Stand ${escapeHtml(planZeit)} Uhr</p>
      </div>`;
    const box = overlay.querySelector(".dialog");
    const schliessen = () => overlay.remove();

    if (alle.length > 0) {
      const liste = document.createElement("div");
      liste.className = "task-list";
      for (const r of alle) {
        const zeile = document.createElement("div");
        zeile.className = "task-row";
        const marke = r === belegt ? "🔴 jetzt" : r === naechste ? "🟡 als nächstes" : "";
        zeile.innerHTML = `<div class="task-row-text"><span><b>${escapeHtml(r.time)}</b> ${escapeHtml(r.name)} · ${r.guests} ${
          r.guests === 1 ? "Person" : "Personen"
        }</span><span class="muted small task-row-meta">${marke}${r.status === "da" ? " · sitzt da" : ""}${
          r.status === "weg" ? " · gegangen" : ""
        }${r.note ? ` · 📝 ${escapeHtml(r.note)}` : ""}</span></div>`;
        liste.appendChild(zeile);
      }
      box.appendChild(liste);
    } else {
      const frei = document.createElement("p");
      frei.className = "callout";
      frei.textContent = "Für diesen Tag ist hier nichts reserviert.";
      box.appendChild(frei);
    }

    const aktionen = document.createElement("div");
    aktionen.className = "plan-aktionen";

    // Walk-in: der häufigste Handgriff am Plan, deshalb ganz oben und ohne Namensabfrage.
    const walkin = document.createElement("button");
    walkin.className = "btn btn-primary btn-huge";
    walkin.textContent = "🚶 Walk-in setzen";
    walkin.onclick = () => {
      schliessen();
      openWalkIn(t);
    };
    aktionen.appendChild(walkin);

    if (belegt && belegt.status !== "da") {
      const da = document.createElement("button");
      da.className = "btn btn-secondary";
      da.textContent = `✓ ${belegt.name} ist da`;
      da.onclick = () => {
        store.updateReservation(belegt.id, { status: "da" });
        schliessen();
        rerender();
      };
      aktionen.appendChild(da);
    }
    if (belegt && belegt.status === "da") {
      const weg = document.createElement("button");
      weg.className = "btn btn-secondary";
      weg.textContent = "Tisch frei machen";
      weg.title = "Gäste sind gegangen";
      weg.onclick = () => {
        store.updateReservation(belegt.id, { status: "weg" });
        schliessen();
        rerender();
      };
      aktionen.appendChild(weg);
    }

    const zu = document.createElement("button");
    zu.className = "btn btn-link";
    zu.textContent = "Schließen";
    zu.onclick = schliessen;
    aktionen.appendChild(zu);

    box.appendChild(aktionen);
    document.body.appendChild(overlay);
  }

  /** Laufkundschaft setzen: nur die Personenzahl, sonst nichts. Name, Telefon und Bereich braucht
   * niemand, wenn die Leute schon vor einem stehen. */
  function openWalkIn(t) {
    const { belegt, naechste } = store.getTableOccupancy(t.id, datum, planZeit);
    const overlay = document.createElement("div");
    overlay.className = "overlay";
    overlay.innerHTML = `
      <div class="dialog">
        <h2>🚶 Walk-in an ${escapeHtml(t.name)}</h2>
        <p class="muted small">${t.seats} Plätze · ab ${escapeHtml(planZeit)} Uhr</p>
      </div>`;
    const box = overlay.querySelector(".dialog");

    if (belegt) {
      const warn = document.createElement("div");
      warn.className = "callout callout-warn";
      warn.innerHTML = `Hier sitzt gerade <b>${escapeHtml(belegt.name)}</b> (${escapeHtml(belegt.time)} Uhr).`;
      box.appendChild(warn);
    } else if (naechste) {
      // Der wichtigste Hinweis überhaupt: bis wann darf der Tisch belegt werden?
      const info = document.createElement("div");
      info.className = "callout";
      info.innerHTML = `Frei bis <b>${escapeHtml(naechste.time)} Uhr</b> – dann kommt ${escapeHtml(naechste.name)}.`;
      box.appendChild(info);
    }

    const feld = document.createElement("label");
    feld.className = "field";
    feld.innerHTML = "<span>Wie viele Personen?</span>";
    const personen = personenFeld(Math.min(t.seats, 2));
    feld.appendChild(personen);
    box.appendChild(feld);

    const aktionen = document.createElement("div");
    aktionen.className = "dialog-actions";
    const abbrechen = document.createElement("button");
    abbrechen.className = "btn btn-secondary";
    abbrechen.textContent = "Abbrechen";
    abbrechen.onclick = () => overlay.remove();
    const setzen = document.createElement("button");
    setzen.className = "btn btn-primary";
    setzen.textContent = "Setzen";
    setzen.onclick = () => {
      store.addWalkIn({ date: datum, time: planZeit, guests: personen.wert(), tableIds: [t.id] });
      overlay.remove();
      rerender();
    };
    aktionen.append(abbrechen, setzen);
    box.appendChild(aktionen);
    document.body.appendChild(overlay);
  }

  function buildListe() {
    const card = document.createElement("section");
    card.className = "card";
    const alle = store.getReservationsByDate(datum);
    if (alle.length === 0) {
      card.innerHTML = `<p class="muted">Für diesen Tag ist noch nichts reserviert.</p>`;
      return card;
    }

    for (const r of alle) card.appendChild(buildZeile(r));
    return card;
  }

  function buildZeile(r) {
    const box = document.createElement("div");
    box.className = "res-row res-" + r.status;

    const kopf = document.createElement("div");
    kopf.className = "res-row-head";

    const zeit = document.createElement("div");
    zeit.className = "res-time";
    zeit.textContent = r.time;

    const mitte = document.createElement("div");
    mitte.className = "res-main";
    const tische = (r.tableIds || []).map((id) => store.getTable(id)?.name).filter(Boolean);
    mitte.innerHTML =
      `<div class="res-name"><b>${escapeHtml(r.name)}</b> · ${r.guests} ${r.guests === 1 ? "Person" : "Personen"}</div>` +
      `<div class="muted small">${escapeHtml(AREA_LABEL[r.area] || r.area)}${
        tische.length ? ` · <b class="res-tisch">${escapeHtml(tische.join(" + "))}</b>` : ' · <span class="res-kein-tisch">kein Tisch</span>'
      }${r.phone ? ` · ${escapeHtml(r.phone)}` : ""} · Nr. ${escapeHtml(r.code)}</div>` +
      (r.note ? `<div class="muted small">📝 ${escapeHtml(r.note)}</div>` : "");

    // Terrasse zugemacht, aber hier sitzt noch jemand draußen: das muss auffallen, sonst steht der Gast
    // im Regen. Die Zuweisung wird bewusst NICHT automatisch gelöscht – umsetzen ist eine Entscheidung.
    const draussenTrotzRegen =
      store.isTerraceClosed(datum) &&
      !["storniert", "weg"].includes(r.status) &&
      (r.tableIds || []).some((id) => store.getTable(id)?.area === "draussen");
    if (draussenTrotzRegen) {
      const warn = document.createElement("div");
      warn.className = "res-warn";
      warn.textContent = "🌧 sitzt auf der gesperrten Terrasse – bitte umsetzen";
      mitte.appendChild(warn);
    }

    kopf.append(zeit, mitte);

    // Die eine Aktion, die im Betrieb zählt: ist der Gast da?
    const aktionen = document.createElement("div");
    aktionen.className = "res-actions";
    if (r.status === "storniert") {
      const zurueck = document.createElement("button");
      zurueck.className = "btn btn-secondary";
      zurueck.textContent = "↩ Zurückholen";
      zurueck.onclick = () => {
        store.updateReservation(r.id, { status: (r.tableIds || []).length ? "zugewiesen" : "offen" });
        rerender();
      };
      aktionen.appendChild(zurueck);
    } else if (r.status === "da") {
      const weg = document.createElement("button");
      weg.className = "btn btn-secondary";
      weg.textContent = "Tisch frei";
      weg.title = "Gäste sind gegangen – Tisch wieder verfügbar";
      weg.onclick = () => {
        store.updateReservation(r.id, { status: "weg" });
        rerender();
      };
      aktionen.appendChild(weg);
    } else if (r.status !== "weg") {
      const da = document.createElement("button");
      da.className = "btn btn-primary res-da-btn";
      da.textContent = "✓ Ist da";
      da.onclick = () => {
        store.updateReservation(r.id, { status: "da" });
        rerender();
      };
      aktionen.appendChild(da);
    }

    const tischBtn = document.createElement("button");
    tischBtn.className = "btn btn-secondary";
    tischBtn.textContent = tische.length ? "Tisch ändern" : "＋ Tisch";
    tischBtn.onclick = () => {
      zuweisenFuer = zuweisenFuer === r.id ? null : r.id;
      rerender();
    };
    aktionen.appendChild(tischBtn);

    const mehr = document.createElement("button");
    mehr.className = "btn btn-secondary";
    mehr.textContent = "⋯";
    mehr.title = "Bearbeiten, absagen, löschen";
    mehr.onclick = () => openMehr(r);
    aktionen.appendChild(mehr);

    kopf.appendChild(aktionen);
    box.appendChild(kopf);

    if (zuweisenFuer === r.id) box.appendChild(buildTischWahl(r));
    return box;
  }

  /** Tischauswahl direkt in der Zeile. Belegte Tische bleiben sichtbar, aber gesperrt – so sieht man
   * sofort, WARUM ein Tisch nicht geht, statt sich zu fragen, wo er hin ist. */
  function buildTischWahl(r) {
    const box = document.createElement("div");
    box.className = "res-tischwahl";

    const tische = store.getTables();
    if (tische.length === 0) {
      box.innerHTML = `<p class="muted small">Erst unter Admin → Tische Tische anlegen.</p>`;
      return box;
    }

    // Vorschläge zuerst: bei 24 Reservierungen soll niemand selbst suchen, welche zwei Zweier noch
    // frei sind und nebeneinander stehen. Nur anzeigen, solange noch nichts zugewiesen ist.
    if ((r.tableIds || []).length === 0) {
      const vorschlaege = store.getCombinationSuggestions(datum, r.time, r.guests, r.area, r.id).slice(0, 5);
      if (vorschlaege.length > 0) {
        const titel = document.createElement("div");
        titel.className = "muted small res-bereich";
        titel.innerHTML = `<b>Passt für ${r.guests} ${r.guests === 1 ? "Person" : "Personen"}</b> – antippen übernimmt direkt`;
        box.appendChild(titel);

        const reihe = document.createElement("div");
        reihe.className = "res-tische";
        for (const v of vorschlaege) {
          const btn = document.createElement("button");
          btn.className = "res-vorschlag" + (v.count > 1 ? " res-vorschlag-kombi" : "");
          btn.innerHTML =
            `<span class="res-tisch-name">${escapeHtml(v.names.join(" + "))}</span>` +
            `<span class="muted small">${v.seats} Plätze${v.count > 1 ? " · zusammengeschoben" : ""}</span>`;
          btn.onclick = () => {
            store.updateReservation(r.id, { tableIds: v.tableIds });
            rerender();
          };
          reihe.appendChild(btn);
        }
        box.appendChild(reihe);

        const trenner = document.createElement("div");
        trenner.className = "muted small res-bereich";
        trenner.textContent = "…oder selbst auswählen:";
        box.appendChild(trenner);
      } else {
        const leer = document.createElement("div");
        leer.className = "callout callout-warn";
        leer.textContent = `Keine freie Kombination für ${r.guests} ${
          r.guests === 1 ? "Person" : "Personen"
        } um ${r.time}. Du kannst trotzdem von Hand zuweisen.`;
        box.appendChild(leer);
      }
    }

    const terrasseZu = store.isTerraceClosed(datum);
    for (const bereich of ["innen", "draussen"]) {
      const imBereich = tische.filter((t) => t.area === bereich);
      if (imBereich.length === 0) continue;

      const titel = document.createElement("div");
      titel.className = "muted small res-bereich";
      titel.textContent =
        (bereich === "innen" ? "Drinnen" : "Draußen") + (bereich === "draussen" && terrasseZu ? " – heute gesperrt (Regen)" : "");
      box.appendChild(titel);

      const reihe = document.createElement("div");
      reihe.className = "res-tische";
      for (const t of imBereich) {
        const gewaehlt = (r.tableIds || []).includes(t.id);
        const konflikte = store.getTableConflicts(t.id, datum, r.time, r.id);
        const gesperrt = (bereich === "draussen" && terrasseZu && !gewaehlt) || (konflikte.length > 0 && !gewaehlt);

        const btn = document.createElement("button");
        btn.className = "res-tisch-btn" + (gewaehlt ? " gewaehlt" : "") + (gesperrt ? " gesperrt" : "");
        btn.innerHTML = `<span class="res-tisch-name">${escapeHtml(t.name)}</span><span class="muted small">${t.seats} Pl.</span>`;
        if (konflikte.length > 0 && !gewaehlt) {
          btn.title = `Belegt: ${konflikte.map((k) => `${k.time} ${k.name}`).join(", ")} – antippen für "trotzdem platzieren"`;
        } else if (gesperrt) {
          btn.title = "Terrasse ist heute gesperrt – antippen für \"trotzdem platzieren\"";
        }
        // Belegte Tische sind markiert, aber NICHT gesperrt: im Betrieb gibt es genug Gründe, es
        // trotzdem zu tun (Gäste gehen früher, jemand rückt zusammen, Tisch wird geteilt). Statt es zu
        // verbieten, wird einmal nachgefragt und der Grund genannt.
        btn.onclick = async () => {
          const jetzt = new Set(r.tableIds || []);
          if (jetzt.has(t.id)) {
            jetzt.delete(t.id);
          } else {
            if (gesperrt && !(await trotzdemPlatzieren(t, konflikte, terrasseZu && t.area === "draussen"))) return;
            jetzt.add(t.id);
          }
          store.updateReservation(r.id, { tableIds: [...jetzt] });
          rerender();
        };
        reihe.appendChild(btn);
      }
      box.appendChild(reihe);
    }

    // Passen die Plätze zur Personenzahl? Nur ein Hinweis, kein Verbot – zusammenrücken geht immer.
    const plaetze = (r.tableIds || []).reduce((s, id) => s + (store.getTable(id)?.seats || 0), 0);
    const info = document.createElement("p");
    if (plaetze === 0) {
      info.className = "muted small";
      info.textContent = "Tisch antippen zum Zuweisen. Mehrere Tische gehen auch (große Gruppen).";
    } else if (plaetze < r.guests) {
      info.className = "callout callout-warn";
      info.textContent = `${plaetze} Plätze für ${r.guests} Personen – reicht knapp nicht. Zweiten Tisch dazunehmen?`;
    } else {
      info.className = "muted small";
      info.textContent = `${plaetze} Plätze für ${r.guests} ${r.guests === 1 ? "Person" : "Personen"}.`;
    }
    box.appendChild(info);

    // Mehrere Tische, die laut Nachbarschaft nicht zusammenpassen: als Hinweis, nicht als Verbot.
    // Es kann gute Gründe geben (Tisch umstellen, Gruppe sitzt getrennt) – das entscheidet der Mensch.
    if ((r.tableIds || []).length > 1 && !store.areTablesCombinable(r.tableIds)) {
      const warn = document.createElement("p");
      warn.className = "callout callout-warn";
      warn.textContent =
        "Diese Tische stehen laut Tischplan nicht nebeneinander – sie lassen sich also nicht zu einer Tafel zusammenschieben. Wenn die Gruppe getrennt sitzen soll, passt es so.";
      box.appendChild(warn);
    }

    const fertig = document.createElement("button");
    fertig.className = "btn btn-primary";
    fertig.textContent = "Fertig";
    fertig.onclick = () => {
      zuweisenFuer = null;
      rerender();
    };
    box.appendChild(fertig);
    return box;
  }

  function openMehr(r) {
    const overlay = document.createElement("div");
    overlay.className = "overlay";
    overlay.innerHTML = `
      <div class="dialog">
        <h2>${escapeHtml(r.name)}</h2>
        <p class="muted small">${escapeHtml(dateDe(r.date))} · ${escapeHtml(r.time)} Uhr · Nr. ${escapeHtml(r.code)}</p>
        <label class="field"><span>Name</span><input type="text" id="rd-name" value="${escapeHtml(r.name)}" /></label>
        <div class="res-form-row">
          <label class="field"><span>Uhrzeit</span><span id="rd-time-slot"></span></label>
          <label class="field"><span>Personen</span><span id="rd-guests-slot"></span></label>
        </div>
        <div class="res-form-row">
          <label class="field"><span>Bereich</span><select id="rd-area">
            <option value="innen" ${r.area === "innen" ? "selected" : ""}>Drinnen</option>
            <option value="draussen" ${r.area === "draussen" ? "selected" : ""}>Draußen</option>
            <option value="egal" ${r.area === "egal" ? "selected" : ""}>Egal</option>
          </select></label>
          <label class="field"><span>Telefon</span><input type="tel" id="rd-phone" value="${escapeHtml(r.phone || "")}" /></label>
        </div>
        <label class="field"><span>Datum</span><input type="date" id="rd-date" value="${escapeHtml(r.date)}" /></label>
        <label class="field"><span>Notiz</span><input type="text" id="rd-note" value="${escapeHtml(r.note || "")}" placeholder="z.B. Kinderstuhl, Geburtstag" /></label>
        <p class="muted small" id="rd-status"></p>
        <div class="dialog-actions">
          <button class="btn btn-secondary" id="rd-cancel">Abbrechen</button>
          <button class="btn btn-primary" id="rd-save">Speichern</button>
        </div>
        <div class="res-dialog-danger">
          ${r.status !== "storniert" ? '<button class="btn btn-secondary" id="rd-absagen">Absagen</button>' : ""}
          <button class="btn btn-link" id="rd-delete">Löschen</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    // Uhrzeit und Personenzahl werden gebaut statt als HTML geschrieben: beide sind zusammengesetzte
    // Bedienelemente (Viertelstunden-Liste bzw. Zähler mit − und +).
    const zeitFeld = zeitAuswahl(r.time);
    overlay.querySelector("#rd-time-slot").replaceWith(zeitFeld);
    const personenFeldEl = personenFeld(r.guests);
    overlay.querySelector("#rd-guests-slot").replaceWith(personenFeldEl);

    const status = overlay.querySelector("#rd-status");
    overlay.querySelector("#rd-cancel").onclick = () => overlay.remove();

    overlay.querySelector("#rd-save").onclick = () => {
      const name = overlay.querySelector("#rd-name").value.trim();
      const zeit = zeitFeld.value;
      const tag = overlay.querySelector("#rd-date").value;
      if (!name || !zeit || !tag) {
        status.className = "callout callout-warn";
        status.textContent = "Name, Datum und Uhrzeit werden gebraucht.";
        return;
      }
      store.updateReservation(r.id, {
        name,
        time: zeit,
        date: tag,
        guests: personenFeldEl.wert(),
        area: overlay.querySelector("#rd-area").value,
        phone: overlay.querySelector("#rd-phone").value,
        note: overlay.querySelector("#rd-note").value,
      });
      overlay.remove();
      datum = tag; // beim Umbuchen auf einen anderen Tag gleich dorthin springen
      rerender();
    };

    overlay.querySelector("#rd-absagen")?.addEventListener("click", () => {
      store.updateReservation(r.id, { status: "storniert", tableIds: [] });
      overlay.remove();
      rerender();
    });

    overlay.querySelector("#rd-delete").onclick = async () => {
      overlay.remove();
      if (await confirmDialog(`Reservierung von ${r.name} wirklich löschen? Absagen reicht meistens – dann bleibt sie sichtbar.`)) {
        store.removeReservation(r.id);
        rerender();
      }
    };
  }

  /** Neue Reservierung von Hand – z.B. telefonisch. Bewusst direkt auf der Seite statt im Dialog:
   * am Telefon tippt man mit, ohne die Tagesliste zu verlieren. */
  function buildNeu() {
    const card = document.createElement("section");
    card.className = "card";
    card.innerHTML = `<h2>＋ Neue Reservierung</h2><p class="muted small">Für ${escapeHtml(dateDe(datum))}. Telefon und Notiz sind freiwillig.</p>`;

    const form = document.createElement("div");
    const feld = (label, el) => {
      const l = document.createElement("label");
      l.className = "field";
      l.innerHTML = `<span>${label}</span>`;
      l.appendChild(el);
      return l;
    };
    const mk = (typ, attrs = {}) => {
      const i = document.createElement("input");
      i.type = typ;
      Object.assign(i, attrs);
      return i;
    };

    const name = mk("text", { placeholder: "Name des Gastes" });
    const zeit = zeitAuswahl("10:00");
    const personen = personenFeld(2);
    const telefon = mk("tel", { placeholder: "optional" });
    const notiz = mk("text", { placeholder: "z.B. Kinderstuhl, Geburtstag" });
    const bereich = document.createElement("select");
    bereich.innerHTML = `<option value="innen">Drinnen</option><option value="draussen">Draußen</option><option value="egal">Egal</option>`;

    const reihe1 = document.createElement("div");
    reihe1.className = "res-form-row";
    reihe1.append(feld("Name", name), feld("Uhrzeit", zeit), feld("Personen", personen));
    const reihe2 = document.createElement("div");
    reihe2.className = "res-form-row";
    reihe2.append(feld("Bereich", bereich), feld("Telefon", telefon), feld("Notiz", notiz));
    form.append(reihe1, reihe2);
    card.appendChild(form);

    const status = document.createElement("p");
    status.className = "muted small";

    const btn = document.createElement("button");
    btn.className = "btn btn-primary btn-huge";
    btn.textContent = "Reservierung anlegen";
    btn.onclick = () => {
      if (!name.value.trim()) {
        status.className = "callout callout-warn";
        status.textContent = "Bitte einen Namen eintragen.";
        name.focus();
        return;
      }
      const r = store.addReservation({
        date: datum,
        time: zeit.value,
        name: name.value,
        phone: telefon.value,
        guests: personen.wert(),
        area: bereich.value,
        note: notiz.value,
      });
      if (!r) {
        status.className = "callout callout-warn";
        status.textContent = "Konnte nicht angelegt werden – bitte Uhrzeit prüfen.";
        return;
      }
      // Direkt zur Tischwahl aufklappen: das ist fast immer der nächste Handgriff.
      zuweisenFuer = r.id;
      rerender();
    };
    card.append(btn, status);
    return card;
  }

  rerender();
  return container;
}

export { renderReservations };
