// ============================================================================
// pages/stockAdmin.js – Admin-Tab „Vorräte": Artikel-Liste verwalten (anlegen/
// löschen), aktuellen Status sehen und bei Bedarf manuell zurücksetzen/korrigieren,
// sowie Rezepte (Verkaufsprodukt -> Zutaten-Verbrauch) pflegen. Status/Menge werden
// meist automatisch geändert (Chef per Bot-Foto: Lieferschein füllt auf, SumUp-
// Verkaufsbericht + Rezept zieht ab) – hier geht's um Grundverwaltung + manuelle
// Korrekturen (z.B. nach einer echten Nachzählung).
// ============================================================================
import { store } from "../store.js";
import { escapeHtml, dateDe } from "../format.js";
import { confirmDialog } from "../dialog.js";
import { nameAehnlichkeit } from "../nameMatch.js";

const STATUS_LABEL = { ok: "✅ Ok", knapp: "🟠 Wird knapp", leer: "🔴 Leer" };

function renderStockAdmin() {
  const container = document.createElement("div");
  container.className = "page";

  // Überlebt Rerenders (Formular-Zustand fürs Rezept-Anlegen/Bearbeiten).
  // draft.targetId: "new" oder die id eines bestehenden Rezepts, das gerade bearbeitet wird.
  let draft = null;

  function rerender() {
    container.innerHTML = "";
    container.appendChild(build());
  }

  function build() {
    const frag = document.createElement("div");
    frag.innerHTML = `
      <h1>📦 Vorräte</h1>
      <p class="muted">Artikel-Liste, die Mitarbeiter im Kiosk als „Ok/Wird knapp/Leer" markieren können.
      Artikel mit Einheit werden zusätzlich mengengeführt: Lieferschein-Fotos füllen den Bestand auf, hinterlegte
      Rezepte ziehen bei einem SumUp-Verkaufsbericht automatisch die verkauften Zutaten ab.
      Der Chef bekommt außerdem eine Warnung per Telegram-Bot, sobald etwas knapp/leer ist.</p>
    `;
    frag.appendChild(buildAddCard());
    frag.appendChild(buildZusammenfuehren());
    frag.appendChild(buildListCard());
    frag.appendChild(buildRecipesCard());
    frag.appendChild(buildAufraeumenCard());
    return frag;
  }

  /** Sammel-Loeschen. Bewusst ganz unten und bewusst unmissverstaendlich beschriftet: das ist die einzige
   * Stelle im Bestand, an der mit einem Klick viel verschwindet. Vorgewaehlt ist die harmloseste Variante. */
  function buildAufraeumenCard() {
    const card = document.createElement("section");
    card.className = "card";
    const artikel = store.getStockItems();
    const rezepte = store.getRecipes();
    const ungeprueftA = artikel.filter((s) => s.needsReview).length;
    const ungeprueftR = rezepte.filter((r) => r.needsReview).length;

    card.innerHTML = `<h2>🧹 Aufräumen</h2>
      <p class="muted small">Mehrere Einträge auf einmal löschen – etwa nach einem Import, der nicht so
      geworden ist wie gedacht. <b>Das lässt sich nicht rückgängig machen.</b></p>`;

    const wahl = [
      { id: "ungeprueft", label: `Nur die zum Einordnen markierten (${ungeprueftA} Artikel, ${ungeprueftR} Rezepte)`,
        hinweis: "Trifft genau das, was automatisch aus Belegen entstanden ist. Alles, was du selbst gepflegt hast, bleibt." },
      { id: "rezepte", label: `Alle Rezepte (${rezepte.length})`,
        hinweis: "Die Artikel und ihr Bestand bleiben. Sinnvoll, wenn du die Rezept-PDFs neu einlesen willst." },
      { id: "artikel", label: `Alle Artikel (${artikel.length})`,
        hinweis: "Auch der Bestand. Rezepte bleiben, verlieren aber ihre Zutaten." },
      { id: "alles", label: `Alles: ${artikel.length} Artikel und ${rezepte.length} Rezepte`,
        hinweis: "Kompletter Neuanfang beim Bestand." },
    ];

    let gewaehlt = "ungeprueft";
    const hinweisZeile = document.createElement("p");
    hinweisZeile.className = "muted small";

    const liste = document.createElement("div");
    liste.className = "task-list";
    for (const w of wahl) {
      const row = document.createElement("label");
      row.className = "task-row";
      const radio = document.createElement("input");
      radio.type = "radio";
      radio.name = "aufraeumen";
      radio.checked = w.id === gewaehlt;
      radio.onchange = () => {
        gewaehlt = w.id;
        hinweisZeile.textContent = w.hinweis;
      };
      const text = document.createElement("div");
      text.className = "task-row-text";
      text.innerHTML = `<span>${escapeHtml(w.label)}</span>`;
      row.append(radio, text);
      liste.appendChild(row);
    }
    hinweisZeile.textContent = wahl[0].hinweis;
    card.append(liste, hinweisZeile);

    // Was bleibt – damit niemand glaubt, die Umsatzzahlen wären auch weg.
    const bleibt = document.createElement("p");
    bleibt.className = "muted small";
    bleibt.innerHTML =
      `<b>Nicht betroffen:</b> Umsätze, Stunden, der bereits gebuchte Wareneinsatz vergangener Tage,
       frühere Inventuren und die Verkaufshistorie. Das ist Vergangenheit und bleibt, wie sie war.`;
    card.appendChild(bleibt);

    const status = document.createElement("p");
    status.className = "muted small";

    const btn = document.createElement("button");
    btn.className = "btn btn-icon-danger";
    btn.style.cssText = "width:auto;padding:12px 18px;";
    btn.textContent = "Ausgewähltes löschen";
    btn.onclick = async () => {
      const opt = {
        ungeprueft: { artikel: true, rezepte: true, nurUngeprueft: true },
        rezepte: { rezepte: true },
        artikel: { artikel: true },
        alles: { artikel: true, rezepte: true },
      }[gewaehlt];
      const beschreibung = wahl.find((w) => w.id === gewaehlt).label;
      const gesichert = store.getSettings().githubBackup?.enabled;
      const frage =
        `${beschreibung}\n\nDas lässt sich nicht rückgängig machen.` +
        (gesichert
          ? `\n\nEuer automatisches Backup läuft – im Notfall lässt sich ein älterer Stand zurückholen.`
          : `\n\n⚠ Es ist kein automatisches Backup eingerichtet. Ohne das gibt es keinen Weg zurück.`);
      if (!(await confirmDialog(frage, { title: "Wirklich löschen?", okLabel: "Endgültig löschen", danger: true }))) return;

      const erg = store.clearStockData(opt);
      status.className = "callout";
      status.textContent = `Gelöscht: ${erg.geloeschteArtikel} Artikel, ${erg.geloeschteRezepte} Rezepte.`;
      rerender();
    };
    card.append(btn, status);
    return card;
  }

  /** Zwei Artikel zusammenfuehren – am iPad genauso wie am Laptop.
   *
   * Steht derselbe Artikel zweimal drin (einmal vom Lieferschein, einmal von Hand), gibt es sonst keinen
   * Weg zusammen. Die Aehnlichkeitssuche schlaegt die offensichtlichen Faelle vor, ist aber bewusst
   * streng – deshalb laesst sich immer auch von Hand waehlen. Ein Abschnitt, der sich bei fehlenden
   * Vorschlaegen selbst ausblendet, laesst einen genau dann im Stich, wenn man ihn braucht.
   */
  function buildZusammenfuehren() {
    const card = document.createElement("section");
    card.className = "card";
    const alle = store.getStockItems();
    if (alle.length < 2) {
      card.style.display = "none";
      return card;
    }

    card.innerHTML = `<h2>🔗 Artikel zusammenführen</h2>
      <p class="muted small">Wenn derselbe Artikel zweimal drinsteht. Der gewählte Name bleibt, der andere
      wird als Zweitname gemerkt und künftig automatisch erkannt. Der Bestand wandert mit, sofern die
      Einheiten zusammenpassen.</p>`;

    const beschreibe = (x) => `${x.name}${x.unit ? ` (${x.currentAmount ?? 0} ${x.unit})` : ""}`;

    // Vorschläge
    const paare = [];
    for (let i = 0; i < alle.length; i++) {
      for (let j = i + 1; j < alle.length; j++) {
        const punkte = nameAehnlichkeit(alle[i].name, alle[j].name);
        if (punkte >= 0.45) paare.push({ a: alle[i], b: alle[j], punkte });
      }
    }
    paare.sort((x, y) => y.punkte - x.punkte);
    if (paare.length > 0) {
      const titel = document.createElement("p");
      titel.className = "muted small";
      titel.innerHTML = "<b>Sieht nach demselben aus</b>";
      card.appendChild(titel);
      const liste = document.createElement("div");
      liste.className = "task-list";
      for (const p of paare.slice(0, 6)) {
        const row = document.createElement("div");
        row.className = "task-row";
        row.innerHTML = `<div class="task-row-text"><span><b>${escapeHtml(beschreibe(p.a))}</b> ↔ <b>${escapeHtml(beschreibe(p.b))}</b></span>
          <span class="muted small task-row-meta">${Math.round(p.punkte * 100)} % ähnlich</span></div>`;
        const akt = document.createElement("div");
        akt.className = "employee-actions";
        for (const [behalten, weg] of [[p.a, p.b], [p.b, p.a]]) {
          const btn = document.createElement("button");
          btn.className = "btn btn-secondary";
          btn.textContent = `${behalten.name} behalten`;
          btn.onclick = () => {
            store.mergeStockItem(weg.id, behalten.id);
            rerender();
          };
          akt.appendChild(btn);
        }
        row.appendChild(akt);
        liste.appendChild(row);
      }
      card.appendChild(liste);
    }

    // Von Hand
    const titel2 = document.createElement("p");
    titel2.className = "muted small";
    titel2.innerHTML = paare.length > 0 ? "<b>Oder selbst auswählen</b>" : "<b>Zwei Artikel auswählen</b>";
    card.appendChild(titel2);

    const sortiert = [...alle].sort((a, b) => a.name.localeCompare(b.name));
    const bauAuswahl = () => {
      const sel = document.createElement("select");
      for (const x of sortiert) {
        const o = document.createElement("option");
        o.value = x.id;
        o.textContent = beschreibe(x);
        sel.appendChild(o);
      }
      return sel;
    };
    const feld = (label, el) => {
      const l = document.createElement("label");
      l.className = "field";
      l.innerHTML = `<span>${label}</span>`;
      l.appendChild(el);
      return l;
    };
    const weg = bauAuswahl();
    const behalten = bauAuswahl();
    behalten.value = sortiert[1].id;
    const reihe = document.createElement("div");
    reihe.className = "res-form-row";
    reihe.append(feld("Dieser verschwindet", weg), feld("…und wird zu diesem", behalten));
    card.appendChild(reihe);

    const vorschau = document.createElement("p");
    const knopf = document.createElement("button");
    knopf.className = "btn btn-primary";
    knopf.textContent = "Zusammenführen";
    const zeige = () => {
      const a = alle.find((x) => x.id === weg.value);
      const b = alle.find((x) => x.id === behalten.value);
      if (!a || !b || a.id === b.id) {
        vorschau.className = "callout callout-warn";
        vorschau.textContent = "Bitte zwei verschiedene Artikel wählen.";
        knopf.disabled = true;
        return;
      }
      knopf.disabled = false;
      const passt = (a.unit || "") === (b.unit || "");
      vorschau.className = passt ? "callout" : "callout callout-warn";
      vorschau.textContent = passt
        ? `${a.name} verschwindet. ${b.name} bleibt, merkt sich den Namen und bekommt dessen Bestand dazu: ` +
          `${a.currentAmount ?? 0} + ${b.currentAmount ?? 0} = ${Math.round(((Number(a.currentAmount) || 0) + (Number(b.currentAmount) || 0)) * 100) / 100} ${b.unit || ""}.`
        : `${a.name} verschwindet und der Name wird gemerkt. Die Einheiten sind verschieden ` +
          `(${a.unit || "keine"} / ${b.unit || "keine"}) – der Bestand wird nicht übertragen, den setzt du danach von Hand.`;
    };
    knopf.onclick = async () => {
      const a = alle.find((x) => x.id === weg.value);
      const b = alle.find((x) => x.id === behalten.value);
      if (!a || !b) return;
      if (!(await confirmDialog(`${a.name} verschwindet und wird zu ${b.name}. Fortfahren?`,
        { title: "Zusammenführen?", okLabel: "Zusammenführen" }))) return;
      store.mergeStockItem(a.id, b.id);
      rerender();
    };
    weg.onchange = zeige;
    behalten.onchange = zeige;
    card.append(vorschau, knopf);
    zeige();
    return card;
  }

  function buildAddCard() {
    const card = document.createElement("section");
    card.className = "card";
    card.innerHTML = `<h2>Neuer Artikel</h2>`;
    const row = document.createElement("div");
    row.className = "task-add-row";
    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = "z.B. Kaffeebohnen, Milch, Servietten…";
    const addBtn = document.createElement("button");
    addBtn.className = "btn btn-primary";
    addBtn.textContent = "＋ Hinzufügen";

    const optHint = document.createElement("p");
    optHint.className = "muted small";
    optHint.style.marginTop = "8px";
    optHint.textContent = "Optional: Einheit angeben, wenn der Artikel mit genauer Menge geführt werden soll (z.B. für Rezepte).";

    const optGrid = document.createElement("div");
    optGrid.className = "kb-grid";
    optGrid.style.marginTop = "4px";
    const unitWrap = document.createElement("label");
    unitWrap.className = "field";
    unitWrap.innerHTML = `<span>Einheit (optional)</span>`;
    const unitInput = document.createElement("input");
    unitInput.type = "text";
    unitInput.placeholder = "z.B. kg, l, Stück";
    unitWrap.appendChild(unitInput);

    const amountWrap = document.createElement("label");
    amountWrap.className = "field";
    amountWrap.innerHTML = `<span>Aktueller Bestand</span>`;
    const amountInput = document.createElement("input");
    amountInput.type = "number";
    amountInput.min = "0";
    amountInput.step = "0.1";
    amountInput.placeholder = "0";
    amountWrap.appendChild(amountInput);

    const thresholdWrap = document.createElement("label");
    thresholdWrap.className = "field";
    thresholdWrap.innerHTML = `<span>Warnschwelle („wird knapp" ab)</span>`;
    const thresholdInput = document.createElement("input");
    thresholdInput.type = "number";
    thresholdInput.min = "0";
    thresholdInput.step = "0.1";
    thresholdInput.placeholder = "0";
    thresholdWrap.appendChild(thresholdInput);

    optGrid.appendChild(unitWrap);
    optGrid.appendChild(amountWrap);
    optGrid.appendChild(thresholdWrap);

    const add = () => {
      const name = input.value.trim();
      if (!name) return;
      store.addStockItem(name, {
        unit: unitInput.value.trim(),
        currentAmount: amountInput.value,
        lowThreshold: thresholdInput.value,
      });
      input.value = "";
      unitInput.value = "";
      amountInput.value = "";
      thresholdInput.value = "";
      rerender();
    };
    addBtn.onclick = add;
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") add();
    });
    row.appendChild(input);
    row.appendChild(addBtn);
    card.appendChild(row);
    card.appendChild(optHint);
    card.appendChild(optGrid);
    return card;
  }

  function buildListCard() {
    const card = document.createElement("section");
    card.className = "card";
    card.innerHTML = `<h2>Artikel-Liste</h2>`;
    const items = store.getStockItems();
    if (items.length === 0) {
      const empty = document.createElement("p");
      empty.className = "muted small";
      empty.textContent = "Noch keine Artikel angelegt.";
      card.appendChild(empty);
      return card;
    }
    const list = document.createElement("div");
    list.className = "task-list";
    for (const item of items) {
      const row = document.createElement("div");
      row.className = "task-row";

      const textWrap = document.createElement("div");
      textWrap.className = "task-row-text";
      const nameSpan = document.createElement("span");
      nameSpan.innerHTML = `<b>${escapeHtml(item.name)}</b>`;
      textWrap.appendChild(nameSpan);

      const statusSpan = document.createElement("span");
      statusSpan.className = "muted small task-row-meta";
      if (item.unit) {
        statusSpan.textContent =
          `${STATUS_LABEL[item.status]} · Bestand: ${item.currentAmount} ${item.unit} (Warnschwelle: ${item.lowThreshold} ${item.unit})` +
          (item.updatedBy ? ` · zuletzt geändert von ${item.updatedBy}` : "");
      } else {
        statusSpan.textContent =
          STATUS_LABEL[item.status] + (item.updatedBy ? ` · zuletzt geändert von ${item.updatedBy}` : "");
      }
      textWrap.appendChild(statusSpan);

      const lastDelivery = item.deliveries?.[0];
      if (lastDelivery) {
        const deliverySpan = document.createElement("span");
        deliverySpan.className = "muted small task-row-meta";
        const qtyText = lastDelivery.quantity != null ? `${lastDelivery.quantity} ${lastDelivery.unit || ""}`.trim() : "";
        deliverySpan.textContent = `📦 Zuletzt geliefert: ${dateDe(lastDelivery.date)}${qtyText ? " · " + qtyText : ""}`;
        textWrap.appendChild(deliverySpan);
      }
      row.appendChild(textWrap);

      const actions = document.createElement("div");
      actions.className = "employee-actions";

      if (item.unit) {
        const correctInput = document.createElement("input");
        correctInput.type = "number";
        correctInput.step = "0.1";
        correctInput.value = item.currentAmount;
        correctInput.style.width = "80px";
        const correctBtn = document.createElement("button");
        correctBtn.className = "btn btn-secondary";
        correctBtn.textContent = "Menge korrigieren";
        correctBtn.onclick = () => {
          store.setStockAmount(item.id, correctInput.value, "Admin");
          rerender();
        };
        actions.appendChild(correctInput);
        actions.appendChild(correctBtn);
      } else if (item.status !== "ok") {
        const resetBtn = document.createElement("button");
        resetBtn.className = "btn btn-secondary";
        resetBtn.textContent = `Auf „Ok" zurücksetzen`;
        resetBtn.onclick = () => {
          store.setStockStatus(item.id, "ok", "Admin");
          rerender();
        };
        actions.appendChild(resetBtn);
      }
      const delBtn = document.createElement("button");
      delBtn.className = "btn btn-icon-danger";
      delBtn.textContent = "✕";
      delBtn.onclick = async () => {
        if (await confirmDialog(`Artikel „${item.name}" endgültig löschen?`, { danger: true, okLabel: "Löschen" })) {
          store.removeStockItem(item.id);
          rerender();
        }
      };
      actions.appendChild(delBtn);
      row.appendChild(actions);

      list.appendChild(row);
    }
    card.appendChild(list);
    return card;
  }

  function buildRecipesCard() {
    const card = document.createElement("section");
    card.className = "card";
    card.innerHTML = `
      <h2>Rezepte</h2>
      <p class="muted small">
        Verknüpft ein Verkaufsprodukt (Name wie im SumUp-Bericht, z.B. „Cappuccino") mit den Zutaten, die pro
        verkauftem Stück verbraucht werden. Nur mengengeführte Artikel (mit Einheit) können Zutaten sein.
      </p>
    `;
    const trackedItems = store.getStockItems().filter((s) => s.unit);

    if (trackedItems.length === 0) {
      const hint = document.createElement("p");
      hint.className = "muted small";
      hint.textContent = "Lege zuerst oben mindestens einen mengengeführten Artikel (mit Einheit) an, bevor du Rezepte anlegen kannst.";
      card.appendChild(hint);
      return card;
    }

    if (!draft) {
      const newBtn = document.createElement("button");
      newBtn.className = "btn btn-primary";
      newBtn.textContent = "＋ Neues Rezept";
      newBtn.style.marginBottom = "12px";
      newBtn.onclick = () => {
        draft = { targetId: "new", productName: "", ingredients: [], yieldAmount: 1, yieldUnit: "Portion" };
        rerender();
      };
      card.appendChild(newBtn);
    }

    if (draft && draft.targetId === "new") {
      card.appendChild(buildRecipeForm(trackedItems));
    }

    const recipes = store.getRecipes();
    if (recipes.length === 0 && !draft) {
      const empty = document.createElement("p");
      empty.className = "muted small";
      empty.textContent = "Noch keine Rezepte angelegt.";
      card.appendChild(empty);
      return card;
    }

    const list = document.createElement("div");
    list.className = "task-list";
    for (const recipe of recipes) {
      if (draft && draft.targetId === recipe.id) {
        list.appendChild(buildRecipeForm(trackedItems));
        continue;
      }
      const row = document.createElement("div");
      row.className = "task-row";
      const textWrap = document.createElement("div");
      textWrap.className = "task-row-text";
      const nameSpan = document.createElement("span");
      nameSpan.innerHTML = `<b>${escapeHtml(recipe.productName)}</b>`;
      textWrap.appendChild(nameSpan);
      const summary = document.createElement("span");
      summary.className = "muted small task-row-meta";
      summary.textContent =
        recipe.ingredients.length === 0
          ? "Keine Zutaten hinterlegt"
          : recipe.ingredients
              .map((ing) => {
                // Eine Zutat kann ein Artikel ODER ein anderes Rezept sein (Grundmix, Sauce, Teig).
                if (ing.recipeId) {
                  const unter = store.getRecipes().find((r) => r.id === ing.recipeId);
                  return unter ? `${ing.amount} ${ing.unit || unter.yieldUnit || ""} ${unter.productName}` : null;
                }
                const stockItem = trackedItems.find((s) => s.id === ing.stockItemId);
                return stockItem ? `${ing.amount} ${stockItem.unit} ${stockItem.name}` : null;
              })
              .filter(Boolean)
              .join(" · ");
      // Ergiebigkeit nur nennen, wenn es NICHT die uebliche eine Portion ist – sonst steht bei jedem
      // Verkaufsprodukt eine Selbstverstaendlichkeit.
      if ((recipe.yieldAmount ?? 1) !== 1 || (recipe.yieldUnit && recipe.yieldUnit !== "Portion")) {
        const ergibt = document.createElement("span");
        ergibt.className = "muted small task-row-meta";
        ergibt.textContent = `ergibt ${recipe.yieldAmount ?? 1} ${recipe.yieldUnit || "Portion"}`;
        textWrap.appendChild(ergibt);
      }
      textWrap.appendChild(summary);
      row.appendChild(textWrap);

      const actions = document.createElement("div");
      actions.className = "employee-actions";
      const editBtn = document.createElement("button");
      editBtn.className = "btn btn-secondary";
      editBtn.textContent = "Bearbeiten";
      editBtn.onclick = () => {
        draft = { targetId: recipe.id, productName: recipe.productName, ingredients: recipe.ingredients.map((i) => ({ ...i })),
          yieldAmount: recipe.yieldAmount ?? 1, yieldUnit: recipe.yieldUnit || "Portion" };
        rerender();
      };
      actions.appendChild(editBtn);
      const delBtn = document.createElement("button");
      delBtn.className = "btn btn-icon-danger";
      delBtn.textContent = "✕";
      delBtn.onclick = async () => {
        if (await confirmDialog(`Rezept „${recipe.productName}" endgültig löschen?`, { danger: true, okLabel: "Löschen" })) {
          store.removeRecipe(recipe.id);
          rerender();
        }
      };
      actions.appendChild(delBtn);
      row.appendChild(actions);
      list.appendChild(row);
    }
    card.appendChild(list);
    return card;
  }

  function buildRecipeForm(trackedItems) {
    const form = document.createElement("div");
    form.className = "card";
    form.style.background = "var(--panel-alt, rgba(0,0,0,0.03))";

    const nameWrap = document.createElement("label");
    nameWrap.className = "field";
    nameWrap.innerHTML = `<span>Produktname (wie im SumUp-Bericht)</span>`;
    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.placeholder = "z.B. Cappuccino";
    nameInput.value = draft.productName;
    nameInput.oninput = () => {
      draft.productName = nameInput.value;
    };
    nameWrap.appendChild(nameInput);
    form.appendChild(nameWrap);

    // Ergiebigkeit: bei einem Verkaufsprodukt 1 Portion, bei einer Vorbereitung das, was ein Ansatz
    // ergibt. Nur damit laesst sich "200 g Grundmix" in einem anderen Rezept ausrechnen.
    const ergibtReihe = document.createElement("div");
    ergibtReihe.className = "res-form-row";
    const feld = (label, el) => {
      const l = document.createElement("label");
      l.className = "field";
      l.innerHTML = `<span>${label}</span>`;
      l.appendChild(el);
      return l;
    };
    const ertrag = document.createElement("input");
    ertrag.type = "number";
    ertrag.step = "0.01";
    ertrag.min = "0.01";
    ertrag.value = draft.yieldAmount ?? 1;
    ertrag.oninput = () => (draft.yieldAmount = ertrag.value);
    const ertragEinheit = document.createElement("input");
    ertragEinheit.type = "text";
    ertragEinheit.placeholder = "Portion, g, ml";
    ertragEinheit.value = draft.yieldUnit || "Portion";
    ertragEinheit.oninput = () => (draft.yieldUnit = ertragEinheit.value);
    ergibtReihe.append(feld("Ergibt", ertrag), feld("Einheit davon", ertragEinheit));
    form.appendChild(ergibtReihe);

    const ergibtHinweis = document.createElement("p");
    ergibtHinweis.className = "muted small";
    ergibtHinweis.innerHTML =
      `Bei einem Verkaufsprodukt: <b>1 Portion</b>. Bei einer Vorbereitung wie einem Grundmix das, was
       ein Ansatz ergibt (z.B. <b>2000 g</b>) – nur dann lässt sich „200 g Grundmix" in einem anderen
       Rezept ausrechnen.`;
    form.appendChild(ergibtHinweis);

    const ingHeading = document.createElement("p");
    ingHeading.className = "muted small";
    ingHeading.style.marginTop = "12px";
    ingHeading.textContent = "Zutaten für einen Ansatz – Artikel oder ein anderes Rezept:";
    form.appendChild(ingHeading);

    draft.ingredients.forEach((ing, idx) => {
      const ingRow = document.createElement("div");
      ingRow.className = "task-add-row";
      const select = document.createElement("select");
      const gruppeA = document.createElement("optgroup");
      gruppeA.label = "Artikel";
      for (const s of trackedItems) {
        const opt = document.createElement("option");
        opt.value = "a:" + s.id;
        opt.textContent = `${s.name} (${s.unit})`;
        if (s.id === ing.stockItemId) opt.selected = true;
        gruppeA.appendChild(opt);
      }
      select.appendChild(gruppeA);
      // Andere Rezepte als Zutat – ein Grundmix ist selbst ein Rezept. Rezepte, die einen Kreis
      // ergaeben, laesst der Store gar nicht erst zur Auswahl zu.
      const nutzbar = store.getVerwendbareRezepte(draft.targetId === "new" ? null : draft.targetId);
      if (nutzbar.length > 0) {
        const gruppeR = document.createElement("optgroup");
        gruppeR.label = "Andere Rezepte";
        for (const r of nutzbar) {
          const opt = document.createElement("option");
          opt.value = "r:" + r.id;
          opt.textContent = `${r.productName} (ergibt ${r.yieldAmount ?? 1} ${r.yieldUnit || "Portion"})`;
          if (r.id === ing.recipeId) opt.selected = true;
          gruppeR.appendChild(opt);
        }
        select.appendChild(gruppeR);
      }
      select.onchange = () => {
        const [art, id] = select.value.split(":");
        if (art === "r") {
          ing.recipeId = id;
          delete ing.stockItemId;
          ing.unit = nutzbar.find((r) => r.id === id)?.yieldUnit || "Portion";
        } else {
          ing.stockItemId = id;
          delete ing.recipeId;
          delete ing.unit;
        }
        rerender();
      };
      const amountInput = document.createElement("input");
      amountInput.type = "number";
      amountInput.min = "0";
      amountInput.step = "0.01";
      amountInput.style.width = "80px";
      amountInput.value = ing.amount;
      amountInput.oninput = () => {
        ing.amount = amountInput.value;
      };
      const removeBtn = document.createElement("button");
      removeBtn.className = "btn btn-icon-danger";
      removeBtn.textContent = "✕";
      removeBtn.onclick = () => {
        draft.ingredients.splice(idx, 1);
        rerender();
      };
      const einheit = document.createElement("span");
      einheit.className = "muted small";
      einheit.textContent = ing.recipeId
        ? ing.unit || store.getRecipes().find((r) => r.id === ing.recipeId)?.yieldUnit || ""
        : trackedItems.find((s) => s.id === ing.stockItemId)?.unit || "";
      ingRow.appendChild(select);
      ingRow.appendChild(amountInput);
      ingRow.appendChild(einheit);
      ingRow.appendChild(removeBtn);
      form.appendChild(ingRow);
    });

    const addIngBtn = document.createElement("button");
    addIngBtn.className = "btn btn-secondary";
    addIngBtn.textContent = "＋ Zutat hinzufügen";
    addIngBtn.style.marginTop = "8px";
    addIngBtn.onclick = () => {
      draft.ingredients.push({ stockItemId: trackedItems[0].id, amount: 1 });
      rerender();
    };
    form.appendChild(addIngBtn);

    const formActions = document.createElement("div");
    formActions.className = "employee-actions";
    formActions.style.marginTop = "12px";
    const cancelBtn = document.createElement("button");
    cancelBtn.className = "btn btn-secondary";
    cancelBtn.textContent = "Abbrechen";
    cancelBtn.onclick = () => {
      draft = null;
      rerender();
    };
    const saveBtn = document.createElement("button");
    saveBtn.className = "btn btn-primary";
    saveBtn.textContent = "Speichern";
    saveBtn.onclick = () => {
      const name = draft.productName.trim();
      if (!name) return;
      const ingredients = draft.ingredients
        .filter((i) => i.stockItemId || i.recipeId)
        .map((i) =>
          i.recipeId
            ? { recipeId: i.recipeId, amount: Number(i.amount) || 0, unit: i.unit || "" }
            : { stockItemId: i.stockItemId, amount: Number(i.amount) || 0 }
        );
      const ertragWerte = { yieldAmount: draft.yieldAmount, yieldUnit: draft.yieldUnit };
      if (draft.targetId === "new") {
        store.addRecipe(name, ingredients, ertragWerte);
      } else {
        store.updateRecipe(draft.targetId, { productName: name, ingredients, ...ertragWerte });
      }
      draft = null;
      rerender();
    };
    formActions.appendChild(cancelBtn);
    formActions.appendChild(saveBtn);
    form.appendChild(formActions);

    return form;
  }

  rerender();
  return container;
}

export { renderStockAdmin };
