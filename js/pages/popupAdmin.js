// ============================================================================
// pages/popupAdmin.js – Admin-Tab „Produkte & Schichten" (Pop-up).
//
// Zwei Dinge, die im Café im Code stehen und hier nicht stehen dürfen:
//
//   PRODUKTE. Was verkauft wird und was es kostet. Daraus rechnet der Tagesabschluss den Umsatz aus den
//   Stückzahlen – ändert sich ein Preis, muss das ohne mich gehen.
//
//   SCHICHTEN. Bei einem Pop-up stehen die Zeiten am Anfang nie fest. Sie hier zu ändern ist eine Minute;
//   sie im Code zu ändern wäre jedes Mal ein Umweg über mich.
// ============================================================================
import { store } from "../store.js";
import { euro, escapeHtml } from "../format.js";
import { confirmDialog, alertDialog } from "../dialog.js";

function renderPopupAdmin() {
  const container = document.createElement("div");
  container.className = "page";

  function rerender() {
    container.innerHTML = "";
    container.appendChild(build());
  }

  function build() {
    const frag = document.createElement("div");
    frag.innerHTML = `<h1>Produkte & Schichten</h1>`;
    frag.appendChild(buildProdukte());
    frag.appendChild(buildSchichten());
    return frag;
  }

  // ---------------------------------------------------------------------
  // Produkte
  // ---------------------------------------------------------------------
  function buildProdukte() {
    const card = document.createElement("section");
    card.className = "card";
    card.innerHTML = `<h2>Produkte</h2>
      <p class="muted small">Was verkauft wird. Der Preis ist die Grundlage für den Umsatz im Tagesabschluss.
      „Wird gebacken“ heißt: davon wird morgens eine Menge hergestellt – dann fragt der Tagesabschluss nach
      Backmenge und Rest, und du bekommst einen Vorschlag für den nächsten Tag.</p>`;

    const produkte = store.getProdukte();
    const liste = document.createElement("div");
    liste.className = "task-list";
    for (const p of produkte) {
      const row = document.createElement("div");
      row.className = "task-row";
      const marge = p.kosten ? ` · Ware ${euro(p.kosten)} → ${euro(p.preis - p.kosten)} bleiben` : " · keine Kosten hinterlegt";
      row.innerHTML = `<div class="task-row-text"><span><b>${escapeHtml(p.name)}</b></span>
        <span class="muted small task-row-meta">${euro(p.preis)}${marge}${p.gebacken ? " · wird gebacken" : ""}</span></div>`;
      const akt = document.createElement("div");
      akt.className = "employee-actions";
      const aendern = document.createElement("button");
      aendern.className = "btn btn-secondary";
      aendern.textContent = "Ändern";
      aendern.onclick = () => openProdukt(p);
      const weg = document.createElement("button");
      weg.className = "btn btn-link";
      weg.textContent = "✕";
      weg.onclick = async () => {
        if (!(await confirmDialog(`„${p.name}“ löschen? Schon eingetragene Verkaufszahlen bleiben erhalten.`, { danger: true, okLabel: "Löschen" }))) return;
        store.setProdukte(produkte.filter((x) => x.id !== p.id));
        rerender();
      };
      akt.append(aendern, weg);
      row.appendChild(akt);
      liste.appendChild(row);
    }
    if (produkte.length === 0) liste.innerHTML = `<p class="muted small">Noch kein Produkt angelegt.</p>`;
    card.appendChild(liste);

    const neu = document.createElement("button");
    neu.className = "btn btn-primary";
    neu.textContent = "＋ Produkt";
    neu.onclick = () => openProdukt(null);
    card.appendChild(neu);
    return card;
  }

  function openProdukt(vorhanden) {
    const overlay = document.createElement("div");
    overlay.className = "overlay";
    const box = document.createElement("div");
    box.className = "dialog";
    box.innerHTML = `<h2>${vorhanden ? "Produkt ändern" : "Neues Produkt"}</h2>`;
    const feld = (label, node, hinweis) => {
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
    };
    const name = Object.assign(document.createElement("input"), { type: "text", value: vorhanden?.name || "", placeholder: "z.B. Zimtschnecke" });
    const preis = Object.assign(document.createElement("input"), { type: "number", step: "0.1", min: "0", value: vorhanden ? vorhanden.preis : "" });
    const kosten = Object.assign(document.createElement("input"), { type: "number", step: "0.01", min: "0", value: vorhanden?.kosten ? vorhanden.kosten : "" });
    const gebacken = Object.assign(document.createElement("input"), { type: "checkbox", checked: vorhanden ? !!vorhanden.gebacken : false });
    const gebackenZeile = document.createElement("label");
    gebackenZeile.className = "field-checkbox";
    gebackenZeile.append(gebacken, document.createTextNode(" Wird gebacken (Backmenge und Rest werden erfasst)"));
    box.append(
      feld("Name", name),
      feld("Preis (€)", preis),
      feld("Ware je Stück (€)", kosten, "Was dich ein Stück an Zutaten, Becher und Bohnen kostet. Leer lassen, wenn du es nicht weisst – dann wird auch keine Marge behauptet."),
      gebackenZeile
    );

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
      const alle = store.getProdukte();
      const neu = {
        id: vorhanden?.id,
        name: name.value.trim(),
        preis: Number(preis.value) || 0,
        kosten: Number(kosten.value) || 0,
        gebacken: gebacken.checked,
      };
      store.setProdukte(vorhanden ? alle.map((p) => (p.id === vorhanden.id ? neu : p)) : [...alle, neu]);
      overlay.remove();
      rerender();
    };
    akt.append(abbrechen, speichern);
    box.appendChild(akt);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    name.focus();
  }

  // ---------------------------------------------------------------------
  // Schichten
  // ---------------------------------------------------------------------
  function buildSchichten() {
    const card = document.createElement("section");
    card.className = "card";
    card.innerHTML = `<h2>Schichten</h2>
      <p class="muted small">Die Schichten, für die sich das Team einträgt und die im Plan stehen. Änderungen
      gelten ab sofort für alles, was noch geplant wird – bereits eingeteilte Tage behalten ihre Zeiten.</p>`;

    const slots = store.getShiftSlotsForRole("service");
    const liste = document.createElement("div");
    liste.className = "task-list";
    for (const s of slots) {
      const row = document.createElement("div");
      row.className = "task-row";
      const tage = s.allowedWeekdays ? s.allowedWeekdays.map((w) => ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"][w]).join(", ") : "jeden Tag";
      row.innerHTML = `<div class="task-row-text"><span><b>${escapeHtml(s.label)}</b> · ${escapeHtml(s.from)}–${escapeHtml(s.to)}</span>
        <span class="muted small task-row-meta">${escapeHtml(tage)}</span></div>`;
      const akt = document.createElement("div");
      akt.className = "employee-actions";
      const aendern = document.createElement("button");
      aendern.className = "btn btn-secondary";
      aendern.textContent = "Ändern";
      aendern.onclick = () => openSchicht(s);
      const weg = document.createElement("button");
      weg.className = "btn btn-link";
      weg.textContent = "✕";
      weg.onclick = async () => {
        if (!(await confirmDialog(`Schicht „${s.label}“ löschen? Schon eingeteilte Tage bleiben unverändert.`, { danger: true, okLabel: "Löschen" }))) return;
        store.setShiftSlots(slots.filter((x) => x.id !== s.id));
        rerender();
      };
      akt.append(aendern, weg);
      row.appendChild(akt);
      liste.appendChild(row);
    }
    if (slots.length === 0) liste.innerHTML = `<p class="muted small">Noch keine Schicht angelegt – dann kann sich auch niemand eintragen.</p>`;
    card.appendChild(liste);

    const neu = document.createElement("button");
    neu.className = "btn btn-primary";
    neu.textContent = "＋ Schicht";
    neu.onclick = () => openSchicht(null);
    card.appendChild(neu);
    return card;
  }

  function openSchicht(vorhanden) {
    const overlay = document.createElement("div");
    overlay.className = "overlay";
    const box = document.createElement("div");
    box.className = "dialog";
    box.innerHTML = `<h2>${vorhanden ? "Schicht ändern" : "Neue Schicht"}</h2>`;
    const feld = (label, node, hinweis) => {
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
    };
    const label = Object.assign(document.createElement("input"), { type: "text", value: vorhanden?.label || "", placeholder: "z.B. Früh" });
    const von = Object.assign(document.createElement("input"), { type: "time", step: 300, value: vorhanden?.from || "" });
    const bis = Object.assign(document.createElement("input"), { type: "time", step: 300, value: vorhanden?.to || "" });
    const tage = document.createElement("div");
    tage.className = "handoff-days";
    let gewaehlt = [...(vorhanden?.allowedWeekdays || [])];
    ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"].forEach((t, i) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = t;
      const male = () => (b.className = "btn " + (gewaehlt.includes(i) ? "btn-primary" : "btn-secondary"));
      b.onclick = () => {
        gewaehlt = gewaehlt.includes(i) ? gewaehlt.filter((x) => x !== i) : [...gewaehlt, i].sort((a, c) => a - c);
        male();
      };
      male();
      tage.appendChild(b);
    });
    const reihe = document.createElement("div");
    reihe.className = "res-form-row";
    reihe.append(feld("Von", von), feld("Bis", bis));
    box.append(feld("Name", label), reihe, feld("An welchen Tagen?", tage, "Keiner gewählt = jeden Tag."));

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
      if (!label.value.trim()) return alertDialog("Bitte einen Namen eintragen.");
      if (!von.value || !bis.value) return alertDialog("Bitte Anfang und Ende eintragen.");
      const alle = store.getShiftSlotsForRole("service");
      const neu = {
        id: vorhanden?.id,
        label: label.value.trim(),
        from: von.value,
        to: bis.value,
        allowedWeekdays: gewaehlt.length > 0 ? gewaehlt : undefined,
      };
      store.setShiftSlots(vorhanden ? alle.map((s) => (s.id === vorhanden.id ? neu : s)) : [...alle, neu]);
      overlay.remove();
      rerender();
    };
    akt.append(abbrechen, speichern);
    box.appendChild(akt);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    label.focus();
  }

  rerender();
  return container;
}

export { renderPopupAdmin };
