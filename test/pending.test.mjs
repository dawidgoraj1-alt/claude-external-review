import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  pendingPath, readPending, appendRound, saveDisplay, clearDisplayed, listPendingFiles,
} from '../src/external-review/lib/pending.mjs';

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'er-pend-'));
const F = (location, problem = 'p') => ({ id: 1, severity: 'important', location, problem, suggestion: 's' });
const round = (files, findings, n = 1) => ({ files, summary: 'sum', findings, round: n, at: '2026-01-01T00:00:00Z' });

test('appendRound appends, never replaces', () => {
  const dir = tmpDir();
  appendRound(dir, 'plan', round(['a-plan.md'], [F('x')], 1));
  appendRound(dir, 'plan', round(['b-plan.md'], [F('y')], 2));
  const p = readPending(dir, 'plan');
  assert.equal(p.rounds.length, 2);
  assert.deepEqual(p.findings.map((f) => f.file), ['a-plan.md', 'b-plan.md']);
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.includes('.tmp')), []);
});

test('ids do not collide across chunks', () => {
  const dir = tmpDir();
  assert.deepEqual(appendRound(dir, 'plan', round(['a.md'], [F('x')])), ['p-1']);
  assert.deepEqual(appendRound(dir, 'plan', round(['b.md'], [F('y')])), ['p-2']);
  assert.deepEqual(appendRound(dir, 'code', round(['a.js'], [F('x'), F('y')])), ['c-1', 'c-2']);
  assert.deepEqual(appendRound(dir, 'spec', round(['s.md'], [F('x')])), ['s-1']);
});

test('file assigned by location for multi-file chunk', () => {
  const dir = tmpDir();
  appendRound(dir, 'code', round(['src/a.js', 'src/b.js'], [F('src/b.js:10'), F('nowhere'), F('b.js:3')]));
  assert.deepEqual(readPending(dir, 'code').findings.map((f) => f.file), ['src/b.js', 'src/a.js', 'src/b.js']);
});

test('clearDisplayed removes only displayed findings', () => {
  const dir = tmpDir();
  appendRound(dir, 'plan', round(['a.md'], [F('1'), F('2'), F('3')]));
  saveDisplay(dir, 'plan', { 1: 'p-1', 2: 'p-3' });
  assert.equal(clearDisplayed(dir, 'plan'), 2);
  const p = readPending(dir, 'plan');
  assert.deepEqual(p.findings.map((f) => f.id), ['p-2']);
  assert.deepEqual(p.display, {});
});

test('clearDisplayed with empty display removes nothing (null) and keeps the file', () => {
  const dir = tmpDir();
  appendRound(dir, 'plan', round(['a.md'], [F('1')]));
  assert.equal(clearDisplayed(dir, 'plan'), null);
  assert.deepEqual(readPending(dir, 'plan').findings.map((f) => f.id), ['p-1']);
  fs.rmSync(pendingPath(dir, 'plan'));
  assert.equal(clearDisplayed(dir, 'plan'), 0);
});

test('clearDisplayed deletes empty pending file', () => {
  const dir = tmpDir();
  appendRound(dir, 'code', round(['a.js'], [F('1')]));
  saveDisplay(dir, 'code', { 1: 'c-1' });
  clearDisplayed(dir, 'code');
  assert.equal(fs.existsSync(pendingPath(dir, 'code')), false);
});

test('listPendingFiles lists only pending files', () => {
  const dir = tmpDir();
  appendRound(dir, 'plan', round(['a.md'], [F('1')]));
  appendRound(dir, 'code', round(['a.js'], [F('1')]));
  fs.writeFileSync(path.join(dir, 'state.json'), '{}');
  assert.deepEqual(listPendingFiles(dir), [pendingPath(dir, 'code'), pendingPath(dir, 'plan')]);
  assert.deepEqual(listPendingFiles(path.join(dir, 'nope')), []);
});

test('appendRound with no findings creates no file and leaves existing untouched', () => {
  const dir = tmpDir();
  assert.deepEqual(appendRound(dir, 'plan', round(['a.md'], [])), []);
  assert.equal(fs.existsSync(pendingPath(dir, 'plan')), false);
  appendRound(dir, 'plan', round(['a.md'], [F('1')]));
  const before = fs.readFileSync(pendingPath(dir, 'plan'), 'utf8');
  appendRound(dir, 'plan', round(['a.md'], []));
  assert.equal(fs.readFileSync(pendingPath(dir, 'plan'), 'utf8'), before);
});

test('listPendingFiles ignores files without findings', () => {
  const dir = tmpDir();
  fs.writeFileSync(pendingPath(dir, 'plan'), JSON.stringify({ stage: 'plan', rounds: [{}], findings: [], display: {} }));
  assert.deepEqual(listPendingFiles(dir), []);
});

test('corrupt pending file is preserved aside, not overwritten', () => {
  const dir = tmpDir();
  fs.writeFileSync(pendingPath(dir, 'code'), '{garbage');
  assert.deepEqual(appendRound(dir, 'code', round(['a.js'], [F('1')])), ['c-1']);
  assert.equal(readPending(dir, 'code').findings.length, 1);
  const aside = fs.readdirSync(dir).filter((n) => n.startsWith('pending-code.json.corrupt-'));
  assert.equal(aside.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, aside[0]), 'utf8'), '{garbage');
});

test('ids stay monotonic after partial clear of highest ids', () => {
  const dir = tmpDir();
  appendRound(dir, 'plan', round(['a.md'], [F('1'), F('2'), F('3')]));
  saveDisplay(dir, 'plan', { 1: 'p-2', 2: 'p-3' });
  assert.equal(clearDisplayed(dir, 'plan'), 2);
  assert.deepEqual(appendRound(dir, 'plan', round(['a.md'], [F('4')])), ['p-4']);
});
