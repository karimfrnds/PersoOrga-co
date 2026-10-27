// ============================================================================
// manager/produktion.js – Produktion am Laptop und am Handy: steuern und nachsehen.
//
// Dieselbe Sache wie im Küchen-Hub am Tablet, aber für jemanden, der sitzt statt steht: breitere
// Tabellen, mehr Zahlen, und alles bearbeitbar. Wer in der Küche steht, will wissen was zu tun ist;
// wer das hier öffnet, will wissen woran es liegt.
//
// Vier Umschalter, weil es vier verschiedene Fragen sind:
//   AUSWERTUNG  – was läuft, was wird weggeworfen, wie lange reicht was
//   PRODUKTE    – was hergestellt wird, mit Soll, Gebinde, Haltbarkeit
//   BEHÄLTER    – worin es landet und was gerade wo steht
//   REZEPTE     – wie es gemacht wird
//
// Gerechnet wird nichts davon hier. Die Zahlen kommen vom Haupt-Tablet, das sie aus Zählungen und
// Chargen bildet – eine zweite Rechnung an zweiter Stelle gäbe irgendwann eine zweite Antwort.
// ============================================================================
import { el, text, knopf, feld, eingabe, textfeld, auswahl, blatt, ausfuehren, segmente, zahl, wann, escapeHtml } from "./ui.js";
import { stammAction } from "./api.js";

let unterTab = "auswertung";

function renderProduktion(daten, { neuLaden }) {
  const wrap = el("div");
  const produkte = daten.produktionsProdukte || [];
  const behaelter = daten.behaelter || [];
  const offen = daten.offeneChargen || [];
  const verlauf = daten.chargenVerlauf || [];
  const rezepte = daten.rezepte || [];
  const heute = daten.heute;

  if (produkte.length === 0 && behaelter.length === 0 && rezepte.length === 0) {
    wrap.appendChild(text("h1", null, "👨‍🍳 Produktion"));
    wrap.appendChild(
      el("div", "callout", "Noch nichts angelegt. Fang mit einem <b>Produkt</b> an – Name, wie viel immer da sein soll, und wie lange es hält.")
    );
    wrap.appendChild(knopf("＋ Produkt", "btn btn-primary", () => openProdukt(null, neuLaden, behaelter, rezepte)));
    return wrap;
  }

  wrap.appendChild(text("h1", null, "👨‍🍳 Produktion"));
  wrap.appendChild(
    segmente(
      [
        ["auswertung", "Auswertung"],
        ["produkte", `Produkte (${produkte.length})`],
        ["behaelter", `Behälter (${behaelter.length})`],
        ["rezepte", `Rezepte (${rezepte.length})`],
      ],
      unterTab,
      (id) => {
        unterTab = id;
        neuLaden();
      }
    )
  );

  if (unterTab === "auswertung") wrap.appendChild(buildAuswertung(daten, produkte, offen, verlauf, heute));
  else if (unterTab === "produkte") wrap.appendChild(buildProdukte(produkte, offen, behaelter, rezepte, heute, neuLaden));
  else if (unterTab === "behaelter") wrap.appendChild(buildBehaelter(behaelter, offen, produkte, neuLaden));
  else wrap.appendChild(buildRezepte(rezepte, neuLaden));
  return wrap;
}

// ---------------------------------------------------------------------
// Auswertung
// ---------------------------------------------------------------------
function buildAuswertung(daten, produkte, offen, verlauf, heute) {
  const box = el("div");

  // --- Was gerade klemmt ---
  const abgelaufen = offen.filter((c) => c.mhd && c.mhd < heute);
  const auftraege = (daten.produktionsAuftraege || []).length;
  const kopf = el("section", "card");
  kopf.appendChild(text("h2", null, "Jetzt"));
  const unterSoll = produkte.filter((p) => {
    const ist = offen.filter((c) => c.produktId === p.id && (!c.mhd || c.mhd >= heute)).reduce((n, c) => n + Number(c.menge || 0), 0);
    return p.soll > 0 && ist < p.soll;
  });
  kopf.appendChild(
    el(
      "p",
      unterSoll.length > 0 || abgelaufen.length > 0 ? "callout callout-warn" : "callout",
      escapeHtml(
        [
          `${auftraege} ${auftraege === 1 ? "Auftrag" : "Aufträge"} offen`,
          `${unterSoll.length} ${unterSoll.length === 1 ? "Produkt" : "Produkte"} unter Soll`,
          `${abgelaufen.length} ${abgelaufen.length === 1 ? "Behälter abgelaufen" : "Behälter abgelaufen"}`,
        ].join(" · ")
      )
    )
  );
  box.appendChild(kopf);

  // --- Je Produkt: produziert, weggeworfen, Bestand ---
  const seit = (tage) => {
    const d = new Date(`${heute}T00:00:00`);
    d.setDate(d.getDate() - tage);
    return d.toISOString().slice(0, 10);
  };
  const karte = el("section", "card");
  karte.appendChild(text("h2", null, "Produktion und Ausschuss"));
  karte.appendChild(
    text(
      "p",
      "muted small",
      "Ausschuss heisst: ein Behälter wurde als leer gemeldet, nachdem er abgelaufen war. Das ist der Teil, der in die Tonne ging statt in den Verkauf."
    )
  );
  const scroll = el("div");
  scroll.style.overflowX = "auto";
  const tab = document.createElement("table");
  tab.className = "calc-table";
  tab.innerHTML = `<thead><tr><th>Produkt</th><th>Da / Soll</th><th>7 Tage</th><th>30 Tage</th><th>Ausschuss</th><th>Zuletzt</th></tr></thead>`;
  const tbody = document.createElement("tbody");
  for (const p of produkte) {
    const meine = verlauf.filter((c) => c.produktId === p.id);
    const im = (tage) => meine.filter((c) => String(c.am || "").slice(0, 10) >= seit(tage));
    const ist = offen.filter((c) => c.produktId === p.id && (!c.mhd || c.mhd >= heute)).reduce((n, c) => n + Number(c.menge || 0), 0);
    const p7 = im(7).reduce((n, c) => n + Number(c.menge || 0), 0);
    const p30 = im(30).reduce((n, c) => n + Number(c.menge || 0), 0);
    const weg = im(30)
      .filter((c) => c.leerAm && c.mhd && String(c.leerAm).slice(0, 10) > c.mhd)
      .reduce((n, c) => n + Number(c.menge || 0), 0);
    const anteil = p30 > 0 ? Math.round((weg / p30) * 100) : 0;
    const zuletzt = meine.map((c) => c.am).sort().slice(-1)[0];
    const tr = document.createElement("tr");
    tr.innerHTML =
      `<td><b>${escapeHtml(p.name)}</b></td>` +
      `<td class="${p.soll > 0 && ist < p.soll ? "res-warn" : ""}">${zahl(Math.round(ist * 100) / 100)} / ${zahl(p.soll)} ${escapeHtml(p.einheit || "")}</td>` +
      `<td>${zahl(Math.round(p7 * 100) / 100)}</td>` +
      `<td>${zahl(Math.round(p30 * 100) / 100)}</td>` +
      `<td class="${anteil >= 10 ? "res-warn" : ""}">${weg > 0 ? `${zahl(Math.round(weg * 100) / 100)} (${anteil} %)` : "–"}</td>` +
      `<td class="muted small">${zuletzt ? escapeHtml(wann(zuletzt)) : "nie"}</td>`;
    tbody.appendChild(tr);
  }
  tab.appendChild(tbody);
  scroll.appendChild(tab);
  karte.appendChild(scroll);
  box.appendChild(karte);

  // --- Verbrauch der eingekauften Ware ---
  const verb = (daten.verbrauch || []).filter((v) => !v.produzierbar && v.ist !== null && v.ist !== undefined);
  if (verb.length > 0) {
    const vk = el("section", "card");
    vk.appendChild(text("h2", null, "Reicht noch"));
    vk.appendChild(
      text("p", "muted small", "Aus den Zählungen gerechnet. Zeiträume mit einer Lieferung dazwischen bleiben aussen vor – die Liefermenge steht nirgends.")
    );
    const s2 = el("div");
    s2.style.overflowX = "auto";
    const t2 = document.createElement("table");
    t2.className = "calc-table";
    t2.innerHTML = `<thead><tr><th>Artikel</th><th>Da</th><th>Pro Tag</th><th>Reicht noch</th><th>Je 100 Stück</th></tr></thead>`;
    const b2 = document.createElement("tbody");
    for (const v of verb) {
      const tr = document.createElement("tr");
      tr.innerHTML =
        `<td><b>${escapeHtml(v.name)}</b></td>` +
        `<td>${zahl(v.ist)} ${escapeHtml(v.einheit || "")}</td>` +
        `<td>${v.proTag === null ? '<span class="muted small">zu wenig gezählt</span>' : zahl(v.proTag)}</td>` +
        `<td class="${v.reichweite !== null && v.reichweite <= 3 ? "res-warn" : ""}">${
          v.reichweite === null ? "–" : v.reichweite === 0 ? "<b>heute leer</b>" : `${v.reichweite} ${v.reichweite === 1 ? "Tag" : "Tage"}`
        }</td>` +
        `<td class="muted small">${v.jeHundert === null ? "–" : zahl(v.jeHundert)}</td>`;
      b2.appendChild(tr);
    }
    t2.appendChild(b2);
    s2.appendChild(t2);
    vk.appendChild(s2);
    box.appendChild(vk);
  }

  // --- Wer hat was gemacht ---
  const proPerson = new Map();
  for (const c of verlauf.filter((x) => String(x.am || "").slice(0, 10) >= seit(30))) {
    const name = String(c.vonName || "").trim();
    if (!name) continue;
    proPerson.set(name, (proPerson.get(name) || 0) + 1);
  }
  if (proPerson.size > 0) {
    const pk = el("section", "card");
    pk.appendChild(text("h2", null, "Letzte 30 Tage"));
    const liste = el("div", "mg-liste");
    for (const [name, n] of [...proPerson.entries()].sort((a, b) => b[1] - a[1])) {
      liste.appendChild(el("div", "summary-line", `<span>${escapeHtml(name)}</span><span>${n} ${n === 1 ? "Charge" : "Chargen"}</span>`));
    }
    pk.appendChild(liste);
    box.appendChild(pk);
  }
  return box;
}

// ---------------------------------------------------------------------
// Produkte
// ---------------------------------------------------------------------
function buildProdukte(produkte, offen, behaelter, rezepte, heute, neuLaden) {
  const card = el("section", "card");
  card.appendChild(text("h2", null, "Produktionsprodukte"));
  card.appendChild(
    text(
      "p",
      "muted small",
      "Das Soll ist die Menge, die immer da sein soll – fällt der Bestand darunter, legt das System beim Einstempeln von selbst einen Auftrag an. Das Gebinde ist die Portion, in der produziert wird; Aufträge werden darauf aufgerundet."
    )
  );
  const liste = el("div", "mg-liste");
  for (const p of produkte) {
    const ist = offen.filter((c) => c.produktId === p.id && (!c.mhd || c.mhd >= heute)).reduce((n, c) => n + Number(c.menge || 0), 0);
    // Gleiche Bauweise wie die anderen Listen in diesem Bereich: zwei Zeilen untereinander, die Karte
    // selbst ist der Knopf. Ein eigenes Gerüst drumherum bricht das Spaltenlayout.
    const zeile = knopf("", "mg-zeile mg-zeile-knopf", () => openProdukt(p, neuLaden, behaelter, rezepte));
    zeile.innerHTML = `<span></span><span class="muted small"></span>`;
    zeile.firstChild.textContent = p.name;
    zeile.lastChild.textContent = [
      `${zahl(Math.round(ist * 100) / 100)} / ${zahl(p.soll)} ${p.einheit || ""}`,
      p.gebinde > 0 ? `Gebinde ${zahl(p.gebinde)}` : null,
      p.haltbarkeitTage > 0 ? `${p.haltbarkeitTage} ${p.haltbarkeitTage === 1 ? "Tag" : "Tage"} haltbar` : "ohne MHD",
      p.rezeptId ? rezepte.find((r) => r.id === p.rezeptId)?.name || null : null,
    ]
      .filter(Boolean)
      .join(" · ");
    liste.appendChild(zeile);
  }
  card.appendChild(liste);
  card.appendChild(knopf("＋ Produkt", "btn btn-primary", () => openProdukt(null, neuLaden, behaelter, rezepte)));
  return card;
}

function openProdukt(vorhanden, neuLaden, behaelter, rezepte) {
  blatt(vorhanden ? vorhanden.name : "Neues Produkt", (box, schliessen) => {
    const name = eingabe("text", vorhanden?.name, "z.B. Zimtschnecken-Teig");
    const einheit = eingabe("text", vorhanden?.einheit || "Blech", "Blech, Liter, kg …");
    const soll = eingabe("text", vorhanden ? zahl(vorhanden.soll) : "", "z.B. 4");
    soll.inputMode = "decimal";
    const gebinde = eingabe("text", vorhanden?.gebinde ? zahl(vorhanden.gebinde) : "", "z.B. 1");
    gebinde.inputMode = "decimal";
    const haltbar = eingabe("text", vorhanden?.haltbarkeitTage ? zahl(vorhanden.haltbarkeitTage) : "", "z.B. 3");
    haltbar.inputMode = "numeric";
    const standard = auswahl([["", "– keiner –"], ...behaelter.map((b) => [b.id, b.name])], vorhanden?.standardBehaelterId || "");
    const rezept = auswahl([["", "– kein Rezept –"], ...rezepte.map((r) => [r.id, r.name])], vorhanden?.rezeptId || "");

    box.appendChild(feld("Produkt", name));
    box.appendChild(feld("Soll – so viel soll immer da sein", soll));
    box.appendChild(feld("Einheit", einheit));
    box.appendChild(feld("Gebinde", gebinde, "Die Portion, in der produziert wird. Leer = keine Rundung."));
    box.appendChild(feld("Haltbar (Tage)", haltbar, "0 oder leer = kein MHD und keine Ablauf-Warnung."));
    box.appendChild(feld("Standard-Behälter", standard, "Beim Eintragen vorausgewählt – die Küche kann ihn ändern."));
    box.appendChild(feld("Rezept", rezept));

    const kommaZahl = (f) => Number(String(f.value).replace(",", ".")) || 0;
    const speichern = knopf("Speichern", "btn btn-primary btn-huge", async () => {
      if (!name.value.trim()) return;
      const fertig = await ausfuehren(speichern, () =>
        stammAction({
          art: "produkt",
          id: vorhanden?.id || null,
          name: name.value.trim(),
          einheit: einheit.value.trim(),
          soll: kommaZahl(soll),
          gebinde: kommaZahl(gebinde),
          haltbarkeitTage: Math.round(kommaZahl(haltbar)),
          standardBehaelterId: standard.value || null,
          rezeptId: rezept.value || null,
        })
      , "Gespeichert – das Tablet übernimmt es beim nächsten Abgleich.");
      if (fertig) {
        schliessen();
        neuLaden();
      }
    });
    box.appendChild(speichern);
  });
}

// ---------------------------------------------------------------------
// Behälter
// ---------------------------------------------------------------------
function buildBehaelter(behaelter, offen, produkte, neuLaden) {
  const card = el("section", "card");
  card.appendChild(text("h2", null, "Behälter"));
  card.appendChild(
    text("p", "muted small", "Eine gepflegte Liste statt freier Eingabe – „GN 1/1“ und „gn1“ nebeneinander, und niemand findet mehr, wo etwas steht.")
  );
  const liste = el("div", "mg-liste");
  for (const b of behaelter) {
    const drin = offen.find((c) => c.behaelterId === b.id);
    const zeile = knopf("", "mg-zeile mg-zeile-knopf", () => openBehaelter(b, neuLaden));
    zeile.innerHTML = `<span></span><span class="muted small"></span>`;
    zeile.firstChild.textContent = b.name;
    zeile.lastChild.textContent =
      ([b.groesse, b.ort].filter(Boolean).join(" · ") || "ohne Angabe") +
      (drin ? ` · belegt: ${produkte.find((p) => p.id === drin.produktId)?.name || "?"}` : " · frei");
    liste.appendChild(zeile);
  }
  card.appendChild(liste);
  card.appendChild(knopf("＋ Behälter", "btn btn-primary", () => openBehaelter(null, neuLaden)));
  return card;
}

function openBehaelter(vorhanden, neuLaden) {
  blatt(vorhanden ? vorhanden.name : "Neuer Behälter", (box, schliessen) => {
    const name = eingabe("text", vorhanden?.name, "z.B. GN 1/1 – 3");
    const groesse = eingabe("text", vorhanden?.groesse, "z.B. 10 L");
    const ort = eingabe("text", vorhanden?.ort, "z.B. Kühlhaus, Regal 2");
    box.appendChild(feld("Name", name, "Eindeutig und am Behälter lesbar – beschrifte ihn genauso."));
    box.appendChild(feld("Grösse", groesse));
    box.appendChild(feld("Steht normalerweise", ort));
    const speichern = knopf("Speichern", "btn btn-primary btn-huge", async () => {
      if (!name.value.trim()) return;
      const fertig = await ausfuehren(
        speichern,
        () => stammAction({ art: "behaelter", id: vorhanden?.id || null, name: name.value.trim(), groesse: groesse.value.trim(), ort: ort.value.trim() }),
        "Gespeichert."
      );
      if (fertig) {
        schliessen();
        neuLaden();
      }
    });
    box.appendChild(speichern);
  });
}

// ---------------------------------------------------------------------
// Rezepte
// ---------------------------------------------------------------------
function buildRezepte(rezepte, neuLaden) {
  const card = el("section", "card");
  card.appendChild(text("h2", null, "Rezepte"));
  card.appendChild(text("p", "muted small", "Zutaten und Schritte als Zeilen – in der Küche wird abgelesen, nicht gerechnet. Sie stehen am Küchen-Tablet."));
  const liste = el("div", "mg-liste");
  for (const r of rezepte) {
    const zeile = knopf("", "mg-zeile mg-zeile-knopf", () => openRezept(r, neuLaden));
    zeile.innerHTML = `<span></span><span class="muted small"></span>`;
    zeile.firstChild.textContent = r.name;
    zeile.lastChild.textContent = [r.ergibt, `${(r.zutaten || []).length} Zutaten`, `${(r.schritte || []).length} Schritte`].filter(Boolean).join(" · ");
    liste.appendChild(zeile);
  }
  if (rezepte.length === 0) card.appendChild(text("p", "muted small", "Noch kein Rezept hinterlegt."));
  else card.appendChild(liste);
  card.appendChild(knopf("＋ Rezept", "btn btn-primary", () => openRezept(null, neuLaden)));
  return card;
}

function openRezept(vorhanden, neuLaden) {
  blatt(vorhanden ? vorhanden.name : "Neues Rezept", (box, schliessen) => {
    const name = eingabe("text", vorhanden?.name, "z.B. Hefeteig");
    const ergibt = eingabe("text", vorhanden?.ergibt, "z.B. 4 Bleche");
    const zutaten = textfeld((vorhanden?.zutaten || []).join("\n"), "Eine Zutat je Zeile:\n500 g Mehl\n200 g Butter", 7);
    const schritte = textfeld((vorhanden?.schritte || []).join("\n"), "Ein Schritt je Zeile:\nMehl und Butter verkneten\n1 Stunde gehen lassen", 7);
    const notiz = textfeld(vorhanden?.notiz, "Worauf zu achten ist", 3);
    box.appendChild(feld("Name", name));
    box.appendChild(feld("Ergibt", ergibt));
    box.appendChild(feld("Zutaten", zutaten, "Je Zeile eine. Leere Zeilen fallen weg."));
    box.appendChild(feld("So geht's", schritte, "Je Zeile ein Schritt."));
    box.appendChild(feld("Notiz", notiz));
    const speichern = knopf("Speichern", "btn btn-primary btn-huge", async () => {
      if (!name.value.trim()) return;
      const fertig = await ausfuehren(
        speichern,
        () =>
          stammAction({
            art: "rezept",
            id: vorhanden?.id || null,
            name: name.value.trim(),
            ergibt: ergibt.value.trim(),
            zutaten: zutaten.value,
            schritte: schritte.value,
            notiz: notiz.value.trim(),
          }),
        "Gespeichert."
      );
      if (fertig) {
        schliessen();
        neuLaden();
      }
    });
    box.appendChild(speichern);
  });
}

export { renderProduktion };
