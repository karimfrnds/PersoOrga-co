// ============================================================================
// pages/einrichtung.js – Einrichtung des Pop-up-Stores.
//
// Ein neuer Betrieb startet bei null: kein Team, keine PINs, keine Bestandsliste, keine Aufgaben. Das
// alles am Abend vor der Eröffnung einzeln anzulegen ist eine halbe Stunde Tipperei – und was man dabei
// vergisst, fällt erst auf, wenn jemand davorsteht.
//
// Deshalb steht hier alles auf einer Seite, in der Reihenfolge, in der man es braucht, mit fertigen
// Vorschlägen für einen Zimtschnecken-Stand. Vorschläge, nicht Vorgaben: abwählen, übernehmen, danach
// ganz normal in den anderen Tabs ändern.
//
// Die Seite verschwindet nicht, wenn alles erledigt ist. Sie wird zur Übersicht – "steht das noch?" ist
// nach drei Wochen dieselbe Frage wie am ersten Tag.
// ============================================================================
import { store } from "../store.js";
import { betrieb } from "../betrieb.js";
import { escapeHtml, euro } from "../format.js";
import { alertDialog } from "../dialog.js";
import { zahlText, einheitText } from "./kueche.js";

// Was ein Zimtschnecken-Stand zählt. Theke = was vorne steht und täglich nachgefüllt wird,
// Lager = was man einkauft. Die Soll-Zahlen sind Startwerte, keine Wahrheit.
const BESTAND_VORSCHLAG = [
  { bereich: "theke", name: "Becher to go", einheit: "Stück", soll: 150 },
  { bereich: "theke", name: "Deckel", einheit: "Stück", soll: 150 },
  { bereich: "theke", name: "Tüten", einheit: "Stück", soll: 100 },
  { bereich: "theke", name: "Servietten", einheit: "Packungen", soll: 4 },
  { bereich: "theke", name: "Hafermilch", einheit: "Liter", soll: 6 },
  { bereich: "theke", name: "Vollmilch", einheit: "Liter", soll: 6 },
  { bereich: "lager", name: "Mehl", einheit: "kg", soll: 25 },
  { bereich: "lager", name: "Butter", einheit: "kg", soll: 8 },
  { bereich: "lager", name: "Zucker", einheit: "kg", soll: 10 },
  { bereich: "lager", name: "Zimt", einheit: "kg", soll: 1 },
  { bereich: "lager", name: "Hefe", einheit: "Packungen", soll: 10 },
  { bereich: "lager", name: "Eier", einheit: "Stück", soll: 60 },
  { bereich: "lager", name: "Frischkäse", einheit: "kg", soll: 3 },
  { bereich: "lager", name: "Matcha-Pulver", einheit: "Packungen", soll: 2 },
  { bereich: "lager", name: "Kaffeebohnen", einheit: "kg", soll: 4 },
  { bereich: "lager", name: "Reinigungsmittel", einheit: "Flaschen", soll: 2 },
];

// Der Tag eines Stands, von vorne nach hinten. Ohne Uhrzeiten – die stehen am Anfang nie fest, und eine
// falsche Uhrzeit meldet sich jeden Tag als überfällig.
const AUFGABEN_VORSCHLAG = [
  { phase: "beginn", text: "Ofen vorheizen" },
  { phase: "beginn", text: "Teig aus dem Kühlschrank nehmen" },
  { phase: "beginn", text: "Kaffeemaschine anstellen und durchspülen" },
  { phase: "beginn", text: "Wechselgeld prüfen und Kasse öffnen" },
  { phase: "beginn", text: "Theke aufbauen und Auslage füllen" },
  { phase: "schicht", text: "Nachbacken, bevor die Auslage leer ist" },
  { phase: "schicht", text: "Becher, Deckel und Tüten nachfüllen" },
  { phase: "schicht", text: "Theke abwischen" },
  { phase: "ende", text: "Verkaufszahlen und Reste im iPad eintragen" },
  { phase: "ende", text: "Kasse zählen und Kassenabschluss machen" },
  { phase: "ende", text: "Kaffeemaschine reinigen" },
  { phase: "ende", text: "Theke abräumen und abwischen" },
  { phase: "ende", text: "Müll rausbringen" },
  // Ein fester Zähltag: dienstags, und die Aufgabe hakt sich ab, sobald die Zählung abgeschlossen ist.
  { phase: "ende", text: "Lager zählen", weekdays: [1], bestandBereich: "lager" },
];

const PHASE_NAME = { beginn: "Schichtbeginn", schicht: "Während der Schicht", ende: "Schichtende" };
const WT = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];

function renderEinrichtung(wechsleTab) {
  const container = document.createElement("div");
  container.className = "page";

  // Welche Vorschläge angehakt sind. Überlebt das Neuzeichnen, damit ein Abwählen nicht zurückspringt.
  const bestandWahl = new Set(BESTAND_VORSCHLAG.map((_, i) => i));
  const aufgabenWahl = new Set(AUFGABEN_VORSCHLAG.map((_, i) => i));

  function rerender() {
    const scroll = window.scrollY;
    container.innerHTML = "";
    container.appendChild(build());
    window.scrollTo(0, scroll);
  }

  // ---------------------------------------------------------------------
  // Was ist erledigt?
  // ---------------------------------------------------------------------
  function stand() {
    const team = store.getEmployees(true);
    const inbox = store.getTaskInboxConfig();
    return {
      team: team.length > 0 && team.every((e) => e.pin),
      teamZahl: team.length,
      ohnePin: team.filter((e) => !e.pin).length,
      schichten: store.getShiftSlotsForRole(betrieb.rollen[0]).length > 0,
      produkte: store.getProdukte().length > 0,
      bestand: store.getPreps(false).length > 0,
      aufgaben: store.getTaskTemplates().length > 0,
      verbindung: !!(inbox.enabled && inbox.workerUrl && inbox.workerSecret),
    };
  }

  function build() {
    const s = stand();
    const schritte = ["team", "schichten", "produkte", "bestand", "aufgaben", "verbindung"];
    const fertig = schritte.filter((k) => s[k]).length;

    const frag = document.createElement("div");
    frag.innerHTML = `<h1>Einrichtung</h1>
      <p class="muted">Was der ${escapeHtml(betrieb.name)} braucht, bevor jemand davorsteht. Alles lässt sich
      später ändern – die Vorschläge sind ein Startpunkt, keine Vorgabe.</p>`;

    const balken = document.createElement("div");
    balken.className = fertig === schritte.length ? "callout" : "callout callout-warn";
    balken.innerHTML =
      fertig === schritte.length
        ? "<b>Alles eingerichtet.</b> Diese Seite bleibt als Übersicht stehen."
        : `<b>${fertig} von ${schritte.length} Schritten erledigt.</b> Offen: ` +
          schritte.filter((k) => !s[k]).map((k) => ({ team: "Team", schichten: "Schichten", produkte: "Produkte", bestand: "Bestand", aufgaben: "Aufgaben", verbindung: "Verbindung" })[k]).join(", ");
    frag.appendChild(balken);

    frag.appendChild(buildTeam(s));
    frag.appendChild(buildSchichten(s));
    frag.appendChild(buildProdukte(s));
    frag.appendChild(buildBestand(s));
    frag.appendChild(buildAufgaben(s));
    frag.appendChild(buildVerbindung(s));
    return frag;
  }

  /** Karten-Gerüst mit Nummer, Titel und Haken. */
  function karte(nr, titel, erledigt, beschreibung) {
    const card = document.createElement("section");
    card.className = "card";
    card.innerHTML = `<h2>${erledigt ? "✅" : "⬜"} ${nr}. ${escapeHtml(titel)}</h2>
      <p class="muted small">${beschreibung}</p>`;
    return card;
  }

  /** Knopf, der in einen anderen Admin-Tab springt. */
  function weiter(label, tabId) {
    const b = document.createElement("button");
    b.className = "btn btn-secondary";
    b.textContent = label;
    b.onclick = () => wechsleTab(tabId);
    return b;
  }

  // ---------------------------------------------------------------------
  // 1. Team
  // ---------------------------------------------------------------------
  function buildTeam(s) {
    const card = karte(
      1,
      "Team",
      s.team,
      "Wer hier steht und mit welchem PIN. Mit diesem PIN stempelt die Person am iPad ein und öffnet ihr eigenes Fenster."
    );

    const team = store.getEmployees(true);
    if (team.length === 0) {
      const leer = document.createElement("p");
      leer.className = "muted small";
      leer.textContent = "Noch niemand angelegt.";
      card.appendChild(leer);
    } else {
      const liste = document.createElement("div");
      liste.className = "task-list";
      for (const e of team) {
        const row = document.createElement("div");
        row.className = "task-row";
        row.innerHTML = `<div class="task-row-text"><span><b>${escapeHtml(e.name)}</b></span>
          <span class="muted small task-row-meta">${e.pin ? "PIN " + escapeHtml(e.pin) : "⚠ kein PIN – kann sich nicht einstempeln"}${
            e.hourlyWage ? " · " + euro(e.hourlyWage) + "/Std" : ""
          }</span></div>`;
        liste.appendChild(row);
      }
      card.appendChild(liste);
    }

    // Anlegen direkt hier: Name, PIN, Lohn. Mehr braucht es zum Einstempeln nicht.
    const reihe = document.createElement("div");
    reihe.className = "res-form-row";
    const name = Object.assign(document.createElement("input"), { type: "text", placeholder: "Name" });
    const pin = Object.assign(document.createElement("input"), { type: "text", inputMode: "numeric", placeholder: "PIN, z.B. 1234" });
    const lohn = Object.assign(document.createElement("input"), { type: "text", inputMode: "decimal", placeholder: "Lohn/Std, optional" });
    for (const [label, node] of [
      ["Name", name],
      ["PIN", pin],
      ["Stundenlohn", lohn],
    ]) {
      const l = document.createElement("label");
      l.className = "field";
      l.innerHTML = `<span>${label}</span>`;
      l.appendChild(node);
      reihe.appendChild(l);
    }
    card.appendChild(reihe);

    const anlegen = document.createElement("button");
    anlegen.className = "btn btn-primary";
    anlegen.textContent = "＋ Person anlegen";
    anlegen.onclick = async () => {
      const n = name.value.trim();
      const p = pin.value.trim();
      if (!n) return alertDialog("Bitte einen Namen eintragen.");
      if (!/^\d{4,8}$/.test(p)) return alertDialog("Der PIN muss aus 4 bis 8 Ziffern bestehen.");
      if (store.isPinTaken(p)) return alertDialog("Diesen PIN benutzt schon jemand anderes (oder der Admin). Bitte einen anderen wählen.");
      store.addEmployee({ name: n, role: betrieb.rollen[0], pin: p, hourlyWage: Number(lohn.value.replace(",", ".")) || 0 });
      rerender();
    };
    card.appendChild(anlegen);
    card.appendChild(weiter("Mitarbeiter bearbeiten", "employees"));
    return card;
  }

  // ---------------------------------------------------------------------
  // 2. Schichten
  // ---------------------------------------------------------------------
  function buildSchichten(s) {
    const slots = store.getShiftSlotsForRole(betrieb.rollen[0]);
    const card = karte(
      2,
      "Schichten",
      s.schichten,
      "Die Zeiten, für die sich das Team einträgt. Bei einem Pop-up stehen sie am Anfang nie fest – hier sind sie änderbar."
    );
    const liste = document.createElement("div");
    liste.className = "mg-liste";
    for (const slot of slots) {
      const zeile = document.createElement("div");
      zeile.className = "summary-line";
      const tage = slot.allowedWeekdays ? slot.allowedWeekdays.map((w) => WT[w]).join(", ") : "jeden Tag";
      zeile.innerHTML = `<span><b>${escapeHtml(slot.label)}</b></span><span>${escapeHtml(slot.from)}–${escapeHtml(slot.to)} <span class="muted small">· ${escapeHtml(tage)}</span></span>`;
      liste.appendChild(zeile);
    }
    if (slots.length === 0) liste.innerHTML = `<p class="muted small">Keine Schicht angelegt – dann kann sich auch niemand eintragen.</p>`;
    card.appendChild(liste);
    card.appendChild(weiter("Zeiten ändern", "produkte"));
    return card;
  }

  // ---------------------------------------------------------------------
  // 3. Produkte
  // ---------------------------------------------------------------------
  function buildProdukte(s) {
    const produkte = store.getProdukte();
    const card = karte(
      3,
      "Produkte",
      s.produkte,
      "Was verkauft wird und was es kostet. Daraus rechnet der Tagesabschluss den Umsatz – und mit den Warenkosten je Stück auch, was unterm Strich bleibt."
    );
    const liste = document.createElement("div");
    liste.className = "mg-liste";
    for (const p of produkte) {
      const zeile = document.createElement("div");
      zeile.className = "summary-line";
      zeile.innerHTML = `<span><b>${escapeHtml(p.name)}</b>${p.gebacken ? ' <span class="muted small">· wird gebacken</span>' : ""}</span><span>${euro(
        p.preis
      )} <span class="muted small">${p.kosten ? `− ${euro(p.kosten)} Ware` : "· keine Warenkosten hinterlegt"}</span></span>`;
      liste.appendChild(zeile);
    }
    if (produkte.length === 0) liste.innerHTML = `<p class="muted small">Noch kein Produkt angelegt.</p>`;
    card.appendChild(liste);
    card.appendChild(weiter("Preise ändern", "produkte"));
    return card;
  }

  // ---------------------------------------------------------------------
  // 4. Bestand
  // ---------------------------------------------------------------------
  function buildBestand(s) {
    const card = karte(
      4,
      "Bestand",
      s.bestand,
      "Was gezählt wird und wie viel mindestens da sein soll. Gezählt wird im persönlichen Fenster – am iPad und am Handy."
    );

    if (s.bestand) {
      const liste = document.createElement("div");
      liste.className = "mg-liste";
      for (const b of store.BESTAND_BEREICHE) {
        const n = store.getPreps(true, b.id).length;
        const zeile = document.createElement("div");
        zeile.className = "summary-line";
        zeile.innerHTML = `<span>${b.symbol} ${escapeHtml(b.label)}</span><span>${n} ${n === 1 ? "Artikel" : "Artikel"}</span>`;
        liste.appendChild(zeile);
      }
      card.appendChild(liste);
      card.appendChild(weiter("Bestand bearbeiten", "sollbestand"));
      return card;
    }

    card.appendChild(vorschlagsListe(BESTAND_VORSCHLAG, bestandWahl, (v) => {
      const b = store.BESTAND_BEREICHE.find((x) => x.id === v.bereich);
      return `<b>${escapeHtml(v.name)}</b> <span class="muted small">${b ? b.symbol + " " + escapeHtml(b.label) : ""} · Soll ${zahlText(
        v.soll
      )} ${escapeHtml(einheitText(v.einheit, v.soll))}</span>`;
    }));

    const uebernehmen = document.createElement("button");
    uebernehmen.className = "btn btn-primary";
    const n = bestandWahl.size;
    uebernehmen.textContent = `${n} ${n === 1 ? "Artikel" : "Artikel"} übernehmen`;
    uebernehmen.disabled = n === 0;
    uebernehmen.onclick = () => {
      let sort = 10;
      for (const i of [...bestandWahl].sort((a, b) => a - b)) {
        const v = BESTAND_VORSCHLAG[i];
        store.addPrep({ name: v.name, bereich: v.bereich, einheit: v.einheit, soll: v.soll, sort: (sort += 10) });
      }
      rerender();
    };
    card.appendChild(uebernehmen);
    card.appendChild(weiter("Lieber selbst anlegen", "sollbestand"));
    return card;
  }

  // ---------------------------------------------------------------------
  // 5. Aufgaben
  // ---------------------------------------------------------------------
  function buildAufgaben(s) {
    const card = karte(
      5,
      "Standard-Aufgaben",
      s.aufgaben,
      "Was jede Schicht bekommt, aufgeteilt in Schichtbeginn, Während der Schicht und Schichtende. Sie entstehen für jede Person beim Einstempeln."
    );

    if (s.aufgaben) {
      const alle = store.getTaskTemplates();
      const liste = document.createElement("div");
      liste.className = "mg-liste";
      for (const ph of ["beginn", "schicht", "ende"]) {
        const n = alle.filter((t) => (t.phase || "schicht") === ph).length;
        const zeile = document.createElement("div");
        zeile.className = "summary-line";
        zeile.innerHTML = `<span>${escapeHtml(PHASE_NAME[ph])}</span><span>${n} ${n === 1 ? "Aufgabe" : "Aufgaben"}</span>`;
        liste.appendChild(zeile);
      }
      card.appendChild(liste);
      card.appendChild(weiter("Aufgaben bearbeiten", "tasks"));
      return card;
    }

    card.appendChild(vorschlagsListe(AUFGABEN_VORSCHLAG, aufgabenWahl, (v) => {
      const extra = [
        PHASE_NAME[v.phase],
        v.weekdays ? "nur " + v.weekdays.map((w) => WT[w]).join(", ") : null,
        v.bestandBereich ? "hakt sich mit der Zählung ab" : null,
      ]
        .filter(Boolean)
        .join(" · ");
      return `<b>${escapeHtml(v.text)}</b> <span class="muted small">${escapeHtml(extra)}</span>`;
    }));

    const uebernehmen = document.createElement("button");
    uebernehmen.className = "btn btn-primary";
    const n = aufgabenWahl.size;
    uebernehmen.textContent = `${n} ${n === 1 ? "Aufgabe" : "Aufgaben"} übernehmen`;
    uebernehmen.disabled = n === 0;
    uebernehmen.onclick = () => {
      for (const i of [...aufgabenWahl].sort((a, b) => a - b)) {
        const v = AUFGABEN_VORSCHLAG[i];
        store.addTaskTemplate({
          text: v.text,
          phase: v.phase,
          weekdays: v.weekdays || [],
          bestandBereich: v.bestandBereich || "",
        });
      }
      rerender();
    };
    card.appendChild(uebernehmen);
    card.appendChild(weiter("Lieber selbst anlegen", "tasks"));
    return card;
  }

  /** Liste mit Häkchen: alles vorgewählt, abwählen was nicht passt. */
  function vorschlagsListe(quelle, wahl, zeileHtml) {
    const box = document.createElement("div");
    box.className = "task-list";
    quelle.forEach((v, i) => {
      const row = document.createElement("label");
      row.className = "task-row";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = wahl.has(i);
      cb.onchange = () => {
        if (cb.checked) wahl.add(i);
        else wahl.delete(i);
        rerender();
      };
      row.appendChild(cb);
      const t = document.createElement("div");
      t.className = "task-row-text";
      t.innerHTML = zeileHtml(v);
      row.appendChild(t);
      box.appendChild(row);
    });
    return box;
  }

  // ---------------------------------------------------------------------
  // 6. Verbindung
  // ---------------------------------------------------------------------
  function buildVerbindung(s) {
    const inbox = store.getTaskInboxConfig();
    const card = karte(
      6,
      "Verbindung zu Handy und Laptop",
      s.verbindung,
      "Ohne sie läuft alles nur auf diesem iPad: kein Eintragen vom Handy, keine Laptop-Ansicht, keine Nachrichten."
    );
    const status = document.createElement("p");
    status.className = s.verbindung ? "muted small" : "callout callout-warn";
    status.innerHTML = s.verbindung
      ? `Eingerichtet · zuletzt abgeglichen: ${inbox.lastSyncAt ? escapeHtml(new Date(inbox.lastSyncAt).toLocaleString("de-DE")) : "noch nie"}`
      : `Noch nicht eingerichtet. Adresse und Schlüssel trägst du unter <b>Einstellungen</b> ein – dieselben, die im Worker stehen.`;
    card.appendChild(status);
    card.appendChild(weiter("Zu den Einstellungen", "settings"));
    return card;
  }

  rerender();
  return container;
}

export { renderEinrichtung };
