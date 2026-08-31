// ============================================================================
// taskSync.js – Gleicht Aufgaben mit dem Cloudflare Worker (worker/telegram-bot.js)
// ab, der sie in einem KV-Speicher hält. Der Worker ist immer erreichbar (nicht
// vom iPad abhängig) – so kann der Telegram-Bot jederzeit die aktuelle Liste
// zeigen/ändern (auch "erledigt" markieren), auch wenn das iPad gerade aus ist.
// Das iPad übernimmt bei jedem Sync neue/entfernte/erledigte Cloud-Aufgaben und
// lädt danach seinen eigenen (jetzt abgeglichenen) Stand wieder hoch, inkl. wer
// gerade im Dienst ist – so bleiben beide Seiten in Sync.
// ============================================================================
import { store } from "./store.js";
import { todayStr } from "./format.js";
import { computeDay } from "./calc.js";

const FINANCIALS_DAYS = 180; // ca. 6 Monate zurück, damit der Bot auch längerfristige Fragen/Vergleiche beantworten kann

function workerUrl(cfg, path) {
  return `${cfg.workerUrl.replace(/\/+$/, "")}${path}`;
}

function isoDaysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

/** Muss Zeichen für Zeichen identisch zu hashPin() in worker/telegram-bot.js sein, sonst schlägt jeder
 * Handy-/Laptop-Login fehl. Der Zugriffsschlüssel dient als "Pfeffer", damit in der Cloud keine blanken
 * PIN-Hashes liegen – der PIN selbst verlässt das iPad nie im Klartext. */
async function hashPin(secret, pin) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${secret}:${pin}`));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** PIN-Hashes aller aktiven Mitarbeiter + des Admin-PINs für den Login am Handy/Laptop. */
async function buildAuthPinsPayload(cfg, employees) {
  const authPins = [];
  for (const e of employees) {
    if (!e.pin) continue;
    authPins.push({ name: e.name, pinHash: await hashPin(cfg.workerSecret, String(e.pin)) });
  }
  const adminPin = store.getSettings().adminPin;
  const adminPinHash = adminPin ? await hashPin(cfg.workerSecret, String(adminPin)) : null;
  return { authPins, adminPinHash };
}

function mondayOf(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const day = dt.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day;
  dt.setUTCDate(dt.getUTCDate() + diff);
  return dt.toISOString().slice(0, 10);
}
function addDaysISO(dateStr, n) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}
/** Montag der Woche NACH der aktuellen – dieselbe Zielwoche, die Kiosk und Bot überall verwenden. */
function nextMondayFrom(dateStr) {
  return addDaysISO(mondayOf(dateStr), 7);
}

/** Nachsichtiger Vergleich für Schicht-Namen ("Früh1" vs "früh 1" vs "FRUEH1" ohne Umlaut-Taste), damit eine
 * per Bot-Chat eingetippte Schicht trotz kleiner Tippabweichungen zum richtigen Slot passt. Muss exakt so
 * auch im Worker (worker/telegram-bot.js: normalizeSlotLabelCheck) stehen, sonst laufen beide auseinander. */
function normalizeSlotLabel(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .replace(/[^a-z0-9]/g, "");
}

/** Kompakte Tages-Kennzahlen der letzten Wochen (nur wenn der Nutzer das freigegeben hat). */
function buildFinancialsPayload() {
  const settings = store.getSettings();
  const employees = store.getEmployees();
  const from = isoDaysAgo(FINANCIALS_DAYS);
  const rows = [];
  for (const day of store.getDays()) {
    if (day.date < from) continue;
    const b = computeDay(day, employees, settings);
    rows.push({
      date: day.date,
      status: day.status,
      umsatzGesamt: Number(day.kassenabschluss?.umsatzGesamt) || 0,
      umsatzBar: Number(day.kassenabschluss?.umsatzBar) || 0,
      trinkgeldGesamt: b.tipPool,
      totalLohn: b.totalLohn,
      totalLohnnebenkosten: b.totalLohnnebenkosten,
      totalHours: b.totalHours,
      umschlag: b.umschlag,
      materialkosten: b.materialkosten,
      // tip wird für die eigene Ansicht der Mitarbeiter am Handy gebraucht (GET /me liefert nur die
      // jeweils eigene Zeile zurück, nie die der Kollegen).
      // hours ist bereits die NETTO-Zeit (gesetzliche Pause abgezogen). breakMinutes kommt mit, damit im
      // Stunden-Export fürs Steuerbüro nachvollziehbar ist, wie viel Pause abgezogen wurde.
      perEmployee: b.perEmployee.map((r) => ({
        name: r.employee.name,
        hours: r.hours,
        breakMinutes: r.breakMinutes,
        lohn: r.lohn,
        lohnnebenkosten: r.lohnnebenkosten,
        tip: r.tip,
      })),
    });
  }
  rows.sort((a, b) => (a.date < b.date ? -1 : 1));
  return rows;
}

/** Aktueller Verfügbarkeits-Stand der Zielwoche (nächste Woche) für den Bot. Wichtig, damit "wer kann wann"
 * auch nach einer Chef-Zuweisung/-Ablehnung per Bot aktuell bleibt – die wird nur LOKAL übernommen
 * (confirmAvailability/rejectAvailability), landet sonst nirgends automatisch wieder in der Cloud. Nur
 * Personen mit tatsächlich abgeschickter Verfügbarkeit werden mitgeschickt. */
function buildAvailabilityUpdatePayload() {
  const weekStart = nextMondayFrom(todayStr());
  const employees = store.getEmployees(false);
  const entries = {};
  for (const emp of employees) {
    const days = [];
    let submittedAt = null;
    for (let i = 0; i < 7; i++) {
      const date = addDaysISO(weekStart, i);
      const day = store.getDayByDate(date);
      const entry = day ? store.getAvailability(day.id, emp.id) : null;
      if (!entry || !entry.submittedAt || entry.slotIds.length === 0) continue;
      submittedAt = entry.submittedAt;
      // Pro Tag nachschlagen, damit Schichten mit abweichender Zeit (z.B. Service 1 Mo/Di bis 17:00)
      // die richtigen Zeiten mitbekommen.
      const slotById = new Map(store.getShiftSlotsForRole(emp.role, date).map((s) => [s.id, s]));
      const slots = entry.slotIds.map((id) => slotById.get(id)).filter(Boolean).map((s) => ({ id: s.id, label: s.label, from: s.from, to: s.to }));
      if (slots.length > 0) days.push({ date, slots, confirmedSlotId: entry.confirmedSlotId || null, bossConfirmed: !!entry.bossConfirmed });
    }
    if (submittedAt) entries[emp.name] = { submittedAt, days };
  }
  return { weekStart, entries };
}

/** Belegte Zeitfenster für die Kapazitätsprüfung der Online-Buchung – ab heute und nur so weit in die
 * Zukunft, wie online überhaupt gebucht werden kann. Ohne Namen, ohne Telefonnummern, ohne Notizen. */
function buildReservationSlotsPayload() {
  const heute = todayStr();
  const tage = Number(store.getSettings().reservation?.maxDaysAhead) || 60;
  const bis = addDaysISO(heute, tage);
  return store
    .getReservations?.()
    ?.filter((r) => r.date >= heute && r.date <= bis && !["storniert", "noshow", "weg"].includes(r.status))
    ?.map((r) => ({ date: r.date, time: r.time, guests: r.guests, tableIds: r.tableIds || [] })) || [];
}

async function fetchRemoteState(cfg) {
  const res = await fetch(workerUrl(cfg, "/state"), {
    headers: { Authorization: `Bearer ${cfg.workerSecret}` },
  });
  if (!res.ok) throw new Error(`Worker antwortete mit ${res.status} (URL/Zugriffsschlüssel prüfen)`);
  return res.json();
}

async function pushLocalState(cfg, payload) {
  const res = await fetch(workerUrl(cfg, "/state"), {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.workerSecret}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Worker antwortete mit ${res.status} beim Hochladen`);
}

/** Sendet eine kurze Notiz eines Mitarbeiters an den Chef (Telegram). Wirft bei echten Fehlern. */
async function sendNoteToBoss(employeeName, text) {
  const cfg = store.getTaskInboxConfig();
  if (!cfg.workerUrl || !cfg.workerSecret) {
    throw new Error("Telegram-Aufgaben-Abgleich ist nicht eingerichtet (siehe Admin → Einstellungen).");
  }
  const res = await fetch(workerUrl(cfg, "/note"), {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.workerSecret}`, "Content-Type": "application/json" },
    body: JSON.stringify({ employeeName, text }),
  });
  if (!res.ok) throw new Error(`Worker antwortete mit ${res.status}`);
}

/** Sendet die Verfügbarkeit eines Mitarbeiters für eine Zielwoche (Montag-Datum) an den Bot.
 * Der Worker sammelt das im Hintergrund und meldet sich beim Chef erst, wenn alle aktiven
 * Mitarbeiter eingetragen haben (kein Spam pro einzelner Person). Wirft bei echten Fehlern. */
async function pushAvailability(employeeName, weekStart, days) {
  const cfg = store.getTaskInboxConfig();
  if (!cfg.workerUrl || !cfg.workerSecret) {
    throw new Error("Telegram-Aufgaben-Abgleich ist nicht eingerichtet (siehe Admin → Einstellungen).");
  }
  const res = await fetch(workerUrl(cfg, "/availability"), {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.workerSecret}`, "Content-Type": "application/json" },
    body: JSON.stringify({ employeeName, weekStart, days }),
  });
  if (!res.ok) throw new Error(`Worker antwortete mit ${res.status}`);
}

/** Meldet dem Bot sofort (nicht erst beim nächsten 90s-Sync), wenn sich jemand ein-/ausstempelt. Best-effort:
 * wirft absichtlich nicht, ein Netzwerkproblem hier soll das eigentliche Ein-/Ausstempeln nicht stören. */
async function sendClockEvent(type, employeeName, time) {
  const cfg = store.getTaskInboxConfig();
  if (!cfg.enabled || !cfg.workerUrl || !cfg.workerSecret) return;
  try {
    await fetch(workerUrl(cfg, "/event"), {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.workerSecret}`, "Content-Type": "application/json" },
      body: JSON.stringify({ type, employeeName, time }),
    });
  } catch {
    // still best effort
  }
}

/** Schickt eine vollständige Kassenabschluss-Zusammenfassung an den Bot, sobald ein Tag abgeschlossen wird –
 * nur wenn Kennzahlen freigegeben sind (genauso sensibel wie die übrigen Kennzahlen). Best-effort. */
async function sendDayClosedReport(day, breakdown) {
  const cfg = store.getTaskInboxConfig();
  if (!cfg.enabled || !cfg.workerUrl || !cfg.workerSecret || !cfg.shareFinancials) return;
  try {
    await fetch(workerUrl(cfg, "/event"), {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.workerSecret}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "day_closed",
        date: day.date,
        umsatzGesamt: Number(day.kassenabschluss?.umsatzGesamt) || 0,
        umsatzBar: Number(day.kassenabschluss?.umsatzBar) || 0,
        trinkgeldGesamt: breakdown.tipPool,
        totalLohn: breakdown.totalLohn,
        totalLohnnebenkosten: breakdown.totalLohnnebenkosten,
        totalHours: breakdown.totalHours,
        umschlag: breakdown.umschlag,
        perEmployee: breakdown.perEmployee.map((r) => ({ name: r.employee.name, hours: r.hours, lohn: r.lohn, tip: r.tip })),
      }),
    });
  } catch {
    // still best effort
  }
}

/** Führt den Abgleich jetzt durch (z.B. für den "Jetzt abgleichen"-Button). Wirft bei echten Fehlern. */
async function performTaskSync() {
  const cfg = store.getTaskInboxConfig();
  if (!cfg.workerUrl || !cfg.workerSecret) {
    throw new Error("Bitte zuerst Worker-URL und Zugriffsschlüssel eintragen.");
  }

  const remote = await fetchRemoteState(cfg);
  const remoteTasks = Array.isArray(remote.tasks) ? remote.tasks : [];
  const remoteById = new Map(remoteTasks.map((t) => [t.id, t]));
  const knownState = new Map((cfg.knownRemoteState || []).map((k) => [k.id, k.done]));

  const localRows = store.getTasksFrom(todayStr());
  const localIds = new Set(localRows.map((r) => r.id));
  const employees = store.getEmployees(false);

  let applied = 0;
  const syncWarnings = []; // Zuweisungen/Nachrichten/Ablehnungen, die NICHT übernommen werden konnten (sichtbar in lastError)

  // Vom Bot per Wochenplan-Nachricht angelegte geplante Schichten -> lokal übernehmen.
  // Zwei Formen: freie Uhrzeit (from/to, per rs.id dedupliziert wie bisher) ODER Zuweisung anhand des
  // Schicht-Namens (slotLabel, z.B. "Früh1" – der Chef sagt dem Bot "Anna bekommt Montag Früh1"). Letztere
  // läuft über confirmAvailability(), damit Kaskade/Ausgrauen für andere korrekt greifen; dafür braucht es
  // eine eigene Dedup-Liste (appliedShiftAssignmentIds), weil dabei keine Schicht mit exakt rs.id entsteht.
  const remotePlanned = Array.isArray(remote.plannedShifts) ? remote.plannedShifts : [];
  const appliedAssignmentIds = new Set(cfg.appliedShiftAssignmentIds || []);
  let newAssignmentIds = false;
  for (const rs of remotePlanned) {
    if (!rs.id) continue;
    if (rs.slotLabel) {
      if (appliedAssignmentIds.has(rs.id)) continue;
      const match = employees.find((e) => e.name.trim().toLowerCase() === String(rs.employeeName || "").trim().toLowerCase());
      if (!match) {
        syncWarnings.push(`Schicht-Zuweisung "${rs.employeeName}" ${rs.date || ""}: Mitarbeiter nicht gefunden (Name prüfen).`);
      } else if (!rs.date) {
        syncWarnings.push(`Schicht-Zuweisung für ${rs.employeeName}: kein gültiges Datum erkannt.`);
      } else {
        const slot = store.getShiftSlotsForRole(match.role, rs.date).find((s) => normalizeSlotLabel(s.label) === normalizeSlotLabel(rs.slotLabel));
        if (!slot) {
          syncWarnings.push(`Schicht-Zuweisung für ${rs.employeeName} am ${rs.date}: Schicht "${rs.slotLabel}" nicht erkannt (erwartet z.B. Früh1/Mittel/Spät2).`);
        } else {
          const day = store.getOrCreateDayByDate(rs.date);
          // note kommt vom Laptop mit ("Info zur Schicht") und landet bei der Person unter "Deine Schichten".
          store.confirmAvailability(day.id, match.id, slot.id, rs.note);
        }
      }
      appliedAssignmentIds.add(rs.id);
      newAssignmentIds = true;
    } else {
      if (store.hasPlannedShiftId(rs.id)) continue;
      const match = employees.find((e) => e.name.trim().toLowerCase() === String(rs.employeeName || "").trim().toLowerCase());
      if (!match || !rs.date || !rs.from || !rs.to) {
        syncWarnings.push(`Wochenplan-Eintrag "${rs.employeeName}" ${rs.date || ""}: unvollständig oder Mitarbeiter nicht gefunden.`);
        continue;
      }
      const day = store.getOrCreateDayByDate(rs.date);
      store.addPlannedShift(day.id, { id: rs.id, employeeId: match.id, from: rs.from, to: rs.to });
    }
  }
  if (newAssignmentIds) {
    store.updateTaskInboxConfig({ appliedShiftAssignmentIds: [...appliedAssignmentIds].slice(-300) });
  }

  // Freie Nachrichten vom Chef ("notify" per Bot) -> als System-Benachrichtigung anlegen, die im Kiosk
  // beim nächsten Öffnen des persönlichen Fensters als Pop-up erscheint. Eigene Dedup-Liste, damit ein
  // erneuter Sync dieselbe Nachricht nicht nochmal zustellt.
  const remoteMessages = Array.isArray(remote.employeeMessages) ? remote.employeeMessages : [];
  const appliedMessageIds = new Set(cfg.appliedMessageIds || []);
  let newMessageIds = false;
  for (const m of remoteMessages) {
    if (!m.id || appliedMessageIds.has(m.id)) continue;
    const match = employees.find((e) => e.name.trim().toLowerCase() === String(m.employeeName || "").trim().toLowerCase());
    if (match && m.text) {
      store.addNotification(match.id, `💬 ${m.text}`);
    } else {
      syncWarnings.push(`Nachricht an "${m.employeeName}": Mitarbeiter nicht gefunden (Name prüfen).`);
    }
    appliedMessageIds.add(m.id);
    newMessageIds = true;
  }
  if (newMessageIds) {
    store.updateTaskInboxConfig({ appliedMessageIds: [...appliedMessageIds].slice(-300) });
  }

  // Vom Chef per Bot abgelehnte Schichten ("reject_shift") -> Slot bei der Person entfernen (fällt für
  // andere wieder frei) und sie per Pop-up informieren. Eigene Dedup-Liste wie bei den Zuweisungen.
  const remoteRejections = Array.isArray(remote.shiftRejections) ? remote.shiftRejections : [];
  const appliedRejectionIds = new Set(cfg.appliedRejectionIds || []);
  let newRejectionIds = false;
  for (const r of remoteRejections) {
    if (!r.id || appliedRejectionIds.has(r.id)) continue;
    const match = employees.find((e) => e.name.trim().toLowerCase() === String(r.employeeName || "").trim().toLowerCase());
    if (!match) {
      syncWarnings.push(`Ablehnung "${r.employeeName}" ${r.date || ""}: Mitarbeiter nicht gefunden (Name prüfen).`);
    } else if (!r.date) {
      syncWarnings.push(`Ablehnung für ${r.employeeName}: kein gültiges Datum erkannt.`);
    } else {
      const slot = store.getShiftSlotsForRole(match.role).find((s) => normalizeSlotLabel(s.label) === normalizeSlotLabel(r.slotLabel));
      if (!slot) {
        syncWarnings.push(`Ablehnung für ${r.employeeName} am ${r.date}: Schicht "${r.slotLabel}" nicht erkannt.`);
      } else {
        const day = store.getOrCreateDayByDate(r.date);
        store.rejectAvailability(day.id, match.id, slot.id);
      }
    }
    appliedRejectionIds.add(r.id);
    newRejectionIds = true;
  }
  if (newRejectionIds) {
    store.updateTaskInboxConfig({ appliedRejectionIds: [...appliedRejectionIds].slice(-300) });
  }

  // Chef meldet per Bot "X ist wieder da" -> Artikel-Status zurück auf "ok". Nachsichtiger Namens-Vergleich
  // (exakt, sonst Teilstring), da Artikel frei benannt sind (kein festes Enum wie bei Schichten). Kennt die
  // Vorräte-Liste den Artikel noch gar nicht, wird er automatisch neu angelegt (reine Ampel, Status "ok") -
  // spart das manuelle Vorab-Anlegen in Admin -> Vorräte.
  const remoteRestocks = Array.isArray(remote.stockRestocks) ? remote.stockRestocks : [];
  const appliedRestockIds = new Set(cfg.appliedRestockIds || []);
  let newRestockIds = false;
  let stockItems = store.getStockItems();
  for (const rs of remoteRestocks) {
    if (!rs.id || appliedRestockIds.has(rs.id)) continue;
    const needle = String(rs.itemName || "").trim().toLowerCase();
    let match =
      stockItems.find((s) => s.name.trim().toLowerCase() === needle) ||
      stockItems.find((s) => needle && s.name.trim().toLowerCase().includes(needle));
    if (!match && rs.itemName) {
      match = store.addStockItem(rs.itemName);
      if (match) {
        stockItems = [...stockItems, match];
        syncWarnings.push(`Neuer Artikel "${rs.itemName}" automatisch angelegt (per Bot-Nachricht "ist wieder da").`);
      }
    }
    if (match) store.setStockStatus(match.id, "ok", "Chef");
    else syncWarnings.push(`"${rs.itemName}" ist wieder da: kein passender Vorrats-Artikel gefunden.`);
    appliedRestockIds.add(rs.id);
    newRestockIds = true;
  }
  if (newRestockIds) {
    store.updateTaskInboxConfig({ appliedRestockIds: [...appliedRestockIds].slice(-300) });
  }

  // Vom Bot per Lieferschein-Foto/PDF erkannte Lieferungen -> als Verlauf beim jeweiligen Artikel anlegen
  // (setzt den Status automatisch auf "ok"). Gleicher nachsichtiger Namens-Vergleich wie bei "restock". Kennt
  // die Vorräte-Liste den Artikel noch nicht, wird er automatisch neu angelegt (mit der auf dem Beleg
  // erkannten Einheit, Start-Bestand 0 - die Menge kommt gleich im nächsten Schritt über addStockDelivery
  // dazu) statt die Lieferung nur als Warnung zu verwerfen. Warnschwelle testweise auf 20% der ersten
  // gelieferten Menge, bei Bedarf unter Admin -> Vorräte anpassen.
  const remoteDeliveries = Array.isArray(remote.stockDeliveries) ? remote.stockDeliveries : [];
  const appliedDeliveryIds = new Set(cfg.appliedDeliveryIds || []);
  let newDeliveryIds = false;
  let stockForDelivery = store.getStockItems(); // frisch (evtl. schon durch die restock-Schleife verändert)
  for (const d of remoteDeliveries) {
    if (!d.id || appliedDeliveryIds.has(d.id)) continue;
    const needle = String(d.itemName || "").trim().toLowerCase();
    let match =
      stockForDelivery.find((s) => s.name.trim().toLowerCase() === needle) ||
      stockForDelivery.find((s) => needle && s.name.trim().toLowerCase().includes(needle));
    if (!match && d.itemName) {
      const qty = Number(d.quantity);
      match = store.addStockItem(d.itemName, {
        unit: d.unit || "",
        currentAmount: 0,
        lowThreshold: Number.isFinite(qty) ? Math.round(qty * 0.2 * 10) / 10 : 0,
      });
      if (match) {
        stockForDelivery = [...stockForDelivery, match];
        syncWarnings.push(`Neuer Artikel "${d.itemName}" automatisch angelegt (Warnschwelle testweise geschätzt, bei Bedarf unter Admin → Vorräte anpassen).`);
      }
    }
    if (match) {
      const lieferung = store.addStockDelivery(match.id, { date: d.date, quantity: d.quantity, unit: d.unit });
      // Liess sich die Menge nicht auf die Einheit des Artikels bringen, MUSS das auffallen – sonst
      // steht die Lieferung im Verlauf, der Bestand bleibt aber stehen und niemand weiss warum.
      if (lieferung && lieferung.uebernommen === null && Number.isFinite(lieferung.verlangt)) {
        syncWarnings.push(
          `Lieferung "${d.itemName}": ${lieferung.verlangt} ${lieferung.einheit || "?"} passt nicht zur Einheit des Artikels ` +
            `(${match.unit || "keine"}). Bestand nicht verändert – bitte Einheit oder Gebindegröße im Artikel prüfen.`
        );
      }
      // Einkaufspreis vom Beleg übernehmen – Grundlage für den Wareneinsatz. Ein von Hand gesetzter
      // Preis bleibt dabei unangetastet (siehe setPriceFromDocument).
      if (d.unitPrice) store.setPriceFromDocument(match.id, d.unitPrice);
    }
    else syncWarnings.push(`Lieferung "${d.itemName}": kein passender Vorrats-Artikel gefunden.`);
    appliedDeliveryIds.add(d.id);
    newDeliveryIds = true;
  }
  if (newDeliveryIds) {
    store.updateTaskInboxConfig({ appliedDeliveryIds: [...appliedDeliveryIds].slice(-300) });
  }

  // Vom Bot per SumUp-Verkaufsbericht-Foto erkannte Verkäufe -> gegen die Rezept-Zutaten verrechnen
  // (zieht die jeweilige Menge automatisch vom Bestand der Zutat-Artikel ab, neue Ampel inklusive).
  const remoteSales = Array.isArray(remote.stockSales) ? remote.stockSales : [];
  const appliedSaleIds = new Set(cfg.appliedSaleIds || []);
  let newSaleIds = false;
  for (const s of remoteSales) {
    if (!s.id || appliedSaleIds.has(s.id)) continue;
    // Immer festhalten, was verkauft wurde – unabhängig davon, ob sich der Bestand verrechnen lässt.
    // Sonst fehlten genau die Produkte in der Auswertung, für die noch kein Rezept hinterlegt ist.
    store.addProductSale({ date: s.date, productName: s.productName, quantity: s.quantitySold, salePrice: s.salePrice });
    const recipe = store.getRecipeByProductName(s.productName);
    if (recipe) {
      store.applyProductSale(recipe.id, s.quantitySold, s.date);
    } else {
      const artikel = store.getStockItemByName(s.productName);
      if (artikel && artikel.unit) {
        // Wird genau so eingekauft, wie es verkauft wird: 1 verkauft = 1 Stück weniger.
        store.applyDirectSale(artikel.id, s.quantitySold, s.date, s.productName);
      } else if (artikel) {
        // Artikel ohne Mengenführung (nur Ampel) – da gibt es nichts abzuziehen.
        syncWarnings.push(`Verkauf "${s.productName}": Artikel wird ohne Menge geführt, nichts abgezogen.`);
      } else if (s.kind === "artikel") {
        // Unbekannt und laut Beleg-Erkennung ein eingekauftes Produkt: als Artikel mit Stück-Führung
        // anlegen und den Verkauf sofort abziehen. Der Bestand startet bei 0 und wird dadurch negativ –
        // das ist gewollt und sichtbar: es zeigt genau, wie viel seit dem Anlegen rausgegangen ist.
        const neu = store.addStockItem(s.productName, { unit: "Stück", currentAmount: 0, lowThreshold: 0, needsReview: true });
        if (neu) {
          store.applyDirectSale(neu.id, s.quantitySold, s.date, s.productName);
          syncWarnings.push(`Neuer Artikel "${s.productName}" aus dem Verkaufsbericht angelegt – bitte am Laptop unter Bestand prüfen.`);
        }
      } else {
        // Alles andere wird als Rezept angelegt, absichtlich OHNE Zutaten. Ein leeres Rezept zieht nichts
        // ab – lieber vorerst nichts verrechnen, als von einem falschen Artikel abzubuchen. Sobald der Chef
        // die Zutaten einträgt, greift die Verrechnung ab dem nächsten Bericht.
        const neu = store.addRecipe(s.productName, [], { needsReview: true });
        if (neu) {
          syncWarnings.push(`Neues Rezept "${s.productName}" angelegt – bitte am Laptop unter Bestand die Zutaten eintragen.`);
        }
      }
    }
    appliedSaleIds.add(s.id);
    newSaleIds = true;
  }
  if (newSaleIds) {
    store.updateTaskInboxConfig({ appliedSaleIds: [...appliedSaleIds].slice(-300) });
  }

  // Artikel- und Rezept-Änderungen aus der Laptop-Ansicht übernehmen. Der iPad hält die maßgebliche
  // Vorräte-/Rezept-Liste, der Laptop reicht nur Änderungswünsche ein (gleiches Muster wie überall).
  const remoteStockChanges = Array.isArray(remote.stockChanges) ? remote.stockChanges : [];
  const appliedStockChangeIds = new Set(cfg.appliedStockChangeIds || []);
  let newStockChangeIds = false;
  for (const c of remoteStockChanges) {
    if (!c.id || appliedStockChangeIds.has(c.id)) continue;
    if (c.kind === "create") {
      store.addStockItem(c.name, { unit: c.unit || "", currentAmount: c.currentAmount ?? 0, lowThreshold: c.lowThreshold ?? 0,
        bereich: c.bereich, packSize: c.packSize, packLabel: c.packLabel, pricePerUnit: c.pricePerUnit });
    } else if (c.kind === "update") {
      if (!store.updateStockItem(c.itemId, { name: c.name, unit: c.unit, lowThreshold: c.lowThreshold,
        bereich: c.bereich, packSize: c.packSize, packLabel: c.packLabel, pricePerUnit: c.pricePerUnit })) {
        syncWarnings.push(`Artikel-Änderung: Artikel nicht gefunden (evtl. schon gelöscht).`);
      }
      // Bearbeiten IST das Prüfen: der Hinweis "bitte einordnen" kann danach weg.
      store.markStockItemReviewed(c.itemId);
    } else if (c.kind === "delete") {
      store.removeStockItem(c.itemId);
    } else if (c.kind === "setAmount") {
      store.setStockAmount(c.itemId, c.currentAmount, "Chef (Laptop)");
    } else if (c.kind === "reviewed") {
      store.markStockItemReviewed(c.itemId);
    } else if (c.kind === "merge") {
      const zusammen = store.mergeStockItem(c.itemId, c.targetId);
      if (!zusammen) {
        syncWarnings.push(`Zusammenführen von Artikeln: einer der beiden ist nicht mehr da.`);
      } else if (!zusammen.mengeUebernommen && zusammen.alteMenge !== 0) {
        syncWarnings.push(
          `"${zusammen.artikel.name}": der Name wurde übernommen, der Bestand von ${zusammen.alteMenge} ` +
            `${zusammen.alteEinheit || "?"} aber nicht – das passt nicht zur Einheit ${zusammen.artikel.unit || "keine"}. ` +
            `Bitte den Bestand einmal von Hand setzen.`
        );
      }
    } else if (c.kind === "alias") {
      store.addNameAlias("artikel", c.itemId, c.alias);
    }
    appliedStockChangeIds.add(c.id);
    newStockChangeIds = true;
  }
  if (newStockChangeIds) {
    store.updateTaskInboxConfig({ appliedStockChangeIds: [...appliedStockChangeIds].slice(-300) });
  }

  const remoteRecipeChanges = Array.isArray(remote.recipeChanges) ? remote.recipeChanges : [];
  const appliedRecipeChangeIds = new Set(cfg.appliedRecipeChangeIds || []);
  let newRecipeChangeIds = false;
  for (const c of remoteRecipeChanges) {
    if (!c.id || appliedRecipeChangeIds.has(c.id)) continue;
    if (c.kind === "create") store.addRecipe(c.productName, c.ingredients || [], { yieldAmount: c.yieldAmount, yieldUnit: c.yieldUnit });
    else if (c.kind === "update") {
      store.updateRecipe(c.recipeId, { productName: c.productName, ingredients: c.ingredients || [],
        yieldAmount: c.yieldAmount, yieldUnit: c.yieldUnit });
      store.markRecipeReviewed(c.recipeId); // Zutaten eingetragen = eingeordnet
    } else if (c.kind === "delete") store.removeRecipe(c.recipeId);
    else if (c.kind === "reviewed") store.markRecipeReviewed(c.recipeId);
    else if (c.kind === "merge") {
      if (!store.mergeRecipe(c.recipeId, c.targetId)) {
        syncWarnings.push(`Zusammenführen von Rezepten: eines der beiden ist nicht mehr da.`);
      }
    } else if (c.kind === "alias") store.addNameAlias("rezept", c.recipeId, c.alias);
    appliedRecipeChangeIds.add(c.id);
    newRecipeChangeIds = true;
  }
  if (newRecipeChangeIds) {
    store.updateTaskInboxConfig({ appliedRecipeChangeIds: [...appliedRecipeChangeIds].slice(-300) });
  }

  // Mitarbeiter-Änderungen aus der Laptop-Ansicht übernehmen. Der PIN wird dabei nie angefasst – der bleibt
  // ausschließlich am iPad und geht nie über das Netz.
  const remoteEmployeeChanges = Array.isArray(remote.employeeChanges) ? remote.employeeChanges : [];
  const appliedEmployeeChangeIds = new Set(cfg.appliedEmployeeChangeIds || []);
  let newEmployeeChangeIds = false;
  for (const c of remoteEmployeeChanges) {
    if (!c.id || appliedEmployeeChangeIds.has(c.id)) continue;
    const daten = { name: c.name, role: c.role, hourlyWage: c.hourlyWage, isMinijob: !!c.isMinijob, minijobLimit: c.minijobLimit };
    if (c.kind === "create") {
      store.addEmployee({ ...daten, pin: null }); // PIN vergibt der Chef am iPad
    } else if (c.kind === "update") {
      if (store.getEmployee(c.employeeId)) store.updateEmployee(c.employeeId, daten);
      else syncWarnings.push(`Mitarbeiter-Änderung: Person nicht gefunden (evtl. schon gelöscht).`);
    } else if (c.kind === "deactivate") {
      store.updateEmployee(c.employeeId, { active: false });
    } else if (c.kind === "activate") {
      store.updateEmployee(c.employeeId, { active: true });
    }
    appliedEmployeeChangeIds.add(c.id);
    newEmployeeChangeIds = true;
  }
  if (newEmployeeChangeIds) {
    store.updateTaskInboxConfig({ appliedEmployeeChangeIds: [...appliedEmployeeChangeIds].slice(-300) });
  }

  // Krankmeldungen vom Handy -> als Krank-Tage übernehmen. Ein Eintrag kann mehrere Tage umfassen
  // (from..to), daraus wird pro Tag ein Krank-Tag. Nachsichtiger Namens-Vergleich wie oben.
  const remoteSick = Array.isArray(remote.sickReports) ? remote.sickReports : [];
  const appliedSickIds = new Set(cfg.appliedSickIds || []);
  let newSickIds = false;
  for (const r of remoteSick) {
    if (!r.id || appliedSickIds.has(r.id)) continue;
    const needle = String(r.employeeName || "").trim().toLowerCase();
    const match = employees.find((e) => e.name.trim().toLowerCase() === needle);
    if (match && /^\d{4}-\d{2}-\d{2}$/.test(r.from)) {
      const to = /^\d{4}-\d{2}-\d{2}$/.test(r.to) && r.to >= r.from ? r.to : r.from;
      // Sicherheitsnetz gegen einen kaputten/absurden Zeitraum: höchstens 60 Tage am Stück.
      for (let d = r.from, guard = 0; d <= to && guard < 60; d = addDaysISO(d, 1), guard++) {
        store.addSickDay(match.id, d, r.note);
      }
    } else {
      syncWarnings.push(`Krankmeldung "${r.employeeName}": Mitarbeiter nicht gefunden oder Datum ungültig.`);
    }
    appliedSickIds.add(r.id);
    newSickIds = true;
  }
  if (newSickIds) {
    store.updateTaskInboxConfig({ appliedSickIds: [...appliedSickIds].slice(-300) });
  }

  // Aus Rezept-PDFs erkannte Rezepturen -> als Rezepte anlegen. Fehlende Zutaten entstehen dabei als
  // Artikel und landen in der Prüfliste am Laptop – falls es sie unter anderem Namen schon gibt, fängt
  // die Zuordnung sie dort ab.
  const remoteRecipeImports = Array.isArray(remote.recipeImports) ? remote.recipeImports : [];
  const appliedRecipeImportIds = new Set(cfg.appliedRecipeImportIds || []);
  let newRecipeImportIds = false;
  for (const r of remoteRecipeImports) {
    if (!r.id || appliedRecipeImportIds.has(r.id)) continue;
    const ergebnis = store.importRecipe({ productName: r.productName, ingredients: r.ingredients });
    if (!ergebnis || !ergebnis.rezept) {
      syncWarnings.push(`Rezept "${r.productName || "?"}" konnte nicht angelegt werden (keine verwertbare Zutat).`);
    } else {
      const teile = [];
      if (ergebnis.ersetzt) teile.push("bestehendes Rezept aktualisiert");
      if (ergebnis.neueArtikel > 0) teile.push(`${ergebnis.neueArtikel} neue Zutat(en) als Artikel angelegt – bitte am Laptop einordnen`);
      for (const w of ergebnis.warnungen) teile.push(w);
      if (teile.length > 0) syncWarnings.push(`Rezept "${r.productName}": ${teile.join(" · ")}`);
    }
    appliedRecipeImportIds.add(r.id);
    newRecipeImportIds = true;
  }
  if (newRecipeImportIds) {
    store.updateTaskInboxConfig({ appliedRecipeImportIds: [...appliedRecipeImportIds].slice(-300) });
  }

  // Online-Reservierungen von der Website -> als echte Reservierung anlegen. Bewusst OHNE Tisch:
  // der Server garantiert nur, dass Platz da war; wer wohin kommt, entscheidet der Chef am iPad.
  const remoteRequests = Array.isArray(remote.reservationRequests) ? remote.reservationRequests : [];
  const appliedReservationIds = new Set(cfg.appliedReservationIds || []);
  let newReservationIds = false;
  for (const q of remoteRequests) {
    if (!q.id || appliedReservationIds.has(q.id)) continue;
    if (/^\d{4}-\d{2}-\d{2}$/.test(q.date) && /^\d{2}:\d{2}$/.test(q.time) && String(q.name || "").trim()) {
      const angelegt = store.addReservation({
        date: q.date,
        time: q.time,
        name: q.name,
        phone: q.phone,
        guests: q.guests,
        area: q.area,
        note: q.note,
        source: "web",
      });
      // Die Nummer, die der Gast auf dem Bildschirm gesehen hat, muss dieselbe bleiben – sonst kann
      // er sie am Telefon nennen und niemand findet die Reservierung.
      if (angelegt && q.code) store.updateReservationCode(angelegt.id, q.code);
    } else {
      syncWarnings.push(`Online-Reservierung "${q.name || "?"}" konnte nicht übernommen werden (unvollständige Angaben).`);
    }
    appliedReservationIds.add(q.id);
    newReservationIds = true;
  }
  if (newReservationIds) {
    store.updateTaskInboxConfig({ appliedReservationIds: [...appliedReservationIds].slice(-500) });
  }

  // Abgeschlossene Schichtpläne: der Chef gibt eine Woche am Laptop frei, das iPad übernimmt das als
  // eigenen Stand. Ohne diesen Schritt würde der nächste Push die Freigabe in der Cloud wieder löschen –
  // die Leute sähen ihren fertigen Plan dann plötzlich nicht mehr.
  const remotePublications = Array.isArray(remote.weekPublications) ? remote.weekPublications : [];
  const appliedPublicationIds = new Set(cfg.appliedPublicationIds || []);
  let newPublicationIds = false;
  for (const p of remotePublications) {
    if (!p.id || appliedPublicationIds.has(p.id)) continue;
    if (/^\d{4}-\d{2}-\d{2}$/.test(p.weekStart)) {
      if (p.action === "unpublish") store.setWeekUnpublished(p.weekStart);
      else store.setWeekPublished(p.weekStart, p.at);
    } else {
      syncWarnings.push(`Schichtplan-Freigabe: ungültige Woche "${p.weekStart}".`);
    }
    appliedPublicationIds.add(p.id);
    newPublicationIds = true;
  }
  if (newPublicationIds) {
    store.updateTaskInboxConfig({ appliedPublicationIds: [...appliedPublicationIds].slice(-300) });
  }

  // Verfügbarkeiten, die Mitarbeiter über ihr HANDY eingetragen haben -> lokal übernehmen.
  // Ohne diesen Schritt landen sie zwar in der Cloud (der Chef sieht sie am Laptop), das iPad erfährt aber
  // nie davon: die Person sähe ihre eigene Eingabe im Kiosk nicht und die Ausgrau-/Kaskaden-Logik liefe nie.
  // Übernommen wird über commitAvailability(), damit exakt dieselben Regeln greifen wie bei einer Eingabe am
  // iPad (bereits vergebene Schichten werden dabei herausgefiltert).
  // Jede Einreichung wird über eine Merkliste genau einmal angewendet (gleiches Muster wie bei Lieferungen
  // und Krankmeldungen). Bewusst NICHT über einen Zeitstempel-Vergleich: der hinge daran, dass die Uhren von
  // iPad und Server zusammenpassen – läuft das iPad nach, würde dieselbe Einreichung bei jedem Abgleich
  // erneut angewendet, die Kaskade jedes Mal neu ausgelöst und Entscheidungen des Chefs überschrieben.
  const remoteAvailability = remote.availability && typeof remote.availability === "object" ? remote.availability : {};
  const appliedAvailabilityKeys = new Set(cfg.appliedAvailabilityKeys || []);
  let newAvailabilityKeys = false;
  for (const [weekStart, bucket] of Object.entries(remoteAvailability)) {
    for (const [name, entry] of Object.entries(bucket?.entries || {})) {
      if (!entry?.submittedAt || !Array.isArray(entry.days)) continue;
      const key = `${weekStart}|${name}|${entry.submittedAt}`; // pro Einreichung eindeutig und stabil
      if (appliedAvailabilityKeys.has(key)) continue;
      const match = employees.find((e) => e.name.trim().toLowerCase() === name.trim().toLowerCase());
      if (!match) {
        syncWarnings.push(`Verfügbarkeit von "${name}" (Woche ab ${weekStart}): Mitarbeiter nicht gefunden.`);
      } else {
        for (const day of entry.days) {
          if (!/^\d{4}-\d{2}-\d{2}$/.test(day?.date)) continue;
          const slotIds = (day.slots || []).map((s) => s.id).filter(Boolean);
          if (slotIds.length === 0) continue;
          const d = store.getOrCreateDayByDate(day.date);
          // Den Zeitstempel der Einreichung MITGEBEN: nur so bleibt der Merk-Schlüssel stabil und
          // dieselbe Einreichung wird nicht bei jedem Abgleich erneut angewendet.
          store.commitAvailability(d.id, match.id, slotIds, entry.submittedAt);
        }
      }
      appliedAvailabilityKeys.add(key);
      newAvailabilityKeys = true;
    }
  }
  if (newAvailabilityKeys) {
    store.updateTaskInboxConfig({ appliedAvailabilityKeys: [...appliedAvailabilityKeys].slice(-300) });
  }

  // Neu in der Cloud (z.B. per Telegram angelegt) -> lokal übernehmen
  for (const rt of remoteTasks) {
    if (localIds.has(rt.id)) continue;
    const day = store.getOrCreateDayByDate(rt.date || todayStr());
    const match = rt.assignedToName
      ? employees.find((e) => e.name.trim().toLowerCase() === String(rt.assignedToName).trim().toLowerCase())
      : null;
    const t = store.addRemoteDayTask(day.id, {
      id: rt.id,
      text: rt.text,
      assignedTo: match ? match.id : null,
      priority: ["niedrig", "normal", "hoch"].includes(rt.priority) ? rt.priority : "normal",
    });
    if (rt.done && t) store.setDayTaskDone(day.id, t.id, true, "Telegram");
    applied++;
  }

  // Schon lokal bekannt, aber der Erledigt-Status in der Cloud weicht vom letzten bekannten Stand ab
  // (z.B. der Bot hat "ist erledigt" verarbeitet) -> lokal übernehmen, statt beim Hochladen zu überschreiben.
  for (const row of localRows) {
    const rt = remoteById.get(row.id);
    if (!rt) continue;
    const knownDone = knownState.get(row.id);
    if (knownDone !== undefined && rt.done !== knownDone && rt.done !== row.done) {
      store.setDayTaskDone(row.dayId, row.id, rt.done, rt.done ? "Telegram" : null);
    }
  }

  // War beim letzten Abgleich noch in der Cloud, jetzt nicht mehr (z.B. per Telegram gelöscht) -> lokal auch entfernen
  for (const id of knownState.keys()) {
    if (remoteById.has(id)) continue;
    const row = localRows.find((r) => r.id === id);
    if (row) store.removeDayTask(row.dayId, row.id);
  }

  // Jetzt vollständig abgeglichenen lokalen Stand hochladen, damit die Cloud auch lokale
  // Änderungen (abgehakt, manuell angelegt/gelöscht/bearbeitet) und wer im Dienst ist kennt.
  const freshRows = store.getTasksFrom(todayStr());
  const pushTasks = freshRows.map((r) => ({
    id: r.id,
    date: r.date,
    text: r.text,
    assignedToName: r.assignedTo ? store.getEmployee(r.assignedTo)?.name || null : null,
    priority: r.priority,
    done: r.done,
  }));
  const shiftsInService = store.getOpenShiftsToday().map((s) => ({
    name: store.getEmployee(s.employeeId)?.name || "?",
    since: s.from,
  }));
  const financials = cfg.shareFinancials ? buildFinancialsPayload() : [];
  const availabilityUpdate = buildAvailabilityUpdatePayload();
  // Für die Minijob-Grenzen-Warnung braucht der Bot, wer Minijobber ist und wo die Grenze liegt (nur die
  // Metadaten, die eigentlichen Lohnsummen kommen wie bisher aus financials -> nur wenn Kennzahlen freigegeben).
  const employeeMeta = cfg.shareFinancials
    ? employees.map((e) => ({ name: e.name, isMinijob: !!e.isMinijob, minijobLimit: Number(e.minijobLimit) || 556 }))
    : [];
  const staleOpenShifts = store.getStaleOpenShifts();
  // id und lowThreshold mitschicken, damit die Laptop-Ansicht Artikel gezielt bearbeiten/löschen kann.
  const stock = store.getStockItems().map((s) => ({
    id: s.id,
    name: s.name,
    status: s.status,
    unit: s.unit || "",
    currentAmount: s.unit ? s.currentAmount : null,
    lowThreshold: s.unit ? s.lowThreshold : null,
    needsReview: !!s.needsReview,
    aliases: s.aliases || [],
    bereich: s.bereich || "kueche",
    packSize: s.packSize || 1,
    packLabel: s.packLabel || "",
    pricePerUnit: s.pricePerUnit ?? null,
    priceSource: s.priceSource || null,
    // Verbrauch der letzten 30 Tage – daraus rechnet die Laptop-Ansicht die Reichweite. Bewusst der
    // ROHWERT plus die Zahl der Tage mit Verbrauch, nicht ein fertiges Ergebnis: so lässt sich am
    // Laptop zeigen, worauf die Aussage beruht.
    verbrauch30: store.getConsumptionSince(s.id, 30),
  }));
  // Was sich mit welchem Produkt verdienen lässt (90 Tage). Auf dem iPad gerechnet, weil nur er die
  // Rezepte und Einkaufspreise vollständig kennt.
  const produktStatistik = store.getProductStats(isoDaysAgo(90), todayStr());
  // Reservierungen als Tageszahlen – ausdrücklich ohne Namen und Telefonnummern.
  const reservationStats = store.getReservationStats(isoDaysAgo(90), todayStr());
  const recipes = store.getRecipes().map((r) => ({ id: r.id, productName: r.productName, ingredients: r.ingredients, needsReview: !!r.needsReview, aliases: r.aliases || [], yieldAmount: r.yieldAmount ?? 1, yieldUnit: r.yieldUnit || "Portion" }));
  // Stammdaten für die Laptop-Verwaltung – ohne PIN. Statt des PINs nur die Info, ob überhaupt einer
  // gesetzt ist, damit am Laptop sichtbar ist, wer sich noch nicht einstempeln kann.
  const employeeDetails = store.getEmployees(true).map((e) => ({
    id: e.id,
    name: e.name,
    role: e.role,
    hourlyWage: e.hourlyWage,
    isMinijob: !!e.isMinijob,
    minijobLimit: e.minijobLimit,
    active: e.active !== false,
    hasPin: !!e.pin,
  }));
  // Grundlage der Online-Buchung. Die belegten Zeitfenster gehen BEWUSST OHNE Namen und Telefonnummern
  // raus: für die Frage "ist noch etwas frei?" braucht es die nicht, und Gästedaten haben in der Cloud
  // nichts verloren, solange sie dort keinen Zweck erfüllen.
  const tables = store.getTables().map((t) => ({
    id: t.id,
    name: t.name,
    seats: t.seats,
    area: t.area,
    active: t.active !== false,
    combinesWith: t.combinesWith || [],
  }));
  const reservationSlots = buildReservationSlotsPayload();
  const einstellungen = store.getSettings().reservation || {};
  const reservationConfig = {
    durationMinutes: einstellungen.durationMinutes,
    openingHours: einstellungen.openingHours,
    maxDaysAhead: einstellungen.maxDaysAhead,
    minLeadMinutes: einstellungen.minLeadMinutes,
    maxGuestsOnline: einstellungen.maxGuestsOnline,
    onlineEnabled: einstellungen.onlineEnabled,
    // Nur die kommenden Sperrtage – vergangene interessieren die Buchungsseite nicht.
    terraceClosedDates: (einstellungen.terraceClosedDates || []).filter((d) => d >= todayStr()),
  };

  const { authPins, adminPinHash } = await buildAuthPinsPayload(cfg, employees);
  // Rollen und Schicht-Definitionen mitschicken, damit die Laptop-Ansicht weiß, welche Schichten es für
  // wen überhaupt gibt (die Definitionen sind code-gesteuert und leben sonst nur hier im Store).
  const employeeRoles = employees.map((e) => ({ name: e.name, role: e.role }));
  const shiftSlots = store.getSettings().shiftSlots;
  await pushLocalState(cfg, {
    employees: employees.map((e) => e.name),
    employeeRoles,
    shiftSlots,
    tasks: pushTasks,
    shiftsInService,
    financials,
    availabilityUpdate,
    employeeMeta,
    staleOpenShifts,
    stock,
    recipes,
    employeeDetails,
    authPins,
    adminPinHash,
    publishedWeeks: store.getPublishedWeeks(),
    tables,
    reservationSlots,
    reservationConfig,
    produktStatistik,
    reservationStats,
  });

  store.updateTaskInboxConfig({
    lastSyncAt: new Date().toISOString(),
    // Kein harter throw, damit der Sync trotzdem als "erfolgreich" durchläuft (Aufgaben/Tasks etc. sind ja
    // angekommen) – aber sichtbar in den Einstellungen, statt eine nicht zuordenbare Zuweisung/Nachricht/
    // Ablehnung stillschweigend zu verwerfen.
    lastError: syncWarnings.length > 0 ? syncWarnings.join(" · ") : null,
    knownRemoteState: pushTasks.map((t) => ({ id: t.id, done: t.done })).slice(-300),
  });
  return { applied, warnings: syncWarnings };
}

/** Beim App-Start / im Leerlauf aufrufen: gleicht still im Hintergrund ab, wenn aktiviert. */
async function maybeSyncPendingTasks() {
  const cfg = store.getTaskInboxConfig();
  if (!cfg.enabled) return;
  try {
    await performTaskSync();
  } catch (e) {
    store.updateTaskInboxConfig({ lastError: String(e.message || e) });
  }
}

export { performTaskSync, maybeSyncPendingTasks, sendNoteToBoss, pushAvailability, sendClockEvent, sendDayClosedReport };
