---
name: external-review-help
description: Wyświetla listę wszystkich komend i odpowiedzi skilla external-review (recenzja Codex) wraz z instalacją, konfiguracją i rozwiązywaniem problemów.
disable-model-invocation: true
---

Wyświetl użytkownikowi **dokładnie** poniższy tekst (od linii `# external-review — pomoc` do końca pliku, z wyłączeniem końcowego komentarza HTML), bez skracania, bez dodatkowego komentarza i bez wywoływania żadnych narzędzi.

# external-review — pomoc

Automatyczna recenzja Twojej pracy przez OpenAI Codex. Po każdej turze, w której Claude zmienił **specyfikację**, **plan** albo **kod** (od 20 linii), hook uruchamia Codexa, Claude odsiewa fałszywe alarmy, a Ty wybierasz poprawki.

## Komendy w Claude Code

| Komenda | Co robi |
|---|---|
| `/external-review-help` | ta pomoc |
| `/external-review --pending` | pokazuje niezałatwione uwagi z poprzednich recenzji |
| `/external-review <ścieżki…>` | recenzuje wskazane pliki teraz (bez progów i limitu rund) |
| `/external-review` | w repozytorium git recenzuje wszystkie niezacommitowane pliki kodu; poza gitem poprosi o ścieżki |

## Odpowiedzi na listę uwag

| Odpowiedź | Efekt |
|---|---|
| `1, 3` | wprowadza tylko wskazane poprawki; zmiany wracają do Codexa (kolejna runda) |
| `wszystkie` | wprowadza wszystkie z sekcji „Proponowane poprawki” (odrzuconych nie) |
| `żadne` | niczego nie zmienia, zamyka listę i zeruje licznik rund |
| `zakończ recenzję` | wprowadza ewentualnie wskazane poprawki i oznacza pliki jako przejrzane — bez kolejnej rundy |
| (inny temat) | uwagi czekają; hook przypomni o nich na końcu tury |

**Esc** w trakcie „Codex recenzuje…” przerywa oczekiwanie — zmiany trafią do następnej recenzji.

## Instalator (w katalogu klonu repozytorium)

| Polecenie | Co robi |
|---|---|
| `node install.mjs` | instaluje lub aktualizuje skill i hooki (potem zrestartuj Claude Code) |
| `node install.mjs --model <nazwa>` | instaluje z innym modelem Codexa |
| `node install.mjs --codex-default-model` | używa domyślnego modelu Twojego Codexa |
| `node install.mjs --uninstall` | usuwa hooki i skill |
| `node install.mjs --uninstall --purge` | dodatkowo usuwa stan recenzji i `config.local.json` |
| `npm test` | uruchamia testy skilla |

Aktualizacja: `git pull`, potem `node install.mjs`.

## Konfiguracja

Plik `~/.claude/external-review/config.local.json` (nadpisuje domyślne wartości):

| Klucz | Domyślnie | Znaczenie |
|---|---|---|
| `enabled` | `true` | `false` wyłącza automatyczną recenzję (ręczne `/external-review` działa dalej) |
| `model` | `gpt-6-sol` | model Codexa |
| `reasoningEffort` | `medium` | wysiłek rozumowania (`low`, `medium`, `high`) |
| `maxReviewRounds` | `3` | maks. rund recenzji na plik |
| `codeMinChangedLines` | `20` | od ilu zmienionych linii kodu startuje recenzja |
| `codexTimeoutSec` / `hookTimeoutSec` | `600` / `900` | limity czasu (po zmianie `hookTimeoutSec` uruchom ponownie instalator) |
| `specPatterns` / `planPatterns` | `**/specs/**/*.md`, `**/plans/**/*.md`, … | które pliki to specyfikacje i plany |
| `ignorePatterns` / `ignoreDirs` | `**/*.md`, `node_modules`, … | pliki i katalogi pomijane w recenzji kodu |

## Gdy coś nie działa

- **Brak recenzji po instalacji** — zrestartuj Claude Code.
- **Codex niezalogowany** — `codex login`, potem `node install.mjs`.
- **Model niedostępny** — `node install.mjs --model <nazwa>` albo `--codex-default-model`.
- **Po 2 awariach z rzędu** recenzje pauzują na 10 minut (`failureBackoffMin`).

**Prywatność:** Codex widzi cały projekt, łącznie z `.env` i kluczami, i może je wysłać do OpenAI. W projektach z wrażliwymi danymi ustaw `"enabled": false`.

Dokumentacja i kod: https://github.com/dawidgoraj1-alt/claude-external-review — autor: Dawid Góraj (MIT).

<!-- external-review © 2026 Dawid Góraj — https://github.com/dawidgoraj1-alt/claude-external-review (MIT) -->
