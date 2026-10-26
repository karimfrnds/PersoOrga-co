// ============================================================================
// pages/produktionAdmin.js – Admin-Tab „Produktion": was hergestellt wird, in welchen Behältern,
// und was gerade wo steht.
//
// Die drei Dinge, die hier zusammenkommen:
//
//   PRODUKTE. Was selbst hergestellt wird, mit Soll-Menge, Haltbarkeit und Gebindegrösse. Das Soll ist
//   die wichtigste Zahl im ganzen Bereich: daran erkennt das System von selbst, dass etwas fehlt, und
//   schreibt es der nächsten Schicht auf die Liste.
//
//   BEHÄLTER. Eine gepflegte Liste statt freier Eingabe. „GN 1/1", „GN1/1" und „gn 1" nebeneinander
//   heisst: niemand findet mehr, wo etwas steht – und genau das soll die Rückverfolgung ja leisten.
//
//   WAS STEHT WO. Die Gegenprobe zum Soll: welcher Behälter enthält gerade was, seit wann, von wem,
//   und wie lange noch. Das ist die Ansicht, die man braucht, wenn jemand fragt "wo ist die Sauce?".
// ============================================================================
import { store } from "../store.js";
import { escapeHtml, dateDe, todayStr } from "../format.js";
import { confirmDialog, alertDialog } from "../dialog.js";
import { zahlText, einheitText, wannText } from "./kueche.js";

const BEREICH_PRODUKTION = "produktion";

function renderProduktionAdmin() {
  const container = document.createElement("div");
  container.className = "page";

  function rerender() {
    const scroll = window.scrollY;
    container.innerHTML = "";
    container.appendChild(build());
    window.scrollTo(0, scroll);
  }

  function build() {
    const frag = document.createElement("div");
    frag.innerHTML = `<h1>Produktion</h1>
      <p class="muted">Was hier hergestellt wird, in welchen Behältern es landet und was gerade wo steht.
      Gezählt wird nichts: der Bestand ist die Summe der nicht leeren Behälter.</p>`;
    frag.appendChild(buildBedarf());
    frag.appendChild(buildProdukte());
    frag.appendChild(buildBehaelter());
    frag.appendChild(buildWasStehtWo());
    return frag;
  }

  // ---------------------------------------------------------------------
  // Was fehlt gerade?
  // ---------------------------------------------------------------------
  function buildBedarf() {
    const card = document.createElement("section");
    card.className = "card";
    const bedarf = store.produktionsBedarf();
    const fehlend = bedarf.filter((b) => b.fehlt > 0);
    const ablauf = store.ablaufendeChargen(2);

    card.innerHTML = `<h2>Jetzt gerade</h2>`;
    if (bedarf.length === 0) {
      card.innerHTML += `<p class="muted small">Noch kein Produktionsprodukt mit Soll-Menge angelegt – deshalb
      kann auch nichts fehlen. Leg unten eines an und trag ein, wie viel davon immer da sein soll.</p>`;
      return card;
    }

    const liste = document.createElement("div");
    liste.className = "mg-liste";
    for (const b of bedarf) {
      const zeile = document.createElement("div");
      zeile.className = "summary-line";
      const knapp = b.fehlt > 0;
      zeile.innerHTML = `<span><b>${escapeHtml(b.prep.name)}</b>${
        b.beauftragt > 0 ? ` <span class="muted small">· ${zahlText(b.beauftragt)} beauftragt</span>` : ""
      }</span><span class="${knapp ? "res-warn" : ""}">${zahlText(b.ist)} / ${zahlText(b.soll)} ${escapeHtml(
        einheitText(b.prep.einheit, b.soll)
      )}${knapp ? ` · <b>${zahlText(b.fehlt)} fehlen</b>` : " · ✓"}</span>`;
      liste.appendChild(zeile);
    }
    card.appendChild(liste);

    if (fehlend.length > 0) {
      const btn = document.createElement("button");
      btn.className = "btn btn-primary";
      btn.textContent = `Aufträge für ${fehlend.length} ${fehlend.length === 1 ? "Produkt" : "Produkte"} anlegen`;
      btn.onclick = async () => {
        const neu = store.ergaenzeProduktionsAuftraege(todayStr());
        await alertDialog(
          neu.length === 0
            ? "Es war schon alles beauftragt."
            : `${neu.length} ${neu.length === 1 ? "Auftrag" : "Aufträge"} angelegt. Sie stehen ab sofort in der Küche auf der Liste.`
        );
        rerender();
      };
      card.appendChild(btn);
      const hinweis = document.createElement("p");
      hinweis.className = "muted small";
      hinweis.textContent =
        "Das passiert auch von selbst, sobald jemand aus der Küche einstempelt – der Knopf ist nur für den Fall, dass du es jetzt sehen willst.";
      card.appendChild(hinweis);
    }

    if (ablauf.length > 0) {
      const warn = document.createElement("div");
      warn.className = "callout callout-warn";
      warn.innerHTML =
        `<b>${ablauf.length} ${ablauf.length === 1 ? "Behälter läuft" : "Behälter laufen"} ab:</b><br>` +
        ablauf
          .slice(0, 6)
          .map((c) => {
            const p = store.getPrep(c.produktId);
            const b = store.getBehaelterById(c.behaelterId);
            const hin = c.mhd < todayStr() ? "abgelaufen" : c.mhd === todayStr() ? "heute" : `bis ${dateDe(c.mhd)}`;
            return `${escapeHtml(p?.name || "?")} in ${escapeHtml(b?.name || "–")}: ${escapeHtml(hin)}`;
          })
          .join("<br>");
      card.appendChild(warn);
    }
    return card;
  }

  // ---------------------------------------------------------------------
  // Produkte
  // ---------------------------------------------------------------------
  function buildProdukte() {
    const card = document.createElement("section");
    card.className = "card";
    card.innerHTML = `<h2>Produktionsprodukte</h2>
      <p class="muted small">Was selbst hergestellt wird. Das <b>Soll</b> ist die Menge, die immer da sein
      soll – fällt der Bestand darunter, legt das System von selbst einen Auftrag an. Das <b>Gebinde</b>
      ist die Portion, in der produziert wird: Aufträge werden darauf aufgerundet.</p>`;

    const alle = store.getPreps(false, BEREICH_PRODUKTION);
    if (alle.length === 0) {
      const leer = document.createElement("p");
      leer.className = "muted small";
      leer.textContent = "Noch nichts angelegt.";
      card.appendChild(leer);
    } else {
      const scroll = document.createElement("div");
      scroll.style.overflowX = "auto";
      const tabelle = document.createElement("table");
      tabelle.className = "calc-table";
      tabelle.innerHTML = `<thead><tr><th>Produkt</th><th>Ist / Soll</th><th>Gebinde</th><th>Haltbar</th><th>Rezept</th><th></th></tr></thead>`;
      const tbody = document.createElement("tbody");
      for (const p of alle) {
        const ist = store.istMenge(p.id);
        const status = store.prepStatus(p);
        const rezept = p.rezeptId ? store.getRecipes().find((r) => r.id === p.rezeptId) : null;
        const tr = document.createElement("tr");
        if (!p.aktiv) tr.style.opacity = "0.5";
        tr.innerHTML = `
          <td><b>${escapeHtml(p.name)}</b>${p.aktiv ? "" : ' <span class="badge badge-gray">stillgelegt</span>'}</td>
          <td class="${status === "ok" ? "" : "res-warn"}">${zahlText(ist || 0)} / ${zahlText(p.soll)} ${escapeHtml(einheitText(p.einheit, p.soll))}</td>
          <td>${p.gebinde > 0 ? `${zahlText(p.gebinde)} ${escapeHtml(einheitText(p.einheit, p.gebinde))}` : "–"}</td>
          <td>${p.haltbarkeitTage > 0 ? `${p.haltbarkeitTage} ${p.haltbarkeitTage === 1 ? "Tag" : "Tage"}` : "–"}</td>
          <td class="muted small">${rezept ? escapeHtml(rezept.name) : "–"}</td>`;
        const td = document.createElement("td");
        const btn = document.createElement("button");
        btn.className = "btn btn-secondary";
        btn.textContent = "Ändern";
        btn.onclick = () => openProdukt(p);
        td.appendChild(btn);
        tr.appendChild(td);
        tbody.appendChild(tr);
      }
      tabelle.appendChild(tbody);
      scroll.appendChild(tabelle);
      card.appendChild(scroll);
    }

    const neu = document.createElement("button");
    neu.className = "btn btn-primary";
    neu.textContent = "＋ Produktionsprodukt";
    neu.onclick = () => openProdukt(null);
    card.appendChild(neu);
    return card;
  }

  function feld(label, node, hinweis) {
    const l = document.createElement("label");
    l.className = "field";
    l.innerHTML = `<span>${label}</span>`;
    l.appendChild(node);
    if (hinweis) {
      const h = document.createElement("p");
      h.className = "muted small";
      h.textContent = hinweis;
      l.appendChild(h);
    }
    return l;
  }
  const textFeld = (wert, platzhalter = "") => Object.assign(document.createElement("input"), { type: "text", value: wert ?? "", placeholder: platzhalter });
  const zahlFeld = (wert, platzhalter = "") => {
    const i = Object.assign(document.createElement("input"), { type: "text", value: wert ? zahlText(wert) : "", placeholder: platzhalter });
    i.inputMode = "decimal";
    return i;
  };
  const auswahl = (paare, wert) => {
    const sel = document.createElement("select");
    for (const [v, t] of paare) {
      const o = document.createElement("option");
      o.value = v;
      o.textContent = t;
      if (String(v) === String(wert)) o.selected = true;
      sel.appendChild(o);
    }
    return sel;
  };
  const zahl = (feldNode) => Number(String(feldNode.value).replace(",", ".")) || 0;

  function openProdukt(vorhanden) {
    const overlay = document.createElement("div");
    overlay.className = "overlay";
    const box = document.createElement("div");
    box.className = "dialog";
    box.innerHTML = `<h2>${vorhanden ? "Produkt ändern" : "Neues Produktionsprodukt"}</h2>`;

    const name = textFeld(vorhanden?.name, "z.B. Zimtschnecken-Teig");
    const einheit = auswahl(store.PREP_EINHEITEN.map((e) => [e, e]), vorhanden?.einheit || "Blech");
    const soll = zahlFeld(vorhanden?.soll, "z.B. 4");
    const gebinde = zahlFeld(vorhanden?.gebinde, "z.B. 1");
    const haltbar = zahlFeld(vorhanden?.haltbarkeitTage, "z.B. 3");
    const rezept = auswahl([["", "– kein Rezept –"], ...store.getRecipes().map((r) => [r.id, r.name])], vorhanden?.rezeptId || "");
    const standard = auswahl([["", "– keiner –"], ...store.getBehaelter(true).map((b) => [b.id, b.name])], vorhanden?.standardBehaelterId || "");
    const notiz = textFeld(vorhanden?.notiz, "z.B. kühl stellen, nicht stapeln");
    const aktiv = Object.assign(document.createElement("input"), { type: "checkbox", checked: vorhanden ? vorhanden.aktiv !== false : true });

    box.appendChild(feld("Produkt", name));
    const r1 = document.createElement("div");
    r1.className = "res-form-row";
    r1.append(feld("Soll (immer da)", soll), feld("Einheit", einheit));
    box.appendChild(r1);
    const r2 = document.createElement("div");
    r2.className = "res-form-row";
    r2.append(
      feld("Gebinde", gebinde, "Die Portion, in der produziert wird. Aufträge werden darauf aufgerundet."),
      feld("Haltbar (Tage)", haltbar, "0 = kein MHD und keine Ablauf-Warnung.")
    );
    box.appendChild(r2);
    box.appendChild(feld("Rezept", rezept));
    box.appendChild(feld("Standard-Behälter", standard, "Beim Eintragen vorausgewählt – änderbar."));
    box.appendChild(feld("Notiz", notiz));
    const aktivZeile = document.createElement("label");
    aktivZeile.className = "field-checkbox";
    aktivZeile.append(aktiv, document.createTextNode(" Wird produziert (ausschalten, statt zu löschen – die Chargen bleiben)"));
    box.appendChild(aktivZeile);

    const akt = document.createElement("div");
    akt.className = "dialog-actions";
    const abbrechen = document.createElement("button");
    abbrechen.className = "btn btn-secondary";
    abbrechen.textContent = "Abbrechen";
    abbrechen.onclick = () => overlay.remove();
    const speichern = document.createElement("button");
    speichern.className = "btn btn-primary";
    speichern.textContent = "Speichern";
    speichern.onclick = async () => {
      if (!name.value.trim()) return alertDialog("Bitte einen Namen eintragen.");
      const daten = {
        name: name.value.trim(),
        bereich: BEREICH_PRODUKTION,
        produzierbar: true,
        einheit: einheit.value,
        soll: zahl(soll),
        gebinde: zahl(gebinde),
        haltbarkeitTage: Math.round(zahl(haltbar)),
        rezeptId: rezept.value || null,
        standardBehaelterId: standard.value || null,
        notiz: notiz.value.trim(),
        aktiv: aktiv.checked,
      };
      if (vorhanden) store.updatePrep(vorhanden.id, daten);
      else store.addPrep(daten);
      overlay.remove();
      rerender();
    };
    akt.append(abbrechen, speichern);
    box.appendChild(akt);

    if (vorhanden) {
      const unten = document.createElement("div");
      unten.className = "res-dialog-danger";
      const weg = document.createElement("button");
      weg.className = "btn btn-link";
      weg.textContent = "Löschen";
      weg.onclick = async () => {
        const chargen = store.getChargen({ produktId: vorhanden.id }).length;
        if (chargen > 0) {
          await alertDialog(
            `Dazu gibt es ${chargen} ${chargen === 1 ? "Charge" : "Chargen"} – die sind die Rückverfolgung und bleiben. ` +
              "Stell das Produkt stattdessen auf „wird nicht produziert“, dann verschwindet es aus den Listen."
          );
          return;
        }
        if (!(await confirmDialog(`„${vorhanden.name}“ löschen?`, { danger: true, okLabel: "Löschen" }))) return;
        store.removePrep(vorhanden.id);
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
  // Behälter
  // ---------------------------------------------------------------------
  function buildBehaelter() {
    const card = document.createElement("section");
    card.className = "card";
    card.innerHTML = `<h2>Behälter</h2>
      <p class="muted small">Worin das Produzierte landet. Nummeriert und beschriftet, damit „wo steht
      die Sauce?“ eine Antwort hat. Nicht frei tippbar – sonst stehen „GN 1/1“ und „gn1“ nebeneinander.</p>`;

    const alle = store.getBehaelter(false);
    if (alle.length === 0) {
      const leer = document.createElement("p");
      leer.className = "muted small";
      leer.textContent = "Noch kein Behälter angelegt.";
      card.appendChild(leer);
    } else {
      const liste = document.createElement("div");
      liste.className = "task-list";
      for (const b of alle) {
        const inhalt = store.inhaltVon(b.id);
        const p = inhalt ? store.getPrep(inhalt.produktId) : null;
        const row = document.createElement("div");
        row.className = "task-row";
        row.innerHTML = `<div class="task-row-text"><span><b>${escapeHtml(b.name)}</b>${
          b.aktiv ? "" : ' <span class="badge badge-gray">stillgelegt</span>'
        }</span><span class="muted small task-row-meta">${[b.groesse, b.ort].filter(Boolean).map(escapeHtml).join(" · ") || "ohne Angabe"}${
          inhalt ? ` · <b>belegt: ${escapeHtml(p?.name || "?")}</b>` : " · frei"
        }</span></div>`;
        const btn = document.createElement("button");
        btn.className = "btn btn-secondary";
        btn.textContent = "Ändern";
        btn.onclick = () => openBehaelter(b);
        row.appendChild(btn);
        liste.appendChild(row);
      }
      card.appendChild(liste);
    }

    const neu = document.createElement("button");
    neu.className = "btn btn-primary";
    neu.textContent = "＋ Behälter";
    neu.onclick = () => openBehaelter(null);
    card.appendChild(neu);

    // Mehrere auf einmal: eine Küche hat selten einen Behälter, sondern zehn gleiche.
    const viele = document.createElement("button");
    viele.className = "btn btn-secondary";
    viele.textContent = "＋ Mehrere auf einmal";
    viele.onclick = () => openBehaelterSerie();
    card.appendChild(viele);
    return card;
  }

  function openBehaelter(vorhanden) {
    const overlay = document.createElement("div");
    overlay.className = "overlay";
    const box = document.createElement("div");
    box.className = "dialog";
    box.innerHTML = `<h2>${vorhanden ? "Behälter ändern" : "Neuer Behälter"}</h2>`;
    const name = textFeld(vorhanden?.name, "z.B. GN 1/1 – 3");
    const groesse = textFeld(vorhanden?.groesse, "z.B. 10 L");
    const ort = textFeld(vorhanden?.ort, "z.B. Kühlhaus, Regal 2");
    const aktiv = Object.assign(document.createElement("input"), { type: "checkbox", checked: vorhanden ? vorhanden.aktiv !== false : true });
    box.appendChild(feld("Name", name, "Eindeutig und am Behälter lesbar – beschrifte ihn genauso."));
    const r = document.createElement("div");
    r.className = "res-form-row";
    r.append(feld("Grösse", groesse), feld("Steht normalerweise", ort));
    box.appendChild(r);
    const aktivZeile = document.createElement("label");
    aktivZeile.className = "field-checkbox";
    aktivZeile.append(aktiv, document.createTextNode(" In Benutzung"));
    box.appendChild(aktivZeile);

    const akt = document.createElement("div");
    akt.className = "dialog-actions";
    const abbrechen = document.createElement("button");
    abbrechen.className = "btn btn-secondary";
    abbrechen.textContent = "Abbrechen";
    abbrechen.onclick = () => overlay.remove();
    const speichern = document.createElement("button");
    speichern.className = "btn btn-primary";
    speichern.textContent = "Speichern";
    speichern.onclick = async () => {
      if (!name.value.trim()) return alertDialog("Bitte einen Namen eintragen.");
      const daten = { name: name.value.trim(), groesse: groesse.value.trim(), ort: ort.value.trim(), aktiv: aktiv.checked };
      if (vorhanden) store.updateBehaelter(vorhanden.id, daten);
      else store.addBehaelter(daten);
      overlay.remove();
      rerender();
    };
    akt.append(abbrechen, speichern);
    box.appendChild(akt);

    if (vorhanden) {
      const unten = document.createElement("div");
      unten.className = "res-dialog-danger";
      const weg = document.createElement("button");
      weg.className = "btn btn-link";
      weg.textContent = "Löschen";
      weg.onclick = async () => {
        if (store.inhaltVon(vorhanden.id)) {
          await alertDialog("In diesem Behälter steht noch etwas. Trag ihn erst als leer ein.");
          return;
        }
        if (!(await confirmDialog(`„${vorhanden.name}“ löschen?`, { danger: true, okLabel: "Löschen" }))) return;
        store.removeBehaelter(vorhanden.id);
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

  /** Zehn gleiche Behälter einzeln anzulegen ist Arbeit ohne Erkenntnis. */
  function openBehaelterSerie() {
    const overlay = document.createElement("div");
    overlay.className = "overlay";
    const box = document.createElement("div");
    box.className = "dialog";
    box.innerHTML = `<h2>Mehrere Behälter</h2><p class="muted small">Legt durchnummerierte Behälter an,
      z.B. „GN 1/1 – 1“ bis „GN 1/1 – 6“.</p>`;
    const basis = textFeld("", "z.B. GN 1/1");
    const anzahl = zahlFeld(6, "6");
    const groesse = textFeld("", "z.B. 10 L");
    const ort = textFeld("", "z.B. Kühlhaus");
    const r = document.createElement("div");
    r.className = "res-form-row";
    r.append(feld("Name", basis), feld("Anzahl", anzahl));
    box.appendChild(r);
    const r2 = document.createElement("div");
    r2.className = "res-form-row";
    r2.append(feld("Grösse", groesse), feld("Steht normalerweise", ort));
    box.appendChild(r2);

    const akt = document.createElement("div");
    akt.className = "dialog-actions";
    const abbrechen = document.createElement("button");
    abbrechen.className = "btn btn-secondary";
    abbrechen.textContent = "Abbrechen";
    abbrechen.onclick = () => overlay.remove();
    const speichern = document.createElement("button");
    speichern.className = "btn btn-primary";
    speichern.textContent = "Anlegen";
    speichern.onclick = async () => {
      const b = basis.value.trim();
      const n = Math.round(zahl(anzahl));
      if (!b) return alertDialog("Bitte einen Namen eintragen.");
      if (n < 1 || n > 50) return alertDialog("Bitte eine Anzahl zwischen 1 und 50.");
      const vorhanden = new Set(store.getBehaelter(false).map((x) => x.name));
      let angelegt = 0;
      for (let i = 1; i <= n; i++) {
        const name = `${b} – ${i}`;
        if (vorhanden.has(name)) continue; // zweimal derselbe Name waere genau das Chaos, das wir vermeiden
        store.addBehaelter({ name, groesse: groesse.value.trim(), ort: ort.value.trim() });
        angelegt++;
      }
      overlay.remove();
      if (angelegt < n) await alertDialog(`${angelegt} angelegt – ${n - angelegt} gab es schon unter demselben Namen.`);
      rerender();
    };
    akt.append(abbrechen, speichern);
    box.appendChild(akt);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    basis.focus();
  }

  // ---------------------------------------------------------------------
  // Was steht wo?
  // ---------------------------------------------------------------------
  function buildWasStehtWo() {
    const card = document.createElement("section");
    card.className = "card";
    const offen = store.offeneChargen();
    card.innerHTML = `<h2>Was steht wo</h2>
      <p class="muted small">Alle Behälter, in denen gerade etwas ist – seit wann, von wem, und wie lange noch.</p>`;
    if (offen.length === 0) {
      const leer = document.createElement("p");
      leer.className = "muted small";
      leer.textContent = "Gerade steht nichts eingetragen – entweder ist alles leer, oder es wurde noch nichts erfasst.";
      card.appendChild(leer);
      return card;
    }
    const scroll = document.createElement("div");
    scroll.style.overflowX = "auto";
    const tabelle = document.createElement("table");
    tabelle.className = "calc-table";
    tabelle.innerHTML = `<thead><tr><th>Behälter</th><th>Inhalt</th><th>Menge</th><th>Von</th><th>Seit</th><th>Haltbar bis</th></tr></thead>`;
    const tbody = document.createElement("tbody");
    for (const c of offen) {
      const p = store.getPrep(c.produktId);
      const b = store.getBehaelterById(c.behaelterId);
      const abgelaufen = c.mhd && c.mhd < todayStr();
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td><b>${escapeHtml(b?.name || "– ohne Behälter –")}</b>${c.ort ? `<br><span class="muted small">${escapeHtml(c.ort)}</span>` : ""}</td>
        <td>${escapeHtml(p?.name || "?")}</td>
        <td>${zahlText(c.menge)} ${escapeHtml(einheitText(c.einheit, c.menge))}</td>
        <td class="muted small">${escapeHtml(c.vonName || "–")}</td>
        <td class="muted small">${escapeHtml(wannText(c.am))}</td>
        <td class="${abgelaufen ? "res-warn" : ""}">${c.mhd ? escapeHtml(dateDe(c.mhd)) + (abgelaufen ? " ⚠" : "") : "–"}</td>`;
      tbody.appendChild(tr);
    }
    tabelle.appendChild(tbody);
    scroll.appendChild(tabelle);
    card.appendChild(scroll);
    return card;
  }

  rerender();
  return container;
}

export { renderProduktionAdmin };
