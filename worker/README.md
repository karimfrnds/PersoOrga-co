# Telegram-Aufgaben-Bot einrichten

Damit du Aufgaben per Telegram-Nachricht statt am iPad eintragen kannst – inkl. Liste ansehen und Löschen,
und das **jederzeit von unterwegs**, auch wenn das iPad gerade aus/gesperrt ist. Dafür liegen die Aufgaben in
einem kleinen, immer erreichbaren Cloudflare-Speicher (KV), nicht mehr nur auf dem iPad.

## Du hattest den Bot schon eingerichtet? Das ändert sich

Der Bot braucht jetzt **keine GitHub-Zugangsdaten mehr** (kein `GITHUB_TOKEN`/`GITHUB_OWNER`/`GITHUB_REPO`) –
die kannst du im Worker löschen, schaden tun sie aber auch nicht, falls du sie drinlässt. Stattdessen kommt ein
**KV-Speicher** dazu (Schritt 3 unten). Danach: neuen Code aus Schritt 2 einfügen, und in der App unter
Einstellungen die **neuen** Felder „Worker-URL" und „Zugriffsschlüssel" ausfüllen (ersetzen die alte
GitHub-Kopplung dort).

## 1. Telegram-Bot erstellen (nur beim allerersten Mal nötig)

1. In Telegram nach **@BotFather** suchen, Chat öffnen.
2. `/newbot` senden, Namen und Nutzernamen vergeben (Nutzername muss auf `bot` enden, z.B. `CafeAufgabenBot`).
3. BotFather schickt dir einen **Token** (lange Zeichenkette wie `123456789:AAF...`). Kopieren, brauchst du gleich.

## 2. Cloudflare Worker anlegen (falls noch nicht vorhanden)

1. Auf [dash.cloudflare.com](https://dash.cloudflare.com) kostenlos registrieren (keine Kreditkarte nötig).
2. Links **Workers & Pages** → **Create** → **Create Worker**. Namen vergeben (z.B. `cafe-telegram-bot`), erstellen.
3. Im Worker auf **Edit Code** (Quick Edit), kompletten Inhalt von [`telegram-bot.js`](telegram-bot.js) aus diesem
   Ordner reinkopieren (vorhandenen Code komplett ersetzen). **Deploy** klicken.
4. Merke dir die Worker-URL (steht oben, z.B. `https://cafe-telegram-bot.deinname.workers.dev`).

## 3. KV-Speicher anlegen und verbinden (neu, ca. 3 Min.)

1. Cloudflare-Dashboard → links **Workers & Pages** → Reiter **KV** → **Create namespace**. Namen vergeben, z.B.
   `cafe-tasks`, erstellen.
2. Zurück zu deinem Worker → **Settings** → **Bindings** → **Add binding** → **KV namespace**.
3. **Variable name** muss exakt `TASKS_KV` heißen (so heißt es im Code). Bei **KV namespace** den gerade
   erstellten Namespace (`cafe-tasks`) auswählen. Speichern/Deploy.

## 4. Secrets/Variablen im Worker setzen

Im Worker unter **Settings → Variables and Secrets** folgende **Secrets** (verschlüsselt) anlegen:

| Name | Wert |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Token von @BotFather aus Schritt 1 |
| `WEBHOOK_SECRET` | ein frei erfundenes, langes Passwort. Wird doppelt genutzt: für Telegram UND als Zugriffsschlüssel, den die App gleich in den Einstellungen bekommt |
| `OWNER_CHAT_ID` | **erstmal leer lassen** – kommt in Schritt 6 |
| `ANTHROPIC_API_KEY` | API-Key von [console.anthropic.com](https://console.anthropic.com/settings/keys) (eigener, kostenpflichtiger Account nötig – Kosten sind bei diesem Nachrichtenaufkommen aber minimal, Bruchteile eines Cents pro Nachricht). Fehlt der Key oder ist die API mal nicht erreichbar, antwortet der Bot mit einer Fehlermeldung statt zu raten. Wird auch für die kurzen Kennzahlen-Beobachtungen genutzt (siehe unten) – fehlt der Key, funktionieren „liste"/„kennzahlen" trotzdem, nur die Beobachtungen fallen dann weg. |

## 5. Telegram-Webhook registrieren (einmaliger Aufruf)

Diesen Link im Browser öffnen (Werte ersetzen: `<TOKEN>` = Bot-Token, `<WORKER_URL>` = URL aus Schritt 2,
`<WEBHOOK_SECRET>` = das Passwort aus Schritt 4):

```
https://api.telegram.org/bot<TOKEN>/setWebhook?url=<WORKER_URL>&secret_token=<WEBHOOK_SECRET>
```

Antwort sollte `"ok":true` enthalten.

## 6. Eigene Chat-ID herausfinden

1. In Telegram eine beliebige Nachricht an deinen neuen Bot schicken (z.B. „Hallo").
2. Der Bot antwortet mit: „Setup: Deine Chat-ID ist 123456789. Bitte als OWNER_CHAT_ID-Secret hinterlegen."
3. Diese Zahl als `OWNER_CHAT_ID`-Secret im Worker eintragen (Schritt 4, Tabelle).

Ab jetzt reagiert der Bot **nur noch auf Nachrichten von dir** – alle anderen werden stillschweigend ignoriert.

## 7. In der App aktivieren

App → Admin → Einstellungen → „Telegram-Aufgaben abgleichen":
- **Worker-URL**: die URL aus Schritt 2 (z.B. `https://cafe-telegram-bot.deinname.workers.dev`)
- **Zugriffsschlüssel**: derselbe Wert wie `WEBHOOK_SECRET` aus Schritt 4
- Häkchen bei „Telegram-Aufgaben-Abgleich aktivieren" setzen
- Optional zusätzlich Häkchen bei „Kennzahlen … für Chat-Abfragen freigeben" – erst damit kann der Bot
  „kennzahlen"/„wie war der Umsatz" beantworten (siehe unten). Separates Häkchen, weil sensibler als reine
  Aufgaben-Texte: ohne Häkchen bleiben Umsatz/Löhne nur lokal auf dem iPad, es werden nur Aufgabentexte und wer
  im Dienst ist synchronisiert.

## Nutzung

Der Bot versteht ganz normal formulierte Nachrichten (per KI interpretiert) und kennt dabei immer den aktuellen
Stand – der liegt im KV-Speicher, den Bot und App beide direkt lesen/schreiben, unabhängig davon ob das iPad
gerade an ist.

**Aufgaben anlegen** – auch mehrere auf einmal, auch an verschiedene Personen:
- `Kaffeemaschine reparieren lassen` → allgemeine Aufgabe für heute.
- `Timm: Kasse nachzählen` oder `Arianna soll die Vitrine putzen` → Aufgabe für die genannte Person (muss zu
  einem aktiven Mitarbeiter passen, sonst bleibt sie unzugeordnet).
- `Anna soll dran denken, Montag ist Inventur` → landet automatisch am Montag statt heute.
- „Das ist dringend" / „priorisieren" → Priorität „hoch"; „kann warten" / „niedrig" → Priorität „niedrig".
- `Timm soll die Vitrine putzen und Anna soll die Kasse zählen` → wird in **zwei** getrennte Aufgaben zerlegt,
  auch bei längeren, frei formulierten Nachrichten mit mehreren Themen.

**Aufgaben ansehen:** `liste`, `was steht noch an`, `zeig mir alles offene` → antwortet sofort mit der
aktuellen Übersicht, gruppiert nach Tag – funktioniert auch wenn das iPad gerade aus ist.

**Aufgaben löschen:** in eigenen Worten beschreiben, was weg soll, z.B. `lösch die Aufgabe Kasse zählen bei
Anna` oder `entfern die Inventur-Aufgabe von Timm am Montag`. Der Bot sucht in der aktuellen Liste nach einem
eindeutigen Treffer, entfernt sie sofort im Speicher und bestätigt, was weg ist.

**Aufgaben als erledigt markieren** (ohne zu löschen): z.B. `Kasse zählen ist erledigt` oder `hab die Vitrine
geputzt`. Wird beim nächsten Sync auch am iPad als abgehakt angezeigt (inkl. „erledigt von Telegram").

**„Wer ist gerade da?"**: `wer ist im dienst`, `wer arbeitet gerade` → zeigt, wer laut letztem iPad-Abgleich
gerade eingestempelt ist.

**Kennzahlen-Übersicht** (nur wenn oben in der App freigegeben, siehe Schritt 7): `kennzahlen`, `wie war der
Umsatz heute`, `wie lief die Woche`, `Zusammenfassung diesen Monat` → Umsatz, Trinkgeld, Lohnkosten (inkl.
Lohnquote), Stunden und Umschlag für „heute"/„gestern"/„diese Woche" (ab Montag)/„diesen Monat", plus – wenn
genug Historie da ist – 2-3 kurze, rein aus den eigenen Zahlen abgeleitete Beobachtungen (klar mit 💡
gekennzeichnet, **keine** Steuer- oder Finanzberatung). Basis sind die letzten ca. 5 Wochen, die die App bei
jedem Abgleich mit hochlädt.

**Stunden/Lohn einer einzelnen Person**: `wie viele Stunden hat Anna diese Woche gemacht`, `was hat Timm im
August gearbeitet` → Summe der Arbeitsstunden und des Lohns dieser Person im genannten Zeitraum (gleiche
Zeiträume wie oben: heute/gestern/Woche/Monat). Passt der Name zu niemandem in den letzten ~5 Wochen, sagt der
Bot das auch so.

**Wochenplan per Chat eintragen**: den fertigen Plan als eine (auch längere) Nachricht schicken, z.B.
„Wochenplan: Montag Anna 10-18, Dienstag Timm 9-17, Mittwoch Anna 10-18" – wird in einzelne Schichten zerlegt
und direkt übernommen. Wochentage ohne explizites Datum beziehen sich automatisch auf die **nächste** Woche
(Montag danach). Taucht ein Name in der Bestätigung mit einer ⚠-Warnung auf, kennt der Bot ihn nicht als
aktiven Mitarbeiter (Tippfehler o.ä.) – trotzdem gespeichert, aber am besten kurz korrigieren. Beim nächsten
iPad-Abgleich erscheinen die Schichten automatisch in der „Deine Schichten"-Übersicht im Kiosk-Fenster der
jeweiligen Person – zählt weiterhin nur als **Planung**, nicht als Ist-Arbeitszeit (dafür stempeln sich die
Mitarbeiter wie gewohnt ein/aus).

**Verfügbarkeit der Mitarbeiter**: Jede Person trägt im eigenen Kiosk-Fenster (nach dem Einstempeln) für die
kommende Woche pro Tag „Kann" (mit Uhrzeit) oder „Kann nicht" ein und sendet es ab. Der Bot sammelt das im
Hintergrund, ohne dich mit einer Nachricht pro Person zu nerven:
- Meldet sich **automatisch**, sobald **alle** aktiven Mitarbeiter für die kommende Woche eingetragen haben.
- Erinnert **freitags morgens** automatisch an alle, die noch fehlen (nur falls Cron Triggers eingerichtet sind,
  siehe oben).
- Jederzeit auf Zuruf abrufbar: `wer kann wann`, `verfügbarkeiten`, `wie sieht die Verfügbarkeit für nächste
  Woche aus` → Übersicht pro Tag, wer kann (mit Uhrzeit) und wer nicht, plus wer noch gar nichts eingetragen hat.

Die Zuteilung selbst („wer arbeitet wann") bleibt bewusst **manuell** – du schickst den fertigen Plan per
Wochenplan-Nachricht (siehe oben), der Bot schlägt nichts automatisch vor.

**Mitarbeiter-Notizen an dich**: Mitarbeiter müssen dafür keinen eigenen Telegram-Zugang haben – sie schreiben
in ihrem eigenen Kiosk-Fenster (nach dem Einstempeln) unter „📝 Notiz an den Chef" eine kurze Nachricht, die
direkt bei dir in Telegram landet (z.B. „Minze bestellen").

**Automatische Erinnerungen (optional):** Richte im Worker unter **Settings → Triggers → Cron Triggers** einen
Trigger mit `0 * * * *` ein (stündlich). Der Bot meldet sich dann von selbst um 8 Uhr morgens (kurze
Tagesübersicht) und um 19 Uhr abends (falls noch Aufgaben offen sind) – Ortszeit Europe/Berlin, DST-sicher. Die
Uhrzeiten stehen als `MORNING_HOUR`/`EVENING_HOUR` ganz oben im Code, falls du sie ändern willst.

Der Bot antwortet immer mit einer klaren Bestätigung, was er wie verstanden/eingetragen hat, z.B.:

```
✅ 2 Aufgaben notiert:
1. Timm – Vitrine putzen
2. Anna – Kasse zählen · 🔴 hoch
```

Sobald das iPad das nächste Mal den Kiosk-Bildschirm zeigt (oder alle 90 Sek., während er schon offen ist),
übernimmt es neue/gelöschte Aufgaben aus der Cloud und lädt umgekehrt auch lokale Änderungen (abgehakt, manuell
angelegt/bearbeitet) wieder hoch – so bleiben Chat und iPad synchron. Unter Admin → Aufgaben gibt es außerdem
eine Übersicht aller zugeordneten Aufgaben, dort lassen sie sich auch manuell anlegen/bearbeiten/löschen.

## Falls etwas nicht funktioniert

- Bot antwortet bei jeder Nachricht mit „⚠ Fehler: ...": meist `ANTHROPIC_API_KEY` (fehlt, falsch, oder kein
  Guthaben mehr) – die Fehlermeldung im Chat zeigt normalerweise direkt an, woran es liegt.
- „liste" zeigt „Aktuell keine Aufgaben hinterlegt", obwohl es welche geben müsste: KV-Bindung im Worker prüfen
  (Schritt 3 – Variable-Name muss exakt `TASKS_KV` heißen).
- App zeigt beim Abgleich einen Fehler: Worker-URL und Zugriffsschlüssel in den Einstellungen prüfen (müssen
  exakt zu Worker-URL bzw. `WEBHOOK_SECRET` passen).
