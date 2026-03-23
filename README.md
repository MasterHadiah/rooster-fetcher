# Rooster Fetcher

Haalt automatisch jouw rooster op uit **Eduflex** en **Magister**, combineert ze tot één `rooster.json`, en committe dat bestand elke 30 minuten naar deze repository. Je startpagina leest dat JSON-bestand rechtstreeks uit.

---

## Instellen (éénmalig, ~15 minuten)

### Stap 1 — Repository aanmaken

1. Ga naar [github.com](https://github.com) en maak een **nieuwe repository** aan.
   - Naam: bijv. `rooster-fetcher`
   - Zichtbaarheid: **Public** (zodat `raw.githubusercontent.com` bereikbaar is)
2. Upload alle bestanden uit deze map naar de repo (of gebruik `git push`).

---

### Stap 2 — Secrets instellen

De wachtwoorden worden als versleutelde **Secrets** opgeslagen, nooit in de code.

1. Open je repo op GitHub
2. Ga naar **Settings → Secrets and variables → Actions**
3. Klik **New repository secret** voor elk van de volgende:

| Secret naam       | Waarde                                        |
|-------------------|-----------------------------------------------|
| `EDUFLEX_USER`    | Jouw Eduflex gebruikersnaam                   |
| `EDUFLEX_PASS`    | Jouw Eduflex wachtwoord                       |
| `MAGISTER_SCHOOL` | Subdomein van jouw school (bijv. `mijnschool` als de URL `mijnschool.magister.net` is) |
| `MAGISTER_USER`   | Jouw Magister gebruikersnaam                  |
| `MAGISTER_PASS`   | Jouw Magister wachtwoord                      |

---

### Stap 3 — Eerste run starten

1. Ga naar **Actions** in je repository
2. Klik op de workflow **"Rooster ophalen"**
3. Klik **"Run workflow"** (blauwe knop rechts)
4. Na ~2 minuten verschijnt `rooster.json` in je repo

Vanaf dan draait de workflow automatisch elke 30 minuten op weekdagen (06:00–18:00 Nederlandse tijd).

---

### Stap 4 — Startpagina aanpassen

Kopieer de inhoud van `startpagina-snippet.html` naar je `index.php` (of `index.html`) op InfinityFree.

Pas deze twee regels bovenin het script aan:

```js
const GITHUB_USER = 'JOUW_GITHUB_GEBRUIKERSNAAM';
const REPO_NAAM   = 'rooster-fetcher';   // of wat je ook hebt gekozen
```

---

## Eduflex selectors aanpassen

De Eduflex-scraper gebruikt CSS-selectors om de roostertabel te parsen. Als er niets opgehaald wordt maar het inloggen lukt, is de kans groot dat de selector-namen niet overeenkomen met de HTML van jouw schoolinstallatie.

**Om te debuggen:**
1. Open de roosterpagina in Chrome
2. Rechtermuisklik op een les → "Inspecteren"
3. Noteer de class-namen van de les-cel, het vak, de tijd, het lokaal
4. Pas die aan in `scripts/eduflex.js` in de `page.evaluate()` functie

---

## Structuur van rooster.json

```json
{
  "bijgewerkt": "2026-03-23T07:30:00.000Z",
  "totaal": 14,
  "afspraken": [
    {
      "vak": "Wiskunde",
      "tijd": "08:30 - 10:00",
      "lokaal": "B104",
      "groep": "5VWO-A",
      "datum": "ma 23-03-2026",
      "startISO": "2026-03-23T07:30:00.000Z",
      "eindISO": "2026-03-23T09:00:00.000Z",
      "bron": "magister"
    }
  ],
  "fouten": {
    "eduflex": null,
    "magister": null
  }
}
```

---

## Later toevoegen: Outlook/Teams

Zodra je Eduflex + Magister werken, kun je Outlook-kalenderitems toevoegen via de **Microsoft Graph API**. Dat vereist eenmalig akkoord van je school-IT-beheerder. Neem contact op als je dat wilt uitbreiden.
