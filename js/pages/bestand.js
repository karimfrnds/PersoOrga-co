// ============================================================================
// pages/bestand.js – „Was fehlt?" am iPad. Die Seite, die dem Team bisher gefehlt hat.
//
// Bisher konnte nur der Admin einen Artikel als leer markieren. Wer im Betrieb die letzte Flasche aus
// dem Kühlschrank nimmt, ist aber nie der Admin – und bis jemand daran denkt, es weiterzugeben, ist es
// vergessen. Deshalb steht diese Seite in der Hauptleiste, ohne PIN, und macht genau eine Sache:
// antippen, bis der Zustand stimmt.
//
// Ein Tipp schaltet weiter: genug → wird knapp → ist leer → genug. Mehr gibt es nicht zu bedienen.
// Keine Mengen, keine Einheiten, kein Zählen – das ist der ganze Punkt an der neuen Bestand-Logik.
// ============================================================================
import { store } from "../store.js";
import { escapeHtml } from "../format.js";

const BEREICHE = [
  { id: "kueche", label: "🍳 Küche" },
  { id: "bar", label: "🍸 Bar" },
];

const STATUS = {
  ok: { label: "genug", klasse: "bestand-ok", rang: 3 },
  knapp: { label: "wird knapp", klasse: "bestand-knapp", rang: 1 },
  leer: { label: "ist leer", klasse: "bestand-leer", rang: 0 },
  bestellt: { label: "bestellt", klasse: "bestand-bestellt", rang: 2 },
};

function renderBestand() {
  const container = document.createElement("div");
  container.className = "page";

  let bereich = "kueche";
  let suche = "";

  function rerender() {
    container.innerHTML = "";
    container.appendChild(build());
  }

  function build() {
    const frag = document.createElement("div");
    frag.innerHTML = `
      <h1>📦 Was fehlt?</h1>
      <p class="muted">Tipp einen Artikel an, wenn er knapp wird oder leer ist. Mehr musst du nicht machen –
      der Chef sieht das sofort und bestellt danach.</p>`;

    frag.appendChild(buildZusammenfassung());
    frag.appendChild(buildBereichswahl());
    frag.appendChild(buildListe());
    return frag;
  }

  function buildZusammenfassung() {
    const box = document.createElement("div");
    const alle = store.getStockItems();
    const leer = alle.filter((s) => s.status === "leer").length;
    const knapp = alle.filter((s) => s.status === "knapp").length;
    if (leer === 0 && knapp === 0) {
      box.className = "callout";
      box.textContent = alle.length === 0 ? "Noch keine Artikel angelegt (Admin → Vorräte)." : "Alles da. Nichts zu melden.";
      return box;
    }
    box.className = "callout" + (leer > 0 ? " callout-warn" : "");
    box.innerHTML =
      (leer > 0 ? `<b>${leer} ${leer === 1 ? "Artikel ist" : "Artikel sind"} leer</b>` : "") +
      (leer > 0 && knapp > 0 ? " · " : "") +
      (knapp > 0 ? `${knapp} ${knapp === 1 ? "wird" : "werden"} knapp` : "");
    return box;
  }

  function buildBereichswahl() {
    const reihe = document.createElement("div");
    reihe.className = "handoff-days";
    for (const b of BEREICHE) {
      const btn = document.createElement("button");
      btn.className = "btn " + (bereich === b.id ? "btn-primary" : "btn-secondary");
      const fehlt = store.getStockNachBereich(b.id).filter((s) => ["leer", "knapp"].includes(s.status)).length;
      btn.textContent = b.label + (fehlt > 0 ? ` (${fehlt})` : "");
      btn.onclick = () => {
        bereich = b.id;
        rerender();
      };
      reihe.appendChild(btn);
    }
    return reihe;
  }

  function buildListe() {
    const card = document.createElement("section");
    card.className = "card";

    const suchfeld = document.createElement("input");
    suchfeld.type = "search";
    suchfeld.placeholder = "Suchen…";
    suchfeld.value = suche;
    // Nur die Liste neu bauen, nicht die ganze Seite: sonst verliert das Feld bei jedem Buchstaben
    // den Fokus und man kann nicht tippen.
    suchfeld.oninput = () => {
      suche = suchfeld.value;
      zeichneZeilen();
    };
    card.appendChild(suchfeld);

    const liste = document.createElement("div");
    liste.className = "bestand-liste";
    card.appendChild(liste);

    function zeichneZeilen() {
      liste.innerHTML = "";
      const begriff = suche.trim().toLowerCase();
      const artikel = store
        .getStockNachBereich(bereich)
        .filter((s) => !begriff || s.name.toLowerCase().includes(begriff));
      if (artikel.length === 0) {
        const leer = document.createElement("p");
        leer.className = "muted small";
        leer.textContent = begriff ? "Nichts gefunden." : "In diesem Bereich ist noch nichts angelegt.";
        liste.appendChild(leer);
        return;
      }
      for (const s of artikel) {
        const zustand = STATUS[s.status] || STATUS.ok;
        const btn = document.createElement("button");
        btn.className = "bestand-zeile " + zustand.klasse;
        btn.innerHTML = `<span class="bestand-name">${escapeHtml(s.name)}</span>
          <span class="bestand-status">${escapeHtml(zustand.label)}</span>`;
        btn.onclick = () => {
          store.setStockStatus(s.id, store.naechsterStockStatus(s.status), "Team");
          rerender();
        };
        liste.appendChild(btn);
      }
    }
    zeichneZeilen();

    const hinweis = document.createElement("p");
    hinweis.className = "muted small";
    hinweis.textContent = "Antippen schaltet weiter: genug → wird knapp → ist leer → genug.";
    card.appendChild(hinweis);
    return card;
  }

  rerender();
  return container;
}

export { renderBestand };
