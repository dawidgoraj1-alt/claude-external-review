import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { install, uninstall, preflight, copyDir } from '../install.mjs';
import { fakeCodexPath } from '../test-support/helpers.mjs';

const installMjs = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'install.mjs');

// Zawsze tymczasowy CLAUDE_CONFIG_DIR — nigdy prawdziwy ~/.claude.
function setup(baseName = 'er-inst-') {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), baseName));
  const base = path.join(tmp, 'cfg');
  fs.mkdirSync(base);
  const env = { ...process.env, CLAUDE_CONFIG_DIR: base };
  const codexCmd = fakeCodexPath(tmp);
  const opts = { codexCmd, skipPreflightCall: true };
  return { tmp, base, env, opts, cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }) };
}
const settingsFile = (base) => path.join(base, 'settings.json');
const readSettings = (base) => JSON.parse(fs.readFileSync(settingsFile(base), 'utf8'));
const hookOf = (base) => `${base.replace(/\\/g, '/')}/skills/external-review/hook.mjs`;
const allCommands = (s) => Object.values(s.hooks || {}).flat().flatMap((g) => g.hooks.map((h) => h.command));

test('preflight failure leaves no changes and exits 1', () => {
  const t = setup();
  try {
    const emptyPath = path.join(t.tmp, 'empty');
    fs.mkdirSync(emptyPath);
    const r = spawnSync(process.execPath, [installMjs, '--skip-preflight-call'], {
      env: { ...t.env, PATH: emptyPath, Path: emptyPath }, encoding: 'utf8',
    });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Codex/);
    assert.deepEqual(fs.readdirSync(t.base), []);
  } finally { t.cleanup(); }
});

test('preflight reports missing flags and failed login', async () => {
  const t = setup();
  try {
    let errs = await preflight(t.opts, { ...t.env, FAKE_CODEX_HELP_MISSING: '--ephemeral' });
    assert.ok(errs.some((e) => e.includes('--ephemeral')));
    errs = await preflight(t.opts, { ...t.env, FAKE_CODEX_LOGIN: 'fail' });
    assert.ok(errs.some((e) => /zalogowany/.test(e)));
    assert.deepEqual(await preflight(t.opts, t.env), []);
    assert.deepEqual(fs.readdirSync(t.base), []);
  } finally { t.cleanup(); }
});

test('preflight test call runs against the fake codex and failure blocks install', async () => {
  const t = setup();
  try {
    const opts = { codexCmd: t.opts.codexCmd };
    assert.deepEqual(await preflight(opts, t.env), []);
    process.env.FAKE_CODEX_MODE = 'exit1';
    const r = await install(opts, t.env);
    assert.equal(r.ok, false);
    assert.match(r.errors.join('\n'), /--codex-default-model/);
    assert.deepEqual(fs.readdirSync(t.base), []);
  } finally { delete process.env.FAKE_CODEX_MODE; t.cleanup(); }
});

test('creates settings.json when missing', async () => {
  const t = setup();
  try {
    const r = await install(t.opts, t.env);
    assert.equal(r.ok, true, r.errors.join('\n'));
    assert.ok(readSettings(t.base).hooks);
    assert.ok(fs.existsSync(path.join(t.base, 'skills', 'external-review', 'hook.mjs')));
    assert.equal(fs.readdirSync(t.base).some((f) => f.includes('.bak-')), false);
    const local = JSON.parse(fs.readFileSync(path.join(t.base, 'external-review', 'config.local.json'), 'utf8'));
    assert.ok(local.codexPath);
  } finally { t.cleanup(); }
});

test('invalid settings.json aborts without writing', async () => {
  const t = setup();
  try {
    fs.writeFileSync(settingsFile(t.base), '{ nie json');
    const r = await install(t.opts, t.env);
    assert.equal(r.ok, false);
    assert.match(r.errors[0], /niepoprawny JSON/);
    assert.equal(fs.readFileSync(settingsFile(t.base), 'utf8'), '{ nie json');
    assert.deepEqual(fs.readdirSync(t.base), ['settings.json']);
  } finally { t.cleanup(); }
});

test('adds three hook entries with statusMessage and timeout 900', async () => {
  const t = setup();
  try {
    await install(t.opts, t.env);
    const h = readSettings(t.base).hooks;
    const hook = hookOf(t.base);
    assert.deepEqual(h.UserPromptSubmit, [{ hooks: [{ type: 'command', command: `node "${hook}" --event prompt`, timeout: 30 }] }]);
    assert.deepEqual(h.PostToolUse, [{ matcher: 'Write|Edit|MultiEdit|NotebookEdit', hooks: [{ type: 'command', command: `node "${hook}" --event tool`, timeout: 30 }] }]);
    assert.deepEqual(h.Stop, [{ hooks: [{ type: 'command', command: `node "${hook}" --event stop`, timeout: 900, statusMessage: 'Codex recenzuje…' }] }]);
  } finally { t.cleanup(); }
});

test('idempotent: second install does not duplicate', async () => {
  const t = setup();
  try {
    await install(t.opts, t.env);
    const first = fs.readFileSync(settingsFile(t.base), 'utf8');
    const r = await install(t.opts, t.env);
    assert.equal(r.ok, true);
    assert.equal(fs.readFileSync(settingsFile(t.base), 'utf8'), first);
    assert.equal(allCommands(readSettings(t.base)).length, 3);
  } finally { t.cleanup(); }
});

test('keeps foreign hooks and other settings; replaces stale own entries from another BASE', async () => {
  const t = setup();
  try {
    const orig = {
      statusLine: { type: 'command', command: 'x' },
      enabledPlugins: { 'a@b': true },
      hooks: {
        Stop: [
          { hooks: [{ type: 'command', command: 'echo foreign' }] },
          { hooks: [{ type: 'command', command: 'node "C:/old/.claude/skills/external-review/hook.mjs" --event stop', timeout: 900 }] },
        ],
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'lint' }] }],
      },
    };
    fs.writeFileSync(settingsFile(t.base), JSON.stringify(orig));
    await install(t.opts, t.env);
    const s = readSettings(t.base);
    assert.deepEqual(s.statusLine, orig.statusLine);
    assert.deepEqual(s.enabledPlugins, orig.enabledPlugins);
    assert.deepEqual(s.hooks.PreToolUse, orig.hooks.PreToolUse);
    assert.equal(s.hooks.Stop.length, 2);
    assert.equal(s.hooks.Stop[0].hooks[0].command, 'echo foreign');
    assert.ok(!allCommands(s).some((c) => c.includes('C:/old')));
  } finally { t.cleanup(); }
});

test('writes backup before modifying settings', async () => {
  const t = setup();
  try {
    const original = '{"language":"pl"}';
    fs.writeFileSync(settingsFile(t.base), original);
    await install(t.opts, t.env);
    const bak = fs.readdirSync(t.base).filter((f) => f.startsWith('settings.json.bak-'));
    assert.equal(bak.length, 1);
    assert.equal(fs.readFileSync(path.join(t.base, bak[0]), 'utf8'), original);
    assert.equal(readSettings(t.base).language, 'pl');
  } finally { t.cleanup(); }
});

test('update removes stale files, keeps config.local.json and merges codexPath/model', async () => {
  const t = setup();
  try {
    await install(t.opts, t.env);
    fs.writeFileSync(path.join(t.base, 'skills', 'external-review', 'stale.txt'), 'x');
    const lp = path.join(t.base, 'external-review', 'config.local.json');
    fs.writeFileSync(lp, JSON.stringify({ maxChunks: 2, model: 'a' }));
    await install({ ...t.opts, model: 'gpt-x' }, t.env);
    assert.equal(fs.existsSync(path.join(t.base, 'skills', 'external-review', 'stale.txt')), false);
    const local = JSON.parse(fs.readFileSync(lp, 'utf8'));
    assert.equal(local.maxChunks, 2);
    assert.equal(local.model, 'gpt-x');
    assert.ok(local.codexPath);
    await install({ ...t.opts, codexDefaultModel: true }, t.env);
    assert.equal(JSON.parse(fs.readFileSync(lp, 'utf8')).model, null);
  } finally { t.cleanup(); }
});

test('substitutes absolute HOOK_PATH with forward slashes in SKILL.md', async () => {
  const t = setup();
  try {
    await install(t.opts, t.env);
    const md = fs.readFileSync(path.join(t.base, 'skills', 'external-review', 'SKILL.md'), 'utf8');
    assert.equal(md.includes('{{HOOK_PATH}}'), false);
    assert.ok(md.includes(`node "${hookOf(t.base)}" --pending`));
  } finally { t.cleanup(); }
});

test('hook command quotes path with spaces and Polish characters', async () => {
  const t = setup('er-żółw ą-');
  try {
    const r = await install(t.opts, t.env);
    assert.ok(r.ok, r.errors.join(' | '));
    const cmds = allCommands(readSettings(t.base));
    assert.equal(cmds.length, 3);
    for (const c of cmds) assert.match(c, /^node "[^"]*żółw ą[^"]*\/skills\/external-review\/hook\.mjs" --event (prompt|tool|stop)$/);
    assert.ok(!cmds.join('').includes('\\'));
  } finally { t.cleanup(); }
});

test('uninstall removes only own entries and empty arrays', async () => {
  const t = setup();
  try {
    fs.writeFileSync(settingsFile(t.base), JSON.stringify({
      statusLine: { type: 'command', command: 'x' },
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo foreign' }] }] },
    }));
    await install(t.opts, t.env);
    const r = await uninstall({}, t.env);
    assert.equal(r.ok, true);
    const s = readSettings(t.base);
    assert.deepEqual(s.hooks, { Stop: [{ hooks: [{ type: 'command', command: 'echo foreign' }] }] });
    assert.equal(s.statusLine.command, 'x');
    assert.equal(fs.existsSync(path.join(t.base, 'skills', 'external-review')), false);
    assert.equal(fs.existsSync(path.join(t.base, 'external-review', 'config.local.json')), true);
  } finally { t.cleanup(); }
});

test('uninstall drops hooks key when nothing foreign remains', async () => {
  const t = setup();
  try {
    await install(t.opts, t.env);
    await uninstall({}, t.env);
    assert.equal('hooks' in readSettings(t.base), false);
  } finally { t.cleanup(); }
});

test('purge removes BASE/external-review', async () => {
  const t = setup();
  try {
    await install(t.opts, t.env);
    fs.mkdirSync(path.join(t.base, 'external-review', 'state'), { recursive: true });
    await uninstall({ purge: true }, t.env);
    assert.equal(fs.existsSync(path.join(t.base, 'external-review')), false);
  } finally { t.cleanup(); }
});

test('aborts when the source overlaps the target (repo cloned into BASE/skills/external-review)', async () => {
  const t = setup();
  try {
    const clone = path.join(t.base, 'skills', 'external-review');
    const srcDir = path.join(clone, 'src', 'external-review');
    fs.cpSync(path.resolve(path.dirname(installMjs), 'src', 'external-review'), srcDir, { recursive: true });
    fs.writeFileSync(path.join(clone, 'install.mjs'), '// repo');
    for (const src of [srcDir, clone]) {
      const r = await install({ ...t.opts, srcDir: src }, t.env);
      assert.equal(r.ok, false);
      assert.match(r.errors[0], /Niczego nie zmieniono/);
    }
    assert.ok(fs.existsSync(path.join(srcDir, 'hook.mjs')));
    assert.ok(fs.existsSync(path.join(clone, 'install.mjs')));
    assert.equal(fs.existsSync(settingsFile(t.base)), false);
  } finally { t.cleanup(); }
});

test('foreign wrapper command mentioning the hook survives install and uninstall', async () => {
  const t = setup();
  try {
    const wrapper = `bash -c 'node "${hookOf(t.base)}" --event stop && notify'`;
    fs.writeFileSync(settingsFile(t.base), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: wrapper }] }] } }));
    await install(t.opts, t.env);
    assert.ok(allCommands(readSettings(t.base)).includes(wrapper));
    await uninstall({}, t.env);
    assert.deepEqual(allCommands(readSettings(t.base)), [wrapper]);
  } finally { t.cleanup(); }
});

test('relative CLAUDE_CONFIG_DIR yields absolute hook paths', async () => {
  const t = setup();
  try {
    const rel = path.relative(process.cwd(), t.base);
    const r = await install(t.opts, { ...process.env, CLAUDE_CONFIG_DIR: rel });
    assert.equal(r.ok, true, r.errors.join('\n'));
    for (const c of allCommands(readSettings(t.base))) {
      const p = /^node "(.*)" --event/.exec(c)[1];
      assert.ok(path.isAbsolute(p), p);
    }
  } finally { t.cleanup(); }
});

test('uninstall and purge abort when the source overlaps the target', async () => {
  const t = setup();
  try {
    const clone = path.join(t.base, 'skills', 'external-review');
    const srcDir = path.join(clone, 'src', 'external-review');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'hook.mjs'), '//');
    fs.writeFileSync(settingsFile(t.base), '{"a":1}');
    let r = await uninstall({ srcDir }, t.env);
    assert.equal(r.ok, false);
    assert.match(r.errors[0], /Niczego nie zmieniono/);
    assert.ok(fs.existsSync(path.join(srcDir, 'hook.mjs')));
    // purge: repozytorium w BASE/external-review
    const dataClone = path.join(t.base, 'external-review', 'repo');
    fs.mkdirSync(dataClone, { recursive: true });
    r = await uninstall({ purge: true, srcDir: dataClone }, t.env);
    assert.equal(r.ok, false);
    assert.ok(fs.existsSync(dataClone));
    assert.equal(fs.readFileSync(settingsFile(t.base), 'utf8'), '{"a":1}');
  } finally { t.cleanup(); }
});

test('copyDir copies nested files into a target with Polish characters and spaces, skipping symlinks', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'er-żółw ą-'));
  try {
    const from = path.join(tmp, 'src');
    fs.mkdirSync(path.join(from, 'sub', 'deep'), { recursive: true });
    fs.writeFileSync(path.join(from, 'SKILL.md'), 'skill ż');
    fs.writeFileSync(path.join(from, 'sub', 'deep', 'a.txt'), 'a');
    try { fs.symlinkSync(path.join(from, 'SKILL.md'), path.join(from, 'link.md')); } catch { /* brak uprawnień do symlinków */ }
    const to = path.join(tmp, 'cel ł', 'skills', 'external-review');
    copyDir(from, to);
    assert.equal(fs.readFileSync(path.join(to, 'SKILL.md'), 'utf8'), 'skill ż');
    assert.equal(fs.readFileSync(path.join(to, 'sub', 'deep', 'a.txt'), 'utf8'), 'a');
    assert.equal(fs.existsSync(path.join(to, 'link.md')), false);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('symlinked settings.json: link kept, real target updated', async (tc) => {
  const t = setup();
  try {
    const realDir = path.join(t.tmp, 'dotfiles');
    fs.mkdirSync(realDir);
    const real = path.join(realDir, 'settings.json');
    fs.writeFileSync(real, '{"language":"pl"}');
    try { fs.symlinkSync(real, settingsFile(t.base), 'file'); } catch { tc.skip('symlinks unavailable'); return; }
    let r = await install(t.opts, t.env);
    assert.equal(r.ok, true, r.errors.join('\n'));
    assert.ok(fs.lstatSync(settingsFile(t.base)).isSymbolicLink(), 'settings.json still a symlink');
    const s = JSON.parse(fs.readFileSync(real, 'utf8'));
    assert.equal(s.language, 'pl');
    assert.equal(allCommands(s).length, 3);
    assert.deepEqual(fs.readdirSync(realDir).filter((n) => n.includes('.tmp')), []);
    r = await uninstall({}, t.env);
    assert.equal(r.ok, true, r.errors.join('\n'));
    assert.ok(fs.lstatSync(settingsFile(t.base)).isSymbolicLink());
    assert.equal(JSON.parse(fs.readFileSync(real, 'utf8')).hooks, undefined);
  } finally { t.cleanup(); }
});

function brokenSource(t, { dropHook = false } = {}) {
  const src = path.join(t.tmp, 'src-copy', 'external-review');
  copyDir(path.resolve(path.dirname(installMjs), 'src', 'external-review'), src);
  if (dropHook) fs.rmSync(path.join(src, 'hook.mjs'));
  return src;
}

const skillsEntries = (base) => fs.readdirSync(path.join(base, 'skills')).sort();

test('update with source missing hook.mjs keeps the previous install and settings', async () => {
  const t = setup();
  try {
    assert.equal((await install(t.opts, t.env)).ok, true);
    const target = path.join(t.base, 'skills', 'external-review');
    fs.writeFileSync(path.join(target, 'marker.txt'), 'old');
    const settingsBefore = fs.readFileSync(settingsFile(t.base), 'utf8');
    const r = await install({ ...t.opts, srcDir: brokenSource(t, { dropHook: true }) }, t.env);
    assert.equal(r.ok, false);
    assert.match(r.errors.join('\n'), /hook\.mjs/);
    assert.ok(fs.existsSync(path.join(target, 'hook.mjs')), 'old hook.mjs kept');
    assert.equal(fs.readFileSync(path.join(target, 'marker.txt'), 'utf8'), 'old');
    assert.equal(fs.readFileSync(settingsFile(t.base), 'utf8'), settingsBefore);
    assert.deepEqual(skillsEntries(t.base), ['external-review']);
  } finally { t.cleanup(); }
});

test('update with copy failing midway keeps the previous install, no leftovers', async () => {
  const t = setup();
  const orig = fs.copyFileSync;
  try {
    assert.equal((await install(t.opts, t.env)).ok, true);
    const target = path.join(t.base, 'skills', 'external-review');
    fs.writeFileSync(path.join(target, 'marker.txt'), 'old');
    fs.copyFileSync = function patched(a, b, ...rest) {
      if (String(b).includes('external-review.new-') && String(a).endsWith('hook.mjs')) {
        throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' });
      }
      return orig.call(this, a, b, ...rest);
    };
    const r = await install(t.opts, t.env);
    fs.copyFileSync = orig;
    assert.equal(r.ok, false);
    assert.ok(r.errors.length);
    assert.ok(fs.existsSync(path.join(target, 'hook.mjs')));
    assert.equal(fs.readFileSync(path.join(target, 'marker.txt'), 'utf8'), 'old');
    assert.deepEqual(skillsEntries(t.base), ['external-review']);
  } finally { fs.copyFileSync = orig; t.cleanup(); }
});

test('leftover external-review.new-/.old- directories are removed by install', async () => {
  const t = setup();
  try {
    for (const n of ['external-review.new-1', 'external-review.old-2']) {
      fs.mkdirSync(path.join(t.base, 'skills', n), { recursive: true });
      fs.writeFileSync(path.join(t.base, 'skills', n, 'SKILL.md'), 'x');
    }
    assert.equal((await install(t.opts, t.env)).ok, true);
    assert.deepEqual(skillsEntries(t.base), ['external-review']);
  } finally { t.cleanup(); }
});
