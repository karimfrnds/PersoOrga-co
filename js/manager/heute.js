// ============================================================================
// manager/heute.js – Die Startseite: Was ist heute los?
//
// Nicht alles, sondern das, wofür man sie morgens öffnet – jeweils mit dem Weg dorthin:
//   Was für mich ansteht (eigene Aufgaben und die vom Chef)
//   Was fehlt (Bestand unter Soll, was die Küche meldet)
//   Was im Plan offen ist (diese und nächste Woche)
//   Wer gerade da ist, was im Laden heute offen ist
// ============================================================================
import { aufgabeAction } from "./api.js";
import { el, text, knopf, ausfuehren, addDays, mondayOf, WT_LANG, wtIndex, datumKurz, zahl } from "./ui.js";
import { aufgabeAm } from "./meins.js";
import { wochenStatus } from "./plan.js";
import { bestandStatus, bestandFehlt } from "./bestand.js";

function renderHeute(daten, { neuLaden, wechsle, rolle }) {
  const wrap = el("div");
  const heute = daten.heute;
  const stunde = new Date().getHours();
  const gruss = stunde < 11 ? "Guten Morgen" : stunde < 17 ? "Hallo" : "Guten Abend";
  wrap.appendChild(
    el("div", "mg-gruss", `<h1>${rolle === "boss" ? "Store-Management" : `${gruss}, <span></span>`}</h1><p class="muted">${WT_LANG[wtIndex(heute)]}, ${datumKurz(heute)}</p>`)
  );
  if (rolle !== "boss") wrap.querySelector(".mg-gruss span").textContent = daten.name;

  // --- Für mich ---
  const meine = (daten.aufgaben || []).filter((a) => {
    const s = aufgabeAm(a, heute);
    return s.gilt && !s.erledigt;
  });
  const vomChef = meine.filter((a) => a.von === "chef");
  const k1 = karte("📌", rolle === "boss" ? `Aufgaben für ${daten.name}` : "Für dich heute", () => wechsle("meins"));
  if (meine.length === 0) k1.appendChild(text("p", "muted small", "Nichts offen."));
  for (const a of [...vomChef, ...meine.filter((x) => x.von !== "chef")].slice(0, 6)) {
    const z = el("label", "mg-aufgabe" + (a.von === "chef" ? " vom-chef" : ""));
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.onchange = async () => {
      cb.disabled = true;
      if (await ausfuehren(null, () => aufgabeAction({ kind: "toggle", id: a.id, datum: heute }), "Erledigt")) neuLaden();
      else {
        cb.checked = false;
        cb.disabled = false;
      }
    };
    z.appendChild(cb);
    const t = el("span", "mg-aufgabe-text", `<span></span><span class="muted small"></span>`);
    t.firstChild.textContent = (a.prioritaet === "hoch" ? "🔴 " : "") + a.text;
    t.lastChild.textContent = [a.von === "chef" ? "vom Chef" : null, a.faellig && a.faellig < heute ? "überfällig" : null].filter(Boolean).join(" · ");
    z.appendChild(t);
    k1.appendChild(z);
  }
  if (meine.length > 6) k1.appendChild(text("p", "muted small", `… und ${meine.length - 6} weitere`));
  wrap.appendChild(k1);

  // --- Was fehlt ---
  const aktiv = (daten.bestand || []).filter((a) => a.aktiv !== false);
  const unter = aktiv.filter((a) => bestandFehlt(a) > 0);
  const leer = aktiv.filter((a) => bestandStatus(a) === "leer");
  const kueche = (daten.kuechenNotizen || []).filter((n) => !n.erledigtAm);
  const k2 = karte("📦", "Was fehlt", () => wechsle("bestand"));
  if (unter.length === 0 && kueche.length === 0) {
    k2.appendChild(text("p", "muted small", aktiv.length === 0 ? "Noch keine Artikel angelegt." : "Alles über Soll."));
  } else {
    if (unter.length > 0) {
      k2.appendChild(
        el("p", "mg-kennzahl", `<b>${unter.length}</b> unter Soll${leer.length ? ` · <span class="res-warn"><b>${leer.length}</b> leer</span>` : ""}`)
      );
      const namen = unter
        .sort((a, b) => bestandFehlt(b) / (b.soll || 1) - bestandFehlt(a) / (a.soll || 1))
        .slice(0, 5)
        .map((a) => `${a.name} (${zahl(a.menge)}/${zahl(a.soll)})`);
      k2.appendChild(text("p", "small", namen.join(" · ") + (unter.length > 5 ? " …" : "")));
    }
    for (const n of kueche.slice(0, 3)) k2.appendChild(text("p", "small", `🍳 ${n.text} – ${n.von || "?"}`));
  }
  for (const [b, label] of [["kueche", "Küche"], ["bar", "Bar"], ["divers", "Divers"]]) {
    const letzte = (daten.bestandAbschluesse || []).filter((x) => x.bereich === b).slice(-1)[0];
    if (letzte && letzte.date === heute) k2.appendChild(text("p", "muted small", `✓ ${label} heute gezählt von ${letzte.by || "?"}`));
  }
  wrap.appendChild(k2);

  // --- Schichtplan ---
  const k3 = karte("📅", "Schichtplan", () => wechsle("plan"));
  if (!daten.shiftSlots) {
    k3.appendChild(text("p", "muted small", "Die Schichtzeiten kommen mit dem nächsten iPad-Abgleich."));
  } else {
    for (const [ws, label] of [
      [mondayOf(heute), "Diese Woche"],
      [addDays(mondayOf(heute), 7), "Nächste Woche"],
    ]) {
      const st = wochenStatus(daten, ws);
      const teile = [`${st.besetzt} besetzt`];
      if (st.offen) teile.push(`<span class="res-warn">${st.offen} offen</span>`);
      if (st.wartet) teile.push(`${st.wartet} mit Meldungen`);
      teile.push(st.freigabe ? "✅ abgeschlossen" : "noch nicht abgeschlossen");
      k3.appendChild(el("p", "small", `<b>${label}:</b> ${teile.join(" · ")}`));
    }
  }
  const abwesend = (daten.absenceReports || []).filter((r) => r.from <= heute && (r.to || r.from) >= heute);
  if (abwesend.length) k3.appendChild(text("p", "muted small", `Heute abwesend: ${abwesend.map((r) => r.employeeName).join(", ")}`));
  wrap.appendChild(k3);

  // --- Im Laden ---
  const k4 = karte("👥", "Im Laden", () => wechsle("team"));
  const imDienst = daten.shiftsInService || [];
  k4.appendChild(
    text("p", "small", imDienst.length ? `Im Dienst: ${imDienst.map((s) => `${s.name} (seit ${s.since})`).join(", ")}` : "Gerade ist niemand eingestempelt.")
  );
  const aufgabenHeute = (daten.tasks || []).filter((t) => t.date === heute);
  const offen = aufgabenHeute.filter((t) => !t.done).length;
  if (aufgabenHeute.length) k4.appendChild(text("p", "small", `Aufgaben heute: ${aufgabenHeute.length - offen} von ${aufgabenHeute.length} erledigt`));
  k4.appendChild(knopf("Aufgaben ansehen", "btn btn-link", () => wechsle("aufgaben")));
  wrap.appendChild(k4);

  return wrap;
}

function karte(symbol, titel, oeffnen) {
  const k = el("section", "card mg-karte");
  const kopf = knopf("", "mg-karte-kopf", oeffnen);
  kopf.innerHTML = `<span>${symbol} <b></b></span><span class="mg-pfeil">›</span>`;
  kopf.querySelector("b").textContent = titel;
  k.appendChild(kopf);
  return k;
}

export { renderHeute };
