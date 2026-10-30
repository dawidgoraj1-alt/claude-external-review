import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fakeCodexPath, makeEnv, makeRepo } from '../test-support/helpers.mjs';
import { canonical, toSlash } from '../src/external-review/lib/paths.mjs';
import { liveDir } from '../src/external-review/lib/live.mjs';

const TMP = canonical(os.tmpdir());
const here = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.resolve(here, '..', 'src', 'external-review', 'hook.mjs');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function setup() {
  const { env, base, cleanup } = makeEnv();
  const repo = canonical(makeRepo({ files: { 'src/a.js': 'const a = 1;\n'.repeat(50) } }));
  fs.mkdirSync(path.join(base, 'external-review'), { recursive: true });
  fs.writeFileSync(path.join(base, 'external-review', 'config.local.json'), JSON.stringify({ codexPath: fakeCodexPath(base) }));
  Object.assign(env, { GIT_CEILING_DIRECTORIES: TMP, FAKE_CODEX_MODE: 'sleep', FAKE_CODEX_SLEEP_MS: '3500', FAKE_CODEX_EVENT_MS: '10' });
  return { env, base, repo, cleanup };
}
const liveFiles = (env) => { try { return fs.readdirSync(liveDir(env)).filter((n) => n.endsWith('.json')); } catch { return []; } };

async function runAndWatch(args, input, t) {
  const child = spawn(process.execPath, [HOOK, ...args], { env: t.env, cwd: t.repo, stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = new Promise((r) => child.on('close', r));
  child.stdin.end(input);
  let seen = null;
  const until = Date.now() + 20000;
  while (Date.now() < until && !seen) {
    const f = liveFiles(t.env)[0];
    if (f) {
      try {
        const j = JSON.parse(fs.readFileSync(path.join(liveDir(t.env), f), 'utf8'));
        if (j.action && j.tokens > 0) seen = j;
      } catch { /* w trakcie zapisu */ }
    }
    await wait(50);
  }
  const code = await exited;
  return { seen, code };
}

test('manual review publishes a live file while Codex runs and removes it after', async () => {
  const t = setup();
  try {
    const { seen, code } = await runAndWatch(['--manual', '--cwd', t.repo, 'src/a.js'], '', t);
    assert.equal(code, 0);
    assert.ok(seen, 'live file with action and tokens appeared');
    assert.equal(seen.root, toSlash(t.repo));
    assert.deepEqual(seen.stages, ['code']);
    assert.deepEqual(seen.files, ['src/a.js']);
    assert.equal(seen.tokens, 1200);
    assert.deepEqual(liveFiles(t.env), []);
  } finally { t.cleanup(); }
});

test('stop hook publishes a live file while Codex runs and removes it after', async () => {
  const t = setup();
  try {
    const fx = (n) => fs.readFileSync(path.join(here, 'fixtures', 'stdin', `${n}.json`), 'utf8');
    const run = (ev, input) => new Promise((res) => {
      const c = spawn(process.execPath, [HOOK, '--event', ev], { env: t.env, cwd: t.repo, stdio: ['pipe', 'ignore', 'ignore'] });
      c.stdin.end(input); c.on('close', res);
    });
    await run('prompt', JSON.stringify({ ...JSON.parse(fx('prompt')), cwd: t.repo }));
    fs.writeFileSync(path.join(t.repo, 'src', 'a.js'), 'const b = 2;\n'.repeat(80));
    await run('tool', JSON.stringify({ ...JSON.parse(fx('tool-write')), cwd: t.repo, tool_input: { file_path: path.join(t.repo, 'src', 'a.js') } }));
    const { seen } = await runAndWatch(['--event', 'stop'], JSON.stringify({ ...JSON.parse(fx('stop')), cwd: t.repo }), t);
    assert.ok(seen, 'live file appeared during stop review');
    assert.deepEqual(liveFiles(t.env), []);
  } finally { t.cleanup(); }
});
