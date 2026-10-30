import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildArgs, readWindowsOverrides, resolveCodex, runCodex, killTree } from '../src/external-review/lib/codex.mjs';
import { loadConfig } from '../src/external-review/lib/config.mjs';
import { fakeCodexPath } from '../test-support/helpers.mjs';

const cfg = loadConfig({ CLAUDE_CONFIG_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'er-c-')) });
const schemaPath = path.resolve('src/external-review/schema/findings.json');

function setup(modeEnv = {}, cwdName = 'cwd') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'er-cx-'));
  const cwd = path.join(dir, cwdName);
  fs.mkdirSync(cwd);
  const outPath = path.join(dir, 'out.json');
  const codexPath = fakeCodexPath(dir);
  Object.assign(process.env, {
    FAKE_CODEX_LOG: path.join(dir, 'prompt.txt'),
    FAKE_CODEX_ARGS: path.join(dir, 'args.json'),
    FAKE_CODEX_PID: path.join(dir, 'pid.txt'),
  }, modeEnv);
  const args = buildArgs(cfg, { cwd, schemaPath, outPath, overrides: [] });
  return { dir, cwd, outPath, codexPath, args };
}
function reset() {
  for (const k of Object.keys(process.env)) if (k.startsWith('FAKE_CODEX_')) delete process.env[k];
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('buildArgs contains required flags in order', () => {
  const a = buildArgs(cfg, { cwd: '/p', schemaPath: '/s.json', outPath: '/o.json', overrides: ['windows.sandbox="unelevated"'] });
  assert.deepEqual(a, ['exec', '-m', 'gpt-6-sol', '-c', 'model_reasoning_effort=medium', '--ignore-user-config',
    '-c', 'windows.sandbox="unelevated"', '--color', 'never', '-s', 'workspace-write', '--ephemeral',
    '--skip-git-repo-check', '--json', '-C', '/p', '--output-schema', '/s.json', '-o', '/o.json', '-']);
});
test('buildArgs omits -m when model null', () => {
  const a = buildArgs({ ...cfg, model: null }, { cwd: '/p', schemaPath: 's', outPath: 'o', overrides: [] });
  assert.ok(!a.includes('-m'));
  assert.deepEqual(a.slice(0, 3), ['exec', '-c', 'model_reasoning_effort=medium']);
});
test('readWindowsOverrides parses [windows] table', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'er-home-'));
  fs.writeFileSync(path.join(home, 'config.toml'), 'model = "x"\n[windows]\n# c\nsandbox = "unelevated"  # kom\n[other]\nsandbox = "no"\n');
  assert.deepEqual(readWindowsOverrides(home), ['windows.sandbox="unelevated"']);
  assert.deepEqual(readWindowsOverrides(path.join(home, 'nope')), []);
});
test('resolveCodex finds executable in PATH, null when missing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'er-rc-'));
  const win = process.platform === 'win32';
  const f = path.join(dir, win ? 'mycodex.exe' : 'mycodex');
  fs.writeFileSync(f, '');
  if (win) fs.writeFileSync(path.join(dir, 'mycodex.cmd'), '');
  assert.equal(resolveCodex('mycodex', { PATH: dir, PATHEXT: '.CMD;.EXE' }), path.resolve(f));
  assert.equal(resolveCodex('nonexistent-zzz', { PATH: dir }), null);
});
test('resolveCodex win32 npm layout prefers codex.cmd over extensionless shim', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'er-npm-'));
  for (const n of ['codex', 'codex.cmd', 'codex.ps1']) fs.writeFileSync(path.join(dir, n), '');
  const env = { PATH: dir, PATHEXT: '.COM;.EXE;.BAT;.CMD' };
  assert.equal(resolveCodex('codex', env, 'win32'), path.resolve(dir, 'codex.cmd'));
  assert.equal(resolveCodex('codex.cmd', env, 'win32'), path.resolve(dir, 'codex.cmd'));
});
test('.cmd shim: metacharacters in cwd and overrides are not interpreted', async () => {
  const s = setup({ FAKE_CODEX_MODE: 'ok' }, 'a&b %PATH% c^d');
  const override = 'windows.v="a&echo X>pwn.txt&rem "';
  const args = buildArgs(cfg, { cwd: s.cwd, schemaPath, outPath: s.outPath, overrides: [override, 'k=%PATH%'] });
  try {
    const r = await runCodex({ codexPath: s.codexPath, args, prompt: 'x', timeoutMs: 20000 });
    assert.equal(r.ok, true, r.error);
    const seen = JSON.parse(fs.readFileSync(process.env.FAKE_CODEX_ARGS, 'utf8'));
    assert.deepEqual(seen.argv, args);
    assert.equal(seen.cwd, s.cwd);
    for (const d of [process.cwd(), s.cwd, s.dir]) assert.equal(fs.existsSync(path.join(d, 'pwn.txt')), false);
  } finally { reset(); }
});
test('runCodex ok returns findings',async () => {
  const s = setup({ FAKE_CODEX_MODE: 'ok' });
  try {
    const r = await runCodex({ codexPath: s.codexPath, args: s.args, prompt: 'hej', timeoutMs: 20000 });
    assert.deepEqual(r, { ok: true, result: { summary: 'ok', findings: [] } });
    assert.equal(fs.readFileSync(process.env.FAKE_CODEX_LOG, 'utf8'), 'hej');
  } finally { reset(); }
});
test('runCodex bad-json and exit1 return ok:false', async () => {
  for (const mode of ['bad-json', 'exit1']) {
    const s = setup({ FAKE_CODEX_MODE: mode });
    try {
      const r = await runCodex({ codexPath: s.codexPath, args: s.args, prompt: 'x', timeoutMs: 20000 });
      assert.equal(r.ok, false, mode);
      assert.ok(r.error);
    } finally { reset(); }
  }
});
test('runCodex rejects JSON not matching schema', async () => {
  const bad = { summary: 's', findings: [{ id: 1, severity: 'huge', location: 'a', problem: 'p', suggestion: 's' }] };
  const s = setup({ FAKE_CODEX_MODE: 'findings', FAKE_CODEX_FINDINGS: JSON.stringify(bad) });
  try {
    const r = await runCodex({ codexPath: s.codexPath, args: s.args, prompt: 'x', timeoutMs: 20000 });
    assert.equal(r.ok, false);
  } finally { reset(); }
});
test('runCodex timeout kills process tree', async () => {
  const s = setup({ FAKE_CODEX_MODE: 'sleep', FAKE_CODEX_SLEEP_MS: '10000' });
  try {
    let spawned;
    const r = await runCodex({ codexPath: s.codexPath, args: s.args, prompt: 'x', timeoutMs: 2000, onSpawn: (p) => { spawned = p; } });
    assert.equal(r.ok, false);
    assert.match(r.error, /timeout/);
    await new Promise((res) => setTimeout(res, 500));
    assert.ok(spawned);
    assert.equal(alive(spawned), false);
    const pidFile = process.env.FAKE_CODEX_PID;
    assert.ok(fs.existsSync(pidFile), 'fake codex should have started within the timeout');
    assert.equal(alive(Number(fs.readFileSync(pidFile, 'utf8'))), false);
  } finally { reset(); }
});
test('runCodex handles BOM, CRLF and Polish characters', async () => {
  const s = setup({ FAKE_CODEX_MODE: 'bom' });
  try {
    const r = await runCodex({ codexPath: s.codexPath, args: s.args, prompt: 'Zażółć gęślą jaźń', timeoutMs: 20000 });
    assert.equal(r.ok, true);
    assert.equal(r.result.findings[0].problem, 'Błąd w żółtym module');
    assert.equal(fs.readFileSync(process.env.FAKE_CODEX_LOG, 'utf8'), 'Zażółć gęślą jaźń');
  } finally { reset(); }
});
test('runCodex trims long fields', async () => {
  const f = [{ id: 1, severity: 'minor', location: 'l'.repeat(300), problem: 'p'.repeat(900), suggestion: 's'.repeat(900) }];
  const s = setup({ FAKE_CODEX_MODE: 'findings', FAKE_CODEX_FINDINGS: JSON.stringify({ summary: 'u'.repeat(900), findings: f }) });
  try {
    const r = await runCodex({ codexPath: s.codexPath, args: s.args, prompt: 'x', timeoutMs: 20000 });
    assert.equal(r.ok, true);
    const g = r.result.findings[0];
    assert.deepEqual([g.location.length, g.problem.length, g.suggestion.length], [200, 500, 500]);
    assert.equal(r.result.summary.length, 500);
  } finally { reset(); }
});
test('cwd with spaces and Polish characters', async () => {
  const s = setup({ FAKE_CODEX_MODE: 'ok' }, 'Mój projekt');
  try {
    const r = await runCodex({ codexPath: s.codexPath, args: s.args, prompt: 'x', timeoutMs: 20000 });
    assert.equal(r.ok, true);
    const seen = JSON.parse(fs.readFileSync(process.env.FAKE_CODEX_ARGS, 'utf8'));
    assert.equal(seen.cwd, s.cwd);
  } finally { reset(); }
});
test('killTree ignores errors for missing pid', () => {
  assert.doesNotThrow(() => killTree(99999999));
});
