# Tape

Web, na kterém boti denně zapisují poznatky z ICT obsahu (včetně kanálu ICT Gems), ladí scalpingový model pro NQ a ES a připravují lekce pro začátečníky. Běží na GitHub Pages z větve `main`.

Vzdělávací projekt, žádné investiční doporučení. Model zatím v backtestu nevydělává.

## Soubory

- `index.html` – celá stránka (vzhled, obrázky, logika). Data čte ze složky `data/`.
- `course.json` – dvanáctitýdenní kurz v sekci Dictator's Room.
- `strategy.txt` – Pine Script strategie pro TradingView.
- `data/core.json` – `state`, `model`, `bots`, `versions`, `backtests`.
- `data/insights.json` – poznatky botů.
- `data/concepts.json` – pojmy s vysvětlením a obrázkem.
- `data/lessons.json` – denní lekce.
- `data/glossary.json` – slovníček.
- `data/priceaction.json` – témata „Price action v obrázcích“ v Lauřině prostoru, skládaná krok za krokem. Denní běh botů je nemění.

## Data format (for the daily bot run)

All texts are Czech. Every file is valid JSON; arrays hold objects with a unique `id`.

- `core.json`
  - `state`: `{lastRun ISO, runCount, modelVersion}`
  - `model`: `{version, name, market, timeframe, status: untested|testing|validated|failing, summary, rules: [{title, detail}], params: [{name, value, why}]}`
  - `bots`: `[{id: skaut|gems|architekt|ucitel, order, name, role, lastRun ISO, lastReport}]`
  - `versions`: `[{id, version, ts, date, change, reason}]`
  - `backtests`: `[{id, ts, modelVersion, symbol, period, trades, winrate, pf, dd, note}]` – written only from the user's own backtests.
- `insights.json`: `[{id: YYYYMMDD-NN, ts ISO, date, bot, title, source, url, simple, takeaway, effect, concept, viz?}]`
  - `concept` is the `id` of an entry in `concepts.json` (required).
  - `simple` is one or two plain sentences for a complete beginner (required).
  - `viz` (optional bar chart for comparable numbers): `{unit, signed, caption, ref: {value, label}, items: [{label (max 40 chars), value, c: accent|amber|good|bad|muted}]}` with 2–6 items.
- `concepts.json`: `[{id, order, title, en, explain: [2 paragraphs], remember, week (1–12), caption, fig | chart}]`
  - `fig` is a built-in figure: `ohlc, timeframe, struktura, mss, sweep, fvg, premium-discount, order-block, cas, bias, model, riziko, split, nahoda, volatilita`.
  - `chart` is a schematic candle chart: `{h (140–260), candles: [[open, high, low, close] | null], marks: [{t: "line", y, x1, x2, c, dash} | {t: "box", x1, x2, y1, y2, c} | {t: "arrow", x1, y1, x2, y2, c} | {t: "text", x, y, s, c, a: start|middle|end, dy}]}`; `x` is the zero-based candle index, `y` a price on the candles' scale. Keep it to 8–14 candles and 2–5 marks.
- `lessons.json`: `[{id: YYYYMMDD-LNN, ts, date, n, week, title, body: [3–5 paragraphs], example, remember, terms: [glossary ids], quiz: [{q, options: [3], correct (zero-based), why}]}]`
- `glossary.json`: `[{id (ascii slug), term, en, def, week, cat}]` where `cat` is one of `zaklady, struktura, likvidita, mezery, bloky, cas, modely, praxe`. Check the list before adding a term so nothing is duplicated.
- `priceaction.json`: `[{id, title, en, week, intro, h, lo, hi, candles: [[open, high, low, close]], steps: [{show, text, focus?, add: [marks]}], remember}]`
  - A step shows the first `show` candles; `focus` lists candle indexes that stay bright while the rest are dimmed. Marks stay for later steps unless they carry `ttl` (number of steps they remain visible).
  - Marks: `line` (`y, x1, x2, c, dash, label, la: start|middle|end|left|right, lv: above|below`), `box` (`x1, x2, y1, y2, c, label, la: start|middle|end, lv: top|bottom|above|below|middle`), `text` (`x, y, s, c, a, dy`), `badge` (`x, y, s, dy`), `path` (`pts: [[x, y]]`, e.g. a structure line through swing points), `span` (`x, y1, y2, c, label` – a vertical measure), `arrow` (`x1, y1, x2, y2, c, bend`). Colours: `accent|amber|good|bad|muted|ink`.
  - The file is generated; keep label positions clear of candles and check every step on a phone-width screen before committing.
- `ideas.json`: `[{id (ascii slug), ts, date, title, area: vyuka|denik|model|vzhled|produkt|data, value: 1–3, effort: 1–3, status: new|picked|building|done|dropped, what, why}]`
  - Written by the Vizionář bot. `what` says concretely what would be built, `why` what it changes for the user. Only the owner changes `status` (through Claude in chat).
- `practice.json`: `[{id, topic, q, answer: [candle indexes], explain, reveal: [marks], candles, h, lo, hi}]` – tasks for "Najdi to na grafu". Generated together with `priceaction.json`; the daily bot run does not change it.

## Co je uložené jen v prohlížeči (boti na to nesahají)

- `knot-journal`: obchodní deník (`trades`) a denní plány (`plans`).
- `knot-activity`: dny, kdy byl uživatel aktivní (série).
- `ictlab-laura`: postup v lekcích, kartičky (`cards`) a zkoušky týdne (`exam`).
- Zkouška týdne se skládá z pojmů v `data/glossary.json` podle pole `week`. Každý nový pojem proto musí mít `week` 1–12 a `cat`.
- `sw.js` zajišťuje práci offline. Boti ho nemění. Další klíče v prohlížeči: `knot-profile` (úvodní průvodce), `knot-minutes` (denní cíl), IndexedDB `tape` (obrázky k obchodům).

## data/news.json (bot Zpravodaj)

```
{"updated": "ISO čas", "events": [{"date": "RRRR-MM-DD", "time": "HH:MM pražského času", "title": "", "impact": 1-3, "note": ""}],
 "posts": [{"date": "RRRR-MM-DD", "who": "", "text": "shrnutí vlastními slovy, žádná citace", "source": "název webu", "url": "https://…", "impact": 1-3}]}
```
`events` jsou plánovaná data a události pro americké indexy na 3 až 4 týdny dopředu, minulé se mažou. `posts` je nejvýš 8 nejnovějších výroků, které pohnuly trhem. Jen ověřené zdroje, neutrálně, bez hodnocení politiků.

## data/study.json

Průvodci v sekci Studium: `model2022` (kroky modelu) a `core` (dvanáct měsíců core contentu). Boti ho nemění.

## Deník a nastavení (verze s kartami Dnes, Obchody, Statistiky, Playbook)

- `tape-settings`: režim (obchodník nebo student), setupy, chyby, účty s pravidly prop firmy, jednotka, poplatek, cíle procesu, skryté karty přehledu.
- `tape-coach-chat`: rozhovor s koučem. `tape-key`: API klíč kouče, nikdy se nezálohuje.
- Obchod v `knot-journal` má navíc pole `tsx`, `qty`, `usd`, `fee`, `acct`, `tp1`, `tp1pct`, `mae`, `mfe`, `emo`, `grade`, `missed`, `levels`, `shots` (počet obrázků, klíče v IndexedDB jsou `id#0` až `id#2`).
- `data/priceaction.json` obsahuje i témata `model-2022-long` a `model-2022-short`. Generuje se skriptem mimo repozitář, boti ho nemění.

- `data/site.json` řídí stěhování na novou adresu (`move`, `from`). Boti ho nemění. `tape-posts` v prohlížeči jsou příspěvky komunity.
- Událost v `data/news.json` může mít volitelné pole `markets` (například `["NQ","MNQ"]`). Bez něj se výsledky firem ("Výsledky …") ukazují jen těm, kdo obchodují NQ nebo MNQ.
- Každé téma v `data/priceaction.json` má navíc `traps` (dvě časté záměny) a `check` (kontrolní otázka). Doplňuje je skript mimo repozitář.
- `data/premium.json` jsou grafy pro sekci Premium. Boti ho nemění.
- `tape-levels.txt` je indikátor pro TradingView (Pine v6). Boti ho nemění.

## Denní studium (běží z chatu, dokud naplánovaná úloha neumí ukládat)

Kromě šesti botů se každý den dělá i studium Zeussyho přístupu: veřejná vlákna, veřejná shrnutí přednášek a rozbory obchodů. Nové poznatky se zapisují do `data/insights.json` s `bot: "skaut"` a konceptem `cas` nebo jiným vhodným, vždy vlastními slovy a s odkazem. Placený obsah se nepřebírá.

## Účet a synchronizace

Přihlášení a ukládání dat k účtu běží přes Supabase (adresa projektu a veřejný klíč jsou v `index.html` v objektu `SB`; tajný klíč do repozitáře nepatří). Každý člověk má jeden řádek v tabulce `public.tape_data` (`user_id`, `data` jsonb, `updated_at`) chráněný pravidly RLS. Do účtu jdou klíče z `SYNC_KEYS`; obrázky (IndexedDB), `tape-key` a `tape-coach-chat` zůstávají v zařízení. Stav přihlášení je v `tape-auth`, stav synchronizace v `tape-sync`.
