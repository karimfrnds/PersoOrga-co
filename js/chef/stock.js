// ============================================================================
// chef/stock.js – Bestand & Bestellung am Laptop: was fehlt, was ist knapp,
// Lieferungen erfassen. Änderungen gehen in die Warteschlangen, die der iPad
// beim nächsten Abgleich übernimmt.
// ============================================================================
import { escapeHtml, dateDe, todayStr } from "../format.js";
import { markRestocked, recordDelivery, uploadDocument, stockItemAction, recipeAction } from "./api.js";
import { bewerteKandidaten } from "../nameMatch.js";

const STATUS = {
  leer: { label: "🔴 Leer", rank: 0 },
  knapp: { label: "🟠 Wird knapp", rank: 1 },
  ok: { label: "✅ Ok", rank: 2 },
};

// Ergebnis des letzten Beleg-Uploads. Muss AUSSERHALB der Render-Funktion liegen: nach dem Hochladen wird
// die ganze Ansicht neu aufgebaut, und eine nur lokal gehaltene Anzeige wäre dabei sofort wieder weg.
let letzterUpload = null;

function renderStock(state, { onChanged }) {
  const el = document.createElement("div");

  function rerender() {
    el.innerHTML = "";
    el.appendChild(build());
  }

  function build() {
    const frag = document.createElement("div");
    frag.innerHTML = `
      <h1>📦 Bestand & Bestellung</h1>
      <p class="muted">Belege hochladen, Artikel und Rezepte pflegen, Bestand korrigieren. Änderungen werden beim nächsten iPad-Abgleich übernommen.</p>
    `;

    const items = [...(state.stock || [])].sort((a, b) => {
      const r = (STATUS[a.status]?.rank ?? 3) - (STATUS[b.status]?.rank ?? 3);
      return r !== 0 ? r : a.name.localeCompare(b.name);
    });

    if (items.length === 0) {
      const card = document.createElement("section");
      card.className = "card";
      card.innerHTML = `<p class="muted small">Noch keine Vorräte bekannt – das iPad muss sich mindestens einmal abgeglichen haben.</p>`;
      frag.appendChild(buildUpload());
      frag.appendChild(buildPruefliste(items));
      frag.appendChild(card);
      frag.appendChild(buildRezepte(items));
      return frag;
    }

    const fehlend = items.filter((i) => i.status !== "ok");
    frag.appendChild(buildUpload());
    frag.appendChild(buildPruefliste(items));
    frag.appendChild(buildEinkaufsliste(fehlend));
    frag.appendChild(buildListe(items));
    frag.appendChild(buildLieferung(items));
    frag.appendChild(buildRezepte(items));
    frag.appendChild(buildBewegungen());
    return frag;
  }

  /** Was aus einem Verkaufsbericht automatisch angelegt wurde und noch nicht eingeordnet ist.
   *
   * Die Erkennung rät bei neuen Produkten, ob sie eingekauft (Artikel) oder zubereitet (Rezept) werden.
   * Am Namen allein ist das nicht sicher zu entscheiden – ob ein Croissant zugekauft oder selbst gebacken
   * wird, weiß nur das Café. Deshalb landet jeder Neuzugang hier, bis er einmal bestätigt ist. */
  function buildPruefliste(items) {
    const card = document.createElement("section");
    card.className = "card";
    const neueArtikel = items.filter((i) => i.needsReview);
    const neueRezepte = (state.recipes || []).filter((r) => r.needsReview);
    const gesamt = neueArtikel.length + neueRezepte.length;
    if (gesamt === 0) {
      card.style.display = "none";
      return card;
    }

    card.innerHTML = `
      <h2>🆕 ${gesamt} ${gesamt === 1 ? "neues Produkt" : "neue Produkte"} einordnen</h2>
      <p class="muted small">Aus einem Verkaufsbericht automatisch angelegt. Die Einordnung ist geraten –
      bitte einmal prüfen. <b>Rezepte ziehen erst etwas vom Bestand ab, wenn Zutaten eingetragen sind.</b></p>`;
    const status = document.createElement("p");
    status.className = "muted small";

    const liste = document.createElement("div");
    liste.className = "task-list";

    for (const item of neueArtikel) {
      const row = document.createElement("div");
      row.className = "task-row";
      row.innerHTML = `<div class="task-row-text"><span><b>${escapeHtml(item.name)}</b> <span class="badge badge-gray">Artikel</span></span>
        <span class="muted small task-row-meta">Wird 1:1 abgezogen · Bestand jetzt ${item.currentAmount ?? 0} ${escapeHtml(item.unit || "")}</span></div>`;
      row.appendChild(buildZuordnung(item, "artikel", status));
      const akt = document.createElement("div");
      akt.className = "employee-actions";

      const passt = document.createElement("button");
      passt.className = "btn btn-primary";
      passt.textContent = "Passt";
      passt.onclick = () => aktion(() => stockItemAction({ kind: "reviewed", itemId: item.id }), status);
      const bearbeiten = document.createElement("button");
      bearbeiten.className = "btn btn-secondary";
      bearbeiten.textContent = "Bearbeiten";
      bearbeiten.onclick = () => openArtikelDialog(item);
      // Falsch geraten: Artikel raus, stattdessen ein Rezept mit demselben Namen. Der Artikel wurde eben
      // erst automatisch angelegt und hat keine Historie, die verloren gehen könnte.
      const umwandeln = document.createElement("button");
      umwandeln.className = "btn btn-secondary";
      umwandeln.textContent = "→ Ist ein Rezept";
      umwandeln.title = "Wird aus Zutaten zubereitet, nicht so eingekauft";
      umwandeln.onclick = () =>
        aktion(async () => {
          await recipeAction({ kind: "create", productName: item.name, ingredients: [] });
          await stockItemAction({ kind: "delete", itemId: item.id });
        }, status);
      akt.append(passt, bearbeiten, umwandeln);
      row.appendChild(akt);
      liste.appendChild(row);
    }

    for (const rez of neueRezepte) {
      const row = document.createElement("div");
      row.className = "task-row";
      const ohneZutaten = (rez.ingredients || []).length === 0;
      row.innerHTML = `<div class="task-row-text"><span><b>${escapeHtml(rez.productName)}</b> <span class="badge badge-gray">Rezept</span></span>
        <span class="muted small task-row-meta">${
          ohneZutaten ? "⚠ Noch keine Zutaten – zieht bisher nichts vom Bestand ab" : `${rez.ingredients.length} Zutaten hinterlegt`
        }</span></div>`;
      row.appendChild(buildZuordnung(rez, "rezept", status));
      const akt = document.createElement("div");
      akt.className = "employee-actions";

      const zutaten = document.createElement("button");
      zutaten.className = "btn btn-primary";
      zutaten.textContent = ohneZutaten ? "Zutaten eintragen" : "Bearbeiten";
      zutaten.onclick = () => openRezeptDialog(rez, items);
      const umwandeln = document.createElement("button");
      umwandeln.className = "btn btn-secondary";
      umwandeln.textContent = "→ Ist ein Artikel";
      umwandeln.title = "Wird genau so eingekauft, wie es verkauft wird (z.B. Flaschengetränk)";
      umwandeln.onclick = () =>
        aktion(async () => {
          await stockItemAction({ kind: "create", name: rez.productName, unit: "Stück", currentAmount: 0, lowThreshold: 0 });
          await recipeAction({ kind: "delete", recipeId: rez.id });
        }, status);
      akt.append(zutaten, umwandeln);
      row.appendChild(akt);
      liste.appendChild(row);
    }

    card.append(liste, status);
    return card;
  }

  /** "Gehört das zu einem Produkt, das es schon gibt?"
   *
   * Der eigentliche Grund für Doppelgänger: Auf dem METRO-Lieferschein heißt das Bier
   * "Paulaner Hefe-Weissbier naturtrüb 0,5l 20er", im SumUp-Bericht "Paulaner Hefeweizen". Kein Name
   * steckt im anderen, und Ähnlichkeit allein reicht nicht, um automatisch zu entscheiden – ein
   * Fehlgriff würde stillschweigend vom falschen Bestand abbuchen.
   *
   * Deshalb schlägt das System hier die ähnlichsten vorhandenen Produkte vor. Ein Klick führt beide
   * zusammen: der Doppelgänger verschwindet, sein Name bleibt als Zweitname gemerkt, und ab dem
   * nächsten Bericht wird er sofort richtig zugeordnet.
   */
  function buildZuordnung(neu, art, status) {
    const box = document.createElement("div");
    const eigenerName = art === "rezept" ? neu.productName : neu.name;

    // Alles, was es schon gibt – außer dem Neuling selbst.
    const artikel = (state.stock || []).filter((s) => s.id !== neu.id && !s.needsReview);
    const rezepte = (state.recipes || []).filter((r) => r.id !== neu.id && !r.needsReview);
    const kandidaten = [
      ...bewerteKandidaten(artikel, "name", eigenerName).map((k) => ({ ...k, art: "artikel" })),
      ...bewerteKandidaten(rezepte, "productName", eigenerName).map((k) => ({ ...k, art: "rezept" })),
    ]
      .sort((a, b) => b.punkte - a.punkte)
      .slice(0, 3);

    if (kandidaten.length === 0) return box;

    const titel = document.createElement("div");
    titel.className = "muted small";
    titel.innerHTML = `<b>Gehört das zu …?</b> Dann werden beide zusammengeführt und der Name künftig erkannt.`;
    box.appendChild(titel);

    const reihe = document.createElement("div");
    reihe.className = "res-tische";
    for (const k of kandidaten) {
      const b2 = document.createElement("button");
      b2.className = "res-vorschlag";
      const zielName = k.art === "rezept" ? k.eintrag.productName : k.eintrag.name;
      b2.innerHTML =
        `<span class="res-tisch-name">${escapeHtml(zielName)}</span>` +
        `<span class="muted small">${k.art === "rezept" ? "Rezept" : "Artikel"} · ${Math.round(k.punkte * 100)} % ähnlich</span>`;
      b2.onclick = () =>
        aktion(async () => {
          // Verschiedene Arten lassen sich nicht verschmelzen – dann wird der Name nur als Zweitname
          // gemerkt und der Doppelgänger gelöscht.
          if (k.art === art) {
            if (art === "rezept") await recipeAction({ kind: "merge", recipeId: neu.id, targetId: k.eintrag.id });
            else await stockItemAction({ kind: "merge", itemId: neu.id, targetId: k.eintrag.id });
          } else if (k.art === "rezept") {
            await recipeAction({ kind: "alias", recipeId: k.eintrag.id, alias: eigenerName });
            await stockItemAction({ kind: "delete", itemId: neu.id });
          } else {
            await stockItemAction({ kind: "alias", itemId: k.eintrag.id, alias: eigenerName });
            await recipeAction({ kind: "delete", recipeId: neu.id });
          }
        }, status);
      reihe.appendChild(b2);
    }
    box.appendChild(reihe);
    return box;
  }

  /** Änderung einreichen und Ansicht neu laden. Fehler landen als Hinweis in der jeweiligen Karte. */
  async function aktion(fn, statusEl) {
    statusEl.className = "muted small";
    statusEl.textContent = "Wird gespeichert…";
    try {
      await fn();
      await onChanged();
    } catch (e) {
      statusEl.className = "callout callout-warn";
      statusEl.textContent = "⚠ " + e.message;
    }
  }

  /** Beleg hochladen (z.B. METRO-Auftragsbestätigung als PDF) und automatisch einpflegen lassen. */
  function buildUpload() {
    const card = document.createElement("section");
    card.className = "card";
    card.innerHTML = `
      <h2>📄 Beleg hochladen</h2>
      <p class="muted small">Lieferschein, Rechnung oder Bestellung (z.B. METRO-Auftragsbestätigung) als PDF oder Foto –
      auch mehrseitig. Genauso ein SumUp-Verkaufsbericht: der wird über die hinterlegten Rezepte gegen den Bestand
      gerechnet. Was erkannt wird, landet automatisch im System; unbekannte Artikel werden dabei neu angelegt.</p>
    `;

    const zone = document.createElement("label");
    zone.className = "upload-zone";
    zone.innerHTML = `<span><b>Datei auswählen</b><br/><span class="muted small">PDF, JPG oder PNG</span></span>`;
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "application/pdf,image/jpeg,image/png";
    input.style.display = "none";
    zone.appendChild(input);

    const status = document.createElement("p");
    status.className = "muted small";
    const ergebnis = document.createElement("div");

    // Ergebnis des letzten Uploads wieder anzeigen (überlebt das Neuladen der Ansicht).
    if (letzterUpload) {
      status.className = letzterUpload.fehler ? "callout callout-warn" : "callout";
      status.textContent = (letzterUpload.fehler ? "⚠ " : "") + letzterUpload.text;
      const res = letzterUpload;
      if ((res.items || []).length > 0) {
        const liste = document.createElement("div");
        liste.className = "task-list";
        liste.style.marginTop = "10px";
        for (const it of res.items) {
          const row = document.createElement("div");
          row.className = "task-row";
          const text =
            res.art === "verkaufsbericht"
              ? `${it.productName} – ${it.quantitySold}x verkauft`
              : `${it.itemName} – ${it.quantity != null ? `${it.quantity} ${it.unit || ""}`.trim() : "Menge unklar"}`;
          const neu = (res.unresolved || []).includes(it.itemName);
          row.innerHTML = `<div class="task-row-text"><span>${escapeHtml(text)}</span>${
            neu ? `<span class="muted small task-row-meta">war noch nicht in der Liste – wird angelegt</span>` : ""
          }</div>`;
          liste.appendChild(row);
        }
        ergebnis.appendChild(liste);
        const hinweis = document.createElement("p");
        hinweis.className = "muted small";
        hinweis.textContent = "Der Bestand aktualisiert sich, sobald das iPad das nächste Mal abgleicht.";
        ergebnis.appendChild(hinweis);
      }
    }

    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      letzterUpload = null;
      ergebnis.innerHTML = "";
      status.className = "muted small";
      status.textContent = `„${file.name}" wird ausgewertet… Das kann bei mehrseitigen Belegen einen Moment dauern.`;
      zone.style.pointerEvents = "none";
      try {
        const res = await uploadDocument(file);
        letzterUpload = res;
        await onChanged(); // baut die Ansicht neu auf und zeigt das Ergebnis von oben
      } catch (e) {
        letzterUpload = { fehler: true, text: e.message, items: [] };
        status.className = "callout callout-warn";
        status.textContent = "⚠ " + e.message;
        zone.style.pointerEvents = "";
        input.value = "";
      }
    };

    card.append(zone, status, ergebnis);
    return card;
  }

  function buildEinkaufsliste(fehlend) {
    const card = document.createElement("section");
    card.className = "card";
    card.innerHTML = `<h2>Einkaufsliste</h2>`;
    if (fehlend.length === 0) {
      const p = document.createElement("p");
      p.className = "muted small";
      p.textContent = `Alles auf „Ok" – gerade nichts nachzukaufen.`;
      card.appendChild(p);
      return card;
    }
    // Nach Bereich getrennt: eingekauft wird fuer Kueche und Bar getrennt, oft sogar bei verschiedenen
    // Lieferanten. Eine gemischte Liste muesste man vor jedem Einkauf erst selbst sortieren.
    for (const bereich of ["kueche", "bar"]) {
      const imBereich = fehlend.filter((i) => (i.bereich || "kueche") === bereich);
      if (imBereich.length === 0) continue;
      const titel = document.createElement("p");
      titel.className = "muted small res-bereich";
      titel.innerHTML = `<b>${bereich === "bar" ? "🍸 Bar" : "🍳 Küche"}</b> · ${imBereich.length} ${
        imBereich.length === 1 ? "Artikel" : "Artikel"
      }`;
      card.appendChild(titel);
      card.appendChild(buildEinkaufsGruppe(imBereich));
    }
    return card;
  }

  function buildEinkaufsGruppe(fehlend) {
    const list = document.createElement("div");
    list.className = "task-list";
    for (const item of fehlend) {
      const row = document.createElement("div");
      row.className = "task-row";
      const text = document.createElement("div");
      text.className = "task-row-text";
      // Bestellform mit anzeigen – beim Bestellen zaehlt der Kasten, nicht die Flasche.
      const bestellung = item.packSize > 1 ? `${item.packLabel || "Gebinde"} à ${item.packSize}` : item.packLabel || "";
      text.innerHTML = `<span><b>${escapeHtml(item.name)}</b></span><span class="muted small task-row-meta">${
        STATUS[item.status]?.label || item.status
      }${item.unit ? ` · Bestand: ${item.currentAmount} ${escapeHtml(item.unit)}` : ""}${
        bestellung ? ` · bestellen als ${escapeHtml(bestellung)}` : ""
      }</span>`;
      row.appendChild(text);

      const actions = document.createElement("div");
      actions.className = "employee-actions";
      const btn = document.createElement("button");
      btn.className = "btn btn-secondary";
      btn.textContent = "Ist wieder da";
      btn.onclick = async () => {
        btn.disabled = true;
        btn.textContent = "…";
        try {
          await markRestocked(item.name);
          await onChanged();
        } catch (e) {
          btn.disabled = false;
          btn.textContent = "Ist wieder da";
          alert("⚠ " + e.message);
        }
      };
      actions.appendChild(btn);
      row.appendChild(actions);
      list.appendChild(row);
    }
    return list;
  }

  function buildListe(items) {
    const card = document.createElement("section");
    card.className = "card";
    card.innerHTML = `<h2>Alle Artikel</h2><p class="muted small">Änderungen werden beim nächsten iPad-Abgleich übernommen.</p>`;
    const status = document.createElement("p");
    status.className = "muted small";

    const scroll = document.createElement("div");
    scroll.style.overflowX = "auto";
    const table = document.createElement("table");
    table.className = "calc-table";
    table.innerHTML = `<thead><tr><th>Artikel</th><th>Status</th><th>Bestand</th><th>Warnschwelle</th><th></th></tr></thead>`;
    const tbody = document.createElement("tbody");
    for (const item of items) {
      const tr = document.createElement("tr");
      const zellen = document.createElement("td");
      zellen.textContent = item.name;
      tr.appendChild(zellen);
      const st = document.createElement("td");
      st.innerHTML = STATUS[item.status]?.label || escapeHtml(item.status || "");
      tr.appendChild(st);

      // Bestand direkt korrigierbar (nur bei mengengeführten Artikeln)
      const menge = document.createElement("td");
      if (item.unit) {
        const inp = document.createElement("input");
        inp.type = "number";
        inp.step = "0.1";
        inp.value = item.currentAmount;
        inp.style.width = "80px";
        inp.onchange = () => aktion(() => stockItemAction({ kind: "setAmount", itemId: item.id, currentAmount: inp.value }), status);
        menge.appendChild(inp);
        menge.append(" " + item.unit);
      } else {
        menge.innerHTML = '<span class="muted">–</span>';
      }
      tr.appendChild(menge);

      const schwelle = document.createElement("td");
      schwelle.innerHTML = item.unit ? `${item.lowThreshold ?? 0} ${escapeHtml(item.unit)}` : '<span class="muted">–</span>';
      tr.appendChild(schwelle);

      const aktionen = document.createElement("td");
      aktionen.className = "employee-actions";
      const bearbeiten = document.createElement("button");
      bearbeiten.className = "btn btn-secondary";
      bearbeiten.textContent = "Bearbeiten";
      bearbeiten.onclick = () => openArtikelDialog(item);
      const loeschen = document.createElement("button");
      loeschen.className = "btn btn-icon-danger";
      loeschen.textContent = "✕";
      loeschen.title = "Artikel löschen";
      loeschen.onclick = () => {
        if (!confirm(`Artikel „${item.name}" löschen?`)) return;
        aktion(() => stockItemAction({ kind: "delete", itemId: item.id }), status);
      };
      aktionen.append(bearbeiten, loeschen);
      tr.appendChild(aktionen);
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    scroll.appendChild(table);

    const neu = document.createElement("button");
    neu.className = "btn btn-primary";
    neu.textContent = "＋ Neuer Artikel";
    neu.onclick = () => openArtikelDialog(null);

    card.append(scroll, neu, status);
    return card;
  }

  /** Artikel anlegen oder bearbeiten. Einheit leer = reine Ampel ohne Mengenführung. */
  /** Preisfeld mit zwei Eingabewegen.
   *
   * Auf einer Rechnung steht meistens der Gebinde-Preis ("Kasten 15,60 €"), gebraucht wird aber der Preis
   * je Einzelstueck. Deshalb kann man beides eintragen – der andere Wert ergibt sich daraus. Ohne das
   * muesste man vor jedem Speichern selbst dividieren, und genau da schleichen sich Fehler ein.
   */
  function buildPreisFeld(item) {
    const proStueck = item?.pricePerUnit;
    const gebinde = item?.packSize > 1 && proStueck != null ? (proStueck * item.packSize).toFixed(2) : "";
    const herkunft =
      item?.priceSource === "beleg"
        ? '<span class="muted small">Vom Lieferschein übernommen. Trägst du hier etwas ein, bleibt dein Wert stehen.</span>'
        : item?.priceSource === "manuell"
        ? '<span class="muted small">Von dir eingetragen – Lieferscheine überschreiben ihn nicht.</span>'
        : '<span class="muted small">Kommt automatisch vom nächsten Lieferschein, wenn du nichts einträgst.</span>';
    return `
      <div class="res-form-row">
        <label class="field"><span>Einkaufspreis je Einheit (€)</span>
          <input type="number" id="ai-preis" step="0.00001" min="0" value="${proStueck ?? ""}" placeholder="leer = unbekannt" /></label>
        <label class="field"><span>oder je Gebinde (€)</span>
          <input type="number" id="ai-preis-gebinde" step="0.01" min="0" value="${gebinde}" placeholder="wird umgerechnet" /></label>
      </div>
      ${herkunft}`;
  }

  /** Liest den Preis aus dem Dialog. Gibt undefined zurueck, wenn nichts eingetragen wurde – dann bleibt
   * ein vorhandener Preis unangetastet, statt ihn durch eine leere Eingabe zu loeschen. */
  function lesePreis(overlay) {
    const proStueck = overlay.querySelector("#ai-preis").value.trim();
    const proGebinde = overlay.querySelector("#ai-preis-gebinde").value.trim();
    const groesse = Math.max(1, Number(overlay.querySelector("#ai-packsize").value) || 1);
    if (proStueck !== "") return Number(proStueck);
    if (proGebinde !== "") return Number(proGebinde) / groesse;
    return undefined;
  }

  function openArtikelDialog(item) {
    const neu = !item;
    const overlay = document.createElement("div");
    overlay.className = "overlay";
    overlay.innerHTML = `
      <div class="dialog">
        <h2>${neu ? "Neuer Artikel" : "Artikel bearbeiten"}</h2>
        <label class="field"><span>Name</span><input type="text" id="ai-name" value="${escapeHtml(item?.name || "")}" placeholder="z.B. Kaffeebohnen" /></label>
        <div class="res-form-row">
          <label class="field"><span>Bereich</span><select id="ai-bereich">
            <option value="kueche" ${item?.bereich !== "bar" ? "selected" : ""}>Küche</option>
            <option value="bar" ${item?.bereich === "bar" ? "selected" : ""}>Bar</option>
          </select></label>
          <label class="field"><span>Einheit</span><input type="text" id="ai-unit" value="${escapeHtml(item?.unit || "")}" placeholder="z.B. g, ml, Stück" /></label>
        </div>
        <div class="res-form-row">
          <label class="field"><span>Bestellform</span><input type="text" id="ai-packlabel" value="${escapeHtml(item?.packLabel || "")}" placeholder="z.B. Kasten, 8er-Pack, einzeln" /></label>
          <label class="field"><span>Stück je Gebinde</span><input type="number" id="ai-packsize" min="1" step="1" value="${item?.packSize ?? 1}" /></label>
        </div>
        <div class="res-form-row">
          ${neu ? `<label class="field"><span>Aktueller Bestand</span><input type="number" id="ai-amount" step="0.1" value="0" /></label>` : ""}
          <label class="field"><span>Warnschwelle</span><input type="number" id="ai-low" step="0.1" value="${item?.lowThreshold ?? 0}" /></label>
        </div>
        ${buildPreisFeld(item)}
        <p class="muted small">Nur mit Einheit wird der Bestand als Menge geführt und automatisch verrechnet.
        Die Bestellform hilft beim Einkauf: <b>Stück je Gebinde</b> ist die Zahl, die auf dem Lieferschein
        in einem Kasten steckt.</p>
        <p class="muted small" id="ai-status"></p>
        <div class="dialog-actions">
          <button class="btn btn-secondary" id="ai-cancel">Abbrechen</button>
          <button class="btn btn-primary" id="ai-save">Speichern</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const status = overlay.querySelector("#ai-status");
    overlay.querySelector("#ai-cancel").onclick = () => overlay.remove();
    overlay.querySelector("#ai-save").onclick = async () => {
      const name = overlay.querySelector("#ai-name").value.trim();
      if (!name) {
        status.className = "callout callout-warn";
        status.textContent = "Bitte einen Namen eintragen.";
        return;
      }
      const body = {
        kind: neu ? "create" : "update",
        itemId: item?.id,
        name,
        unit: overlay.querySelector("#ai-unit").value.trim(),
        lowThreshold: overlay.querySelector("#ai-low").value,
        bereich: overlay.querySelector("#ai-bereich").value,
        packSize: overlay.querySelector("#ai-packsize").value,
        packLabel: overlay.querySelector("#ai-packlabel").value.trim(),
      };
      const preis = lesePreis(overlay);
      if (preis !== undefined) body.pricePerUnit = preis;
      if (neu) body.currentAmount = overlay.querySelector("#ai-amount").value;
      overlay.querySelectorAll("button").forEach((b) => (b.disabled = true));
      status.className = "muted small";
      status.textContent = "Wird gespeichert…";
      try {
        await stockItemAction(body);
        overlay.remove();
        await onChanged();
      } catch (e) {
        status.className = "callout callout-warn";
        status.textContent = "⚠ " + e.message;
        overlay.querySelectorAll("button").forEach((b) => (b.disabled = false));
      }
    };
  }

  /** Rezepte: Verkaufsprodukt -> Zutatenverbrauch. Basis für die automatische Bestandsrechnung. */
  function buildRezepte(items) {
    const card = document.createElement("section");
    card.className = "card";
    card.innerHTML = `
      <h2>🧾 Rezepte</h2>
      <p class="muted small">Verknüpft ein Verkaufsprodukt (Name wie im SumUp-Bericht) mit den Zutaten pro verkauftem Stück.
      Nur damit kann ein Verkaufsbericht den Bestand automatisch abziehen.</p>`;
    const status = document.createElement("p");
    status.className = "muted small";

    const mengengefuehrt = items.filter((i) => i.unit);
    if (mengengefuehrt.length === 0) {
      card.innerHTML += `<p class="muted small">Lege zuerst mindestens einen Artikel mit Einheit an – ohne Mengenführung kann nichts verrechnet werden.</p>`;
      return card;
    }

    const rezepte = [...(state.recipes || [])].sort((a, b) => a.productName.localeCompare(b.productName));
    if (rezepte.length === 0) {
      const p = document.createElement("p");
      p.className = "muted small";
      p.textContent = "Noch keine Rezepte hinterlegt.";
      card.appendChild(p);
    } else {
      const liste = document.createElement("div");
      liste.className = "task-list";
      for (const r of rezepte) {
        const row = document.createElement("div");
        row.className = "task-row";
        const zutaten = (r.ingredients || [])
          .map((z) => {
            const art = mengengefuehrt.find((i) => i.id === z.stockItemId);
            return art ? `${z.amount} ${art.unit} ${art.name}` : null;
          })
          .filter(Boolean)
          .join(" · ");
        row.innerHTML = `<div class="task-row-text"><span><b>${escapeHtml(r.productName)}</b></span><span class="muted small task-row-meta">${
          escapeHtml(zutaten) || "keine Zutaten hinterlegt"
        }</span></div>`;
        const akt = document.createElement("div");
        akt.className = "employee-actions";
        const bearb = document.createElement("button");
        bearb.className = "btn btn-secondary";
        bearb.textContent = "Bearbeiten";
        bearb.onclick = () => openRezeptDialog(r, mengengefuehrt);
        const del = document.createElement("button");
        del.className = "btn btn-icon-danger";
        del.textContent = "✕";
        del.onclick = () => {
          if (!confirm(`Rezept „${r.productName}" löschen?`)) return;
          aktion(() => recipeAction({ kind: "delete", recipeId: r.id }), status);
        };
        akt.append(bearb, del);
        row.appendChild(akt);
        liste.appendChild(row);
      }
      card.appendChild(liste);
    }

    const neu = document.createElement("button");
    neu.className = "btn btn-primary";
    neu.textContent = "＋ Neues Rezept";
    neu.onclick = () => openRezeptDialog(null, mengengefuehrt);
    card.append(neu, status);
    return card;
  }

  function openRezeptDialog(rezept, artikel) {
    const neu = !rezept;
    const zutaten = (rezept?.ingredients || []).map((z) => ({ ...z }));
    const overlay = document.createElement("div");
    overlay.className = "overlay";
    document.body.appendChild(overlay);

    const zeichne = () => {
      overlay.innerHTML = `
        <div class="dialog">
          <h2>${neu ? "Neues Rezept" : "Rezept bearbeiten"}</h2>
          <label class="field"><span>Produktname (wie im SumUp-Bericht)</span><input type="text" id="rz-name" value="${escapeHtml(
            rezept?.productName || ""
          )}" placeholder="z.B. Cappuccino" /></label>
          <p class="muted small"><b>Zutaten pro verkauftem Stück</b></p>
          <div id="rz-list" class="task-list"></div>
          <button class="btn btn-secondary" id="rz-add" style="margin-top:8px">＋ Zutat hinzufügen</button>
          <p class="muted small" id="rz-status"></p>
          <div class="dialog-actions">
            <button class="btn btn-secondary" id="rz-cancel">Abbrechen</button>
            <button class="btn btn-primary" id="rz-save">Speichern</button>
          </div>
        </div>`;
      const nameInput = overlay.querySelector("#rz-name");
      const liste = overlay.querySelector("#rz-list");
      zutaten.forEach((z, idx) => {
        const row = document.createElement("div");
        row.className = "task-add-row";
        const sel = document.createElement("select");
        for (const a of artikel) {
          const o = document.createElement("option");
          o.value = a.id;
          o.textContent = `${a.name} (${a.unit})`;
          if (a.id === z.stockItemId) o.selected = true;
          sel.appendChild(o);
        }
        sel.onchange = () => (z.stockItemId = sel.value);
        const menge = document.createElement("input");
        menge.type = "number";
        menge.step = "0.01";
        menge.min = "0";
        menge.style.width = "90px";
        menge.value = z.amount;
        menge.oninput = () => (z.amount = menge.value);
        const weg = document.createElement("button");
        weg.className = "btn btn-icon-danger";
        weg.textContent = "✕";
        weg.onclick = () => {
          zutaten.splice(idx, 1);
          const merk = nameInput.value;
          zeichne();
          overlay.querySelector("#rz-name").value = merk;
        };
        row.append(sel, menge, weg);
        liste.appendChild(row);
      });

      overlay.querySelector("#rz-add").onclick = () => {
        zutaten.push({ stockItemId: artikel[0].id, amount: 1 });
        const merk = nameInput.value;
        zeichne();
        overlay.querySelector("#rz-name").value = merk;
      };
      overlay.querySelector("#rz-cancel").onclick = () => overlay.remove();
      overlay.querySelector("#rz-save").onclick = async () => {
        const status = overlay.querySelector("#rz-status");
        const name = overlay.querySelector("#rz-name").value.trim();
        if (!name) {
          status.className = "callout callout-warn";
          status.textContent = "Bitte einen Produktnamen eintragen.";
          return;
        }
        overlay.querySelectorAll("button").forEach((b) => (b.disabled = true));
        status.className = "muted small";
        status.textContent = "Wird gespeichert…";
        try {
          await recipeAction({
            kind: neu ? "create" : "update",
            recipeId: rezept?.id,
            productName: name,
            ingredients: zutaten.map((z) => ({ stockItemId: z.stockItemId, amount: Number(z.amount) || 0 })),
          });
          overlay.remove();
          await onChanged();
        } catch (e) {
          status.className = "callout callout-warn";
          status.textContent = "⚠ " + e.message;
          overlay.querySelectorAll("button").forEach((b) => (b.disabled = false));
        }
      };
    };
    zeichne();
  }

  /** Was zuletzt rein- und rausgegangen ist – aus den erfassten Lieferungen und Verkäufen. */
  function buildBewegungen() {
    const card = document.createElement("section");
    card.className = "card";
    card.innerHTML = `<h2>📊 Letzte Bewegungen</h2>`;
    const lieferungen = [...(state.stockDeliveries || [])].slice(-40).reverse();
    const verkaeufe = [...(state.stockSales || [])].slice(-40).reverse();
    if (lieferungen.length === 0 && verkaeufe.length === 0) {
      card.innerHTML += `<p class="muted small">Noch nichts erfasst.</p>`;
      return card;
    }
    const details = document.createElement("details");
    details.className = "history";
    details.innerHTML = `<summary>${lieferungen.length} Lieferungen · ${verkaeufe.length} Verkaufsposten anzeigen</summary>`;
    const scroll = document.createElement("div");
    scroll.style.overflowX = "auto";
    scroll.style.marginTop = "10px";
    const table = document.createElement("table");
    table.className = "calc-table";
    table.innerHTML = `<thead><tr><th>Datum</th><th>Art</th><th>Artikel / Produkt</th><th>Menge</th></tr></thead>`;
    const tbody = document.createElement("tbody");
    const alle = [
      ...lieferungen.map((d) => ({ date: d.date, art: "Eingang", was: d.itemName, menge: d.quantity != null ? `${d.quantity} ${d.unit || ""}`.trim() : "—" })),
      ...verkaeufe.map((s) => ({ date: s.date, art: "Verkauf", was: s.productName, menge: `${s.quantitySold}x` })),
    ].sort((a, b) => (a.date < b.date ? 1 : -1));
    for (const z of alle) {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td>${escapeHtml(dateDe(z.date))}</td><td>${z.art}</td><td>${escapeHtml(z.was)}</td><td>${escapeHtml(z.menge)}</td>`;
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    scroll.appendChild(table);
    details.appendChild(scroll);
    card.appendChild(details);
    return card;
  }

  function buildLieferung(items) {
    const card = document.createElement("section");
    card.className = "card";
    card.innerHTML = `
      <h2>Lieferung erfassen</h2>
      <p class="muted small">Für einzelne Nachträge. Ganze Lieferscheine/Bestellungen schickst du weiterhin einfach als Foto oder PDF an den Telegram-Bot.</p>
    `;
    const grid = document.createElement("div");
    grid.className = "kb-grid";

    const artikelWrap = document.createElement("label");
    artikelWrap.className = "field";
    artikelWrap.innerHTML = `<span>Artikel</span>`;
    const select = document.createElement("select");
    for (const i of items) {
      const opt = document.createElement("option");
      opt.value = i.name;
      opt.textContent = i.unit ? `${i.name} (${i.unit})` : i.name;
      select.appendChild(opt);
    }
    artikelWrap.appendChild(select);

    const mengeWrap = document.createElement("label");
    mengeWrap.className = "field";
    mengeWrap.innerHTML = `<span>Menge</span>`;
    const menge = document.createElement("input");
    menge.type = "number";
    menge.min = "0";
    menge.step = "0.1";
    mengeWrap.appendChild(menge);

    const datumWrap = document.createElement("label");
    datumWrap.className = "field";
    datumWrap.innerHTML = `<span>Datum</span>`;
    const datum = document.createElement("input");
    datum.type = "date";
    datum.value = todayStr();
    datumWrap.appendChild(datum);

    grid.append(artikelWrap, mengeWrap, datumWrap);
    card.appendChild(grid);

    const status = document.createElement("p");
    status.className = "muted small";

    const btn = document.createElement("button");
    btn.className = "btn btn-primary";
    btn.textContent = "Lieferung eintragen";
    btn.style.marginTop = "10px";
    btn.onclick = async () => {
      const qty = Number(menge.value);
      if (!Number.isFinite(qty) || qty <= 0) {
        status.textContent = "⚠ Bitte eine Menge größer als 0 eintragen.";
        return;
      }
      btn.disabled = true;
      status.textContent = "Wird gespeichert…";
      const item = items.find((i) => i.name === select.value);
      try {
        await recordDelivery(select.value, qty, item?.unit || "", datum.value);
        menge.value = "";
        status.textContent = "✅ Eingetragen. Der Bestand aktualisiert sich beim nächsten iPad-Abgleich.";
        await onChanged();
      } catch (e) {
        status.textContent = "⚠ " + e.message;
      }
      btn.disabled = false;
    };
    card.append(btn, status);
    return card;
  }

  rerender();
  return el;
}

export { renderStock };
