# claude-external-review

**Autor: Dawid Góraj** · [github.com/dawidgoraj1-alt](https://github.com/dawidgoraj1-alt)

Skill dla [Claude Code](https://claude.com/claude-code), który automatycznie (przez hooki)
zleca niezależną recenzję **specyfikacji**, **planu implementacji** i **kodu** modelowi
OpenAI uruchamianemu przez [Codex CLI](https://github.com/openai/codex) w trybie headless.
Claude odsiewa fałszywe alarmy i pokazuje listę poprawek — Ty decydujesz, które wprowadzić.

> **Prywatność — przeczytaj przed instalacją.** Codex dostaje dostęp do **całego projektu**
> (sandbox `workspace-write`, bez list wykluczeń), więc jego zawartość — **łącznie
> z ewentualnymi sekretami** (klucze, hasła, pliki `.env`) — może zostać przeczytana
> i wysłana do OpenAI. Nie włączaj tego skilla w projektach, których nie chcesz tam wysyłać
> (patrz [Prywatność](#prywatność)).

## Jak to działa

1. Pracujesz z Claude Code normalnie. Hooki (`UserPromptSubmit`, `PostToolUse`, `Stop`)
   śledzą, które pliki zmienił Claude.
2. Na końcu tury hook `Stop` wykrywa zmiany w specyfikacji, planie lub kodzie (kod — od progu
   `codeMinChangedLines` zmienionych linii) i uruchamia `codex exec`. Pasek stanu pokazuje
   „Codex recenzuje…”.
3. Claude sprawdza każdą uwagę w prawdziwym pliku, odsiewa fałszywe alarmy (pokazuje je
   z uzasadnieniem) i przedstawia numerowaną listę poprawek po polsku.
4. Odpowiadasz, które wprowadzić. Wprowadzone poprawki wracają do recenzji (maks.
   `maxReviewRounds` rund na plik; każda runda wymaga Twojej decyzji).

Awaria Codexa nigdy nie blokuje pracy — dostajesz ostrzeżenie, a zmiany nie przepadają.
Skill nigdy nie wprowadza poprawek bez Twojej zgody.

## Wymagania

- **Node.js ≥ 20** (bez zależności npm),
- **git**,
- **Codex CLI** zainstalowany i **zalogowany**,
- dostęp Twojego konta Codex do modelu (domyślnie `gpt-6-sol`; inaczej patrz niżej).

## Instalacja w Claude Code

Krok po kroku, także dla osoby, która nie robiła tego wcześniej.

### 1. Sprawdź wymagania

W terminalu uruchom:

```
node --version
git --version
codex --version
codex login status
```

- `node --version` musi pokazać wersję **20 lub nowszą** (np. `v22.4.0`).
- Brak `codex`? Zainstaluj Codex CLI według [instrukcji projektu](https://github.com/openai/codex).
- `codex login status` musi pokazać, że jesteś zalogowany. Jeśli nie — wykonaj `codex login`
  i postępuj według instrukcji w przeglądarce.

### 2. Pobierz repozytorium

```
git clone https://github.com/dawidgoraj1-alt/claude-external-review.git
cd claude-external-review
```

Sklonuj je do **zwykłego folderu** (np. `~/projekty`), **nie** do `~/.claude/skills`.
Instalator kopiuje skill do `~/.claude/skills/external-review/` i odmówi pracy, jeśli
źródło i cel się nakładają — klon w katalogu skilli zostałby wymazany przy podmianie plików.

### 3. Uruchom instalator

```
node install.mjs
```

Możesz to zrobić też z poziomu sesji Claude Code, wpisując w promptcie:

```
! node install.mjs
```

(`!` uruchamia polecenie powłoki bezpośrednio, a jego wynik trafia do rozmowy). Polecenie działa w katalogu roboczym sesji — uruchom Claude Code w katalogu klonu albo podaj pełną ścieżkę: `! node "<ścieżka do klonu>/install.mjs"`.

Instalator sprawdza wymagania, robi próbne wywołanie Codexa i dopiero wtedy zmienia pliki.
Jeśli model `gpt-6-sol` nie jest dostępny na Twoim koncie, wybierz inny:

```
node install.mjs --model <nazwa>          # konkretny model
node install.mjs --codex-default-model    # domyślny model Twojego Codexa
```

Instalator kopiuje skill do `BASE/skills/external-review/` (gdzie `BASE` to
`$CLAUDE_CONFIG_DIR` lub `~/.claude`), zapisuje wybrany model i ścieżkę Codexa w
`BASE/external-review/config.local.json` i dopisuje hooki do `BASE/settings.json`
(robiąc kopię `settings.json.bak-<timestamp>`; Twoje inne hooki zostają nietknięte).
Jeśli `settings.json` jest dowiązaniem symbolicznym (np. dotfiles/stow), instalator zapisuje
plik docelowy dowiązania, a samo dowiązanie zostaje.

### 4. Zrestartuj Claude Code

Hooki są wczytywane przy starcie sesji — zamknij Claude Code i uruchom go ponownie.

### 5. Pierwsze użycie

Pracuj jak zwykle. Gdy Claude zmieni spec, plan albo wystarczająco dużo kodu, na końcu tury
zobaczysz spinner „Codex recenzuje…” (może trwać do kilkunastu minut). Potem Claude pokaże:

```
## Recenzja Codex — kod (src/app.js, runda 1)
### Proponowane poprawki
1. [krytyczna] src/app.js:42 — … → …
### Odrzucone jako fałszywe alarmy
2. [drobna] src/app.js:10 — … — odrzucam, bo …
Które poprawki wprowadzić? („1, 3”, „wszystkie”, „żadne”, „zakończ recenzję”)
```

Odpowiedz:

- `1, 3` — wprowadź wskazane poprawki,
- `wszystkie` — wszystkie z sekcji „Proponowane poprawki”,
- `żadne` — nic nie zmieniaj, uwagi zostają zamknięte,
- `zakończ recenzję` — wprowadź ewentualnie wybrane i zakończ bez kolejnej rundy.

### 6. Użycie ręczne

- `/external-review-help` — wyświetl wszystkie komendy, odpowiedzi, opcje instalatora i konfiguracji,
- `/external-review --pending` — pokaż niezałatwione uwagi z poprzednich recenzji,
- `/external-review <ścieżki>` — zrecenzuj wskazane pliki (z pominięciem progów i limitu rund),
- `/external-review` — w repozytorium git zrecenzuj wszystkie zmienione pliki kodu
  (poza gitem podaj ścieżki).

Jawnie wskazane pliki są recenzowane mimo `ignorePatterns`/`ignoreDirs` (kto podaje plik, chce go
zrecenzować; `.md` poza specyfikacjami i planami idzie jako kod). Pliki binarne i ponad limit
rozmiaru są pomijane z ostrzeżeniem. Claude zawsze pokazuje ostrzeżenia i odróżnia „Codex
przejrzał pliki — brak uwag” od „Nic nie zostało zrecenzowane”. Recenzja trwa zwykle kilka minut
(najdłużej ok. 8); przy błędzie Codexa (kod 1) Claude pokaże błąd i zaproponuje ponowienie.

### 7. Aktualizacja

```
cd claude-external-review
git pull
node install.mjs
```

Instalator jest idempotentny: podmienia skill i nie duplikuje hooków; Twoje
`config.local.json` zostaje. Nowa wersja jest najpierw kopiowana obok i sprawdzana; jeśli
kopiowanie lub podmiana się nie uda, poprzednia instalacja zostaje nienaruszona.

### 8. Deinstalacja

```
node install.mjs --uninstall           # usuwa hooki i katalog skilla
node install.mjs --uninstall --purge   # dodatkowo stan i config.local.json
```

### 9. Rozwiązywanie problemów

- **Codex niezalogowany** — instalator przerwie z komunikatem; wykonaj `codex login`
  i uruchom instalator ponownie. Jeśli logowanie wygaśnie później, recenzja zakończy się
  ostrzeżeniem. Pojedyncza awaria jest ponawiana przy następnym zatrzymaniu (Stop); dopiero po co najmniej 2 kolejnych nieudanych uruchomieniach recenzje są wstrzymywane na `failureBackoffMin` minut od ostatniej awarii. Każdy sukces zeruje licznik.
- **Model niedostępny** — zainstaluj ponownie z `--model <nazwa>` lub
  `--codex-default-model`, albo zmień `model` w `config.local.json`.
- **Recenzja trwa zbyt długo / hook przekroczył czas** — Esc przerywa oczekiwanie; zmiany
  nie przepadają i trafią do kolejnej recenzji. Limity: `codexTimeoutSec` (jedno wywołanie)
  i `hookTimeoutSec` (cały hook; instalator ustawia go także we wpisie hooka Stop — po zmianie `hookTimeoutSec` w `config.local.json` uruchom ponownie `node install.mjs`, inaczej limit hooka Stop się nie zmieni).
- **Wyłączenie skilla** — w `BASE/external-review/config.local.json` ustaw
  `"enabled": false` (bez odinstalowywania). To przełącznik **globalny** — dotyczy wszystkich projektów, nie ma opcji per projekt. Wyłącza to automatyczną recenzję i śledzenie zmian (hooki niczego nie zapisują); ręczne `/external-review` nadal działa.
- **Nie znaleziono polecenia Codexa** — recenzja jest pomijana z ostrzeżeniem (raz na sesję), a pliki czekają na recenzję. Zainstaluj Codex CLI lub popraw `PATH` i uruchom ponownie `node install.mjs` (zapisuje `codexPath`).
- **Brak reakcji po instalacji** — upewnij się, że zrestartowałeś Claude Code.

## Konfiguracja

Domyślne wartości są w `config.json` skilla; własne nadpisania wpisz do
`BASE/external-review/config.local.json` (płytkie scalenie, tablice zastępowane w całości):

```json
{
  "enabled": true,
  "model": "gpt-6-sol",
  "reasoningEffort": "medium",
  "codeMinChangedLines": 20,
  "maxReviewRounds": 3
}
```

| Klucz | Domyślnie | Znaczenie |
|-------|-----------|-----------|
| `enabled` | `true` | wyłącznik automatycznej recenzji i śledzenia zmian (wszystkie hooki); ręczne `/external-review` działa nadal |
| `codexPath` | `null` | ścieżka Codexa (instalator ją zapisuje; `null` = szukaj w PATH) |
| `model` | `"gpt-6-sol"` | model Codexa |
| `reasoningEffort` | `"medium"` | `model_reasoning_effort` |
| `codexSandbox` | `"workspace-write"` | sandbox Codexa |
| `ignoreUserConfig` | `true` | Codex ignoruje Twój `config.toml` |
| `codexConfigOverrides` | `[]` | dodatkowe `-c klucz=wartość` dla Codexa |
| `codexTimeoutSec` | `600` | limit jednego wywołania Codexa |
| `hookTimeoutSec` | `900` | limit całego hooka Stop |
| `failureBackoffMin` | `10` | wstrzymanie recenzji po co najmniej 2 kolejnych awariach (liczone od ostatniej) |
| `codeMinChangedLines` | `20` | próg zmian kodu uruchamiający recenzję |
| `maxReviewRounds` | `3` | maks. rund recenzji na plik |
| `maxReviewBytes` | `204800` | maks. rozmiar materiału na wywołanie |
| `maxChunks` | `3` | maks. części, na które dzielony jest materiał |
| `specPatterns` | `**/specs/**/*.md`, `**/*-design.md`, `**/*-spec.md`, `**/spec.md` | pliki traktowane jako specyfikacje |
| `planPatterns` | `**/plans/**/*.md`, `**/*-plan.md`, `**/plan.md` | pliki traktowane jako plany |
| `ignorePatterns` | `**/*.md`, `**/*.log`, `**/package-lock.json`, `**/yarn.lock`, `**/pnpm-lock.yaml`, `**/.coverage` | pliki pomijane w recenzji kodu |
| `ignoreDirs` | `node_modules`, `.git`, `dist`, `build`, `coverage`, `__pycache__`, `.pytest_cache`, `.venv`, `.next`, `target` | katalogi pomijane |

## Podgląd pracy Codexa

Gdy Codex recenzuje (hook Stop albo ręczne `/external-review`), w linii statusu Claude Code
możesz zobaczyć, co robi:

```
⟳ Codex · kod (3 pliki) · 1:12 · czyta stop.mjs · 18k tok
```

Widać etapy (specyfikacja, plan, kod), liczbę plików, czas, bieżącą czynność i zużyte tokeny.
Skill zapisuje postęp w `BASE/external-review/live/` (jeden mały plik na działający proces,
usuwany po recenzji; nieodświeżany plik starszy niż 15 s jest ignorowany), a segment czyta ten
katalog bez gita i bez przeszukiwania projektu. Gdy nic nie działa, segment jest pusty.

Włączenie (jeśli nie masz jeszcze własnej linii statusu):

```
node install.mjs --statusline
```

Instalator wpisuje wtedy `statusLine` z `"refreshInterval": 1` (Claude Code odświeża linię co
sekundę, także w trakcie długiego hooka Stop). Jeśli masz już własny `statusLine`, instalator go
nie zmienia, tylko wypisuje wpis do wklejenia; zwykła instalacja (bez `--statusline`) nigdy nie
rusza `statusLine`. `--uninstall` usuwa `statusLine` tylko wtedy, gdy jest nasz.

Własna linia statusu — dołącz segment w Node:

```js
import { codexSegment } from '<BASE>/skills/external-review/statusline.mjs';
const seg = codexSegment(workspaceDir); // '' gdy Codex nic nie robi
```

albo uruchom skrypt `node "<BASE>/skills/external-review/statusline.mjs"` z tym samym JSON-em
ze stdin, który dostaje Twoja linia statusu (czyta `workspace.current_dir`), i dołącz jego
wyjście. Ustaw `"refreshInterval": 1` w swoim `statusLine`, inaczej segment nie będzie się
odświeżał w trakcie recenzji.

Uwaga: tekst „Codex recenzuje…” obok spinnera pochodzi z Claude Code i hooki nie mogą go zmienić;
żywy postęp jest dlatego w linii statusu.

## Koszty i limity

Każda recenzja to wywołania Codexa, które zużywają Twój limit/środki OpenAI:

- do `3 × maxChunks` wywołań na jedno zatrzymanie (Stop) — po jednym na etap
  (spec, plan, kod), każde dzielone na maks. `maxChunks` części;
- każda runda poprawek to kolejna recenzja; maks. `maxReviewRounds` kolejnych rund z uwagami
  na plik (recenzja bez uwag do pliku lub odpowiedź „żadne” bez zmian w pliku zeruje licznik);
- kod jest recenzowany dopiero od `codeMinChangedLines` zmienionych linii;
- pojedyncza awaria Codexa jest ponawiana przy następnym Stop; po co najmniej 2 kolejnych awariach recenzje są wstrzymane na `failureBackoffMin` minut od ostatniej (sukces zeruje licznik);
- pojedyncza recenzja może trwać do `hookTimeoutSec` (domyślnie 15 min).

## Prywatność

- Codex ma dostęp do **całego projektu** — to świadoma decyzja projektowa, bez list
  wykluczeń. Wszystko, co jest w projekcie, także sekrety, może zostać odczytane i wysłane
  do OpenAI. Nie używaj skilla tam, gdzie to niedopuszczalne (wyłącz automatyczną recenzję przez
  `"enabled": false` — przełącznik globalny, działa na wszystkie projekty, więc włącz go z powrotem
  po pracy z takim projektem albo odinstaluj skill; ręczne `/external-review` nadal wysyła dane, więc go nie uruchamiaj).
- Pliki, które edytuje Claude — **także `.env`, klucze i inne sekrety** — są wysyłane do
  Codexa w całości (lub jako diff) bezpośrednio w prompcie, a kopie ich przejrzanej treści
  zostają lokalnie w `BASE/external-review/state/`. `ignorePatterns` / `ignoreDirs` wyłączają
  pliki z recenzji, ale nie ograniczają dostępu Codexa do projektu.
- Codex nie powinien zmieniać plików; prompt tego zabrania, a hook zgłasza (nie cofa) zmiany
  wprowadzone w trakcie recenzji: w repozytorium git — pliki widoczne w `git status` (zmienione,
  nowe nieignorowane, usunięte) poza `ignoreDirs`/`ignorePatterns`; poza gitem — pliki projektu
  poza `ignoreDirs`/`ignorePatterns` (po rozmiarze i czasie modyfikacji); zawsze, także gdy git je
  ignoruje — `.git/hooks/**`, `.git/config`, `.claude/**`, `.vscode/**`, `.github/workflows/**`.
  Pliki spec/plan są zgłaszane mimo `ignorePatterns`. Zmiany innych plików ignorowanych przez
  git i reszty katalogu `.git` nie są wykrywane.
- Ochrona przed prompt injection: materiał trafia do Codexa w ogranicznikach jako dane,
  pola uwag są przycinane, a skill zabrania Claude'owi wykonywania poleceń z treści uwag.
- Dane lokalne: stan i kopie przejrzanej treści leżą w `BASE/external-review/state/`;
  `node install.mjs --uninstall --purge` je usuwa.

## Platformy

Windows, macOS i Linux (Node ≥ 20). Ścieżki i porównania nazw plików są obsługiwane
zgodnie z systemem (bez rozróżniania wielkości liter na Windows i macOS). Testy
(`npm test`) działają w CI na wszystkich trzech systemach.

## Ograniczenia

- Poza gitem edycje przez Bash / zewnętrzne narzędzia nie są wykrywane (tylko narzędzia
  edycji Claude'a i czas modyfikacji spec/plan); pierwsza recenzja pliku obejmuje pełną treść.
- Ręczne edycje w trakcie tury i zmiany równoległej sesji w tym samym repo mogą zostać
  zrecenzowane razem ze zmianami Claude'a.
- Równoległe sesje Claude Code w tym samym projekcie dzielą pliki pending i zapisaną
  numerację (`display`): numeracja zapisana w jednej sesji zastępuje numerację drugiej, więc
  `--mark-reviewed` może usunąć uwagi pokazane w innej sesji. Bez zapisanej numeracji
  `--mark-reviewed` niczego nie usuwa i prosi o `--save-display`.
- Gdy w tle pracują subagenci, Stop może zrecenzować pracę niedokończoną; dalsze zmiany
  wrócą w kolejnej rundzie.
- Usunięcia plików nie są recenzowane; zmiana nazwy pliku = recenzja od zera.
- Pliki binarne i pliki, których materiał sam przekracza `maxReviewBytes`, nie są recenzowane
  automatycznie: hook ostrzega raz i oznacza ich bieżącą treść jako przejrzaną. Pliki, które
  nie zmieściły się w `maxChunks` porcjach, czekają na kolejny Stop.
- Zmian wprowadzonych przez Codexa nie da się przypisać do etapu; nie są cofane.
- Na Windows domyślny sandbox Codexa (`workspace-write` z `windows.sandbox="unelevated"`) blokuje
  procesom uruchamianie procesów potomnych (`spawn EPERM`): Codex czyta kod, ale zwykle nie uruchomi
  testów projektu (np. `npm test`). Na macOS i Linuksie tego ograniczenia nie ma. Aby Codex mógł
  uruchamiać testy na Windows, wybierz jedno:
  - **sandbox „elevated”** — skonfiguruj go w Codexie (wymaga jednorazowej zgody administratora),
    a potem ustaw `sandbox = "elevated"` w sekcji `[windows]` swojego `~/.codex/config.toml` (skill
    przenosi ustawienia z tej sekcji mimo `ignoreUserConfig`) albo
    `"codexConfigOverrides": ["windows.sandbox=\"elevated\""]` w `config.local.json`;
  - **bez sandboxa** — `"codexSandbox": "danger-full-access"` w `config.local.json`. Codex działa wtedy
    bez żadnych ograniczeń (także poza projektem i z dostępem do sieci); używaj tylko w zaufanych projektach.
- Tekst paska stanu jest stały; recenzja może trwać do `hookTimeoutSec` — Esc przerywa
  oczekiwanie (zmiany trafią do kolejnej recenzji).
- Instalacja wyłącznie globalna (nie per projekt).

## Testy

```
npm test
```

## Autor

Pomysł, projekt i implementacja: **Dawid Góraj** (2026).
Oryginalne repozytorium: https://github.com/dawidgoraj1-alt/claude-external-review

Jeśli korzystasz z tego skilla, rozwijasz go lub publikujesz jego fork,
zachowaj informację o autorze i link do oryginalnego repozytorium.

## Licencja

MIT © 2026 Dawid Góraj — pełna treść w pliku [LICENSE](LICENSE).
Licencja wymaga zachowania powyższej informacji o prawach autorskich we wszystkich kopiach
i istotnych częściach oprogramowania.
