// Copyright (c) 2026 Dawid Góraj — external-review (https://github.com/dawidgoraj1-alt/claude-external-review). Licencja MIT.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const SEVERITIES = ['critical', 'important', 'minor'];

function stripTomlComment(v) {
  let q = null;
  for (let i = 0; i < v.length; i++) {
    const c = v[i];
    if (q) {
      if (c === '\\' && q === '"') i++;
      else if (c === q) q = null;
    } else if (c === '"' || c === "'") q = c;
    else if (c === '#') return v.slice(0, i).trim();
  }
  return v.trim();
}

export function readWindowsOverrides(codexHome = path.join(os.homedir(), '.codex')) {
  let text;
  try { text = fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8'); } catch { return []; }
  const out = [];
  let inWindows = false;
  for (const raw of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('[')) { inWindows = /^\[\s*windows\s*\](\s*#.*)?$/.test(line); continue; }
    if (!inWindows) continue;
    const m = /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/.exec(line);
    if (!m) continue;
    const value = stripTomlComment(m[2]);
    if (value) out.push(`windows.${m[1]}=${value}`);
  }
  return out;
}

export function buildArgs(cfg, o) {
  const args = ['exec'];
  if (cfg.model !== null && cfg.model !== undefined) args.push('-m', cfg.model);
  args.push('-c', `model_reasoning_effort=${cfg.reasoningEffort}`);
  if (cfg.ignoreUserConfig) args.push('--ignore-user-config');
  for (const ov of [...(o.overrides || []), ...(cfg.codexConfigOverrides || [])]) args.push('-c', ov);
  args.push('--color', 'never', '-s', cfg.codexSandbox, '--ephemeral', '--skip-git-repo-check',
    '-C', o.cwd, '--output-schema', o.schemaPath, '-o', o.outPath, '-');
  return args;
}

export function resolveCodex(cmd, env = process.env, platform = process.platform) {
  const win = platform === 'win32';
  const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
  let exts = [''];
  if (win) {
    const pe = (env.PATHEXT || env.Pathext || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map((e) => e.toLowerCase());
    exts = [...pe.filter((e) => e === '.exe'), ...pe.filter((e) => e !== '.exe')];
    // Goła nazwa (np. powłokowy shim npm bez rozszerzenia) nie jest uruchamialna;
    // używana tylko, gdy nazwa ma już rozszerzenie z PATHEXT.
    if (pe.some((e) => cmd.toLowerCase().endsWith(e))) exts = ['', ...exts];
  }
  if (/[\\/]/.test(cmd)) {
    for (const e of exts) if (isFile(cmd + e)) return path.resolve(cmd + e);
    return null;
  }
  const pathVar = env.PATH ?? env.Path ?? '';
  for (const dir of pathVar.split(win ? ';' : ':').filter(Boolean)) {
    for (const e of exts) {
      const p = path.join(dir.replace(/^"|"$/g, ''), cmd + e);
      if (isFile(p)) return path.resolve(p);
    }
  }
  return null;
}

export function killTree(pid, platform = process.platform) {
  try {
    if (platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    else process.kill(-pid, 'SIGKILL');
  } catch { /* ignored */ }
}

// Ręczny walidator dokładnie dla schema/findings.json.
function validateFindings(r) {
  const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);
  const exact = (o, keys) => Object.keys(o).length === keys.length && keys.every((k) => k in o);
  if (!isObj(r) || !exact(r, ['summary', 'findings'])) return 'niezgodne pola wyniku';
  if (typeof r.summary !== 'string') return 'summary nie jest tekstem';
  if (!Array.isArray(r.findings)) return 'findings nie jest tablicą';
  for (const f of r.findings) {
    if (!isObj(f) || !exact(f, ['id', 'severity', 'location', 'problem', 'suggestion'])) return 'niezgodne pola uwagi';
    if (!Number.isInteger(f.id)) return 'id nie jest liczbą całkowitą';
    if (!SEVERITIES.includes(f.severity)) return 'nieprawidłowe severity';
    if (typeof f.location !== 'string' || typeof f.problem !== 'string' || typeof f.suggestion !== 'string') return 'pole uwagi nie jest tekstem';
  }
  return null;
}

function trimFindings(r) {
  return {
    summary: r.summary.slice(0, 500),
    findings: r.findings.map((f) => ({
      ...f,
      location: f.location.slice(0, 200),
      problem: f.problem.slice(0, 500),
      suggestion: f.suggestion.slice(0, 500),
    })),
  };
}

const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

// Cytowanie jak w cross-spawn: MSVCRT, potem daszek przed każdym metaznakiem cmd.exe;
// dla .cmd/.bat (powtórne rozwinięcie %*) ucieczka podwójna.
function quoteCmdArg(a, double) {
  let s = String(a).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1');
  s = `"${s}"`.replace(CMD_META, '^$1');
  return double ? s.replace(CMD_META, '^$1') : s;
}
function escapeCmdCommand(c) {
  return path.normalize(c).replace(CMD_META, '^$1');
}

function readResult(outPath) {
  let raw;
  try { raw = fs.readFileSync(outPath, 'utf8'); } catch { return { ok: false, error: 'brak pliku wyniku' }; }
  let parsed;
  try { parsed = JSON.parse(raw.replace(/^﻿/, '')); } catch { return { ok: false, error: 'wynik nie jest poprawnym JSON' }; }
  const err = validateFindings(parsed);
  if (err) return { ok: false, error: `wynik niezgodny ze schematem: ${err}` };
  return { ok: true, result: trimFindings(parsed) };
}

export function runCodex(o) {
  return new Promise((resolve) => {
    const win = process.platform === 'win32';
    const oi = o.args.indexOf('-o');
    const outPath = oi >= 0 ? o.args[oi + 1] : null;
    let file = o.codexPath;
    let args = o.args;
    const opts = { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: !win };
    if (win && /\.(cmd|bat)$/i.test(file)) {
      args = ['/d', '/s', '/c', `"${[escapeCmdCommand(file), ...o.args.map((x) => quoteCmdArg(x, true))].join(' ')}"`];
      file = process.env.ComSpec || 'cmd.exe';
      opts.windowsVerbatimArguments = true;
    }
    let done = false;
    let timer = null;
    let stderr = '';
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(r);
    };
    let child;
    try { child = spawn(file, args, opts); } catch (e) { return finish({ ok: false, error: `nie można uruchomić Codexa: ${e.message}` }); }
    child.on('error', (e) => finish({ ok: false, error: `nie można uruchomić Codexa: ${e.message}` }));
    if (child.pid && o.onSpawn) { try { o.onSpawn(child.pid); } catch { /* ignored */ } }
    child.stdout.on('data', () => {});
    child.stderr.on('data', (d) => { if (stderr.length < 2000) stderr += d.toString('utf8'); });
    child.stdin.on('error', () => {});
    child.stdin.end(Buffer.from(o.prompt, 'utf8'));
    timer = setTimeout(() => {
      killTree(child.pid);
      finish({ ok: false, error: `timeout po ${o.timeoutMs} ms` });
    }, o.timeoutMs);
    child.on('close', (code) => {
      if (code !== 0) return finish({ ok: false, error: `Codex zakończył się kodem ${code}${stderr.trim() ? `: ${stderr.trim().slice(0, 300)}` : ''}` });
      if (!outPath) return finish({ ok: false, error: 'brak pliku wyniku' });
      finish(readResult(outPath));
    });
  });
}
