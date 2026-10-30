#!/usr/bin/env node
// Atrapa Codexa na potrzeby testów. Tryb: FAKE_CODEX_MODE.
import fs from 'node:fs';

const argv = process.argv.slice(2);
const arg = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
// Podkomendy pomocnicze instalatora: `--help` i `login status` (bez czytania stdin).
if (argv.includes('--help')) {
  const flags = ['--output-schema', '--ephemeral', '--ignore-user-config', '--json'].filter((f) => f !== process.env.FAKE_CODEX_HELP_MISSING);
  process.stdout.write(`Usage: codex exec [OPTIONS]\n${flags.map((f) => `      ${f}\n`).join('')}`);
  process.exit(0);
}
if (argv[0] === 'login') {
  if (process.env.FAKE_CODEX_LOGIN === 'fail') { process.stderr.write('Not logged in\n'); process.exit(1); }
  process.stdout.write('Logged in using ChatGPT\n');
  process.exit(0);
}
const outPath = arg('-o');
const cwd = arg('-C');

const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const prompt = Buffer.concat(chunks).toString('utf8');

const env = process.env;
if (env.FAKE_CODEX_LOG) fs.writeFileSync(env.FAKE_CODEX_LOG, prompt, 'utf8');
if (env.FAKE_CODEX_ARGS) fs.writeFileSync(env.FAKE_CODEX_ARGS, JSON.stringify({ argv, cwd }), 'utf8');
if (env.FAKE_CODEX_PID) fs.writeFileSync(env.FAKE_CODEX_PID, String(process.pid), 'utf8');
// FAKE_CODEX_CALLS: dopisuje linie "start|end <ms> <pid>" (log wielu wywołań).
const logCall = (what) => {
  if (env.FAKE_CODEX_CALLS) fs.appendFileSync(env.FAKE_CODEX_CALLS, `${what} ${Date.now()} ${process.pid}\n`, 'utf8');
};
logCall('start');
process.on('exit', () => logCall('end'));
// FAKE_CODEX_SLEEP_MATCH: uśpienie (FAKE_CODEX_SLEEP_MS) przed trybem, tylko gdy prompt zawiera ten tekst.
if (env.FAKE_CODEX_SLEEP_MATCH && prompt.includes(env.FAKE_CODEX_SLEEP_MATCH)) {
  await new Promise((r) => setTimeout(r, Number(env.FAKE_CODEX_SLEEP_MS || 10000)));
}

const mode = env.FAKE_CODEX_MODE || 'ok';
// Z --json: kilka zdarzeń JSONL na stdout (jak codex exec --json); FAKE_CODEX_EVENT_MS = przerwa między nimi.
if (argv.includes('--json')) {
  const events = [
    { type: 'thread.started', thread_id: 't1' },
    { type: 'turn.started' },
    { type: 'item.started', item: { id: 'i1', type: 'reasoning' } },
    { type: 'item.started', item: { id: 'i2', type: 'command_execution', command: 'cat src/stop.mjs' } },
    { type: 'item.completed', item: { id: 'i2', type: 'command_execution', command: 'cat src/stop.mjs' } },
    { type: 'item.completed', item: { id: 'i3', type: 'agent_message' } },
    { type: 'turn.completed', usage: { input_tokens: 1000, cached_input_tokens: 400, output_tokens: 200 } },
  ];
  const gap = Number(env.FAKE_CODEX_EVENT_MS || 0);
  for (const e of events) {
    process.stdout.write(`${JSON.stringify(e)}\n`);
    if (gap) await new Promise((r) => setTimeout(r, gap));
  }
}
const write = (obj) => fs.writeFileSync(outPath, JSON.stringify(obj), 'utf8');

switch (mode) {
  case 'ok': write({ summary: 'ok', findings: [] }); break;
  case 'findings': {
    const f = JSON.parse(env.FAKE_CODEX_FINDINGS || '[]');
    write(Array.isArray(f) ? { summary: 'findings', findings: f } : f);
    break;
  }
  case 'bad-json': fs.writeFileSync(outPath, '{ to nie jest json', 'utf8'); break;
  case 'exit1': process.stderr.write('fake codex failure\n'); process.exit(1); break;
  case 'sleep':
    await new Promise((r) => setTimeout(r, Number(env.FAKE_CODEX_SLEEP_MS || 10000)));
    write({ summary: 'ok', findings: [] });
    break;
  case 'modify':
    fs.appendFileSync(env.FAKE_CODEX_MODIFY, 'zmodyfikowane przez codex\n', 'utf8');
    write({ summary: 'ok', findings: JSON.parse(env.FAKE_CODEX_FINDINGS || '[]') });
    break;
  case 'bom':
    fs.writeFileSync(outPath, '﻿' + JSON.stringify({
      summary: 'ok',
      findings: [{ id: 1, severity: 'important', location: 'a.js:1', problem: 'Błąd w żółtym module', suggestion: 'Popraw' }],
    }, null, 2).replace(/\n/g, '\r\n'), 'utf8');
    break;
  default: process.stderr.write(`unknown mode ${mode}\n`); process.exit(2);
}
