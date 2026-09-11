// ============================================================================
// social/statistik.js – Auswertung.
//
// Die Zahlen kommen von Hand: es gibt keinen API-Zugang zu Instagram & Co., und wer etwas anderes
// verspricht, baut eine Zahl, die niemand nachprüfen kann. Deshalb ist die Frage nicht "wie kommen die
// Zahlen rein", sondern "welche vier Zahlen lohnen den Aufwand".
//
// Es sind diese:
//   Follower über die Zeit  – wächst der Account überhaupt? Die einzige Zahl, die über Monate zählt.
//   Interaktionsrate        – erreichen die Beiträge die Leute, die sie sehen? Unabhängig von der
//                             Accountgröße und damit die ehrlichste Zahl für "war der Post gut".
//   Was nach Rubrik/Format  – WAS funktioniert, nicht nur DASS etwas funktioniert hat. Das ist der
//                             Unterschied zwischen Statistik und Erkenntnis.
//   Beste Zeit              – aus den eigenen Daten, nicht aus einem Ratgeber im Netz.
//
// Überall gilt: lieber "noch zu wenige Daten" schreiben als einen Schnitt aus zwei Posts zeigen.
// ============================================================================
import { escapeHtml, el, zahl, prozent, interaktionen, interaktionsrate, dateDeShort, WOCHENTAGE, weekdayIndex, feld } from "./gemeinsam.js";

const MINDEST_POSTS = 3; // darunter ist ein Durchschnitt Zufall, kein Ergebnis

function renderStatistik(daten, { onAccount, onAccountLoeschen }) {
  const wrap = el("div");
  wrap.appendChild(el("h2", "sm-kal-titel", "Auswertung"));

  const mitZahlen = (daten.posts || []).filter((p) => p.statistik && p.statistik.reichweite !== null);
  wrap.appendChild(buildFollower(daten, { onAccount, onAccountLoeschen }));
  wrap.appendChild(buildUeberblick(mitZahlen, daten));
  wrap.appendChild(buildTopPosts(mitZahlen));
  wrap.appendChild(buildNachGruppe(mitZahlen, "rubrik", "Was funktioniert – nach Rubrik"));
  wrap.appendChild(buildNachGruppe(mitZahlen, "format", "Was funktioniert – nach Format"));
  wrap.appendChild(buildBesteZeit(mitZahlen));
  return wrap;
}

/** Die Follower-Kurve. Bewusst als Balken über die erfassten Stichtage statt als glatte Linie: es sind
 * einzelne Ablesungen, keine durchgehende Messung, und das soll man sehen. */
function buildFollower(daten, { onAccount, onAccountLoeschen }) {
  const card = el("section", "card");
  card.appendChild(el("h2", null, "Follower"));
  const stats = [...(daten.accountStats || [])].sort((a, b) => a.datum.localeCompare(b.datum));

  if (stats.length === 0) {
    card.appendChild(
      el(
        "p",
        "muted small",
        "Noch kein Stand erfasst. Trag einmal pro Woche die Follower-Zahl ein – nach vier Wochen siehst du, ob der Account wächst."
      )
    );
  } else {
    const letzter = stats[stats.length - 1];
    const vorletzter = stats.length > 1 ? stats[stats.length - 2] : null;
    const diff = vorletzter ? letzter.follower - vorletzter.follower : null;
    const kopf = el("div", "sm-kennzahl");
    kopf.innerHTML =
      `<b>${zahl(letzter.follower)}</b><span class="muted small">Stand ${escapeHtml(dateDeShort(letzter.datum))}</span>` +
      (diff !== null
        ? `<span class="${diff >= 0 ? "sm-auf" : "sm-ab"}">${diff >= 0 ? "+" : ""}${zahl(diff)} seit ${escapeHtml(dateDeShort(vorletzter.datum))}</span>`
        : "");
    card.appendChild(kopf);

    // Balken. Die Skala beginnt bewusst nicht bei 0, sondern knapp unter dem kleinsten Wert – sonst
    // sähen 1200 und 1250 Follower gleich aus und die Kurve würde nichts zeigen.
    const werte = stats.map((s) => s.follower);
    const min = Math.min(...werte);
    const max = Math.max(...werte);
    const spanne = Math.max(1, max - min);
    const chart = el("div", "sm-chart");
    for (const s of stats.slice(-16)) {
      const hoehe = 12 + ((s.follower - min) / spanne) * 78;
      const saeule = el("div", "sm-chart-saeule");
      saeule.title = `${dateDeShort(s.datum)}: ${zahl(s.follower)} Follower`;
      saeule.innerHTML = `<div class="sm-chart-balken" style="height:${hoehe}%"></div><span>${escapeHtml(dateDeShort(s.datum))}</span>`;
      chart.appendChild(saeule);
    }
    card.appendChild(chart);
    card.appendChild(el("p", "muted small", `Die Skala beginnt bei ${zahl(min)}, damit kleine Bewegungen sichtbar bleiben.`));

    const liste = el("div", "task-list");
    for (const s of [...stats].reverse().slice(0, 5)) {
      const row = el("div", "task-row");
      const teile = [
        `${zahl(s.follower)} Follower`,
        s.reichweite !== null && s.reichweite !== undefined ? `${zahl(s.reichweite)} Reichweite` : null,
        s.profilaufrufe !== null && s.profilaufrufe !== undefined ? `${zahl(s.profilaufrufe)} Profilaufrufe` : null,
        s.notiz || null,
      ].filter(Boolean);
      row.innerHTML = `<div class="task-row-text"><span><b>${escapeHtml(dateDeShort(s.datum))}</b></span>
        <span class="muted small task-row-meta">${escapeHtml(teile.join(" · "))}</span></div>`;
      const weg = el("button", "btn btn-link", "✕");
      weg.onclick = () => onAccountLoeschen(s);
      row.appendChild(weg);
      liste.appendChild(row);
    }
    card.appendChild(liste);
  }

  // Eingabe
  const box = el("div", "res-form");
  box.appendChild(el("p", "muted small", "<b>Stand eintragen</b> – am besten immer am selben Wochentag."));
  const datum = document.createElement("input");
  datum.type = "date";
  datum.value = daten.heute;
  const follower = document.createElement("input");
  follower.type = "number";
  follower.min = "0";
  follower.inputMode = "numeric";
  const reichweite = document.createElement("input");
  reichweite.type = "number";
  reichweite.min = "0";
  const aufrufe = document.createElement("input");
  aufrufe.type = "number";
  aufrufe.min = "0";
  const reihe = el("div", "res-form-row");
  reihe.append(
    feld("Stichtag", datum),
    feld("Follower", follower),
    feld("Reichweite (7 Tage)", reichweite),
    feld("Profilaufrufe (7 Tage)", aufrufe)
  );
  box.appendChild(reihe);
  const hinweis = el("p", "muted small");
  box.appendChild(hinweis);
  const speichern = el("button", "btn btn-primary", "Eintragen");
  speichern.onclick = () => {
    if (!follower.value) {
      hinweis.className = "res-warn small";
      hinweis.textContent = "Bitte die Follower-Zahl eintragen.";
      return;
    }
    onAccount({
      datum: datum.value,
      follower: follower.value,
      reichweite: reichweite.value,
      profilaufrufe: aufrufe.value,
    });
  };
  box.appendChild(speichern);
  card.appendChild(box);
  return card;
}

function buildUeberblick(mitZahlen, daten) {
  const card = el("section", "card");
  card.appendChild(el("h2", null, "Beiträge im Schnitt"));
  const raus = (daten.posts || []).filter((p) => p.status === "veroeffentlicht").length;
  if (mitZahlen.length === 0) {
    card.appendChild(
      el(
        "p",
        "muted small",
        raus > 0
          ? `${raus} Beiträge sind raus, aber bei keinem stehen Zahlen. Trag sie bei ein paar Posts nach – vorher lässt sich nichts vergleichen.`
          : "Noch keine Zahlen erfasst."
      )
    );
    return card;
  }
  const summe = (f) => mitZahlen.reduce((a, p) => a + (f(p) || 0), 0);
  const schnittReichweite = Math.round(summe((p) => p.statistik.reichweite) / mitZahlen.length);
  const mitRate = mitZahlen.map(interaktionsrate).filter((x) => x !== null);
  const schnittRate = mitRate.length ? mitRate.reduce((a, b) => a + b, 0) / mitRate.length : null;
  const zeilen = [
    ["Beiträge mit Zahlen", `${mitZahlen.length} von ${raus} veröffentlicht`],
    ["Reichweite im Schnitt", zahl(schnittReichweite)],
    ["Interaktionen im Schnitt", zahl(Math.round(summe((p) => interaktionen(p)) / mitZahlen.length))],
    ["Interaktionsrate", schnittRate === null ? "–" : prozent(schnittRate)],
    ["Neue Follower gesamt", zahl(summe((p) => p.statistik.neueFollower))],
  ];
  for (const [links, rechts] of zeilen) {
    card.appendChild(el("div", "summary-line", `<span>${links}</span><span><b>${rechts}</b></span>`));
  }
  card.appendChild(
    el(
      "p",
      "muted small",
      "Die <b>Interaktionsrate</b> ist Interaktionen geteilt durch Reichweite – sie sagt, ob ein Beitrag die Leute erreicht hat, die ihn gesehen haben. Unabhängig davon, wie groß der Account ist."
    )
  );
  return card;
}

function buildTopPosts(mitZahlen) {
  const card = el("section", "card");
  card.appendChild(el("h2", null, "Beste und schwächste Beiträge"));
  if (mitZahlen.length < MINDEST_POSTS) {
    card.appendChild(el("p", "muted small", `Dafür braucht es mindestens ${MINDEST_POSTS} Beiträge mit Zahlen.`));
    return card;
  }
  const sortiert = [...mitZahlen].sort((a, b) => (interaktionsrate(b) ?? -1) - (interaktionsrate(a) ?? -1));
  const tabelle = (titel, liste) => {
    card.appendChild(el("p", "muted small res-bereich", `<b>${titel}</b>`));
    const t = el("div", "task-list");
    for (const p of liste) {
      const row = el("div", "task-row");
      row.innerHTML = `<div class="task-row-text"><span><b>${escapeHtml(p.titel)}</b></span>
        <span class="muted small task-row-meta">${escapeHtml(dateDeShort(p.datum))} · ${escapeHtml(p.kanal)} · ${escapeHtml(
          p.format
        )}${p.rubrik ? " · " + escapeHtml(p.rubrik) : ""}</span>
        <span class="muted small task-row-meta">${zahl(p.statistik.reichweite)} Reichweite · ${zahl(
          interaktionen(p)
        )} Interaktionen · <b>${prozent(interaktionsrate(p))}</b></span></div>`;
      t.appendChild(row);
    }
    card.appendChild(t);
  };
  tabelle("Lief am besten", sortiert.slice(0, 3));
  tabelle("Lief am schwächsten", sortiert.slice(-3).reverse());
  return card;
}

/** Nach Rubrik bzw. Format auswerten. Das ist der Schritt von "der Post lief gut" zu "Reels über das
 * Team laufen gut" – und nur der zweite Satz hilft bei der nächsten Planung. */
function buildNachGruppe(mitZahlen, feldName, titel) {
  const card = el("section", "card");
  card.appendChild(el("h2", null, titel));
  const gruppen = new Map();
  for (const p of mitZahlen) {
    const key = p[feldName] || "ohne Angabe";
    if (!gruppen.has(key)) gruppen.set(key, []);
    gruppen.get(key).push(p);
  }
  const zeilen = [...gruppen.entries()]
    .map(([name, posts]) => {
      const raten = posts.map(interaktionsrate).filter((x) => x !== null);
      return {
        name,
        anzahl: posts.length,
        reichweite: Math.round(posts.reduce((a, p) => a + (p.statistik.reichweite || 0), 0) / posts.length),
        rate: raten.length ? raten.reduce((a, b) => a + b, 0) / raten.length : null,
      };
    })
    .sort((a, b) => (b.rate ?? -1) - (a.rate ?? -1));

  if (zeilen.length < 2) {
    card.appendChild(el("p", "muted small", "Dafür braucht es Beiträge aus mindestens zwei verschiedenen Gruppen."));
    return card;
  }
  const scroll = el("div");
  scroll.style.overflowX = "auto";
  const tab = document.createElement("table");
  tab.className = "calc-table";
  tab.innerHTML = `<thead><tr><th>${feldName === "rubrik" ? "Rubrik" : "Format"}</th><th>Beiträge</th><th>Ø Reichweite</th><th>Ø Interaktionsrate</th></tr></thead>`;
  const tb = document.createElement("tbody");
  for (const z of zeilen) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${escapeHtml(z.name)}</td><td>${z.anzahl}</td><td>${zahl(z.reichweite)}</td>
      <td>${z.anzahl < MINDEST_POSTS ? `<span class="muted">${prozent(z.rate)} (zu wenige)</span>` : `<b>${prozent(z.rate)}</b>`}</td>`;
    tb.appendChild(tr);
  }
  tab.appendChild(tb);
  scroll.appendChild(tab);
  card.appendChild(scroll);
  card.appendChild(
    el("p", "muted small", `Gruppen mit weniger als ${MINDEST_POSTS} Beiträgen sind grau – der Schnitt wäre dort Zufall.`)
  );
  return card;
}

/** Welcher Wochentag läuft? Aus den eigenen Zahlen, nicht aus einem Ratgeber. */
function buildBesteZeit(mitZahlen) {
  const card = el("section", "card");
  card.appendChild(el("h2", null, "Wochentage"));
  if (mitZahlen.length < MINDEST_POSTS * 2) {
    card.appendChild(
      el("p", "muted small", `Dafür braucht es mindestens ${MINDEST_POSTS * 2} Beiträge mit Zahlen – sonst ist es geraten.`)
    );
    return card;
  }
  const proTag = Array.from({ length: 7 }, () => []);
  for (const p of mitZahlen) proTag[weekdayIndex(p.datum)].push(p);
  const max = Math.max(
    ...proTag.map((liste) => (liste.length ? liste.reduce((a, p) => a + (p.statistik.reichweite || 0), 0) / liste.length : 0))
  );
  const chart = el("div", "sm-chart");
  proTag.forEach((liste, i) => {
    const schnitt = liste.length ? liste.reduce((a, p) => a + (p.statistik.reichweite || 0), 0) / liste.length : 0;
    const saeule = el("div", "sm-chart-saeule");
    saeule.title = liste.length ? `${WOCHENTAGE[i]}: ${zahl(Math.round(schnitt))} Reichweite im Schnitt (${liste.length} Beiträge)` : `${WOCHENTAGE[i]}: keine Beiträge`;
    saeule.innerHTML = `<div class="sm-chart-balken${liste.length === 0 ? " sm-chart-leer" : ""}" style="height:${
      max > 0 ? Math.max(4, (schnitt / max) * 90) : 4
    }%"></div><span>${WOCHENTAGE[i]}</span>`;
    chart.appendChild(saeule);
  });
  card.appendChild(chart);
  card.appendChild(el("p", "muted small", "Durchschnittliche Reichweite je Wochentag. Tage ohne Beitrag bleiben leer."));
  return card;
}

export { renderStatistik };
