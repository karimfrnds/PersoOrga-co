// ============================================================================
// social/kalender.js – Der geteilte Kalender.
//
// Eine Monatsansicht, in der alles zusammenkommt, was an einem Tag passiert: Posts, Shootings, eigene
// Termine und die Café-Veranstaltungen (Bingo-Abende). Genau dafür ist ein geteilter Kalender da – man
// sieht, dass am Samstag ein Bingo-Abend ist und noch kein Post dazu geplant.
//
// Die Café-Termine kommen aus dem Café-Teil des Systems und sind hier nur zum Lesen. Sie abzutippen
// wäre die häufigste Fehlerquelle, und eine Veranstaltung, die niemand ankündigt, ist der häufigste
// Fehler überhaupt.
// ============================================================================
import { STATUS, WOCHENTAGE, MONATE, addDaysISO, weekdayIndex, escapeHtml, el, dateDeLang } from "./gemeinsam.js";

function tageDesMonats(jahr, monat) {
  return new Date(Date.UTC(jahr, monat + 1, 0)).getUTCDate();
}
const iso = (jahr, monat, tag) =>
  `${jahr}-${String(monat + 1).padStart(2, "0")}-${String(tag).padStart(2, "0")}`;

/**
 * @param daten   Der komplette Stand aus /social/overview
 * @param zustand { jahr, monat } – überlebt das Neuzeichnen, damit man nicht bei jedem Klick
 *                zurück in den aktuellen Monat springt
 */
function renderKalender(daten, zustand, { onMonat, onTag, onNeu }) {
  const wrap = el("div");
  const { jahr, monat } = zustand;

  // --- Kopf: Monat wechseln ---
  const kopf = el("div", "sm-kal-kopf");
  const zurueck = el("button", "btn btn-secondary", "←");
  zurueck.onclick = () => onMonat(monat === 0 ? { jahr: jahr - 1, monat: 11 } : { jahr, monat: monat - 1 });
  const vor = el("button", "btn btn-secondary", "→");
  vor.onclick = () => onMonat(monat === 11 ? { jahr: jahr + 1, monat: 0 } : { jahr, monat: monat + 1 });
  const heuteBtn = el("button", "btn btn-secondary", "Heute");
  heuteBtn.onclick = () => {
    const h = new Date(daten.heute + "T12:00:00");
    onMonat({ jahr: h.getFullYear(), monat: h.getMonth() });
  };
  const titel = el("h2", "sm-kal-titel", `${MONATE[monat]} ${jahr}`);
  kopf.append(heuteBtn, zurueck, vor, titel);

  const neu = el("button", "btn btn-primary", "＋ Eintrag");
  neu.onclick = () => onNeu(null);
  kopf.appendChild(neu);
  wrap.appendChild(kopf);

  // --- Einträge des Monats nach Tag sortieren ---
  const proTag = new Map();
  const merken = (datum, eintrag) => {
    if (!proTag.has(datum)) proTag.set(datum, []);
    proTag.get(datum).push(eintrag);
  };
  for (const p of daten.posts || []) {
    merken(p.datum, { art: "post", id: p.id, titel: p.titel, status: p.status, kanal: p.kanal, zeit: p.uhrzeit });
  }
  for (const sh of daten.shootings || []) {
    merken(sh.datum, { art: "shooting", id: sh.id, titel: sh.thema || "Shooting", zeit: sh.von, erledigt: sh.erledigt });
  }
  for (const t of daten.termine || []) {
    // Mehrtägige Termine erscheinen an jedem Tag – sonst übersieht man den zweiten Urlaubstag.
    let d = t.datum;
    for (let i = 0; i < 60 && d <= (t.bisDatum || t.datum); i++) {
      merken(d, { art: "termin", id: t.id, titel: t.titel });
      d = addDaysISO(d, 1);
    }
  }
  for (const c of daten.cafeTermine || []) {
    merken(c.datum, { art: "cafe", id: c.id, titel: c.titel });
  }

  // --- Raster ---
  const tabelle = el("div", "sm-kal");
  for (const w of WOCHENTAGE) tabelle.appendChild(el("div", "sm-kal-wochentag", w));

  const ersterTag = iso(jahr, monat, 1);
  const leerVorne = weekdayIndex(ersterTag);
  for (let i = 0; i < leerVorne; i++) tabelle.appendChild(el("div", "sm-kal-tag sm-kal-leer"));

  const anzahl = tageDesMonats(jahr, monat);
  for (let t = 1; t <= anzahl; t++) {
    const datum = iso(jahr, monat, t);
    const zelle = el("div", "sm-kal-tag" + (datum === daten.heute ? " sm-kal-heute" : ""));
    const kopfzeile = el("div", "sm-kal-tag-kopf");
    kopfzeile.appendChild(el("span", "sm-kal-nr", String(t)));
    const plus = el("button", "sm-kal-plus", "＋");
    plus.title = "Hier etwas eintragen";
    plus.onclick = (e) => {
      e.stopPropagation();
      onNeu(datum);
    };
    kopfzeile.appendChild(plus);
    zelle.appendChild(kopfzeile);

    for (const e of (proTag.get(datum) || []).sort((a, b) => (a.zeit || "99").localeCompare(b.zeit || "99"))) {
      const chip = el("button", "sm-chip sm-chip-" + e.art);
      if (e.art === "post") {
        chip.style.borderLeftColor = STATUS[e.status]?.farbe || "#999";
        chip.innerHTML = `<span class="sm-chip-zeit">${escapeHtml(e.zeit || "")}</span> ${escapeHtml(e.titel)}`;
        chip.title = `${e.kanal} · ${STATUS[e.status]?.label || e.status}`;
      } else if (e.art === "shooting") {
        chip.innerHTML = `📸 ${escapeHtml(e.titel)}`;
        if (e.erledigt) chip.classList.add("sm-chip-fertig");
      } else if (e.art === "cafe") {
        chip.innerHTML = `🎱 ${escapeHtml(e.titel)}`;
        chip.title = "Veranstaltung aus dem Café – hier nur zum Lesen";
      } else {
        chip.innerHTML = `📌 ${escapeHtml(e.titel)}`;
      }
      chip.onclick = () => onTag(e);
      zelle.appendChild(chip);
    }
    tabelle.appendChild(zelle);
  }
  wrap.appendChild(tabelle);

  // --- Was als Nächstes ansteht, unter dem Kalender ---
  wrap.appendChild(buildNaechstes(daten, proTag));
  return wrap;
}

/** Die nächsten sieben Tage als Liste. Der Monat zeigt die Lage, die Liste zeigt die Reihenfolge –
 * und am Handy ist ein Monatsraster ohnehin zu klein zum Arbeiten. */
function buildNaechstes(daten, proTag) {
  const card = el("section", "card");
  card.appendChild(el("h2", null, "Die nächsten Tage"));
  const liste = el("div", "task-list");
  let gefunden = 0;
  for (let i = 0; i < 14 && gefunden < 12; i++) {
    const datum = addDaysISO(daten.heute, i);
    const eintraege = proTag.get(datum) || [];
    if (eintraege.length === 0) continue;
    gefunden++;
    const kopf = el("p", "muted small res-bereich", `<b>${escapeHtml(i === 0 ? "Heute" : dateDeLang(datum))}</b>`);
    card.appendChild(kopf);
    for (const e of eintraege.sort((a, b) => (a.zeit || "99").localeCompare(b.zeit || "99"))) {
      const row = el("div", "task-row");
      const symbol = e.art === "post" ? "📝" : e.art === "shooting" ? "📸" : e.art === "cafe" ? "🎱" : "📌";
      const zusatz =
        e.art === "post"
          ? `${escapeHtml(e.kanal || "")}${e.zeit ? " · " + escapeHtml(e.zeit) + " Uhr" : ""} · ${escapeHtml(STATUS[e.status]?.label || "")}`
          : e.zeit
            ? escapeHtml(e.zeit) + " Uhr"
            : "";
      row.innerHTML = `<div class="task-row-text"><span>${symbol} <b>${escapeHtml(e.titel)}</b></span>
        <span class="muted small task-row-meta">${zusatz}</span></div>`;
      card.appendChild(row);
    }
  }
  if (gefunden === 0) {
    card.appendChild(el("p", "muted small", "In den nächsten zwei Wochen ist nichts eingetragen."));
  }
  return card;
}

export { renderKalender };
