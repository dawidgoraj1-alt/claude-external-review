import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { codexSegment, plFiles, formatElapsed } from '../src/external-review/statusline.mjs';
import { liveDir } from '../src/external-review/lib/live.mjs';
import { makeEnv } from '../test-support/helpers.mjs';

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'external-review', 'statusline.mjs');
const NOW = 1_000_000_000_000;

function put(env, name, over = {}) {
  const d = liveDir(env);
  fs.mkdirSync(d, { recursive: true });
  const rec = { root: '/proj', stages: ['code'], files: ['a.js', 'b.js', 'c.js'], round: 1, startedAt: NOW - 72000, updatedAt: NOW - 1000, action: 'czyta stop.mjs', tokens: 18400, pid: 1, ...over };
  fs.writeFileSync(path.join(d, `${name}.json`), JSON.stringify(rec));
}

test('plural forms of "plik"', () => {
  const f = (n) => plFiles(n);
  assert.equal(f(1), '1 plik');
  for (const n of [2, 3, 4, 22, 23, 104]) assert.equal(f(n), `${n} pliki`, String(n));
  for (const n of [0, 5, 11, 12, 13, 14, 15, 21, 25, 100, 112]) assert.equal(f(n), `${n} plików`, String(n));
});
test('elapsed formatting m:ss', () => {
  assert.equal(formatElapsed(72000), '1:12');
  assert.equal(formatElapsed(5000), '0:05');
  assert.equal(formatElapsed(-5), '0:00');
  assert.equal(formatElapsed(3600000 + 61000), '61:01');
});
test('full segment', () => {
  const t = makeEnv();
  try {
    put(t.env, 'x-1');
    assert.equal(codexSegment('/proj', t.env, NOW), '⟳ Codex · kod (3 pliki) · 1:12 · czyta stop.mjs · 18k tok');
  } finally { t.cleanup(); }
});
test('no tokens and no action: those parts are omitted; stage names', () => {
  const t = makeEnv();
  try {
    put(t.env, 'x-1', { stages: ['spec', 'plan', 'code'], files: ['a'], tokens: 0, action: '' });
    assert.equal(codexSegment('/proj', t.env, NOW), '⟳ Codex · specyfikacja, plan, kod (1 plik) · 1:12');
  } finally { t.cleanup(); }
});
test('empty when dir missing, stale file ignored, other project ignored, empty stages ignored', () => {
  const t = makeEnv();
  try {
    assert.equal(codexSegment('/proj', t.env, NOW), '');
    put(t.env, 'stale', { updatedAt: NOW - 16000 });
    put(t.env, 'other', { root: '/other' });
    put(t.env, 'empty', { stages: [] });
    fs.writeFileSync(path.join(liveDir(t.env), 'junk.json'), '{nie json');
    assert.equal(codexSegment('/proj', t.env, NOW), '');
    assert.equal(codexSegment('/proj/sub', { ...t.env }, NOW), '');
  } finally { t.cleanup(); }
});
test('subdirectory cwd matches; sibling with common prefix does not; slashes and case normalised', () => {
  const t = makeEnv();
  try {
    put(t.env, 'x-1', { root: 'C:/Work/Proj' });
    assert.match(codexSegment('C:\\Work\\Proj\\src\\deep', t.env, NOW), /^⟳ Codex/);
    assert.match(codexSegment('C:\\Work\\Proj', t.env, NOW), /^⟳ Codex/);
    assert.equal(codexSegment('C:/Work/Proj2', t.env, NOW), '');
    if (process.platform === 'win32' || process.platform === 'darwin') assert.match(codexSegment('c:/work/proj/x', t.env, NOW), /^⟳ Codex/);
    else assert.equal(codexSegment('c:/work/proj/x', t.env, NOW), '');
  } finally { t.cleanup(); }
});
test('merge of two files: union of stages, files, earliest start, latest action, summed tokens', () => {
  const t = makeEnv();
  try {
    put(t.env, 'a-1', { stages: ['code'], files: ['a.js', 'b.js'], startedAt: NOW - 30000, updatedAt: NOW - 3000, action: 'myśli', tokens: 1000 });
    put(t.env, 'a-2', { stages: ['spec'], files: ['b.js', 'x.md'], startedAt: NOW - 90000, updatedAt: NOW - 500, action: 'pisze wynik', tokens: 2000 });
    assert.equal(codexSegment('/proj', t.env, NOW), '⟳ Codex · specyfikacja, kod (3 pliki) · 1:30 · pisze wynik · 3k tok');
  } finally { t.cleanup(); }
});
test('script mode: stdin JSON (workspace.current_dir or cwd), silent otherwise, always exit 0', () => {
  const t = makeEnv();
  try {
    const now = Date.now();
    put(t.env, 'x-1', { startedAt: now - 72000, updatedAt: now });
    const run = (input) => spawnSync(process.execPath, [SCRIPT], { input, env: t.env, encoding: 'utf8' });
    let r = run(JSON.stringify({ workspace: { current_dir: '/proj/src' } }));
    assert.equal(r.status, 0);
    assert.match(r.stdout, /^⟳ Codex · kod \(3 pliki\) · \d:\d\d · czyta stop\.mjs · 18k tok\n?$/);
    r = run(JSON.stringify({ cwd: '/proj' }));
    assert.match(r.stdout, /^⟳ Codex/);
    for (const bad of ['', 'nie json', '[]', JSON.stringify({ cwd: '/inny' })]) {
      r = run(bad);
      assert.equal(r.status, 0);
      assert.equal(r.stdout, '');
    }
  } finally { t.cleanup(); }
});
test('script mode finishes fast when stdin never closes', () => {
  const t = makeEnv();
  try {
    const t0 = Date.now();
    // stdio 'pipe' bez zamknięcia stdin: spawnSync zamyka go po input, więc użyj 'inherit' zastępczo przez ignore
    const r = spawnSync(process.execPath, [SCRIPT], { env: t.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 });
    assert.equal(r.status, 0);
    assert.ok(Date.now() - t0 < 3000);
  } finally { t.cleanup(); }
});
