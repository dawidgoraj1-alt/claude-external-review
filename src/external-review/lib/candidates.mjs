// Copyright (c) 2026 Dawid Góraj — external-review (https://github.com/dawidgoraj1-alt/claude-external-review). Licencja MIT.
import fs from 'node:fs';
import path from 'node:path';
import { matchAny, walk } from './glob.mjs';
import { committedSince, headSha, statusPaths } from './git.mjs';
import { canonical, relTo } from './paths.mjs';
import { readState, withState } from './state.mjs';
import { isBinary, normalizeText, sha256 } from './text.mjs';

const BASELINE_MAX_FILES = 2000;
const MTIME_SLACK_MS = 2000;
const WALK_MAX_FILES = 50000;

export function classify(rel, cfg, nocase) {
  const segs = rel.split('/');
  const norm = (s) => (nocase ? s.toLowerCase() : s);
  const dirs = new Set((cfg.ignoreDirs || []).map(norm));
  if (segs.some((s) => dirs.has(norm(s)))) return null;
  const o = { nocase };
  if (matchAny(rel, cfg.specPatterns || [], o)) return 'spec';
  if (matchAny(rel, cfg.planPatterns || [], o)) return 'plan';
  if (matchAny(rel, cfg.ignorePatterns || [], o)) return null;
  return 'code';
}

export function fileHash(root, rel) {
  let buf;
  try {
    const abs = path.join(root, rel);
    if (!fs.statSync(abs).isFile()) return null;
    buf = fs.readFileSync(abs);
  } catch {
    return null;
  }
  if (isBinary(buf)) return sha256(buf.toString('latin1'));
  return sha256(normalizeText(buf));
}

function dirtyPaths(ctx) {
  if (!ctx.isGit) return [];
  try { return statusPaths(ctx.root); } catch { return []; }
}

export function collectCandidates(ctx, s, sessionId) {
  const out = new Set(s.outstanding || []);
  const sess = s.sessions?.[sessionId];
  if (sess) {
    for (const t of sess.touched || []) out.add(t);
    if (ctx.isGit) {
      const snap = sess.snapshot || {};
      for (const rel of dirtyPaths(ctx)) {
        const h = fileHash(ctx.root, rel);
        if (h !== null && h !== snap[rel]) out.add(rel);
      }
      try {
        for (const rel of committedSince(ctx.root, sess.headSha)) out.add(rel);
      } catch { /* ignore */ }
    }
    // W git status (z nieśledzonymi) i committedSince już mieszczą się pliki spec/plan; pełne przeszukiwanie
    // katalogów (z vendor/, .idea/ itp.) zostaje tylko dla projektów bez gita.
    if (!ctx.isGit) {
      const since = (sess.startedAt || 0) - MTIME_SLACK_MS;
      const cfg = ctx.config;
      for (const f of walk(ctx.root, { ignoreDirs: cfg.ignoreDirs, nocase: ctx.nocase, maxFiles: WALK_MAX_FILES })) {
        if (f.mtimeMs < since) continue;
        const kind = classify(f.rel, cfg, ctx.nocase);
        if (kind === 'spec' || kind === 'plan') out.add(f.rel);
      }
    }
  }
  return [...out].sort();
}

export async function onPrompt(input, ctx) {
  const id = input.session_id;
  const cfg = ctx.config;
  if (cfg.enabled === false) return; // wyłączony: bez śledzenia (inaczej outstanding rośnie do ponownego włączenia)
  const firstRun = !fs.existsSync(path.join(ctx.stateDir, 'state.json'));
  const dirty = dirtyPaths(ctx).filter((rel) => classify(rel, cfg, ctx.nocase) !== null);
  const head = ctx.isGit ? headSha(ctx.root) : null;
  const snapshot = {};
  for (const rel of dirty) {
    const h = fileHash(ctx.root, rel);
    if (h !== null) snapshot[rel] = h;
  }
  // Expensive work (git, filesystem walk, hashing) happens outside the lock,
  // from a read-only snapshot; the lock only covers the cheap merge.
  const hashes = {};
  try {
    const s0 = readState(ctx.stateDir);
    if (s0.sessions[id]) {
      for (const rel of collectCandidates(ctx, s0, id)) {
        if (classify(rel, cfg, ctx.nocase) === null) continue;
        hashes[rel] = fileHash(ctx.root, rel);
      }
    }
    await withState(ctx.stateDir, (s) => {
      if (firstRun && Object.keys(s.files).length === 0) {
        // Baseline: pre-existing user changes are not reviewed wholesale.
        for (const rel of dirty.slice(0, BASELINE_MAX_FILES)) {
          if (snapshot[rel] === undefined) continue;
          s.files[rel] = { stage: classify(rel, cfg, ctx.nocase), reviewedHash: snapshot[rel], rounds: 0 };
        }
      }
      const prev = s.sessions[id];
      if (prev) {
        // Paths touched after the unlocked read (concurrent onTool) are hashed here: few and cheap.
        for (const rel of prev.touched || []) {
          if (!(rel in hashes) && classify(rel, cfg, ctx.nocase) !== null) hashes[rel] = fileHash(ctx.root, rel);
        }
        for (const [rel, h] of Object.entries(hashes)) {
          if (h === null || h === s.files[rel]?.reviewedHash) continue;
          if (!s.outstanding.includes(rel)) s.outstanding.push(rel);
        }
      }
      s.sessions[id] = {
        startedAt: ctx.now,
        headSha: head,
        snapshot,
        touched: [],
        warnedMissingCodex: prev?.warnedMissingCodex ?? false,
      };
    });
  } catch { /* hooks never throw */ }
}

export async function onTool(input, ctx) {
  if (ctx.config.enabled === false) return;
  const ti = input.tool_input || {};
  const p = ti.file_path || ti.notebook_path;
  if (typeof p !== 'string' || !p) return;
  const abs = canonical(path.resolve(ctx.cwd, p));
  const rel = relTo(ctx.root, abs);
  if (!rel || rel === '..' || rel.startsWith('../') || path.isAbsolute(rel)) return;
  try {
    await withState(ctx.stateDir, (s) => {
      const sess = s.sessions[input.session_id] ||= {
        startedAt: ctx.now, headSha: null, snapshot: {}, touched: [], warnedMissingCodex: false,
      };
      if (!sess.touched.includes(rel)) sess.touched.push(rel);
    });
  } catch { /* hooks never throw */ }
}
