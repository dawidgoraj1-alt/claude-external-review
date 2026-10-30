import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { matchAny, walk } from './glob.mjs';
import { statusDeletedPaths, statusPaths } from './git.mjs';

const WALK_MAX_FILES = 50000;
const SENSITIVE_MAX_FILES = 5000;
const DELETED = 'deleted';

// Ścieżki wrażliwe sprawdzane zawsze (także gdy git je ignoruje lub leżą w .git):
// zmiana mogłaby uruchomić kod (hooki gita, aliasy w .git/config, konfiguracja Claude Code,
// zadania edytora, workflow CI).
const SENSITIVE_DIRS = ['.git/hooks', '.claude', '.vscode', '.github/workflows'];
const SENSITIVE_FILES = ['.git/config'];
const SENSITIVE_PATTERNS = [...SENSITIVE_DIRS.map((d) => `${d}/**`), ...SENSITIVE_FILES];

function isSensitive(rel, nocase) {
  return matchAny(rel, SENSITIVE_PATTERNS, { nocase });
}

function addSensitive(ctx, snap) {
  for (const d of SENSITIVE_DIRS) {
    for (const f of walk(path.join(ctx.root, d), { maxFiles: SENSITIVE_MAX_FILES })) {
      const rel = `${d}/${f.rel}`;
      snap.set(rel, hashFile(path.join(ctx.root, rel)));
    }
  }
  for (const rel of SENSITIVE_FILES) {
    const abs = path.join(ctx.root, rel);
    try { if (fs.statSync(abs).isFile()) snap.set(rel, hashFile(abs)); } catch { /* brak */ }
  }
}

function hashFile(abs) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
  } catch {
    return 'unreadable';
  }
}

// Migawka: git -> sciezka => hash tresci (pliki widziane przez git status);
// poza gitem -> sciezka => "rozmiar:mtimeMs". Zawsze dodatkowo hash tresci sciezek wrazliwych.
export function snapshotWorkspace(ctx) {
  const snap = new Map();
  const dirs = new Set((ctx.config.ignoreDirs || []).map((d) => (ctx.nocase ? d.toLowerCase() : d)));
  const inIgnoredDir = (rel) =>
    rel.split('/').slice(0, -1).some((s) => dirs.has(ctx.nocase ? s.toLowerCase() : s));
  if (ctx.isGit) {
    for (const rel of statusPaths(ctx.root)) {
      if (inIgnoredDir(rel)) continue;
      snap.set(rel, hashFile(path.join(ctx.root, rel)));
    }
    for (const rel of statusDeletedPaths(ctx.root)) {
      if (!inIgnoredDir(rel)) snap.set(rel, DELETED);
    }
  } else {
    for (const f of walk(ctx.root, { ignoreDirs: ctx.config.ignoreDirs, nocase: ctx.nocase, maxFiles: WALK_MAX_FILES })) {
      snap.set(f.rel, `${f.size}:${f.mtimeMs}`);
    }
  }
  addSensitive(ctx, snap);
  return snap;
}

// Nowe, zmienione i usuniete sciezki (bez ignorePatterns / ignoreDirs).
export function changedBetween(before, after, cfg, nocase) {
  const norm = (s) => (nocase ? s.toLowerCase() : s);
  const dirs = new Set((cfg.ignoreDirs || []).map(norm));
  const o = { nocase };
  // Klasyfikacja przed ignorowaniem: spec/plan raportowane mimo ignorePatterns.
  // Ścieżki wrażliwe raportowane zawsze (mimo ignoreDirs / ignorePatterns).
  const skip = (rel) => !isSensitive(rel, nocase) && (
    rel.split('/').slice(0, -1).some((s) => dirs.has(norm(s))) ||
    (matchAny(rel, cfg.ignorePatterns || [], o) &&
      !matchAny(rel, cfg.specPatterns || [], o) && !matchAny(rel, cfg.planPatterns || [], o)));
  const out = [];
  for (const [rel, h] of after) {
    if (!before.has(rel) || before.get(rel) !== h) out.push(rel);
  }
  for (const rel of before.keys()) {
    if (!after.has(rel)) out.push(rel);
  }
  return out.filter((r) => !skip(r)).sort();
}
