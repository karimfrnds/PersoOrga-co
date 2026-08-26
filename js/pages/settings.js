// ============================================================================
// pages/settings.js – Verteilungsschlüssel, Rundung, Backup
// ============================================================================
import { store } from "../store.js";
import { ROLES, ROLE_LABEL } from "../calc.js";
import { confirmDialog, alertDialog } from "../dialog.js";
import { performBackup } from "../backup.js";
import { performTaskSync } from "../taskSync.js";
import { dateDe, todayStr } from "../format.js";

function renderSettings() {
  const container = document.createElement("div");
  container.className = "page";

  function rerender() {
    container.innerHTML = "";
    container.appendChild(build());
  }

  function build() {
    const settings = store.getSettings();
    const frag = document.createElement("div");
    frag.innerHTML = `<h1>Einstellungen</h1>`;

    // Verteilungsschlüssel (Punkte-System)
    const splitCard = document.createElement("section");
    splitCard.className = "card";
    splitCard.innerHTML = `
      <h2>Trinkgeld-Verteilung</h2>
      <p class="muted small">
        Jede Rolle bekommt eine Gewichtung (Punkte pro Stunde). Jeder Mitarbeiter sammelt an einem Tag
        <b>Stunden × Gewicht seiner Rolle</b> Punkte, der gesamte Trinkgeld-Topf wird dann im Verhältnis der
        gesammelten Punkte aufgeteilt. So zählen Rolle <i>und</i> tatsächlich gearbeitete Zeit gemeinsam –
        wer länger da ist, bekommt automatisch mehr, egal wie lange die anderen Rollen an diesem Tag da waren.
        Die Zahlen müssen sich nicht zu 100 aufaddieren, nur das Verhältnis zueinander zählt (z. B. Service 70
        zu Bar 10 bedeutet: eine Stunde Service zählt 7× so viel wie eine Stunde Bar).
      </p>
    `;
    const grid = document.createElement("div");
    grid.className = "kb-grid";
    for (const role of ROLES) {
      const wrap = document.createElement("label");
      wrap.className = "field";
      const span = document.createElement("span");
      span.textContent = ROLE_LABEL[role] + " (Punkte/Std.)";
      const input = document.createElement("input");
      input.type = "number";
      input.min = "0";
      input.step = "0.5";
      input.value = settings.tipSplit[role];
      input.onchange = () => {
        const tipSplit = { ...settings.tipSplit, [role]: Number(input.value) || 0 };
        store.updateSettings({ tipSplit });
        rerender();
      };
      wrap.appendChild(span);
      wrap.appendChild(input);
      grid.appendChild(wrap);
    }
    splitCard.appendChild(grid);
    frag.appendChild(splitCard);

    // Rundung
    const roundCard = document.createElement("section");
    roundCard.className = "card";
    roundCard.innerHTML = `<h2>Arbeitszeit-Rundung</h2><p class="muted small">Erfasste Zeiten werden auf diesen Wert gerundet.</p>`;
    const select = document.createElement("select");
    [
      [0, "keine Rundung"],
      [5, "auf 5 Minuten"],
      [10, "auf 10 Minuten"],
      [15, "auf 15 Minuten"],
      [30, "auf 30 Minuten"],
    ].forEach(([val, label]) => {
      const opt = document.createElement("option");
      opt.value = val;
      opt.textContent = label;
      if (settings.roundingMinutes === val) opt.selected = true;
      select.appendChild(opt);
    });
    select.onchange = () => {
      store.updateSettings({ roundingMinutes: Number(select.value) });
    };
    roundCard.appendChild(select);
    frag.appendChild(roundCard);

    // Lohnauszahlung
    const wageCard = document.createElement("section");
    wageCard.className = "card";
    wageCard.innerHTML = `<h2>Lohnauszahlung</h2><p class="muted small">Wird der Stundenlohn direkt bar aus der Kasse ausgezahlt (beeinflusst den Umschlag-Betrag)?</p>`;
    const checkboxLabel = document.createElement("label");
    checkboxLabel.className = "field-checkbox";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = settings.cashWagePayout;
    checkbox.onchange = () => store.updateSettings({ cashWagePayout: checkbox.checked });
    checkboxLabel.appendChild(checkbox);
    checkboxLabel.append(" Lohn wird bar ausgezahlt (sonst: Überweisung, nur Trinkgeld ist bar)");
    wageCard.appendChild(checkboxLabel);
    frag.appendChild(wageCard);

    // Admin-PIN
    const pinCard = document.createElement("section");
    pinCard.className = "card";
    pinCard.innerHTML = `<h2>Admin-PIN</h2><p class="muted small">Schützt diesen Bereich (Mitarbeiter, Einstellungen, Berichte) vor versehentlichen Änderungen. Kein echter Passwortschutz, nur ein Schutz gegen Versehen.</p>`;
    const changePinBtn = document.createElement("button");
    changePinBtn.className = "btn btn-secondary";
    changePinBtn.textContent = "PIN ändern";
    changePinBtn.onclick = () => openChangePinDialog();
    pinCard.appendChild(changePinBtn);
    frag.appendChild(pinCard);

    // Steuerhinweis
    const taxCard = document.createElement("section");
    taxCard.className = "card";
    taxCard.innerHTML = `
      <h2>Hinweis Steuer &amp; Recht</h2>
      <p class="small muted">
        Diese App ersetzt keine TSE-pflichtige Registrierkasse und keine Steuerberatung. Sie hilft bei der internen
        Dokumentation von Arbeitszeiten (§17 MiLoG), der sauberen Trennung von Lohn (steuerpflichtig) und Trinkgeld
        (i.d.R. steuerfrei nach §3 Nr. 51 EStG) sowie bei der Nachvollziehbarkeit von Stornos. Bitte die
        Berechnungslogik hier einmal mit eurem Steuerbüro abstimmen. Daten mindestens 2 Jahre (Arbeitszeiten) bzw.
        10 Jahre (Buchhaltungsrelevantes) aufbewahren – siehe Backup unten.
      </p>
    `;
    frag.appendChild(taxCard);

    // Automatisches Tages-Backup nach GitHub
    const autoBackupCard = document.createElement("section");
    autoBackupCard.className = "card";
    const ghCfg = store.getGithubBackupConfig();
    autoBackupCard.innerHTML = `
      <h2>Automatisches Tages-Backup (GitHub)</h2>
      <p class="muted small">
        Sichert einmal pro Tag automatisch alle Daten in euer GitHub-Repository (dasselbe, auf dem die App liegt) –
        ihr müsst dafür nichts tun, es läuft beim Öffnen der App im Hintergrund mit. Braucht ein
        <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">Fine-grained Personal Access Token</a>
        (bei GitHub selbst erstellt): Repository access → nur dieses eine Repo auswählen, Permissions →
        „Contents" auf „Read and write" stellen. Sonst nichts freigeben.
      </p>
    `;
    const enabledLabel = document.createElement("label");
    enabledLabel.className = "field-checkbox";
    const enabledCb = document.createElement("input");
    enabledCb.type = "checkbox";
    enabledCb.checked = ghCfg.enabled;
    enabledCb.onchange = () => store.updateGithubBackupConfig({ enabled: enabledCb.checked });
    enabledLabel.appendChild(enabledCb);
    enabledLabel.append(" Automatisches Backup aktivieren");
    autoBackupCard.appendChild(enabledLabel);

    const ghGrid = document.createElement("div");
    ghGrid.className = "kb-grid";
    const ownerField = document.createElement("label");
    ownerField.className = "field";
    ownerField.innerHTML = `<span>GitHub-Nutzername</span>`;
    const ownerInput = document.createElement("input");
    ownerInput.type = "text";
    ownerInput.value = ghCfg.owner;
    ownerInput.onchange = () => store.updateGithubBackupConfig({ owner: ownerInput.value.trim() });
    ownerField.appendChild(ownerInput);

    const repoField = document.createElement("label");
    repoField.className = "field";
    repoField.innerHTML = `<span>Repository-Name</span>`;
    const repoInput = document.createElement("input");
    repoInput.type = "text";
    repoInput.value = ghCfg.repo;
    repoInput.onchange = () => store.updateGithubBackupConfig({ repo: repoInput.value.trim() });
    repoField.appendChild(repoInput);

    const tokenField = document.createElement("label");
    tokenField.className = "field";
    tokenField.innerHTML = `<span>Personal Access Token</span>`;
    const tokenInput = document.createElement("input");
    tokenInput.type = "password";
    tokenInput.value = ghCfg.token;
    tokenInput.onchange = () => store.updateGithubBackupConfig({ token: tokenInput.value.trim() });
    tokenField.appendChild(tokenInput);

    ghGrid.appendChild(ownerField);
    ghGrid.appendChild(repoField);
    ghGrid.appendChild(tokenField);
    autoBackupCard.appendChild(ghGrid);

    const statusLine = document.createElement("p");
    statusLine.className = ghCfg.lastError ? "callout callout-warn" : "muted small";
    if (ghCfg.lastError) {
      statusLine.textContent = `⚠ Letztes automatisches Backup fehlgeschlagen: ${ghCfg.lastError}`;
    } else if (ghCfg.lastBackupDate) {
      statusLine.textContent = `Letztes Backup: ${ghCfg.lastBackupDate === todayStr() ? "heute" : dateDe(ghCfg.lastBackupDate)}.`;
    } else {
      statusLine.textContent = "Noch kein Backup durchgeführt.";
    }
    autoBackupCard.appendChild(statusLine);

    const testBtn = document.createElement("button");
    testBtn.className = "btn btn-secondary";
    testBtn.textContent = "Jetzt testen";
    testBtn.onclick = async () => {
      testBtn.disabled = true;
      testBtn.textContent = "Sichere…";
      try {
        await performBackup();
        await alertDialog("Backup erfolgreich. Zu finden im Repo unter „backups/“.");
      } catch (e) {
        await alertDialog("Backup fehlgeschlagen: " + e.message, { title: "Fehler" });
      }
      rerender();
    };
    autoBackupCard.appendChild(testBtn);
    frag.appendChild(autoBackupCard);

    // Telegram-Aufgaben abgleichen (eigener Cloudflare Worker + KV-Speicher, unabhängig von GitHub)
    const inboxCard = document.createElement("section");
    inboxCard.className = "card";
    const inboxCfg = store.getTaskInboxConfig();
    inboxCard.innerHTML = `
      <h2>Telegram-Aufgaben abgleichen</h2>
      <p class="muted small">
        Gleicht Aufgaben mit dem Telegram-Bot ab (Einrichtung: siehe <code>worker/README.md</code> im Repo) – neue/gelöschte
        Aufgaben aus dem Chat werden übernommen, der eigene Stand wird hochgeladen, damit „liste" im Chat immer stimmt.
        Läuft automatisch beim Öffnen des Kiosk-Bildschirms und danach alle 90 Sekunden im Leerlauf mit.
      </p>
    `;
    const inboxEnabledLabel = document.createElement("label");
    inboxEnabledLabel.className = "field-checkbox";
    const inboxEnabledCb = document.createElement("input");
    inboxEnabledCb.type = "checkbox";
    inboxEnabledCb.checked = inboxCfg.enabled;
    inboxEnabledCb.onchange = () => store.updateTaskInboxConfig({ enabled: inboxEnabledCb.checked });
    inboxEnabledLabel.appendChild(inboxEnabledCb);
    inboxEnabledLabel.append(" Telegram-Aufgaben-Abgleich aktivieren");
    inboxCard.appendChild(inboxEnabledLabel);

    const inboxGrid = document.createElement("div");
    inboxGrid.className = "kb-grid";
    const workerUrlField = document.createElement("label");
    workerUrlField.className = "field";
    workerUrlField.innerHTML = `<span>Worker-URL</span>`;
    const workerUrlInput = document.createElement("input");
    workerUrlInput.type = "text";
    workerUrlInput.placeholder = "https://cafe-telegram-bot.deinname.workers.dev";
    workerUrlInput.value = inboxCfg.workerUrl;
    workerUrlInput.onchange = () => store.updateTaskInboxConfig({ workerUrl: workerUrlInput.value.trim() });
    workerUrlField.appendChild(workerUrlInput);

    const workerSecretField = document.createElement("label");
    workerSecretField.className = "field";
    workerSecretField.innerHTML = `<span>Zugriffsschlüssel</span>`;
    const workerSecretInput = document.createElement("input");
    workerSecretInput.type = "password";
    workerSecretInput.placeholder = "derselbe Wert wie WEBHOOK_SECRET im Worker";
    workerSecretInput.value = inboxCfg.workerSecret;
    workerSecretInput.onchange = () => store.updateTaskInboxConfig({ workerSecret: workerSecretInput.value.trim() });
    workerSecretField.appendChild(workerSecretInput);

    inboxGrid.appendChild(workerUrlField);
    inboxGrid.appendChild(workerSecretField);
    inboxCard.appendChild(inboxGrid);

    const financialsLabel = document.createElement("label");
    financialsLabel.className = "field-checkbox";
    const financialsCb = document.createElement("input");
    financialsCb.type = "checkbox";
    financialsCb.checked = inboxCfg.shareFinancials;
    financialsCb.onchange = () => store.updateTaskInboxConfig({ shareFinancials: financialsCb.checked });
    financialsLabel.appendChild(financialsCb);
    financialsLabel.append(" Kennzahlen (Umsatz/Lohnkosten/Stunden der letzten ~5 Wochen, inkl. Stunden je Mitarbeiter) für Chat-Abfragen freigeben");
    inboxCard.appendChild(financialsLabel);
    const financialsNote = document.createElement("p");
    financialsNote.className = "muted small";
    financialsNote.textContent = "Separat, weil sensibler als reine Aufgaben-Texte – ohne Häkchen bleiben Umsatz/Löhne/Mitarbeiterstunden nur lokal auf dem iPad.";
    inboxCard.appendChild(financialsNote);

    const inboxStatusLine = document.createElement("p");
    inboxStatusLine.className = inboxCfg.lastError ? "callout callout-warn" : "muted small";
    if (inboxCfg.lastError) {
      // Kann entweder ein echter Fehlschlag sein (Netzwerk/Worker nicht erreichbar) oder ein Hinweis,
      // dass einzelne Bot-Zuweisungen/Nachrichten nicht zugeordnet werden konnten (Name/Schicht prüfen) –
      // der Rest des Abgleichs (Aufgaben etc.) lief in beiden Fällen trotzdem durch.
      inboxStatusLine.textContent = `⚠ Hinweis zum letzten Abgleich: ${inboxCfg.lastError}`;
    } else if (inboxCfg.lastSyncAt) {
      const t = new Date(inboxCfg.lastSyncAt);
      inboxStatusLine.textContent = `Letzter Abgleich: ${t.toLocaleDateString("de-DE")} ${t.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })} Uhr.`;
    } else {
      inboxStatusLine.textContent = "Noch kein Abgleich durchgeführt.";
    }
    inboxCard.appendChild(inboxStatusLine);

    const inboxTestBtn = document.createElement("button");
    inboxTestBtn.className = "btn btn-secondary";
    inboxTestBtn.textContent = "Jetzt abgleichen";
    inboxTestBtn.onclick = async () => {
      inboxTestBtn.disabled = true;
      inboxTestBtn.textContent = "Gleiche ab…";
      try {
        const result = await performTaskSync();
        await alertDialog(result.applied > 0 ? `${result.applied} neue Aufgabe(n) übernommen.` : "Keine neuen Aufgaben aus der Cloud, eigener Stand ist hochgeladen.");
      } catch (e) {
        await alertDialog("Abgleich fehlgeschlagen: " + e.message, { title: "Fehler" });
      }
      rerender();
    };
    inboxCard.appendChild(inboxTestBtn);
    frag.appendChild(inboxCard);

    // Manuelles Backup
    const backupCard = document.createElement("section");
    backupCard.className = "card";
    backupCard.innerHTML = `<h2>Manuelle Datensicherung</h2><p class="muted small">Zusätzlich zum automatischen Backup – z.B. um eine Sicherung direkt auf diesem Gerät zu behalten.</p>`;
    const exportBtn = document.createElement("button");
    exportBtn.className = "btn btn-secondary";
    exportBtn.textContent = "⬇ Sicherung herunterladen (JSON)";
    exportBtn.onclick = () => {
      const blob = new Blob([store.exportJSON()], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `cafe-backup-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    };
    backupCard.appendChild(exportBtn);

    const importLabel = document.createElement("label");
    importLabel.className = "btn btn-secondary";
    importLabel.textContent = "⬆ Sicherung wiederherstellen";
    const importInput = document.createElement("input");
    importInput.type = "file";
    importInput.accept = "application/json";
    importInput.style.display = "none";
    importInput.onchange = async () => {
      const file = importInput.files[0];
      if (!file) return;
      if (!(await confirmDialog("Aktuelle Daten werden durch die Sicherung ersetzt. Fortfahren?", { danger: true, okLabel: "Ersetzen" }))) return;
      const text = await file.text();
      try {
        store.importJSON(text);
        await alertDialog("Wiederhergestellt.");
        location.reload();
      } catch (e) {
        await alertDialog("Datei konnte nicht gelesen werden: " + e.message);
      }
    };
    importLabel.appendChild(importInput);
    backupCard.appendChild(importLabel);
    frag.appendChild(backupCard);

    return frag;
  }

  function openChangePinDialog() {
    const overlay = document.createElement("div");
    overlay.className = "overlay";
    overlay.innerHTML = `
      <div class="dialog">
        <h2>Admin-PIN ändern</h2>
        <label class="field"><span>Neuer PIN (mind. 4 Zeichen)</span><input type="text" inputmode="numeric" id="p-new" /></label>
        <label class="field"><span>Wiederholen</span><input type="text" inputmode="numeric" id="p-repeat" /></label>
        <div class="dialog-actions">
          <button class="btn btn-secondary" id="p-cancel">Abbrechen</button>
          <button class="btn btn-primary" id="p-save">Speichern</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    overlay.querySelector("#p-cancel").onclick = () => overlay.remove();
    overlay.querySelector("#p-save").onclick = async () => {
      const p1 = overlay.querySelector("#p-new").value.trim();
      const p2 = overlay.querySelector("#p-repeat").value.trim();
      if (p1.length < 4) {
        await alertDialog("Der PIN sollte mindestens 4 Zeichen haben.");
        return;
      }
      if (p1 !== p2) {
        await alertDialog("Die beiden Eingaben stimmen nicht überein.");
        return;
      }
      store.setAdminPin(p1);
      overlay.remove();
      await alertDialog("PIN geändert.");
    };
  }

  rerender();
  return container;
}

export { renderSettings };
