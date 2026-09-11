// ============================================================================
// social/posts.js – Redaktionsplan: die Posts als Liste, nach Status sortiert, und das Formular dazu.
//
// Die Liste ist bewusst nach STATUS gruppiert und nicht nach Datum. Beim Arbeiten will man wissen, was
// als Nächstes zu tun ist – und das ist immer der Status: was wartet auf Freigabe, was ist noch Idee.
// Wann etwas rausgeht, zeigt der Kalender.
// ============================================================================
import { STATUS, STATUS_REIHE, escapeHtml, el, feld, auswahl, dateDeLang, interaktionen, interaktionsrate, zahl, prozent } from "./gemeinsam.js";

/** Offene Freigaben. Steht ganz oben, weil es das Einzige ist, das WARTET: ein Post in Freigabe hält
 * jemand anderen auf, alles andere liegt bei einem selbst. */
function renderFreigaben(daten, { onStatus, onOeffnen, rolle }) {
  const offen = (daten.posts || []).filter((p) => p.status === "freigabe");
  if (offen.length === 0) return null;
  const card = el("section", "card sm-freigabe");
  card.appendChild(
    el("h2", null, `⏳ ${offen.length} ${offen.length === 1 ? "Post wartet" : "Posts warten"} auf Freigabe`)
  );
  if (rolle !== "boss") {
    card.appendChild(el("p", "muted small", "Karim muss freigeben, dann kann es raus."));
  }
  const liste = el("div", "task-list");
  for (const p of offen.sort((a, b) => a.datum.localeCompare(b.datum))) {
    const row = el("div", "task-row");
    row.innerHTML = `<div class="task-row-text"><span><b>${escapeHtml(p.titel)}</b></span>
      <span class="muted small task-row-meta">${escapeHtml(dateDeLang(p.datum))}${
        p.uhrzeit ? " · " + escapeHtml(p.uhrzeit) + " Uhr" : ""
      } · ${escapeHtml(p.kanal)} · ${escapeHtml(p.format)}</span></div>`;
    const akt = el("div", "employee-actions");
    const ansehen = el("button", "btn btn-secondary", "Ansehen");
    ansehen.onclick = () => onOeffnen(p);
    akt.appendChild(ansehen);
    if (rolle === "boss") {
      const frei = el("button", "btn btn-primary", "Freigeben");
      frei.onclick = () => onStatus(p, "geplant");
      const zurueck = el("button", "btn btn-link", "Zurück an sie");
      zurueck.onclick = () => onStatus(p, "inArbeit", true);
      akt.append(frei, zurueck);
    }
    row.appendChild(akt);
    liste.appendChild(row);
  }
  card.appendChild(liste);
  return card;
}

/** Der Redaktionsplan als Liste, nach Status gruppiert. */
function renderPosts(daten, { onOeffnen, onStatus, onNeu, filter, onFilter }) {
  const wrap = el("div");
  const kopf = el("div", "sm-kal-kopf");
  kopf.appendChild(el("h2", "sm-kal-titel", "Redaktionsplan"));
  const neu = el("button", "btn btn-primary", "＋ Post");
  neu.onclick = () => onNeu(null);
  kopf.appendChild(neu);
  wrap.appendChild(kopf);

  // Filter: Kanal und Rubrik. Mehr braucht es nicht – wer nach Status filtern will, sieht ihn ohnehin
  // als Überschrift.
  const filterReihe = el("div", "res-form-row");
  const kanal = auswahl([{ wert: "", label: "Alle Kanäle" }, ...(daten.config?.kanaele || []).map((k) => ({ wert: k, label: k }))], filter.kanal);
  kanal.onchange = () => onFilter({ ...filter, kanal: kanal.value });
  const rubrik = auswahl([{ wert: "", label: "Alle Rubriken" }, ...(daten.config?.rubriken || []).map((k) => ({ wert: k, label: k }))], filter.rubrik);
  rubrik.onchange = () => onFilter({ ...filter, rubrik: rubrik.value });
  filterReihe.append(feld("Kanal", kanal), feld("Rubrik", rubrik));
  wrap.appendChild(filterReihe);

  const posts = (daten.posts || []).filter(
    (p) => (!filter.kanal || p.kanal === filter.kanal) && (!filter.rubrik || p.rubrik === filter.rubrik)
  );
  if (posts.length === 0) {
    wrap.appendChild(el("section", "card", `<p class="muted small">Noch kein Post geplant. Fang mit einer Idee an – Datum und Titel reichen.</p>`));
    return wrap;
  }

  for (const status of STATUS_REIHE) {
    const drin = posts.filter((p) => p.status === status);
    if (drin.length === 0) continue;
    const card = el("section", "card");
    const s = STATUS[status];
    card.appendChild(el("h2", null, `<span class="sm-punkt" style="background:${s.farbe}"></span> ${s.label} <span class="muted">(${drin.length})</span>`));
    const liste = el("div", "task-list");
    // Innerhalb eines Status nach Datum: was zuerst raus muss, steht oben.
    for (const p of drin.sort((a, b) => (a.datum + (a.uhrzeit || "")).localeCompare(b.datum + (b.uhrzeit || "")))) {
      const row = el("div", "task-row");
      const teile = [
        dateDeLang(p.datum) + (p.uhrzeit ? ` · ${p.uhrzeit} Uhr` : ""),
        p.kanal,
        p.format,
        p.rubrik || null,
        p.verantwortlich || null,
      ].filter(Boolean);
      const rate = interaktionsrate(p);
      row.innerHTML = `<div class="task-row-text"><span><b>${escapeHtml(p.titel)}</b></span>
        <span class="muted small task-row-meta">${escapeHtml(teile.join(" · "))}</span>
        ${
          p.statistik
            ? `<span class="muted small task-row-meta">📊 ${zahl(p.statistik.reichweite)} Reichweite · ${zahl(
                interaktionen(p)
              )} Interaktionen${rate !== null ? " · " + prozent(rate) : ""}</span>`
            : ""
        }</div>`;
      const akt = el("div", "employee-actions");
      const oeffnen = el("button", "btn btn-secondary", "Öffnen");
      oeffnen.onclick = () => onOeffnen(p);
      akt.appendChild(oeffnen);
      if (s.naechster) {
        const weiter = el("button", "btn btn-primary", s.naechsterLabel);
        weiter.onclick = () => onStatus(p, s.naechster);
        akt.appendChild(weiter);
      }
      row.appendChild(akt);
      liste.appendChild(row);
    }
    card.appendChild(liste);
    wrap.appendChild(card);
  }
  return wrap;
}

/** Formular für einen Post. Enthält bewusst auch die Caption: sie irgendwo anders zu schreiben und dann
 * zu kopieren, ist genau die Stelle, an der die falsche Fassung rausgeht. */
function openPostDialog(daten, post, { onSpeichern, onLoeschen, onStatus, onStats, rolle, vorgabe }) {
  const overlay = el("div", "overlay");
  const box = el("div", "dialog sm-dialog");
  box.appendChild(el("h2", null, post ? "Post bearbeiten" : "Neuer Post"));

  // vorgabe kommt aus dem Kalender ("hier etwas eintragen") und belegt nur das Datum vor. Frueher habe
  // ich dafuer ein halbes Post-Objekt gebaut – das sah im Dialog wie ein bestehender Post aus und
  // haette beim Speichern eine Aenderung an etwas ausgeloest, das es nicht gibt.
  const entwurf = {
    datum: post?.datum || vorgabe?.datum || daten.heute,
    uhrzeit: post?.uhrzeit || "",
    kanal: post?.kanal || daten.config.kanaele[0],
    format: post?.format || daten.config.formate[0],
    rubrik: post?.rubrik || "",
    titel: post?.titel || "",
    caption: post?.caption || "",
    notiz: post?.notiz || "",
    verantwortlich: post?.verantwortlich || "",
  };

  const datum = document.createElement("input");
  datum.type = "date";
  datum.value = entwurf.datum;
  const uhrzeit = document.createElement("input");
  uhrzeit.type = "time";
  uhrzeit.step = 300;
  uhrzeit.value = entwurf.uhrzeit;
  const kanal = auswahl(daten.config.kanaele, entwurf.kanal);
  const format = auswahl(daten.config.formate, entwurf.format);
  const rubrik = auswahl([{ wert: "", label: "–" }, ...daten.config.rubriken.map((r) => ({ wert: r, label: r }))], entwurf.rubrik);
  const titel = document.createElement("input");
  titel.type = "text";
  titel.placeholder = "z.B. Neue Bowl auf der Karte";
  titel.value = entwurf.titel;
  const verantwortlich = document.createElement("input");
  verantwortlich.type = "text";
  verantwortlich.placeholder = "Wer macht es?";
  verantwortlich.value = entwurf.verantwortlich;
  const caption = document.createElement("textarea");
  caption.rows = 6;
  caption.placeholder = "Der Text, so wie er rausgeht – inklusive Hashtags.";
  caption.value = entwurf.caption;
  const notiz = document.createElement("textarea");
  notiz.rows = 2;
  notiz.placeholder = "z.B. Foto vom Shooting am 12., Reihenfolge beachten";
  notiz.value = entwurf.notiz;

  const reihe1 = el("div", "res-form-row");
  reihe1.append(feld("Datum", datum), feld("Uhrzeit", uhrzeit), feld("Kanal", kanal), feld("Format", format));
  const reihe2 = el("div", "res-form-row");
  reihe2.append(feld("Rubrik", rubrik), feld("Wer macht es?", verantwortlich));
  box.append(reihe1, feld("Titel", titel), reihe2, feld("Text / Caption", caption), feld("Notiz", notiz));

  if (post) {
    const s = STATUS[post.status];
    const standRow = el("p", "muted small", `Status: <b style="color:${s.farbe}">${s.label}</b>`);
    box.appendChild(standRow);
    if (post.freigabeNotiz) {
      box.appendChild(el("div", "callout callout-warn", `<b>Anmerkung von Karim:</b> ${escapeHtml(post.freigabeNotiz)}`));
    }
    const statusReihe = el("div", "employee-actions");
    for (const ziel of STATUS_REIHE) {
      if (ziel === post.status) continue;
      // Freigeben darf nur der Inhaber – sonst wäre die Freigabe eine Formsache, die sich selbst abnickt.
      if (ziel === "geplant" && post.status === "freigabe" && rolle !== "boss") continue;
      const b = el("button", "btn btn-secondary", STATUS[ziel].kurz);
      b.onclick = () => onStatus(post, ziel);
      statusReihe.appendChild(b);
    }
    box.appendChild(feld("Status ändern", statusReihe));
  }

  const fehler = el("p", "muted small");
  box.appendChild(fehler);

  const akt = el("div", "dialog-actions");
  const abbrechen = el("button", "btn btn-secondary", "Abbrechen");
  abbrechen.onclick = () => overlay.remove();
  const speichern = el("button", "btn btn-primary", "Speichern");
  speichern.onclick = () => {
    if (!titel.value.trim()) {
      fehler.className = "res-warn small";
      fehler.textContent = "Bitte einen Titel angeben.";
      return;
    }
    overlay.remove();
    onSpeichern(post, {
      datum: datum.value,
      uhrzeit: uhrzeit.value,
      kanal: kanal.value,
      format: format.value,
      rubrik: rubrik.value,
      titel: titel.value,
      caption: caption.value,
      notiz: notiz.value,
      verantwortlich: verantwortlich.value,
    });
  };
  akt.append(abbrechen, speichern);
  box.appendChild(akt);

  if (post) {
    const unten = el("div", "res-dialog-danger");
    const zahlen = el("button", "btn btn-secondary", post.statistik ? "Zahlen ändern" : "📊 Zahlen eintragen");
    zahlen.onclick = () => {
      overlay.remove();
      onStats(post);
    };
    const weg = el("button", "btn btn-link", "Löschen");
    weg.onclick = () => {
      overlay.remove();
      onLoeschen(post);
    };
    unten.append(zahlen, weg);
    box.appendChild(unten);
  }

  overlay.appendChild(box);
  document.body.appendChild(overlay);
  titel.focus();
}

/** Die Zahlen eines Posts von Hand nachtragen. Es gibt keinen API-Zugang zu Instagram & Co. – wer das
 * anders verspricht, baut eine Zahl, die niemand nachprüfen kann. Leere Felder bleiben leer. */
function openStatsDialog(post, { onSpeichern }) {
  const overlay = el("div", "overlay");
  const box = el("div", "dialog");
  box.appendChild(el("h2", null, "Zahlen eintragen"));
  box.appendChild(el("p", "muted small", `${escapeHtml(post.titel)} · ${escapeHtml(post.kanal)}`));
  box.appendChild(
    el(
      "p",
      "muted small",
      "Aus den Insights der App abgelesen. Was du nicht ablesen kannst, lass leer – eine 0 hieße „lief nicht“."
    )
  );

  const felder = {};
  const mk = (schluessel, label) => {
    const i = document.createElement("input");
    i.type = "number";
    i.min = "0";
    i.inputMode = "numeric";
    i.value = post.statistik?.[schluessel] ?? "";
    felder[schluessel] = i;
    return feld(label, i);
  };
  const r1 = el("div", "res-form-row");
  r1.append(mk("reichweite", "Reichweite"), mk("likes", "Likes"), mk("kommentare", "Kommentare"));
  const r2 = el("div", "res-form-row");
  r2.append(mk("saves", "Gespeichert"), mk("shares", "Geteilt"), mk("profilaufrufe", "Profilaufrufe"));
  const r3 = el("div", "res-form-row");
  r3.append(mk("neueFollower", "Neue Follower"));
  box.append(r1, r2, r3);

  const akt = el("div", "dialog-actions");
  const abbrechen = el("button", "btn btn-secondary", "Abbrechen");
  abbrechen.onclick = () => overlay.remove();
  const speichern = el("button", "btn btn-primary", "Speichern");
  speichern.onclick = () => {
    const werte = {};
    for (const [k, i] of Object.entries(felder)) werte[k] = i.value;
    overlay.remove();
    onSpeichern(post, werte);
  };
  akt.append(abbrechen, speichern);
  box.appendChild(akt);
  overlay.appendChild(box);
  document.body.appendChild(overlay);
}

export { renderPosts, renderFreigaben, openPostDialog, openStatsDialog };
