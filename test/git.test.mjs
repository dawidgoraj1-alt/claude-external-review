import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { canonical, toSlash } from '../src/external-review/lib/paths.mjs';
import {
  gitRoot, headSha, statusPaths, committedSince, isTracked, diffFile, diffNoIndex, countChangedLines,
} from '../src/external-review/lib/git.mjs';

function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'core.quotepath=false', ...args], { cwd, encoding: 'utf8' });
}

function tmpRepo() {
  const dir = canonical(fs.mkdtempSync(path.join(os.tmpdir(), 'er-git-')));
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 't@example.com');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'core.autocrlf', 'false');
  return dir;
}

function write(dir, rel, content = 'x\n') {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

function commitAll(dir, msg = 'c') {
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', msg);
}

test('statusPaths handles spaces and Polish characters', () => {
  const dir = tmpRepo();
  write(dir, 'Mój plik ó.js');
  assert.deepEqual(statusPaths(dir), ['Mój plik ó.js']);
});

test('statusPaths lists untracked files inside new dirs (-uall)', () => {
  const dir = tmpRepo();
  write(dir, 'newdir/sub/a.js');
  write(dir, 'newdir/b.js');
  assert.deepEqual(statusPaths(dir).sort(), ['newdir/b.js', 'newdir/sub/a.js']);
});

test('statusPaths returns new path for renames and skips deleted files', () => {
  const dir = tmpRepo();
  write(dir, 'old name.js', 'line1\nline2\nline3\nline4\n');
  write(dir, 'gone.js');
  commitAll(dir);
  git(dir, 'mv', 'old name.js', 'nowa ścieżka.js');
  fs.rmSync(path.join(dir, 'gone.js'));
  assert.deepEqual(statusPaths(dir), ['nowa ścieżka.js']);
});

test('committedSince lists files committed after sha', () => {
  const dir = tmpRepo();
  write(dir, 'a.js');
  commitAll(dir, 'one');
  const sha = headSha(dir);
  assert.deepEqual(committedSince(dir, sha), []);
  write(dir, 'dir/Zażółć gęślą.js');
  commitAll(dir, 'two');
  assert.deepEqual(committedSince(dir, sha), ['dir/Zażółć gęślą.js']);
  assert.deepEqual(committedSince(dir, null), []);
});

test('headSha is null in repo without commits', () => {
  const dir = tmpRepo();
  assert.equal(headSha(dir), null);
  write(dir, 'a.js');
  commitAll(dir);
  assert.match(headSha(dir), /^[0-9a-f]{40}$/);
});

test('isTracked distinguishes tracked and untracked files', () => {
  const dir = tmpRepo();
  write(dir, 'ó a.js');
  write(dir, 'b.js');
  git(dir, 'add', 'ó a.js');
  assert.equal(isTracked(dir, 'ó a.js'), true);
  assert.equal(isTracked(dir, 'b.js'), false);
});

test('diffFile returns diff against rev', () => {
  const dir = tmpRepo();
  write(dir, 'a.js', 'one\n');
  commitAll(dir);
  write(dir, 'a.js', 'two\n');
  const d = diffFile(dir, 'HEAD', 'a.js');
  assert.match(d, /-one/);
  assert.match(d, /\+two/);
  assert.equal(countChangedLines(d), 2);
});

test('diffNoIndex returns diff and treats exit 1 as success', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'er-ni-'));
  write(dir, 'a.txt', 'one\n');
  write(dir, 'b.txt', 'two\n');
  write(dir, 'c.txt', 'one\n');
  const d = diffNoIndex(path.join(dir, 'a.txt'), path.join(dir, 'b.txt'));
  assert.match(d, /-one/);
  assert.match(d, /\+two/);
  assert.equal(diffNoIndex(path.join(dir, 'a.txt'), path.join(dir, 'c.txt')), '');
});

test('countChangedLines ignores headers', () => assert.equal(countChangedLines('--- a\n+++ b\n@@\n-x\n+y\n+z\n'), 3));

test('gitRoot returns the toplevel inside repo and null outside', () => {
  const dir = tmpRepo();
  write(dir, 'sub/a.js');
  assert.equal(gitRoot(path.join(dir, "sub")).toLowerCase(), toSlash(dir).toLowerCase());
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'er-nogit-'));
  // ceiling: ignore a repo that may exist above the system temp dir (e.g. one in $HOME)
  const prev = process.env.GIT_CEILING_DIRECTORIES;
  process.env.GIT_CEILING_DIRECTORIES = path.dirname(outside);
  try {
    assert.equal(gitRoot(outside), null);
  } finally {
    if (prev === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
    else process.env.GIT_CEILING_DIRECTORIES = prev;
  }
});
