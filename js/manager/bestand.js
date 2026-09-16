// ============================================================================
// manager/bestand.js – Bestand und Bestellung.
//
// Die Frage beim Bestellen ist nicht "wie viel ist da?", sondern "wie viel muss ich holen?". Deshalb steht
// oben die Bestellliste – alles unter Soll, mit der fehlenden Menge –, fertig zum Kopieren oder Teilen
// (z.B. per WhatsApp an den Lieferanten). Darunter, was die Küche gemeldet hat ("Gurken fehlen"), und dann
// die ganzen Listen zum Nachsehen und Pflegen.
// ============================================================================
import { bestandAction } from "./api.js";
import { el, text, knopf, feld, eingabe, auswahl, haken, blatt, toast, ausfuehren, wann, zahl, datumKurz } from "./ui.js";

const BEREICHE = [
  { id: "kueche", label: "Küche", symbol: "🍳" },
  { id: "bar", label: "Bar", symbol: "🍸" },
];
const EINHEITEN = ["Stück", "Flaschen", "Packungen", "Kisten", "Liter", "kg", "g", "Behälter", "Schale", "Blech", "Beutel", "Portionen"];

let nurFehlend = false;

function status(a) {
  if (a.menge === null || a.menge === undefined) return "unbekannt";
  if (a.menge <= 0) return "leer";
  if (a.soll > 0 && a.menge < a.soll) return "knapp";
  return "ok";
}
const fehlt = (a) => (a.menge !== null && a.menge !== undefined && a.soll > a.menge ? Math.round((a.soll - a.menge) * 100) / 100 : 0);

function renderBestand(daten, { neuLaden }) {
  const wrap = el("div");
  const aktiv = (daten.bestand || []).filter((a) => a.aktiv !== false);

  // --- Bestellliste ---
  const karte = el("section", "card mg-bestellung");
  karte.appendChild(text("h2", null, "🛒 Zu bestellen"));
  const unter = aktiv.filter((a) => fehlt(a) > 0);
  const nieGezaehlt = aktiv.filter((a) => status(a) === "unbekannt");
  if (unter.length === 0) {
    karte.appendChild(text("p", "muted", aktiv.length === 0 ? "Noch keine Artikel angelegt." : "Alles über Soll – nichts zu bestellen."));
  } else {
    for (const b of BEREICHE) {
      const teil = unter.filter((a) => a.bereich === b.id).sort((x, y) => fehlt(y) / (y.soll || 1) - fehlt(x) / (x.soll || 1));
      if (teil.length === 0) continue;
      karte.appendChild(text("p", "muted small res-bereich", `${b.symbol} ${b.label}`));
      const liste = el("div", "mg-liste");
      for (const a of teil) {
        const z = el("div", "mg-bestell-zeile" + (status(a) === "leer" ? " leer" : ""));
        z.appendChild(el("span", "mg-bestell-name", ""));
        z.lastChild.textContent = a.name;
        z.appendChild(el("span", "mg-bestell-menge", `<b>${zahl(fehlt(a))}</b> ${a.einheit || ""}`));
        z.appendChild(text("span", "muted small mg-bestell-stand", `${zahl(a.menge)}/${zahl(a.soll)}`));
        liste.appendChild(z);
      }
      karte.appendChild(liste);
    }
    const akt = el("div", "employee-actions");
    const textListe = () => bestelltext(daten, unter);
    akt.appendChild(
      knopf("📋 Kopieren", "btn btn-secondary", async () => {
        try {
          await navigator.clipboard.writeText(textListe());
          toast("Bestellliste kopiert");
        } catch {
          zeigeText(textListe());
        }
      })
    );
    if (navigator.share) {
      akt.appendChild(
        knopf("↗ Teilen", "btn btn-primary", async () => {
          try {
            await navigator.share({ title: "Bestellung", text: textListe() });
          } catch {}
        })
      );
    }
    karte.appendChild(akt);
  }
  if (nieGezaehlt.length > 0) {
    karte.appendChild(text("p", "muted small", `Noch nie gezählt, deshalb nicht in der Liste: ${nieGezaehlt.map((a) => a.name).join(", ")}`));
  }
  wrap.appendChild(karte);

  // --- Was die Küche meldet ---
  const offen = (daten.kuechenNotizen || []).filter((n) => !n.erledigtAm);
  if (offen.length > 0) {
    const k = el("section", "card");
    k.appendChild(text("h2", null, "🍳 Küche meldet"));
    const l = el("div", "mg-liste");
    for (const n of offen) {
      const z = el("div", "mg-zeile");
      z.appendChild(text("span", null, n.text));
      z.appendChild(text("span", "muted small", `für ${n.fuer === daten.heute ? "heute" : datumKurz(n.fuer)} · ${n.von || "?"}`));
      l.appendChild(z);
    }
    k.appendChild(l);
    wrap.appendChild(k);
  }

  // --- Listen ---
  const filter = haken("Nur was fehlt", nurFehlend);
  filter.cb.onchange = () => {
    nurFehlend = filter.cb.checked;
    wrap.replaceWith(renderBestand(daten, { neuLaden }));
  };
  wrap.appendChild(filter.zeile);

  for (const b of BEREICHE) {
    const alle = (daten.bestand || [])
      .filter((a) => a.bereich === b.id)
      .sort((x, y) => (Number(x.sort) || 0) - (Number(y.sort) || 0) || String(x.name).localeCompare(String(y.name)));
    const zeigen = nurFehlend ? alle.filter((a) => a.aktiv !== false && ["leer", "knapp"].includes(status(a))) : alle;
    const letzte = (daten.bestandAbschluesse || []).filter((x) => x.bereich === b.id).slice(-1)[0];

    const card = el("section", "card");
    card.appendChild(text("h2", null, `${b.symbol} ${b.label}`));
    card.appendChild(text("p", "muted small", letzte ? `Letzte Zählung: ${letzte.by || "?"}, ${wann(letzte.at)}` : "Noch keine abgeschlossene Zählung."));
    const liste = el("div", "mg-liste");
    for (const a of zeigen) {
      const st = status(a);
      const z = knopf("", "mg-artikel " + st + (a.aktiv === false ? " aus" : ""), () => artikelBlatt(a, b.id, neuLaden));
      z.innerHTML = `<span class="mg-artikel-name"></span><span class="mg-artikel-zahl"></span><span class="muted small mg-artikel-meta"></span>`;
      z.querySelector(".mg-artikel-name").textContent = a.name + (a.aktiv === false ? " (wird nicht gezählt)" : "");
      z.querySelector(".mg-artikel-zahl").textContent = `${zahl(a.menge)} / ${zahl(a.soll)} ${a.einheit || ""}`;
      z.querySelector(".mg-artikel-meta").textContent = a.at ? `${wann(a.at)}${a.by ? " · " + a.by : ""}` : "nie gezählt";
      liste.appendChild(z);
    }
    if (zeigen.length === 0) liste.appendChild(text("p", "muted small", nurFehlend ? "Nichts unter Soll." : "Noch keine Artikel."));
    card.appendChild(liste);
    card.appendChild(knopf(`＋ Artikel für ${b.label}`, "btn btn-secondary", () => artikelBlatt(null, b.id, neuLaden)));
    wrap.appendChild(card);
  }
  return wrap;
}

function bestelltext(daten, unter) {
  const zeilen = [`Bestellung ${datumKurz(daten.heute)}`];
  for (const b of BEREICHE) {
    const teil = unter.filter((a) => a.bereich === b.id);
    if (teil.length === 0) continue;
    zeilen.push("", `${b.label}:`);
    for (const a of teil) zeilen.push(`- ${a.name}: ${zahl(fehlt(a))} ${a.einheit || ""}`.trimEnd());
  }
  return zeilen.join("\n");
}

/** Wo Kopieren nicht erlaubt ist (manche Browser): Text zum Markieren anzeigen. */
function zeigeText(inhalt) {
  blatt("Bestellliste", (box) => {
    const t = document.createElement("textarea");
    t.rows = 12;
    t.value = inhalt;
    box.appendChild(t);
    t.select();
  });
}

function artikelBlatt(vorhanden, bereich, neuLaden) {
  blatt(vorhanden ? "Artikel ändern" : "Neuer Artikel", (box, schliessen) => {
    const name = eingabe("text", vorhanden?.name, "z.B. Hafermilch");
    const soll = eingabe("text", vorhanden ? zahl(vorhanden.soll) : "", "z.B. 20");
    soll.inputMode = "decimal";
    const einheit = auswahl(EINHEITEN.map((e) => [e, e]), vorhanden?.einheit && EINHEITEN.includes(vorhanden.einheit) ? vorhanden.einheit : "Stück");
    const wo = auswahl(BEREICHE.map((b) => [b.id, `${b.symbol} ${b.label}`]), vorhanden?.bereich || bereich);
    const notiz = eingabe("text", vorhanden?.notiz, "z.B. Lager hinten links");
    const aktiv = haken("Wird gezählt", vorhanden ? vorhanden.aktiv !== false : true);

    box.appendChild(feld("Artikel", name));
    const reihe = el("div", "mg-reihe");
    reihe.append(feld("Soll", soll), feld("Einheit", einheit));
    box.appendChild(reihe);
    box.appendChild(feld("Wer zählt?", wo, "Küche: Küchen-Team · Bar: Bar und Service"));
    box.appendChild(feld("Notiz", notiz));
    box.appendChild(aktiv.zeile);
    if (vorhanden && String(vorhanden.id).startsWith("vorlaeufig-")) {
      box.appendChild(text("p", "callout", "Dieser Artikel ist noch nicht am iPad angekommen. Ändern geht nach dem nächsten Abgleich (spätestens 90 Sekunden)."));
    }

    const speichern = knopf("Speichern", "btn btn-primary btn-huge", async (e) => {
      if (!name.value.trim()) return toast("Bitte einen Namen eintragen.", true);
      const daten = {
        name: name.value.trim(),
        soll: Number(soll.value.replace(",", ".")) || 0,
        einheit: einheit.value,
        bereich: wo.value,
        notiz: notiz.value.trim(),
        aktiv: aktiv.cb.checked,
      };
      const ok = await ausfuehren(
        e.currentTarget,
        () => bestandAction(vorhanden ? { kind: "update", itemId: vorhanden.id, ...daten } : { kind: "create", ...daten }),
        "Gespeichert"
      );
      if (ok) {
        schliessen();
        neuLaden();
      }
    });
    speichern.disabled = !!(vorhanden && String(vorhanden.id).startsWith("vorlaeufig-"));
    box.appendChild(speichern);

    if (vorhanden && !String(vorhanden.id).startsWith("vorlaeufig-")) {
      box.appendChild(
        knopf("Artikel löschen", "btn btn-link", async (e) => {
          if (!confirm(`„${vorhanden.name}“ endgültig löschen? Zum Pausieren lieber „Wird gezählt“ ausschalten.`)) return;
          if (await ausfuehren(e.currentTarget, () => bestandAction({ kind: "delete", itemId: vorhanden.id }), "Gelöscht")) {
            schliessen();
            neuLaden();
          }
        })
      );
    }
    name.focus();
  });
}

export { renderBestand, status as bestandStatus, fehlt as bestandFehlt };
