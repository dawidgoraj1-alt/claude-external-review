import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeContext } from '../src/external-review/lib/context.mjs';
import { emptyState, blobPath, writeBlob } from '../src/external-review/lib/state.mjs';
import { sha256 } from '../src/external-review/lib/text.mjs';
import { buildItems, meetsThreshold, chunkItems } from '../src/external-review/lib/material.mjs';

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function setup({ repo = true } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'er-mat-t-')));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'er-mat-h-'));
  if (repo) {
    git(dir, 'init', '-q');
    git(dir, 'config', 'user.email', 't@example.com');
    git(dir, 'config', 'user.name', 'Test');
    git(dir, 'config', 'core.autocrlf', 'false');
  }
  const env = { ...process.env, CLAUDE_CONFIG_DIR: path.join(home, 'claude'), GIT_CEILING_DIRECTORIES: path.dirname(dir) };
  const prevCeil = process.env.GIT_CEILING_DIRECTORIES;
  process.env.GIT_CEILING_DIRECTORIES = path.dirname(dir);
  const ctx = makeContext(dir, env, { homedir: home });
  if (prevCeil === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
  else process.env.GIT_CEILING_DIRECTORIES = prevCeil;
  const write = (rel, c) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), c);
  };
  const commit = () => {
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'c');
    return git(dir, 'rev-parse', 'HEAD');
  };
  const withBlob = (s, rel, text, stage = 'code') => {
    const hash = writeBlob(ctx.stateDir, text);
    s.files[rel] = { stage, reviewedHash: hash, rounds: 1 };
  };
  return { dir, ctx, write, commit, withBlob };
}

test('code with blob → diff from blob', () => {
  const t = setup();
  t.write('a.js', 'one\ntwo\n');
  t.commit();
  const s = emptyState();
  t.withBlob(s, 'a.js', 'one\ntwo\n');
  t.write('a.js', 'one\nTWO\nthree\n');
  const { items } = buildItems(t.ctx, s, 'code', ['a.js']);
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, 'diff');
  assert.equal(items[0].changedLines, 3);
  assert.equal(items[0].content, 'one\nTWO\nthree\n');
  assert.equal(items[0].hash, sha256('one\nTWO\nthree\n'));
});

test('CRLF-only change against blob yields no diff item', () => {
  const t = setup();
  t.write('a.js', 'one\ntwo\n');
  const s = emptyState();
  t.withBlob(s, 'a.js', 'one\ntwo\n');
  t.write('a.js', '﻿one\r\ntwo\r\n');
  assert.deepEqual(buildItems(t.ctx, s, 'code', ['a.js']).items, []);
  t.write('a.js', 'one\r\nXX\r\n');
  const { items } = buildItems(t.ctx, s, 'code', ['a.js']);
  assert.equal(items[0].changedLines, 2);
  assert.ok(!items[0].text.includes('\r'));
});

test('baseline entry without blob is treated as no blob', () => {
  const t = setup();
  t.write('a.js', 'one\n');
  t.commit();
  const s = emptyState();
  s.files['a.js'] = { stage: 'code', reviewedHash: sha256('one\n'), rounds: 0 };
  assert.ok(!fs.existsSync(blobPath(t.ctx.stateDir, s.files['a.js'].reviewedHash)));
  t.write('a.js', 'one\ntwo\n');
  const { items } = buildItems(t.ctx, s, 'code', ['a.js']);
  assert.equal(items[0].kind, 'diff');
  assert.equal(items[0].changedLines, 1);
});

test('tracked code without blob → diff from HEAD', () => {
  const t = setup();
  t.write('a.js', 'one\n');
  t.commit();
  t.write('a.js', 'one\ntwo\n');
  const { items } = buildItems(t.ctx, emptyState(), 'code', ['a.js']);
  assert.equal(items[0].kind, 'diff');
  assert.equal(items[0].changedLines, 1);
});

test('commit during turn → diff from headSha still shows change', () => {
  const t = setup();
  t.write('a.js', 'one\n');
  const sha = t.commit();
  t.write('a.js', 'one\ntwo\n');
  t.commit();
  const s = emptyState();
  assert.deepEqual(buildItems(t.ctx, s, 'code', ['a.js']).items, []);
  const { items } = buildItems(t.ctx, s, 'code', ['a.js'], { headSha: sha });
  assert.equal(items[0].kind, 'diff');
  assert.equal(items[0].changedLines, 1);
});

test('new or non-git file → full content, changedLines = line count', () => {
  const t = setup();
  t.write('seed.txt', 's\n');
  t.commit();
  t.write('new.js', 'a\nb\nc\n');
  let r = buildItems(t.ctx, emptyState(), 'code', ['new.js']);
  assert.equal(r.items[0].kind, 'full');
  assert.equal(r.items[0].changedLines, 3);
  const n = setup({ repo: false });
  assert.equal(n.ctx.isGit, false);
  n.write('x.js', 'a\nb');
  r = buildItems(n.ctx, emptyState(), 'code', ['x.js']);
  assert.equal(r.items[0].kind, 'full');
  assert.equal(r.items[0].changedLines, 2);
});

test('binary file skipped', () => {
  const t = setup();
  t.write('b.bin', Buffer.from([1, 2, 0, 3]));
  const r = buildItems(t.ctx, emptyState(), 'code', ['b.bin']);
  assert.deepEqual(r.items, []);
  assert.deepEqual(r.skipped, [{ path: 'b.bin', reason: 'binary' }]);
});

test('threshold 19 false, 20 true', () => {
  const mk = (n) => [{ changedLines: n - 5 }, { changedLines: 5 }];
  assert.equal(meetsThreshold(mk(19), 20), false);
  assert.equal(meetsThreshold(mk(20), 20), true);
});

test('spec with blob yields full + diff items', () => {
  const t = setup();
  t.write('spec.md', '# A\n');
  const s = emptyState();
  t.withBlob(s, 'spec.md', '# A\n', 'spec');
  t.write('spec.md', '# A\nmore\n');
  const { items } = buildItems(t.ctx, s, 'spec', ['spec.md']);
  assert.deepEqual(items.map((i) => i.kind), ['full', 'diff']);
  assert.equal(items[0].text, '# A\nmore\n');
  assert.equal(items[1].changedLines, 1);
  const none = buildItems(t.ctx, emptyState(), 'spec', ['spec.md']).items;
  assert.deepEqual(none.map((i) => i.kind), ['full']);
});

const big = (p, kb = 100) => ({ path: p, kind: 'full', text: 'x'.repeat(kb * 1024), changedLines: 1 });

test('chunking keeps files whole and reports overflow', () => {
  const items = [big('a'), big('b'), big('c'), big('d')];
  const { chunks, overflow } = chunkItems(items, 204800, 1);
  assert.equal(chunks.length, 1);
  assert.deepEqual(chunks[0].map((i) => i.path), ['a', 'b']);
  assert.deepEqual(overflow, ['c', 'd']);
  const two = chunkItems(items, 204800, 3);
  assert.deepEqual(two.chunks.map((c) => c.map((i) => i.path)), [['a', 'b'], ['c', 'd']]);
  assert.deepEqual(two.overflow, []);
});

test('items of the same file stay together in a chunk', () => {
  const items = [big('a', 60), { ...big('a', 60), kind: 'diff' }, big('b', 60)];
  const { chunks, overflow } = chunkItems(items, 150 * 1024, 2);
  assert.deepEqual(chunks.map((c) => c.map((i) => i.path)), [['a', 'a'], ['b']]);
  assert.deepEqual(overflow, []);
});

test('single file larger than limit is reported as tooLarge, not overflow', () => {
  const { chunks, overflow, tooLarge } = chunkItems([big('huge', 300), big('ok', 10)], 204800, 3);
  assert.deepEqual(tooLarge, ['huge']);
  assert.deepEqual(overflow, []);
  assert.deepEqual(chunks.map((c) => c.map((i) => i.path)), [['ok']]);
});
