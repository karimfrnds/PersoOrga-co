// ============================================================================
// manager/meins.js – Ihr eigener Bereich.
//
// Zwei Dinge:
//   Aufgaben  – für sich selbst (Putzroutine jeden Montag) und vom Chef (Event Freitag, mehr bestellen).
//               Wiederkehrendes wird pro Tag abgehakt; was vom Chef kommt, ist als solches markiert und
//               nur von ihm zu ändern.
//   Notizen   – was bei der Orientierung hilft: Text, Fotos (wie das Lager aussehen soll, wo was steht).
//
// Meldet sich der Chef hier an, sieht er nur die Aufgaben, die er ihr gibt – die Notizen sind ihre.
// ============================================================================
import { aufgabeAction, notizAction, fotoHochladen, fotoLaden } from "./api.js";
import {
  el,
  text,
  knopf,
  feld,
  eingabe,
  textfeld,
  auswahl,
  haken,
  wochentagWahl,
  segmente,
  blatt,
  toast,
  ausfuehren,
  addDays,
  wtIndex,
  datumKurz,
  tagName,
  WT,
} from "./ui.js";

let ansicht = "heute"; // heute | alle
const fotoCache = new Map(); // id -> dataUrl (oder Promise)

/** Steht die Aufgabe an diesem Tag an – und ist sie dort erledigt? */
function aufgabeAm(a, datum) {
  if (a.art === "wiederkehrend") {
    const gilt = !a.wochentage?.length || a.wochentage.includes(wtIndex(datum));
    return { gilt, erledigt: !!a.erledigtTage?.[datum] };
  }
  const erledigtHeute = a.erledigtAm && lokalesDatum(a.erledigtAm) === datum;
  // Einmalige: ab dem Fälligkeitstag (oder sofort) bis sie erledigt ist – Liegengebliebenes rutscht mit.
  const gilt = (!a.erledigtAm && (!a.faellig || a.faellig <= datum)) || erledigtHeute;
  return { gilt, erledigt: !!a.erledigtAm, ueberfaellig: !a.erledigtAm && a.faellig && a.faellig < datum };
}
function lokalesDatum(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function rhythmus(a) {
  if (a.art === "wiederkehrend") return a.wochentage?.length ? `jeden ${a.wochentage.map((w) => WT[w]).join(", ")}` : "täglich";
  return a.faellig ? `bis ${datumKurz(a.faellig)}` : "ohne Datum";
}

function renderMeins(daten, { neuLaden, rolle }) {
  const wrap = el("div");
  const istChef = rolle === "boss";
  wrap.appendChild(buildAufgaben(daten, neuLaden, istChef, () => wrap.replaceWith(renderMeins(daten, { neuLaden, rolle }))));
  if (!istChef) wrap.appendChild(buildNotizen(daten, neuLaden));
  return wrap;
}

// ---------------------------------------------------------------------
// Aufgaben
// ---------------------------------------------------------------------
function buildAufgaben(daten, neuLaden, istChef, neu) {
  const card = el("section", "card");
  const heute = daten.heute;
  card.appendChild(text("h2", null, istChef ? `📌 Aufgaben für ${daten.name}` : "📌 Meine Aufgaben"));
  if (istChef) {
    card.appendChild(text("p", "muted small", "Was du hier einträgst, steht bei ihr oben mit „vom Chef“. Ihre eigenen Aufgaben siehst du auch – ihre Notizen nicht."));
  }
  card.appendChild(
    segmente(
      [
        ["heute", "Heute"],
        ["alle", "Alle"],
      ],
      ansicht,
      (id) => {
        ansicht = id;
        neu();
      }
    )
  );
  card.appendChild(knopf(istChef ? `＋ Aufgabe für ${daten.name}` : "＋ Aufgabe oder Routine", "btn btn-primary", () => aufgabeBlatt(null, istChef, neuLaden)));

  const alle = daten.aufgaben || [];
  const liste = el("div", "mg-liste");
  let zeigen;
  if (ansicht === "heute") {
    zeigen = alle.filter((a) => aufgabeAm(a, heute).gilt);
    // Vom Chef und Überfälliges zuerst, dann Offenes, Erledigtes unten.
    zeigen.sort((x, y) => {
      const sx = aufgabeAm(x, heute);
      const sy = aufgabeAm(y, heute);
      return Number(sx.erledigt) - Number(sy.erledigt) || Number(y.von === "chef") - Number(x.von === "chef") || Number(!!sy.ueberfaellig) - Number(!!sx.ueberfaellig);
    });
  } else {
    zeigen = [...alle].sort((x, y) => Number(x.art === "wiederkehrend") - Number(y.art === "wiederkehrend") || String(x.faellig || "9").localeCompare(String(y.faellig || "9")));
  }
  for (const a of zeigen) liste.appendChild(aufgabeZeile(a, heute, istChef, neuLaden, ansicht === "alle"));
  if (zeigen.length === 0) {
    liste.appendChild(text("p", "muted small", ansicht === "heute" ? "Für heute nichts offen." : "Noch keine Aufgaben. Eine Routine wie „Theke putzen, jeden Montag“ ist ein guter Anfang."));
  }
  card.appendChild(liste);
  return card;
}

function aufgabeZeile(a, heute, istChef, neuLaden, alleAnsicht) {
  const s = aufgabeAm(a, heute);
  const z = el("div", "mg-aufgabe" + (s.erledigt && (s.gilt || a.art !== "wiederkehrend") ? " erledigt" : "") + (a.von === "chef" ? " vom-chef" : ""));
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = a.art === "wiederkehrend" ? s.erledigt : !!a.erledigtAm;
  // Wiederkehrendes lässt sich nur an Tagen abhaken, an denen es ansteht.
  cb.disabled = a.art === "wiederkehrend" && !s.gilt;
  cb.onchange = async () => {
    cb.disabled = true;
    if (await ausfuehren(null, () => aufgabeAction({ kind: "toggle", id: a.id, datum: heute }))) neuLaden();
    else {
      cb.checked = !cb.checked;
      cb.disabled = false;
    }
  };
  z.appendChild(cb);
  const darfAendern = a.von !== "chef" || istChef;
  const mitte = knopf("", "mg-aufgabe-text", () => (darfAendern ? aufgabeBlatt(a, istChef, neuLaden) : zeigeAufgabe(a)));
  const meta = [a.von === "chef" ? "vom Chef" : null, s.ueberfaellig ? "überfällig" : null, alleAnsicht || a.art === "wiederkehrend" ? rhythmus(a) : null, a.notiz ? "📝" : null]
    .filter(Boolean)
    .join(" · ");
  mitte.innerHTML = `<span></span><span class="muted small"></span>`;
  mitte.firstChild.textContent = (a.prioritaet === "hoch" ? "🔴 " : "") + a.text;
  mitte.lastChild.textContent = meta;
  z.appendChild(mitte);
  return z;
}

function zeigeAufgabe(a) {
  blatt(a.text, (box) => {
    box.appendChild(text("p", "muted small", `vom Chef · ${rhythmus(a)}`));
    if (a.notiz) box.appendChild(text("p", "mg-notiz-text", a.notiz));
  });
}

function aufgabeBlatt(a, istChef, neuLaden) {
  blatt(a ? "Aufgabe ändern" : istChef ? "Aufgabe für die Store-Managerin" : "Neue Aufgabe", (box, schliessen) => {
    const was = eingabe("text", a?.text, istChef ? "z.B. Freitag Event – mehr Wein bestellen" : "z.B. Theke gründlich putzen");
    let art = a?.art || "einmalig";
    const faellig = eingabe("date", a?.faellig || "");
    const tage = wochentagWahl(a?.wochentage || []);
    const prio = auswahl(
      [
        ["normal", "Normal"],
        ["hoch", "🔴 Wichtig"],
      ],
      a?.prioritaet || "normal"
    );
    const notiz = textfeld(a?.notiz, "Details, falls nötig", 3);

    box.appendChild(feld("Was?", was));
    const artWahl = el("div");
    const einmaligBox = feld("Bis wann?", faellig, "Leer lassen, wenn es kein festes Datum gibt.");
    const wiederBox = feld("An welchen Tagen?", tage.node, "Keiner gewählt = jeden Tag.");
    const zeichneArt = () => {
      artWahl.innerHTML = "";
      artWahl.appendChild(
        segmente(
          [
            ["einmalig", "Einmal"],
            ["wiederkehrend", "Regelmäßig"],
          ],
          art,
          (id) => {
            art = id;
            zeichneArt();
          }
        )
      );
      einmaligBox.hidden = art !== "einmalig";
      wiederBox.hidden = art !== "wiederkehrend";
    };
    zeichneArt();
    box.append(artWahl, einmaligBox, wiederBox, feld("Priorität", prio), feld("Notiz", notiz));

    box.appendChild(
      knopf("Speichern", "btn btn-primary btn-huge", async (e) => {
        if (!was.value.trim()) return toast("Bitte eintragen, was zu tun ist.", true);
        const felder = { text: was.value.trim(), art, faellig: faellig.value, wochentage: tage.werte(), prioritaet: prio.value, notiz: notiz.value };
        const ok = await ausfuehren(e.currentTarget, () => aufgabeAction(a ? { kind: "update", id: a.id, ...felder } : { kind: "create", ...felder }), "Gespeichert");
        if (ok) {
          schliessen();
          neuLaden();
        }
      })
    );
    if (a) {
      box.appendChild(
        knopf("Löschen", "btn btn-link", async (e) => {
          if (!confirm(`„${a.text}“ löschen?`)) return;
          if (await ausfuehren(e.currentTarget, () => aufgabeAction({ kind: "delete", id: a.id }), "Gelöscht")) {
            schliessen();
            neuLaden();
          }
        })
      );
    }
    was.focus();
  });
}

// ---------------------------------------------------------------------
// Notizen
// ---------------------------------------------------------------------
function buildNotizen(daten, neuLaden) {
  const card = el("section", "card");
  card.appendChild(text("h2", null, "🗒 Notizen"));
  card.appendChild(knopf("＋ Notiz", "btn btn-primary", () => notizBlatt(null, neuLaden)));
  const notizen = [...(daten.notizen || [])].sort((a, b) => Number(b.angeheftet) - Number(a.angeheftet) || String(b.geaendert).localeCompare(String(a.geaendert)));
  if (notizen.length === 0) {
    card.appendChild(text("p", "muted small", "Noch keine Notizen. Gut geeignet für: wie das Lager aufgeräumt aussieht, Lieferanten-Kontakte, Abläufe zum Nachlesen."));
    return card;
  }
  const raster = el("div", "mg-notizen");
  for (const n of notizen) {
    const k = knopf("", "mg-notiz" + (n.angeheftet ? " angeheftet" : ""), () => notizBlatt(n, neuLaden));
    k.innerHTML = `<b class="mg-notiz-titel"></b><span class="mg-notiz-vorschau"></span><span class="mg-notiz-fotos"></span><span class="muted small"></span>`;
    k.querySelector(".mg-notiz-titel").textContent = (n.angeheftet ? "📌 " : "") + (n.titel || "Ohne Titel");
    k.querySelector(".mg-notiz-vorschau").textContent = (n.text || "").slice(0, 140);
    k.querySelector(".muted").textContent = new Date(n.geaendert).toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit" });
    const fotos = k.querySelector(".mg-notiz-fotos");
    for (const id of (n.fotoIds || []).slice(0, 3)) fotos.appendChild(vorschaubild(id));
    if ((n.fotoIds || []).length > 3) fotos.appendChild(text("span", "muted small", `+${n.fotoIds.length - 3}`));
    raster.appendChild(k);
  }
  card.appendChild(raster);
  return card;
}

function ladeFoto(id) {
  if (!fotoCache.has(id)) {
    fotoCache.set(
      id,
      fotoLaden(id).then(
        (r) => r.dataUrl,
        () => {
          fotoCache.delete(id);
          return null;
        }
      )
    );
  }
  return fotoCache.get(id);
}

function vorschaubild(id, gross = false) {
  const img = document.createElement("img");
  img.className = gross ? "mg-foto-gross" : "mg-foto-klein";
  img.alt = "";
  ladeFoto(id).then((url) => {
    if (url) img.src = url;
  });
  return img;
}

/** Foto im Browser verkleinern: ein Handyfoto hat 3–5 MB, gebraucht werden ein paar hundert KB. */
function verkleinern(datei, maxKante = 1600) {
  return new Promise((resolve, reject) => {
    const leser = new FileReader();
    leser.onerror = () => reject(new Error("Foto konnte nicht gelesen werden."));
    leser.onload = () => {
      const bild = new Image();
      bild.onerror = () => reject(new Error("Das ist kein Foto, das sich öffnen lässt."));
      bild.onload = () => {
        const faktor = Math.min(1, maxKante / Math.max(bild.width, bild.height));
        const c = document.createElement("canvas");
        c.width = Math.round(bild.width * faktor);
        c.height = Math.round(bild.height * faktor);
        c.getContext("2d").drawImage(bild, 0, 0, c.width, c.height);
        let url = c.toDataURL("image/jpeg", 0.8);
        if (url.length > 1_400_000) url = c.toDataURL("image/jpeg", 0.6);
        resolve(url);
      };
      bild.src = leser.result;
    };
    leser.readAsDataURL(datei);
  });
}

function notizBlatt(n, neuLaden) {
  blatt(n ? "Notiz" : "Neue Notiz", (box, schliessen) => {
    const titel = eingabe("text", n?.titel, "Titel");
    const inhalt = textfeld(n?.text, "Was du dir merken willst…", 8);
    const anheften = haken("Oben anheften", n?.angeheftet);
    let fotoIds = [...(n?.fotoIds || [])];

    box.appendChild(feld("Titel", titel));
    box.appendChild(feld("Text", inhalt));

    const fotoBox = el("div", "mg-foto-liste");
    const zeichneFotos = () => {
      fotoBox.innerHTML = "";
      for (const id of fotoIds) {
        const f = el("div", "mg-foto-kachel");
        const img = vorschaubild(id);
        img.onclick = () => blatt("Foto", (b) => b.appendChild(vorschaubild(id, true)));
        const weg = knopf("✕", "mg-foto-weg", () => {
          fotoIds = fotoIds.filter((x) => x !== id);
          zeichneFotos();
        });
        f.append(img, weg);
        fotoBox.appendChild(f);
      }
    };
    zeichneFotos();
    const datei = document.createElement("input");
    datei.type = "file";
    datei.accept = "image/*";
    datei.multiple = true;
    datei.hidden = true;
    const hinzu = knopf("📷 Foto hinzufügen", "btn btn-secondary", () => datei.click());
    datei.onchange = async () => {
      const dateien = [...datei.files];
      datei.value = "";
      for (const d of dateien) {
        hinzu.disabled = true;
        hinzu.textContent = "Lade hoch…";
        try {
          const url = await verkleinern(d);
          const r = await fotoHochladen(url);
          fotoCache.set(r.id, Promise.resolve(url));
          fotoIds.push(r.id);
          zeichneFotos();
        } catch (e) {
          toast("⚠ " + e.message, true);
        }
      }
      hinzu.disabled = false;
      hinzu.textContent = "📷 Foto hinzufügen";
    };
    const fotoFeld = el("div", "field");
    fotoFeld.append(text("span", null, "Fotos"), fotoBox, hinzu, datei);
    box.appendChild(fotoFeld);
    box.appendChild(anheften.zeile);

    box.appendChild(
      knopf("Speichern", "btn btn-primary btn-huge", async (e) => {
        const felder = { titel: titel.value.trim(), text: inhalt.value, fotoIds, angeheftet: anheften.cb.checked };
        if (!felder.titel && !felder.text.trim() && fotoIds.length === 0) return toast("Die Notiz ist leer.", true);
        const ok = await ausfuehren(e.currentTarget, () => notizAction(n ? { kind: "update", id: n.id, ...felder } : { kind: "create", ...felder }), "Gespeichert");
        if (ok) {
          schliessen();
          neuLaden();
        }
      })
    );
    if (n) {
      box.appendChild(
        knopf("Notiz löschen", "btn btn-link", async (e) => {
          if (!confirm("Notiz samt Fotos löschen?")) return;
          if (await ausfuehren(e.currentTarget, () => notizAction({ kind: "delete", id: n.id }), "Gelöscht")) {
            schliessen();
            neuLaden();
          }
        })
      );
    }
    if (!n) titel.focus();
  });
}

export { renderMeins, aufgabeAm };
