// ============================================================================
// nachricht.js – Fertige Nachricht an eine Telefonnummer vorbereiten.
//
// Das System verschickt selbst nichts. Es baut den Text und öffnet WhatsApp bzw. die SMS-App mit genau
// dieser Nummer und dem fertigen Text – abgeschickt wird von Hand. Das ist keine Notlösung: bei einer
// Absage will man den Ton meistens anpassen, und man sieht, was rausgeht. Ein automatischer Versand
// bräuchte außerdem einen kostenpflichtigen Anbieter.
// ============================================================================

/** Eine deutsche Handynummer in das Format bringen, das WhatsApp braucht: nur Ziffern, mit Landesvorwahl.
 *
 * "0176 123 45 67" → "491761234567", "+49 176 …" → "49176…", "0049…" → "49…".
 * Gibt null zurück, wenn daraus keine plausible Nummer wird – lieber keinen Link als einen, der beim
 * falschen Menschen landet.
 */
function whatsappNummer(roh) {
  let n = String(roh || "").replace(/[^0-9+]/g, "");
  if (!n) return null;
  if (n.startsWith("+")) n = n.slice(1);
  else if (n.startsWith("00")) n = n.slice(2);
  else if (n.startsWith("0")) n = "49" + n.slice(1); // deutsche Nummer ohne Landesvorwahl
  // Kürzer als eine Vorwahl plus Anschluss kann keine Handynummer sein.
  return n.length >= 10 && n.length <= 15 ? n : null;
}

/** Sieht das überhaupt nach einer Nummer aus, an die man schreiben kann? */
function hatNummer(roh) {
  return whatsappNummer(roh) !== null;
}

function whatsappLink(nummer, text) {
  const n = whatsappNummer(nummer);
  if (!n) return null;
  return `https://wa.me/${n}?text=${encodeURIComponent(text)}`;
}

/** SMS-Link. Die Schreibweise mit "?&body=" ist die, die sowohl iOS als auch Android verstehen –
 * nur "?body=" öffnet auf dem iPad eine leere Nachricht. */
function smsLink(nummer, text) {
  const n = String(nummer || "").replace(/[^0-9+]/g, "");
  if (!n) return null;
  return `sms:${n}?&body=${encodeURIComponent(text)}`;
}

/** Der Absage-Text.
 *
 * Bewusst kurz und ohne Floskeln: der Gast will wissen, dass es nicht klappt, warum, und dass er
 * willkommen bleibt. Alles Weitere schreibt man von Hand dazu – der Text ist vor dem Abschicken
 * änderbar.
 */
function absageText({ name, datum, zeit, personen, grundText, cafeName }) {
  const anrede = name ? `Hallo ${name},` : "Hallo,";
  const wann = [datum, zeit ? `um ${zeit} Uhr` : ""].filter(Boolean).join(" ");
  const wieViele = personen ? ` für ${personen} ${personen === 1 ? "Person" : "Personen"}` : "";
  return [
    anrede,
    "",
    `leider müssen wir eure Reservierung${wieViele} am ${wann} absagen: ${grundText}`,
    "",
    "Das tut uns leid. Meldet euch gerne für einen anderen Tag – wir freuen uns auf euch.",
    "",
    cafeName ? `Viele Grüße vom ${cafeName}` : "Viele Grüße",
  ].join("\n");
}

export { whatsappNummer, hatNummer, whatsappLink, smsLink, absageText };
