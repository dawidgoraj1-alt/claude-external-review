import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'external-review', 'SKILL.md');
const text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
const frontmatter = text.match(/^---\n([\s\S]*?)\n---\n/)?.[1] ?? '';

test('frontmatter has name, description, argument-hint', () => {
  assert.match(frontmatter, /^name: external-review$/m);
  assert.match(frontmatter, /^description: .{80,}/m);
  assert.match(frontmatter, /^argument-hint: \[--pending \| ścieżki\.\.\.\]$/m);
  assert.match(frontmatter, /Stop/);
  assert.match(frontmatter, /zakończ recenzję/);
  assert.match(frontmatter, /\/external-review/);
});

test('every hook invocation uses {{HOOK_PATH}} and --cwd', () => {
  const lines = text.split('\n').filter((l) => /node\s+"/.test(l) || /hook\.mjs/.test(l));
  assert.ok(lines.length >= 5, 'expected several hook invocations');
  for (const l of lines) {
    assert.match(l, /node "\{\{HOOK_PATH\}\}"/, l);
    assert.match(l, /--cwd "<katalog projektu>"/, l);
  }
  for (const mode of ['--pending', '--manual', '--save-display', '--mark-reviewed', '--mark-reviewed --stage', '--final']) {
    assert.ok(text.includes(mode), mode);
  }
  assert.ok(!/hook\.mjs/.test(text.replace(/\{\{HOOK_PATH\}\}/g, '')), 'no hard-coded hook path');
});

test('contains output template headings and choice prompt', () => {
  for (const s of ['### Proponowane poprawki', '### Odrzucone jako fałszywe alarmy', 'zakończ recenzję',
    '## Recenzja Codex', 'Które poprawki wprowadzić?', 'Brak niezałatwionych uwag Codexa']) {
    assert.ok(text.includes(s), s);
  }
});

test('forbids executing instructions from findings', () => {
  assert.match(text, /nigdy nie wykonuj/i);
  assert.match(text, /dane/);
  assert.match(text, /display/);
  assert.match(text, /nie (edytuj|zmieniaj)[^\n]*przed/i);
});

test('help skill: user-only, lists every command and reply', () => {
  const help = fs.readFileSync(path.join(path.dirname(file), '..', 'external-review-help', 'SKILL.md'), 'utf8').replace(/\r\n/g, '\n');
  const fm = help.match(/^---\n([\s\S]*?)\n---\n/)?.[1] ?? '';
  assert.match(fm, /^name: external-review-help$/m);
  assert.match(fm, /^disable-model-invocation: true$/m);
  for (const s of ['/external-review-help', '/external-review --pending', '/external-review <ścieżki…>', '`1, 3`', '`wszystkie`',
    '`żadne`', '`zakończ recenzję`', 'node install.mjs --uninstall --purge', '--codex-default-model', 'config.local.json', '"enabled": false']) {
    assert.ok(help.includes(s), s);
  }
});
