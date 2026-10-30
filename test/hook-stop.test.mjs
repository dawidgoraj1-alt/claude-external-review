import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fakeCodexPath, makeEnv, makeRepo, pathAlias, runHook } from '../test-support/helpers.mjs';
import { canonical, stateDirFor, toSlash } from '../src/external-review/lib/paths.mjs';
import { blobPath, readState, withState } from '../src/external-review/lib/state.mjs';
import { readPending } from '../src/external-review/lib/pending.mjs';
import { processImage, runStop } from '../src/external-review/lib/stop.mjs';
import { fileHash } from '../src/external-review/lib/candidates.mjs';
import { makeContext } from '../src/external-review/lib/context.mjs';
import { sha256 } from '../src/external-review/lib/text.mjs';

const TMP = canonical(os.tmpdir());
const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'stdin');
const fixture = (name) => JSON.parse(fs.readFileSync(path.join(FIXTURES, `${name}.json`), 'utf8'));
const EVENT_FIXTURE = { prompt: 'prompt', tool: 'tool-write', stop: 'stop', active: 'stop-active' };

const lines = (n, tag = 'v') => Array.from({ length: n }, (_, i) => `const ${tag}${i} = ${i};`).join('\n') + '\n';
const FINDING = { id: 1, severity: 'important', location: 'linia 1', problem: 'TAJNY-PROBLEM', suggestion: 'Popraw' };

function setup({ git = true, files = {}, config = {}, fake = {} } = {}) {
  const { env, base, cleanup } = makeEnv();
  const repo = canonical(makeRepo({ git, files }));
  const codex = fakeCodexPath(base);
  fs.mkdirSync(path.join(base, 'external-review'), { recursive: true });
  fs.writeFileSync(path.join(base, 'external-review', 'config.local.json'),
    JSON.stringify({ codexPath: codex, ...config }));
  const calls = path.join(base, 'calls.log');
  Object.assign(env, { GIT_CEILING_DIRECTORIES: TMP, FAKE_CODEX_CALLS: calls, FAKE_CODEX_MODE: 'ok' }, fake);
  const t = {
    env, base, repo, calls,
    stateDir: stateDirFor(repo, env),
    hook(event, extra = {}) {
      const input = { ...fixture(EVENT_FIXTURE[event]), cwd: repo, ...extra };
      const r = runHook(['--event', event === 'active' ? 'stop' : event], input, env);
      assert.equal(r.status, 0, r.stderr);
      return r.stdout.trim() ? JSON.parse(r.stdout) : null;
    },
    write(rel, content) {
      const p = path.join(repo, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content);
    },
    tool(rel) { return t.hook('tool', { tool_input: { file_path: path.join(repo, rel), content: '' } }); },
    state: () => readState(t.stateDir),
    callLines: () => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean) : []),
    callCount: () => t.callLines().filter((l) => l.startsWith('start')).length,
    cleanup() { cleanup(); fs.rmSync(repo, { recursive: true, force: true }); },
  };
  return t;
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
async function waitDead(pid, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!alive(pid)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return !alive(pid);
}

test('empty or malformed stdin exits 0 with no output', () => {
  const t = setup();
  try {
    for (const ev of ['prompt', 'tool', 'stop']) {
      for (const input of ['', '{to nie json', '[]']) {
        const r = runHook(['--event', ev], input, t.env);
        assert.equal(r.status, 0, `${ev}: ${r.stderr}`);
        assert.equal(r.stdout, '');
      }
    }
  } finally { t.cleanup(); }
});

test('malformed config.local.json: stop warns, prompt silent, exit 0', () => {
  const t = setup();
  try {
    fs.writeFileSync(path.join(t.base, 'external-review', 'config.local.json'), '{zepsuty');
    assert.equal(t.hook('prompt'), null);
    const out = t.hook('stop');
    assert.match(out.systemMessage, /błąd/i);
  } finally { t.cleanup(); }
});

test('spec written in turn → block with pending path', () => {
  const t = setup({ fake: { FAKE_CODEX_MODE: 'findings', FAKE_CODEX_FINDINGS: JSON.stringify([FINDING]) } });
  try {
    t.hook('prompt');
    t.write('docs/specs/x-spec.md', '# Spec\n\nTreść.\n');
    const out = t.hook('stop');
    assert.equal(out.decision, 'block');
    assert.ok(out.reason.includes(toSlash(path.join(t.stateDir, 'pending-spec.json'))), out.reason);
    assert.ok(!out.reason.includes('TAJNY-PROBLEM'), 'reason must not contain finding text');
    const p = readPending(t.stateDir, 'spec');
    assert.equal(p.findings.length, 1);
    assert.equal(p.findings[0].file, 'docs/specs/x-spec.md');
    assert.equal(p.findings[0].round, 1);
    assert.equal(t.state().files['docs/specs/x-spec.md'].stage, 'spec');
  } finally { t.cleanup(); }
});

test('no findings → systemMessage, files marked reviewed', () => {
  const t = setup();
  try {
    t.hook('prompt');
    const content = lines(25);
    t.write('src/a.js', content);
    t.tool('src/a.js');
    const out = t.hook('stop');
    assert.ok(out.systemMessage, JSON.stringify(out));
    assert.equal(out.decision, undefined);
    const f = t.state().files['src/a.js'];
    assert.equal(f.reviewedHash, sha256(content));
    assert.equal(f.rounds, 0); // brak uwag → licznik rund wyzerowany
    assert.equal(f.stage, 'code');
    assert.ok(fs.existsSync(blobPath(t.stateDir, f.reviewedHash)));
    assert.deepEqual(t.state().outstanding, []);
    assert.deepEqual(t.state().codexPids, []);
    assert.equal(t.state().failures.consecutive, 0);
  } finally { t.cleanup(); }
});

test('8.3/symlink alias in hook cwd and tool file_path: same state, root-relative path', (tc) => {
  const t = setup();
  try {
    const alias = pathAlias(t.repo);
    if (!alias) { tc.skip('no 8.3 names or symlinks here'); return; }
    t.hook('prompt', { cwd: alias });
    const content = lines(25);
    t.write('src/a.js', content);
    t.hook('tool', { cwd: alias, tool_input: { file_path: path.join(alias, 'src', 'a.js'), content: '' } });
    t.hook('tool', { tool_input: { file_path: path.join(alias, 'src', 'b.js'), content: '' } });
    assert.deepEqual(t.state().sessions['sess-1'].touched, ['src/a.js', 'src/b.js']);
    const out = t.hook('stop', { cwd: alias });
    assert.ok(out.systemMessage, JSON.stringify(out));
    assert.equal(t.state().files['src/a.js'].reviewedHash, sha256(content));
  } finally { t.cleanup(); }
});

test('stop_hook_active → candidates to outstanding, no codex call', () => {
  const t = setup();
  try {
    t.hook('prompt');
    t.write('src/a.js', lines(25));
    t.tool('src/a.js');
    assert.equal(t.hook('active'), null);
    assert.deepEqual(t.state().outstanding, ['src/a.js']);
    assert.equal(t.callCount(), 0);
  } finally { t.cleanup(); }
});

test('enabled false → no output', () => {
  const t = setup({ config: { enabled: false } });
  try {
    t.hook('prompt');
    t.write('src/a.js', lines(25));
    t.tool('src/a.js');
    assert.equal(t.hook('stop'), null);
    assert.equal(t.callCount(), 0);
  } finally { t.cleanup(); }
});

test('code below threshold → no review, outstanding kept; next turn reaches 20 → review', () => {
  const t = setup();
  try {
    t.hook('prompt');
    t.write('src/a.js', lines(10, 'a')); // wykryty przez git status (bez PostToolUse)
    assert.equal(t.hook('stop'), null);
    assert.equal(t.callCount(), 0);
    assert.deepEqual(t.state().outstanding, ['src/a.js']);
    t.hook('prompt');
    t.write('src/b.js', lines(10, 'b'));
    const out = t.hook('stop');
    assert.ok(out.systemMessage);
    assert.equal(t.callCount(), 1);
    const s = t.state();
    assert.deepEqual(s.outstanding, []);
    assert.ok(s.files['src/a.js'].reviewedHash);
    assert.ok(s.files['src/b.js'].reviewedHash);
  } finally { t.cleanup(); }
});

test('spec and plan in one turn reviewed in parallel', () => {
  const SLEEP = 3000;
  const t = setup({ fake: { FAKE_CODEX_SLEEP_MATCH: 'MATERIAL', FAKE_CODEX_SLEEP_MS: String(SLEEP) } });
  try {
    t.hook('prompt');
    t.write('docs/specs/x-spec.md', '# Spec\n');
    t.write('docs/plans/x-plan.md', '# Plan\n');
    const t0 = Date.now();
    const out = t.hook('stop');
    const elapsed = Date.now() - t0;
    assert.ok(out.systemMessage);
    const ls = t.callLines().map((l) => l.split(' '));
    const starts = ls.filter((l) => l[0] === 'start').map((l) => Number(l[1]));
    const ends = ls.filter((l) => l[0] === 'end').map((l) => Number(l[1]));
    assert.equal(starts.length, 2);
    assert.equal(ends.length, 2);
    assert.ok(Math.max(...starts) < Math.min(...ends), 'calls overlap');
    assert.ok(elapsed < 2 * SLEEP, `elapsed ${elapsed}`);
    const s = t.state();
    assert.equal(s.files['docs/specs/x-spec.md'].stage, 'spec');
    assert.equal(s.files['docs/plans/x-plan.md'].stage, 'plan');
  } finally { t.cleanup(); }
});

test('deadline: sleeping codex killed, successful results saved', async () => {
  const t = setup({
    config: { hookTimeoutSec: 5, codexTimeoutSec: 600 },
    fake: { FAKE_CODEX_SLEEP_MATCH: 'SPIACY-ZNACZNIK', FAKE_CODEX_SLEEP_MS: '60000' },
  });
  try {
    t.hook('prompt');
    t.write('docs/specs/x-spec.md', '# Spec SPIACY-ZNACZNIK\n');
    t.write('docs/plans/x-plan.md', '# Plan\n');
    const t0 = Date.now();
    const out = t.hook('stop');
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 9000, `elapsed ${elapsed}`);
    assert.match(out.systemMessage, /timeout/);
    const s = t.state();
    assert.ok(s.files['docs/plans/x-plan.md']?.reviewedHash, 'plan result saved');
    assert.equal(s.files['docs/specs/x-spec.md'], undefined);
    assert.deepEqual(s.outstanding, ['docs/specs/x-spec.md']);
    assert.deepEqual(s.codexPids, []);
    const ls = t.callLines().map((l) => l.split(' '));
    const ended = new Set(ls.filter((l) => l[0] === 'end').map((l) => l[2]));
    const sleeping = ls.filter((l) => l[0] === 'start' && !ended.has(l[2])).map((l) => Number(l[2]));
    assert.equal(sleeping.length, 1);
    assert.ok(await waitDead(sleeping[0]), 'sleeping codex killed');
  } finally { t.cleanup(); }
});

test('orphaned codexPids killed on next Stop; stale, legacy and live-owner entries spared', async () => {
  const t = setup();
  const sleeper = () => spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { detached: true, stdio: 'ignore' });
  const DEAD_HOOK = 2 ** 30; // PID, który nie istnieje
  const orphan = sleeper(); // młody wpis, martwy hook, obraz node → zabijany
  const owned = sleeper(); // żywy hook (tu: proces testu) → zostaje
  const stale = sleeper(); // wpis starszy niż hookTimeoutSec + 60 s → usuwany bez zabijania
  const legacy = sleeper(); // stary format (sama liczba) → usuwany bez zabijania
  const exited = new Promise((r) => orphan.on('exit', r));
  try {
    const now = Date.now();
    const ownedEntry = { pid: owned.pid, hookPid: process.pid, startedAt: now };
    await withState(t.stateDir, (s) => {
      s.codexPids = [
        { pid: orphan.pid, hookPid: DEAD_HOOK, startedAt: now - 1000 },
        ownedEntry,
        { pid: stale.pid, hookPid: DEAD_HOOK, startedAt: now - (900 + 61) * 1000 },
        legacy.pid,
      ];
    });
    t.hook('stop');
    const res = await Promise.race([exited.then(() => 'dead'), new Promise((r) => setTimeout(() => r('alive'), 5000))]);
    assert.equal(res, 'dead');
    assert.ok(alive(owned.pid), 'live-owner entry not killed');
    assert.ok(alive(stale.pid), 'stale entry not killed');
    assert.ok(alive(legacy.pid), 'legacy entry not killed');
    assert.deepEqual(t.state().codexPids, [ownedEntry]);
  } finally {
    for (const c of [orphan, owned, stale, legacy]) { try { process.kill(c.pid); } catch { /* gone */ } }
    t.cleanup();
  }
});

test('young orphan with non-codex image is dropped, not killed', { skip: process.platform !== 'win32' && !fs.existsSync('/bin/sleep') }, async () => {
  const t = setup();
  // Proces o obrazie spoza listy (win32: ping.exe, POSIX: sleep) — symuluje ponownie użyty PID.
  const other = process.platform === 'win32'
    ? spawn('ping', ['-n', '60', '127.0.0.1'], { detached: true, stdio: 'ignore', windowsHide: true })
    : spawn('/bin/sleep', ['60'], { detached: true, stdio: 'ignore' });
  try {
    await withState(t.stateDir, (s) => {
      s.codexPids = [{ pid: other.pid, hookPid: 2 ** 30, startedAt: Date.now() }];
    });
    t.hook('stop');
    assert.ok(alive(other.pid), 'unrelated process not killed');
    assert.deepEqual(t.state().codexPids, []);
  } finally {
    try { process.kill(other.pid); } catch { /* gone */ }
    t.cleanup();
  }
});

test('two consecutive failures trigger backoff', () => {
  const t = setup({ fake: { FAKE_CODEX_MODE: 'exit1' } });
  try {
    t.hook('prompt');
    t.write('src/a.js', lines(25));
    t.tool('src/a.js');
    let out = t.hook('stop');
    assert.match(out.systemMessage, /nie powiodła/);
    assert.equal(t.state().failures.consecutive, 1);
    out = t.hook('stop');
    assert.equal(t.state().failures.consecutive, 2);
    assert.equal(t.callCount(), 2);
    out = t.hook('stop');
    assert.match(out.systemMessage, /wstrzymana/);
    assert.equal(t.callCount(), 2);
    assert.deepEqual(t.state().outstanding, ['src/a.js']);
  } finally { t.cleanup(); }
});

test('success resets failure counter', () => {
  const t = setup({ fake: { FAKE_CODEX_MODE: 'bad-json' } });
  try {
    t.hook('prompt');
    t.write('src/a.js', lines(25));
    t.tool('src/a.js');
    t.hook('stop');
    assert.equal(t.state().failures.consecutive, 1);
    t.env.FAKE_CODEX_MODE = 'ok';
    t.hook('stop');
    const s = t.state();
    assert.equal(s.failures.consecutive, 0);
    assert.ok(s.files['src/a.js'].reviewedHash);
    assert.deepEqual(s.outstanding, []);
  } finally { t.cleanup(); }
});

test('missing codex warns once per session', () => {
  const t = setup({ config: { codexPath: path.join(TMP, 'brak-codexa-xyz', 'codex') } });
  try {
    t.hook('prompt');
    t.write('src/a.js', lines(25));
    t.tool('src/a.js');
    const out = t.hook('stop');
    assert.match(out.systemMessage, /Codex/);
    assert.equal(t.hook('stop'), null);
    const s = t.state();
    assert.deepEqual(s.outstanding, ['src/a.js']);
    assert.equal(s.sessions['sess-1'].warnedMissingCodex, true);
    assert.equal(s.failures.consecutive, 0);
  } finally { t.cleanup(); }
});

test('codex modifying files → warning in reason, files not candidates next turn', () => {
  const t = setup({ files: { 'src/other.js': 'const o = 1;\n' } });
  try {
    Object.assign(t.env, {
      FAKE_CODEX_MODE: 'modify',
      FAKE_CODEX_MODIFY: path.join(t.repo, 'src', 'other.js'),
      FAKE_CODEX_FINDINGS: JSON.stringify([FINDING]),
    });
    t.hook('prompt');
    t.write('src/a.js', lines(25));
    t.tool('src/a.js');
    const out = t.hook('stop');
    assert.equal(out.decision, 'block');
    assert.match(out.reason, /src\/other\.js/);
    t.env.FAKE_CODEX_MODE = 'ok';
    t.hook('prompt');
    t.hook('stop');
    assert.equal(t.callCount(), 1);
    const s = t.state();
    assert.ok(!s.outstanding.includes('src/other.js'));
    assert.equal(s.files['src/other.js'], undefined);
  } finally { t.cleanup(); }
});

test('reviewedHash equals content before codex call', () => {
  const t = setup();
  try {
    const content = lines(25);
    Object.assign(t.env, { FAKE_CODEX_MODE: 'modify', FAKE_CODEX_MODIFY: path.join(t.repo, 'src', 'a.js') });
    t.hook('prompt');
    t.write('src/a.js', content);
    t.tool('src/a.js');
    t.hook('stop');
    const f = t.state().files['src/a.js'];
    assert.equal(f.reviewedHash, sha256(content));
    assert.notEqual(fs.readFileSync(path.join(t.repo, 'src', 'a.js'), 'utf8'), content);
    // Zmiana Codexa nie jest zmianą Claude'a: brak kolejnej recenzji w następnej turze.
    t.env.FAKE_CODEX_MODE = 'ok';
    t.hook('prompt');
    t.hook('stop');
    assert.equal(t.callCount(), 1);
    assert.ok(!t.state().outstanding.includes('src/a.js'));
    assert.ok(!t.state().sessions['sess-1'].touched.includes('src/a.js'));
  } finally { t.cleanup(); }
});

test('maxReviewRounds reached → marked reviewed with warning', () => {
  const t = setup({ config: { maxReviewRounds: 1 }, fake: { FAKE_CODEX_MODE: 'findings', FAKE_CODEX_FINDINGS: JSON.stringify([FINDING]) } });
  try {
    t.hook('prompt');
    t.write('src/a.js', lines(25));
    t.tool('src/a.js');
    t.hook('stop');
    assert.equal(t.state().files['src/a.js'].rounds, 1);
    t.hook('prompt');
    const next = lines(25) + lines(5, 'x');
    t.write('src/a.js', next);
    t.tool('src/a.js');
    const out = t.hook('stop');
    assert.match(out.systemMessage, /limit rund/);
    assert.match(out.systemMessage, /src\/a\.js/);
    assert.equal(t.callCount(), 1);
    const f = t.state().files['src/a.js'];
    assert.equal(f.reviewedHash, sha256(next));
    assert.ok(fs.existsSync(blobPath(t.stateDir, f.reviewedHash)));
  } finally { t.cleanup(); }
});

test('deleted file removed from state', () => {
  const t = setup();
  try {
    t.hook('prompt');
    t.write('src/a.js', lines(25));
    t.tool('src/a.js');
    t.hook('stop');
    assert.ok(t.state().files['src/a.js']);
    t.hook('prompt');
    fs.rmSync(path.join(t.repo, 'src', 'a.js'));
    t.tool('src/a.js');
    assert.equal(t.hook('stop'), null);
    const s = t.state();
    assert.equal(s.files['src/a.js'], undefined);
    assert.ok(!s.outstanding.includes('src/a.js'));
    assert.equal(t.callCount(), 1);
  } finally { t.cleanup(); }
});

test('outside git: new code file reviewed in full', () => {
  const t = setup({ git: false });
  try {
    t.hook('prompt');
    t.write('a.js', lines(25));
    t.tool('a.js');
    const out = t.hook('stop');
    assert.ok(out.systemMessage);
    assert.ok(t.state().files['a.js'].reviewedHash);
  } finally { t.cleanup(); }
});

test('processImage: lookup timeout or failure → null; real process → image name', () => {
  for (const platform of ['win32', 'linux']) {
    let seen = null;
    const timedOut = (cmd, args, opts) => { seen = opts; return { error: Object.assign(new Error('spawnSync ETIMEDOUT'), { code: 'ETIMEDOUT' }), status: null, stdout: '' }; };
    assert.equal(processImage(1234, platform, timedOut), null);
    assert.equal(seen.timeout, 5000);
    assert.equal(seen.windowsHide, true);
    assert.equal(processImage(1234, platform, () => ({ status: 1, stdout: '' })), null);
    assert.equal(processImage(1234, platform, () => { throw new Error('boom'); }), null);
  }
  assert.equal(processImage(2 ** 30), null); // nieistniejący PID
  assert.match(processImage(process.pid), /^node(\.exe)?$/);
});

test('orphan entry whose process cannot be looked up is dropped, nothing killed', async () => {
  const t = setup();
  try {
    await withState(t.stateDir, (s) => {
      s.codexPids = [{ pid: 2 ** 30, hookPid: 2 ** 30 + 1, startedAt: Date.now() }];
    });
    t.hook('stop');
    assert.deepEqual(t.state().codexPids, []);
  } finally { t.cleanup(); }
});

test('repeated reviews without findings: codex every turn, no round note, rounds stay 0', () => {
  const t = setup();
  try {
    const log = path.join(t.base, 'prompt.log');
    t.env.FAKE_CODEX_LOG = log;
    let content = '';
    for (let i = 1; i <= 4; i++) {
      t.hook('prompt');
      content += lines(25, `t${i}_`);
      t.write('src/a.js', content);
      t.tool('src/a.js');
      const out = t.hook('stop');
      assert.match(out.systemMessage, /brak nowych uwag/, `turn ${i}`);
      assert.equal(t.callCount(), i, `turn ${i}`);
      assert.ok(!fs.readFileSync(log, 'utf8').includes('ponowna recenzja'), `turn ${i}: no round note`);
      assert.equal(t.state().files['src/a.js'].rounds, 0);
    }
  } finally { t.cleanup(); }
});

test('findings → fix → re-review gets round note; round limit still enforced for fix loops', () => {
  const t = setup({ config: { maxReviewRounds: 2 }, fake: { FAKE_CODEX_MODE: 'findings', FAKE_CODEX_FINDINGS: JSON.stringify([FINDING]) } });
  try {
    const log = path.join(t.base, 'prompt.log');
    t.env.FAKE_CODEX_LOG = log;
    t.hook('prompt');
    let content = lines(25, 'a');
    t.write('src/a.js', content);
    t.tool('src/a.js');
    assert.equal(t.hook('stop').decision, 'block');
    assert.ok(!fs.readFileSync(log, 'utf8').includes('ponowna recenzja'));
    assert.equal(t.state().files['src/a.js'].rounds, 1);
    t.hook('prompt');
    content += lines(25, 'b');
    t.write('src/a.js', content);
    t.tool('src/a.js');
    assert.equal(t.hook('stop').decision, 'block');
    assert.ok(fs.readFileSync(log, 'utf8').includes('ponowna recenzja'));
    assert.equal(t.state().files['src/a.js'].rounds, 2);
    t.hook('prompt');
    content += lines(25, 'c');
    t.write('src/a.js', content);
    t.tool('src/a.js');
    assert.match(t.hook('stop').systemMessage, /limit rund/);
    assert.equal(t.callCount(), 2);
  } finally { t.cleanup(); }
});

// Uruchamia fn z fs.writeFileSync rzucającym przy zapisie plików pending (appendRound zawodzi).
async function withPendingWriteFailure(fn) {
  const orig = fs.writeFileSync;
  fs.writeFileSync = function patched(p, ...rest) {
    if (/pending-(spec|plan|code)\.json/.test(String(p))) throw Object.assign(new Error('ENOSPC: no space left'), { code: 'ENOSPC' });
    return orig.call(this, p, ...rest);
  };
  try { return await fn(); } finally { fs.writeFileSync = orig; }
}

test('pending write failure: findings not lost — file stays outstanding, not marked reviewed', async () => {
  const t = setup({ fake: { FAKE_CODEX_MODE: 'findings', FAKE_CODEX_FINDINGS: JSON.stringify([FINDING]) } });
  const saved = {};
  for (const k of ['FAKE_CODEX_MODE', 'FAKE_CODEX_FINDINGS', 'FAKE_CODEX_CALLS']) { saved[k] = process.env[k]; process.env[k] = t.env[k]; }
  try {
    t.hook('prompt');
    t.write('src/a.js', lines(25));
    t.tool('src/a.js');
    const ctx = makeContext(t.repo, t.env);
    const out = await withPendingWriteFailure(() => runStop({ ...fixture('stop'), cwd: t.repo }, ctx));
    assert.equal(t.callCount(), 1);
    assert.equal(out.decision, undefined);
    assert.match(out.systemMessage, /Nie udało się zapisać uwag/);
    const s = t.state();
    assert.equal(s.files['src/a.js'], undefined, 'not marked reviewed');
    assert.deepEqual(s.outstanding, ['src/a.js']);
    // Następny Stop recenzuje plik ponownie i zapisuje uwagi.
    const again = t.hook('stop');
    assert.equal(again.decision, 'block');
    assert.equal(readPending(t.stateDir, 'code').findings.length, 1);
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    t.cleanup();
  }
});

test('binary file: warned once, marked reviewed without blob, dropped from outstanding', () => {
  const t = setup();
  try {
    t.hook('prompt');
    t.write('src/img.bin', Buffer.from([0x89, 0x50, 0x00, 0x01, 0x02, 0x00, 0xff]));
    t.tool('src/img.bin');
    const out = t.hook('stop');
    assert.match(out.systemMessage, /binarn/);
    assert.match(out.systemMessage, /src\/img\.bin/);
    assert.equal(t.callCount(), 0);
    let s = t.state();
    assert.equal(s.files['src/img.bin'].reviewedHash, fileHash(t.repo, 'src/img.bin'));
    assert.deepEqual(s.outstanding, []);
    t.hook('prompt');
    assert.equal(t.hook('stop'), null, 'no repeated warning');
    s = t.state();
    assert.deepEqual(s.outstanding, []);
  } finally { t.cleanup(); }
});

test('single file over maxReviewBytes: warned once, marked reviewed, not reviewed by codex', () => {
  const t = setup({ config: { maxReviewBytes: 1000 } });
  try {
    t.hook('prompt');
    t.write('src/big.js', lines(100));
    t.write('src/small.js', lines(25, 's'));
    t.tool('src/big.js');
    t.tool('src/small.js');
    const out = t.hook('stop');
    assert.match(out.systemMessage, /src\/big\.js/);
    assert.match(out.systemMessage, /maxReviewBytes|limit/);
    assert.equal(t.callCount(), 1); // tylko small.js
    let s = t.state();
    assert.equal(s.files['src/big.js'].reviewedHash, sha256(lines(100)));
    assert.ok(s.files['src/small.js'].reviewedHash);
    assert.deepEqual(s.outstanding, []);
    t.hook('prompt');
    assert.equal(t.hook('stop'), null, 'no repeated warning');
    assert.equal(t.callCount(), 1);
  } finally { t.cleanup(); }
});

test('enabled false → prompt and tool hooks do not record state', () => {
  const t = setup({ config: { enabled: false } });
  try {
    t.hook('prompt');
    t.write('src/a.js', lines(25));
    t.tool('src/a.js');
    assert.equal(fs.existsSync(path.join(t.stateDir, 'state.json')), false);
  } finally { t.cleanup(); }
});

test('files edited by Claude tools while Codex runs are not attributed to Codex', async () => {
  const t = setup({ files: { 'src/b.js': 'const b = 1;\n' }, fake: { FAKE_CODEX_MODE: 'sleep', FAKE_CODEX_SLEEP_MS: '2500' } });
  try {
    t.hook('prompt');
    t.write('src/a.js', lines(25));
    t.tool('src/a.js');
    const hookJs = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'external-review', 'hook.mjs');
    const child = spawn(process.execPath, [hookJs, '--event', 'stop'], { env: t.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stdin.end(JSON.stringify({ ...fixture('stop'), cwd: t.repo }));
    const done = new Promise((r) => child.on('close', r));
    // W trakcie recenzji Claude (lub jego agent) edytuje kolejny plik.
    for (let i = 0; i < 100 && t.callCount() === 0; i++) await new Promise((r) => setTimeout(r, 50));
    t.write('src/b.js', lines(30, 'b'));
    t.tool('src/b.js');
    await done;
    assert.doesNotMatch(out, /Codex zmienił pliki[^"]*src\/b\.js/, 'no "Codex zmienił" warning for a Claude edit');
    const sess = t.state().sessions['sess-1'];
    assert.ok(sess.touched.includes('src/b.js'), 'Claude edit stays tracked for the next review');
  } finally { t.cleanup(); }
});

test('file edited by both Claude tools and Codex during the review: ambiguous warning, stays tracked', async () => {
  const t = setup({ files: { 'src/b.js': 'const b = 1;\n' } });
  try {
    Object.assign(t.env, { FAKE_CODEX_MODE: 'modify', FAKE_CODEX_MODIFY: path.join(t.repo, 'src', 'b.js'), FAKE_CODEX_EVENT_MS: '400' });
    t.hook('prompt');
    t.write('src/a.js', lines(25));
    t.tool('src/a.js');
    const hookJs = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'external-review', 'hook.mjs');
    const child = spawn(process.execPath, [hookJs, '--event', 'stop'], { env: t.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stdin.end(JSON.stringify({ ...fixture('stop'), cwd: t.repo }));
    const done = new Promise((r) => child.on('close', r));
    for (let i = 0; i < 100 && t.callCount() === 0; i++) await new Promise((r) => setTimeout(r, 50));
    t.write('src/b.js', lines(30, 'b'));
    t.tool('src/b.js');
    await done;
    assert.doesNotMatch(out, /Codex zmienił pliki[^"]*src\/b\.js/);
    assert.match(out, /zmienione w trakcie recenzji[^"]*src\/b\.js/);
    assert.ok(t.state().sessions['sess-1'].touched.includes('src/b.js'));
  } finally { t.cleanup(); }
});
