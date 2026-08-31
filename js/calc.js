// ============================================================================
// calc.js – Reine Rechenfunktionen. Nichts hier greift auf Speicher/DOM zu,
// dadurch bleibt die Logik nachvollziehbar und einfach zu prüfen.
// ============================================================================

const ROLES = ["service", "kueche", "bar"];
const ROLE_LABEL = { service: "Service", kueche: "Küche", bar: "Bar" };
const VAT_RATES = { rate7: 0.07, rate19: 0.19 };

/** Extrahiert die enthaltene Umsatzsteuer aus einem Bruttobetrag (Umsatz inkl. USt). */
function extractVat(grossAmount, rate) {
  const gross = Number(grossAmount) || 0;
  return gross - gross / (1 + rate);
}

function parseTimeToMinutes(hhmm) {
  if (!hhmm) return null;
  const [h, m] = hhmm.split(":").map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return h * 60 + m;
}

function roundToStep(minutes, step) {
  if (!step || step <= 0) return minutes;
  return Math.round(minutes / step) * step;
}

/** Berechnet die Arbeitsdauer in Stunden zwischen from/to (HH:MM). Über Mitternacht wird automatisch erkannt. */
function computeHours(from, to, roundingMinutes) {
  const start = parseTimeToMinutes(from);
  const end = parseTimeToMinutes(to);
  if (start === null || end === null) return 0;
  let diff = end - start;
  if (diff < 0) diff += 24 * 60; // Schicht geht über Mitternacht (from === to heißt 0 Std., nicht 24)
  diff = roundToStep(diff, roundingMinutes);
  return Math.max(0, diff / 60);
}

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Gesetzliche Ruhepause (§4 ArbZG): über 6 Std. Arbeit -> 30 Min Pause, über 9 Std. -> 45 Min. */
function breakDeductionMinutes(rawHours) {
  if (rawHours > 9) return 45;
  if (rawHours > 6) return 30;
  return 0;
}

/**
 * Vollständige Berechnung eines Tages.
 * @param {object} day
 * @param {object[]} employees
 * @param {object} settings
 * @returns {object} breakdown
 */
function computeDay(day, employees, settings) {
  const empById = Object.fromEntries(employees.map((e) => [e.id, e]));
  const rounding = settings.roundingMinutes || 0;

  // 1) Stunden & Lohn pro Schicht/Mitarbeiter (mehrere Schichten pro Mitarbeiter möglich -> aufsummieren).
  // Pro Schicht wird automatisch die gesetzliche Pause abgezogen (>6 Std. -30 Min, >9 Std. -45 Min, §4 ArbZG) –
  // "hours" ist danach die bezahlte Nettozeit, "rawHours" die reine Kommen/Gehen-Zeit zur Kontrolle.
  const perEmployee = {}; // id -> { employee, hours, rawHours, breakMinutes, lohn, tip, cashPayout }
  for (const shift of day.shifts) {
    const emp = empById[shift.employeeId];
    if (!emp) continue;
    const rawHours = computeHours(shift.from, shift.to, rounding);
    const breakMinutes = breakDeductionMinutes(rawHours);
    const netHours = Math.max(0, rawHours - breakMinutes / 60);
    if (!perEmployee[emp.id]) {
      perEmployee[emp.id] = { employee: emp, hours: 0, rawHours: 0, breakMinutes: 0, lohn: 0, tip: 0, cashPayout: 0 };
    }
    perEmployee[emp.id].hours += netHours;
    perEmployee[emp.id].rawHours += rawHours;
    perEmployee[emp.id].breakMinutes += breakMinutes;
  }
  // Lohnnebenkosten (Arbeitgeberanteil Sozialversicherung etc.) – pauschaler Prozentsatz je nach
  // Beschäftigungsart, da die exakten Sätze (Berufsgenossenschaft etc.) individuell variieren. Nur eine
  // Schätzung für die eigene Kennzahlen-Übersicht, kein Ersatz für die Lohnbuchhaltung.
  const nebenkostenPct = settings.lohnnebenkostenProzent || { minijob: 30, festangestellt: 21 };
  for (const id in perEmployee) {
    const row = perEmployee[id];
    row.hours = round2(row.hours);
    row.rawHours = round2(row.rawHours);
    row.lohn = round2(row.hours * row.employee.hourlyWage);
    const pct = row.employee.isMinijob ? Number(nebenkostenPct.minijob ?? 30) : Number(nebenkostenPct.festangestellt ?? 21);
    row.lohnnebenkosten = round2(row.lohn * (pct / 100));
  }

  // 2) Trinkgeldtopf – Punkte-System: jede Rolle hat ein Gewicht (Punkte pro Stunde).
  // Eine Stunde Service mit Gewicht 70 zählt gleich viel wie 7 Stunden Bar mit Gewicht 10.
  // So fließen Rolle UND tatsächlich gearbeitete Zeit gemeinsam in eine einzige Rechnung ein –
  // wer an einem Tag länger da ist, bekommt automatisch einen größeren Anteil, unabhängig davon,
  // wie viele Stunden die anderen Rollen an diesem Tag gearbeitet haben.
  const kb = day.kassenabschluss || {};
  const tipPool = Number(kb.trinkgeldKarte || 0) + Number(kb.trinkgeldBar || 0);
  const weight = settings.tipSplit || { service: 0, kueche: 0, bar: 0 };

  let totalPoints = 0;
  for (const row of Object.values(perEmployee)) {
    row.points = round2(row.hours * (Number(weight[row.employee.role]) || 0));
    totalPoints += row.points;
  }

  let unassignedTip = 0; // niemand hat gearbeitet bzw. alle beteiligten Rollen haben Gewicht 0 -> Topf bleibt im Umschlag
  if (totalPoints > 0) {
    for (const row of Object.values(perEmployee)) {
      row.tip = round2(tipPool * (row.points / totalPoints));
    }
  } else {
    unassignedTip = tipPool;
  }

  // 3) Bar-Auszahlung an Mitarbeiter (Trinkgeld immer bar, Lohn nur wenn settings.cashWagePayout)
  let totalCashToStaff = 0;
  for (const row of Object.values(perEmployee)) {
    row.cashPayout = round2(row.tip + (settings.cashWagePayout ? row.lohn : 0));
    totalCashToStaff += row.cashPayout;
  }
  totalCashToStaff = round2(totalCashToStaff);

  // 4) Stornos (nur die, die tatsächlich Bargeld betreffen, mindern den Umschlag)
  const stornoCashTotal = round2((day.stornos || []).filter((s) => s.cashAffected).reduce((s, x) => s + Number(x.amount || 0), 0));
  const stornoTotal = round2((day.stornos || []).reduce((s, x) => s + Number(x.amount || 0), 0));

  // 5) Umschlag fürs Café
  const bargeldGesamt = round2(Number(kb.umsatzBar || 0) + Number(kb.trinkgeldBar || 0));
  const umschlag = round2(bargeldGesamt - totalCashToStaff - stornoCashTotal + unassignedTip);

  // 6) Umsatzsteuer-Aufteilung fürs Steuerbüro (7% ermäßigt / 19% regulär), Bruttobeträge lt. Kassenbon.
  const umsatz7 = Number(kb.umsatz7 || 0);
  const umsatz19 = Number(kb.umsatz19 || 0);
  const umsatzSplitDiff = round2(Number(kb.umsatzGesamt || 0) - umsatz7 - umsatz19);

  return {
    perEmployee: Object.values(perEmployee).sort((a, b) => a.employee.name.localeCompare(b.employee.name)),
    tipPool: round2(tipPool),
    totalPoints: round2(totalPoints),
    unassignedTip: round2(unassignedTip),
    totalCashToStaff,
    stornoTotal,
    stornoCashTotal,
    bargeldGesamt,
    umschlag,
    umsatz7,
    umsatz19,
    ust7: round2(extractVat(umsatz7, VAT_RATES.rate7)),
    ust19: round2(extractVat(umsatz19, VAT_RATES.rate19)),
    umsatzSplitDiff,
    totalLohn: round2(Object.values(perEmployee).reduce((s, r) => s + r.lohn, 0)),
    totalLohnnebenkosten: round2(Object.values(perEmployee).reduce((s, r) => s + r.lohnnebenkosten, 0)),
    totalHours: round2(Object.values(perEmployee).reduce((s, r) => s + r.hours, 0)),
    // Wareneinsatz: was die an diesem Tag verkauften Waren im Einkauf gekostet haben.
    materialkosten: round2(Number(day.materialkosten) || 0),
  };
}

/** Monatssumme pro Mitarbeiter für den Export/Steuerbüro (nur abgeschlossene Tage). */
function computeMonth(days, employees, settings, yyyymm) {
  const filtered = days.filter((d) => d.date.startsWith(yyyymm) && d.status === "abgeschlossen");
  const totals = {}; // employeeId -> { name, hours, lohn, tip }
  let umsatzGesamt = 0, umsatz7 = 0, umsatz19 = 0, ust7 = 0, ust19 = 0;
  for (const day of filtered) {
    const b = computeDay(day, employees, settings);
    for (const row of b.perEmployee) {
      if (!totals[row.employee.id]) {
        totals[row.employee.id] = { employee: row.employee, hours: 0, lohn: 0, tip: 0, lohnnebenkosten: 0 };
      }
      totals[row.employee.id].hours = round2(totals[row.employee.id].hours + row.hours);
      totals[row.employee.id].lohn = round2(totals[row.employee.id].lohn + row.lohn);
      totals[row.employee.id].tip = round2(totals[row.employee.id].tip + row.tip);
      totals[row.employee.id].lohnnebenkosten = round2(totals[row.employee.id].lohnnebenkosten + row.lohnnebenkosten);
    }
    umsatzGesamt += Number(day.kassenabschluss?.umsatzGesamt || 0);
    umsatz7 += b.umsatz7;
    umsatz19 += b.umsatz19;
    ust7 += b.ust7;
    ust19 += b.ust19;
  }
  const rows = Object.values(totals).sort((a, b) => a.employee.name.localeCompare(b.employee.name));
  const dayUmschlagTotal = round2(filtered.reduce((s, d) => s + computeDay(d, employees, settings).umschlag, 0));
  return {
    rows,
    days: filtered,
    dayUmschlagTotal,
    umsatzGesamt: round2(umsatzGesamt),
    umsatz7: round2(umsatz7),
    umsatz19: round2(umsatz19),
    ust7: round2(ust7),
    ust19: round2(ust19),
  };
}

/**
 * Stunden pro Mitarbeiter über einen frei wählbaren Zeitraum (inkl. offener Tage) –
 * für die reine Arbeitszeit-Übersicht, unabhängig von der Lohn-/Trinkgeld-Abrechnung.
 */
function computeRange(days, employees, settings, fromDate, toDate) {
  const filtered = days.filter((d) => (!fromDate || d.date >= fromDate) && (!toDate || d.date <= toDate));
  const totals = {}; // employeeId -> { employee, hours, lohn, tip, breakMinutes }
  for (const day of filtered) {
    const b = computeDay(day, employees, settings);
    for (const row of b.perEmployee) {
      if (!totals[row.employee.id]) {
        totals[row.employee.id] = { employee: row.employee, hours: 0, lohn: 0, tip: 0, breakMinutes: 0, lohnnebenkosten: 0 };
      }
      totals[row.employee.id].hours = round2(totals[row.employee.id].hours + row.hours);
      totals[row.employee.id].lohn = round2(totals[row.employee.id].lohn + row.lohn);
      totals[row.employee.id].tip = round2(totals[row.employee.id].tip + row.tip);
      totals[row.employee.id].breakMinutes += row.breakMinutes;
      totals[row.employee.id].lohnnebenkosten = round2(totals[row.employee.id].lohnnebenkosten + row.lohnnebenkosten);
    }
  }
  const rows = Object.values(totals).sort((a, b) => a.employee.name.localeCompare(b.employee.name));
  const openCount = filtered.filter((d) => d.status === "offen").length;
  return { rows, days: filtered, openCount, closedCount: filtered.length - openCount };
}

/**
 * Eine Zeile pro Mitarbeiter und Tag in einem Zeitraum (sortiert nach Datum, dann Name) –
 * für die tagesgenaue Übersicht im Admin-Bereich und den CSV-Export fürs Steuerbüro.
 */
function computeDayByDayRange(days, employees, settings, fromDate, toDate, { onlyClosed = false } = {}) {
  const filtered = days
    .filter((d) => (!fromDate || d.date >= fromDate) && (!toDate || d.date <= toDate))
    .filter((d) => !onlyClosed || d.status === "abgeschlossen")
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const rows = [];
  for (const day of filtered) {
    const b = computeDay(day, employees, settings);
    for (const row of b.perEmployee) {
      const shiftsOfEmployee = day.shifts.filter((s) => s.employeeId === row.employee.id);
      const timeRange = shiftsOfEmployee.map((s) => `${s.from}–${s.to}`).join(", ");
      rows.push({
        date: day.date,
        status: day.status,
        employee: row.employee,
        timeRange,
        hours: row.hours,
        rawHours: row.rawHours,
        breakMinutes: row.breakMinutes,
        lohn: row.lohn,
        tip: row.tip,
      });
    }
  }
  rows.sort((a, b) => (a.date === b.date ? a.employee.name.localeCompare(b.employee.name) : a.date < b.date ? -1 : 1));
  return rows;
}

export {
  ROLES,
  ROLE_LABEL,
  VAT_RATES,
  computeHours,
  breakDeductionMinutes,
  computeDay,
  computeMonth,
  computeRange,
  computeDayByDayRange,
  extractVat,
  round2,
  parseTimeToMinutes,
};
