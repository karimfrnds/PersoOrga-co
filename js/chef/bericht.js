// ============================================================================
// chef/bericht.js – der Wochenrückblick am Laptop.
//
// Die Regel, nach der das hier gebaut ist: ZAHLEN AUS DEM CODE, DEUTUNG VON DER KI. Die Tabellen oben
// rechnet der Worker aus den erfassten Tagen. Der Text darunter ist Claudes Lesart davon – deutlich
// als solche gekennzeichnet, damit niemand eine Formulierung für eine Messung hält.
//
// Fällt die KI aus, stehen die Zahlen trotzdem da. Sie sind der wertvolle Teil; der Text ist die
// Abkürzung zum Hinsehen.
// ============================================================================
import { escapeHtml, euro, dateDe } from "../format.js";
import { berichtLaden } from "./api.js";

const zahl = (n) => (n === null || n === undefined ? "–" : Number.isInteger(n) ? String(n) : String(n).replace(".", ","));
const prozent = (n) => (n === null || n === undefined ? "–" : `${String(n).replace(".", ",")} %`);

/** Veränderung gegenüber der Vorwoche, als Text mit Vorzeichen. Ohne Vergleichswoche: nichts. */
function delta(jetzt, davor, formatieren = euro) {
  if (!davor || davor === 0) return "";
  const diff = jetzt - davor;
  const p = Math.round((diff / Math.abs(davor)) * 100);
  if (p === 0) return `<span class="muted small">unverändert</span>`;
  return `<span class="muted small">${p > 0 ? "+" : ""}${p} % (${diff > 0 ? "+" : ""}${formatieren(diff)})</span>`;
}

function renderBericht(state) {
  const el = document.createElement("div");
  el.innerHTML = `<h1>🧠 Wochenrückblick</h1>`;
  const inhalt = document.createElement("div");
  el.appendChild(inhalt);

  let laeuft = false;
  async function laden(neu = false) {
    if (laeuft) return;
    laeuft = true;
    inhalt.innerHTML = `<p class="muted">${neu ? "Rechne neu und lasse deuten – das dauert einen Moment…" : "Lade…"}</p>`;
    try {
      const bericht = await berichtLaden(neu);
      inhalt.innerHTML = "";
      inhalt.appendChild(buildBericht(bericht, laden));
    } catch (e) {
      inhalt.innerHTML = "";
      const box = document.createElement("div");
      box.className = "callout callout-warn";
      box.textContent = "⚠ " + e.message;
      inhalt.appendChild(box);
      const nochmal = document.createElement("button");
      nochmal.className = "btn btn-secondary";
      nochmal.textContent = "Nochmal versuchen";
      nochmal.onclick = () => laden();
      inhalt.appendChild(nochmal);
    }
    laeuft = false;
  }
  laden();
  return el;
}

function buildBericht(bericht, laden) {
  const frag = document.createElement("div");
  const z = bericht?.zahlen;
  if (!z) {
    frag.innerHTML = `<div class="callout">Noch keine Zahlen – sobald ein paar Tage abgeschlossen sind, steht hier etwas.</div>`;
    return frag;
  }

  const kopf = document.createElement("p");
  kopf.className = "muted small";
  kopf.innerHTML = `${escapeHtml(dateDe(z.von))} bis ${escapeHtml(dateDe(z.bis))} · ${z.woche.tage} ${
    z.woche.tage === 1 ? "erfasster Tag" : "erfasste Tage"
  }${bericht.erstelltAm ? ` · gerechnet ${escapeHtml(new Date(bericht.erstelltAm).toLocaleString("de-DE"))}` : ""}`;
  frag.appendChild(kopf);

  if (z.woche.tage < 7) {
    const w = document.createElement("div");
    w.className = "callout callout-warn";
    w.textContent = `Nur ${z.woche.tage} von 7 Tagen sind erfasst – alles darunter ist entsprechend unvollständig.`;
    frag.appendChild(w);
  }

  // ---- Die Zahlen ----
  const zahlenKarte = document.createElement("section");
  zahlenKarte.className = "card";
  zahlenKarte.innerHTML = `<h2>Die Woche in Zahlen</h2><p class="muted small">Aus den abgeschlossenen Tagen gerechnet, verglichen mit den sieben Tagen davor.</p>`;
  const liste = document.createElement("div");
  liste.className = "mg-liste";
  const zeile = (label, wert, vergleich) => {
    const d = document.createElement("div");
    d.className = "summary-line";
    d.innerHTML = `<span>${label}</span><span>${wert} ${vergleich || ""}</span>`;
    liste.appendChild(d);
  };
  zeile("Umsatz", `<b>${euro(z.woche.umsatz)}</b>`, delta(z.woche.umsatz, z.davor.umsatz));
  zeile("Lohn", euro(z.woche.lohn), delta(z.woche.lohn, z.davor.lohn));
  zeile("Lohnquote", `<b>${prozent(z.woche.lohnquote)}</b>`, z.davor.lohnquote ? `<span class="muted small">davor ${prozent(z.davor.lohnquote)}</span>` : "");
  zeile("Stunden", `${zahl(z.woche.stunden)} h`, delta(z.woche.stunden, z.davor.stunden, (n) => `${zahl(Math.round(n * 10) / 10)} h`));
  if (z.woche.waren > 0) zeile("Wareneinsatz", euro(z.woche.waren), delta(z.woche.waren, z.davor.waren));
  zahlenKarte.appendChild(liste);
  frag.appendChild(zahlenKarte);

  // ---- Verkauf ----
  const namen = [...new Set([...Object.keys(z.verkaufWoche || {}), ...Object.keys(z.verkaufDavor || {})])];
  if (namen.length > 0) {
    const vk = document.createElement("section");
    vk.className = "card";
    vk.innerHTML = `<h2>Verkauf</h2>`;
    const scroll = document.createElement("div");
    scroll.style.overflowX = "auto";
    const t = document.createElement("table");
    t.className = "calc-table";
    t.innerHTML = `<thead><tr><th>Produkt</th><th>Verkauft</th><th>Woche davor</th><th>Übrig</th></tr></thead>`;
    const tb = document.createElement("tbody");
    for (const n of namen) {
      const a = z.verkaufWoche[n] || { verkauft: 0, uebrig: 0 };
      const b = z.verkaufDavor[n] || { verkauft: 0 };
      const tr = document.createElement("tr");
      tr.innerHTML = `<td><b>${escapeHtml(n)}</b></td><td>${a.verkauft}</td><td class="muted small">${b.verkauft}</td><td>${
        a.uebrig > 0 ? a.uebrig : "–"
      }</td>`;
      tb.appendChild(tr);
    }
    t.appendChild(tb);
    scroll.appendChild(t);
    vk.appendChild(scroll);
    frag.appendChild(vk);
  }

  // ---- Produktion ----
  const prod = z.produktion;
  if (prod && Array.isArray(prod.produkte) && prod.produkte.length > 0) {
    const pk = document.createElement("section");
    pk.className = "card";
    pk.innerHTML = `<h2>Produktion</h2>`;
    const scroll = document.createElement("div");
    scroll.style.overflowX = "auto";
    const t = document.createElement("table");
    t.className = "calc-table";
    t.innerHTML = `<thead><tr><th>Produkt</th><th>Da / Soll</th><th>Produziert</th><th>Ausschuss</th></tr></thead>`;
    const tb = document.createElement("tbody");
    for (const p of prod.produkte) {
      const tr = document.createElement("tr");
      tr.innerHTML =
        `<td><b>${escapeHtml(p.name)}</b></td>` +
        `<td class="${p.unterSoll ? "res-warn" : ""}">${zahl(p.da)} / ${zahl(p.soll)} ${escapeHtml(p.einheit || "")}</td>` +
        `<td>${zahl(p.produziert)}</td>` +
        `<td class="${p.ausschussProzent >= 10 ? "res-warn" : ""}">${p.ausschuss > 0 ? `${zahl(p.ausschuss)} (${p.ausschussProzent} %)` : "–"}</td>`;
      tb.appendChild(tr);
    }
    t.appendChild(tb);
    scroll.appendChild(t);
    pk.appendChild(scroll);
    frag.appendChild(pk);
  }

  // ---- Reichweite ----
  const verb = z.verbrauch?.artikel || [];
  const knapp = verb.filter((v) => v.reichweiteTage !== null && v.reichweiteTage <= 7);
  if (knapp.length > 0) {
    const rk = document.createElement("section");
    rk.className = "card";
    rk.innerHTML = `<h2>Geht bald aus</h2><p class="muted small">Aus den Zählungen gerechnet.</p>`;
    const l = document.createElement("div");
    l.className = "mg-liste";
    for (const v of knapp.sort((a, b) => a.reichweiteTage - b.reichweiteTage)) {
      const d = document.createElement("div");
      d.className = "summary-line";
      d.innerHTML = `<span>${escapeHtml(v.name)}</span><span class="${v.reichweiteTage <= 3 ? "res-warn" : ""}">${
        v.reichweiteTage === 0 ? "<b>heute leer</b>" : `noch ${v.reichweiteTage} ${v.reichweiteTage === 1 ? "Tag" : "Tage"}`
      }</span>`;
      l.appendChild(d);
    }
    rk.appendChild(l);
    frag.appendChild(rk);
  }

  // ---- Die Deutung ----
  const deutung = document.createElement("section");
  deutung.className = "card card-highlight";
  deutung.innerHTML = `<h2>Was auffällt</h2>`;
  if (bericht.text) {
    const p = document.createElement("div");
    // Der Text kommt vom Modell: als Klartext einsetzen, nie als HTML.
    p.style.whiteSpace = "pre-wrap";
    p.textContent = bericht.text;
    deutung.appendChild(p);
    const quelle = document.createElement("p");
    quelle.className = "muted small";
    quelle.textContent =
      "Das ist die Lesart der KI zu den Zahlen oben – kein zusätzliches Wissen und keine Beratung. Die Zahlen stehen oben und sind gerechnet, nicht geschätzt.";
    deutung.appendChild(quelle);
  } else {
    const p = document.createElement("p");
    p.className = "muted small";
    p.textContent =
      "Gerade keine Deutung verfügbar – entweder fehlt der ANTHROPIC_API_KEY im Worker, oder die Anfrage kam nicht durch. Die Zahlen oben stimmen trotzdem.";
    deutung.appendChild(p);
  }
  frag.appendChild(deutung);

  const neu = document.createElement("button");
  neu.className = "btn btn-secondary";
  neu.textContent = "Jetzt neu rechnen";
  neu.onclick = () => laden(true);
  frag.appendChild(neu);
  const hinweis = document.createElement("p");
  hinweis.className = "muted small";
  hinweis.textContent = "Der Bericht rechnet sich von selbst neu, wenn er älter als ein Tag ist.";
  frag.appendChild(hinweis);
  return frag;
}

export { renderBericht };
