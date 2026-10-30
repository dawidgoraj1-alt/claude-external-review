import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describeEvent, createLineParser } from '../src/external-review/lib/progress.mjs';
import { buildArgs, runCodex } from '../src/external-review/lib/codex.mjs';
import { loadConfig } from '../src/external-review/lib/config.mjs';
import { fakeCodexPath } from '../test-support/helpers.mjs';

const item = (type, extra = {}) => ({ type: 'item.started', item: { type, ...extra } });

test('describeEvent maps item types to Polish actions', () => {
  assert.equal(describeEvent(item('reasoning')).action, 'myśli');
  assert.equal(describeEvent(item('file_change')).action, 'zmienia pliki');
  assert.equal(describeEvent(item('web_search')).action, 'szuka w sieci');
  assert.equal(describeEvent({ type: 'item.completed', item: { type: 'agent_message' } }).action, 'pisze wynik');
});
test('describeEvent: command, file reads and truncation', () => {
  assert.equal(describeEvent(item('command_execution', { command: 'npm test' })).action, 'uruchamia npm test');
  assert.equal(describeEvent(item('command_execution', { command: 'cat src/lib/stop.mjs' })).action, 'czyta stop.mjs');
  assert.equal(describeEvent(item('command_execution', { command: 'sed -n 1,80p src/lib/codex.mjs' })).action, 'czyta codex.mjs');
  assert.equal(describeEvent(item('command_execution', { command: '"C:\\Windows\\pwsh.exe" -Command "Get-Content -Raw src\\lib\\paths.mjs"' })).action, 'czyta paths.mjs');
  assert.equal(describeEvent(item('command_execution', { command: 'rg -n foo C:\\proj\\src\\x.js' })).action, 'czyta x.js');
  const long = describeEvent(item('command_execution', { command: 'node ' + 'a'.repeat(100) })).action;
  assert.equal(long, 'uruchamia ' + ('node ' + 'a'.repeat(100)).slice(0, 40));
});
test('describeEvent: tokens from turn.completed, tolerant to junk', () => {
  assert.equal(describeEvent({ type: 'turn.completed', usage: { input_tokens: 1000, cached_input_tokens: 500, output_tokens: 200 } }).tokens, 1200);
  assert.deepEqual(describeEvent({ type: 'turn.completed' }), {});
  assert.deepEqual(describeEvent({ type: 'thread.started' }), {});
  assert.deepEqual(describeEvent(null), {});
  assert.deepEqual(describeEvent({ type: 'item.started' }), {});
  assert.deepEqual(describeEvent(item('nieznany')), {});
  assert.deepEqual(describeEvent(item('command_execution')), {});
});
test('createLineParser handles partial chunks, junk and unknown lines', () => {
  const got = [];
  const p = createLineParser((e) => got.push(e));
  p.write(Buffer.from('{"type":"turn.sta'));
  p.write('rted"}\nnie json\n{"type":"x"}\r\n\n[1]\n{"type":"a');
  p.write('"}');
  p.end();
  assert.deepEqual(got.map((e) => e.type), ['turn.started', 'x', 'a']);
});
test('createLineParser survives throwing handler and huge line', () => {
  let n = 0;
  const p = createLineParser(() => { n++; throw new Error('x'); });
  p.write('{"type":"a"}\n');
  p.write('z'.repeat(2_000_000));
  p.write('\n{"type":"b"}\n');
  assert.equal(n, 2);
});

const cfg = loadConfig({ CLAUDE_CONFIG_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'er-pg-')) });
test('buildArgs includes --json and runCodex streams events to onEvent', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'er-pgx-'));
  const outPath = path.join(dir, 'out.json');
  const args = buildArgs(cfg, { cwd: dir, schemaPath: path.resolve('src/external-review/schema/findings.json'), outPath, overrides: [] });
  assert.ok(args.includes('--json'));
  process.env.FAKE_CODEX_MODE = 'ok';
  try {
    const seen = [];
    const r = await runCodex({ codexPath: fakeCodexPath(dir), args, prompt: 'x', timeoutMs: 20000, onEvent: (e) => seen.push(e) });
    assert.equal(r.ok, true, r.error);
    const types = seen.map((e) => e.type);
    assert.ok(types.includes('turn.started') && types.includes('turn.completed'), types.join());
    assert.ok(seen.some((e) => e.item?.type === 'command_execution'));
  } finally { delete process.env.FAKE_CODEX_MODE; }
});

test('createLineParser drops over-long lines even when complete in one chunk', () => {
  const got = [];
  const p = createLineParser((e) => got.push(e.type));
  const big = `{"type":"big","pad":"${'x'.repeat(1_100_000)}"}`;
  p.write(`${big}\n{"type":"ok"}\n`);
  p.write(`${big}`);
  p.write('\n{"type":"ok2"}');
  p.end();
  assert.deepEqual(got, ['ok', 'ok2']);
});
