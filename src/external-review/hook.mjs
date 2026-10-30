#!/usr/bin/env node
// Punkt wejścia external-review (interfejs: spec §3.3).
import { onPrompt, onTool } from './lib/candidates.mjs';
import { makeContext } from './lib/context.mjs';
import { runManualCli } from './lib/manual.mjs';
import { messageOutput } from './lib/output.mjs';
import { runStop } from './lib/stop.mjs';

const EVENTS = {
  prompt: onPrompt,
  tool: onTool,
  stop: runStop,
};

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

function parseInput(raw) {
  try {
    const v = JSON.parse(raw.replace(/^﻿/, ''));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

function exit(code, output) {
  const done = () => process.exit(code);
  if (output === undefined || output === null) return done();
  process.stdout.write(typeof output === 'string' ? output : JSON.stringify(output), done);
}

// Tryby hookowe: zawsze kod 0; wyjątek → ostrzeżenie (tylko stop) lub cisza.
async function runEvent(event) {
  const handler = EVENTS[event];
  let input = null;
  try {
    input = parseInput(await readStdin());
  } catch { /* brak stdin */ }
  if (!handler || !input) return exit(0);
  try {
    const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd();
    const ctx = makeContext(cwd, process.env);
    const out = await handler(input, ctx);
    return exit(0, event === 'stop' ? out : null);
  } catch (e) {
    if (event !== 'stop') return exit(0);
    return exit(0, messageOutput({
      lines: [`Zewnętrzna recenzja Codex: błąd hooka Stop — recenzja pominięta (${e?.message || e}).`],
      warnings: [],
      pendingFiles: [],
    }));
  }
}

// Tryby ręczne (wywoływane przez Claude'a, nie przez hooki): logika w lib/manual.mjs.
async function runManualMode(argv) {
  const { code, stdout } = await runManualCli(argv, { readStdin });
  return exit(code, stdout);
}

async function main(argv) {
  if (argv[0] === '--event') {
    // Tryby hookowe nigdy nie kończą się kodem ≠ 0, nawet przy błędnych argumentach.
    return runEvent(argv.length === 2 ? argv[1] : null);
  }
  return runManualMode(argv);
}

main(process.argv.slice(2)).catch(() => {
  process.exit(process.argv[2] === '--event' ? 0 : 1);
});
