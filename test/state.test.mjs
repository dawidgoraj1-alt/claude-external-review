import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  emptyState, readState, withState, writeBlob, blobPath, gcBlobs, pruneSessions,
} from '../src/external-review/lib/state.mjs';

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'er-state-')); }
const DAY = 24 * 3600 * 1000;

test('emptyState has the documented shape', () => {
  assert.deepEqual(emptyState(), {
    version: 1, files: {}, outstanding: [], failures: { consecutive: 0, lastAt: null },
    codexPids: [], sessions: {},
  });
});

test('withState persists mutation atomically', async () => {
  const dir = tmpDir();
  const ok = await withState(dir, (s) => { s.outstanding = ['a']; });
  assert.equal(ok, true);
  assert.deepEqual(readState(dir).outstanding, ['a']);
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.includes('.tmp')), []);
  assert.equal(fs.existsSync(path.join(dir, 'state.lock')), false);
});

test('withState returns false when lock held by live process', async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'state.lock'), JSON.stringify({ pid: process.pid, at: Date.now() }));
  let called = false;
  const ok = await withState(dir, () => { called = true; }, { waitMs: 100 });
  assert.equal(ok, false);
  assert.equal(called, false);
});

test('stale lock (dead pid) is taken over', async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'state.lock'), JSON.stringify({ pid: 999999, at: Date.now() }));
  assert.equal(await withState(dir, (s) => { s.outstanding = ['x']; }, { waitMs: 500 }), true);
  assert.deepEqual(readState(dir).outstanding, ['x']);
});

test('lock older than 60 s is taken over', async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'state.lock'), JSON.stringify({ pid: process.pid, at: Date.now() - 61000 }));
  assert.equal(await withState(dir, () => {}, { waitMs: 500 }), true);
});

test('lock is released when fn throws', async () => {
  const dir = tmpDir();
  await assert.rejects(withState(dir, () => { throw new Error('boom'); }), /boom/);
  assert.equal(fs.existsSync(path.join(dir, 'state.lock')), false);
  assert.deepEqual(readState(dir), emptyState());
});

test('writeBlob is idempotent and blobPath points at it', () => {
  const dir = tmpDir();
  const h = writeBlob(dir, 'a\r\nb');
  assert.equal(writeBlob(dir, 'a\nb'), h);
  assert.equal(fs.readFileSync(blobPath(dir, h), 'utf8'), 'a\nb');
});

test('gcBlobs removes unreferenced blobs', () => {
  const dir = tmpDir();
  const h1 = writeBlob(dir, 'one');
  const h2 = writeBlob(dir, 'two');
  const s = emptyState();
  s.files['f.md'] = { stage: 'plan', reviewedHash: h1, rounds: 1 };
  gcBlobs(dir, s);
  assert.equal(fs.existsSync(blobPath(dir, h1)), true);
  assert.equal(fs.existsSync(blobPath(dir, h2)), false);
});

test('withState runs gc on write', async () => {
  const dir = tmpDir();
  const h = writeBlob(dir, 'orphan');
  await withState(dir, () => {});
  assert.equal(fs.existsSync(blobPath(dir, h)), false);
});

test('corrupt state.json is moved aside', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'state.json'), '{not json');
  assert.deepEqual(readState(dir), emptyState());
  const names = fs.readdirSync(dir);
  assert.ok(names.some((n) => n.startsWith('state.json.corrupt-')));
  assert.equal(names.includes('state.json'), false);
});

test('missing state.json yields emptyState', () => {
  assert.deepEqual(readState(tmpDir()), emptyState());
});

test('pruneSessions drops sessions older than 7 days', () => {
  const now = Date.now();
  const s = emptyState();
  s.sessions.old = { startedAt: now - 8 * DAY };
  s.sessions.fresh = { startedAt: now - 1 * DAY };
  pruneSessions(s, now);
  assert.deepEqual(Object.keys(s.sessions), ['fresh']);
});

test('parallel withState calls do not lose updates', async () => {
  const dir = tmpDir();
  const results = await Promise.all(Array.from({ length: 10 }, (_, i) =>
    withState(dir, (s) => { s.outstanding.push(`f${i}`); }, { waitMs: 15000 })));
  assert.ok(results.every((r) => r === true));
  assert.equal(readState(dir).outstanding.length, 10);
});

test('transient read error of state.json → withState returns false, state and blobs untouched', async () => {
  const dir = tmpDir();
  const h = writeBlob(dir, 'reviewed');
  await withState(dir, (s) => { s.files['a.md'] = { stage: 'plan', reviewedHash: h, rounds: 1 }; });
  const sp = path.join(dir, 'state.json');
  const before = fs.readFileSync(sp, 'utf8');
  const orig = fs.readFileSync;
  fs.readFileSync = function patched(p, ...rest) {
    if (String(p) === sp) throw Object.assign(new Error('EBUSY: resource busy'), { code: 'EBUSY' });
    return orig.call(this, p, ...rest);
  };
  let called = false;
  let ok;
  try {
    ok = await withState(dir, () => { called = true; });
  } finally {
    fs.readFileSync = orig;
  }
  assert.equal(ok, false);
  assert.equal(called, false);
  assert.equal(fs.readFileSync(sp, 'utf8'), before);
  assert.ok(fs.existsSync(blobPath(dir, h)), 'blob not garbage-collected');
  assert.equal(fs.existsSync(path.join(dir, 'state.lock')), false);
  assert.ok(!fs.readdirSync(dir).some((n) => n.includes('.corrupt-')), 'not moved aside');
});
