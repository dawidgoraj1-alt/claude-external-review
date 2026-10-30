import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startLive, liveDir } from '../src/external-review/lib/live.mjs';
import { makeEnv } from '../test-support/helpers.mjs';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const readAll = (env) => {
  const d = liveDir(env);
  try { return fs.readdirSync(d).filter((n) => n.endsWith('.json')).map((n) => JSON.parse(fs.readFileSync(path.join(d, n), 'utf8'))); } catch { return []; }
};

test('live file is created at start, aggregates jobs and is removed on stop', async () => {
  const t = makeEnv();
  try {
    const live = startLive({ root: 'C:\\proj', env: t.env, throttleMs: 0, heartbeatMs: 50 });
    const a = live.addJob({ stage: 'code', files: ['a.js', 'b.js'], round: 1 });
    const b = live.addJob({ stage: 'spec', files: ['b.js', 'x.md'], round: 2 });
    assert.equal(readAll(t.env)[0].root, 'C:/proj');
    assert.equal(readAll(t.env)[0].pid, process.pid);
    a.onEvent({ type: 'item.started', item: { type: 'reasoning' } });
    b.onEvent({ type: 'item.started', item: { type: 'command_execution', command: 'cat src/stop.mjs' } });
    a.onEvent({ type: 'turn.completed', usage: { input_tokens: 1000, output_tokens: 100 } });
    b.onEvent({ type: 'turn.completed', usage: { input_tokens: 500, output_tokens: 0 } });
    const [f] = readAll(t.env);
    assert.deepEqual(f.stages, ['spec', 'code']);
    assert.deepEqual(f.files.sort(), ['a.js', 'b.js', 'x.md']);
    assert.equal(f.round, 2);
    assert.equal(f.action, 'czyta stop.mjs');
    assert.equal(f.tokens, 1600);
    assert.ok(f.startedAt <= f.updatedAt);
    assert.equal(fs.readdirSync(liveDir(t.env)).length, 1, 'no tmp leftovers');
    a.done();
    assert.deepEqual(readAll(t.env)[0].stages, ['spec']);
    assert.equal(readAll(t.env)[0].tokens, 1600);
    live.stop();
    assert.deepEqual(readAll(t.env), []);
    live.stop(); // idempotent
  } finally { t.cleanup(); }
});
test('heartbeat refreshes updatedAt without events; throttle limits event writes', async () => {
  const t = makeEnv();
  try {
    const live = startLive({ root: '/p', env: t.env, throttleMs: 100000, heartbeatMs: 40 });
    const j = live.addJob({ stage: 'code', files: ['a'], round: 1 });
    const u0 = readAll(t.env)[0].updatedAt;
    await wait(150);
    assert.ok(readAll(t.env)[0].updatedAt > u0, 'heartbeat');
    j.onEvent({ type: 'item.started', item: { type: 'reasoning' } });
    // throttled event is flushed by the next heartbeat
    await wait(150);
    assert.equal(readAll(t.env)[0].action, 'myśli');
    live.stop();
  } finally { t.cleanup(); }
});
test('live I/O errors never throw', () => {
  const t = makeEnv();
  try {
    // BASE jest plikiem → katalog live nie powstanie
    const blocker = path.join(t.base, 'external-review');
    fs.writeFileSync(blocker, 'x');
    let live;
    assert.doesNotThrow(() => { live = startLive({ root: '/p', env: t.env }); });
    assert.doesNotThrow(() => live.addJob({ stage: 'code', files: [], round: 1 }).onEvent({ type: 'item.started', item: { type: 'reasoning' } }));
    assert.doesNotThrow(() => live.stop());
  } finally { t.cleanup(); }
});

test('first job is written immediately (not throttled) and no file exists before any job', () => {
  const t = makeEnv();
  try {
    const live = startLive({ root: '/p', env: t.env, throttleMs: 100000, heartbeatMs: 20 });
    assert.deepEqual(readAll(t.env), [], 'nothing before a job is added');
    live.addJob({ stage: 'plan', files: ['p.md'], round: 1 });
    const [f] = readAll(t.env);
    assert.deepEqual(f.stages, ['plan']);
    assert.deepEqual(f.files, ['p.md']);
    live.stop();
  } finally { t.cleanup(); }
});
test('heartbeat never writes a file with an empty stage list', async () => {
  const t = makeEnv();
  try {
    const live = startLive({ root: '/p', env: t.env, throttleMs: 0, heartbeatMs: 20 });
    const j = live.addJob({ stage: 'code', files: ['a'], round: 1 });
    j.done();
    await wait(80);
    for (const f of readAll(t.env)) assert.ok(f.stages.length > 0);
    live.stop();
  } finally { t.cleanup(); }
});
