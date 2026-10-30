#!/usr/bin/env node
// Copyright (c) 2026 Dawid Góraj — external-review (https://github.com/dawidgoraj1-alt/claude-external-review). Licencja MIT.
// Segment linii statusu Claude Code: postęp recenzji Codexa w bieżącym projekcie.
// Jako moduł: import { codexSegment } from '<katalog skilla>/statusline.mjs'.
// Jako skrypt: czyta JSON linii statusu ze stdin i drukuje segment (lub nic); zawsze kończy się kodem 0.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { liveDir } from './lib/live.mjs';
import { nocase, toSlash } from './lib/paths.mjs';

const STALE_MS = 15000;
const STAGE_NAMES = { spec: 'specyfikacja', plan: 'plan', code: 'kod' };
const STAGE_ORDER = ['spec', 'plan', 'code'];

export function plFiles(n) {
  if (n === 1) return '1 plik';
  const last = n % 10;
  const teen = n % 100 >= 12 && n % 100 <= 14;
  return `${n} ${last >= 2 && last <= 4 && !teen ? 'pliki' : 'plików'}`;
}

export function formatElapsed(ms) {
  const s = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function formatTokens(n) {
  return n >= 1000 ? `${Math.round(n / 1000)}k tok` : `${n} tok`;
}

function normPath(p) {
  let s = toSlash(p);
  if (s.length > 1) s = s.replace(/\/+$/, '') || '/';
  if (/^[A-Za-z]:$/.test(s)) s += '/';
  return nocase() ? s.toLowerCase() : s;
}

function covers(root, cwd) {
  const r = normPath(root);
  const c = normPath(cwd);
  return c === r || c.startsWith(r.endsWith('/') ? r : `${r}/`);
}

export function codexSegment(cwd, env = process.env, now = Date.now()) {
  try {
    if (!cwd || typeof cwd !== 'string') return '';
    const dir = liveDir(env);
    const recs = [];
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      let r;
      try { r = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')); } catch { continue; }
      if (!r || typeof r.root !== 'string' || !Array.isArray(r.stages) || !r.stages.length) continue;
      if (!(now - Number(r.updatedAt) <= STALE_MS)) continue;
      if (!covers(r.root, cwd)) continue;
      recs.push(r);
    }
    if (!recs.length) return '';
    const stages = STAGE_ORDER.filter((s) => recs.some((r) => r.stages.includes(s)));
    if (!stages.length) return '';
    const files = new Set(recs.flatMap((r) => (Array.isArray(r.files) ? r.files : [])));
    const startedAt = Math.min(...recs.map((r) => Number(r.startedAt) || now));
    const latest = recs.reduce((a, b) => (Number(b.updatedAt) > Number(a.updatedAt) ? b : a));
    const tokens = recs.reduce((n, r) => n + (Number(r.tokens) || 0), 0);
    const parts = ['⟳ Codex', `${stages.map((s) => STAGE_NAMES[s]).join(', ')} (${plFiles(files.size)})`, formatElapsed(now - startedAt)];
    if (latest.action) parts.push(String(latest.action));
    if (tokens > 0) parts.push(formatTokens(tokens));
    return parts.join(' · ');
  } catch {
    return '';
  }
}

function readStdin(timeoutMs = 200) {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('');
    let buf = '';
    let done = false;
    const finish = () => { if (done) return; done = true; clearTimeout(timer); resolve(buf); };
    const timer = setTimeout(finish, timeoutMs);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => { buf += d; });
    process.stdin.on('end', finish);
    process.stdin.on('error', finish);
  });
}

async function main() {
  try {
    const raw = await readStdin();
    let input = {};
    try { input = JSON.parse(raw.replace(/^﻿/, '')); } catch { /* brak lub zły JSON */ }
    const cwd = input?.workspace?.current_dir ?? input?.cwd;
    const seg = codexSegment(cwd);
    if (seg) process.stdout.write(`${seg}\n`, () => process.exit(0));
    else process.exit(0);
  } catch {
    process.exit(0);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
