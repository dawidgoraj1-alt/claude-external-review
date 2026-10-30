// Copyright (c) 2026 Dawid Góraj — external-review (https://github.com/dawidgoraj1-alt/claude-external-review). Licencja MIT.
// Plik „na żywo” z postępem recenzji (BASE/external-review/live/<sha1(root)>-<pid>.json) czytany przez linię statusu.
// Cały zapis jest best-effort: żaden błąd I/O nie może zepsuć ani spowolnić recenzji.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { baseDir, projectKey, toSlash } from './paths.mjs';
import { describeEvent } from './progress.mjs';

const STAGE_ORDER = ['spec', 'plan', 'code'];

export function liveDir(env = process.env) {
  return path.join(baseDir(env), 'external-review', 'live');
}

// Jedna sesja na proces; zadania równoległe (etapy) są agregowane w jednym pliku.
export function startLive({ root, env = process.env, throttleMs = 1000, heartbeatMs = 2000 }) {
  const startedAt = Date.now();
  const rootSlash = toSlash(root);
  const file = path.join(liveDir(env), `${crypto.createHash('sha1').update(projectKey(root), 'utf8').digest('hex')}-${process.pid}.json`);
  const jobs = new Set();
  let doneTokens = 0;
  let action = '';
  let lastWrite = 0;
  let dirty = false;
  let stopped = false;
  let trailing = null;

  const snapshot = () => {
    const live = [...jobs];
    return {
      root: rootSlash,
      stages: STAGE_ORDER.filter((s) => live.some((j) => j.stage === s)),
      files: [...new Set(live.flatMap((j) => j.files))],
      round: live.reduce((m, j) => Math.max(m, j.round), 0),
      startedAt,
      updatedAt: Date.now(),
      action,
      tokens: doneTokens + live.reduce((n, j) => n + j.tokens, 0),
      pid: process.pid,
    };
  };
  const write = () => {
    if (stopped || !jobs.size) return; // bez zadań nie ma co pokazywać (pusta lista etapów)
    lastWrite = Date.now();
    dirty = false;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(snapshot()), 'utf8');
      fs.renameSync(tmp, file);
    } catch { /* best-effort */ }
  };
  const touch = () => {
    dirty = true;
    const wait = throttleMs - (Date.now() - lastWrite);
    if (wait <= 0) write();
    else if (!trailing) {
      // Końcowy zapis po okresie dławienia, by ostatnie zdarzenia nie czekały na puls.
      trailing = setTimeout(() => { trailing = null; if (dirty) write(); }, wait);
      trailing.unref();
    }
  };
  const cleanup = () => {
    try { fs.rmSync(file, { force: true }); } catch { /* ignored */ }
    try { fs.rmSync(`${file}.tmp`, { force: true }); } catch { /* ignored */ }
  };

  const timer = setInterval(write, heartbeatMs);
  timer.unref();
  process.on('exit', cleanup);

  return {
    file,
    addJob({ stage, files = [], round = 1 }) {
      const job = { stage, files: [...files], round, tokens: 0 };
      jobs.add(job);
      write(); // dodanie zadania zawsze od razu widoczne, bez dławienia
      return {
        onEvent(evt) {
          try {
            const d = describeEvent(evt);
            if (d.action) action = d.action;
            if (d.tokens) job.tokens += d.tokens;
            if (d.action || d.tokens) touch();
          } catch { /* ignored */ }
        },
        done() {
          if (!jobs.delete(job)) return;
          doneTokens += job.tokens;
          touch();
        },
      };
    },
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      clearTimeout(trailing);
      process.removeListener('exit', cleanup);
      cleanup();
    },
  };
}
