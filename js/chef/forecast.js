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
    frag.appendChild(buildReichweite(state));
    frag.appendChild(buildReservierungen(state, heute));
    el.appendChild(frag);
    return el;
  }

  frag.appendChild(buildTrend(fertig, heute));
  frag.appendChild(buildWareneinsatz(fertig));
  frag.appendChild(buildRenner(state));
  frag.appendChild(buildReichweite(state));
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

/** Wareneinsatz und Prime Cost über die Zeit.
 *
 * Gerechnet wird ausschliesslich über Tage, an denen der Wareneinsatz auch erfasst ist. Ein Tag ohne
 * hochgeladenen Kassenbericht hätte 0 EUR Wareneinsatz und würde die Quote schöner aussehen lassen,
 * als sie ist – das wäre die gefährlichste Art von Fehler in dieser Ansicht.
 */
function buildWareneinsatz(fertig) {
  const card = document.createElement("section");
  card.className = "card";
  card.innerHTML = `<h2>Wareneinsatz & Prime Cost</h2>`;

  const mitWaren = fertig.filter((r) => Number(r.materialkosten) > 0);
  if (mitWaren.length === 0) {
    card.innerHTML += `<p class="muted small">Noch keine Daten. Der Wareneinsatz entsteht automatisch, sobald
      drei Dinge zusammenkommen: Kassenberichte sind hochgeladen, bei den Artikeln stehen Einkaufspreise,
      und die verkauften Produkte sind einem Rezept oder Artikel zugeordnet (Bestand → neue Produkte einordnen).</p>`;
    return card;
  }

  const rechne = (rows) => {
    const u = summe(rows, "umsatzGesamt");
    const w = summe(rows, "materialkosten");
    const l = round2(summe(rows, "totalLohn") + summe(rows, "totalLohnnebenkosten"));
    return { umsatz: u, ware: w, lohn: l, wareQuote: u > 0 ? (w / u) * 100 : 0,
             lohnQuote: u > 0 ? (l / u) * 100 : 0, prime: u > 0 ? ((w + l) / u) * 100 : 0 };
  };
  const gesamt = rechne(mitWaren);

  const table = document.createElement("table");
  table.className = "calc-table";
  table.innerHTML = `<thead><tr><th></th><th>Betrag</th><th>Anteil am Umsatz</th></tr></thead>`;
  const tb = document.createElement("tbody");
  const zeile = (label, betrag, anteil, fett) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${fett ? "<b>" + label + "</b>" : label}</td><td>${euro(betrag)}</td>
      <td>${fett ? "<b>" + prozent(anteil) + "</b>" : prozent(anteil)}</td>`;
    tb.appendChild(tr);
  };
  zeile("Wareneinsatz", gesamt.ware, gesamt.wareQuote);
  zeile("Personal", gesamt.lohn, gesamt.lohnQuote);
  zeile("Prime Cost", round2(gesamt.ware + gesamt.lohn), gesamt.prime, true);
  table.appendChild(tb);
  const scroll = document.createElement("div");
  scroll.style.overflowX = "auto";
  scroll.appendChild(table);
  card.appendChild(scroll);

  const einordnung = document.createElement("p");
  einordnung.className = gesamt.prime > 70 ? "callout callout-warn" : "callout";
  einordnung.innerHTML =
    `<b>Prime Cost sind Ware und Personal zusammen</b> – die beiden Blöcke, die sich täglich beeinflussen
     lassen. Miete, Energie und Versicherung stehen ohnehin fest. ` +
    (gesamt.prime > 70
      ? `Bei ${prozent(gesamt.prime)} bleibt davon wenig übrig.`
      : `Unter etwa 70 % gilt als gesund, ihr liegt bei ${prozent(gesamt.prime)}.`);
  card.appendChild(einordnung);

  // Entwicklung: letzte 4 Wochen gegen davor – nur wenn beide Zeiträume erfasste Tage haben.
  const heute = todayStr();
  const jetzt = mitWaren.filter((r) => r.date > addDaysISO(heute, -28));
  const davor = mitWaren.filter((r) => r.date > addDaysISO(heute, -56) && r.date <= addDaysISO(heute, -28));
  if (jetzt.length >= 3 && davor.length >= 3) {
    const a = rechne(jetzt);
    const b = rechne(davor);
    const diff = round2(a.wareQuote - b.wareQuote);
    const p = document.createElement("p");
    p.className = "muted small";
    // Beim Wareneinsatz ist WENIGER besser – wie bei der Lohnquote.
    p.innerHTML =
      `Wareneinsatzquote letzte 4 Wochen: <b>${prozent(a.wareQuote)}</b> (${jetzt.length} Tage), ` +
      `4 Wochen davor: ${prozent(b.wareQuote)} (${davor.length} Tage) – ` +
      `<b style="color:${diff <= 0 ? "var(--green)" : "var(--orange)"}">${diff > 0 ? "+" : ""}${String(diff).replace(".", ",")} Punkte</b>. ` +
      `Ein Rückgang ist günstig.`;
    card.appendChild(p);
  }

  const basis = document.createElement("p");
  basis.className = "muted small";
  basis.textContent =
    `Grundlage sind ${mitWaren.length} von ${fertig.length} abgeschlossenen Tagen – nur auf denen ist der ` +
    `Wareneinsatz erfasst. Tage ohne Kassenbericht sind bewusst ausgelassen, sonst sähen die Quoten zu gut aus.`;
  card.appendChild(basis);
  return card;
}

/** Was läuft und was nicht – aus den Kassenberichten. */
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
    table.innerHTML = `<thead><tr><th>Produkt</th><th>Verkauft</th><th>Umsatz</th><th>Materialkosten</th><th>Deckungsbeitrag</th></tr></thead>`;
    const tb = document.createElement("tbody");
    for (const p of liste) {
      const db = p.umsatz > 0 && p.materialkosten != null ? round2(p.umsatz - p.materialkosten) : null;
      const dbQuote = db !== null && p.umsatz > 0 ? round2((db / p.umsatz) * 100) : null;
      const tr = document.createElement("tr");
      tr.innerHTML = `<td>${escapeHtml(p.productName)}</td><td>${p.menge}×</td>
        <td>${p.umsatz > 0 ? euro(p.umsatz) : '<span class="muted">–</span>'}</td>
        <td>${p.materialkosten != null ? euro(p.materialkosten) : '<span class="muted">unbekannt</span>'}</td>
        <td>${db !== null ? `<b>${euro(db)}</b> <span class="muted small">(${prozent(dbQuote)})</span>` : '<span class="muted">–</span>'}</td>`;
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

  const ohneKosten = produkte.filter((p) => p.materialkosten == null).length;
  const info = document.createElement("p");
  info.className = "muted small";
  info.innerHTML =
    `Letzte 90 Tage. <b>Deckungsbeitrag</b> ist Umsatz minus Materialkosten – was ein Produkt wirklich
     einbringt, bevor Personal und Miete abgehen. ` +
    (ohneKosten > 0
      ? `Bei ${ohneKosten} von ${produkte.length} Produkten fehlen die Materialkosten – dort ist entweder
         kein Rezept hinterlegt oder einer Zutat fehlt der Einkaufspreis. Lieber keine Zahl als eine zu niedrige.`
      : `Für alle Produkte sind die Materialkosten bekannt.`);
  card.appendChild(info);
  return card;
}

/** Wie lange reicht der Bestand noch? Aus Verbrauch und aktuellem Stand. */
function buildReichweite(state) {
  const card = document.createElement("section");
  card.className = "card";
  card.innerHTML = `<h2>Reichweite & Bestellvorschlag</h2>`;

  const artikel = (state.stock || []).filter((s) => s.unit && s.verbrauch30 && s.verbrauch30.menge > 0);
  if (artikel.length === 0) {
    card.innerHTML += `<p class="muted small">Noch kein Verbrauch erfasst. Sobald Kassenberichte hochgeladen
      sind und die Produkte einem Rezept oder Artikel zugeordnet wurden, steht hier, wie lange der Bestand
      noch reicht.</p>`;
    return card;
  }

  const mitReichweite = artikel
    .map((s) => {
      // Nur Tage MIT Verbrauch zählen: bei zwei Ruhetagen pro Woche sähe der Tagesschnitt sonst
      // kleiner aus und die Reichweite länger, als sie ist.
      const proTag = s.verbrauch30.tage > 0 ? s.verbrauch30.menge / s.verbrauch30.tage : 0;
      const tage = proTag > 0 ? Math.floor((Number(s.currentAmount) || 0) / proTag) : null;
      return { ...s, proTag: round2(proTag), tage };
    })
    .filter((s) => s.tage !== null)
    .sort((a, b) => a.tage - b.tage);

  const scroll = document.createElement("div");
  scroll.style.overflowX = "auto";
  const table = document.createElement("table");
  table.className = "calc-table";
  table.innerHTML = `<thead><tr><th>Artikel</th><th>Bestand</th><th>Ø Verbrauch/Tag</th><th>Reicht noch</th><th>Bestellen</th></tr></thead>`;
  const tb = document.createElement("tbody");
  for (const s of mitReichweite.slice(0, 15)) {
    // Vorschlag: so viele Gebinde, dass es wieder zwei Wochen reicht.
    const bedarf = Math.max(0, s.proTag * 14 - (Number(s.currentAmount) || 0));
    const gebinde = s.packSize > 1 ? Math.ceil(bedarf / s.packSize) : Math.ceil(bedarf);
    const dringend = s.tage <= 3;
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${escapeHtml(s.name)} <span class="muted small">${s.bereich === "bar" ? "Bar" : "Küche"}</span></td>
      <td>${s.currentAmount} ${escapeHtml(s.unit)}</td>
      <td>${s.proTag} ${escapeHtml(s.unit)}</td>
      <td style="color:${dringend ? "var(--orange)" : "inherit"};font-weight:${dringend ? 600 : 400}">${
        s.tage === 0 ? "heute leer" : s.tage + " Tage"
      }</td>
      <td>${bedarf > 0 ? `${gebinde} ${escapeHtml(s.packSize > 1 ? s.packLabel || "Gebinde" : s.unit)}` : '<span class="muted">–</span>'}</td>`;
    tb.appendChild(tr);
  }
  table.appendChild(tb);
  scroll.appendChild(table);
  card.appendChild(scroll);

  const info = document.createElement("p");
  info.className = "muted small";
  info.textContent =
    "Verbrauch der letzten 30 Tage, gerechnet nur über Tage mit tatsächlichem Verbrauch – Ruhetage würden " +
    "den Schnitt sonst drücken und die Reichweite zu lang erscheinen lassen. Der Bestellvorschlag füllt auf " +
    "zwei Wochen auf. Das ist eine Fortschreibung, keine Vorhersage: eine Aktion oder ein Feiertag steht nicht drin.";
  card.appendChild(info);
  return card;
}

/** Was die Reservierungen über den Betrieb sagen. */
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
