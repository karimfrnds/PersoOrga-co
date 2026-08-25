// ============================================================================
// pages/session.js – Ansicht nach dem Einstempeln: gemeinsame Tages-Aufgaben
// abhaken, Schicht beenden. Ist gerade niemand sonst mehr eingestempelt, wird
// automatisch der Tagesabschluss (erst offene Aufgaben, dann Kassenabschluss
// in day.js) angeboten.
// ============================================================================
import { store } from "../store.js";
import { escapeHtml, todayStr } from "../format.js";
import { confirmDialog, alertDialog } from "../dialog.js";

function renderSession(employee, navigate) {
  const container = document.createElement("div");
  container.className = "page";

  let mode = "working"; // "working" | "closing" | "goodbye"
  let goodbyeTimer = null;

  function rerender() {
    clearGoodbyeTimer();
    container.innerHTML = "";
    container.appendChild(build());
  }

  function clearGoodbyeTimer() {
    if (goodbyeTimer) {
      clearTimeout(goodbyeTimer);
      goodbyeTimer = null;
    }
  }

  function build() {
    const day = store.getDayByDate(todayStr());
    if (mode === "goodbye" || !day) return buildGoodbye();
    return buildTasks(day);
  }

  function buildTasks(day) {
    const wrap = document.createElement("div");
    const closing = mode === "closing";
    const openShift = store.getOpenShiftForEmployeeToday(employee.id);
    const clockedInAt = openShift?.from;

    const head = document.createElement("div");
    head.className = "session-head";
    head.innerHTML = closing
      ? `<h1>Bevor es zum Kassenabschluss geht</h1><p class="muted">Bitte erst alle offenen Aufgaben erledigen, ${escapeHtml(employee.name)}.</p>`
      : `<h1>Hallo ${escapeHtml(employee.name)}</h1><p class="muted">${clockedInAt ? `Im Dienst seit ${escapeHtml(clockedInAt)} Uhr` : "Im Dienst"}</p>`;
    wrap.appendChild(head);

    const tasksCard = document.createElement("section");
    tasksCard.className = "card";
    const openCount = day.tasks.filter((t) => !t.done).length;
    tasksCard.innerHTML = `<h2>📋 Aufgaben heute${day.tasks.length ? ` <span class="muted small">(${openCount} offen)</span>` : ""}</h2>`;

    if (day.tasks.length === 0) {
      const empty = document.createElement("p");
      empty.className = "muted";
      empty.textContent = "Keine Aufgaben hinterlegt.";
      tasksCard.appendChild(empty);
    } else {
      const list = document.createElement("div");
      list.className = "task-list";
      // Eigene zugeordnete Aufgaben zuerst, dann nach Priorität, damit Dringendes nicht untergeht.
      const priorityOrder = { hoch: 0, normal: 1, niedrig: 2 };
      const sortedTasks = [...day.tasks].sort((a, b) => {
        const mine = (a.assignedTo === employee.id ? 0 : 1) - (b.assignedTo === employee.id ? 0 : 1);
        if (mine !== 0) return mine;
        return (priorityOrder[a.priority] ?? 1) - (priorityOrder[b.priority] ?? 1);
      });
      for (const task of sortedTasks) {
        const row = document.createElement("label");
        row.className = "task-row" + (task.done ? " done" : "");
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = task.done;
        cb.onchange = () => {
          store.toggleDayTask(day.id, task.id, employee.name);
          rerender();
        };
        row.appendChild(cb);
        const textWrap = document.createElement("div");
        textWrap.className = "task-row-text";
        const span = document.createElement("span");
        span.textContent = (task.priority === "hoch" ? "🔴 " : task.priority === "niedrig" ? "🔵 " : "") + task.text;
        textWrap.appendChild(span);
        if (task.assignedTo) {
          const assignee = store.getEmployee(task.assignedTo);
          if (assignee) {
            const tag = document.createElement("span");
            tag.className = "muted small task-row-meta";
            tag.textContent = `→ für ${assignee.name}`;
            textWrap.appendChild(tag);
          }
        }
        if (task.done && task.doneBy) {
          const meta = document.createElement("span");
          meta.className = "muted small task-row-meta";
          meta.textContent = `✓ erledigt von ${task.doneBy}${task.doneAt ? ", " + new Date(task.doneAt).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" }) + " Uhr" : ""}`;
          textWrap.appendChild(meta);
        }
        row.appendChild(textWrap);
        list.appendChild(row);
      }
      tasksCard.appendChild(list);
    }

    const addRow = document.createElement("div");
    addRow.className = "task-add-row";
    const addInput = document.createElement("input");
    addInput.type = "text";
    addInput.placeholder = "Neue Aufgabe/Notiz für heute…";
    const addBtn = document.createElement("button");
    addBtn.className = "btn btn-secondary";
    addBtn.textContent = "＋";
    const addTask = () => {
      const text = addInput.value.trim();
      if (!text) return;
      store.addAdhocDayTask(day.id, text, employee.name);
      rerender();
    };
    addBtn.onclick = addTask;
    addInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") addTask();
    });
    addRow.appendChild(addInput);
    addRow.appendChild(addBtn);
    tasksCard.appendChild(addRow);

    wrap.appendChild(tasksCard);

    if (closing) {
      const allDone = store.allTasksDone(day.id);
      const goBtn = document.createElement("button");
      goBtn.className = "btn btn-primary btn-huge";
      goBtn.textContent = allDone ? "Weiter zum Kassenabschluss →" : `Noch ${openCount} Aufgabe(n) offen`;
      goBtn.disabled = !allDone;
      goBtn.onclick = () => navigate(`day/${day.id}`);
      wrap.appendChild(goBtn);

      const backLink = document.createElement("button");
      backLink.className = "btn btn-link";
      backLink.textContent = "← Doch noch nicht abschließen";
      backLink.onclick = () => {
        mode = "working";
        rerender();
      };
      wrap.appendChild(backLink);
    } else {
      const endBtn = document.createElement("button");
      endBtn.className = "btn btn-primary btn-huge";
      endBtn.textContent = "🚪 Schicht beenden";
      endBtn.onclick = () => endShift(day);
      wrap.appendChild(endBtn);
    }

    return wrap;
  }

  async function endShift(day) {
    const openShift = store.getOpenShiftForEmployeeToday(employee.id);
    if (!openShift) {
      navigate("");
      return;
    }
    store.clockOut(day.id, openShift.id);
    const stillOpen = store.getOpenShiftsToday();
    if (stillOpen.length > 0 || day.status === "abgeschlossen") {
      mode = "goodbye";
      rerender();
      return;
    }
    const wantsClose = await confirmDialog(
      `${escapeHtml(employee.name)}, du bist aktuell als Letzte(r) eingestempelt. Jetzt den Tag abschließen (Kassenabschluss)?`,
      { title: "Tag abschließen?", okLabel: "Ja, abschließen", cancelLabel: "Nein, später" }
    );
    if (!wantsClose) {
      mode = "goodbye";
      rerender();
      return;
    }
    if (day.tasks.length > 0 && !store.allTasksDone(day.id)) {
      await alertDialog("Bitte zuerst alle offenen Aufgaben erledigen, dann geht es zum Kassenabschluss.");
    }
    mode = "closing";
    rerender();
  }

  function buildGoodbye() {
    const wrap = document.createElement("div");
    wrap.className = "kiosk-wrap";
    wrap.innerHTML = `
      <div class="kiosk-greet-card card card-highlight">
        <div class="kiosk-greet-emoji">👋</div>
        <h1>Bis bald, ${escapeHtml(employee.name)}!</h1>
        <p class="muted">Du bist jetzt ausgestempelt.</p>
      </div>
    `;
    const doneBtn = document.createElement("button");
    doneBtn.className = "btn btn-primary btn-huge";
    doneBtn.textContent = "Fertig";
    doneBtn.onclick = () => {
      clearGoodbyeTimer();
      navigate("");
    };
    wrap.appendChild(doneBtn);
    goodbyeTimer = setTimeout(() => navigate(""), 3000);
    return wrap;
  }

  rerender();
  return container;
}

export { renderSession };
