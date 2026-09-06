// ============================================================================
// chef/bestellung.js – Die Bestellliste am Laptop.
//
// Das ist der neue Bestand. Er führt bewusst KEINE Mengen mehr: eine Mengenführung stimmt nur, solange
// jede Lieferung und jeder Verbrauch eingetragen wird, und das passiert im Betrieb nie vollständig.
// Danach ist die Zahl falsch, man traut ihr nicht mehr, und die ganze Pflege war umsonst.
//
// Gebraucht wird ohnehin etwas anderes: eine fertige Liste, bei wem was bestellt werden muss. Die
// entsteht hier aus dem, was das Team am iPad im Vorbeigehen antippt – gruppiert nach Lieferant, weil
// man bei METRO und beim Getränkehändler getrennt bestellt.
// ============================================================================
import { escapeHtml } from "../format.js";
import { stockItemAction } from "./api.js";

const STATUS = {
  leer: { label: "leer", klasse: "res-warn" },
  knapp: { label: "wird knapp", klasse: "" },
  bestellt: { label: "bestellt", klasse: "muted" },
  ok: { label: "genug", klasse: "muted" },
};

/** "vor 3 Tagen" liest sich schneller als ein Datum – und genau darum geht es hier: ist das lange her? */
function seit(iso) {
  if (!iso) return null;
  const tage = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  if (tage <= 0) return "heute";
  if (tage === 1) return "gestern";
  return `vor ${tage} Tagen`;
}

function renderBestellung(state, { onChanged }) {
  const el = document.createElement("div");
  let bearbeite = null; // id eines Artikels, der gerade bearbeitet wird, oder "neu"

  function rerender() {
    el.innerHTML = "";
    el.appendChild(build());
  }

  const alleArtikel = () => (Array.isArray(state.stock) ? state.stock : []);

  function build() {
    const frag = document.createElement("div");
    frag.innerHTML = `
      <h1>📦 Bestellung</h1>
      <p class="muted">Was das Team am iPad als knapp oder leer gemeldet hat – sortiert nach Lieferant.
      Keine Mengen, keine Inventur: nur, was raus muss.</p>`;
    frag.appendChild(buildListe());
    frag.appendChild(buildArtikelverwaltung());
    return frag;
  }

  /** Dieselbe Gruppierung wie im Store (getBestellliste), hier auf den Daten, die der Worker liefert. */
  function bestellliste() {
    const offen = alleArtikel().filter((s) => ["knapp", "leer", "bestellt"].includes(s.status));
    const gruppen = new Map();
    for (const s of offen) {
      const key = s.lieferant || "";
      if (!gruppen.has(key)) gruppen.set(key, []);
      gruppen.get(key).push(s);
    }
    const RANG = { leer: 0, knapp: 1, bestellt: 2 };
    return [...gruppen.entries()]
      .map(([lieferant, artikel]) => ({
        lieferant,
        artikel: artikel.sort((a, b) => RANG[a.status] - RANG[b.status] || a.name.localeCompare(b.name)),
        dringend: artikel.filter((a) => a.status === "leer").length,
        offen: artikel.filter((a) => a.status !== "bestellt").length,
      }))
      // Ohne Lieferant immer ganz nach unten – das ist keine Bestellung, sondern eine Zuordnung, die
      // noch fehlt. Darunter die Lieferanten mit dringenden Sachen zuerst.
      .sort(
        (a, b) =>
          (a.lieferant === "" ? 1 : 0) - (b.lieferant === "" ? 1 : 0) ||
          b.dringend - a.dringend ||
          a.lieferant.localeCompare(b.lieferant)
      );
  }

  function buildListe() {
    const card = document.createElement("section");
    card.className = "card";
    const status = document.createElement("p");
    status.className = "muted small";

    const gruppen = bestellliste();
    const gesamtOffen = gruppen.reduce((n, g) => n + g.offen, 0);
    card.innerHTML = `<h2>Zu bestellen</h2>`;
    if (gruppen.length === 0) {
      card.innerHTML += `<p class="muted small">Nichts gemeldet – alles da.</p>`;
      card.appendChild(status);
      return card;
    }
    const kopf = document.createElement("p");
    kopf.className = "muted small";
    kopf.textContent = `${gesamtOffen} ${gesamtOffen === 1 ? "Artikel" : "Artikel"} offen bei ${gruppen.length} ${
      gruppen.length === 1 ? "Lieferant" : "Lieferanten"
    }.`;
    card.appendChild(kopf);

    for (const g of gruppen) {
      const titel = document.createElement("p");
      titel.className = "muted small res-bereich";
      titel.innerHTML = g.lieferant
        ? `<b>${escapeHtml(g.lieferant)}</b>${g.dringend > 0 ? ` · <span class="res-warn">${g.dringend} dringend</span>` : ""}`
        : `<b>Ohne Lieferant</b> · bitte unten zuordnen, sonst landen sie auf keiner Bestellung`;
      card.appendChild(titel);

      const liste = document.createElement("div");
      liste.className = "task-list";
      for (const s of g.artikel) {
        const row = document.createElement("div");
        row.className = "task-row";
        const zustand = STATUS[s.status] || STATUS.ok;
        const meta = [
          s.bestellmenge || null,
          s.bereich === "bar" ? "Bar" : "Küche",
          s.lastOrderedAt ? "zuletzt bestellt " + seit(s.lastOrderedAt) : null,
        ].filter(Boolean);
        row.innerHTML = `<div class="task-row-text">
          <span><b>${escapeHtml(s.name)}</b> <span class="${zustand.klasse}">· ${escapeHtml(zustand.label)}</span></span>
          <span class="muted small task-row-meta">${escapeHtml(meta.join(" · "))}</span></div>`;

        const akt = document.createElement("div");
        akt.className = "employee-actions";
        if (s.status === "bestellt") {
          const da = document.createElement("button");
          da.className = "btn btn-primary";
          da.textContent = "Ist geliefert";
          da.onclick = () => aktion(() => stockItemAction({ kind: "geliefert", itemIds: [s.id] }), status);
          akt.appendChild(da);
        } else {
          const raus = document.createElement("button");
          raus.className = "btn btn-secondary";
          raus.textContent = "Bestellt";
          raus.onclick = () => aktion(() => stockItemAction({ kind: "bestellt", itemIds: [s.id] }), status);
          const genug = document.createElement("button");
          genug.className = "btn btn-link";
          genug.textContent = "Doch genug da";
          genug.onclick = () => aktion(() => stockItemAction({ kind: "status", itemId: s.id, status: "ok" }), status);
          akt.append(raus, genug);
        }
        row.appendChild(akt);
        liste.appendChild(row);
      }
      card.appendChild(liste);

      const offeneIds = g.artikel.filter((a) => a.status !== "bestellt").map((a) => a.id);
      if (offeneIds.length > 1) {
        const alles = document.createElement("button");
        alles.className = "btn btn-primary";
        alles.textContent = `Alle ${offeneIds.length} als bestellt markieren`;
        alles.onclick = () => aktion(() => stockItemAction({ kind: "bestellt", itemIds: offeneIds }), status);
        card.appendChild(alles);
      }
      const gelieferteIds = g.artikel.filter((a) => a.status === "bestellt").map((a) => a.id);
      if (gelieferteIds.length > 1) {
        const alles = document.createElement("button");
        alles.className = "btn btn-secondary";
        alles.textContent = `Lieferung von ${g.lieferant || "diesem Lieferanten"} ist da (${gelieferteIds.length})`;
        alles.onclick = () => aktion(() => stockItemAction({ kind: "geliefert", itemIds: gelieferteIds }), status);
        card.appendChild(alles);
      }
    }
    card.appendChild(status);
    return card;
  }

  // ---- Artikel pflegen ----
  function buildArtikelverwaltung() {
    const card = document.createElement("section");
    card.className = "card";
    const status = document.createElement("p");
    status.className = "muted small";
    card.innerHTML = `<h2>Artikel</h2>
      <p class="muted small">Wer keinen Lieferanten hat, taucht in der Bestellliste unter „Ohne Lieferant“
      auf. Die Bestellmenge ist ein freier Text – schreib sie so hin, wie du sie bestellst.</p>`;

    const artikel = [...alleArtikel()].sort(
      (a, b) => (a.lieferant || "￿").localeCompare(b.lieferant || "￿") || a.name.localeCompare(b.name)
    );

    if (artikel.length > 0) {
      const scroll = document.createElement("div");
      scroll.style.overflowX = "auto";
      const tabelle = document.createElement("table");
      tabelle.className = "calc-table";
      tabelle.innerHTML = `<thead><tr><th>Artikel</th><th>Lieferant</th><th>Bestellmenge</th><th>Bereich</th><th>Zustand</th><th></th></tr></thead>`;
      const tbody = document.createElement("tbody");
      for (const s of artikel) {
        const tr = document.createElement("tr");
        tr.innerHTML = `<td><b>${escapeHtml(s.name)}</b></td>
          <td>${s.lieferant ? escapeHtml(s.lieferant) : "<span class='muted'>–</span>"}</td>
          <td>${s.bestellmenge ? escapeHtml(s.bestellmenge) : "<span class='muted'>–</span>"}</td>
          <td>${s.bereich === "bar" ? "Bar" : "Küche"}</td>
          <td>${escapeHtml((STATUS[s.status] || STATUS.ok).label)}</td>`;
        const td = document.createElement("td");
        const aendern = document.createElement("button");
        aendern.className = "btn btn-secondary";
        aendern.textContent = "Ändern";
        aendern.onclick = () => {
          bearbeite = s.id;
          rerender();
        };
        const weg = document.createElement("button");
        weg.className = "btn btn-link";
        weg.textContent = "✕";
        weg.onclick = () => {
          if (!confirm(`Artikel „${s.name}" löschen?`)) return;
          aktion(() => stockItemAction({ kind: "delete", itemId: s.id }), status);
        };
        td.append(aendern, weg);
        tr.appendChild(td);
        tbody.appendChild(tr);
        if (bearbeite === s.id) {
          const formZeile = document.createElement("tr");
          const zelle = document.createElement("td");
          zelle.colSpan = 6;
          zelle.appendChild(buildArtikelForm(s, status));
          formZeile.appendChild(zelle);
          tbody.appendChild(formZeile);
        }
      }
      tabelle.appendChild(tbody);
      scroll.appendChild(tabelle);
      card.appendChild(scroll);
    }

    if (bearbeite === "neu") {
      card.appendChild(buildArtikelForm(null, status));
    } else {
      const neu = document.createElement("button");
      neu.className = "btn btn-primary";
      neu.textContent = "＋ Neuer Artikel";
      neu.onclick = () => {
        bearbeite = "neu";
        rerender();
      };
      card.appendChild(neu);
    }
    card.appendChild(status);
    return card;
  }

  function buildArtikelForm(vorhanden, status) {
    const box = document.createElement("div");
    box.className = "res-form";
    const feld = (label, node) => {
      const l = document.createElement("label");
      l.className = "field";
      l.innerHTML = `<span>${label}</span>`;
      l.appendChild(node);
      return l;
    };
    const name = document.createElement("input");
    name.type = "text";
    name.placeholder = "z.B. Paulaner Hefeweizen";
    name.value = vorhanden?.name || "";

    // Lieferanten als Vorschlagsliste: tippen geht, aber die bekannten stehen zur Auswahl. Eine reine
    // Auswahlliste wäre falsch – der erste Lieferant muss sich ja auch anlegen lassen.
    const lieferant = document.createElement("input");
    lieferant.type = "text";
    lieferant.placeholder = "z.B. METRO";
    lieferant.value = vorhanden?.lieferant || "";
    lieferant.setAttribute("list", "lieferanten-liste");
    const datalist = document.createElement("datalist");
    datalist.id = "lieferanten-liste";
    for (const l of [...new Set(alleArtikel().map((s) => s.lieferant).filter(Boolean))].sort()) {
      const o = document.createElement("option");
      o.value = l;
      datalist.appendChild(o);
    }
    box.appendChild(datalist);

    const menge = document.createElement("input");
    menge.type = "text";
    menge.placeholder = "z.B. 1 Kasten";
    menge.value = vorhanden?.bestellmenge || "";

    const bereich = document.createElement("select");
    for (const [v, label] of [["kueche", "Küche"], ["bar", "Bar"]]) {
      const o = document.createElement("option");
      o.value = v;
      o.textContent = label;
      bereich.appendChild(o);
    }
    bereich.value = vorhanden?.bereich === "bar" ? "bar" : "kueche";

    const reihe = document.createElement("div");
    reihe.className = "res-form-row";
    reihe.append(feld("Artikel", name), feld("Lieferant", lieferant), feld("Bestellmenge", menge), feld("Bereich", bereich));
    box.appendChild(reihe);

    const akt = document.createElement("div");
    akt.className = "employee-actions";
    const speichern = document.createElement("button");
    speichern.className = "btn btn-primary";
    speichern.textContent = "Speichern";
    speichern.onclick = () => {
      if (!name.value.trim()) {
        status.className = "res-warn small";
        status.textContent = "Bitte einen Artikelnamen angeben.";
        return;
      }
      const felder = {
        name: name.value,
        lieferant: lieferant.value,
        bestellmenge: menge.value,
        bereich: bereich.value,
      };
      bearbeite = null;
      aktion(
        () => stockItemAction(vorhanden ? { kind: "update", itemId: vorhanden.id, ...felder } : { kind: "create", ...felder }),
        status
      );
    };
    const abbrechen = document.createElement("button");
    abbrechen.className = "btn btn-link";
    abbrechen.textContent = "Abbrechen";
    abbrechen.onclick = () => {
      bearbeite = null;
      rerender();
    };
    akt.append(speichern, abbrechen);
    box.appendChild(akt);
    return box;
  }

  async function aktion(fn, statusEl) {
    statusEl.className = "muted small";
    statusEl.textContent = "Wird gespeichert…";
    try {
      await fn();
      await onChanged();
    } catch (e) {
      statusEl.className = "callout callout-warn";
      statusEl.textContent = e.message;
    }
  }

  rerender();
  return el;
}

export { renderBestellung };
