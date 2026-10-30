#!/usr/bin/env node
// Copyright (c) 2026 Dawid Góraj — external-review (https://github.com/dawidgoraj1-alt/claude-external-review). Licencja MIT.
// Instalator skilla external-review: preflight, kopiowanie do BASE/skills, wpisy hooków w settings.json.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { baseDir, canonical, toSlash } from './src/external-review/lib/paths.mjs';
import { localConfigPath, loadConfig } from './src/external-review/lib/config.mjs';
import { buildArgs, readWindowsOverrides, resolveCodex, runCodex } from './src/external-review/lib/codex.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(here, 'src', 'external-review');
// Skill /external-review-help leży obok głównego (src/external-review-help).
const helpSrc = (src) => path.join(path.dirname(src), 'external-review-help');
const REQUIRED_FLAGS = ['--output-schema', '--ephemeral', '--ignore-user-config', '--json'];
const TOOL_MATCHER = 'Write|Edit|MultiEdit|NotebookEdit';

// Ścieżki hooków muszą być bezwzględne, więc BASE jest rozwiązywany względem cwd.
const normEnv = (env) => ({ ...env, CLAUDE_CONFIG_DIR: path.resolve(baseDir(env)) });
const skillTarget = (env) => path.join(baseDir(env), 'skills', 'external-review');
const helpTarget = (env) => path.join(baseDir(env), 'skills', 'external-review-help');
const dataDir = (env) => path.join(baseDir(env), 'external-review');
const settingsPath = (env) => path.join(baseDir(env), 'settings.json');
const OWN_RE = /^node "[^"]*skills\/external-review\/hook\.mjs" --event (prompt|tool|stop)$/;
const OWN_RE_CI = new RegExp(OWN_RE.source, 'i');

function overlaps(a, b) {
  const ci = process.platform === 'win32' || process.platform === 'darwin';
  const n = (p) => { const x = toSlash(canonical(p)).replace(/\/+$/, ''); return ci ? x.toLowerCase() : x; };
  const x = n(a); const y = n(b);
  return x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`);
}

const SL_RE = /^node "[^"]*skills\/external-review\/statusline\.mjs"$/;
const SL_RE_CI = new RegExp(SL_RE.source, 'i');

function statuslineCommand(env) {
  return `node "${toSlash(path.join(skillTarget(env), 'statusline.mjs'))}"`;
}

function isOwnStatusline(sl) {
  if (!sl || typeof sl !== 'object' || typeof sl.command !== 'string') return false;
  return (process.platform === 'win32' || process.platform === 'darwin' ? SL_RE_CI : SL_RE).test(toSlash(sl.command));
}

// --statusline: ustawia statusLine tylko gdy go nie ma lub jest nasz; cudzego nie rusza.
function applyStatusline(settings, env, messages) {
  const cmd = statuslineCommand(env);
  if (settings.statusLine === undefined || settings.statusLine === null) {
    settings.statusLine = { type: 'command', command: cmd, refreshInterval: 1 };
    messages.push('Włączono podgląd pracy Codexa w linii statusu (statusLine w settings.json).');
  } else if (isOwnStatusline(settings.statusLine)) {
    settings.statusLine = { ...settings.statusLine, type: 'command', command: cmd, refreshInterval: 1 };
    messages.push('Odświeżono wpis statusLine (podgląd pracy Codexa).');
  } else {
    const snippet = JSON.stringify({ statusLine: { type: 'command', command: cmd, refreshInterval: 1 } });
    messages.push(
      'Masz już własną linię statusu (statusLine) — nie zmieniłem jej. Aby zobaczyć postęp Codexa, dołącz w niej wynik skryptu statusline.mjs',
      `(na wejście skryptu podaj JSON linii statusu) albo zaimportuj codexSegment z ${toSlash(path.join(skillTarget(env), 'statusline.mjs'))} (zob. README) i ustaw "refreshInterval": 1.`,
      `Gotowy wpis, gdybyś chciał zastąpić swój: ${snippet}`,
    );
  }
}

function hookCommand(env, event) {
  return `node "${toSlash(path.join(skillTarget(env), 'hook.mjs'))}" --event ${event}`;
}

function isOwn(command) {
  if (typeof command !== 'string') return false;
  const c = toSlash(command);
  return (process.platform === 'win32' || process.platform === 'darwin' ? OWN_RE_CI : OWN_RE).test(c);
}

// Uruchamia polecenie Codexa (na win32 .cmd/.bat przez cmd.exe).
function runSync(file, args, env) {
  const o = { encoding: 'utf8', env, windowsHide: true, timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] };
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(file)) {
    return spawnSync(env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${[`"${file}"`, ...args].join(' ')}"`], { ...o, windowsVerbatimArguments: true });
  }
  return spawnSync(file, args, o);
}

function readLocalConfig(env) {
  let raw;
  try { raw = fs.readFileSync(localConfigPath(env), 'utf8'); } catch (e) { if (e.code === 'ENOENT') return {}; throw e; }
  return JSON.parse(raw.replace(/^﻿/, ''));
}

// Zwraca listę błędów (pusta = OK). Asynchroniczna z powodu próbnego wywołania modelu.
export async function preflight(opts = {}, env = process.env) {
  env = normEnv(env);
  const errors = [];
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 20) errors.push(`Wymagany Node.js >= 20 (jest ${process.versions.node}).`);
  const git = spawnSync('git', ['--version'], { encoding: 'utf8', env, windowsHide: true });
  if (git.error || git.status !== 0) errors.push('Nie znaleziono polecenia git (git --version nie działa). Zainstaluj Git.');
  const codexPath = resolveCodex(opts.codexCmd || 'codex', env);
  if (!codexPath) {
    errors.push('Nie znaleziono Codex CLI w PATH. Zainstaluj Codex i sprawdź, czy polecenie "codex" działa.');
    return errors;
  }
  const help = runSync(codexPath, ['exec', '--help'], env);
  const helpText = `${help.stdout || ''}${help.stderr || ''}`;
  if (help.error || help.status !== 0) errors.push('Nie udało się uruchomić "codex exec --help".');
  else {
    const missing = REQUIRED_FLAGS.filter((f) => !helpText.includes(f));
    if (missing.length) errors.push(`Ta wersja Codexa nie obsługuje wymaganych flag: ${missing.join(', ')}. Zaktualizuj Codex.`);
  }
  const login = runSync(codexPath, ['login', 'status'], env);
  if (login.error || login.status !== 0) {
    errors.push('Codex nie jest zalogowany (codex login status zakończyło się błędem). Uruchom "codex login".');
    return errors;
  }
  if (!opts.skipPreflightCall && errors.length === 0) {
    let cfg;
    try {
      cfg = { ...loadConfig(env) };
    } catch (e) {
      errors.push(`Nie można wczytać konfiguracji: ${e.message}`);
      return errors;
    }
    if (opts.codexDefaultModel) cfg.model = null;
    else if (opts.model) cfg.model = opts.model;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'er-preflight-'));
    try {
      const outPath = path.join(tmp, 'out.json');
      const args = buildArgs(cfg, { cwd: tmp, schemaPath: path.join(opts.srcDir || SRC, 'schema', 'findings.json'), outPath, overrides: readWindowsOverrides() });
      const r = await runCodex({
        codexPath, args, timeoutMs: 120000,
        prompt: 'To jest próbne wywołanie. Zwróć pustą listę uwag (findings: []) i krótkie summary.',
      });
      if (!r.ok) {
        const m = cfg.model === null ? 'domyślny model Codexa' : `model "${cfg.model}"`;
        errors.push(`Próbne wywołanie Codexa (${m}) nie powiodło się: ${r.error}. Jeśli model jest niedostępny, użyj --model <nazwa> lub --codex-default-model.`);
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
  return errors;
}

// Wczytuje settings.json; brak pliku → null; niepoprawny JSON → wyjątek z polskim komunikatem.
function readSettings(env) {
  const p = settingsPath(env);
  let raw;
  try { raw = fs.readFileSync(p, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  try {
    const s = JSON.parse(raw.replace(/^﻿/, ''));
    if (!s || typeof s !== 'object' || Array.isArray(s)) throw new Error('korzeń nie jest obiektem');
    return s;
  } catch (e) {
    throw new Error(`Plik ${p} zawiera niepoprawny JSON (${e.message}). Napraw go ręcznie; instalator niczego nie zmienił.`);
  }
}

// settings.json bywa dowiązaniem (stow/dotfiles): zapis tmp + rename obok PRAWDZIWEGO pliku,
// żeby nie zastąpić dowiązania zwykłym plikiem.
function writeSettings(env, settings, existed) {
  const p = settingsPath(env);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  if (existed) fs.copyFileSync(p, `${p}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  let real = p;
  try { real = fs.realpathSync(p); } catch { /* brak pliku — zapis pod p */ }
  const tmp = `${real}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  try {
    fs.renameSync(tmp, real);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    throw e;
  }
}

// Usuwa własne wpisy ze wszystkich zdarzeń (i puste tablice); zwraca true, gdy coś zmieniono.
function stripOwn(settings) {
  let changed = false;
  if (!settings.hooks || typeof settings.hooks !== 'object') return false;
  for (const ev of Object.keys(settings.hooks)) {
    const groups = settings.hooks[ev];
    if (!Array.isArray(groups)) continue;
    const kept = [];
    for (const g of groups) {
      if (!g || !Array.isArray(g.hooks)) { kept.push(g); continue; }
      const hooks = g.hooks.filter((h) => !(h && isOwn(h.command)));
      if (hooks.length !== g.hooks.length) changed = true;
      if (hooks.length) kept.push({ ...g, hooks });
    }
    if (kept.length) settings.hooks[ev] = kept;
    else if (groups.length) { delete settings.hooks[ev]; changed = true; }
  }
  if (changed && !Object.keys(settings.hooks).length) delete settings.hooks;
  return changed;
}

function addOwn(settings, env, hookTimeoutSec) {
  settings.hooks = settings.hooks && typeof settings.hooks === 'object' ? settings.hooks : {};
  const add = (ev, group) => { settings.hooks[ev] = [...(Array.isArray(settings.hooks[ev]) ? settings.hooks[ev] : []), group]; };
  add('UserPromptSubmit', { hooks: [{ type: 'command', command: hookCommand(env, 'prompt'), timeout: 30 }] });
  add('PostToolUse', { matcher: TOOL_MATCHER, hooks: [{ type: 'command', command: hookCommand(env, 'tool'), timeout: 30 }] });
  add('Stop', { hooks: [{ type: 'command', command: hookCommand(env, 'stop'), timeout: hookTimeoutSec, statusMessage: 'Codex recenzuje…' }] });
}

// Własna kopia rekurencyjna (fs.cpSync na Node 22/Windows gubi pliki przy ścieżkach spoza ASCII). Pomija dowiązania.
export function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const ent of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, ent.name);
    const b = path.join(to, ent.name);
    if (ent.isSymbolicLink()) continue;
    if (ent.isDirectory()) copyDir(a, b);
    else if (ent.isFile()) fs.copyFileSync(a, b);
  }
}

const SIDE_RE = /^external-review(-help)?\.(new|old)-/;

// Usuwa pozostałości przerwanych instalacji (inaczej Claude Code wczytałby je jako kolejne skille).
function removeLeftovers(skillsDir) {
  let names = [];
  try { names = fs.readdirSync(skillsDir); } catch { return; }
  for (const n of names) {
    if (SIDE_RE.test(n)) fs.rmSync(path.join(skillsDir, n), { recursive: true, force: true });
  }
}

// Kopia do katalogu obok celu, weryfikacja, potem zamiana (stary na bok → nowy na miejsce →
// usunięcie starego). Przy błędzie poprzednia instalacja zostaje nienaruszona.
function replaceSkillDir(src, target, required = ['SKILL.md', 'hook.mjs']) {
  const stamp = `${Date.now()}-${process.pid}`;
  const fresh = `${target}.new-${stamp}`;
  const old = `${target}.old-${stamp}`;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  try {
    copyDir(src, fresh);
    for (const f of required) {
      if (!fs.existsSync(path.join(fresh, f))) {
        throw new Error(`po kopiowaniu brakuje pliku ${f}; sprawdź katalog źródłowy (${src}) i uprawnienia do katalogu docelowego`);
      }
    }
    const skillMd = path.join(fresh, 'SKILL.md');
    fs.writeFileSync(skillMd, fs.readFileSync(skillMd, 'utf8').replaceAll('{{HOOK_PATH}}', toSlash(path.join(target, 'hook.mjs'))), 'utf8');
  } catch (e) {
    fs.rmSync(fresh, { recursive: true, force: true });
    throw new Error(`Kopiowanie skilla nie powiodło się (${e.message}). Poprzednia instalacja pozostała bez zmian.`);
  }
  const hadOld = fs.existsSync(target);
  try {
    if (hadOld) fs.renameSync(target, old);
  } catch (e) {
    fs.rmSync(fresh, { recursive: true, force: true });
    throw new Error(`Nie można podmienić ${target} (${e.message}). Zamknij programy, które go używają, i spróbuj ponownie; poprzednia instalacja pozostała bez zmian.`);
  }
  try {
    fs.renameSync(fresh, target);
  } catch (e) {
    if (hadOld) { try { fs.renameSync(old, target); } catch { /* zostaje na boku */ } }
    fs.rmSync(fresh, { recursive: true, force: true });
    throw new Error(`Nie można przenieść nowej wersji do ${target} (${e.message}); przywrócono poprzednią instalację.`);
  }
  if (hadOld) fs.rmSync(old, { recursive: true, force: true });
}

export async function install(opts = {}, env = process.env) {
  env = normEnv(env);
  const messages = [];
  const src = opts.srcDir || SRC;
  try {
    const hitTarget = [skillTarget(env), helpTarget(env)].find((t) => overlaps(src, t));
    if (hitTarget) {
      return { ok: false, errors: [`Katalog źródłowy (${src}) pokrywa się z katalogiem docelowym (${hitTarget}) lub zawiera go albo jest w nim zawarty. Sklonuj repozytorium poza ${path.join(baseDir(env), 'skills')}. Niczego nie zmieniono.`], messages };
    }
    // Oba źródła sprawdzane przed jakąkolwiek zmianą — błąd nie zostawi nowej pomocy obok starego głównego skilla.
    const missing = [path.join(helpSrc(src), 'SKILL.md'), path.join(src, 'SKILL.md'), path.join(src, 'hook.mjs'), path.join(src, 'statusline.mjs')]
      .filter((f) => { try { return !fs.lstatSync(f).isFile(); } catch { return true; } }); // copyDir pomija dowiązania
    if (missing.length) {
      return { ok: false, errors: [`Brak pliku źródłowego: ${missing.join(', ')} (external-review / external-review-help); repozytorium jest niekompletne. Niczego nie zmieniono.`], messages };
    }
    const errors = await preflight(opts, env);
    if (errors.length) return { ok: false, errors, messages };
    const codexPath = resolveCodex(opts.codexCmd || 'codex', env);
    // Walidacja plików użytkownika przed jakąkolwiek zmianą.
    const settings = readSettings(env);
    const local = readLocalConfig(env);

    const target = skillTarget(env);
    removeLeftovers(path.dirname(target));
    // Najpierw pomoc: jej nieudana podmiana wycofuje się sama, a główny skill i settings zostają nietknięte.
    replaceSkillDir(helpSrc(src), helpTarget(env), ['SKILL.md']);
    replaceSkillDir(src, target);

    const next = { ...local, codexPath };
    if (opts.codexDefaultModel) next.model = null;
    else if (opts.model) next.model = opts.model;
    fs.mkdirSync(dataDir(env), { recursive: true });
    fs.writeFileSync(localConfigPath(env), `${JSON.stringify(next, null, 2)}\n`, 'utf8');

    const s = settings || {};
    stripOwn(s);
    addOwn(s, env, loadConfig(env).hookTimeoutSec);
    if (opts.statusline) applyStatusline(s, env, messages);
    writeSettings(env, s, settings !== null);
    messages.push(`Zainstalowano w ${target} (pomoc: /external-review-help).`, `Codex: ${codexPath}`, 'Zrestartuj Claude Code, aby hooki zaczęły działać.');
    return { ok: true, errors: [], messages };
  } catch (e) {
    return { ok: false, errors: [e.message], messages };
  }
}

export async function uninstall(opts = {}, env = process.env) {
  env = normEnv(env);
  const messages = [];
  try {
    const src = opts.srcDir || SRC;
    const targets = opts.purge ? [skillTarget(env), helpTarget(env), dataDir(env)] : [skillTarget(env), helpTarget(env)];
    const hit = targets.find((t) => overlaps(src, t));
    if (hit) return { ok: false, errors: [`Katalog źródłowy instalatora (${src}) pokrywa się z ${hit} lub jest z nim zagnieżdżony; usunięcie skasowałoby repozytorium. Uruchom deinstalację z kopii repozytorium poza BASE. Niczego nie zmieniono.`], messages };
    const settings = readSettings(env);
    if (settings) {
      const hooksChanged = stripOwn(settings);
      // Usuwany tylko wpis tej instalacji (dokładnie ta ścieżka); wpis innego BASE zostaje.
      const ci = process.platform === 'win32' || process.platform === 'darwin';
      const norm = (c) => (ci ? toSlash(c).toLowerCase() : toSlash(c));
      const slOwn = isOwnStatusline(settings.statusLine) && norm(settings.statusLine.command) === norm(statuslineCommand(env));
      if (slOwn) delete settings.statusLine;
      if (hooksChanged || slOwn) {
        writeSettings(env, settings, true);
        if (hooksChanged) messages.push('Usunięto wpisy hooków z settings.json.');
        if (slOwn) messages.push('Usunięto wpis statusLine (podgląd pracy Codexa).');
      }
    }
    fs.rmSync(skillTarget(env), { recursive: true, force: true });
    fs.rmSync(helpTarget(env), { recursive: true, force: true });
    removeLeftovers(path.dirname(skillTarget(env)));
    messages.push(`Usunięto ${skillTarget(env)} i ${helpTarget(env)}.`);
    if (opts.purge) {
      fs.rmSync(dataDir(env), { recursive: true, force: true });
      messages.push(`Usunięto ${dataDir(env)}.`);
    }
    return { ok: true, errors: [], messages };
  } catch (e) {
    return { ok: false, errors: [e.message], messages };
  }
}

export function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--model') { o.model = argv[++i]; if (!o.model) throw new Error('--model wymaga nazwy modelu.'); }
    else if (a === '--codex-default-model') o.codexDefaultModel = true;
    else if (a === '--uninstall') o.uninstall = true;
    else if (a === '--statusline') o.statusline = true;
    else if (a === '--purge') o.purge = true;
    else if (a === '--skip-preflight-call') o.skipPreflightCall = true;
    else throw new Error(`Nieznany argument: ${a}`);
  }
  if (o.model && o.codexDefaultModel) throw new Error('--model i --codex-default-model wykluczają się.');
  if (o.purge && !o.uninstall) throw new Error('--purge działa tylko z --uninstall.');
  return o;
}

async function main() {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(1); }
  const r = opts.uninstall ? await uninstall(opts, process.env) : await install(opts, process.env);
  for (const m of r.messages) console.log(m);
  for (const e of r.errors) console.error(`BŁĄD: ${e}`);
  process.exit(r.ok ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
