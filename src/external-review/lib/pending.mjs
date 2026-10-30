// Copyright (c) 2026 Dawid Góraj — external-review (https://github.com/dawidgoraj1-alt/claude-external-review). Licencja MIT.
import fs from 'node:fs';
import path from 'node:path';
import { toSlash } from './paths.mjs';

const PREFIX = { spec: 's', plan: 'p', code: 'c' };
const FILE_RE = /^pending-(spec|plan|code)\.json$/;
const rand = () => Math.random().toString(36).slice(2);

export function pendingPath(dir, stage) {
  return path.join(dir, `pending-${stage}.json`);
}

// Returns {pending} (null when absent) or {corrupt: true} when unreadable/unparseable.
function loadPending(dir, stage) {
  let raw;
  try {
    raw = fs.readFileSync(pendingPath(dir, stage), 'utf8');
  } catch (e) {
    return e.code === 'ENOENT' ? { pending: null } : { corrupt: true };
  }
  try {
    const p = JSON.parse(raw.replace(/^﻿/, ''));
    if (!p || typeof p !== 'object' || Array.isArray(p)) return { corrupt: true };
    return { pending: {
      stage,
      nextId: Number.isInteger(p.nextId) && p.nextId > 0 ? p.nextId : 1,
      rounds: Array.isArray(p.rounds) ? p.rounds : [],
      findings: Array.isArray(p.findings) ? p.findings : [],
      display: p.display && typeof p.display === 'object' && !Array.isArray(p.display) ? p.display : {},
    } };
  } catch {
    return { corrupt: true };
  }
}

export function readPending(dir, stage) {
  return loadPending(dir, stage).pending ?? null;
}

// Synchronous atomic write (tmp + rename); callers hold the state lock.
function writePending(dir, stage, data) {
  const p = pendingPath(dir, stage);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${p}.tmp-${process.pid}-${rand()}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  try {
    fs.renameSync(tmp, p);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    throw e;
  }
}

function fileForFinding(files, location) {
  if (files.length <= 1) return files[0] ?? '';
  const loc = String(location ?? '').replace(/\\/g, '/').toLowerCase();
  const byLen = [...files].sort((a, b) => b.length - a.length);
  for (const f of byLen) if (loc.includes(f.toLowerCase())) return f;
  for (const f of byLen) {
    const base = f.slice(f.lastIndexOf('/') + 1).toLowerCase();
    if (base && loc.includes(base)) return f;
  }
  return files[0];
}

// Pliki, którym przypisano co najmniej jedną uwagę (ta sama reguła co w appendRound).
export function attributedFiles(files, findings) {
  return new Set((findings || []).map((f) => fileForFinding(files, f.location)));
}

export function appendRound(dir, stage, r) {
  const prefix = PREFIX[stage];
  if (!r.findings.length) return [];
  const loaded = loadPending(dir, stage);
  if (loaded.corrupt) {
    const p = pendingPath(dir, stage);
    try { fs.renameSync(p, p + '.corrupt-' + Date.now()); } catch { /* ignore */ }
  }
  const pending = loaded.pending ?? { stage, nextId: 1, rounds: [], findings: [], display: {} };
  let next = pending.nextId;
  for (const f of pending.findings) {
    const n = Number(String(f.id).split('-')[1]);
    if (Number.isInteger(n) && n >= next) next = n + 1;
  }
  pending.rounds.push({ at: r.at, files: r.files, summary: r.summary });
  const ids = [];
  for (const f of r.findings) {
    const id = `${prefix}-${next++}`;
    ids.push(id);
    pending.findings.push({
      id,
      file: fileForFinding(r.files, f.location),
      severity: f.severity,
      location: f.location,
      problem: f.problem,
      suggestion: f.suggestion,
      round: r.round,
    });
  }
  pending.nextId = next;
  writePending(dir, stage, pending);
  return ids;
}

export function saveDisplay(dir, stage, map) {
  const pending = readPending(dir, stage);
  if (!pending) return;
  pending.display = { ...map };
  writePending(dir, stage, pending);
}

// Usuwa uwagi z zapisanej numeracji (display). Pusta numeracja przy istniejących uwagach →
// null i nic nie jest usuwane (nie wiadomo, co pokazano; display jest wspólny dla projektu).
export function clearDisplayed(dir, stage) {
  const pending = readPending(dir, stage);
  if (!pending) return 0;
  const shown = new Set(Object.values(pending.display).map(String));
  if (shown.size === 0) return pending.findings.length ? null : 0;
  const before = pending.findings.length;
  pending.findings = pending.findings.filter((f) => !shown.has(String(f.id)));
  const removed = before - pending.findings.length;
  pending.display = {};
  if (pending.findings.length === 0) {
    fs.rmSync(pendingPath(dir, stage), { force: true });
  } else {
    writePending(dir, stage, pending);
  }
  return removed;
}

export function listPendingFiles(dir) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names
    .filter((n) => FILE_RE.test(n))
    .sort()
    .filter((n) => {
      const p = readPending(dir, n.slice(8, -5));
      return !!p && p.findings.length > 0;
    })
    .map((n) => path.join(dir, n));
}

// Pliki pending-*.json, które istnieją, ale nie dają się wczytać (uszkodzone) — do ostrzeżeń dla użytkownika.
export function corruptPendingFiles(dir, stage) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names
    .filter((n) => FILE_RE.test(n) && (!stage || n === `pending-${stage}.json`))
    .sort()
    .filter((n) => loadPending(dir, n.slice(8, -5)).corrupt === true)
    .map((n) => path.join(dir, n));
}

export function corruptWarning(file) {
  return `Plik uwag ${toSlash(file)} jest uszkodzony lub nieczytelny — zapisane w nim uwagi nie zostaną pokazane. Usuń lub napraw plik; kolejna recenzja zapisze uwagi od nowa.`;
}
