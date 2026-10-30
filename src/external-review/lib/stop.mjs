// Copyright (c) 2026 Dawid Góraj — external-review (https://github.com/dawidgoraj1-alt/claude-external-review). Licencja MIT.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { classify, collectCandidates, fileHash } from './candidates.mjs';
import { changedBetween, snapshotWorkspace } from './changes.mjs';
import { buildArgs, killTree, readWindowsOverrides, resolveCodex, runCodex } from './codex.mjs';
import { buildItems, chunkItems, meetsThreshold } from './material.mjs';
import { blockOutput, messageOutput } from './output.mjs';
import { appendRound, attributedFiles, listPendingFiles, pendingPath } from './pending.mjs';
import { renderPrompt } from './prompt.mjs';
import { startLive } from './live.mjs';
import { skillDir, toSlash } from './paths.mjs';
import { readState, withState, writeBlob } from './state.mjs';

const STAGES = ['spec', 'plan', 'code'];
const STAGE_NAMES = { spec: 'specyfikacja', plan: 'plan', code: 'kod' };
const LIST_MAX = 20;

function list(rels) {
  const shown = rels.slice(0, LIST_MAX).join(', ');
  return rels.length > LIST_MAX ? `${shown} i ${rels.length - LIST_MAX} innych` : shown;
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

// Wpis codexPids: {pid, hookPid, startedAt} (hookPid = proces hooka, który uruchomił Codexa);
// sama liczba = stary format.
const pidOf = (e) => (typeof e === 'number' ? e : e?.pid);

function addUnique(arr, rels) {
  for (const r of rels) if (!arr.includes(r)) arr.push(r);
}

function removeAll(arr, rels) {
  const drop = new Set(rels);
  return arr.filter((r) => !drop.has(r));
}

function failuresAt(f) {
  if (typeof f?.lastAt === 'number') return f.lastAt;
  const t = Date.parse(f?.lastAt ?? '');
  return Number.isNaN(t) ? null : t;
}

// R1: wspólny termin wywołań Codexa = start hooka + hookTimeoutSec − min(60 s, 10%).
export function codexDeadline(start, hookTimeoutSec) {
  const total = hookTimeoutSec * 1000;
  return start + total - Math.min(60_000, total * 0.1);
}

export function resolveCodexPath(cfg) {
  return resolveCodex(cfg.codexPath || 'codex');
}

// Obrazy procesów, które mogą być drzewem Codexa (shim .cmd → cmd.exe, npm → node).
const CODEX_IMAGES = new Set(['codex', 'codex.exe', 'node', 'node.exe', 'cmd.exe']);

// Zawieszony tasklist/ps (np. WMI) nie może blokować hooka Stop.
const LOOKUP_OPTS = { encoding: 'utf8', windowsHide: true, timeout: 5000 };

// Nazwa obrazu procesu (małymi literami) albo null, gdy nie da się jej ustalić
// (błąd, timeout, brak procesu) — wtedy wpis jest usuwany bez zabijania.
export function processImage(pid, platform = process.platform, run = spawnSync) {
  try {
    if (platform === 'win32') {
      const r = run('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], LOOKUP_OPTS);
      if (r.error || r.status !== 0) return null;
      const m = /^"([^"]+)","(\d+)"/m.exec(r.stdout || '');
      return m && Number(m[2]) === pid ? m[1].toLowerCase() : null;
    }
    const r = run('ps', ['-o', 'comm=', '-p', String(pid)], LOOKUP_OPTS);
    if (r.error || r.status !== 0) return null;
    const name = (r.stdout || '').trim();
    return name ? path.basename(name).toLowerCase() : null;
  } catch {
    return null;
  }
}

// Krok 2: zabicie osieroconych drzew Codexa. Ochrona przed ponownym użyciem PID-u:
// wpisy starsze niż hookTimeoutSec + 60 s (termin ich hooka minął) i wpisy bez startedAt
// (stary format) są usuwane BEZ zabijania; młodsze z martwym hookiem — zabijane tylko,
// gdy proces wygląda na Codexa/node.
async function killOrphans(ctx) {
  const entries = readState(ctx.stateDir).codexPids;
  if (!Array.isArray(entries) || entries.length === 0) return;
  const maxAge = ctx.config.hookTimeoutSec * 1000 + 60_000;
  const now = Date.now();
  const handled = [];
  for (const e of entries) {
    const pid = pidOf(e);
    const valid = e && typeof e === 'object' && typeof e.startedAt === 'number';
    if (valid && now - e.startedAt <= maxAge) {
      if (e.hookPid && e.hookPid !== process.pid && pidAlive(e.hookPid)) continue; // żywy hook
      if (pidAlive(pid) && CODEX_IMAGES.has(processImage(pid))) killTree(pid);
    }
    handled.push(pid);
  }
  if (handled.length) {
    await withState(ctx.stateDir, (s) => {
      s.codexPids = (s.codexPids || []).filter((e) => !handled.includes(pidOf(e)));
    });
  }
}

// Kroki 5–6: klasyfikacja i filtry na podstawie odczytu bez blokady.
function triage(ctx, s0, candidates) {
  const cfg = ctx.config;
  const t = { drop: [], deleted: [], limit: [], review: { spec: [], plan: [], code: [] } };
  for (const rel of candidates) {
    const stage = classify(rel, cfg, ctx.nocase);
    if (!stage) { t.drop.push(rel); continue; }
    if (!fs.existsSync(path.join(ctx.root, rel))) { t.deleted.push(rel); continue; }
    const h = fileHash(ctx.root, rel);
    const entry = s0.files[rel];
    if (h === null || entry?.reviewedHash === h) { t.drop.push(rel); continue; }
    if ((entry?.rounds ?? 0) >= cfg.maxReviewRounds) { t.limit.push(rel); continue; }
    t.review[stage].push(rel);
  }
  return t;
}

// Wspólna część każdego zapisu stanu po Stop (pod blokadą).
function applyTriage(ctx, s, t, { markLimit }) {
  for (const rel of t.deleted) delete s.files[rel];
  s.outstanding = removeAll(s.outstanding || [], [...t.drop, ...t.deleted]);
  if (!markLimit) return;
  for (const rel of t.limit) {
    let text;
    try { text = fs.readFileSync(path.join(ctx.root, rel), 'utf8'); } catch { continue; }
    const cur = s.files[rel] || {};
    // Licznik rund zerowany: kolejne zmiany pliku zaczynają nowy cykl recenzji.
    s.files[rel] = { stage: cur.stage || classify(rel, ctx.config, ctx.nocase), reviewedHash: writeBlob(ctx.stateDir, text), rounds: 0 };
  }
  s.outstanding = removeAll(s.outstanding, t.limit);
}

// Zapis wyniku recenzji pliku (pod blokadą). Licznik rund rośnie tylko, gdy recenzja przypisała
// plikowi uwagi (pętla poprawek); recenzja bez uwag kończy cykl i zeruje licznik.
export function markFileReviewed(dir, s, rel, stage, item, hadFindings) {
  const cur = s.files[rel];
  if (cur?.reviewedHash !== item.hash) {
    s.files[rel] = { stage, reviewedHash: writeBlob(dir, item.content), rounds: hadFindings ? (cur?.rounds ?? 0) + 1 : 0 };
  } else if (!hadFindings) {
    cur.rounds = 0;
  }
}

function limitWarning(ctx, t) {
  if (!t.limit.length) return [];
  return [`Osiągnięto limit rund recenzji (${ctx.config.maxReviewRounds}) — bieżąca treść oznaczona jako przejrzana: ${list(t.limit)}.`];
}

function finish(ctx, { lines = [], warnings = [] }) {
  const pendingFiles = listPendingFiles(ctx.stateDir).map(toSlash);
  if (!lines.length && !warnings.length && !pendingFiles.length) return null;
  return messageOutput({ lines, warnings, pendingFiles });
}

// Jedno wywołanie Codexa dla porcji; własny katalog tymczasowy na plik wyniku (R10).
export async function runJob(ctx, codexPath, job, { deadline, overrides, onSpawn, onEvent }) {
  const cfg = ctx.config;
  let tmp = null;
  try {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'er-codex-'));
    const outPath = path.join(tmp, 'out.json');
    fs.rmSync(outPath, { force: true });
    const timeoutMs = Math.min(cfg.codexTimeoutSec * 1000, deadline - Date.now());
    if (timeoutMs <= 0) return { ok: false, error: 'brak czasu do terminu hooka' };
    const prompt = renderPrompt(job.stage, { items: job.items, round: job.round, cfg });
    const schemaPath = path.join(skillDir(), 'schema', 'findings.json');
    const args = buildArgs(cfg, { cwd: ctx.root, schemaPath, outPath, overrides });
    return await runCodex({ codexPath, args, prompt, timeoutMs, onSpawn, onEvent });
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  } finally {
    if (tmp) { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } }
  }
}

// Uruchamia zadania równolegle z plikiem postępu „na żywo” (zawsze sprzątanym w finally)
// i zapisuje PID-y Codexa w stanie (sprzątanie osieroconych procesów).
export async function runJobsLive(ctx, jobs, codexPath, { deadline, overrides, pids }, stateDir) {
  const live = startLive({ root: ctx.root, env: ctx.env });
  try {
    const runs = jobs.map((job) => {
      const h = live.addJob(job);
      return runJob(ctx, codexPath, job, { deadline, overrides, onSpawn: (pid) => pids.push(pid), onEvent: h.onEvent }).finally(h.done);
    });
    if (pids.length) {
      await withState(stateDir, (s) => {
        s.codexPids = [...(s.codexPids || []), ...pids.map((pid) => ({ pid, hookPid: process.pid, startedAt: Date.now() }))];
      });
    }
    return await Promise.all(runs);
  } finally {
    live.stop();
  }
}

// Krok 8: materiał, próg i porcje → zadania dla Codexa. Pliki binarne i pliki, których materiał
// sam przekracza maxReviewBytes, nie mogą być nigdy zrecenzowane: ostrzeżenie raz i bieżący hash
// jako reviewedHash (bez bloba) — inaczej zostawałyby w outstanding i ostrzegały przy każdym Stop.
function planJobs(ctx, s0, t, headSha) {
  const cfg = ctx.config;
  const jobs = [];
  const outstanding = [];
  const warnings = [];
  const unreviewable = [];
  const markUnreviewable = (stage, rels) => {
    for (const rel of rels) {
      const hash = fileHash(ctx.root, rel);
      if (hash !== null) unreviewable.push({ rel, stage, hash });
    }
  };
  for (const stage of STAGES) {
    const rels = t.review[stage];
    if (!rels.length) continue;
    const { items, skipped } = buildItems(ctx, s0, stage, rels, { headSha });
    if (skipped.length) {
      const bin = skipped.map((x) => x.path);
      markUnreviewable(stage, bin);
      warnings.push(`Pominięto pliki binarne (oznaczone jako przejrzane): ${list(bin)}.`);
    }
    const withItems = [...new Set(items.map((i) => i.path))];
    if (stage === 'code' && !meetsThreshold(items, cfg.codeMinChangedLines)) {
      outstanding.push(...withItems);
      continue;
    }
    const { chunks, overflow, tooLarge } = chunkItems(items, cfg.maxReviewBytes, cfg.maxChunks);
    if (tooLarge.length) {
      markUnreviewable(stage, tooLarge);
      warnings.push(`Materiał pliku przekracza limit maxReviewBytes (${cfg.maxReviewBytes} B) — plik pominięty i oznaczony jako przejrzany (użyj /external-review po zmniejszeniu zmian lub zwiększ limit): ${list(tooLarge)}.`);
    }
    if (overflow.length) {
      outstanding.push(...overflow);
      warnings.push(`Pliki etapu ${STAGE_NAMES[stage]} poza limitem materiału (${cfg.maxReviewBytes} B × ${cfg.maxChunks} porcji) pozostają do recenzji: ${list(overflow)}.`);
    }
    for (const chunk of chunks) {
      const files = [...new Set(chunk.map((i) => i.path))];
      const round = Math.max(...files.map((f) => s0.files[f]?.rounds ?? 0)) + 1;
      jobs.push({ stage, items: chunk, files, round });
    }
  }
  return { jobs, outstanding, warnings, unreviewable };
}

// Pod blokadą: pliki niemożliwe do recenzji oznaczane bieżącym hashem (bez bloba).
function applyUnreviewable(s, planned) {
  for (const { rel, stage, hash } of planned.unreviewable) {
    s.files[rel] = { stage, reviewedHash: hash, rounds: 0 };
  }
  s.outstanding = removeAll(s.outstanding || [], planned.unreviewable.map((u) => u.rel));
}

function safeSnapshot(ctx) {
  try { return snapshotWorkspace(ctx); } catch { return null; }
}

export async function runStop(input, ctx) {
  const cfg = ctx.config;
  if (cfg.enabled === false) return null;
  const start = ctx.now;
  const dir = ctx.stateDir;
  const sid = String(input.session_id ?? '');

  await killOrphans(ctx);

  // Kroki 3, 5, 6 — bez blokady.
  const s0 = readState(dir);
  const sess0 = s0.sessions[sid];
  const t = triage(ctx, s0, collectCandidates(ctx, s0, sid));
  const reviewAll = STAGES.flatMap((st) => t.review[st]);

  // Krok 4.
  if (input.stop_hook_active === true) {
    await withState(dir, (s) => {
      applyTriage(ctx, s, t, { markLimit: false });
      addUnique(s.outstanding, [...reviewAll, ...t.limit]);
    });
    return null;
  }

  const warnings = limitWarning(ctx, t);
  if (!reviewAll.length) {
    const ok = await withState(dir, (s) => applyTriage(ctx, s, t, { markLimit: true }));
    if (!ok) warnings.push('Nie udało się zapisać stanu recenzji (blokada stanu zajęta lub stan chwilowo nieczytelny).');
    return finish(ctx, { warnings });
  }

  // Krok 7: backoff po kolejnych błędach i brak polecenia Codexa.
  const lastAt = failuresAt(s0.failures);
  if ((s0.failures?.consecutive ?? 0) >= 2 && lastAt !== null && start - lastAt < cfg.failureBackoffMin * 60_000) {
    await withState(dir, (s) => {
      applyTriage(ctx, s, t, { markLimit: true });
      addUnique(s.outstanding, reviewAll);
    });
    warnings.unshift(`Recenzja Codex wstrzymana na ${cfg.failureBackoffMin} min po kolejnych nieudanych wywołaniach; pliki czekają na recenzję: ${list(reviewAll)}.`);
    return finish(ctx, { warnings });
  }
  const codexPath = resolveCodexPath(cfg);
  if (!codexPath) {
    let warn = false;
    await withState(dir, (s) => {
      applyTriage(ctx, s, t, { markLimit: true });
      addUnique(s.outstanding, reviewAll);
      const sess = s.sessions[sid] ||= {
        startedAt: ctx.now, headSha: null, snapshot: {}, touched: [], warnedMissingCodex: false,
      };
      warn = !sess.warnedMissingCodex;
      sess.warnedMissingCodex = true;
    });
    if (warn) warnings.unshift(`Nie znaleziono polecenia Codexa (${cfg.codexPath || 'codex'}) — recenzja pominięta, pliki czekają na recenzję. Sprawdź instalację (node install.mjs).`);
    return finish(ctx, { warnings });
  }

  // Krok 8.
  const planned = planJobs(ctx, s0, t, sess0?.headSha ?? null);
  warnings.push(...planned.warnings);
  const { jobs } = planned;
  if (!jobs.length) {
    await withState(dir, (s) => {
      applyTriage(ctx, s, t, { markLimit: true });
      applyUnreviewable(s, planned);
      addUnique(s.outstanding, planned.outstanding);
    });
    return finish(ctx, { warnings });
  }

  // Kroki 9–11: migawka „przed”, Codex równolegle (stan bez blokady), migawka „po”.
  const before = safeSnapshot(ctx);
  const deadline = codexDeadline(start, cfg.hookTimeoutSec);
  const overrides = readWindowsOverrides();
  const pids = [];
  const results = await runJobsLive(ctx, jobs, codexPath, { deadline, overrides, pids }, dir);
  const after = before ? safeSnapshot(ctx) : null;
  const changed = before && after ? changedBetween(before, after, cfg, ctx.nocase) : [];
  const changedHashes = Object.fromEntries(changed.map((rel) => [rel, fileHash(ctx.root, rel)]));

  // Krok 12: scalenie wyników pod blokadą.
  let newCount = 0;
  const stagesWithFindings = new Set();
  const reviewedStages = new Set();
  const reviewedFiles = [];
  const failWarnings = [];
  const saved = await withState(dir, (s) => {
    applyTriage(ctx, s, t, { markLimit: true });
    applyUnreviewable(s, planned);
    addUnique(s.outstanding, planned.outstanding);
    let anyOk = false;
    let anyFail = false;
    jobs.forEach((job, i) => {
      const r = results[i];
      if (!r.ok) {
        anyFail = true;
        addUnique(s.outstanding, job.files);
        failWarnings.push(`Recenzja etapu ${STAGE_NAMES[job.stage]} nie powiodła się (${r.error}); pliki czekają na recenzję: ${list(job.files)}.`);
        return;
      }
      anyOk = true;
      // Najpierw uwagi do pending; pliki oznaczane jako przejrzane tylko po udanym zapisie,
      // inaczej uwagi przepadłyby bez śladu.
      let ids;
      try {
        ids = appendRound(dir, job.stage, {
          files: job.files, summary: r.result.summary, findings: r.result.findings, round: job.round, at: new Date().toISOString(),
        });
      } catch (e) {
        addUnique(s.outstanding, job.files);
        failWarnings.push(`Nie udało się zapisać uwag etapu ${STAGE_NAMES[job.stage]} (${e.message}); pliki czekają na recenzję: ${list(job.files)}.`);
        return;
      }
      newCount += ids.length;
      if (ids.length) stagesWithFindings.add(job.stage);
      reviewedStages.add(job.stage);
      const hit = attributedFiles(job.files, r.result.findings);
      for (const rel of job.files) {
        const item = job.items.find((it) => it.path === rel);
        const cur = s.files[rel];
        const seen = s0.files[rel]?.reviewedHash;
        // Inny proces zmienił reviewedHash w międzyczasie — nie nadpisujemy jego zapisu.
        const concurrent = cur?.reviewedHash !== undefined && cur.reviewedHash !== seen;
        if (!concurrent) markFileReviewed(dir, s, rel, job.stage, item, hit.has(rel));
        reviewedFiles.push(rel);
      }
      s.outstanding = removeAll(s.outstanding, job.files);
    });
    if (anyOk) s.failures = { consecutive: 0, lastAt: s.failures?.lastAt ?? null };
    else if (anyFail) s.failures = { consecutive: (s.failures?.consecutive ?? 0) + 1, lastAt: Date.now() };
    s.codexPids = (s.codexPids || []).filter((e) => !pids.includes(pidOf(e)));
    // 6.1: pliki zmienione przez Codexa nie są zmianami Claude'a.
    const sess = s.sessions[sid];
    if (sess && changed.length) {
      sess.snapshot ||= {};
      for (const [rel, h] of Object.entries(changedHashes)) {
        if (h === null) delete sess.snapshot[rel];
        else sess.snapshot[rel] = h;
      }
      sess.touched = removeAll(sess.touched || [], changed);
    }
  });

  warnings.push(...failWarnings);
  if (!saved) warnings.push('Nie udało się zapisać wyników recenzji (blokada stanu zajęta lub stan chwilowo nieczytelny); pliki wrócą do recenzji.');
  if (changed.length) warnings.push(`Codex zmienił pliki projektu (zmian nie cofnięto): ${list(changed)}.`);

  // Krok 13.
  if (saved && newCount > 0) {
    const stages = STAGES.filter((st) => stagesWithFindings.has(st));
    return blockOutput({
      stages, count: newCount, warnings,
      pendingFiles: stages.map((st) => toSlash(pendingPath(dir, st))),
    });
  }
  const lines = [];
  if (reviewedStages.size) {
    const names = STAGES.filter((st) => reviewedStages.has(st)).map((st) => STAGE_NAMES[st]).join(', ');
    lines.push(`Zewnętrzna recenzja Codex (${names}): brak nowych uwag. Pliki: ${list(reviewedFiles)}.`);
  } else {
    lines.push('Zewnętrzna recenzja Codex nie powiodła się.');
  }
  return finish(ctx, { lines, warnings });
}
