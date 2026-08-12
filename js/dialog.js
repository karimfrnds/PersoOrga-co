// ============================================================================
// dialog.js – Eigene Dialogfenster statt window.confirm/alert/prompt.
// Passt zum Design, funktioniert zuverlässig auf Tablet/Touch.
// ============================================================================

function openOverlay(innerHtml, wire) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "overlay";
    overlay.innerHTML = `<div class="dialog">${innerHtml}</div>`;
    document.body.appendChild(overlay);
    const close = (result) => {
      overlay.remove();
      resolve(result);
    };
    wire(overlay, close);
  });
}

/** Ersatz für window.confirm – gibt Promise<boolean> zurück. */
function confirmDialog(message, { title = "Bitte bestätigen", okLabel = "OK", cancelLabel = "Abbrechen", danger = false } = {}) {
  return openOverlay(
    `
      <h2>${title}</h2>
      <p>${message}</p>
      <div class="dialog-actions">
        <button class="btn btn-secondary" data-role="cancel">${cancelLabel}</button>
        <button class="btn ${danger ? "btn-icon-danger" : "btn-primary"}" data-role="ok" style="${danger ? "width:auto;padding:12px 18px;" : ""}">${okLabel}</button>
      </div>
    `,
    (overlay, close) => {
      overlay.querySelector('[data-role="cancel"]').onclick = () => close(false);
      overlay.querySelector('[data-role="ok"]').onclick = () => close(true);
    }
  );
}

/** Ersatz für window.prompt – gibt Promise<string|null> zurück. */
function promptDialog(message, { title = "Eingabe", placeholder = "", type = "text", defaultValue = "", okLabel = "Speichern" } = {}) {
  return openOverlay(
    `
      <h2>${title}</h2>
      <p>${message}</p>
      <input type="${type}" id="dlg-input" placeholder="${placeholder}" value="${defaultValue}" style="width:100%" />
      <div class="dialog-actions">
        <button class="btn btn-secondary" data-role="cancel">Abbrechen</button>
        <button class="btn btn-primary" data-role="ok">${okLabel}</button>
      </div>
    `,
    (overlay, close) => {
      const input = overlay.querySelector("#dlg-input");
      input.focus();
      overlay.querySelector('[data-role="cancel"]').onclick = () => close(null);
      overlay.querySelector('[data-role="ok"]').onclick = () => close(input.value);
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") close(input.value);
      });
    }
  );
}

/** Ersatz für window.alert – gibt Promise<void> zurück. */
function alertDialog(message, { title = "Hinweis" } = {}) {
  return openOverlay(
    `
      <h2>${title}</h2>
      <p>${message}</p>
      <div class="dialog-actions">
        <button class="btn btn-primary" data-role="ok">OK</button>
      </div>
    `,
    (overlay, close) => {
      overlay.querySelector('[data-role="ok"]').onclick = () => close();
    }
  );
}

export { confirmDialog, promptDialog, alertDialog };
