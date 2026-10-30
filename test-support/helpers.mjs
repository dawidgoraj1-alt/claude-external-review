import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

export function makeEnv() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'er-base-'));
  return {
    env: { ...process.env, CLAUDE_CONFIG_DIR: base },
    base,
    cleanup: () => fs.rmSync(base, { recursive: true, force: true }),
  };
}

// opts: {git = true, files = {rel: content}, commit = true, name}
export function makeRepo(opts = {}) {
  const { git = true, files = {}, commit = true, name = 'er-repo-' } = opts;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), name));
  const sh = (...a) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { stdio: 'ignore' });
  if (git) sh('init', '-q');
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  if (git && commit && Object.keys(files).length) { sh('add', '-A'); sh('commit', '-q', '-m', 'init'); }
  return dir;
}

export function fakeCodexPath(dir) {
  const js = path.join(here, 'fake-codex.mjs');
  if (process.platform === 'win32') {
    const p = path.join(dir, 'fake-codex.cmd');
    fs.writeFileSync(p, `@echo off\r\nnode "${js}" %*\r\n`);
    return p;
  }
  const p = path.join(dir, 'fake-codex');
  fs.writeFileSync(p, `#!/bin/sh\nexec node "${js}" "$@"\n`, { mode: 0o755 });
  return p;
}

export function runHook(args, stdin, env) {
  const input = typeof stdin === 'string' ? stdin : JSON.stringify(stdin);
  const r = spawnSync(process.execPath, [path.join(root, 'src', 'external-review', 'hook.mjs'), ...args], {
    input, env, encoding: 'utf8', cwd: root,
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

// Another spelling of an existing directory that resolves to the same place:
// the 8.3 short name on win32, a symlink elsewhere. null when the platform or
// volume cannot provide one (8.3 generation disabled, symlinks not permitted).
export function pathAlias(dir) {
  if (process.platform === 'win32') {
    const r = spawnSync('cmd.exe', ['/d', '/s', '/c', `"for %I in ("${dir}") do @echo %~sI"`], {
      encoding: 'utf8', windowsVerbatimArguments: true, windowsHide: true,
    });
    const short = (r.stdout || '').trim();
    return short && short.toLowerCase() !== dir.toLowerCase() && fs.existsSync(short) ? short : null;
  }
  try {
    const link = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'er-alias-')), 'link');
    fs.symlinkSync(dir, link, 'dir');
    return link;
  } catch {
    return null;
  }
}
