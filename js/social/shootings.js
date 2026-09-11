// ============================================================================
// social/shootings.js – Shootings und die Listen (Ideen, Hashtags, Aufgaben).
//
// Zwei Dinge in einer Datei, weil sie dieselbe Form haben: eine Sache mit abhakbaren Punkten darunter.
// Beim Shooting ist es die Shotlist – und die ist der eigentliche Grund für den Termin. Ein Shooting
// ohne Shotlist ist ein Nachmittag, an dem man merkt, dass das eine Foto fehlt.
// ============================================================================
import { escapeHtml, el, feld, dateDeLang } from "./gemeinsam.js";

function renderShootings(daten, { onNeu, onOeffnen, onShot, onErledigt }) {
  const wrap = el("div");
  const kopf = el("div", "sm-kal-kopf");
  kopf.appendChild(el("h2", "sm-kal-titel", "Shootings"));
  const neu = el("button", "btn btn-primary", "＋ Shooting");
  neu.onclick = () => onNeu(null);
  kopf.appendChild(neu);
  wrap.appendChild(kopf);

  const alle = [...(daten.shootings || [])].sort((a, b) => a.datum.localeCompare(b.datum));
  const kommend = alle.filter((s) => s.datum >= daten.heute && !s.erledigt);
  const rest = alle.filter((s) => !kommend.includes(s)).reverse();

  if (alle.length === 0) {
    wrap.appendChild(
      el("section", "card", `<p class="muted small">Noch kein Shooting geplant. Trag eins ein und schreib die Shotlist dazu – das ist der Teil, der am Tag selbst zählt.</p>`)
    );
    return wrap;
  }

  const abschnitt = (titel, liste) => {
    if (liste.length === 0) return;
    wrap.appendChild(el("p", "muted small res-bereich", `<b>${titel}</b>`));
    for (const s of liste) wrap.appendChild(buildShootingKarte(s, { onOeffnen, onShot, onErledigt }));
  };
  abschnitt("Kommt", kommend);
  abschnitt("Vorbei", rest);
  return wrap;
}

function buildShootingKarte(s, { onOeffnen, onShot, onErledigt }) {
  const card = el("section", "card" + (s.erledigt ? " sm-erledigt" : ""));
  const teile = [dateDeLang(s.datum), s.von ? `${s.von}${s.bis ? "–" + s.bis : ""} Uhr` : null, s.ort || null, s.wer || null].filter(Boolean);
  card.appendChild(el("h2", null, `📸 ${escapeHtml(s.thema || "Shooting")}`));
  card.appendChild(el("p", "muted small", escapeHtml(teile.join(" · "))));
  if (s.notiz) card.appendChild(el("p", "muted small", escapeHtml(s.notiz)));

  const offen = (s.shotlist || []).filter((z) => !z.erledigt).length;
  const gesamt = (s.shotlist || []).length;
  if (gesamt > 0) {
    card.appendChild(el("p", "muted small", `Shotlist: ${gesamt - offen} von ${gesamt} erledigt`));
  }
  const liste = el("div", "task-list");
  for (const z of s.shotlist || []) {
    const row = el("label", "task-row" + (z.erledigt ? " done" : ""));
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = !!z.erledigt;
    cb.onchange = () => onShot(s, { shotAktion: "toggle", shotId: z.id });
    row.appendChild(cb);
    row.appendChild(el("div", "task-row-text", `<span>${escapeHtml(z.text)}</span>`));
    const weg = el("button", "btn btn-link", "✕");
    weg.type = "button";
    weg.onclick = (e) => {
      e.preventDefault();
      onShot(s, { shotAktion: "delete", shotId: z.id });
    };
    row.appendChild(weg);
    liste.appendChild(row);
  }
  card.appendChild(liste);

  const eingabe = el("div", "task-add-row");
  const feldNeu = document.createElement("input");
  feldNeu.type = "text";
  feldNeu.placeholder = "Was muss aufs Bild?";
  const add = el("button", "btn btn-secondary", "＋");
  const absenden = () => {
    if (!feldNeu.value.trim()) return;
    onShot(s, { shotAktion: "add", shotText: feldNeu.value });
    feldNeu.value = "";
  };
  add.onclick = absenden;
  feldNeu.addEventListener("keydown", (e) => {
    if (e.key === "Enter") absenden();
  });
  eingabe.append(feldNeu, add);
  card.appendChild(eingabe);

  const akt = el("div", "employee-actions");
  const bearbeiten = el("button", "btn btn-secondary", "Ändern");
  bearbeiten.onclick = () => onOeffnen(s);
  const fertig = el("button", "btn " + (s.erledigt ? "btn-link" : "btn-primary"), s.erledigt ? "Wieder öffnen" : "Erledigt");
  fertig.onclick = () => onErledigt(s, !s.erledigt);
  akt.append(bearbeiten, fertig);
  card.appendChild(akt);
  return card;
}

function openShootingDialog(daten, shooting, { onSpeichern, onLoeschen, vorgabe }) {
  const overlay = el("div", "overlay");
  const box = el("div", "dialog");
  box.appendChild(el("h2", null, shooting ? "Shooting ändern" : "Neues Shooting"));

  const datum = document.createElement("input");
  datum.type = "date";
  datum.value = shooting?.datum || vorgabe?.datum || daten.heute;
  const von = document.createElement("input");
  von.type = "time";
  von.step = 300;
  von.value = shooting?.von || "";
  const bis = document.createElement("input");
  bis.type = "time";
  bis.step = 300;
  bis.value = shooting?.bis || "";
  const thema = document.createElement("input");
  thema.type = "text";
  thema.placeholder = "z.B. Herbstkarte";
  thema.value = shooting?.thema || "";
  const ort = document.createElement("input");
  ort.type = "text";
  ort.placeholder = "z.B. im Laden, Terrasse";
  ort.value = shooting?.ort || "";
  const wer = document.createElement("input");
  wer.type = "text";
  wer.placeholder = "z.B. Karim, Nina, Fotograf";
  wer.value = shooting?.wer || "";
  const notiz = document.createElement("textarea");
  notiz.rows = 3;
  notiz.placeholder = "Was mitbringen, worauf achten…";
  notiz.value = shooting?.notiz || "";

  const r1 = el("div", "res-form-row");
  r1.append(feld("Datum", datum), feld("Von", von), feld("Bis", bis));
  const r2 = el("div", "res-form-row");
  r2.append(feld("Thema", thema), feld("Ort", ort));
  box.append(r1, r2, feld("Wer ist dabei?", wer), feld("Notiz", notiz));

  const akt = el("div", "dialog-actions");
  const abbrechen = el("button", "btn btn-secondary", "Abbrechen");
  abbrechen.onclick = () => overlay.remove();
  const speichern = el("button", "btn btn-primary", "Speichern");
  speichern.onclick = () => {
    overlay.remove();
    onSpeichern(shooting, {
      datum: datum.value,
      von: von.value,
      bis: bis.value,
      thema: thema.value,
      ort: ort.value,
      wer: wer.value,
      notiz: notiz.value,
    });
  };
  akt.append(abbrechen, speichern);
  box.appendChild(akt);
  if (shooting) {
    const unten = el("div", "res-dialog-danger");
    const weg = el("button", "btn btn-link", "Löschen");
    weg.onclick = () => {
      overlay.remove();
      onLoeschen(shooting);
    };
    unten.appendChild(weg);
    box.appendChild(unten);
  }
  overlay.appendChild(box);
  document.body.appendChild(overlay);
  thema.focus();
}

// ---------------------------------------------------------------------
// Listen
// ---------------------------------------------------------------------

/** Frei anlegbare Listen: Ideen, Hashtag-Sets, Aufgaben, Content-Säulen. Bewusst ohne feste Struktur –
 * jeder sortiert anders, und eine erzwungene Ordnung wäre in zwei Wochen im Weg. */
function renderListen(daten, { onListe }) {
  const wrap = el("div");
  const kopf = el("div", "sm-kal-kopf");
  kopf.appendChild(el("h2", "sm-kal-titel", "Listen"));
  const neu = el("button", "btn btn-primary", "＋ Liste");
  neu.onclick = () => {
    const titel = prompt("Wie soll die Liste heißen?\n\nz.B. Ideen, Hashtags Frühstück, Muss noch erledigt werden");
    if (titel && titel.trim()) onListe({ kind: "create", titel: titel.trim() });
  };
  kopf.appendChild(neu);
  wrap.appendChild(kopf);

  const listen = daten.listen || [];
  if (listen.length === 0) {
    wrap.appendChild(
      el(
        "section",
        "card",
        `<p class="muted small">Noch keine Liste. Typisch sind: <b>Ideen</b> (was uns einfällt, bevor es ein Post wird),
         <b>Hashtag-Sets</b> (damit nicht jedes Mal neu getippt wird) und <b>Muss noch erledigt werden</b>.</p>`
      )
    );
    return wrap;
  }

  for (const l of listen) {
    const card = el("section", "card");
    const offen = (l.eintraege || []).filter((e) => !e.erledigt).length;
    const kopfzeile = el("div", "sm-kal-kopf");
    kopfzeile.appendChild(el("h2", "sm-kal-titel", `${escapeHtml(l.titel)} <span class="muted">(${offen})</span>`));
    const weg = el("button", "btn btn-link", "Liste löschen");
    weg.onclick = () => {
      if (confirm(`Liste „${l.titel}" mit allen Einträgen löschen?`)) onListe({ kind: "delete", listeId: l.id });
    };
    kopfzeile.appendChild(weg);
    card.appendChild(kopfzeile);

    const liste = el("div", "task-list");
    // Offene zuerst: das Erledigte ist Archiv und soll nicht die Hälfte des Bildschirms einnehmen.
    const sortiert = [...(l.eintraege || [])].sort((a, b) => Number(a.erledigt) - Number(b.erledigt));
    for (const e of sortiert) {
      const row = el("label", "task-row" + (e.erledigt ? " done" : ""));
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = !!e.erledigt;
      cb.onchange = () => onListe({ kind: "toggle", listeId: l.id, eintragId: e.id });
      row.appendChild(cb);
      row.appendChild(el("div", "task-row-text", `<span>${escapeHtml(e.text)}</span>`));
      const x = el("button", "btn btn-link", "✕");
      x.type = "button";
      x.onclick = (ev) => {
        ev.preventDefault();
        onListe({ kind: "removeItem", listeId: l.id, eintragId: e.id });
      };
      row.appendChild(x);
      liste.appendChild(row);
    }
    card.appendChild(liste);

    const eingabe = el("div", "task-add-row");
    const neuText = document.createElement("input");
    neuText.type = "text";
    neuText.placeholder = "Neuer Eintrag";
    const add = el("button", "btn btn-secondary", "＋");
    const absenden = () => {
      if (!neuText.value.trim()) return;
      onListe({ kind: "add", listeId: l.id, eintragText: neuText.value });
      neuText.value = "";
    };
    add.onclick = absenden;
    neuText.addEventListener("keydown", (e) => {
      if (e.key === "Enter") absenden();
    });
    eingabe.append(neuText, add);
    card.appendChild(eingabe);
    wrap.appendChild(card);
  }
  return wrap;
}

export { renderShootings, openShootingDialog, renderListen };
