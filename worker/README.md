# Telegram-Aufgaben-Bot einrichten

Damit du Aufgaben per Telegram-Nachricht statt am iPad eintragen kannst. Dauert insgesamt ca. 10–15 Minuten,
einmalig. Der Code (`telegram-bot.js`) ist fertig – du musst ihn nur an den richtigen Stellen einfügen und
ein paar Werte eintragen.

## 1. Telegram-Bot erstellen (2 Min.)

1. In Telegram nach **@BotFather** suchen, Chat öffnen.
2. `/newbot` senden, Namen und Nutzernamen vergeben (Nutzername muss auf `bot` enden, z.B. `CafeAufgabenBot`).
3. BotFather schickt dir einen **Token** (lange Zeichenkette wie `123456789:AAF...`). Kopieren, brauchst du gleich.

## 2. Cloudflare Worker anlegen (5 Min.)

1. Auf [dash.cloudflare.com](https://dash.cloudflare.com) kostenlos registrieren (keine Kreditkarte nötig).
2. Links **Workers & Pages** → **Create** → **Create Worker**. Namen vergeben (z.B. `cafe-telegram-bot`), erstellen.
3. Im Worker auf **Edit Code** (Quick Edit), kompletten Inhalt von [`telegram-bot.js`](telegram-bot.js) aus diesem
   Ordner reinkopieren (vorhandenen Beispielcode ersetzen). **Deploy** klicken.
4. Merke dir die Worker-URL (steht oben, z.B. `https://cafe-telegram-bot.deinname.workers.dev`).

## 3. Secrets/Variablen im Worker setzen

Im Worker unter **Settings → Variables and Secrets** folgende **Secrets** (verschlüsselt) anlegen:

| Name | Wert |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Token von @BotFather aus Schritt 1 |
| `WEBHOOK_SECRET` | ein frei erfundenes, langes Passwort (nur du brauchst es) |
| `GITHUB_TOKEN` | derselbe Fine-grained Token wie fürs App-Backup (Contents: Read and write, nur dieses Repo) – falls noch keiner existiert: [hier erstellen](https://github.com/settings/personal-access-tokens/new) |
| `GITHUB_OWNER` | dein GitHub-Nutzername |
| `GITHUB_REPO` | `PersoOrga-co` |
| `OWNER_CHAT_ID` | **erstmal leer lassen** – kommt in Schritt 5 |
| `ANTHROPIC_API_KEY` | API-Key von [console.anthropic.com](https://console.anthropic.com/settings/keys) (eigener, kostenpflichtiger Account nötig – Kosten sind bei diesem Nachrichtenaufkommen aber minimal, Bruchteile eines Cents pro Nachricht). Fehlt der Key oder ist die API mal nicht erreichbar, erkennt der Bot Aufgaben trotzdem noch über einfachere Textmuster – nur weniger flexibel. |

## 4. Telegram-Webhook registrieren (einmaliger Aufruf)

Diesen Link im Browser öffnen (Werte ersetzen: `<TOKEN>` = Bot-Token, `<WORKER_URL>` = URL aus Schritt 2,
`<WEBHOOK_SECRET>` = das Passwort aus Schritt 3):

```
https://api.telegram.org/bot<TOKEN>/setWebhook?url=<WORKER_URL>&secret_token=<WEBHOOK_SECRET>
```

Antwort sollte `"ok":true` enthalten.

## 5. Eigene Chat-ID herausfinden

1. In Telegram eine beliebige Nachricht an deinen neuen Bot schicken (z.B. „Hallo").
2. Der Bot antwortet mit: „Setup: Deine Chat-ID ist 123456789. Bitte als OWNER_CHAT_ID-Secret hinterlegen."
3. Diese Zahl als `OWNER_CHAT_ID`-Secret im Worker eintragen (Schritt 3, Tabelle).

Ab jetzt reagiert der Bot **nur noch auf Nachrichten von dir** – alle anderen werden stillschweigend ignoriert.

## 6. In der App aktivieren

App → Admin → Einstellungen:
- GitHub-Backup-Felder ausfüllen, falls noch nicht geschehen (Nutzername, Repo, Token – derselbe Token wie in
  Schritt 3 funktioniert).
- Häkchen bei „Telegram-Aufgaben abholen aktivieren" setzen.

## Nutzung

Der Bot versteht ganz normal formulierte Nachrichten (per KI interpretiert). Er kennt dafür immer den aktuellen
Stand (was gerade an Aufgaben existiert, welche Mitarbeiter es gibt) – die App lädt diesen Stand bei jedem
Sync nach `data/state-snapshot.json` hoch, der Bot liest ihn vor jeder Antwort neu.

**Aufgaben anlegen** – auch mehrere auf einmal, auch an verschiedene Personen:
- `Kaffeemaschine reparieren lassen` → allgemeine Aufgabe für heute.
- `Timm: Kasse nachzählen` oder `Arianna soll die Vitrine putzen` → Aufgabe für die genannte Person (muss zu
  einem aktiven Mitarbeiter passen, sonst bleibt sie unzugeordnet).
- `Anna soll dran denken, Montag ist Inventur` → landet automatisch am Montag statt heute.
- „Das ist dringend" / „priorisieren" → Priorität „hoch"; „kann warten" / „niedrig" → Priorität „niedrig".
- `Timm soll die Vitrine putzen und Anna soll die Kasse zählen` → wird in **zwei** getrennte Aufgaben zerlegt,
  auch bei längeren, frei formulierten Nachrichten mit mehreren Themen.

**Aufgaben ansehen:** `liste`, `was steht noch an`, `zeig mir alles offene` → antwortet mit der aktuellen
Übersicht, gruppiert nach Tag, inkl. Zeitstempel wie aktuell der Stand ist.

**Aufgaben löschen:** in eigenen Worten beschreiben, was weg soll, z.B. `lösch die Aufgabe Kasse zählen bei
Anna` oder `entfern die Inventur-Aufgabe von Timm am Montag`. Der Bot sucht in der aktuellen Liste nach einem
eindeutigen Treffer und bestätigt, was entfernt wird.

Der Bot antwortet immer mit einer klaren Bestätigung, was er wie verstanden/eingetragen hat, z.B.:

```
✅ 2 Aufgaben notiert:
1. Timm – Vitrine putzen
2. Anna – Kasse zählen · 🔴 hoch
```

Neue/gelöschte Aufgaben wirken sich spätestens beim nächsten Öffnen des Kiosk-Bildschirms bzw. innerhalb von
90 Sekunden aus, falls er schon offen ist – „liste" zeigt dabei immer den Stand vom letzten Sync (Zeitstempel
steht mit dabei). Unter Admin → Aufgaben gibt es außerdem eine Übersicht aller zugeordneten Aufgaben, dort
lassen sie sich auch manuell anlegen/bearbeiten/löschen.

## Falls die KI-Aufteilung mal wieder nicht funktioniert

Antwortet der Bot bei jeder Nachricht mit „⚠ Fehler: ..." oder kopiert er wieder nur den ganzen Text als eine
Aufgabe, meist liegt es an `ANTHROPIC_API_KEY` (fehlt, falsch, oder kein Guthaben mehr auf dem Anthropic-Konto).
Die Fehlermeldung im Chat zeigt normalerweise direkt an, woran es liegt.
