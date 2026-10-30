import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeCodexPath, makeEnv, makeRepo, pathAlias, runHook } from '../test-support/helpers.mjs';
import { canonical, stateDirFor, toSlash } from '../src/external-review/lib/paths.mjs';
import { readState } from '../src/external-review/lib/state.mjs';
import { readPending } from '../src/external-review/lib/pending.mjs';
import { makeContext } from '../src/external-review/lib/context.mjs';
import { runManual } from '../src/external-review/lib/manual.mjs';
import { sha256 } from '../src/external-review/lib/text.mjs';

const TMP = canonical(os.tmpdir());
const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'stdin');
const fixture = (name) => JSON.parse(fs.readFileSync(path.join(FIXTURES, `${name}.json`), 'utf8'));

const lines = (n, tag = 'v') => Array.from({ length: n }, (_, i) => `const ${tag}${i} = ${i};`).join('\n') + '\n';
const FINDING = { id: 1, severity: 'important', location: 'linia 1', problem: 'PROBLEM-A', suggestion: 'Popraw' };
const FINDINGS = JSON.stringify([FINDING]);

function setup({ git = true, files = {}, config = {}, fake = {} } = {}) {
  const { env, base, cleanup } = makeEnv();
  const repo = canonical(makeRepo({ git, files }));
  const codex = fakeCodexPath(base);
  fs.mkdirSync(path.join(base, 'external-review'), { recursive: true });
  fs.writeFileSync(path.join(base, 'external-review', 'config.local.json'),
    JSON.stringify({ codexPath: codex, ...config }));
  const calls = path.join(base, 'calls.log');
  Object.assign(env, { GIT_CEILING_DIRECTORIES: TMP, FAKE_CODEX_CALLS: calls, FAKE_CODEX_MODE: 'findings', FAKE_CODEX_FINDINGS: FINDINGS }, fake);
  const t = {
    env, base, repo, calls,
    stateDir: stateDirFor(repo, env),
    stop(extra = {}) {
      const r = runHook(['--event', 'stop'], { ...fixture('stop'), cwd: repo, ...extra }, env);
      assert.equal(r.status, 0, r.stderr);
      return r.stdout.trim() ? JSON.parse(r.stdout) : null;
    },
    prompt() {
      const r = runHook(['--event', 'prompt'], { ...fixture('prompt'), cwd: repo }, env);
      assert.equal(r.status, 0, r.stderr);
    },
    cli: (args, stdin = '') => runHook(args, stdin, env),
    write(rel, content) {
      const p = path.join(repo, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content);
    },
    state: () => readState(t.stateDir),
    callCount: () => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').split('\n').filter((l) => l.startsWith('start')).length : 0),
    cleanup() { cleanup(); fs.rmSync(repo, { recursive: true, force: true }); },
  };
  return t;
}

// Spec zrecenzowany przez Stop → pending-spec z 1 uwagą s-1 (runda 1).
function withSpecPending(t, content = '# Spec\n\nTreść.\n') {
  t.prompt();
  t.write('docs/specs/x-spec.md', content);
  const out = t.stop();
  assert.equal(out.decision, 'block');
  return 'docs/specs/x-spec.md';
}

test('mark-reviewed clears displayed findings, keeps reviewedHash of reviewed content', () => {
  const t = setup();
  try {
    const rel = withSpecPending(t);
    const reviewed = sha256('# Spec\n\nTreść.\n');
    assert.equal(t.cli(['--save-display', '--stage', 'spec', '--cwd', t.repo], '{"1":"s-1"}').status, 0);
    t.write(rel, '# Spec\n\nTreść.\n\nPoprawka.\n');
    const r = t.cli(['--mark-reviewed', '--stage', 'spec', '--cwd', t.repo]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim().split('\n').length, 1);
    assert.equal(readPending(t.stateDir, 'spec'), null);
    assert.equal(t.state().files[rel].reviewedHash, reviewed);
    // Kolejny Stop recenzuje diff — runda 2.
    const before = t.callCount();
    t.stop();
    assert.equal(t.callCount(), before + 1);
    assert.equal(readPending(t.stateDir, 'spec').findings[0].round, 2);
  } finally { t.cleanup(); }
});

test('mark-reviewed --final stores current content, no next round', () => {
  const t = setup();
  try {
    const rel = withSpecPending(t);
    t.cli(['--save-display', '--stage', 'spec', '--cwd', t.repo], '{"1":"s-1"}');
    const edited = '# Spec\n\nTreść.\n\nPoprawka.\n';
    t.write(rel, edited);
    const r = t.cli(['--mark-reviewed', '--stage', 'spec', '--cwd', t.repo, '--final']);
    assert.equal(r.status, 0, r.stderr);
    const f = t.state().files[rel];
    assert.equal(f.reviewedHash, sha256(edited));
    assert.equal(f.rounds, 0);
    assert.ok(fs.existsSync(path.join(t.stateDir, 'blobs', f.reviewedHash)));
    const before = t.callCount();
    assert.equal(t.stop(), null);
    assert.equal(t.callCount(), before);
  } finally { t.cleanup(); }
});

test('"żadne": mark-reviewed without edits → next Stop has nothing to review', () => {
  const t = setup();
  try {
    withSpecPending(t);
    t.cli(['--save-display', '--stage', 'spec', '--cwd', t.repo], '{"1":"s-1"}');
    assert.equal(t.state().files['docs/specs/x-spec.md'].rounds, 1);
    assert.equal(t.cli(['--mark-reviewed', '--stage', 'spec', '--cwd', t.repo]).status, 0);
    assert.equal(t.state().files['docs/specs/x-spec.md'].rounds, 0); // bieżąca treść == reviewedHash → licznik zerowany
    const before = t.callCount();
    assert.equal(t.stop(), null);
    assert.equal(t.callCount(), before);
  } finally { t.cleanup(); }
});

test('manual on a previously reviewed unchanged spec: full material, no round note', () => {
  const t = setup();
  try {
    const rel = withSpecPending(t);
    assert.equal(t.state().files[rel].rounds, 1);
    const log = path.join(t.base, 'prompt.log');
    t.env.FAKE_CODEX_LOG = log;
    const r = t.cli(['--manual', '--cwd', t.repo, rel]);
    assert.equal(r.status, 0, r.stderr);
    const prompt = fs.readFileSync(log, 'utf8');
    assert.ok(prompt.includes('kind="full"'));
    assert.ok(!prompt.includes('ponowna recenzja'));
  } finally { t.cleanup(); }
});

test('manual with paths ignores hash gate, threshold and round limit', () => {
  const t = setup({ config: { maxReviewRounds: 1, codeMinChangedLines: 1000 } });
  try {
    t.write('src/a.js', lines(3)); // poniżej progu; pierwsza ręczna recenzja
    let r = t.cli(['--manual', '--cwd', t.repo, 'src/a.js']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(t.callCount(), 1);
    const out = JSON.parse(r.stdout);
    assert.deepEqual(out.warnings, []);
    assert.equal(out.pendingFiles.length, 1);
    assert.ok(out.pendingFiles[0].endsWith('pending-code.json'));
    assert.equal(out.pendingFiles[0], toSlash(out.pendingFiles[0]));
    assert.equal(t.state().files['src/a.js'].rounds, 1); // limit rund (1) osiągnięty
    // Zmieniona treść po osiągnięciu limitu rund — i tak recenzja.
    t.write('src/a.js', lines(3) + 'const z = 1;\n');
    r = t.cli(['--manual', '--cwd', t.repo, 'src/a.js']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(t.callCount(), 2);
    assert.equal(readPending(t.stateDir, 'code').findings.length, 2);
  } finally { t.cleanup(); }
});

test('manual with explicit path reviews clean tracked file and file equal to reviewedHash in full', () => {
  const t = setup({ files: { 'src/c.js': lines(3, 'c') } });
  try {
    let r = t.cli(['--manual', '--cwd', t.repo, 'src/c.js']); // czysty plik śledzony
    assert.equal(r.status, 0, r.stderr);
    assert.equal(t.callCount(), 1);
    assert.deepEqual(JSON.parse(r.stdout).warnings, []);
    assert.equal(readPending(t.stateDir, 'code').findings.length, 1);
    r = t.cli(['--manual', '--cwd', t.repo, 'src/c.js']); // treść == reviewedHash
    assert.equal(r.status, 0, r.stderr);
    assert.equal(t.callCount(), 2);
    assert.deepEqual(JSON.parse(r.stdout).warnings, []);
    assert.equal(readPending(t.stateDir, 'code').findings.length, 2);
  } finally { t.cleanup(); }
});

test('manual with alias (8.3/symlink) --cwd and path argument resolves root-relative', (tc) => {
  const t = setup({ files: { 'src/c.js': lines(3, 'c') } });
  try {
    const alias = pathAlias(t.repo);
    if (!alias) { tc.skip('no 8.3 names or symlinks here'); return; }
    const r = t.cli(['--manual', '--cwd', alias, path.join(alias, 'src', 'c.js')]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readPending(t.stateDir, 'code').findings[0].file, 'src/c.js');
  } finally { t.cleanup(); }
});

test('manual without paths in git reviews dirty code files', () => {
  const t = setup({ files: { 'README.txt': 'x\n' } });
  try {
    t.write('src/a.js', lines(3));
    const r = t.cli(['--manual', '--cwd', t.repo]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(t.callCount(), 1);
    assert.equal(readPending(t.stateDir, 'code').findings[0].file, 'src/a.js');
  } finally { t.cleanup(); }
});

test('manual without paths outside git → exit 2', () => {
  const t = setup({ git: false });
  try {
    t.write('src/a.js', lines(3));
    const r = t.cli(['--manual', '--cwd', t.repo]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /ścieżki/);
    assert.equal(t.callCount(), 0);
  } finally { t.cleanup(); }
});

test('manual: codex error → exit 1 with warning', () => {
  const t = setup({ fake: { FAKE_CODEX_MODE: 'exit1' } });
  try {
    t.write('src/a.js', lines(3));
    const r = t.cli(['--manual', '--cwd', t.repo, 'src/a.js']);
    assert.equal(r.status, 1);
    assert.equal(JSON.parse(r.stdout).warnings.length, 1);
    assert.equal(readPending(t.stateDir, 'code'), null);
  } finally { t.cleanup(); }
});

test('pending lists open pending files', () => {
  const t = setup();
  try {
    let r = t.cli(['--pending', '--cwd', t.repo]);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), { pendingFiles: [], warnings: [] });
    withSpecPending(t);
    r = t.cli(['--pending', '--cwd', t.repo]);
    const { pendingFiles } = JSON.parse(r.stdout);
    assert.equal(pendingFiles.length, 1);
    assert.equal(pendingFiles[0], toSlash(path.join(t.stateDir, 'pending-spec.json')));
  } finally { t.cleanup(); }
});

test('save-display stores numbering used by mark-reviewed', () => {
  const t = setup({ fake: { FAKE_CODEX_FINDINGS: JSON.stringify([FINDING, { ...FINDING, id: 2, problem: 'PROBLEM-B' }]) } });
  try {
    withSpecPending(t);
    assert.equal(readPending(t.stateDir, 'spec').findings.length, 2);
    const r = t.cli(['--save-display', '--stage', 'spec', '--cwd', t.repo], '{"1":"s-2"}');
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(readPending(t.stateDir, 'spec').display, { 1: 's-2' });
    assert.equal(t.cli(['--mark-reviewed', '--stage', 'spec', '--cwd', t.repo]).status, 0);
    assert.deepEqual(readPending(t.stateDir, 'spec').findings.map((f) => f.id), ['s-1']);
  } finally { t.cleanup(); }
});

test('invalid arguments → exit 2', () => {
  const t = setup();
  try {
    const bad = [
      [['--bogus']],
      [['--mark-reviewed', '--cwd', t.repo]],
      [['--mark-reviewed', '--stage', 'xxx', '--cwd', t.repo]],
      [['--mark-reviewed', '--stage', 'spec']],
      [['--mark-reviewed', '--stage', 'spec', '--cwd', path.join(t.repo, 'nie-ma')]],
      [['--pending', '--cwd', t.repo, '--final']],
      [['--pending', '--cwd', t.repo, 'a.js']],
      [['--manual', '--cwd', t.repo, 'brak.js']],
      [['--manual', '--cwd', t.repo, path.join(t.base, 'poza.js')]],
      [['--save-display', '--stage', 'spec', '--cwd', t.repo], '{nie json'],
      [['--save-display', '--stage', 'spec', '--cwd', t.repo], '[1]'],
      [['--save-display', '--stage', 'spec', '--cwd', t.repo], '{"1":2}'],
    ];
    for (const [args, stdin] of bad) {
      const r = t.cli(args, stdin ?? '');
      assert.equal(r.status, 2, `${args.join(' ')}: ${r.stderr}`);
      assert.equal(r.stdout, '');
      assert.ok(r.stderr.trim());
    }
    assert.equal(t.callCount(), 0);
  } finally { t.cleanup(); }
});

test('manual: pending write failure → file not marked reviewed, kept outstanding, exit 1', async () => {
  const t = setup();
  const saved = {};
  for (const k of ['FAKE_CODEX_MODE', 'FAKE_CODEX_FINDINGS', 'FAKE_CODEX_CALLS']) { saved[k] = process.env[k]; process.env[k] = t.env[k]; }
  const orig = fs.writeFileSync;
  try {
    t.write('src/a.js', lines(3));
    const ctx = makeContext(t.repo, t.env);
    fs.writeFileSync = function patched(p, ...rest) {
      if (/pending-code\.json/.test(String(p))) throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
      return orig.call(this, p, ...rest);
    };
    let r;
    try { r = await runManual(ctx, ['src/a.js']); } finally { fs.writeFileSync = orig; }
    assert.equal(r.exitCode, 1);
    assert.ok(r.warnings.some((w) => /Nie udało się zapisać uwag/.test(w)), r.warnings.join(' | '));
    assert.equal(t.state().files['src/a.js'], undefined);
    assert.deepEqual(t.state().outstanding, ['src/a.js']);
  } finally {
    fs.writeFileSync = orig;
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    t.cleanup();
  }
});

test('mark-reviewed without saved display removes nothing and asks for --save-display', () => {
  const t = setup();
  try {
    const rel = withSpecPending(t);
    for (const extra of [[], ['--final']]) {
      const r = t.cli(['--mark-reviewed', '--stage', 'spec', '--cwd', t.repo, ...extra]);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /--save-display/);
      assert.deepEqual(readPending(t.stateDir, 'spec').findings.map((f) => f.id), ['s-1']);
      assert.equal(t.state().files[rel].rounds, 1);
    }
  } finally { t.cleanup(); }
});

test('manual: explicitly named files bypass ignorePatterns/ignoreDirs; .md outside spec/plan is reviewed as code', () => {
  const t = setup();
  try {
    t.write('notes.md', '# Notatki\n\nTreść.\n');
    t.write('node_modules/lib/x.js', lines(3));
    const log = path.join(t.base, 'prompt.log');
    t.env.FAKE_CODEX_LOG = log;
    const r = t.cli(['--manual', '--cwd', t.repo, 'notes.md', 'node_modules/lib/x.js']);
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.deepEqual(out.warnings, []);
    assert.deepEqual([...out.reviewed].sort(), ['node_modules/lib/x.js', 'notes.md']);
    assert.equal(t.callCount(), 1);
    assert.equal(readPending(t.stateDir, 'code').findings.length, 1);
    assert.equal(readPending(t.stateDir, 'spec'), null);
    assert.ok(fs.readFileSync(log, 'utf8').includes('notes.md'));
  } finally { t.cleanup(); }
});

test('manual: JSON lists reviewed files; nothing sent → reviewed empty (also binary skipped with warning)', () => {
  const t = setup();
  try {
    fs.writeFileSync(path.join(t.repo, 'img.bin'), Buffer.from([0, 1, 2, 0, 3]));
    const r = t.cli(['--manual', '--cwd', t.repo, 'img.bin']);
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.deepEqual(out.reviewed, []);
    assert.ok(out.warnings.some((w) => /binarn/.test(w)), out.warnings.join('|'));
    assert.equal(t.callCount(), 0);
  } finally { t.cleanup(); }
});

test('corrupt pending file: --pending and --mark-reviewed warn instead of silently ignoring it', () => {
  const t = setup();
  try {
    withSpecPending(t);
    const file = path.join(t.stateDir, 'pending-spec.json');
    fs.writeFileSync(file, '{ to nie jest json');
    let r = t.cli(['--pending', '--cwd', t.repo]);
    assert.equal(r.status, 0, r.stderr);
    let out = JSON.parse(r.stdout);
    assert.deepEqual(out.pendingFiles, []);
    assert.equal(out.warnings.length, 1);
    assert.match(out.warnings[0], /pending-spec\.json/);
    assert.match(out.warnings[0], /uszkodzon|nieczytelny/);
    r = t.cli(['--mark-reviewed', '--stage', 'spec', '--cwd', t.repo]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /pending-spec\.json/);
    assert.match(r.stdout, /uszkodzon|nieczytelny/);
    // Zdrowy stan nie generuje ostrzeżeń.
    fs.rmSync(file);
    out = JSON.parse(t.cli(['--pending', '--cwd', t.repo]).stdout);
    assert.deepEqual(out, { pendingFiles: [], warnings: [] });
  } finally { t.cleanup(); }
});

test('mark-reviewed --final <paths> also marks extra changed files as reviewed at current content', () => {
  const t = setup();
  try {
    const rel = withSpecPending(t);
    t.cli(['--save-display', '--stage', 'spec', '--cwd', t.repo], '{"1":"s-1"}');
    t.write(rel, '# Spec\n\nTreść.\n\nPoprawka.\n');
    const extra = lines(30, 'x');
    t.write('src/extra.js', extra); // plik zmieniony przy wprowadzaniu poprawek, poza uwagami
    t.write('docs/ignored.log', 'x\n'); // plik ignorowany nie jest śledzony
    const r = t.cli(['--mark-reviewed', '--stage', 'spec', '--cwd', t.repo, '--final', 'src/extra.js', 'docs/ignored.log']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /src\/extra\.js/);
    const s = t.state();
    assert.equal(s.files['src/extra.js'].reviewedHash, sha256(extra));
    assert.equal(s.files['src/extra.js'].rounds, 0);
    assert.equal(s.files['src/extra.js'].stage, 'code');
    assert.equal(s.files['docs/ignored.log'], undefined);
    assert.ok(fs.existsSync(path.join(t.stateDir, 'blobs', s.files['src/extra.js'].reviewedHash)));
    const before = t.callCount();
    assert.equal(t.stop(), null);
    assert.equal(t.callCount(), before, 'extra file not re-reviewed');
  } finally { t.cleanup(); }
});

test('paths are only allowed with --mark-reviewed --final; outside-project path → exit 2', () => {
  const t = setup();
  try {
    withSpecPending(t);
    t.cli(['--save-display', '--stage', 'spec', '--cwd', t.repo], '{"1":"s-1"}');
    let r = t.cli(['--mark-reviewed', '--stage', 'spec', '--cwd', t.repo, 'src/x.js']);
    assert.equal(r.status, 2);
    r = t.cli(['--mark-reviewed', '--stage', 'spec', '--cwd', t.repo, '--final', '../poza.js']);
    assert.equal(r.status, 2);
    assert.equal(readPending(t.stateDir, 'spec').findings.length, 1, 'nic nie usunięto przy błędzie argumentów');
  } finally { t.cleanup(); }
});

test('manual: explicit spec/plan path inside an ignoreDir is reviewed as spec/plan, not code', () => {
  const t = setup();
  try {
    t.write('build/specs/x-design.md', '# Projekt\n\nTreść.\n');
    t.write('dist/plans/y-plan.md', '# Plan\n\nTreść.\n');
    const r = t.cli(['--manual', '--cwd', t.repo, 'build/specs/x-design.md', 'dist/plans/y-plan.md']);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual([...JSON.parse(r.stdout).reviewed].sort(), ['build/specs/x-design.md', 'dist/plans/y-plan.md']);
    assert.equal(readPending(t.stateDir, 'spec').findings.length, 1);
    assert.equal(readPending(t.stateDir, 'plan').findings.length, 1);
    assert.equal(readPending(t.stateDir, 'code'), null);
  } finally { t.cleanup(); }
});
