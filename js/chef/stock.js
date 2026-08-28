// ============================================================================
// chef/stock.js – Bestand & Bestellung am Laptop: was fehlt, was ist knapp,
// Lieferungen erfassen. Änderungen gehen in die Warteschlangen, die der iPad
// beim nächsten Abgleich übernimmt.
// ============================================================================
import { escapeHtml, dateDe, todayStr } from "../format.js";
import { markRestocked, recordDelivery, uploadDocument } from "./api.js";

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
      <p class="muted">Was nachgekauft werden muss, und Lieferungen erfassen. Artikel selbst werden am iPad unter Admin → Vorräte verwaltet.</p>
    `;

    const items = [...(state.stock || [])].sort((a, b) => {
      const r = (STATUS[a.status]?.rank ?? 3) - (STATUS[b.status]?.rank ?? 3);
      return r !== 0 ? r : a.name.localeCompare(b.name);
    });

    if (items.length === 0) {
      const card = document.createElement("section");
      card.className = "card";
      card.innerHTML = `<p class="muted small">Noch keine Vorräte bekannt – das iPad muss sich mindestens einmal abgeglichen haben.</p>`;
      frag.appendChild(card);
      return frag;
    }

    const fehlend = items.filter((i) => i.status !== "ok");
    frag.appendChild(buildUpload());
    frag.appendChild(buildEinkaufsliste(fehlend));
    frag.appendChild(buildListe(items));
    frag.appendChild(buildLieferung(items));
    return frag;
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
    const list = document.createElement("div");
    list.className = "task-list";
    for (const item of fehlend) {
      const row = document.createElement("div");
      row.className = "task-row";
      const text = document.createElement("div");
      text.className = "task-row-text";
      text.innerHTML = `<span><b>${escapeHtml(item.name)}</b></span><span class="muted small task-row-meta">${
        STATUS[item.status]?.label || item.status
      }${item.unit ? ` · Bestand: ${item.currentAmount} ${escapeHtml(item.unit)}` : ""}</span>`;
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
    card.appendChild(list);
    return card;
  }

  function buildListe(items) {
    const card = document.createElement("section");
    card.className = "card";
    card.innerHTML = `<h2>Alle Artikel</h2>`;
    const scroll = document.createElement("div");
    scroll.style.overflowX = "auto";
    const table = document.createElement("table");
    table.className = "calc-table";
    table.innerHTML = `<thead><tr><th>Artikel</th><th>Status</th><th>Bestand</th></tr></thead>`;
    const tbody = document.createElement("tbody");
    for (const item of items) {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${escapeHtml(item.name)}</td>
        <td>${STATUS[item.status]?.label || escapeHtml(item.status || "")}</td>
        <td>${item.unit ? `${item.currentAmount} ${escapeHtml(item.unit)}` : '<span class="muted">–</span>'}</td>`;
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    scroll.appendChild(table);
    card.appendChild(scroll);
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
