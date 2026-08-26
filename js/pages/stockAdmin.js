// ============================================================================
// pages/stockAdmin.js – Admin-Tab „Vorräte": Artikel-Liste verwalten (anlegen/
// löschen), aktuellen Status sehen und bei Bedarf manuell zurücksetzen. Der
// Status selbst wird meist von den Mitarbeitern im Kiosk oder per Bot vom Chef
// geändert – hier geht's nur um die Grundverwaltung der Artikel-Liste.
// ============================================================================
import { store } from "../store.js";
import { escapeHtml, dateDe } from "../format.js";
import { confirmDialog } from "../dialog.js";

const STATUS_LABEL = { ok: "✅ Ok", knapp: "🟠 Wird knapp", leer: "🔴 Leer" };

function renderStockAdmin() {
  const container = document.createElement("div");
  container.className = "page";

  function rerender() {
    container.innerHTML = "";
    container.appendChild(build());
  }

  function build() {
    const frag = document.createElement("div");
    frag.innerHTML = `
      <h1>📦 Vorräte</h1>
      <p class="muted">Artikel-Liste, die Mitarbeiter im Kiosk als „Ok/Wird knapp/Leer" markieren können.
      Der Chef bekommt eine Einkaufsliste per Telegram-Bot (falls eingerichtet), sobald etwas knapp/leer ist.</p>
    `;
    frag.appendChild(buildAddCard());
    frag.appendChild(buildListCard());
    return frag;
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
    const add = () => {
      const name = input.value.trim();
      if (!name) return;
      store.addStockItem(name);
      input.value = "";
      rerender();
    };
    addBtn.onclick = add;
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") add();
    });
    row.appendChild(input);
    row.appendChild(addBtn);
    card.appendChild(row);
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
      statusSpan.textContent =
        STATUS_LABEL[item.status] + (item.updatedBy ? ` · zuletzt geändert von ${item.updatedBy}` : "");
      textWrap.appendChild(statusSpan);
      const lastDelivery = item.deliveries?.[0];
      if (lastDelivery) {
        const deliverySpan = document.createElement("span");
        deliverySpan.className = "muted small task-row-meta";
        deliverySpan.textContent = `📦 Zuletzt geliefert: ${dateDe(lastDelivery.date)}${lastDelivery.amount ? " · " + lastDelivery.amount : ""}`;
        textWrap.appendChild(deliverySpan);
      }
      row.appendChild(textWrap);

      const actions = document.createElement("div");
      actions.className = "employee-actions";
      if (item.status !== "ok") {
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

  rerender();
  return container;
}

export { renderStockAdmin };
