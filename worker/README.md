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

Der Bot versteht ganz normal formulierte Nachrichten (per KI interpretiert, Modell **Claude Sonnet 5** – versteht
auch komplexere/mehrdeutige Formulierungen deutlich besser als ein kleines Modell) und kennt dabei immer den
aktuellen Stand – der liegt im KV-Speicher, den Bot und App beide direkt lesen/schreiben, unabhängig davon ob das
iPad gerade an ist.

**Frag ihn einfach direkt etwas**: passt eine Nachricht zu keinem der unten aufgelisteten festen Befehle, aber
ist erkennbar eine echte Frage oder Bitte um Einschätzung (z.B. „wieso war der Umschlag diese Woche schlechter",
„vergleich Julis Stunden mit August", „wer wartet noch auf eine Schicht-Bestätigung", „was haben die
Mitarbeiter zuletzt geschrieben"), holt sich der Bot dafür selbst **gezielt genau die Daten**, die er für die
Antwort braucht – bei Bedarf auch mehrere Abfragen nacheinander (z.B. zwei Zeiträume zum Vergleichen). Er hat
dabei Zugriff auf:

| Bereich | Was er abrufen kann |
|---|---|
| Kennzahlen | Umsatz, Lohn, Lohnnebenkosten, Stunden, Umschlag – tagesgenau für jeden Zeitraum |
| Mitarbeiter-Stunden | Stunden/Lohn einer einzelnen Person über einen frei wählbaren Zeitraum |
| Schichtplanung | wer wann fest eingeplant ist, wer sich für was gemeldet hat, was noch auf Bestätigung wartet |
| Mitarbeiterliste | Minijob-Status und Grenze, wer gerade eingestempelt ist, vergessenes Ausstempeln |
| Aufgaben | offene, erledigte oder alle |
| Vorräte | aktueller Stand (Ampel + Mengen) |
| Warenbewegungen | erfasste Lieferungen (Wareneingang) und Verkäufe (Warenausgang) mit Datum und Menge |
| Notizen | was Mitarbeiter aus dem Kiosk an dich geschickt haben |

Basis sind die letzten **ca. 6 Monate**, die die App synchronisiert. **Nichts erfunden oder geschätzt** – was
die Daten nicht hergeben, sagt er ehrlich; wird eine Abfrage zu groß, sagt er das ebenfalls, statt mit
unvollständigen Daten weiterzurechnen. Er merkt sich außerdem die letzten paar Nachrichten des Gesprächs,
Rückfragen wie „und was können wir dagegen tun" funktionieren also im Kontext der vorherigen Antwort.

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
Umsatz heute`, `wie lief die Woche`, `wie war letzte Woche`, `Zusammenfassung diesen Monat` → Umsatz, Trinkgeld,
Lohn, **Lohnnebenkosten** (Arbeitgeberanteil, geschätzter Pauschalsatz – einstellbar unter Admin →
Einstellungen, getrennt nach Minijob/Festangestellt), Lohnkosten gesamt (inkl. Lohnquote vom Umsatz), Stunden
und Umschlag für „heute"/„gestern"/„diese Woche" (ab Montag)/„letzte Woche"/„diesen Monat" **oder einen frei
genannten Zeitraum** (z.B. `vom 1. bis 5. August`, `am 12.08.`), plus – wenn genug Historie da ist – 2-3 kurze,
rein aus den eigenen Zahlen abgeleitete Beobachtungen (klar mit 💡 gekennzeichnet, **keine** Steuer- oder
Finanzberatung). Basis sind die letzten ca. 6 Monate, die die App bei jedem Abgleich mit hochlädt – ein frei
genannter Zeitraum davor liefert entsprechend keine Daten.

**Stunden/Lohn einer einzelnen Person**: `wie viele Stunden hat Anna diese Woche gemacht`, `was hat Timm vom
1. bis 5. August gearbeitet` → Summe der Arbeitsstunden, Lohn und Lohnnebenkosten dieser Person im genannten
Zeitraum (gleiche Zeiträume wie oben, inkl. frei genanntem Datumsbereich). Passt der Name zu niemandem in den
letzten ~6 Monaten, sagt der Bot das auch so.

**Kassenabschluss-Bericht (automatisch)**: sobald ihr in der App einen Tag abschließt, schickt dir der Bot
sofort die komplette Zusammenfassung (Umsatz, Trinkgeld, Lohn/-nebenkosten, Stunden, Umschlag, Aufschlüsselung
pro Person) – nur wenn Kennzahlen freigegeben sind (Schritt 7).

**Ein-/Ausstempeln (automatisch)**: sobald sich jemand am Kiosk ein- oder ausstempelt, bekommst du sofort eine
kurze Nachricht (🟢/🔴) – unabhängig von der Kennzahlen-Freigabe, reicht die normale Telegram-Abgleich-Aktivierung.

**Mitarbeiter-Notizen sammeln**: `nachrichten` (oder „was haben die Mitarbeiter geschrieben") → Liste der
letzten 20 Notizen, die Mitarbeiter dir aus ihrem Kiosk-Fenster geschickt haben, mit Datum und Namen.

**Wochenplan per Chat eintragen**: zwei Varianten, beide gehen in derselben Nachricht auch gemischt/mehrfach.
- Frei mit Uhrzeit, z.B. „Wochenplan: Montag Anna 10-18, Dienstag Timm 9-17" – für Zeiten außerhalb der festen
  Schichten (Aushilfe, Sonderfall).
- Gezielt anhand einer gemeldeten Verfügbarkeit, z.B. „Anna bekommt Montag Früh1" – siehe unten, wie sich das
  mit dem Ausgrauen/der Kaskade verrechnet.

Wochentage ohne explizites Datum beziehen sich automatisch auf die **nächste** Woche (Montag danach). Taucht
ein Name in der Bestätigung mit einer ⚠-Warnung auf, kennt der Bot ihn nicht als aktiven Mitarbeiter
(Tippfehler o.ä.) – trotzdem gespeichert, aber am besten kurz korrigieren. Beim nächsten iPad-Abgleich
erscheinen die Schichten automatisch in der „Deine Schichten"-Übersicht im Kiosk-Fenster der jeweiligen Person
– zählt weiterhin nur als **Planung**, nicht als Ist-Arbeitszeit (dafür stempeln sich die Mitarbeiter wie
gewohnt ein/aus).

**Verfügbarkeit der Mitarbeiter**: Jede Person tippt im eigenen Kiosk-Fenster (nach dem Einstempeln) für die
kommende Woche pro Tag auf **jede Schicht an, die sie übernehmen könnte** (feste Zeitfenster, siehe unten –
bei keiner Präferenz einfach alle antippen) und sendet es ab. Feste Zeitfenster (in `js/store.js` unter
`settings.shiftSlots` hinterlegt, bei Bedarf einfach sagen wenn sich die Zeiten ändern sollen):

| Rolle | Schichten |
|---|---|
| Service / Bar | Früh1 08:30–16:00 (alle Tage) · Früh2 09:30–17:00 (nur Sa/So) · Mittel 10:00–14:00 (alle Tage) · Spät1 15:30–23:00 (Mi-Sa) · Spät2 18:00–23:00 (Mi-Sa) |
| Küche | Früh1 08:00–15:30 (alle Tage) · Früh2 10:00–16:00 (nur Fr/Sa/So) · Mittel 10:00–14:00 (alle Tage) |

Service und Bar teilen sich EINEN Plan und blockieren sich gegenseitig (eine Bar- und eine Service-Person
können nicht beide "Früh1" haben). Küche ist komplett unabhängig davon.

So funktioniert die Zuteilung:
- **Wählt jemand genau EINE Schicht**, ist sie **sofort fest** ihre – für alle anderen (Service+Bar bzw. Küche)
  ab da ausgegraut, direkt im System verbucht (taucht bei ihr unter "Deine Schichten" auf) und an dich
  weitergegeben. Gilt automatisch als **bestätigt**, außer bei "Mittel" (siehe unten).
- **Wählt jemand mehrere**, heißt das "keine Präferenz" – nichts wird ausgegraut, bleibt offen, bis entweder du
  entscheidest oder sich die Auswahl automatisch auf eine reduziert (weil eine der Optionen anderweitig vergeben
  wurde und nur noch eine übrig bleibt – **Kaskaden-Effekt**, kann auch mehrere Personen nacheinander betreffen).
- **"Mittel"-Schichten brauchen IMMER deine explizite Bestätigung**, selbst wenn sie automatisch (Einzelauswahl
  oder Kaskade) fest wurden – erst dann gilt sie als bestätigt.
- **Du weist gezielt zu / bestätigst**: `Anna bekommt Montag Früh1`, `Timm soll Mittwoch die Spät2 machen`,
  `Anna bekommt Montag Mittel` (bestätigt eine bereits gehaltene Mittel-Schicht) – überstimmt alles, auch falls
  die Schicht gerade wem anders fest gehört (die verliert sie dann wieder).
- **Du lehnst ab**: `Annas Mittel-Schicht am Montag ablehnen`, `Timms Früh1 am Mittwoch geht nicht` – die
  Schicht wird ihr entzogen (fällt für andere wieder frei, springt aber niemandem automatisch zu) und sie
  bekommt Bescheid, dass sie sich neu entscheiden muss.
- Die betroffene Person bekommt in beiden Fällen eine **Nachricht** ("📬 Nachricht vom Chef"), die als Pop-up
  erscheint, sobald sie sich das nächste Mal im Kiosk anmeldet.

Der Bot sammelt das im Hintergrund, ohne dich mit einer Nachricht pro Person zu nerven:
- Meldet sich **automatisch**, sobald **alle** aktiven Mitarbeiter für die kommende Woche eingetragen haben.
- Erinnert **freitags morgens** automatisch an alle, die noch fehlen (nur falls Cron Triggers eingerichtet sind,
  siehe oben).
- Jederzeit auf Zuruf abrufbar: `wer kann wann`, `verfügbarkeiten`, `wie sieht die Verfügbarkeit für nächste
  Woche aus` → Übersicht pro Tag und Schicht, wer sich bereit erklärt hat (✅fest = bestätigt, 🔶wartet auf
  Bestätigung = fest, aber noch nicht von dir bestätigt, 🕓Kandidat = hat mehrere Schichten gemeldet, du musst
  noch entscheiden – dafür gibt es auch die Tabelle unter Admin → Schichtplanung zum Antippen), plus wer noch
  gar nichts eingetragen hat.

Sobald jemand seine Verfügbarkeit für die Woche abgeschickt hat, klappt die Auswahl im Kiosk-Fenster zu einer
kompakten Ansicht zusammen (die Schichten stehen weiter oben bei „Deine Schichten"). Für Änderungswünsche gibt
es dort den Button „💬 Chef anfragen für Schichtänderung" – schickt dir eine Notiz und öffnet die Auswahl direkt
wieder für die Person.

**Hinweis zu WhatsApp**: Mitarbeiter-Benachrichtigungen laufen bewusst als In-App-Pop-up im Kiosk, nicht per
WhatsApp – eine WhatsApp-Anbindung bräuchte eine eigene, kostenpflichtige WhatsApp-Business-API-Einrichtung
plus hinterlegte Telefonnummern. Bei Bedarf lässt sich das später ergänzen.

**Mitarbeiter-Notizen an dich**: Mitarbeiter müssen dafür keinen eigenen Telegram-Zugang haben – sie schreiben
in ihrem eigenen Kiosk-Fenster (nach dem Einstempeln) unter „📝 Notiz an den Chef" eine kurze Nachricht, die
direkt bei dir in Telegram landet (z.B. „Minze bestellen").

**Nachrichten an Mitarbeiter (umgekehrte Richtung)**: du schreibst dem Bot z.B. „Sag Anna, sie soll morgen 30
Min früher kommen" oder „Richte allen aus, dass am Montag Inventur ist" (dann bekommt jede aktive Person eine
eigene Nachricht) – landet beim nächsten iPad-Abgleich als Pop-up „📬 Nachricht vom Chef" im Kiosk-Fenster der
jeweiligen Person, sobald sie sich anmeldet. Bewusst kein WhatsApp (siehe Hinweis oben), sondern dasselbe
Pop-up-System wie bei Schicht-Bestätigungen.

**Vorräte (Einkaufsliste)**: Unter Admin → Vorräte legst du die Artikel-Liste an (z.B. Kaffeebohnen, Milch,
Servietten) und pflegst dort auch den Status „Ok" / „Wird knapp" / „Leer" (Mitarbeiter melden das nicht mehr
selbst im Kiosk – die Ampel ist reine Admin-Sache). Du fragst jederzeit `was fehlt` oder `einkaufsliste` ab und
meldest per `Kaffeebohnen sind wieder da` (auch mehrere auf einmal), wenn was nachgekauft wurde – nachsichtiger
Namensvergleich, muss nicht exakt passen.

**Mengengeführte Artikel + Rezepte (intelligenter Bestand)**: Optional kann ein Artikel unter Admin → Vorräte
zusätzlich mit einer Einheit (z.B. „l", „kg", „Stück") und einer Warnschwelle angelegt werden – dann wird nicht
nur die Ampel, sondern der tatsächliche Bestand geführt (Status wird automatisch aus der Menge berechnet).
Unter Admin → Vorräte → Rezepte verknüpfst du ein Verkaufsprodukt (Name wie im SumUp-Bericht, z.B.
„Cappuccino") mit den Zutaten und der Menge pro verkauftem Stück. Damit rechnet das System bei einem
hochgeladenen SumUp-Verkaufsbericht automatisch aus, wie viel von den Zutaten verbraucht wurde – ganz ohne
eigene SumUp-API-Anbindung.

**Lieferschein- oder Verkaufsbericht-Foto**: ein Foto direkt an den Bot schicken (mit oder ohne
Bildunterschrift) – der Bot erkennt per KI-Bilderkennung selbst, um welche Art Beleg es sich handelt:
- **Lieferschein/Rechnung/Bestellung/Auftragsbestätigung** (auch von einem Großhändler wie METRO, auch
  mehrseitig mit vielen Positionen): liest heraus, welche Artikel mit welcher Menge geliefert wurden, gleicht
  sie mit der Vorräte-Liste ab und erhöht bei mengengeführten Artikeln den Bestand entsprechend (sonst nur
  Status zurück auf „Ok"), plus Liefer-Historie (sichtbar unter Admin → Vorräte: „Zuletzt geliefert: Datum ·
  Menge"). Reine Pfand-/Leergut-Zeilen werden dabei ignoriert. Steht auf dem Beleg eine Gebinde-/
  Verpackungsgröße (z.B. „20er" bei einem Kasten Bier), rechnet der Bot das direkt in die tatsächliche
  Stückzahl der Verkaufseinheit um (4 Kästen à 20 Flaschen → 80 Flaschen), NICHT die rohe Bestellmenge (4) –
  sonst würde ein späterer Kassenbericht mit einzeln verkauften Flaschen den Bestand falsch verrechnen. Bei
  Artikeln mit Gebinde-Umrechnung lohnt sich trotzdem ein kurzer Blick unter Admin → Vorräte, ob die Menge
  plausibel aussieht (per „Menge korrigieren" jederzeit manuell anpassbar).
- **SumUp-Verkaufsbericht**: liest heraus, welche Produkte wie oft verkauft wurden, sucht das passende Rezept
  und zieht die entsprechende Zutatenmenge automatisch vom Bestand ab (nur bei Artikeln mit hinterlegtem Rezept
  – ohne Rezept passiert nichts, keine Schätzung).

Es wird **nichts erfunden oder geschätzt** – nur verrechnet, was tatsächlich auf dem Beleg steht bzw. im Rezept
hinterlegt ist. Fotos **und PDF-Dateien** werden beide unterstützt (z.B. eine als PDF exportierte Bestellung);
andere Dateiformate (Word, Excel, …) werden mit einer klaren Fehlermeldung abgelehnt statt stillschweigend
ignoriert. Braucht denselben `ANTHROPIC_API_KEY` wie das Verstehen von Textnachrichten.

**Artikel müssen nicht vorher angelegt sein**: kennt die Vorräte-Liste einen auf dem Beleg erkannten Artikel
noch nicht (auch bei „X ist wieder da"), wird er automatisch neu angelegt statt die Lieferung/Meldung nur als
Warnung zu verwerfen. Bei einer Lieferung mit Menge+Einheit wird der Artikel gleich mengengeführt angelegt
(Warnschwelle testweise auf 20 % der ersten Liefermenge geschätzt – unter Admin → Vorräte jederzeit anpassbar).
Nur bei **Rezepten** geht das nicht automatisch: der Bot kann aus einem Verkaufsbericht nicht wissen, wie viel
Milch/Kaffee etc. in einem „Cappuccino" stecken – das musst du einmalig unter Admin → Vorräte → Rezepte
eintragen, danach rechnet das System jeden weiteren Verkauf automatisch dagegen.

**Automatische Erinnerungen (optional):** Richte im Worker unter **Settings → Triggers → Cron Triggers** einen
Trigger mit `0 * * * *` ein (stündlich). Der Bot meldet sich dann von selbst:
- **Täglich um 8 Uhr**: kurze Tagesübersicht der Aufgaben.
- **Täglich um 19 Uhr**: falls noch Aufgaben offen sind.
- **Freitags**: wer für die kommende Woche noch keine Verfügbarkeit eingetragen hat.
- **Montags**: Wochenrückblick (Umsatz/Lohnkosten/Stunden der letzten Woche + kurze, aus bis zu ~2 Monaten
  Historie abgeleitete Beobachtungen für längerfristige Muster) – nur wenn Kennzahlen freigegeben sind (siehe
  oben).
- **Täglich, einmalig pro Monat und Person**: Warnung, sobald ein Minijobber 85% seiner Verdienstgrenze erreicht
  hat – nur wenn Kennzahlen freigegeben sind (die Minijob-Grenze selbst steht am Mitarbeiter, Admin → Mitarbeiter).
- **Täglich, einmalig pro Tag und Person**: Hinweis, falls eine PIN-Schicht aus einem vergangenen Tag noch offen
  ist (vermutlich vergessenes Ausstempeln).

Ortszeit Europe/Berlin, DST-sicher. Die Uhrzeiten stehen als `MORNING_HOUR`/`EVENING_HOUR` ganz oben im Code,
falls du sie ändern willst.

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
