// Tryby ręczne hook.mjs: --mark-reviewed, --manual, --pending, --save-display (spec §3.3, §8).
import fs from 'node:fs';
import path from 'node:path';
import { classify, fileHash } from './candidates.mjs';
import { readWindowsOverrides } from './codex.mjs';
import { headSha, statusPaths } from './git.mjs';
import { makeContext } from './context.mjs';
import { buildItems, chunkItems } from './material.mjs';
import { appendRound, attributedFiles, clearDisplayed, listPendingFiles, readPending, saveDisplay } from './pending.mjs';
import { canonical, relTo, toSlash } from './paths.mjs';
import { codexDeadline, markFileReviewed, resolveCodexPath, runJob } from './stop.mjs';
import { readState, withState, writeBlob } from './state.mjs';
import { isBinary, normalizeText, sha256 } from './text.mjs';

const STAGES = ['spec', 'plan', 'code'];
const STAGE_NAMES = { spec: 'specyfikacja', plan: 'plan', code: 'kod' };
const LIST_MAX = 20;

class UsageError extends Error {}

function list(rels) {
  const shown = rels.slice(0, LIST_MAX).join(', ');
  return rels.length > LIST_MAX ? `${shown} i ${rels.length - LIST_MAX} innych` : shown;
}

async function locked(ctx, fn) {
  const ok = await withState(ctx.stateDir, fn);
  if (!ok) throw new Error('blokada stanu zajęta lub stan chwilowo nieczytelny — spróbuj ponownie');
}

// --mark-reviewed: usuwa z pending uwagi pokazane użytkownikowi. reviewedHash zostaje treścią
// ocenioną przez Codexa (poprawki wrócą do recenzji). --final dodatkowo zapisuje BIEŻĄCĄ
// treść plików z rund tego etapu jako przejrzaną i zeruje licznik rund (Ruling 13); bez --final
// licznik jest zerowany dla plików niezmienionych od recenzji („żadne”).
export async function markReviewed(ctx, stage, { final = false } = {}) {
  let removed = 0;
  const finalized = [];
  // Odczyty plików i hashowanie poza blokadą; w blokadzie tylko zapisy stanu.
  const pending = readPending(ctx.stateDir, stage);
  const files = pending
    ? [...new Set([
      ...pending.rounds.flatMap((r) => (Array.isArray(r?.files) ? r.files : [])),
      ...pending.findings.map((f) => f.file),
    ].filter((f) => typeof f === 'string' && f))]
    : [];
  const current = [];
  for (const rel of files) {
    try {
      const buf = fs.readFileSync(path.join(ctx.root, rel));
      if (!isBinary(buf)) {
        const text = normalizeText(buf);
        current.push([rel, text, sha256(text)]);
      }
    } catch { /* brak pliku lub nie plik */ }
  }
  let noDisplay = false;
  await locked(ctx, (s) => {
    removed = clearDisplayed(ctx.stateDir, stage);
    if (removed === null) { noDisplay = true; return; }
    if (!final) {
      // „żadne”: plik niezmieniony od recenzji → cykl poprawek zakończony, licznik rund od zera.
      for (const [rel, , hash] of current) {
        const cur = s.files[rel];
        if (cur && cur.reviewedHash === hash) cur.rounds = 0;
      }
      return;
    }
    for (const [rel, text] of current) {
      s.files[rel] = { stage, reviewedHash: writeBlob(ctx.stateDir, text), rounds: 0 };
      s.outstanding = (s.outstanding || []).filter((r) => r !== rel);
      finalized.push(rel);
    }
  });
  if (noDisplay) {
    return `Etap ${STAGE_NAMES[stage]}: brak zapisanej numeracji pokazanych uwag — nic nie usunięto ani nie oznaczono. `
      + `Najpierw zapisz numerację: --save-display --stage ${stage} (JSON numer → id uwagi na stdin), potem ponów --mark-reviewed.`;
  }
  let line = `Etap ${STAGE_NAMES[stage]}: usunięto z pending uwag: ${removed}.`;
  if (final) {
    line += ` Bieżąca treść oznaczona jako przejrzana (${finalized.length} plików${finalized.length ? `: ${list(finalized)}` : ''}).`;
  }
  return line;
}

export function listPending(ctx) {
  return { pendingFiles: listPendingFiles(ctx.stateDir).map(toSlash) };
}

function resolveRels(ctx, paths) {
  const rels = [];
  for (const p of paths) {
    const abs = canonical(path.resolve(ctx.cwd, p));
    const rel = relTo(ctx.root, abs);
    if (!rel || rel === '..' || rel.startsWith('../') || path.isAbsolute(rel)) {
      throw new UsageError(`Ścieżka poza projektem: ${p}`);
    }
    let st;
    try { st = fs.statSync(abs); } catch { throw new UsageError(`Plik nie istnieje: ${p}`); }
    if (!st.isFile()) throw new UsageError(`To nie jest plik: ${p}`);
    if (!rels.includes(rel)) rels.push(rel);
  }
  return rels;
}

function fullItem(ctx, rel) {
  let buf;
  try { buf = fs.readFileSync(path.join(ctx.root, rel)); } catch { return null; }
  if (isBinary(buf)) return null;
  const content = normalizeText(buf);
  const n = content === '' ? 0 : content.split('\n').length - (content.endsWith('\n') ? 1 : 0);
  return { path: rel, kind: 'full', text: content, changedLines: n, hash: sha256(content), content };
}

// --manual: bez bramki hashy, progu i limitu rund. exitCode: 0, 1 (błąd Codexa), 2 (argumenty).
export async function runManual(ctx, paths) {
  const cfg = ctx.config;
  const warnings = [];
  const explicit = paths.length > 0;
  const pendingNow = () => listPendingFiles(ctx.stateDir).map(toSlash);
  let rels;
  if (paths.length) {
    rels = resolveRels(ctx, paths);
  } else {
    if (!ctx.isGit) {
      process.stderr.write('Poza repozytorium git podaj ścieżki plików do recenzji: hook.mjs --manual --cwd <katalog> <ścieżki...>\n');
      return { pendingFiles: [], warnings, exitCode: 2 };
    }
    rels = statusPaths(ctx.root).filter((r) => classify(r, cfg, ctx.nocase) === 'code' && fileHash(ctx.root, r) !== null);
  }

  const review = { spec: [], plan: [], code: [] };
  for (const rel of rels) {
    const stage = classify(rel, cfg, ctx.nocase);
    if (!stage) warnings.push(`Pominięto plik wykluczony z recenzji (ignorePatterns/ignoreDirs): ${rel}.`);
    else review[stage].push(rel);
  }
  if (!STAGES.some((st) => review[st].length)) return { pendingFiles: pendingNow(), warnings, exitCode: 0 };

  const codexPath = resolveCodexPath(cfg);
  if (!codexPath) {
    process.stderr.write(`Nie znaleziono polecenia Codexa (${cfg.codexPath || 'codex'}). Sprawdź instalację (node install.mjs).\n`);
    return { pendingFiles: pendingNow(), warnings, exitCode: 1 };
  }

  const s0 = readState(ctx.stateDir);
  const head = ctx.isGit ? headSha(ctx.root) : null;
  const jobs = [];
  for (const stage of STAGES) {
    if (!review[stage].length) continue;
    const { items, skipped } = buildItems(ctx, s0, stage, review[stage], { headSha: head });
    if (skipped.length) warnings.push(`Pominięto pliki binarne: ${list(skipped.map((x) => x.path))}.`);
    const withItems = new Set(items.map((i) => i.path));
    const empty = review[stage].filter((r) => !withItems.has(r) && !skipped.some((x) => x.path === r));
    // Jawnie wskazany plik bez diffu (czysty / treść == reviewedHash) jest recenzowany w całości (Ruling 17).
    if (explicit) items.push(...empty.map((r) => fullItem(ctx, r)).filter(Boolean));
    else if (empty.length) warnings.push(`Brak zmian do recenzji: ${list(empty)}.`);
    const { chunks, overflow, tooLarge } = chunkItems(items, cfg.maxReviewBytes, cfg.maxChunks);
    if (overflow.length || tooLarge.length) {
      warnings.push(`Pliki etapu ${STAGE_NAMES[stage]} poza limitem materiału (${cfg.maxReviewBytes} B × ${cfg.maxChunks} porcji) — pominięte: ${list([...tooLarge, ...overflow])}.`);
    }
    for (const chunk of chunks) {
      const files = [...new Set(chunk.map((i) => i.path))];
      const round = Math.max(...files.map((f) => s0.files[f]?.rounds ?? 0)) + 1;
      jobs.push({ stage, items: chunk, files, round });
    }
  }
  if (!jobs.length) return { pendingFiles: pendingNow(), warnings, exitCode: 0 };

  // Codex bez blokady stanu; każde wywołanie ma własny katalog na plik wyniku (R10).
  const deadline = codexDeadline(Date.now(), cfg.hookTimeoutSec);
  const overrides = readWindowsOverrides();
  const results = await Promise.all(jobs.map((job) => runJob(ctx, codexPath, job, { deadline, overrides, onSpawn: () => {} })));

  let failed = false;
  await locked(ctx, (s) => {
    jobs.forEach((job, i) => {
      const r = results[i];
      if (!r.ok) {
        failed = true;
        warnings.push(`Recenzja etapu ${STAGE_NAMES[job.stage]} nie powiodła się (${r.error}); pliki: ${list(job.files)}.`);
        return;
      }
      // Najpierw uwagi do pending; pliki oznaczane jako przejrzane tylko po udanym zapisie.
      try {
        appendRound(ctx.stateDir, job.stage, {
          files: job.files, summary: r.result.summary, findings: r.result.findings, round: job.round, at: new Date().toISOString(),
        });
      } catch (e) {
        failed = true;
        s.outstanding = [...new Set([...(s.outstanding || []), ...job.files])];
        warnings.push(`Nie udało się zapisać uwag etapu ${STAGE_NAMES[job.stage]} (${e.message}); pliki czekają na recenzję: ${list(job.files)}.`);
        return;
      }
      const hit = attributedFiles(job.files, r.result.findings);
      for (const rel of job.files) {
        markFileReviewed(ctx.stateDir, s, rel, job.stage, job.items.find((it) => it.path === rel), hit.has(rel));
      }
      s.outstanding = (s.outstanding || []).filter((x) => !job.files.includes(x));
    });
  });
  return { pendingFiles: pendingNow(), warnings, exitCode: failed ? 1 : 0 };
}

const VALUE_FLAGS = new Set(['--stage', '--cwd']);
const MODES = new Set(['--mark-reviewed', '--manual', '--pending', '--save-display']);

function parseArgs(argv) {
  const mode = argv[0];
  if (!MODES.has(mode)) throw new UsageError(`Nieznane argumenty: ${argv.join(' ')}`);
  const o = { mode, paths: [], final: false };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { o.paths.push(...argv.slice(i + 1)); break; }
    if (VALUE_FLAGS.has(a)) {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new UsageError(`Brak wartości dla ${a}`);
      o[a.slice(2)] = v;
    } else if (a === '--final') {
      o.final = true;
    } else if (a.startsWith('--')) {
      throw new UsageError(`Nieznany argument: ${a}`);
    } else {
      o.paths.push(a);
    }
  }
  if (o.paths.length && mode !== '--manual') throw new UsageError('Ścieżki są dozwolone tylko z --manual');
  if (o.final && mode !== '--mark-reviewed') throw new UsageError('--final jest dozwolone tylko z --mark-reviewed');
  if (!o.cwd) throw new UsageError('Brak --cwd <katalog>');
  let isDir = false;
  try { isDir = fs.statSync(o.cwd).isDirectory(); } catch { /* nieistniejący */ }
  if (!isDir) throw new UsageError(`Katalog nie istnieje: ${o.cwd}`);
  const needsStage = mode === '--mark-reviewed' || mode === '--save-display';
  if (needsStage && !STAGES.includes(o.stage)) throw new UsageError('Wymagane --stage spec|plan|code');
  if (!needsStage && o.stage !== undefined) throw new UsageError('--stage nie dotyczy tego trybu');
  return o;
}

function parseDisplay(raw) {
  let v;
  try { v = JSON.parse(raw.replace(/^﻿/, '')); } catch { throw new UsageError('Stdin nie zawiera poprawnego JSON'); }
  if (!v || typeof v !== 'object' || Array.isArray(v) || !Object.values(v).every((x) => typeof x === 'string')) {
    throw new UsageError('Oczekiwano obiektu JSON {"<nr>":"<id uwagi>"}');
  }
  return v;
}

// Zwraca {code, stdout?}; komunikaty błędów idą na stderr. Wyjątek → kod 1.
export async function runManualCli(argv, { readStdin, env = process.env } = {}) {
  try {
    const o = parseArgs(argv);
    const map = o.mode === '--save-display' ? parseDisplay(await readStdin()) : null;
    const ctx = makeContext(path.resolve(o.cwd), env);
    switch (o.mode) {
      case '--mark-reviewed':
        return { code: 0, stdout: `${await markReviewed(ctx, o.stage, { final: o.final })}\n` };
      case '--pending':
        return { code: 0, stdout: JSON.stringify(listPending(ctx)) };
      case '--save-display':
        await locked(ctx, () => saveDisplay(ctx.stateDir, o.stage, map));
        return { code: 0 };
      default: {
        const { pendingFiles, warnings, exitCode } = await runManual(ctx, o.paths);
        return { code: exitCode, stdout: exitCode === 2 ? undefined : JSON.stringify({ pendingFiles, warnings }) };
      }
    }
  } catch (e) {
    if (e instanceof UsageError) {
      process.stderr.write(`${e.message}\n`);
      return { code: 2 };
    }
    process.stderr.write(`Błąd external-review: ${e?.message || e}\n`);
    return { code: 1 };
  }
}
