// ============================================================================
// mitarbeiter/app.js – Handy-Ansicht für Mitarbeiter.
// Bewusst OHNE Ein-/Ausstempeln: das bleibt am iPad im Café, damit niemand aus
// der Ferne für sich oder andere stempeln kann.
// ============================================================================
import { getSession, clearSession, getWorkerUrl, setWorkerUrl, login, getMe, sendAvailability, reportSick, markNotificationsRead } from "./api.js";
import { euro, hours, escapeHtml, dateDe, todayStr } from "../format.js";

const outlet = document.getElementById("outlet");
const WEEKDAYS = ["Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag", "Sonntag"];

let me = null;
// Kurzmeldung, die nach dem Neuladen EINMAL oben erscheint (sonst wäre sie durch das Rerendern sofort weg).
let flash = null;

const show = (node) => {
  outlet.innerHTML = "";
  outlet.appendChild(node);
};

function mondayOf(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const day = dt.getUTCDay();
  dt.setUTCDate(dt.getUTCDate() + (day === 0 ? -6 : 1 - day));
  return dt.toISOString().slice(0, 10);
}
function addDaysISO(dateStr, n) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}
const dateDeShort = (s) => {
  const [, m, d] = s.split("-");
  return `${d}.${m}.`;
};
function weekdayIndex(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return wd === 0 ? 6 : wd - 1;
}
/** Zeiten, die an DIESEM Wochentag gelten (manche Schichten enden an einzelnen Tagen später).
 * Bewusst klein gehalten und gespiegelt aus js/store.js – diese Ansicht kennt den Store nicht. */
function slotAmTag(slot, wochentagIndex) {
  const ov = slot?.weekdayOverrides?.[wochentagIndex];
  return ov ? { ...slot, ...ov } : slot;
}

// ---------------------------------------------------------------------
// Anmeldung
// ---------------------------------------------------------------------
function renderLogin(message) {
  const wrap = document.createElement("div");
  wrap.className = "page";
  wrap.innerHTML = `<h1>☕ Anmelden</h1><p class="muted">Mit deinem PIN vom Café.</p>`;

  const card = document.createElement("section");
  card.className = "card";

  // Adresse muss nur beim allerersten Mal eingetragen werden.
  const needsUrl = !getWorkerUrl();
  const urlInput = document.createElement("input");
  if (needsUrl) {
    const urlWrap = document.createElement("label");
    urlWrap.className = "field";
    urlWrap.innerHTML = `<span>Adresse (bekommst du vom Chef)</span>`;
    urlInput.type = "text";
    urlInput.placeholder = "https://…workers.dev";
    urlWrap.appendChild(urlInput);
    card.appendChild(urlWrap);
  }

  const pinWrap = document.createElement("label");
  pinWrap.className = "field";
  pinWrap.innerHTML = `<span>Dein PIN</span>`;
  const pin = document.createElement("input");
  pin.type = "password";
  pin.inputMode = "numeric";
  pin.autocomplete = "current-password";
  pinWrap.appendChild(pin);

  const status = document.createElement("p");
  status.className = message ? "callout callout-warn" : "muted small";
  status.textContent = message || "";

  const btn = document.createElement("button");
  btn.className = "btn btn-primary btn-huge";
  btn.textContent = "Anmelden";

  const submit = async () => {
    if (needsUrl) {
      if (!urlInput.value.trim()) {
        status.className = "callout callout-warn";
        status.textContent = "Bitte die Adresse eintragen.";
        return;
      }
      setWorkerUrl(urlInput.value.trim());
    }
    btn.disabled = true;
    status.className = "muted small";
    status.textContent = "Melde an…";
    try {
      await login(pin.value.trim());
      await load();
    } catch (e) {
      status.className = "callout callout-warn";
      status.textContent = "⚠ " + e.message;
      btn.disabled = false;
    }
  };
  btn.onclick = submit;
  pin.addEventListener("keydown", (e) => e.key === "Enter" && submit());

  card.append(pinWrap, status, btn);
  wrap.appendChild(card);
  show(wrap);
}

// ---------------------------------------------------------------------
// Hauptansicht
// ---------------------------------------------------------------------
function renderMain() {
  const wrap = document.createElement("div");
  wrap.className = "page";

  const head = document.createElement("div");
  head.className = "chef-head";
  head.innerHTML = `<div><b>Hallo ${escapeHtml(me.name)}</b></div>`;
  const logout = document.createElement("button");
  logout.className = "btn btn-secondary";
  logout.textContent = "Abmelden";
  logout.onclick = () => {
    clearSession();
    renderLogin();
  };
  head.appendChild(logout);
  wrap.appendChild(head);

  if (flash) {
    const f = document.createElement("div");
    f.className = "callout";
    f.textContent = flash;
    wrap.appendChild(f);
    flash = null;
  }

  wrap.appendChild(buildPostfach());
  wrap.appendChild(buildShifts());
  wrap.appendChild(buildWochenplan());
  wrap.appendChild(buildAvailability());
  wrap.appendChild(buildSick());
  wrap.appendChild(buildNumbers());
  show(wrap);

  // Nachrichten vom Chef (Schicht zugesagt/abgelehnt) als Pop-up – wie am iPad im Kiosk.
  if ((me.neueNachrichten || []).length > 0) showMessages(me.neueNachrichten);
}

function showMessages(nachrichten) {
  const overlay = document.createElement("div");
  overlay.className = "overlay";
  overlay.innerHTML = `
    <div class="dialog">
      <h2>📬 ${nachrichten.length === 1 ? "Nachricht vom Chef" : `${nachrichten.length} Nachrichten vom Chef`}</h2>
      <div class="task-list">
        ${nachrichten
          .map((n) => `<div class="task-row"><div class="task-row-text"><span>${escapeHtml(n.text).replace(/\n/g, "<br/>")}</span></div></div>`)
          .join("")}
      </div>
      <div class="dialog-actions"><button class="btn btn-primary" id="msg-ok">Verstanden</button></div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.querySelector("#msg-ok").onclick = async () => {
    overlay.remove();
    // Fehler hier bewusst schlucken: gelingt das Markieren nicht, erscheint die Nachricht halt nochmal –
    // besser als eine Fehlermeldung, die die Person nicht einordnen kann.
    try {
      await markNotificationsRead(nachrichten.map((n) => n.id));
      me.neueNachrichten = [];
    } catch {}
  };
}

/** Postfach: alle Nachrichten vom Chef, auch bereits gelesene – zum Nachschlagen. */
function buildPostfach() {
  const card = document.createElement("section");
  card.className = "card";
  const nachrichten = me.postfach || [];
  const ungelesen = nachrichten.filter((n) => !n.gelesen).length;
  card.innerHTML = `<h2>📬 Postfach${ungelesen > 0 ? ` <span class="badge badge-orange">${ungelesen} neu</span>` : ""}</h2>`;

  if (nachrichten.length === 0) {
    const p = document.createElement("p");
    p.className = "muted small";
    p.textContent = "Noch keine Nachrichten.";
    card.appendChild(p);
    return card;
  }

  const zeige = (anzahl) => {
    card.querySelector(".task-list")?.remove();
    card.querySelector(".pf-more")?.remove();
    const list = document.createElement("div");
    list.className = "task-list";
    for (const n of nachrichten.slice(0, anzahl)) {
      const row = document.createElement("div");
      row.className = "task-row";
      const datum = new Date(n.createdAt).toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "2-digit" });
      row.innerHTML = `<div class="task-row-text"><span>${escapeHtml(n.text).replace(/\n/g, "<br/>")}</span><span class="muted small task-row-meta">${datum}${
        n.gelesen ? "" : " · neu"
      }</span></div>`;
      list.appendChild(row);
    }
    card.appendChild(list);
    if (nachrichten.length > anzahl) {
      const mehr = document.createElement("button");
      mehr.className = "btn btn-secondary pf-more";
      mehr.textContent = `Ältere anzeigen (${nachrichten.length - anzahl})`;
      mehr.onclick = () => zeige(nachrichten.length);
      card.appendChild(mehr);
    }
  };
  zeige(5);
  return card;
}

function buildShifts() {
  const card = document.createElement("section");
  card.className = "card";
  card.innerHTML = `<h2>📅 Deine Schichten</h2>`;
  const heute = me.heute;

  // Bestätigte Schichten kommen aus der eigenen Verfügbarkeit (dort hängt auch die Info des Chefs dran).
  const rows = [];
  for (const entry of Object.values(me.meineVerfuegbarkeit || {})) {
    for (const day of entry?.days || []) {
      if (day.date < heute || !day.confirmedSlotId) continue;
      const slot = (day.slots || []).find((s) => s.id === day.confirmedSlotId);
      rows.push({ date: day.date, slot, bestaetigt: !!day.bossConfirmed, note: day.note || "" });
    }
  }
  rows.sort((a, b) => (a.date < b.date ? -1 : 1));

  if (rows.length === 0) {
    const p = document.createElement("p");
    p.className = "muted small";
    p.textContent = "Für die nächsten Tage ist noch keine Schicht für dich eingetragen.";
    card.appendChild(p);
    return card;
  }
  const list = document.createElement("div");
  list.className = "task-list";
  for (const r of rows) {
    const row = document.createElement("div");
    row.className = "task-row";
    const label = r.date === heute ? "Heute" : `${WEEKDAYS[weekdayIndex(r.date)]}, ${dateDeShort(r.date)}`;
    const zeit = r.slot ? `${r.slot.from}–${r.slot.to} Uhr` : "";
    const status = r.bestaetigt ? "✅ bestätigt" : "⏳ wartet auf Bestätigung";
    const text = document.createElement("div");
    text.className = "task-row-text";
    text.innerHTML = `<span><b>${escapeHtml(label)}</b> · ${escapeHtml(zeit)}</span><span class="muted small task-row-meta">${status}</span>${
      r.note ? `<span class="muted small task-row-meta">📝 ${escapeHtml(r.note)}</span>` : ""
    }`;
    row.appendChild(text);
    list.appendChild(row);
  }
  card.appendChild(list);
  return card;
}

/** Der fertige Wochenplan – erscheint erst, wenn der Chef die Woche abgeschlossen hat.
 *
 * Hier stehen bewusst die Namen der Kollegen: jeder soll sehen, mit wem er arbeitet, und wen er fragen kann,
 * wenn er tauschen möchte. Solange eine Woche noch geplant wird, gibt es hier nichts zu sehen – das ist der
 * Sinn der Sache, niemand soll Zwischenstände mitbekommen. */
function buildWochenplan() {
  const card = document.createElement("section");
  card.className = "card";
  card.innerHTML = `<h2>📋 Schichtplan der Woche</h2>`;

  const plaene = me.wochenplaene || [];
  if (plaene.length === 0) {
    const p = document.createElement("p");
    p.className = "muted small";
    p.textContent = "Sobald der Chef den Plan für eine Woche abgeschlossen hat, steht er hier – mit allen Schichten und wer sie übernimmt.";
    card.appendChild(p);
    return card;
  }

  // Standard ist die Woche, in der wir gerade sind; sonst die erste fertige.
  const aktuellerMontag = mondayOf(me.heute);
  let index = Math.max(0, plaene.findIndex((p) => p.weekStart === aktuellerMontag));

  const nav = document.createElement("div");
  nav.className = "week-nav";
  const inhalt = document.createElement("div");

  const zeichne = () => {
    const plan = plaene[index];
    nav.innerHTML = "";
    if (plaene.length > 1) {
      const zurueck = document.createElement("button");
      zurueck.className = "btn btn-secondary";
      zurueck.textContent = "←";
      zurueck.disabled = index === 0;
      zurueck.onclick = () => {
        index--;
        zeichne();
      };
      const vor = document.createElement("button");
      vor.className = "btn btn-secondary";
      vor.textContent = "→";
      vor.disabled = index >= plaene.length - 1;
      vor.onclick = () => {
        index++;
        zeichne();
      };
      const label = document.createElement("span");
      label.className = "week-nav-label";
      label.textContent = `${dateDeShort(plan.weekStart)} – ${dateDeShort(addDaysISO(plan.weekStart, 6))}`;
      nav.append(zurueck, label, vor);
    } else {
      const label = document.createElement("span");
      label.className = "week-nav-label";
      label.textContent = `${dateDeShort(plan.weekStart)} – ${dateDeShort(addDaysISO(plan.weekStart, 6))}`;
      nav.appendChild(label);
    }

    inhalt.innerHTML = "";
    for (const tag of plan.tage) {
      const block = document.createElement("div");
      block.className = "wp-tag";
      const kopf = document.createElement("div");
      kopf.className = "wp-tag-kopf";
      kopf.textContent = `${WEEKDAYS[weekdayIndex(tag.date)]}, ${dateDeShort(tag.date)}`;
      if (tag.date === me.heute) kopf.textContent += " · heute";
      block.appendChild(kopf);

      if (tag.schichten.length === 0) {
        const leer = document.createElement("div");
        leer.className = "muted small";
        leer.textContent = "keine Schichten";
        block.appendChild(leer);
      }
      for (const s of tag.schichten) {
        const row = document.createElement("div");
        const ichSelbst = s.name && s.name.trim().toLowerCase() === me.name.trim().toLowerCase();
        row.className = "wp-row" + (ichSelbst ? " wp-mine" : "") + (s.name ? "" : " wp-frei");
        row.innerHTML = `<span class="wp-schicht">${escapeHtml(s.label)}<br/><span class="muted small">${escapeHtml(s.from)}–${escapeHtml(
          s.to
        )}</span></span><span class="wp-name">${
          s.name ? escapeHtml(s.name) + (ichSelbst ? " (du)" : "") + (s.krank ? " 🤒" : "") : '<span class="muted">frei</span>'
        }</span>`;
        block.appendChild(row);
      }
      inhalt.appendChild(block);
    }
  };
  zeichne();

  card.append(nav, inhalt);
  const fuss = document.createElement("p");
  fuss.className = "muted small";
  fuss.textContent = "Wenn du tauschen möchtest, frag die Person direkt – abgesprochene Tauschs muss der Chef noch eintragen.";
  card.appendChild(fuss);
  return card;
}

/** Verfügbarkeit für die kommende Woche eintragen: pro Tag antippen, was man übernehmen könnte. */
function buildAvailability() {
  const card = document.createElement("section");
  card.className = "card";
  const weekStart = addDaysISO(mondayOf(me.heute), 7);
  const weekEnd = addDaysISO(weekStart, 6);
  card.innerHTML = `
    <h2>🗓 Verfügbarkeit nächste Woche</h2>
    <p class="muted small">${escapeHtml(dateDeShort(weekStart))} – ${escapeHtml(dateDeShort(weekEnd))}. Tippe an, was du übernehmen könntest.
    Wählst du nur eine Schicht, ist sie sofort deine – bei mehreren entscheidet der Chef.</p>
  `;

  const alle = me.meineSchichtarten || [];
  if (alle.length === 0) {
    const p = document.createElement("p");
    p.className = "muted small";
    p.textContent = "Die Schichtzeiten sind noch nicht verfügbar. Das iPad im Café muss sich einmal abgleichen.";
    card.appendChild(p);
    return card;
  }

  // Vorhandene Auswahl aus der Cloud vorbelegen, damit man sie sieht und ändern kann.
  const vorhanden = me.meineVerfuegbarkeit?.[weekStart];
  const auswahl = new Map(); // date -> Set(slotId)
  const festeTage = new Map(); // date -> unveränderter Tages-Eintrag, den der Chef bereits bestätigt hat
  for (const day of vorhanden?.days || []) {
    auswahl.set(day.date, new Set((day.slots || []).map((s) => s.id)));
    // Vom Chef bestätigte Schichten sind nichts, was man hier versehentlich wegtippen können soll –
    // und beim Senden müssen Bestätigung und Info erhalten bleiben, sonst wären sie danach weg.
    if (day.bossConfirmed && day.confirmedSlotId) festeTage.set(day.date, day);
  }

  for (let i = 0; i < 7; i++) {
    const date = addDaysISO(weekStart, i);
    const angeboten = alle.filter((s) => !s.allowedWeekdays || s.allowedWeekdays.includes(i)).map((s) => slotAmTag(s, i));
    if (angeboten.length === 0) continue;

    const block = document.createElement("div");
    block.style.marginTop = "12px";
    const fest = festeTage.get(date);
    const label = document.createElement("div");
    label.innerHTML = `<b>${WEEKDAYS[i]}</b> <span class="muted small">${dateDeShort(date)}</span>${
      fest ? ` <span class="muted small">· ✅ fest eingeteilt</span>` : ""
    }`;
    block.appendChild(label);

    const row = document.createElement("div");
    row.className = "avail-slot-list";
    for (const slot of angeboten) {
      const belegt = (me.belegteSchichten?.[date] || []).includes(slot.id);
      const istFest = fest && fest.confirmedSlotId === slot.id;
      const btn = document.createElement("button");
      btn.className = "avail-slot-btn" + (istFest ? " active" : "");
      btn.innerHTML = `${escapeHtml(slot.label)}<br/><span>${escapeHtml(slot.from)}–${escapeHtml(slot.to)}</span>`;
      if (fest) {
        // Ganzer Tag ist entschieden: nichts anklickbar, damit die Zuteilung nicht aus Versehen kippt.
        btn.disabled = true;
        btn.title = istFest ? "Vom Chef fest eingeteilt" : "Für diesen Tag bist du schon eingeteilt";
        if (!istFest) btn.style.opacity = "0.45";
      } else if (belegt) {
        btn.disabled = true;
        btn.title = "Schon vergeben";
        btn.style.opacity = "0.45";
      } else {
        const gewaehlt = () => auswahl.get(date)?.has(slot.id);
        const paint = () => btn.classList.toggle("active", !!gewaehlt());
        paint();
        btn.onclick = () => {
          if (!auswahl.has(date)) auswahl.set(date, new Set());
          const set = auswahl.get(date);
          if (set.has(slot.id)) set.delete(slot.id);
          else set.add(slot.id);
          paint();
        };
      }
      row.appendChild(btn);
    }
    block.appendChild(row);
    card.appendChild(block);
  }

  const status = document.createElement("p");
  status.className = "muted small";
  const send = document.createElement("button");
  send.className = "btn btn-primary btn-huge";
  send.textContent = "An den Chef senden";
  send.style.marginTop = "14px";
  send.onclick = async () => {
    const days = [];
    for (const [date, set] of auswahl.entries()) {
      // Bereits fest eingeteilte Tage unverändert mitschicken: sonst würden Bestätigung und die Info des
      // Chefs beim Senden verloren gehen, weil der Eintrag als Ganzes ersetzt wird.
      const fest = festeTage.get(date);
      if (fest) {
        days.push(fest);
        continue;
      }
      if (set.size === 0) continue;
      const slots = alle.filter((s) => set.has(s.id)).map((s) => ({ id: s.id, label: s.label, from: s.from, to: s.to }));
      days.push({ date, slots, confirmedSlotId: slots.length === 1 ? slots[0].id : null, bossConfirmed: false });
    }
    if (days.length === 0) {
      status.className = "callout callout-warn";
      status.textContent = "Bitte für mindestens einen Tag eine Schicht antippen.";
      return;
    }
    send.disabled = true;
    status.className = "muted small";
    status.textContent = "Wird gesendet…";
    try {
      await sendAvailability(weekStart, days);
      flash = "✅ Verfügbarkeit gesendet. Der Chef sieht deine Auswahl.";
      await load();
    } catch (e) {
      status.className = "callout callout-warn";
      status.textContent = "⚠ " + e.message;
      send.disabled = false;
    }
  };
  card.append(send, status);
  return card;
}

function buildSick() {
  const card = document.createElement("section");
  card.className = "card";
  card.innerHTML = `<h2>🤒 Krankmelden</h2><p class="muted small">Der Chef bekommt sofort Bescheid.</p>`;

  const grid = document.createElement("div");
  grid.className = "kb-grid";
  const mk = (labelText, value) => {
    const w = document.createElement("label");
    w.className = "field";
    w.innerHTML = `<span>${labelText}</span>`;
    const i = document.createElement("input");
    i.type = "date";
    i.value = value;
    w.appendChild(i);
    grid.appendChild(w);
    return i;
  };
  const von = mk("Von", me.heute);
  const bis = mk("Bis", me.heute);

  const notiz = document.createElement("label");
  notiz.className = "field";
  notiz.innerHTML = `<span>Notiz (optional)</span>`;
  const notizInput = document.createElement("input");
  notizInput.type = "text";
  notizInput.maxLength = 300;
  notizInput.placeholder = "z.B. Erkältung, war beim Arzt";
  notiz.appendChild(notizInput);

  const status = document.createElement("p");
  status.className = "muted small";
  const btn = document.createElement("button");
  btn.className = "btn btn-secondary";
  btn.textContent = "Krankmeldung senden";
  btn.onclick = async () => {
    btn.disabled = true;
    status.className = "muted small";
    status.textContent = "Wird gesendet…";
    try {
      await reportSick(von.value, bis.value, notizInput.value.trim());
      status.className = "callout";
      status.textContent = "✅ Krankmeldung gesendet. Gute Besserung!";
      notizInput.value = "";
    } catch (e) {
      status.className = "callout callout-warn";
      status.textContent = "⚠ " + e.message;
    }
    btn.disabled = false;
  };
  card.append(grid, notiz, btn, status);
  return card;
}

function buildNumbers() {
  const card = document.createElement("section");
  card.className = "card";
  card.innerHTML = `<h2>⏱ Deine Stunden</h2>`;
  if (!me.kennzahlenFreigegeben) {
    const p = document.createElement("p");
    p.className = "muted small";
    p.textContent = "Deine Stunden sind hier noch nicht sichtbar. Der Chef muss das im Café einmal freigeben.";
    card.appendChild(p);
    return card;
  }
  const line = (l, v) => `<div class="summary-line"><span>${l}</span><span>${v}</span></div>`;
  card.innerHTML += `
    <p class="muted small">Diese Woche</p>
    ${line("Stunden", hours(me.dieseWoche.stunden))}
    ${line("Lohn", euro(me.dieseWoche.lohn))}
    ${line("Trinkgeld", euro(me.dieseWoche.trinkgeld))}
    <p class="muted small" style="margin-top:14px">Dieser Monat</p>
    ${line("Stunden", hours(me.dieserMonat.stunden))}
    ${line("Lohn", euro(me.dieserMonat.lohn))}
    ${line("Trinkgeld", euro(me.dieserMonat.trinkgeld))}
  `;

  const letzte = (me.tage || []).slice(-10).reverse();
  if (letzte.length > 0) {
    const details = document.createElement("details");
    details.className = "history";
    details.style.marginTop = "12px";
    details.innerHTML =
      `<summary>Letzte Tage im Einzelnen</summary>` +
      letzte
        .map((t) => `<div class="summary-line"><span>${escapeHtml(dateDe(t.date))}</span><span>${hours(t.stunden)} · ${euro(t.lohn)}</span></div>`)
        .join("");
    card.appendChild(details);
  }
  return card;
}

// ---------------------------------------------------------------------
async function load() {
  const loading = document.createElement("div");
  loading.className = "page";
  loading.innerHTML = `<p class="muted">Lade…</p>`;
  show(loading);
  try {
    me = await getMe();
    renderMain();
  } catch (e) {
    if (!getSession()) renderLogin(e.message);
    else {
      const err = document.createElement("div");
      err.className = "page";
      err.innerHTML = `<div class="callout callout-warn">⚠ ${escapeHtml(e.message)}</div>`;
      const retry = document.createElement("button");
      retry.className = "btn btn-secondary";
      retry.textContent = "Nochmal versuchen";
      retry.onclick = () => load();
      err.appendChild(retry);
      show(err);
    }
  }
}

if (getSession()) load();
else renderLogin();
