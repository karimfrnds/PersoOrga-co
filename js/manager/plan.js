// ============================================================================
// manager/plan.js – Schichtplan fürs Handy.
//
// Am Laptop ist der Plan eine Tabelle: Schichten mal Wochentage. Auf dem Handy wäre das ein Rechteck, in dem
// man seitlich scrollt und nichts trifft. Hier deshalb ein Tag nach dem anderen: oben die sieben Tage mit
// "3/4 besetzt", darunter die Schichten des gewählten Tages als Karten. Wer sich gemeldet hat, steht als
// antippbarer Name direkt in der offenen Schicht – ein Tipp teilt ein.
//
// Es sind dieselben Wege wie am Laptop: Zusagen, Austragen, Plan abschließen. Solange die Woche nicht
// abgeschlossen ist, erfährt das Team nichts; danach geht jede Änderung sofort an die betroffene Person.
// ============================================================================
import { decideShift, publishWeek } from "./api.js";
import { el, text, knopf, feld, eingabe, blatt, toast, ausfuehren, addDays, mondayOf, datumKurz, WT, WT_LANG, gleicherName } from "./ui.js";

const ABWESENHEIT = {
  urlaub: { label: "Urlaub", symbol: "🏖" },
  krank: { label: "Krankheit", symbol: "🤒" },
  kind: { label: "Kind krank", symbol: "🧒" },
  sonstiges: { label: "Sonstiges", symbol: "📌" },
};

// Überlebt das Neuladen nach jeder Änderung – sonst spränge die Ansicht nach jedem Tipp zurück.
let woche = null;
let tagIndex = null;

// ---------------------------------------------------------------------
// Rechnen (auch von "Heute" benutzt)
// ---------------------------------------------------------------------
function rolleVon(daten, name) {
  return (daten.employeeRoles || []).find((r) => gleicherName(r.name, name))?.role || "service";
}
const istKueche = (daten, name) => rolleVon(daten, name) === "kueche";

function slotAmTag(slot, i) {
  const ov = slot?.weekdayOverrides?.[i];
  return ov ? { ...slot, ...ov } : slot;
}

function wocheEintraege(daten, weekStart) {
  const out = [];
  for (const [name, entry] of Object.entries((daten.availability || {})[weekStart]?.entries || {})) {
    for (const day of entry?.days || []) out.push({ name, ...day });
  }
  return out;
}

function abwesenheit(daten, name, date) {
  return (daten.absenceReports || []).find((r) => gleicherName(r.employeeName, name) && r.from <= date && (r.to || r.from) >= date) || null;
}

/** Alle Schichten eines Tages mit Belegung: [{kueche, slot, belegt, kandidaten}] */
function tagesSchichten(daten, weekStart, i) {
  if (!daten.shiftSlots) return [];
  const date = addDays(weekStart, i);
  const alle = wocheEintraege(daten, weekStart);
  const out = [];
  for (const [slots, kueche] of [
    [daten.shiftSlots.service || [], false],
    [daten.shiftSlots.kueche || [], true],
  ]) {
    for (const roh of slots) {
      if (roh.allowedWeekdays && !roh.allowedWeekdays.includes(i)) continue;
      const slot = slotAmTag(roh, i);
      const relevant = alle.filter((e) => e.date === date && istKueche(daten, e.name) === kueche && !abwesenheit(daten, e.name, date));
      out.push({
        kueche,
        slot,
        date,
        relevant,
        belegt: relevant.find((e) => e.confirmedSlotId === slot.id) || null,
        kandidaten: relevant.filter((e) => e.confirmedSlotId !== slot.id && !e.confirmedSlotId && (e.slots || []).some((s) => s.id === slot.id)),
      });
    }
  }
  return out;
}

function wochenStatus(daten, weekStart) {
  let besetzt = 0;
  let offen = 0;
  let wartet = 0;
  const eingeteilt = new Set();
  for (let i = 0; i < 7; i++) {
    for (const s of tagesSchichten(daten, weekStart, i)) {
      if (s.belegt && s.belegt.bossConfirmed) {
        besetzt++;
        eingeteilt.add(s.belegt.name);
      } else {
        offen++;
        if (s.belegt || s.kandidaten.length > 0) wartet++;
      }
    }
  }
  const beworben = Object.keys((daten.availability || {})[weekStart]?.entries || {});
  const leer = beworben.filter((n) => !eingeteilt.has(n));
  const freigabe = (daten.publishedWeeks || []).find((w) => w.weekStart === weekStart) || null;
  return { besetzt, offen, wartet, eingeteilt, leer, freigabe };
}

// ---------------------------------------------------------------------
// Ansicht
// ---------------------------------------------------------------------
function renderPlan(daten, { neuLaden }) {
  const heute = daten.heute;
  if (!woche) woche = addDays(mondayOf(heute), 7);
  if (tagIndex === null) tagIndex = 0;

  const wrap = el("div", "mg-plan");
  if (!daten.shiftSlots) {
    wrap.appendChild(text("div", "callout", "Die Schichtzeiten sind noch nicht da. Das iPad muss sich einmal abgleichen."));
    return wrap;
  }

  // --- Woche wählen ---
  const nav = el("div", "mg-woche");
  nav.appendChild(knopf("‹", "mg-icon-btn", () => wechsleWoche(-7)));
  const label = el("div", "mg-woche-label");
  const kw = woche === mondayOf(heute) ? "Diese Woche" : woche === addDays(mondayOf(heute), 7) ? "Nächste Woche" : "Woche";
  label.innerHTML = `<b>${kw}</b><span class="muted small">${datumKurz(woche)} – ${datumKurz(addDays(woche, 6))}</span>`;
  nav.appendChild(label);
  nav.appendChild(knopf("›", "mg-icon-btn", () => wechsleWoche(7)));
  wrap.appendChild(nav);

  function wechsleWoche(n) {
    woche = addDays(woche, n);
    tagIndex = woche === mondayOf(heute) ? (Date.parse(heute) - Date.parse(woche)) / 86400000 : 0;
    neuZeichnen();
  }
  function neuZeichnen() {
    const neu = renderPlan(daten, { neuLaden });
    wrap.replaceWith(neu);
  }

  // --- Stand der Woche + Abschließen ---
  const st = wochenStatus(daten, woche);
  const stand = el("section", "card mg-plan-stand");
  if (st.freigabe) {
    stand.appendChild(el("p", "mg-plan-stand-text", `✅ <b>Plan abgeschlossen.</b> Änderungen gehen ab jetzt sofort an die betroffene Person.`));
    stand.appendChild(
      knopf("🔓 Wieder öffnen", "btn btn-link", async (e) => {
        if (await ausfuehren(e.currentTarget, () => publishWeek(woche, "unpublish"), "Woche wieder geöffnet – Änderungen bleiben jetzt still.")) neuLaden();
      })
    );
  } else {
    stand.appendChild(
      el(
        "p",
        "mg-plan-stand-text",
        `<b>${st.besetzt} besetzt</b>${st.offen > 0 ? ` · <span class="res-warn">${st.offen} offen</span>` : ""} · Das Team weiß noch nichts von dieser Woche.`
      )
    );
    stand.appendChild(knopf("✅ Plan abschließen & Team informieren", "btn btn-primary", () => abschliessen(daten, woche, st, neuLaden)));
  }
  wrap.appendChild(stand);

  // --- Tage ---
  const tage = el("div", "mg-tage");
  for (let i = 0; i < 7; i++) {
    const date = addDays(woche, i);
    const schichten = tagesSchichten(daten, woche, i);
    const voll = schichten.filter((s) => s.belegt?.bossConfirmed).length;
    const b = knopf("", "mg-tag" + (i === tagIndex ? " an" : "") + (schichten.length > 0 && voll === schichten.length ? " voll" : "") + (date === heute ? " heute" : ""), () => {
      tagIndex = i;
      neuZeichnen();
    });
    b.innerHTML = `<span class="mg-tag-wt">${WT[i]}</span><span class="mg-tag-dat">${datumKurz(date)}</span><span class="mg-tag-zahl">${voll}/${schichten.length}</span>`;
    tage.appendChild(b);
  }
  wrap.appendChild(tage);

  // --- Schichten des Tages ---
  const date = addDays(woche, tagIndex);
  wrap.appendChild(text("h2", "mg-plan-tag", `${WT_LANG[tagIndex]}, ${datumKurz(date)}`));
  const schichten = tagesSchichten(daten, woche, tagIndex);
  for (const [kueche, titel] of [
    [false, "Service / Bar"],
    [true, "Küche"],
  ]) {
    const teil = schichten.filter((s) => s.kueche === kueche);
    if (teil.length === 0) continue;
    wrap.appendChild(text("p", "muted small res-bereich", titel));
    for (const s of teil) wrap.appendChild(schichtKarte(daten, s, neuLaden));
  }

  const abwesend = (daten.absenceReports || []).filter((r) => r.from <= date && (r.to || r.from) >= date);
  if (abwesend.length > 0) {
    const box = el("section", "card");
    box.appendChild(text("p", "muted small res-bereich", "Abwesend an diesem Tag"));
    for (const r of abwesend) {
      const a = ABWESENHEIT[r.art] || ABWESENHEIT.krank;
      box.appendChild(text("p", "small", `${a.symbol} ${r.employeeName} · ${a.label}${r.note ? " – " + r.note : ""}`));
    }
    wrap.appendChild(box);
  }
  wrap.appendChild(text("p", "muted small", "✅ fest eingeteilt · 🔶 wartet auf Bestätigung · Namen in einer offenen Schicht haben sich gemeldet – antippen teilt ein."));
  return wrap;
}

function schichtKarte(daten, s, neuLaden) {
  const { slot, belegt, kandidaten, date } = s;
  const karte = el("section", "card mg-schicht" + (belegt?.bossConfirmed ? " voll" : belegt ? " wartet" : " offen"));
  karte.appendChild(el("div", "mg-schicht-kopf", `<b>${slot.label}</b><span class="muted small">${slot.from}–${slot.to}</span>`));

  if (belegt) {
    const zeile = el("div", "mg-schicht-person");
    const name = knopf(`${belegt.bossConfirmed ? "✅" : "🔶"} ${belegt.name}${belegt.note ? " 📝" : ""}`, "mg-person-btn", () => waehlen(daten, s, neuLaden));
    zeile.appendChild(name);
    if (!belegt.bossConfirmed) {
      zeile.appendChild(
        knopf("✓ Bestätigen", "btn btn-primary mg-klein", async (e) => {
          if (await ausfuehren(e.currentTarget, () => decideShift(belegt.name, date, slot.label, "confirm", belegt.note || ""), `${belegt.name} bestätigt`)) neuLaden();
        })
      );
    }
    zeile.appendChild(
      knopf("✗", "mg-icon-btn mg-raus", async (e) => {
        if (await ausfuehren(e.currentTarget, () => decideShift(belegt.name, date, slot.label, "reject"), `${belegt.name} ausgetragen`)) neuLaden();
      })
    );
    zeile.lastChild.title = `${belegt.name} austragen`;
    karte.appendChild(zeile);
    if (belegt.note) karte.appendChild(text("p", "muted small", "📝 " + belegt.note));
    return karte;
  }

  const chips = el("div", "mg-chips");
  for (const k of kandidaten) {
    chips.appendChild(
      knopf(`＋ ${k.name}`, "mg-chip", async (e) => {
        if (await ausfuehren(e.currentTarget, () => decideShift(k.name, date, slot.label, "confirm"), `${k.name} eingeteilt`)) neuLaden();
      })
    );
  }
  chips.appendChild(knopf(kandidaten.length > 0 ? "Jemand anderes…" : "＋ Einteilen", "mg-chip mg-chip-leer", () => waehlen(daten, s, neuLaden)));
  karte.appendChild(chips);
  if (kandidaten.length === 0) karte.appendChild(text("p", "muted small", "Noch niemand gemeldet."));
  return karte;
}

/** Auswahl, wer die Schicht bekommt: Gemeldete oben, dann alle anderen aus dem passenden Bereich. */
function waehlen(daten, s, neuLaden) {
  const { slot, date, kueche, relevant, belegt } = s;
  const namen = [...(daten.employees || [])].filter((n) => istKueche(daten, n) === kueche).sort((a, b) => a.localeCompare(b));
  const gemeldet = new Set(relevant.filter((e) => (e.slots || []).some((x) => x.id === slot.id)).map((e) => e.name));

  blatt(`${slot.label} · ${datumKurz(date)}`, (box, schliessen) => {
    box.appendChild(text("p", "muted small", `${slot.from}–${slot.to} Uhr`));
    const notiz = eingabe("text", belegt?.note || "", "z.B. bitte Lieferung annehmen");
    notiz.maxLength = 200;

    const zeile = (name) => {
      const abw = abwesenheit(daten, name, date);
      const woanders = relevant.find((e) => gleicherName(e.name, name) && e.confirmedSlotId && e.confirmedSlotId !== slot.id);
      const hinweis = abw
        ? `${(ABWESENHEIT[abw.art] || ABWESENHEIT.krank).label} gemeldet`
        : woanders
          ? "schon in einer anderen Schicht"
          : gemeldet.has(name)
            ? "hat sich gemeldet"
            : "";
      const b = knopf("", "picker-row" + (belegt && gleicherName(belegt.name, name) ? " picker-current" : "") + (abw ? " picker-warn" : ""), async (e) => {
        if (await ausfuehren(e.currentTarget, () => decideShift(name, date, slot.label, "confirm", notiz.value.trim()), `${name} eingeteilt`)) {
          schliessen();
          neuLaden();
        }
      });
      b.innerHTML = `<span class="picker-name"></span>${hinweis ? `<span class="muted small"></span>` : ""}`;
      b.querySelector(".picker-name").textContent = name + (belegt && gleicherName(belegt.name, name) ? " ✓" : "");
      if (hinweis) b.querySelector(".muted").textContent = hinweis;
      return b;
    };

    const oben = namen.filter((n) => gemeldet.has(n));
    const rest = namen.filter((n) => !gemeldet.has(n));
    if (oben.length) {
      box.appendChild(text("p", "muted small res-bereich", "Hat sich gemeldet"));
      const l = el("div", "picker-list");
      oben.forEach((n) => l.appendChild(zeile(n)));
      box.appendChild(l);
    }
    if (rest.length) {
      box.appendChild(text("p", "muted small res-bereich", oben.length ? "Alle anderen" : kueche ? "Küche" : "Service / Bar"));
      const l = el("div", "picker-list");
      rest.forEach((n) => l.appendChild(zeile(n)));
      box.appendChild(l);
    }
    if (namen.length === 0) box.appendChild(text("p", "muted small", "Für diesen Bereich sind keine Mitarbeiter hinterlegt."));
    box.appendChild(feld("Info zur Schicht (optional)", notiz));
  });
}

/** Abschließen verschickt Nachrichten an echte Menschen – deshalb mit Blick darauf, wer was bekommt. */
function abschliessen(daten, weekStart, st, neuLaden) {
  blatt("Plan abschließen", (box, schliessen) => {
    box.appendChild(text("p", "muted small", `${datumKurz(weekStart)} – ${datumKurz(addDays(weekStart, 6))}`));
    box.appendChild(
      text(
        "div",
        st.offen > 0 ? "callout callout-warn" : "callout",
        st.offen > 0
          ? `${st.offen} ${st.offen === 1 ? "Schicht ist" : "Schichten sind"} noch nicht fest besetzt. Du kannst trotzdem abschließen – die Lücken bleiben sichtbar.`
          : "Alle Schichten sind besetzt."
      )
    );
    const namen = [...st.eingeteilt].sort((a, b) => a.localeCompare(b));
    box.appendChild(text("p", "small", `Bekommt eine Schicht (${namen.length}): ${namen.join(", ") || "niemand"}`));
    if (st.leer.length > 0) box.appendChild(text("p", "small", `Hat sich gemeldet, geht leer aus (${st.leer.length}): ${st.leer.join(", ")} – bekommt eine kurze Absage.`));
    const los = knopf("Abschließen & informieren", "btn btn-primary btn-huge", async (e) => {
      let res;
      const ok = await ausfuehren(e.currentTarget, async () => {
        res = await publishWeek(weekStart);
      });
      if (ok) {
        schliessen();
        toast(`✅ Plan abgeschlossen. ${res?.benachrichtigt ?? 0} informiert.`);
        neuLaden();
      }
    });
    box.appendChild(los);
  });
}

export { renderPlan, wochenStatus, tagesSchichten, rolleVon };
