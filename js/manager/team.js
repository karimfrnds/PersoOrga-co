// ============================================================================
// manager/team.js – Das Team.
//
// Eine Liste zum Antippen. Wer gerade im Dienst ist, wer abwesend ist und bei wem der PIN fehlt, steht
// gleich dran – das sind die Dinge, die man beim Blick aufs Team wissen will. Tippt man eine Person an,
// kommen die drei Sachen, die man mit ihr tut: Nachricht schicken, Aufgabe geben, Angaben ändern.
//
// Löhne gibt es hier nicht: die sieht nur der Chef. Wer hier neu angelegt wird, bekommt Lohn und PIN
// von ihm am iPad.
// ============================================================================
import { employeeAction, sendMessage, taskAction } from "./api.js";
import { el, text, knopf, feld, eingabe, textfeld, auswahl, blatt, toast, ausfuehren, WT, ROLLEN, gleicherName, datumKurz } from "./ui.js";

const ABWESENHEIT = { urlaub: "🏖 Urlaub", krank: "🤒 krank", kind: "🧒 Kind krank", sonstiges: "📌 abwesend" };

function renderTeam(daten, { neuLaden }) {
  const wrap = el("div");
  const heute = daten.heute;

  const akt = el("div", "employee-actions");
  akt.appendChild(knopf("＋ Mitarbeiter anlegen", "btn btn-primary", () => personBlatt(daten, null, neuLaden)));
  akt.appendChild(knopf("💬 Nachricht an alle", "btn btn-secondary", () => nachrichtBlatt(null, neuLaden)));
  wrap.appendChild(akt);

  const team = [...(daten.team || [])].sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name));
  const aktiv = team.filter((p) => p.active);
  const inaktiv = team.filter((p) => !p.active);

  const card = el("section", "card");
  card.appendChild(text("h2", null, `Team · ${aktiv.length}`));
  const l = el("div", "mg-liste");
  for (const p of aktiv) l.appendChild(personZeile(daten, p, heute, neuLaden));
  if (aktiv.length === 0) l.appendChild(text("p", "muted small", "Noch niemand angelegt – oder das iPad hat sich noch nicht abgeglichen."));
  card.appendChild(l);
  wrap.appendChild(card);

  if (inaktiv.length > 0) {
    const d = document.createElement("details");
    d.className = "card";
    d.innerHTML = `<summary>Nicht mehr aktiv · ${inaktiv.length}</summary>`;
    const li = el("div", "mg-liste");
    for (const p of inaktiv) li.appendChild(personZeile(daten, p, heute, neuLaden));
    d.appendChild(li);
    wrap.appendChild(d);
  }
  return wrap;
}

function personZeile(daten, p, heute, neuLaden) {
  const imDienst = (daten.shiftsInService || []).find((s) => gleicherName(s.name, p.name));
  const abw = (daten.absenceReports || []).find((r) => gleicherName(r.employeeName, p.name) && r.from <= heute && (r.to || r.from) >= heute);
  const offen = (daten.tasks || []).filter((t) => t.date === heute && !t.done && gleicherName(t.assignedToName, p.name)).length;

  const z = knopf("", "mg-person" + (p.active ? "" : " aus"), () => personAktionen(daten, p, neuLaden));
  const zeilen = [ROLLEN[p.role] || p.role];
  if ((p.festeSchichten || []).length) zeilen.push("fest: " + p.festeSchichten.map((f) => WT[f.weekday]).join(", "));
  if (offen) zeilen.push(`${offen} ${offen === 1 ? "Aufgabe" : "Aufgaben"} heute`);
  z.innerHTML = `<span class="mg-person-name"></span><span class="muted small"></span><span class="mg-person-badges"></span>`;
  z.querySelector(".mg-person-name").textContent = p.name;
  z.querySelector(".muted").textContent = zeilen.join(" · ");
  const badges = z.querySelector(".mg-person-badges");
  if (imDienst) badges.appendChild(text("span", "badge badge-green", `im Dienst seit ${imDienst.since}`));
  if (abw) badges.appendChild(text("span", "badge badge-orange", ABWESENHEIT[abw.art] || "abwesend"));
  if (p.active && !p.hasPin) badges.appendChild(text("span", "badge badge-gray", "PIN fehlt"));
  return z;
}

function personAktionen(daten, p, neuLaden) {
  blatt(p.name, (box, schliessen) => {
    box.appendChild(text("p", "muted small", `${ROLLEN[p.role] || p.role}${p.hasPin ? "" : " · noch kein PIN zum Einstempeln"}`));
    const reihe = el("div", "mg-aktionen");
    reihe.appendChild(
      knopf("💬 Nachricht", "mg-aktion", () => {
        schliessen();
        nachrichtBlatt(p, neuLaden);
      })
    );
    reihe.appendChild(
      knopf("📋 Aufgabe geben", "mg-aktion", () => {
        schliessen();
        aufgabeGeben(daten, p, neuLaden);
      })
    );
    reihe.appendChild(
      knopf("✏️ Ändern", "mg-aktion", () => {
        schliessen();
        personBlatt(daten, p, neuLaden);
      })
    );
    box.appendChild(reihe);

    const heute = daten.heute;
    const offen = (daten.tasks || []).filter((t) => t.date >= heute && !t.done && gleicherName(t.assignedToName, p.name));
    if (offen.length > 0) {
      box.appendChild(text("p", "muted small res-bereich", "Offene Aufgaben"));
      const l = el("div", "mg-liste");
      for (const t of offen.slice(0, 8)) {
        l.appendChild(el("div", "mg-zeile", `<span></span><span class="muted small">${t.date === heute ? "heute" : datumKurz(t.date)}${t.time ? " · ab " + t.time : ""}</span>`));
        l.lastChild.firstChild.textContent = t.text;
      }
      box.appendChild(l);
    }

    box.appendChild(
      knopf(p.active ? "Deaktivieren" : "Wieder aktivieren", "btn btn-link", async (e) => {
        if (p.active && !confirm(`${p.name} deaktivieren? Die Person taucht bei neuen Schichten nicht mehr auf. Vergangenes bleibt erhalten.`)) return;
        const ok = await ausfuehren(
          e.currentTarget,
          () => employeeAction({ kind: p.active ? "deactivate" : "activate", employeeId: p.id, name: p.name, role: p.role }),
          "Gespeichert – kommt beim nächsten iPad-Abgleich an"
        );
        if (ok) {
          schliessen();
          neuLaden();
        }
      })
    );
  });
}

function nachrichtBlatt(p, neuLaden) {
  blatt(p ? `Nachricht an ${p.name}` : "Nachricht an alle", (box, schliessen) => {
    const t = textfeld("", "z.B. Denkt bitte an die Blumen für Freitag.", 5);
    t.maxLength = 1000;
    box.appendChild(feld("Nachricht", t, "Kommt im Handy-Postfach an und als Pop-up am iPad – mit deinem Namen davor."));
    box.appendChild(
      knopf("Senden", "btn btn-primary btn-huge", async (e) => {
        if (!t.value.trim()) return toast("Bitte etwas schreiben.", true);
        let res;
        const ok = await ausfuehren(e.currentTarget, async () => {
          res = await sendMessage(p ? { employeeName: p.name, text: t.value.trim() } : { toAll: true, text: t.value.trim() });
        });
        if (ok) {
          schliessen();
          toast(p ? `An ${p.name} gesendet` : `An ${res?.empfaenger ?? "alle"} gesendet`);
        }
      })
    );
    t.focus();
  });
}

function aufgabeGeben(daten, p, neuLaden) {
  blatt(`Aufgabe für ${p.name}`, (box, schliessen) => {
    const was = eingabe("text", "", "z.B. Kühlschrank abtauen");
    const wann = eingabe("date", daten.heute);
    wann.min = daten.heute;
    const zeit = eingabe("time", "");
    zeit.step = 300;
    const prio = auswahl(
      [
        ["normal", "Normal"],
        ["hoch", "🔴 Hoch"],
      ],
      "normal"
    );
    box.appendChild(feld("Was?", was));
    const r = el("div", "mg-reihe");
    r.append(feld("Tag", wann), feld("Ab wann?", zeit));
    box.appendChild(r);
    box.appendChild(feld("Priorität", prio));
    box.appendChild(text("p", "muted small", `Steht bei ${p.name} im eigenen Fenster am iPad, sobald das iPad abgeglichen hat.`));
    box.appendChild(
      knopf("Aufgabe geben", "btn btn-primary btn-huge", async (e) => {
        if (!was.value.trim()) return toast("Bitte eintragen, was zu tun ist.", true);
        const ok = await ausfuehren(
          e.currentTarget,
          () => taskAction({ kind: "create", text: was.value.trim(), date: wann.value || daten.heute, assignedToName: p.name, time: zeit.value, priority: prio.value }),
          `Aufgabe an ${p.name}`
        );
        if (ok) {
          schliessen();
          neuLaden();
        }
      })
    );
    was.focus();
  });
}

function personBlatt(daten, p, neuLaden) {
  blatt(p ? `${p.name} ändern` : "Mitarbeiter anlegen", (box, schliessen) => {
    const name = eingabe("text", p?.name, "Vor- und ggf. Nachname");
    const rolle = auswahl(Object.entries(ROLLEN), p?.role || "service");
    box.appendChild(feld("Name", name));
    box.appendChild(feld("Bereich", rolle));
    box.appendChild(
      text(
        "p",
        "callout",
        p
          ? "Lohn, PIN und feste Schichten ändert Karim am iPad."
          : "Nach dem Anlegen fehlen noch Stundenlohn und PIN zum Einstempeln – die vergibt Karim am iPad unter Admin → Mitarbeiter."
      )
    );
    box.appendChild(
      knopf(p ? "Speichern" : "Anlegen", "btn btn-primary btn-huge", async (e) => {
        const n = name.value.trim();
        if (!n) return toast("Bitte einen Namen eintragen.", true);
        if (!p && (daten.team || []).some((x) => gleicherName(x.name, n))) return toast(`${n} gibt es schon.`, true);
        const ok = await ausfuehren(
          e.currentTarget,
          () => employeeAction(p ? { kind: "update", employeeId: p.id, name: n, role: rolle.value } : { kind: "create", name: n, role: rolle.value }),
          "Gespeichert – kommt beim nächsten iPad-Abgleich an"
        );
        if (ok) {
          schliessen();
          neuLaden();
        }
      })
    );
    name.focus();
  });
}

export { renderTeam };
