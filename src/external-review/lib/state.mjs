// Copyright (c) 2026 Dawid Góraj — external-review (https://github.com/dawidgoraj1-alt/claude-external-review). Licencja MIT.
import fs from 'node:fs';
import path from 'node:path';
import { normalizeText, sha256 } from './text.mjs';

const LOCK_STALE_MS = 60_000;
const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;
const HASH_RE = /^[0-9a-f]{64}$/;

export function emptyState() {
  return {
    version: 1,
    files: {},
    outstanding: [],
    failures: { consecutive: 0, lastAt: null },
    codexPids: [],
    sessions: {},
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = () => Math.random().toString(36).slice(2);

function statePath(dir) { return path.join(dir, 'state.json'); }
function lockPath(dir) { return path.join(dir, 'state.lock'); }

// {state} albo {error}: brak pliku (ENOENT) = stan pusty; uszkodzony JSON jest odkładany
// na bok (stan pusty); inny błąd odczytu (EPERM/EBUSY/EMFILE…) = {error} — stanu nie wolno
// wtedy nadpisać pustym (GC usunąłby wszystkie bloby).
function loadState(dir) {
  const p = statePath(dir);
  let raw;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch (e) {
    return e?.code === 'ENOENT' ? { state: emptyState() } : { error: e };
  }
  try {
    const parsed = JSON.parse(raw.replace(/^﻿/, ''));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('shape');
    return { state: { ...emptyState(), ...parsed } };
  } catch {
    try { fs.renameSync(p, `${p}.corrupt-${Date.now()}`); } catch { /* ignore */ }
    return { state: emptyState() };
  }
}

// Odczyt bez blokady (tylko do odczytu): przy błędzie odczytu stan pusty.
export function readState(dir) {
  return loadState(dir).state ?? emptyState();
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return !!e && e.code === 'EPERM';
  }
}

function lockIsStale(lp) {
  let info = null;
  try { info = JSON.parse(fs.readFileSync(lp, 'utf8')); } catch { /* unreadable or partial */ }
  if (info && typeof info === 'object') {
    if (typeof info.at !== 'number' || Date.now() - info.at > LOCK_STALE_MS) return true;
    return !pidAlive(info.pid);
  }
  // Unparseable (possibly being written right now): judge by mtime only.
  try { return Date.now() - fs.statSync(lp).mtimeMs > LOCK_STALE_MS; } catch { return false; }
}

async function acquireLock(dir, waitMs) {
  const lp = lockPath(dir);
  const deadline = Date.now() + waitMs;
  for (;;) {
    const token = { pid: process.pid, at: Date.now() };
    try {
      fs.writeFileSync(lp, JSON.stringify(token), { flag: 'wx' });
      return token;
    } catch (e) {
      if (e.code !== 'EEXIST' && e.code !== 'EPERM' && e.code !== 'EACCES') throw e;
    }
    if (lockIsStale(lp)) {
      // Rename is atomic: only one contender moves the stale file aside.
      const aside = `${lp}.stale-${process.pid}-${rand()}`;
      try { fs.renameSync(lp, aside); fs.rmSync(aside, { force: true }); } catch { /* lost the race */ }
      continue;
    }
    if (Date.now() >= deadline) return null;
    await sleep(10 + Math.floor(Math.random() * 20));
  }
}

function releaseLock(dir, token) {
  const lp = lockPath(dir);
  try {
    const cur = JSON.parse(fs.readFileSync(lp, 'utf8'));
    if (cur.pid !== token.pid || cur.at !== token.at) return; // taken over; not ours
    fs.rmSync(lp, { force: true });
  } catch { /* already gone */ }
}

async function renameWithRetry(from, to) {
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (e) {
      const transient = e.code === 'EPERM' || e.code === 'EBUSY' || e.code === 'EACCES';
      if (!transient || i >= 20) {
        try { fs.rmSync(from, { force: true }); } catch { /* ignore */ }
        throw e;
      }
      await sleep(10 + i * 5);
    }
  }
}

export function pruneSessions(s, now) {
  for (const [id, sess] of Object.entries(s.sessions || {})) {
    const started = sess && typeof sess.startedAt === 'number' ? sess.startedAt : 0;
    if (now - started > SESSION_TTL_MS) delete s.sessions[id];
  }
}

export function blobPath(dir, hash) {
  return path.join(dir, 'blobs', hash);
}

export function writeBlob(dir, text) {
  const norm = normalizeText(text);
  const hash = sha256(norm);
  const bp = blobPath(dir, hash);
  if (fs.existsSync(bp)) return hash;
  fs.mkdirSync(path.dirname(bp), { recursive: true });
  const tmp = `${bp}.tmp-${process.pid}-${rand()}`;
  fs.writeFileSync(tmp, norm, 'utf8');
  try {
    fs.renameSync(tmp, bp);
  } catch (e) {
    // A concurrent writer may have created the same content; that is fine.
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    if (!fs.existsSync(bp)) throw e;
  }
  return hash;
}

export function gcBlobs(dir, s) {
  const keep = new Set();
  for (const f of Object.values(s.files || {})) if (f && f.reviewedHash) keep.add(f.reviewedHash);
  let names;
  try { names = fs.readdirSync(path.join(dir, 'blobs')); } catch { return; }
  for (const n of names) {
    if (!HASH_RE.test(n) || keep.has(n)) continue;
    try { fs.rmSync(path.join(dir, 'blobs', n), { force: true }); } catch { /* ignore */ }
  }
}

export async function withState(dir, fn, opts = {}) {
  const waitMs = opts.waitMs ?? 5000;
  fs.mkdirSync(dir, { recursive: true });
  const token = await acquireLock(dir, waitMs);
  if (!token) return false;
  try {
    const { state: s } = loadState(dir);
    if (!s) return false; // błąd odczytu: nie nadpisujemy stanu
    await fn(s);
    pruneSessions(s, Date.now());
    gcBlobs(dir, s);
    const tmp = path.join(dir, `state.json.tmp-${process.pid}-${rand()}`);
    fs.writeFileSync(tmp, JSON.stringify(s, null, 2), 'utf8');
    await renameWithRetry(tmp, statePath(dir));
    return true;
  } finally {
    releaseLock(dir, token);
  }
}
