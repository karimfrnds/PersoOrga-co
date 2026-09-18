// ============================================================================
// pages/bestandAdmin.js – Admin-Tab „Soll-Bestand": welche Artikel Küche und Bar zählen, und wie viel
// davon mindestens da sein soll.
//
// Hier legt der Chef fest, gezählt wird woanders: im persönlichen Fenster am iPad und am Handy. Deshalb
// steht hier neben dem Soll auch gleich der letzte Stand – wer das Soll festlegt, will sehen, wie weit die
// Wirklichkeit davon weg ist.
// ============================================================================
import { store } from "../store.js";
import { escapeHtml } from "../format.js";
import { openPrepForm, zahlText, einheitText, wannText } from "./kueche.js";

function renderBestandAdmin() {
  const container = document.createElement("div");
  container.className = "page";

  function rerender() {
    container.innerHTML = "";
    container.appendChild(build());
  }

  function build() {
    const frag = document.createElement("div");
    frag.innerHTML = `
      <h1>Soll-Bestand</h1>
      <p class="muted">Welche Artikel gezählt werden und was mindestens da sein soll. Gezählt wird im
      persönlichen Fenster am iPad und am Handy: <b>Küche</b> vom Küchen-Team, <b>Bar</b> von Bar und Service,
      <b>Divers</b> von der Store-Managerin – sie sieht alle drei.</p>
      <p class="muted small">Einen festen Zähltag legst du unter <b>Aufgaben</b> an: Standard-Aufgabe, z.B.
      „Bar zählen“ für Dienstag, und bei „Mit Bestand verknüpft“ die Bar wählen. Dann steht am Dienstag
      „Heute wird gezählt“ – und die Aufgabe hakt sich ab, sobald jemand die Zählung abschließt.</p>`;

    for (const b of store.BESTAND_BEREICHE) frag.appendChild(buildBereich(b));
    return frag;
  }

  function buildBereich(b) {
    const card = document.createElement("section");
    card.className = "card";
    const alle = store.getPreps(false, b.id);
    const letzte = store.letzteZaehlung(b.id);
    const faellig = store.zaehlungFaellig(b.id);
    card.innerHTML = `<h2>${b.symbol} ${escapeHtml(b.label)} <span class="muted small">(${alle.filter((p) => p.aktiv).length})</span></h2>
      <p class="muted small">${
        letzte ? `Letzte abgeschlossene Zählung: ${escapeHtml(letzte.by || "?")}, ${escapeHtml(wannText(letzte.at))}` : "Noch keine abgeschlossene Zählung."
      }${faellig ? " · <b>heute ist Zählen dran</b>" : ""}</p>`;

    if (alle.length === 0) {
      const leer = document.createElement("p");
      leer.className = "muted small";
      leer.textContent = "Noch keine Artikel.";
      card.appendChild(leer);
    } else {
      const scroll = document.createElement("div");
      scroll.style.overflowX = "auto";
      const tabelle = document.createElement("table");
      tabelle.className = "calc-table";
      tabelle.innerHTML = `<thead><tr><th>Artikel</th><th>Ist / Soll</th><th>Zuletzt</th><th></th></tr></thead>`;
      const tbody = document.createElement("tbody");
      for (const p of alle) {
        const status = store.prepStatus(p);
        const tr = document.createElement("tr");
        if (!p.aktiv) tr.style.opacity = "0.5";
        const ist = p.bestand ? zahlText(p.bestand.menge) : "–";
        const farbe = status === "leer" ? "res-warn" : status === "knapp" ? "res-warn" : "";
        tr.innerHTML = `
          <td><b>${escapeHtml(p.name)}</b>${p.aktiv ? "" : ' <span class="badge badge-gray">wird nicht gezählt</span>'}</td>
          <td class="${farbe}">${ist} / ${zahlText(p.soll)} ${escapeHtml(einheitText(p.einheit, p.soll))}</td>
          <td class="muted small">${p.bestand ? `${escapeHtml(wannText(p.bestand.at))}${p.bestand.by ? " · " + escapeHtml(p.bestand.by) : ""}` : "nie"}</td>`;
        const td = document.createElement("td");
        const aendern = document.createElement("button");
        aendern.className = "btn btn-secondary";
        aendern.textContent = "Ändern";
        aendern.onclick = () => openPrepForm(p, { onChange: rerender });
        td.appendChild(aendern);
        tr.appendChild(td);
        tbody.appendChild(tr);
      }
      tabelle.appendChild(tbody);
      scroll.appendChild(tabelle);
      card.appendChild(scroll);
    }

    const neu = document.createElement("button");
    neu.className = "btn btn-primary";
    neu.textContent = `＋ Artikel für ${b.label}`;
    neu.onclick = () => openPrepForm(null, { onChange: rerender, bereich: b.id });
    card.appendChild(neu);
    return card;
  }

  rerender();
  return container;
}

export { renderBestandAdmin };
