import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeContext } from '../src/external-review/lib/context.mjs';
import { snapshotWorkspace, changedBetween } from '../src/external-review/lib/changes.mjs';

const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' });

function tmp(isGit) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'er-chg-')));
  if (isGit) {
    git(dir, 'init', '-q');
    git(dir, 'config', 'user.email', 't@example.com');
    git(dir, 'config', 'user.name', 'Test');
    git(dir, 'config', 'core.autocrlf', 'false');
  }
  return dir;
}
function write(dir, rel, c = 'x\n') {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, c);
}
function ctxFor(dir) {
  process.env.GIT_CEILING_DIRECTORIES = path.dirname(dir);
  return makeContext(dir);
}
const diff = (ctx, mutate) => {
  const before = snapshotWorkspace(ctx);
  mutate();
  return changedBetween(before, snapshotWorkspace(ctx), ctx.config, ctx.nocase);
};

test('detects file modified between snapshots (git)', () => {
  const dir = tmp(true);
  write(dir, 'a.js', 'one\n');
  git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'c');
  write(dir, 'b.js', 'b\n');
  const ctx = ctxFor(dir);
  assert.equal(ctx.isGit, true);
  assert.deepEqual(diff(ctx, () => { write(dir, 'b.js', 'b2\n'); write(dir, 'a.js', 'two\n'); }), ['a.js', 'b.js']);
});

test('detects deleted file (git)', () => {
  const dir = tmp(true);
  write(dir, 'a.js');
  const ctx = ctxFor(dir);
  assert.deepEqual(diff(ctx, () => fs.rmSync(path.join(dir, 'a.js'))), ['a.js']);
});

test('detects new file outside git', () => {
  const dir = tmp(false);
  write(dir, 'old.js');
  const ctx = ctxFor(dir);
  assert.equal(ctx.isGit, false);
  assert.deepEqual(diff(ctx, () => write(dir, 'src/new.js')), ['src/new.js']);
});

test('detects modified and deleted files outside git', () => {
  const dir = tmp(false);
  write(dir, 'a.js', 'x'); write(dir, 'b.js', 'y');
  const ctx = ctxFor(dir);
  const out = diff(ctx, () => { write(dir, 'a.js', 'longer content'); fs.rmSync(path.join(dir, 'b.js')); });
  assert.deepEqual(out, ['a.js', 'b.js']);
});

for (const isGit of [true, false]) {
  test(`ignores artifacts in ignoreDirs (${isGit ? 'git' : 'no git'})`, () => {
    const dir = tmp(isGit);
    write(dir, 'a.js');
    const ctx = ctxFor(dir);
    assert.deepEqual(diff(ctx, () => {
      write(dir, '__pycache__/x.pyc');
      write(dir, 'pkg/.pytest_cache/v/cache');
    }), []);
  });
}

test('ignores *.log', () => {
  const dir = tmp(true);
  write(dir, 'a.js');
  const ctx = ctxFor(dir);
  assert.deepEqual(diff(ctx, () => { write(dir, 'run.log'); write(dir, 'sub/x.log'); }), []);
});

test('detects deleted committed file (git, clean tracked)', () => {
  const dir = tmp(true);
  write(dir, 'a.js'); write(dir, 'b.js');
  git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'c');
  const ctx = ctxFor(dir);
  assert.deepEqual(diff(ctx, () => fs.rmSync(path.join(dir, 'a.js'))), ['a.js']);
});

test('detects staged deletion of committed file (git)', () => {
  const dir = tmp(true);
  write(dir, 'a.js');
  git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'c');
  const ctx = ctxFor(dir);
  assert.deepEqual(diff(ctx, () => git(dir, 'rm', '-q', 'a.js')), ['a.js']);
});

test('reports spec/plan changes despite ignorePatterns, not plain .md', () => {
  const dir = tmp(true);
  write(dir, 'a.js');
  const ctx = ctxFor(dir);
  assert.deepEqual(diff(ctx, () => {
    write(dir, 'docs/superpowers/specs/x-design.md');
    write(dir, 'feature-plan.md');
    write(dir, 'README.md');
  }), ['docs/superpowers/specs/x-design.md', 'feature-plan.md']);
});

test('sensitive paths detected even when gitignored or inside .git; other ignored files and .git internals not', () => {
  const dir = tmp(true);
  write(dir, '.gitignore', '.claude/\n.vscode/\nsecret.txt\n');
  write(dir, '.claude/settings.json', '{}\n');
  write(dir, '.vscode/tasks.json', '{}\n');
  write(dir, 'secret.txt', 'a\n');
  write(dir, 'a.js', 'one\n');
  git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'c');
  const ctx = ctxFor(dir);
  const changed = diff(ctx, () => {
    write(dir, '.claude/settings.json', '{"hooks":{}}\n');
    write(dir, '.vscode/tasks.json', '{"x":1}\n');
    write(dir, '.git/hooks/pre-commit', '#!/bin/sh\n');
    fs.appendFileSync(path.join(dir, '.git', 'config'), '[alias]\n\tx = !sh\n');
    write(dir, '.github/workflows/ci.yml', 'on: push\n');
    write(dir, 'secret.txt', 'b\n');
    write(dir, '.git/info/exclude', 'zz\n');
  });
  assert.deepEqual(changed, [
    '.claude/settings.json', '.git/config', '.git/hooks/pre-commit', '.github/workflows/ci.yml', '.vscode/tasks.json',
  ]);
});

test('deleted sensitive file is reported (git)', () => {
  const dir = tmp(true);
  write(dir, '.gitignore', '.claude/\n');
  write(dir, '.claude/x.json', '{}\n');
  write(dir, 'a.js', 'one\n');
  git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'c');
  const ctx = ctxFor(dir);
  assert.deepEqual(diff(ctx, () => fs.rmSync(path.join(dir, '.claude', 'x.json'))), ['.claude/x.json']);
});
