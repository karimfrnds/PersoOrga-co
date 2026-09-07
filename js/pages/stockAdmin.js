// ============================================================================
// pages/stockAdmin.js – Admin-Tab „Vorräte": die Artikel-Liste pflegen.
//
// Hier stehen nur noch die vier Angaben, die eine Bestellung braucht: Name, Bereich, Lieferant und in
// welcher Einheit bestellt wird – plus, wie viel davon in einer normalen Woche weggeht. Aus dem letzten
// entsteht die Standard-Bestellliste am Laptop.
//
// Was das Team im Betrieb macht (knapp/leer melden), passiert nicht hier, sondern unter „Bestand" in der
// Hauptleiste. Diese Seite ist Verwaltung und wird selten gebraucht.
// ============================================================================
import { store } from "../store.js";
import { escapeHtml } from "../format.js";
import { confirmDialog } from "../dialog.js";
import { nameAehnlichkeit } from "../nameMatch.js";

const STATUS_LABEL = { ok: "✅ Genug da", knapp: "🟠 Wird knapp", leer: "🔴 Leer", bestellt: "📦 Bestellt" };

function renderStockAdmin() {
  const container = document.createElement("div");
  container.className = "page";
  let bearbeite = null; // id oder "neu"

  function rerender() {
    container.innerHTML = "";
    container.appendChild(build());
  }

  function build() {
    const frag = document.createElement("div");
    frag.innerHTML = `
      <h1>📦 Vorräte</h1>
      <p class="muted">Die Artikel, die das Team unter „Bestand“ als knapp oder leer melden kann.
      Wochenmenge heißt: wie viel davon in einer normalen Woche weggeht – daraus entsteht am Laptop die
      Standard-Bestellliste.</p>`;
    frag.appendChild(buildForm());
    frag.appendChild(buildDoppelte());
    frag.appendChild(buildListe());
    frag.appendChild(buildAufraeumen());
    return frag;
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

  function buildForm() {
    const vorhanden = bearbeite && bearbeite !== "neu" ? store.getStockItems().find((s) => s.id === bearbeite) : null;
    const card = document.createElement("section");
    card.className = "card";
    card.innerHTML = `<h2>${vorhanden ? "Artikel ändern" : "Neuer Artikel"}</h2>`;

    const name = document.createElement("input");
    name.type = "text";
    name.placeholder = "z.B. Paulaner Hefeweizen";
    name.value = vorhanden?.name || "";

    const lieferant = document.createElement("input");
    lieferant.type = "text";
    lieferant.placeholder = "z.B. METRO";
    lieferant.value = vorhanden?.lieferant || "";
    lieferant.setAttribute("list", "lieferanten-vorschlaege");
    const datalist = document.createElement("datalist");
    datalist.id = "lieferanten-vorschlaege";
    for (const l of store.getLieferanten()) {
      const o = document.createElement("option");
      o.value = l;
      datalist.appendChild(o);
    }

    const menge = document.createElement("input");
    menge.type = "text";
    menge.placeholder = "z.B. 1 Kasten";
    menge.value = vorhanden?.bestellmenge || "";

    const woche = document.createElement("input");
    woche.type = "number";
    woche.min = "0";
    woche.step = "0.5";
    woche.inputMode = "decimal";
    woche.value = vorhanden ? String(vorhanden.wochenmenge || 0) : "0";

    const bereich = document.createElement("select");
    for (const [wert, label] of [["kueche", "🍳 Küche"], ["bar", "🍸 Bar"]]) {
      const o = document.createElement("option");
      o.value = wert;
      o.textContent = label;
      bereich.appendChild(o);
    }
    bereich.value = vorhanden?.bereich === "bar" ? "bar" : "kueche";

    const reihe = document.createElement("div");
    reihe.className = "res-form-row";
    reihe.append(feld("Artikel", name), feld("Lieferant", lieferant), feld("Bestellmenge", menge), feld("Bereich", bereich));
    card.append(datalist, reihe);
    card.appendChild(
      feld("Pro Woche", woche, "Wie viele Bestellmengen in einer normalen Woche weggehen. 0 = kommt nur auf die Liste, wenn jemand meldet.")
    );

    const hinweis = document.createElement("p");
    hinweis.className = "muted small";
    card.appendChild(hinweis);

    const akt = document.createElement("div");
    akt.className = "employee-actions";
    const speichern = document.createElement("button");
    speichern.className = "btn btn-primary btn-huge";
    speichern.textContent = vorhanden ? "Speichern" : "＋ Hinzufügen";
    speichern.onclick = () => {
      if (!name.value.trim()) {
        hinweis.className = "res-warn small";
        hinweis.textContent = "Bitte einen Artikelnamen angeben.";
        return;
      }
      const felder = {
        name: name.value,
        lieferant: lieferant.value,
        bestellmenge: menge.value,
        wochenmenge: woche.value,
        bereich: bereich.value,
      };
      if (vorhanden) store.updateStockItem(vorhanden.id, felder);
      else store.addStockItem(felder.name, felder);
      bearbeite = null;
      rerender();
    };
    akt.appendChild(speichern);
    if (vorhanden) {
      const abbrechen = document.createElement("button");
      abbrechen.className = "btn btn-link";
      abbrechen.textContent = "Abbrechen";
      abbrechen.onclick = () => {
        bearbeite = null;
        rerender();
      };
      akt.appendChild(abbrechen);
    }
    card.appendChild(akt);
    return card;
  }

  /** Doppelgänger zusammenführen. Ohne Mengen ist das eine reine Namenssache: der eine verschwindet, sein
   * Name bleibt als Zweitname, damit ein Beleg ihn künftig richtig zuordnet. */
  function buildDoppelte() {
    const card = document.createElement("section");
    card.className = "card";
    const alle = store.getStockItems();
    const paare = [];
    for (let i = 0; i < alle.length; i++) {
      for (let j = i + 1; j < alle.length; j++) {
        if (store.istAlsVerschiedenMarkiert(alle[i].id, alle[j].id)) continue;
        const punkte = nameAehnlichkeit(alle[i].name, alle[j].name);
        if (punkte >= 0.45) paare.push({ a: alle[i], b: alle[j], punkte });
      }
    }
    if (paare.length === 0) {
      card.style.display = "none";
      return card;
    }
    paare.sort((x, y) => y.punkte - x.punkte);
    card.innerHTML = `<h2>🔗 Sieht doppelt aus</h2>
      <p class="muted small">Der gewählte Name bleibt, der andere wird als Zweitname gemerkt und künftig
      automatisch erkannt.</p>`;
    const liste = document.createElement("div");
    liste.className = "task-list";
    for (const p of paare.slice(0, 6)) {
      const row = document.createElement("div");
      row.className = "task-row";
      row.innerHTML = `<div class="task-row-text"><span><b>${escapeHtml(p.a.name)}</b> ↔ <b>${escapeHtml(p.b.name)}</b></span>
        <span class="muted small task-row-meta">${Math.round(p.punkte * 100)} % ähnlich</span></div>`;
      const akt = document.createElement("div");
      akt.className = "employee-actions";
      for (const [behalten, weg] of [[p.a, p.b], [p.b, p.a]]) {
        const btn = document.createElement("button");
        btn.className = "btn btn-secondary";
        btn.textContent = `${behalten.name} behalten`;
        btn.onclick = async () => {
          if (!(await confirmDialog(`„${weg.name}“ verschwindet und wird zu „${behalten.name}“.`,
            { title: "Dasselbe?", okLabel: "Zusammenführen" }))) return;
          store.mergeStockItem(weg.id, behalten.id);
          rerender();
        };
        akt.appendChild(btn);
      }
      const verschieden = document.createElement("button");
      verschieden.className = "btn btn-link";
      verschieden.textContent = "Ist nicht dasselbe";
      verschieden.onclick = () => {
        store.markNotSame(p.a.id, p.b.id);
        rerender();
      };
      akt.appendChild(verschieden);
      row.appendChild(akt);
      liste.appendChild(row);
    }
    card.appendChild(liste);
    return card;
  }

  function buildListe() {
    const card = document.createElement("section");
    card.className = "card";
    card.innerHTML = `<h2>Artikel-Liste</h2>`;
    const items = store.getStockItems();
    if (items.length === 0) {
      card.innerHTML += `<p class="muted small">Noch keine Artikel angelegt.</p>`;
      return card;
    }
    const liste = document.createElement("div");
    liste.className = "task-list";
    for (const item of items) {
      const row = document.createElement("div");
      row.className = "task-row";
      const meta = [
        STATUS_LABEL[item.status] || item.status,
        item.lieferant || "ohne Lieferant",
        item.bestellmenge || null,
        item.wochenmenge > 0 ? `${String(item.wochenmenge).replace(".", ",")}× pro Woche` : null,
        item.bereich === "bar" ? "Bar" : "Küche",
      ].filter(Boolean);
      row.innerHTML = `<div class="task-row-text"><span><b>${escapeHtml(item.name)}</b></span>
        <span class="muted small task-row-meta">${escapeHtml(meta.join(" · "))}</span></div>`;
      const akt = document.createElement("div");
      akt.className = "employee-actions";
      const aendern = document.createElement("button");
      aendern.className = "btn btn-secondary";
      aendern.textContent = "Ändern";
      aendern.onclick = () => {
        bearbeite = item.id;
        rerender();
        container.scrollIntoView({ block: "start" });
      };
      const weg = document.createElement("button");
      weg.className = "btn btn-link";
      weg.textContent = "✕";
      weg.onclick = async () => {
        if (!(await confirmDialog(`Artikel „${item.name}“ löschen?`, { danger: true, okLabel: "Löschen" }))) return;
        store.removeStockItem(item.id);
        rerender();
      };
      akt.append(aendern, weg);
      row.appendChild(akt);
      liste.appendChild(row);
    }
    card.appendChild(liste);
    return card;
  }

  function buildAufraeumen() {
    const card = document.createElement("section");
    card.className = "card";
    const anzahl = store.getStockItems().length;
    if (anzahl === 0) {
      card.style.display = "none";
      return card;
    }
    card.innerHTML = `<h2>🧹 Aufräumen</h2>
      <p class="muted small">Alle ${anzahl} Artikel auf einmal löschen – etwa um die Liste neu aufzubauen.
      <b>Das lässt sich nicht rückgängig machen.</b></p>`;
    const btn = document.createElement("button");
    btn.className = "btn btn-secondary";
    btn.textContent = `Alle ${anzahl} Artikel löschen`;
    btn.onclick = async () => {
      if (!(await confirmDialog(`Wirklich alle ${anzahl} Artikel löschen?`, { danger: true, okLabel: "Endgültig löschen" }))) return;
      store.clearStockData({ artikel: true });
      rerender();
    };
    card.appendChild(btn);
    return card;
  }

  rerender();
  return container;
}

export { renderStockAdmin };
