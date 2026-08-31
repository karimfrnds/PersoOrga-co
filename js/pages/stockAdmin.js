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
        draft = { targetId: "new", productName: "", ingredients: [] };
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
                const stockItem = trackedItems.find((s) => s.id === ing.stockItemId);
                return stockItem ? `${ing.amount} ${stockItem.unit} ${stockItem.name}` : null;
              })
              .filter(Boolean)
              .join(" · ");
      textWrap.appendChild(summary);
      row.appendChild(textWrap);

      const actions = document.createElement("div");
      actions.className = "employee-actions";
      const editBtn = document.createElement("button");
      editBtn.className = "btn btn-secondary";
      editBtn.textContent = "Bearbeiten";
      editBtn.onclick = () => {
        draft = { targetId: recipe.id, productName: recipe.productName, ingredients: recipe.ingredients.map((i) => ({ ...i })) };
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

    const ingHeading = document.createElement("p");
    ingHeading.className = "muted small";
    ingHeading.style.marginTop = "12px";
    ingHeading.textContent = "Zutaten (pro verkauftem Stück verbraucht):";
    form.appendChild(ingHeading);

    draft.ingredients.forEach((ing, idx) => {
      const ingRow = document.createElement("div");
      ingRow.className = "task-add-row";
      const select = document.createElement("select");
      for (const s of trackedItems) {
        const opt = document.createElement("option");
        opt.value = s.id;
        opt.textContent = `${s.name} (${s.unit})`;
        if (s.id === ing.stockItemId) opt.selected = true;
        select.appendChild(opt);
      }
      select.onchange = () => {
        ing.stockItemId = select.value;
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
      ingRow.appendChild(select);
      ingRow.appendChild(amountInput);
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
        .filter((i) => i.stockItemId)
        .map((i) => ({ stockItemId: i.stockItemId, amount: Number(i.amount) || 0 }));
      if (draft.targetId === "new") {
        store.addRecipe(name, ingredients);
      } else {
        store.updateRecipe(draft.targetId, { productName: name, ingredients });
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
