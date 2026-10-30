// Copyright (c) 2026 Dawid Góraj — external-review (https://github.com/dawidgoraj1-alt/claude-external-review). Licencja MIT.
import fs from 'node:fs';
import path from 'node:path';
import { skillDir } from './paths.mjs';

const ROLES = {
  spec: 'Oceń specyfikację pod kątem: kompletności, sprzeczności, niejednoznaczności, placeholderów, wykonalności, brakującej obsługi błędów i testów oraz zbyt szerokiego zakresu.',
  plan: 'Oceń plan pod kątem: zgodności ze specyfikacją (znajdź ją według wzorców z {{SPEC_PATTERNS}}; spec może być w trakcie poprawek), brakujących lub źle uporządkowanych kroków oraz kroków nietestowalnych lub zbyt dużych.',
  code: 'Oceń kod pod kątem: błędów logicznych, bezpieczeństwa, przypadków brzegowych, obsługi błędów, brakujących testów oraz zgodności z planem i specyfikacją (według wzorców, jeśli istnieją). Pomiń stylistykę.',
};

const ROUND_NOTE =
  'To ponowna recenzja po poprawkach. Oceniaj wyłącznie zmiany z materiału kind=diff; zgłaszaj tylko uwagi critical/important.';

// Zastępuje ścieżki w nagłówkach diffu (diff --git / --- / +++) ścieżką projektu,
// by do promptu nie trafiały lokalne ścieżki bezwzględne (temp, blob).
export function sanitizeDiffHeaders(text, relPath) {
  let inHeader = true;
  return text
    .split('\n')
    .map((line) => {
      if (line.startsWith('diff --git ')) {
        inHeader = true;
        return `diff --git a/${relPath} b/${relPath}`;
      }
      if (line.startsWith('@@')) {
        inHeader = false;
        return line;
      }
      if (!inHeader) return line;
      if (line.startsWith('--- ') && !line.startsWith('--- /dev/null')) return `--- a/${relPath}`;
      if (line.startsWith('+++ ') && !line.startsWith('+++ /dev/null')) return `+++ b/${relPath}`;
      return line;
    })
    .join('\n');
}

// Neutralizuje znaczniki ograniczników w danych, by materiał nie mógł zamknąć bloku
// ani podrobić nagłówka kolejnego elementu.
function neutralize(text) {
  return text.replace(/<<<(END MATERIAL|MATERIAL\b)/g, '<<​<$1');
}

function safePath(p) {
  return neutralize(p).replace(/\r\n|\r|\n/g, ' ').replace(/"/g, "'");
}

function renderMaterial(items) {
  return items
    .map((it) => {
      const body = neutralize(it.kind === 'diff' ? sanitizeDiffHeaders(it.text, it.path) : it.text);
      return `<<<MATERIAL path="${safePath(it.path)}" kind="${it.kind}">>>\n${body}\n<<<END MATERIAL>>>`;
    })
    .join('\n\n');
}

export function renderPrompt(stage, { items, round, cfg }) {
  const file = path.join(skillDir(), 'prompts', `${stage}.md`);
  const template = fs.readFileSync(file, 'utf8');
  const values = {
    ROLE: ROLES[stage],
    // Notatka o ponownej recenzji tylko, gdy jest materiał kind=diff (inaczej recenzja byłaby pusta).
    ROUND_NOTE: round >= 2 && items.some((it) => it.kind === 'diff') ? ROUND_NOTE : '',
    SPEC_PATTERNS: (cfg.specPatterns || []).join(', '),
    PLAN_PATTERNS: (cfg.planPatterns || []).join(', '),
    MATERIAL: renderMaterial(items),
  };
  // ROLE może zawierać {{SPEC_PATTERNS}}: najpierw rozwiń ROLE, potem reszta w jednym przebiegu,
  // by treść materiału nie była ponownie interpretowana.
  const withRole = template.replace('{{ROLE}}', () => values.ROLE);
  return withRole.replace(/\{\{(SPEC_PATTERNS|PLAN_PATTERNS|ROUND_NOTE|MATERIAL)\}\}/g, (_, k) => values[k]);
}
