// ============================================================================
// pages/kueche.js – Der Küchen-Bereich: was vorbereitet ist, und wie man es macht.
//
// Zwei Dinge, die zusammengehören:
//
//   VORBEREITUNGEN. Die Frage am Anfang jeder Schicht ist immer dieselbe: Was ist noch da? Die Antwort
//   hiess bisher nachsehen – in jeden Behälter, jedes Mal, auch wenn die Schicht davor es zwei Stunden
//   vorher schon gewusst hat. Hier trägt die gehende Schicht eine Zahl ein und die kommende liest sie ab.
//   Daneben steht das Soll. Der Unterschied zwischen „3 Behälter" und „3 von 5" ist der ganze Punkt.
//
//   REZEPTE. Dieselbe Vorbereitung, immer gleich gemacht – ohne dass jemand fragen muss. Am Artikel
//   hängt sein Rezept, damit man nicht erst in einer Liste danach sucht, während die Pfanne heiss wird.
//
// Bewusst ohne PIN, wie „Was fehlt?": wer in der Küche steht, muss zählen können, nicht sich anmelden.
// ============================================================================
import { store } from "../store.js";
import { escapeHtml, todayStr } from "../format.js";
import { confirmDialog, alertDialog } from "../dialog.js";

const STATUS = {
  leer: { label: "leer", klasse: "bestand-leer", rang: 0 },
  knapp: { label: "unter Soll", klasse: "bestand-knapp", rang: 1 },
  unbekannt: { label: "nicht gezählt", klasse: "bestand-bestellt", rang: 2 },
  ok: { label: "genug", klasse: "bestand-ok", rang: 3 },
};

/** „vor 20 Min", „vor 3 Std", „gestern" – eine Uhrzeit allein sagt nicht, ob die Zahl von heute ist. */
function wannText(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const min = Math.round((Date.now() - d.getTime()) / 60000);
  const uhr = d.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
  if (min < 2) return "gerade eben";
  if (min < 60) return `vor ${min} Min`;
  // Ortszeit vergleichen, nicht UTC: sonst gilt eine Zaehlung von gestern Abend 23:30 als "heute"
  // (oder umgekehrt), und genau an der Stelle zaehlt die Angabe.
  const lokal = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  if (lokal === todayStr()) return `${uhr} Uhr`;
  return `${d.toLocaleDateString("de-DE", { weekday: "short", day: "2-digit", month: "2-digit" })}, ${uhr} Uhr`;
}

/** "von 3 Schale" liest sich falsch. Nur die zwei Einheiten, bei denen der Plural nicht gleich ist –
 * eine allgemeine Pluralbildung fuer Deutsch waere hier ein eigenes Projekt. */
const PLURAL = { Schale: "Schalen", Blech: "Bleche" };
function einheitText(einheit, menge) {
  return menge === 1 ? einheit : PLURAL[einheit] || einheit;
}

function zahlText(n) {
  return Number.isInteger(n) ? String(n) : String(n).replace(".", ",");
}

function renderKueche() {
  const container = document.createElement("div");
  container.className = "page";

  let tab = "prep"; // "prep" | "rezepte"
  let zaehler = ""; // wer gerade zählt (Mitarbeiter-ID)
  let suche = "";
  let offenesRezept = null;
  // Eingetippte, noch nicht gespeicherte Zahlen: prepId -> Zahl. Überlebt das Neuzeichnen, damit man
  // die ganze Liste durchgehen kann und erst am Ende einmal speichert.
  const entwurf = new Map();

  function rerender() {
    container.innerHTML = "";
    container.appendChild(build());
  }

  function build() {
    const frag = document.createElement("div");
    frag.innerHTML = `<h1>🍳 Küche</h1>`;

    const tabs = document.createElement("div");
    tabs.className = "admin-tabs";
    for (const [id, label] of [["prep", "Vorbereitungen"], ["rezepte", "Rezepte"]]) {
      const btn = document.createElement("button");
      btn.className = "admin-tab" + (tab === id ? " active" : "");
      btn.textContent = label;
      btn.onclick = () => {
        tab = id;
        rerender();
      };
      tabs.appendChild(btn);
    }
    frag.appendChild(tabs);

    frag.appendChild(tab === "prep" ? buildPrep() : buildRezepte());
    return frag;
  }

  // =====================================================================
  // Vorbereitungen
  // =====================================================================
  function buildPrep() {
    const wrap = document.createElement("div");
    const preps = store.getPreps();

    wrap.appendChild(
      el("p", "muted", "Trag ein, wie viel gerade da ist. Die nächste Schicht sieht es dann, ohne nachzusehen.")
    );

    if (preps.length === 0) {
      wrap.appendChild(
        el(
          "div",
          "empty-state",
          "Noch keine Vorbereitung angelegt. Trag ein, was bei euch immer vorbereitet sein muss – z.B. Tomatensauce, Aioli, geschnittene Zwiebeln."
        )
      );
      wrap.appendChild(neuKnopf());
      return wrap;
    }

    wrap.appendChild(buildZusammenfassung(preps));
    wrap.appendChild(buildZaehlerWahl());

    const liste = document.createElement("div");
    liste.className = "prep-list";
    // Was fehlt, steht oben: leer, dann unter Soll, dann nie gezählt, dann der Rest.
    const sortiert = [...preps].sort(
      (a, b) => STATUS[store.prepStatus(a)].rang - STATUS[store.prepStatus(b)].rang || (a.sort || 0) - (b.sort || 0)
    );
    for (const p of sortiert) liste.appendChild(buildPrepRow(p));
    wrap.appendChild(liste);

    wrap.appendChild(buildSpeichernLeiste());
    wrap.appendChild(neuKnopf());
    return wrap;
  }

  function buildZusammenfassung(preps) {
    const leer = preps.filter((p) => store.prepStatus(p) === "leer");
    const knapp = preps.filter((p) => store.prepStatus(p) === "knapp");
    const unbekannt = preps.filter((p) => store.prepStatus(p) === "unbekannt");
    const box = document.createElement("div");
    if (leer.length === 0 && knapp.length === 0) {
      box.className = "callout";
      box.textContent = unbekannt.length > 0 ? `Alles über Soll – ${unbekannt.length} noch nie gezählt.` : "Alles über Soll.";
      return box;
    }
    box.className = "callout callout-warn";
    const teile = [];
    if (leer.length > 0) teile.push(`<b>leer:</b> ${leer.map((p) => escapeHtml(p.name)).join(", ")}`);
    if (knapp.length > 0) teile.push(`<b>unter Soll:</b> ${knapp.map((p) => escapeHtml(p.name)).join(", ")}`);
    box.innerHTML = teile.join("<br>");
    return box;
  }

  /** Wer zählt gerade? Steht nachher an der Zahl – „3 Behälter" ohne Absender ist im Zweifel wertlos,
   * weil niemand weiss, ob das von vorhin oder von vorgestern ist. Ist genau eine Küchenkraft im Dienst,
   * ist sie vorausgewählt; sonst fragt die Seite einmal nach. */
  function buildZaehlerWahl() {
    const imDienst = store
      .getOpenShiftsToday()
      .map((s) => store.getEmployee(s.employeeId))
      .filter(Boolean);
    const kueche = imDienst.filter((e) => e.role === "kueche");
    if (!zaehler) zaehler = (kueche.length === 1 ? kueche[0] : imDienst.length === 1 ? imDienst[0] : null)?.id || "";

    const box = el("div", "res-form-row prep-zaehler");
    const label = document.createElement("label");
    label.className = "field";
    label.innerHTML = `<span>Wer zählt?</span>`;
    const sel = document.createElement("select");
    const leer = document.createElement("option");
    leer.value = "";
    leer.textContent = "– bitte wählen –";
    sel.appendChild(leer);
    for (const e of store.getEmployees(false)) {
      const o = document.createElement("option");
      o.value = e.id;
      o.textContent = e.name + (imDienst.some((x) => x.id === e.id) ? " (im Dienst)" : "");
      sel.appendChild(o);
    }
    sel.value = zaehler;
    sel.onchange = () => {
      zaehler = sel.value;
      rerender();
    };
    label.appendChild(sel);
    box.appendChild(label);
    return box;
  }

  function buildPrepRow(p) {
    const status = store.prepStatus(p);
    const row = document.createElement("div");
    row.className = "prep-row " + STATUS[status].klasse;

    const kopf = el("div", "prep-row-kopf");
    const titel = el("div", "prep-row-titel");
    titel.innerHTML = `<b>${escapeHtml(p.name)}</b>`;
    const meta = el("span", "muted small");
    meta.textContent = p.bestand
      ? `zuletzt ${wannText(p.bestand.at)}${p.bestand.by ? " · " + p.bestand.by : ""}`
      : "noch nie gezählt";
    titel.appendChild(meta);
    if (p.notiz) titel.appendChild(el("span", "muted small", escapeHtml(p.notiz)));
    kopf.appendChild(titel);
    kopf.appendChild(el("span", "prep-chip " + STATUS[status].klasse, STATUS[status].label));
    row.appendChild(kopf);

    // Zähl-Zeile: −, Zahl, +. Die Zahl ist auch von Hand tippbar, weil „17 Portionen" sonst
    // siebzehn Tipper wären.
    const zaehl = el("div", "prep-zaehl");
    const wert = () => (entwurf.has(p.id) ? entwurf.get(p.id) : p.bestand ? p.bestand.menge : null);

    const minus = el("button", "btn btn-secondary prep-step", "−");
    const plus = el("button", "btn btn-secondary prep-step", "＋");
    const input = document.createElement("input");
    // Bewusst KEIN type="number": dort aendert das Mausrad ueber dem Feld stillschweigend die Zahl, ohne
    // dass die Seite davon erfaehrt – dann stuende im Feld etwas anderes als das, was gespeichert wird.
    // inputmode="decimal" bringt auf dem iPad trotzdem die Zifferntastatur.
    input.type = "text";
    input.inputMode = "decimal";
    input.className = "prep-input";
    input.placeholder = "?";
    input.value = wert() === null ? "" : zahlText(wert());
    const setze = (n) => {
      const zahl = Math.max(0, Math.round(n * 2) / 2);
      entwurf.set(p.id, zahl);
      input.value = zahlText(zahl);
      zeichneFuss();
      row.className = "prep-row " + STATUS[vorschauStatus(p, zahl)].klasse;
    };
    minus.onclick = () => setze((wert() ?? 0) - 1);
    plus.onclick = () => setze((wert() ?? 0) + 1);
    input.oninput = () => {
      const roh = input.value.trim();
      if (roh === "") {
        entwurf.delete(p.id);
        zeichneFuss();
        return;
      }
      // "1,5" ist die Schreibweise, die hier jemand eintippt – die muss ankommen.
      const zahl = Number(roh.replace(",", "."));
      if (!Number.isFinite(zahl) || zahl < 0) return;
      entwurf.set(p.id, zahl);
      zeichneFuss();
      row.className = "prep-row " + STATUS[vorschauStatus(p, zahl)].klasse;
    };
    zaehl.append(minus, input, plus);
    zaehl.appendChild(
      el(
        "span",
        "prep-soll",
        p.soll > 0
          ? `von ${zahlText(p.soll)} ${escapeHtml(einheitText(p.einheit, p.soll))}`
          : escapeHtml(einheitText(p.einheit, 2))
      )
    );
    row.appendChild(zaehl);

    const akt = el("div", "employee-actions");
    if (p.rezeptId && store.getRecipe(p.rezeptId)) {
      const rez = el("button", "btn btn-link", "📖 Rezept");
      rez.onclick = () => zeigeRezept(store.getRecipe(p.rezeptId));
      akt.appendChild(rez);
    }
    const aendern = el("button", "btn btn-link", "Ändern");
    aendern.onclick = () => openPrepForm(p);
    akt.appendChild(aendern);
    row.appendChild(akt);
    return row;
  }

  function vorschauStatus(p, menge) {
    return store.prepStatus({ ...p, bestand: { menge } });
  }

  /** Die Leiste unten: erst wenn wirklich etwas geändert wurde, gibt es etwas zu speichern. So kann man
   * die ganze Liste durchgehen und am Ende einmal tippen, statt nach jeder Zahl. */
  function buildSpeichernLeiste() {
    const box = el("div", "prep-fuss");
    box.id = "prep-fuss";
    zeichneFussIn(box);
    return box;
  }
  function zeichneFuss() {
    const box = container.querySelector("#prep-fuss");
    if (box) zeichneFussIn(box);
  }
  function zeichneFussIn(box) {
    box.innerHTML = "";
    const anzahl = entwurf.size;
    if (anzahl === 0) {
      box.appendChild(el("p", "muted small", "Zahlen eintragen, dann unten speichern."));
      return;
    }
    if (!zaehler) {
      box.appendChild(el("p", "res-warn small", "Bitte oben auswählen, wer zählt – sonst weiss die nächste Schicht nicht, von wem die Zahl kommt."));
    }
    const btn = el("button", "btn btn-primary btn-huge", `✓ ${anzahl} ${anzahl === 1 ? "Zahl" : "Zahlen"} eintragen`);
    btn.disabled = !zaehler;
    btn.onclick = () => {
      const name = store.getEmployee(zaehler)?.name || null;
      for (const [id, menge] of entwurf) store.setPrepBestand(id, menge, name);
      entwurf.clear();
      rerender();
    };
    box.appendChild(btn);
    const weg = el("button", "btn btn-link", "Eingaben verwerfen");
    weg.onclick = () => {
      entwurf.clear();
      rerender();
    };
    box.appendChild(weg);
  }

  function neuKnopf() {
    const btn = el("button", "btn btn-secondary", "＋ Vorbereitung");
    btn.onclick = () => openPrepForm(null);
    return btn;
  }

  function openPrepForm(vorhanden) {
    const overlay = el("div", "overlay");
    const box = el("div", "dialog");
    box.appendChild(el("h2", null, vorhanden ? "Vorbereitung ändern" : "Neue Vorbereitung"));

    const name = eingabe("text", vorhanden?.name || "", "z.B. Tomatensauce");
    const soll = eingabe("number", vorhanden?.soll ?? 0, "");
    soll.min = "0";
    soll.step = "0.5";
    const einheit = auswahl(store.PREP_EINHEITEN.map((e) => [e, e]), vorhanden?.einheit || "Behälter");
    const notiz = eingabe("text", vorhanden?.notiz || "", "z.B. im grossen Kühlschrank unten");

    const rezepte = store.getRecipes();
    const rezept = auswahl([["", "– kein Rezept –"], ...rezepte.map((r) => [r.id, r.name])], vorhanden?.rezeptId || "");

    box.appendChild(feld("Was wird vorbereitet?", name));
    const reihe = el("div", "res-form-row");
    reihe.append(feld("Soll (mindestens)", soll), feld("Einheit", einheit));
    box.appendChild(reihe);
    box.appendChild(feld("Rezept", rezept, rezepte.length === 0 ? "Noch keine Rezepte angelegt – das geht im Reiter „Rezepte“." : ""));
    box.appendChild(feld("Notiz", notiz, "Wo es steht, worauf zu achten ist."));

    const akt = el("div", "dialog-actions");
    const abbrechen = el("button", "btn btn-secondary", "Abbrechen");
    abbrechen.onclick = () => overlay.remove();
    const speichern = el("button", "btn btn-primary", "Speichern");
    speichern.onclick = async () => {
      if (!name.value.trim()) {
        await alertDialog("Bitte einen Namen eintragen.");
        return;
      }
      const daten = {
        name: name.value.trim(),
        soll: Number(soll.value) || 0,
        einheit: einheit.value,
        notiz: notiz.value.trim(),
        rezeptId: rezept.value || null,
      };
      if (vorhanden) store.updatePrep(vorhanden.id, daten);
      else store.addPrep(daten);
      overlay.remove();
      rerender();
    };
    akt.append(abbrechen, speichern);
    box.appendChild(akt);

    if (vorhanden) {
      const unten = el("div", "res-dialog-danger");
      const weg = el("button", "btn btn-link", "Löschen");
      weg.onclick = async () => {
        if (!(await confirmDialog(`„${vorhanden.name}“ aus der Liste nehmen?`, { danger: true, okLabel: "Löschen" }))) return;
        store.removePrep(vorhanden.id);
        entwurf.delete(vorhanden.id);
        overlay.remove();
        rerender();
      };
      unten.appendChild(weg);
      box.appendChild(unten);
    }
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    name.focus();
  }

  // =====================================================================
  // Rezepte
  // =====================================================================
  function buildRezepte() {
    const wrap = document.createElement("div");
    wrap.appendChild(el("p", "muted", "Wie die Vorbereitungen gemacht werden – damit es jedes Mal gleich schmeckt."));

    const alle = store.getRecipes();
    const kopf = el("div", "res-form-row");
    const suchfeld = eingabe("search", suche, "Suchen…");
    suchfeld.oninput = () => {
      suche = suchfeld.value;
      zeichneRezeptListe();
    };
    kopf.appendChild(feld("Rezept suchen", suchfeld));
    wrap.appendChild(kopf);

    const akt = el("div", "employee-actions");
    const neu = el("button", "btn btn-primary", "＋ Rezept");
    neu.onclick = () => openRezeptForm(null);
    const imp = el("button", "btn btn-secondary", "📥 Rezepte übernehmen");
    imp.onclick = openImport;
    akt.append(neu, imp);
    wrap.appendChild(akt);

    const liste = el("div", "prep-list");
    liste.id = "rezept-liste";
    wrap.appendChild(liste);
    // Nach dem Anhängen füllen, damit die Suche nur die Liste neu zeichnet und das Feld den Fokus behält.
    queueMicrotask(zeichneRezeptListe);
    if (alle.length === 0) {
      wrap.appendChild(
        el(
          "div",
          "empty-state",
          "Noch keine Rezepte. Entweder hier anlegen – oder mit „Rezepte übernehmen“ aus einer anderen App einfügen."
        )
      );
    }
    return wrap;
  }

  function zeichneRezeptListe() {
    const liste = container.querySelector("#rezept-liste");
    if (!liste) return;
    liste.innerHTML = "";
    const such = suche.trim().toLowerCase();
    const treffer = store
      .getRecipes()
      .filter((r) => !such || r.name.toLowerCase().includes(such) || r.zutaten.join(" ").toLowerCase().includes(such));
    if (treffer.length === 0 && such) {
      liste.appendChild(el("p", "muted small", "Kein Rezept gefunden."));
      return;
    }
    for (const r of treffer) {
      const row = el("div", "prep-row");
      const kopf = el("div", "prep-row-kopf");
      const titel = el("div", "prep-row-titel");
      titel.innerHTML = `<b>${escapeHtml(r.name)}</b>`;
      const teile = [r.ergibt ? `ergibt ${r.ergibt}` : null, `${r.zutaten.length} Zutaten`, `${r.schritte.length} Schritte`]
        .filter(Boolean)
        .join(" · ");
      titel.appendChild(el("span", "muted small", escapeHtml(teile)));
      kopf.appendChild(titel);
      row.appendChild(kopf);
      const akt = el("div", "employee-actions");
      const auf = el("button", "btn btn-primary", "Öffnen");
      auf.onclick = () => zeigeRezept(r);
      const aendern = el("button", "btn btn-link", "Ändern");
      aendern.onclick = () => openRezeptForm(r);
      akt.append(auf, aendern);
      row.appendChild(akt);
      liste.appendChild(row);
    }
  }

  /** Das Rezept zum Kochen: gross, Zutaten und Schritte getrennt, Schritte abhakbar. Das Abhaken ist
   * bewusst flüchtig (nur solange offen) – ein Rezept ist keine Aufgabe, es wird beim nächsten Mal
   * wieder von vorn gekocht. */
  function zeigeRezept(r) {
    offenesRezept = r.id;
    const overlay = el("div", "overlay");
    const box = el("div", "dialog dialog-gross");
    box.appendChild(el("h2", null, escapeHtml(r.name)));
    if (r.ergibt) box.appendChild(el("p", "muted small", "Ergibt " + escapeHtml(r.ergibt)));

    if (r.zutaten.length > 0) {
      box.appendChild(el("p", "muted small res-bereich", "<b>Zutaten</b>"));
      const ul = el("div", "task-list");
      for (const z of r.zutaten) ul.appendChild(el("div", "task-row", `<div class="task-row-text"><span>${escapeHtml(z)}</span></div>`));
      box.appendChild(ul);
    }
    if (r.schritte.length > 0) {
      box.appendChild(el("p", "muted small res-bereich", "<b>So geht's</b>"));
      const ol = el("div", "task-list");
      r.schritte.forEach((sch, i) => {
        const row = el("label", "task-row");
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.onchange = () => row.classList.toggle("done", cb.checked);
        row.appendChild(cb);
        row.appendChild(el("div", "task-row-text", `<span><b>${i + 1}.</b> ${escapeHtml(sch)}</span>`));
        ol.appendChild(row);
      });
      box.appendChild(ol);
    }
    if (r.notiz) box.appendChild(el("p", "callout", escapeHtml(r.notiz)));
    if (r.quelle) box.appendChild(el("p", "muted small", "Übernommen aus: " + escapeHtml(r.quelle)));

    const akt = el("div", "dialog-actions");
    const zu = el("button", "btn btn-primary", "Schliessen");
    zu.onclick = () => {
      offenesRezept = null;
      overlay.remove();
    };
    const aendern = el("button", "btn btn-secondary", "Ändern");
    aendern.onclick = () => {
      overlay.remove();
      openRezeptForm(r);
    };
    akt.append(aendern, zu);
    box.appendChild(akt);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
  }

  function openRezeptForm(vorhanden) {
    const overlay = el("div", "overlay");
    const box = el("div", "dialog dialog-gross");
    box.appendChild(el("h2", null, vorhanden ? "Rezept ändern" : "Neues Rezept"));

    const name = eingabe("text", vorhanden?.name || "", "z.B. Aioli");
    const ergibt = eingabe("text", vorhanden?.ergibt || "", "z.B. 2 Behälter");
    const zutaten = mehrzeilig(vorhanden?.zutaten || [], "Eine Zutat pro Zeile:\n500 g Tomaten\n2 EL Olivenöl");
    const schritte = mehrzeilig(vorhanden?.schritte || [], "Ein Schritt pro Zeile:\nTomaten würfeln\n20 Minuten köcheln");
    const notiz = eingabe("text", vorhanden?.notiz || "", "z.B. hält 3 Tage");

    const reihe = el("div", "res-form-row");
    reihe.append(feld("Name", name), feld("Ergibt", ergibt));
    box.append(reihe, feld("Zutaten", zutaten, "Eine pro Zeile."), feld("Schritte", schritte, "Einer pro Zeile."), feld("Notiz", notiz));

    const akt = el("div", "dialog-actions");
    const abbrechen = el("button", "btn btn-secondary", "Abbrechen");
    abbrechen.onclick = () => overlay.remove();
    const speichern = el("button", "btn btn-primary", "Speichern");
    speichern.onclick = async () => {
      if (!name.value.trim()) {
        await alertDialog("Bitte einen Namen eintragen.");
        return;
      }
      const daten = {
        name: name.value.trim(),
        ergibt: ergibt.value.trim(),
        zutaten: zutaten.value,
        schritte: schritte.value,
        notiz: notiz.value.trim(),
        updatedBy: store.getEmployee(zaehler)?.name || null,
      };
      if (vorhanden) store.updateRecipe(vorhanden.id, daten);
      else store.addRecipe(daten);
      overlay.remove();
      rerender();
    };
    akt.append(abbrechen, speichern);
    box.appendChild(akt);

    if (vorhanden) {
      const unten = el("div", "res-dialog-danger");
      const weg = el("button", "btn btn-link", "Löschen");
      weg.onclick = async () => {
        if (!(await confirmDialog(`Rezept „${vorhanden.name}“ löschen?`, { danger: true, okLabel: "Löschen" }))) return;
        store.removeRecipe(vorhanden.id);
        overlay.remove();
        rerender();
      };
      unten.appendChild(weg);
      box.appendChild(unten);
    }
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    name.focus();
  }

  // ---------------------------------------------------------------------
  // Rezepte aus einer anderen App übernehmen
  //
  // Zwei Formate, weil beide vorkommen: eine Datei, die eine App ausgibt (JSON), und das, was man von
  // Hand zusammenkopiert (Text). Gleiche Namen werden ersetzt statt verdoppelt – zweimal einfügen soll
  // nicht jedes Rezept zweimal in die Liste legen.
  // ---------------------------------------------------------------------
  function openImport() {
    const overlay = el("div", "overlay");
    const box = el("div", "dialog dialog-gross");
    box.appendChild(el("h2", null, "Rezepte übernehmen"));
    box.appendChild(
      el(
        "p",
        "muted small",
        `Zwei Möglichkeiten: Entweder die Export-Datei einer anderen App hier hineinkopieren (JSON) –
         oder die Rezepte als Text in dieser Form:<br><br>
         <code># Aioli<br>Ergibt: 2 Behälter<br>Zutaten:<br>- 3 Knoblauchzehen<br>- 250 ml Öl<br>Schritte:<br>- alles mixen<br>---<br># Nächstes Rezept</code>`
      )
    );
    const feldText = document.createElement("textarea");
    feldText.rows = 12;
    feldText.placeholder = "Hier einfügen…";
    box.appendChild(feld("Inhalt", feldText));
    const status = el("p", "muted small");
    box.appendChild(status);

    const akt = el("div", "dialog-actions");
    const abbrechen = el("button", "btn btn-secondary", "Abbrechen");
    abbrechen.onclick = () => overlay.remove();
    const los = el("button", "btn btn-primary", "Übernehmen");
    los.onclick = async () => {
      const roh = feldText.value.trim();
      if (!roh) {
        status.className = "res-warn small";
        status.textContent = "Bitte etwas einfügen.";
        return;
      }
      let liste;
      try {
        liste = leseRezepte(roh);
      } catch (e) {
        status.className = "callout callout-warn";
        status.textContent = e.message;
        return;
      }
      if (liste.length === 0) {
        status.className = "callout callout-warn";
        status.textContent = "Darin war kein Rezept zu erkennen. Prüf bitte das Format – oder schick mir ein Beispiel.";
        return;
      }
      const ergebnis = store.importRecipes(liste, "Import");
      overlay.remove();
      await alertDialog(
        `${ergebnis.neu} neu übernommen, ${ergebnis.aktualisiert} aktualisiert (gleicher Name).` +
          (ergebnis.verknuepft > 0
            ? ` ${ergebnis.verknuepft} ${ergebnis.verknuepft === 1 ? "Vorbereitung hat" : "Vorbereitungen haben"} dadurch ein Rezept bekommen.`
            : ""),
        { title: "Rezepte übernommen" }
      );
      rerender();
    };
    akt.append(abbrechen, los);
    box.appendChild(akt);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    feldText.focus();
  }

  // =====================================================================
  // Kleinkram
  // =====================================================================
  function el(tag, klasse, html) {
    const n = document.createElement(tag);
    if (klasse) n.className = klasse;
    if (html !== undefined && html !== null) n.innerHTML = html;
    return n;
  }
  function feld(label, node, hinweis) {
    const l = document.createElement("label");
    l.className = "field";
    l.innerHTML = `<span>${label}</span>`;
    l.appendChild(node);
    if (hinweis) {
      const h = document.createElement("p");
      h.className = "muted small";
      h.innerHTML = hinweis;
      l.appendChild(h);
    }
    return l;
  }
  function eingabe(typ, wert, platzhalter) {
    const i = document.createElement("input");
    i.type = typ;
    i.value = wert === null || wert === undefined ? "" : String(wert);
    if (platzhalter) i.placeholder = platzhalter;
    return i;
  }
  function mehrzeilig(zeilen, platzhalter) {
    const t = document.createElement("textarea");
    t.rows = 5;
    t.value = (zeilen || []).join("\n");
    t.placeholder = platzhalter;
    return t;
  }
  function auswahl(paare, wert) {
    const sel = document.createElement("select");
    for (const [v, label] of paare) {
      const o = document.createElement("option");
      o.value = v;
      o.textContent = label;
      sel.appendChild(o);
    }
    sel.value = wert;
    return sel;
  }

  rerender();
  return container;
}

/** Erkennt Rezepte in eingefügtem JSON oder Text. Als eigene Funktion (und exportiert), damit sich das
 * Erkennen prüfen lässt, ohne eine Oberfläche zu bedienen. */
function leseRezepte(roh) {
  const text = String(roh || "").trim();
  if (!text) return [];

  if (text.startsWith("{") || text.startsWith("[")) {
    let daten;
    try {
      daten = JSON.parse(text);
    } catch {
      throw new Error("Das sieht nach JSON aus, lässt sich aber nicht lesen. Vermutlich fehlt ein Stück am Anfang oder Ende.");
    }
    const liste = findeRezeptListe(daten);
    if (!liste) throw new Error("In dieser Datei war keine Liste von Rezepten zu finden.");
    return liste.map(ausObjekt).filter((r) => r.name);
  }

  // Textform: Blöcke, getrennt durch "---" oder eine Zeile, die mit # beginnt.
  const bloecke = text
    .split(/\n\s*---+\s*\n/)
    .flatMap((b) => (b.includes("\n#") ? b.split(/\n(?=#\s)/) : [b]))
    .map((b) => b.trim())
    .filter(Boolean);
  return bloecke.map(ausText).filter((r) => r.name);
}

/** Sucht in einem beliebigen JSON-Gebilde die erste Liste, die nach Rezepten aussieht. Apps verpacken
 * ihre Daten unterschiedlich tief ({recipes: [...]}, {data: {items: [...]}}), und danach zu raten ist
 * besser, als den Import an einer Verpackung scheitern zu lassen. */
function findeRezeptListe(daten, tiefe = 0) {
  if (tiefe > 4 || !daten) return null;
  if (Array.isArray(daten)) {
    return daten.some((x) => x && typeof x === "object" && (x.name || x.title || x.titel)) ? daten : null;
  }
  if (typeof daten !== "object") return null;
  for (const key of ["recipes", "rezepte", "items", "data", "list", "entries"]) {
    if (daten[key]) {
      const treffer = findeRezeptListe(daten[key], tiefe + 1);
      if (treffer) return treffer;
    }
  }
  for (const wert of Object.values(daten)) {
    const treffer = findeRezeptListe(wert, tiefe + 1);
    if (treffer) return treffer;
  }
  return null;
}

/** Ein Rezept-Objekt aus einer fremden App auf unsere Felder abbilden. Die Namen, die verbreitet sind,
 * werden erkannt; alles andere landet in der Notiz, statt verloren zu gehen. */
function ausObjekt(o) {
  const zeilen = (v) => {
    if (Array.isArray(v)) {
      return v
        .map((x) => {
          if (typeof x === "string") return x;
          if (!x || typeof x !== "object") return "";
          // {menge, einheit, name} oder {quantity, unit, name} – die gängige Form.
          const teile = [x.menge ?? x.amount ?? x.quantity, x.einheit ?? x.unit, x.name ?? x.text ?? x.zutat ?? x.ingredient];
          return teile.filter((t) => t !== undefined && t !== null && String(t).trim() !== "").join(" ");
        })
        .filter(Boolean);
    }
    return String(v || "")
      .split("\n")
      .map((z) => z.replace(/^\s*[-*•]\s*/, "").trim())
      .filter(Boolean);
  };
  return {
    name: String(o?.name ?? o?.title ?? o?.titel ?? "").trim(),
    ergibt: String(o?.ergibt ?? o?.yield ?? o?.servings ?? o?.portionen ?? "").trim(),
    zutaten: zeilen(o?.zutaten ?? o?.ingredients ?? o?.zutatenliste),
    schritte: zeilen(o?.schritte ?? o?.steps ?? o?.instructions ?? o?.zubereitung ?? o?.method),
    notiz: String(o?.notiz ?? o?.note ?? o?.notes ?? o?.description ?? "").trim(),
  };
}

/** Ein Textblock -> Rezept. Erkennt "Zutaten:" und "Schritte:"/"Zubereitung:" als Abschnitte; steht
 * nichts davon drin, gilt alles ab der zweiten Zeile als Zutaten. */
function ausText(block) {
  const zeilen = block.split("\n").map((z) => z.trim());
  const name = (zeilen.shift() || "").replace(/^#+\s*/, "").trim();
  const r = { name, ergibt: "", zutaten: [], schritte: [], notiz: "" };
  let abschnitt = "zutaten";
  for (const z of zeilen) {
    if (!z) continue;
    const klein = z.toLowerCase();
    if (/^(ergibt|menge|yield|portionen)\s*:/.test(klein)) {
      r.ergibt = z.split(":").slice(1).join(":").trim();
      continue;
    }
    if (/^(zutaten|ingredients)\s*:?$/.test(klein)) {
      abschnitt = "zutaten";
      continue;
    }
    if (/^(schritte|zubereitung|so geht.s|steps|anleitung)\s*:?$/.test(klein)) {
      abschnitt = "schritte";
      continue;
    }
    if (/^(notiz|hinweis|note)\s*:/.test(klein)) {
      r.notiz = z.split(":").slice(1).join(":").trim();
      continue;
    }
    r[abschnitt].push(z.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim());
  }
  return r;
}

export { renderKueche, leseRezepte };
