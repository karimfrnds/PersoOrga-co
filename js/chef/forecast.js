// ============================================================================
// chef/forecast.js – Statistiken, Trends und Hochrechnung aus den eigenen Zahlen.
//
// Bewusst rein rechnerisch, ohne KI-Text: jede Zahl hier lässt sich nachvollziehen,
// und zu jedem Durchschnitt steht dabei, auf wie vielen Tagen er beruht. Bei dünner
// Datenlage wird das ausdrücklich gesagt, statt eine Genauigkeit vorzutäuschen.
//
// Wichtig: Nur ABGESCHLOSSENE Tage gehen in Durchschnitte und Trends ein. Ein noch
// offener Tag (z.B. heute) hat unvollständige Zahlen und würde jeden Schnitt nach
// unten ziehen.
// ============================================================================
import { euro, hours, escapeHtml, todayStr } from "../format.js";

const WEEKDAYS = ["Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag", "Sonntag"];
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const prozent = (n) => `${String(round2(n)).replace(".", ",")} %`;

function weekdayIndex(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return wd === 0 ? 6 : wd - 1; // 0 = Montag
}
function addDaysISO(dateStr, n) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}
const summe = (arr, key) => round2(arr.reduce((s, r) => s + (Number(r[key]) || 0), 0));
const mittel = (arr, key) => (arr.length === 0 ? 0 : round2(summe(arr, key) / arr.length));

function renderForecast(state) {
  const el = document.createElement("div");
  const heute = todayStr();
  // Nur abgeschlossene Tage – offene Tage sind unvollständig und würden alles verzerren.
  const fertig = (state.financials || []).filter((r) => r.status === "abgeschlossen").sort((a, b) => (a.date < b.date ? -1 : 1));

  const frag = document.createElement("div");
  frag.innerHTML = `
    <h1>📈 Auswertung & Hochrechnung</h1>
    <p class="muted">Alles auf Basis eurer abgeschlossenen Tage. Noch offene Tage sind bewusst nicht eingerechnet,
    weil ihre Zahlen unvollständig wären.</p>`;

  if (fertig.length < 7) {
    const c = document.createElement("section");
    c.className = "card";
    c.innerHTML = `<p class="muted">Für Umsatz-Auswertungen sind noch zu wenige abgeschlossene Tage da
    (${fertig.length}). Ab etwa einer vollen Woche lassen sich erste Muster zeigen.</p>`;
    frag.appendChild(c);
    // Bestand und Produkte hängen nicht an abgeschlossenen Tagen – die können schon jetzt helfen.
    frag.appendChild(buildRenner(state));
    frag.appendChild(buildReservierungen(state, heute));
    el.appendChild(frag);
    return el;
  }

  frag.appendChild(buildTrend(fertig, heute));
  frag.appendChild(buildRenner(state));
  frag.appendChild(buildReservierungen(state, heute));
  frag.appendChild(buildWochentage(fertig));
  frag.appendChild(buildHochrechnung(fertig, heute));
  frag.appendChild(buildPersonal(fertig));
  el.appendChild(frag);
  return el;
}

/** Letzte 4 Wochen gegen die 4 Wochen davor. Zeigt, wohin es sich bewegt. */
function buildTrend(fertig, heute) {
  const card = document.createElement("section");
  card.className = "card";
  card.innerHTML = `<h2>Entwicklung</h2>`;

  const grenze1 = addDaysISO(heute, -28);
  const grenze2 = addDaysISO(heute, -56);
  const jetzt = fertig.filter((r) => r.date > grenze1);
  const davor = fertig.filter((r) => r.date > grenze2 && r.date <= grenze1);

  if (jetzt.length === 0 || davor.length === 0) {
    card.innerHTML += `<p class="muted small">Für einen Vergleich braucht es zwei aufeinanderfolgende Vier-Wochen-Zeiträume
    mit abgeschlossenen Tagen. Aktuell: ${jetzt.length} Tage in den letzten 4 Wochen, ${davor.length} in den 4 Wochen davor.</p>`;
    return card;
  }

  // Pro Tag vergleichen, nicht als Summe – sonst verzerrt eine unterschiedliche Anzahl Tage das Bild.
  const zeilen = [
    ["Umsatz je Tag", mittel(jetzt, "umsatzGesamt"), mittel(davor, "umsatzGesamt"), euro],
    ["Lohnkosten je Tag", round2(mittel(jetzt, "totalLohn") + mittel(jetzt, "totalLohnnebenkosten")), round2(mittel(davor, "totalLohn") + mittel(davor, "totalLohnnebenkosten")), euro],
    ["Stunden je Tag", mittel(jetzt, "totalHours"), mittel(davor, "totalHours"), hours],
    ["Umschlag je Tag", mittel(jetzt, "umschlag"), mittel(davor, "umschlag"), euro],
  ];

  const table = document.createElement("table");
  table.className = "calc-table";
  table.innerHTML = `<thead><tr><th></th><th>Letzte 4 Wochen</th><th>4 Wochen davor</th><th>Veränderung</th></tr></thead>`;
  const tb = document.createElement("tbody");
  for (const [label, a, b, fmt] of zeilen) {
    const diff = b === 0 ? null : ((a - b) / Math.abs(b)) * 100;
    const pfeil = diff === null ? "" : diff > 1 ? "▲" : diff < -1 ? "▼" : "▬";
    const farbe = diff === null || Math.abs(diff) <= 1 ? "var(--gray)" : diff > 0 ? "var(--green)" : "var(--orange)";
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${label}</td><td>${fmt(a)}</td><td>${fmt(b)}</td>
      <td style="color:${farbe};font-weight:600">${diff === null ? "–" : `${pfeil} ${prozent(diff)}`}</td>`;
    tb.appendChild(tr);
  }

  // Lohnquote getrennt: das ist ein Verhältnis, kein Tagesmittel
  const quote = (rows) => {
    const u = summe(rows, "umsatzGesamt");
    return u > 0 ? ((summe(rows, "totalLohn") + summe(rows, "totalLohnnebenkosten")) / u) * 100 : 0;
  };
  const qJetzt = quote(jetzt);
  const qDavor = quote(davor);
  const qDiff = qJetzt - qDavor;
  const trQ = document.createElement("tr");
  // Bei der Lohnquote ist WENIGER besser – Farblogik hier bewusst andersherum als oben.
  const qFarbe = Math.abs(qDiff) <= 0.5 ? "var(--gray)" : qDiff < 0 ? "var(--green)" : "var(--orange)";
  trQ.innerHTML = `<td>Lohnquote (Anteil am Umsatz)</td><td>${prozent(qJetzt)}</td><td>${prozent(qDavor)}</td>
    <td style="color:${qFarbe};font-weight:600">${qDiff > 0 ? "+" : ""}${prozent(qDiff).replace(" %", "")} Punkte</td>`;
  tb.appendChild(trQ);
  table.appendChild(tb);

  const scroll = document.createElement("div");
  scroll.style.overflowX = "auto";
  scroll.appendChild(table);
  card.appendChild(scroll);

  const info = document.createElement("p");
  info.className = "muted small";
  info.textContent = `Verglichen werden Tagesdurchschnitte: ${jetzt.length} Tage gegen ${davor.length} Tage. Bei der Lohnquote ist ein Rückgang günstig.`;
  card.appendChild(info);
  return card;
}

/** Was am besten und am wenigsten laeuft.
 *
 * Frueher stand hier auch ein Deckungsbeitrag je Produkt. Der kam aus Rezept mal Einkaufspreis – eine
 * Rechnung, die nur stimmte, solange jedes Rezept und jeder Preis gepflegt war. Sie ist mit der
 * Mengenfuehrung weggefallen. Was bleibt, ist der Umsatz je Produkt, und der steht direkt im
 * Kassenbericht: dafuer muss niemand etwas pflegen.
 */
function buildRenner(state) {
  const card = document.createElement("section");
  card.className = "card";
  card.innerHTML = `<h2>Renner & Penner</h2>`;
  const produkte = [...(state.produktStatistik || [])];
  if (produkte.length === 0) {
    card.innerHTML += `<p class="muted small">Noch keine Verkaufsdaten. Sie entstehen, sobald ein
      SumUp-Kassenbericht hochgeladen wurde.</p>`;
    return card;
  }

  const nachMenge = [...produkte].sort((a, b) => b.menge - a.menge);
  const oben = nachMenge.slice(0, 8);
  const unten = nachMenge.slice(-5).reverse().filter((p) => !oben.includes(p));

  const tabelle = (liste, titel) => {
    const t = document.createElement("div");
    const h = document.createElement("p");
    h.className = "muted small res-bereich";
    h.innerHTML = `<b>${titel}</b>`;
    t.appendChild(h);
    const table = document.createElement("table");
    table.className = "calc-table";
    table.innerHTML = `<thead><tr><th>Produkt</th><th>Verkauft</th><th>Umsatz</th><th>Ø je Tag</th></tr></thead>`;
    const tb = document.createElement("tbody");
    for (const p of liste) {
      const proTag = p.tage > 0 ? Math.round((p.menge / p.tage) * 10) / 10 : null;
      const tr = document.createElement("tr");
      tr.innerHTML = `<td>${escapeHtml(p.productName)}</td><td>${p.menge}×</td>
        <td>${p.umsatz > 0 ? euro(p.umsatz) : '<span class="muted">–</span>'}</td>
        <td>${proTag !== null ? String(proTag).replace(".", ",") + "×" : '<span class="muted">–</span>'}</td>`;
      tb.appendChild(tr);
    }
    table.appendChild(tb);
    const scroll = document.createElement("div");
    scroll.style.overflowX = "auto";
    scroll.appendChild(table);
    t.appendChild(scroll);
    return t;
  };

  card.appendChild(tabelle(oben, "Läuft am besten"));
  if (unten.length > 0) card.appendChild(tabelle(unten, "Läuft am wenigsten"));

  const info = document.createElement("p");
  info.className = "muted small";
  info.textContent =
    "Letzte 90 Tage. „Ø je Tag\u201c zählt nur die Tage, an denen das Produkt überhaupt verkauft wurde – " +
    "so drückt ein Ruhetag den Schnitt nicht.";
  card.appendChild(info);
  return card;
}

/** Wie lange reicht der Bestand noch? Aus Verbrauch und aktuellem Stand. */
function buildReservierungen(state, heute) {
  const card = document.createElement("section");
  card.className = "card";
  card.innerHTML = `<h2>Reservierungen</h2>`;
  const stats = (state.reservationStats || []).filter((s) => s.date <= heute);
  if (stats.length === 0) {
    card.innerHTML += `<p class="muted small">Noch keine Daten. Sie entstehen mit jeder Reservierung und
      jedem Walk-in, den ihr am iPad erfasst.</p>`;
    return card;
  }

  const s = (key) => stats.reduce((sum, d) => sum + (Number(d[key]) || 0), 0);
  const reserviert = s("anzahl");
  const gaeste = s("gaeste");
  const walkins = s("walkins");
  const walkinGaeste = s("walkinGaeste");
  const storniert = s("storniert");
  const erschienen = s("erschienen");
  // No-Show: nicht erschienen, obwohl nicht abgesagt. Nur über Tage, die vorbei sind – bei heutigen
  // Reservierungen steht das Ergebnis noch aus.
  const vergangen = stats.filter((d) => d.date < heute);
  const vAnzahl = vergangen.reduce((sum, d) => sum + d.anzahl - d.storniert, 0);
  const vErschienen = vergangen.reduce((sum, d) => sum + d.erschienen, 0);
  const noShow = vAnzahl > 0 ? round2(((vAnzahl - vErschienen) / vAnzahl) * 100) : null;
  const anteilReserviert = gaeste + walkinGaeste > 0 ? round2((gaeste / (gaeste + walkinGaeste)) * 100) : 0;

  const zeile = document.createElement("div");
  zeile.className = "res-stats";
  zeile.innerHTML = `
    <div><span class="res-stat-zahl">${reserviert}</span><span class="muted small">Reservierungen</span></div>
    <div><span class="res-stat-zahl">${gaeste}</span><span class="muted small">Gäste reserviert</span></div>
    <div><span class="res-stat-zahl">${walkinGaeste}</span><span class="muted small">Gäste spontan</span></div>
    <div><span class="res-stat-zahl">${storniert}</span><span class="muted small">abgesagt</span></div>`;
  card.appendChild(zeile);

  const box = document.createElement("p");
  box.className = "callout";
  box.innerHTML =
    `<b>${prozent(anteilReserviert)} eurer Gäste kommen mit Reservierung</b>, der Rest spontan. ` +
    (noShow === null
      ? "Für eine No-Show-Quote sind noch keine vergangenen Tage erfasst."
      : noShow > 10
      ? `<b>No-Show-Quote: ${prozent(noShow)}</b> – das ist hoch. Jede nicht erschienene Reservierung ist ein Tisch, der leer blieb, obwohl ihr ihn hättet vergeben können.`
      : `No-Show-Quote: <b>${prozent(noShow)}</b>.`);
  card.appendChild(box);

  if (noShow !== null) {
    const hinweis = document.createElement("p");
    hinweis.className = "muted small";
    hinweis.textContent =
      `Als No-Show zählt, was weder abgesagt noch als angekommen markiert wurde – über ${vergangen.length} ` +
      `vergangene Tage. Wird im Betrieb nicht konsequent auf „Ist da" getippt, sieht die Quote schlechter aus, ` +
      `als sie ist. Das ist die einzige Zahl hier, die von eurer Disziplin am iPad abhängt.`;
    card.appendChild(hinweis);
  }
  return card;
}

/** Welcher Wochentag trägt wie viel? Mit Angabe, auf wie vielen Tagen der Schnitt beruht. */
function buildWochentage(fertig) {
  const card = document.createElement("section");
  card.className = "card";
  card.innerHTML = `<h2>Nach Wochentag</h2>`;

  const proTag = WEEKDAYS.map(() => []);
  for (const r of fertig) proTag[weekdayIndex(r.date)].push(r);

  const table = document.createElement("table");
  table.className = "calc-table";
  table.innerHTML = `<thead><tr><th>Tag</th><th>Ø Umsatz</th><th>Ø Stunden</th><th>Ø Umsatz je Stunde</th><th>Tage</th></tr></thead>`;
  const tb = document.createElement("tbody");
  const schnitte = proTag.map((rows) => mittel(rows, "umsatzGesamt"));
  const bester = Math.max(...schnitte);
  let duenn = false;

  proTag.forEach((rows, i) => {
    const tr = document.createElement("tr");
    if (rows.length === 0) {
      tr.innerHTML = `<td>${WEEKDAYS[i]}</td><td colspan="4" class="muted">keine abgeschlossenen Tage</td>`;
      tb.appendChild(tr);
      return;
    }
    if (rows.length < 3) duenn = true;
    const ums = mittel(rows, "umsatzGesamt");
    const std = mittel(rows, "totalHours");
    const proStunde = std > 0 ? round2(ums / std) : 0;
    const istBester = ums === bester && bester > 0;
    tr.innerHTML = `
      <td>${WEEKDAYS[i]}${istBester ? " ⭐" : ""}</td>
      <td>${euro(ums)}</td>
      <td>${hours(std)}</td>
      <td>${euro(proStunde)}</td>
      <td class="muted">${rows.length}${rows.length < 3 ? " ⚠" : ""}</td>`;
    tb.appendChild(tr);
  });
  table.appendChild(tb);
  const scroll = document.createElement("div");
  scroll.style.overflowX = "auto";
  scroll.appendChild(table);
  card.appendChild(scroll);

  const info = document.createElement("p");
  info.className = "muted small";
  info.innerHTML = `⭐ = umsatzstärkster Wochentag. „Umsatz je Stunde" setzt den Umsatz ins Verhältnis zu den bezahlten Stunden.${
    duenn ? ` <b>⚠ Bei mit ⚠ markierten Tagen liegen weniger als 3 abgeschlossene Tage vor – diese Durchschnitte sind noch wenig aussagekräftig.</b>` : ""
  }`;
  card.appendChild(info);
  return card;
}

/** Hochrechnung auf das Monatsende: Ist-Zahlen plus Wochentags-Schnitt für die Resttage. */
function buildHochrechnung(fertig, heute) {
  const card = document.createElement("section");
  card.className = "card";
  card.innerHTML = `<h2>Hochrechnung laufender Monat</h2>`;

  const monatsStart = heute.slice(0, 7) + "-01";
  const [jahr, monat] = heute.split("-").map(Number);
  const letzterTag = new Date(Date.UTC(jahr, monat, 0)).getUTCDate();
  const monatsEnde = `${heute.slice(0, 7)}-${String(letzterTag).padStart(2, "0")}`;

  const bisher = fertig.filter((r) => r.date >= monatsStart && r.date <= heute);
  // Wochentags-Schnitt aus den letzten 8 Wochen – aktueller als die ganze Historie, aber breit genug.
  const basis = fertig.filter((r) => r.date > addDaysISO(heute, -56));
  const schnittProTag = WEEKDAYS.map((_, i) => {
    const rows = basis.filter((r) => weekdayIndex(r.date) === i);
    return { umsatz: mittel(rows, "umsatzGesamt"), lohn: round2(mittel(rows, "totalLohn") + mittel(rows, "totalLohnnebenkosten")), anzahl: rows.length };
  });

  // Resttage: alles ab heute bis Monatsende, was noch nicht abgeschlossen ist.
  // Heute gehört ausdrücklich dazu – der Tag läuft ja noch. Würde man erst ab morgen
  // rechnen, fehlte der heutige Tag in der Monatssumme komplett (bei einem Samstag
  // schnell ein paar hundert Euro).
  const abgeschlosseneTage = new Set(bisher.map((r) => r.date));
  let restUmsatz = 0;
  let restLohn = 0;
  let restTage = 0;
  let ohneBasis = 0;
  for (let d = heute; d <= monatsEnde; d = addDaysISO(d, 1)) {
    if (abgeschlosseneTage.has(d)) continue;
    const s = schnittProTag[weekdayIndex(d)];
    restTage++;
    if (s.anzahl === 0) ohneBasis++;
    restUmsatz += s.umsatz;
    restLohn += s.lohn;
  }

  const istUmsatz = summe(bisher, "umsatzGesamt");
  const istLohn = round2(summe(bisher, "totalLohn") + summe(bisher, "totalLohnnebenkosten"));
  const erwartetUmsatz = round2(istUmsatz + restUmsatz);
  const erwartetLohn = round2(istLohn + restLohn);
  const erwarteteQuote = erwartetUmsatz > 0 ? (erwartetLohn / erwartetUmsatz) * 100 : 0;

  card.innerHTML += `
    <div class="summary-line"><span>Bisher abgeschlossen (${bisher.length} Tage)</span><span>${euro(istUmsatz)} Umsatz · ${euro(istLohn)} Lohnkosten</span></div>
    <div class="summary-line"><span>Erwartet für die restlichen ${restTage} Tage${abgeschlosseneTage.has(heute) ? "" : " (inkl. heute)"}</span><span>${euro(round2(restUmsatz))} · ${euro(round2(restLohn))}</span></div>
    <div class="summary-line"><span><b>Hochrechnung Monatsende</b></span><span><b>${euro(erwartetUmsatz)} Umsatz · ${euro(erwartetLohn)} Lohnkosten</b></span></div>
    <div class="summary-line"><span>Erwartete Lohnquote</span><span>${prozent(erwarteteQuote)}</span></div>`;

  const hinweis = document.createElement("p");
  hinweis.className = "callout";
  hinweis.innerHTML =
    `<b>So kommt die Zahl zustande:</b> Für jeden noch nicht abgeschlossenen Tag – auch für heute – wird der
     Durchschnitt des gleichen Wochentags aus den letzten 8 Wochen angesetzt. Der heutige Tag läuft noch, deshalb
     zählt hier der Wochentags-Schnitt und nicht das, was bis jetzt in der Kasse ist.
     Das ist eine Fortschreibung des Bisherigen – <b>keine Vorhersage</b>.
     Feiertage, Wetter, Ferien oder Aktionen sind darin nicht enthalten.` +
    (ohneBasis > 0
      ? ` <br/><b>⚠ Für ${ohneBasis} der ${restTage} Resttage gibt es keinen Vergleichswert</b> (dieser Wochentag kam in den letzten 8 Wochen nicht abgeschlossen vor) – diese Tage sind mit 0 angesetzt, die Hochrechnung fällt dadurch zu niedrig aus.`
      : "");
  card.appendChild(hinweis);
  return card;
}

/** Wer trägt wie viel bei – und was kostet die Stunde im Schnitt. */
function buildPersonal(fertig) {
  const card = document.createElement("section");
  card.className = "card";
  card.innerHTML = `<h2>Personal (letzte 8 Wochen)</h2>`;
  const basis = fertig.filter((r) => r.date > addDaysISO(todayStr(), -56));

  const proPerson = new Map();
  for (const r of basis) {
    for (const pe of r.perEmployee || []) {
      if (!proPerson.has(pe.name)) proPerson.set(pe.name, { stunden: 0, kosten: 0, tage: 0 });
      const p = proPerson.get(pe.name);
      p.stunden += Number(pe.hours) || 0;
      p.kosten += (Number(pe.lohn) || 0) + (Number(pe.lohnnebenkosten) || 0);
      p.tage++;
    }
  }
  if (proPerson.size === 0) {
    card.innerHTML += `<p class="muted small">Keine Arbeitszeiten in diesem Zeitraum.</p>`;
    return card;
  }

  const gesamtStunden = [...proPerson.values()].reduce((s, p) => s + p.stunden, 0);
  const table = document.createElement("table");
  table.className = "calc-table";
  table.innerHTML = `<thead><tr><th>Mitarbeiter</th><th>Tage</th><th>Stunden</th><th>Anteil</th><th>Ø Kosten je Stunde</th></tr></thead>`;
  const tb = document.createElement("tbody");
  for (const [name, p] of [...proPerson.entries()].sort((a, b) => b[1].stunden - a[1].stunden)) {
    const anteil = gesamtStunden > 0 ? (p.stunden / gesamtStunden) * 100 : 0;
    const proStunde = p.stunden > 0 ? round2(p.kosten / p.stunden) : 0;
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${escapeHtml(name)}</td><td>${p.tage}</td><td>${hours(round2(p.stunden))}</td>
      <td>${prozent(anteil)}</td><td>${euro(proStunde)}</td>`;
    tb.appendChild(tr);
  }
  table.appendChild(tb);
  const scroll = document.createElement("div");
  scroll.style.overflowX = "auto";
  scroll.appendChild(table);
  card.appendChild(scroll);

  const info = document.createElement("p");
  info.className = "muted small";
  info.textContent = `„Kosten je Stunde" enthält den Arbeitgeberanteil (Lohnnebenkosten), ist also mehr als der Stundenlohn.`;
  card.appendChild(info);
  return card;
}

export { renderForecast };
