import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { classify, onPrompt, onTool, collectCandidates, fileHash } from '../src/external-review/lib/candidates.mjs';
import { makeContext } from '../src/external-review/lib/context.mjs';
import { readState } from '../src/external-review/lib/state.mjs';
import { loadConfig } from '../src/external-review/lib/config.mjs';
import { canonical, toSlash } from '../src/external-review/lib/paths.mjs';
import { pathAlias } from '../test-support/helpers.mjs';

const TMP = canonical(os.tmpdir());
// The home dir may be a git repo: keep git discovery below the temp dir.
process.env.GIT_CEILING_DIRECTORIES = TMP;

const d = loadConfig({ CLAUDE_CONFIG_DIR: path.join(TMP, 'er-none') });
const defaults = d;

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}
function tmp(prefix) { return canonical(fs.mkdtempSync(path.join(TMP, prefix))); }
function tmpRepo() {
  const dir = tmp('er-cand-');
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 't@example.com');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'core.autocrlf', 'false');
  return dir;
}
function write(dir, rel, content = 'x\n') {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}
function commitAll(dir, msg = 'c') {
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', msg);
}
function env() { return { ...process.env, CLAUDE_CONFIG_DIR: tmp('er-cfg-') }; }
const ctxFor = (cwd, e) => makeContext(cwd, e);
const S = 's1';

test('default config: spec under docs/superpowers/specs is spec, not ignored', () => assert.equal(classify('docs/superpowers/specs/x-design.md', defaults, true), 'spec'));
test('plain markdown is ignored', () => assert.equal(classify('docs/notes.md', defaults, true), null));
test('non-superpowers names', () => {
  assert.equal(classify('SPEC.md', d, true), 'spec');
  assert.equal(classify('feature-plan.md', d, true), 'plan');
});
test('code file', () => assert.equal(classify('src/a.js', d, true), 'code'));
test('file in ignoreDirs is null', () => {
  assert.equal(classify('node_modules/x/a.js', d, true), null);
  assert.equal(classify('a/Node_Modules/specs/x.md', d, true), null);
});
test('case sensitivity follows nocase flag', () => {
  assert.equal(classify('SPEC.md', d, false), null);
  assert.equal(classify('Plans/x.md', d, true), 'plan');
});

test('makeContext: home-dir repo above cwd is treated as non-git', () => {
  const home = tmpRepo();
  const sub = path.join(home, 'proj');
  fs.mkdirSync(sub);
  const e = env();
  const c = makeContext(sub, e, { homedir: home });
  assert.equal(c.isGit, false);
  assert.equal(c.root, sub);
  const swapped = home.toUpperCase() === home ? home.toLowerCase() : home.toUpperCase();
  const c2 = makeContext(sub, e, { homedir: swapped });
  assert.equal(c2.isGit, process.platform === 'linux');
  const atHome = makeContext(home, e, { homedir: home });
  assert.equal(atHome.isGit, true);
  const normal = makeContext(sub, e, { homedir: path.join(home, 'elsewhere') });
  assert.equal(normal.isGit, true);
  assert.equal(normal.root.toLowerCase(), home.replace(/\\/g, '/').toLowerCase());
});

test('makeContext: non-git dir', () => {
  const dir = tmp('er-nogit-');
  const c = ctxFor(dir, env());
  assert.equal(c.isGit, false);
  assert.equal(c.root, dir);
});

test('first prompt records baseline without review', async () => {
  const repo = tmpRepo();
  write(repo, 'a.js', 'one\n');
  commitAll(repo);
  write(repo, 'a.js', 'dirty\n');
  write(repo, 'b.js', 'new\n');
  const e = env();
  const ctx = ctxFor(repo, e);
  await onPrompt({ session_id: S }, ctx);
  const s = readState(ctx.stateDir);
  assert.equal(s.files['a.js'].reviewedHash, fileHash(repo, 'a.js'));
  assert.equal(s.files['b.js'].reviewedHash, fileHash(repo, 'b.js'));
  assert.deepEqual(s.outstanding, []);
  assert.deepEqual(collectCandidates(ctx, s, S), []);
  assert.ok(s.sessions[S].startedAt > 0);
});

test('baseline skips ignoreDirs and caps at 2000 files', async () => {
  const repo = tmpRepo();
  write(repo, 'seed.txt', 's');
  commitAll(repo);
  for (let i = 0; i < 3000; i++) write(repo, `node_modules/p/f${i}.js`, `${i}\n`);
  for (let i = 0; i < 5; i++) write(repo, `src/f${i}.js`, `${i}\n`);
  const ctx = ctxFor(repo, env());
  const t0 = Date.now();
  await onPrompt({ session_id: S }, ctx);
  assert.ok(Date.now() - t0 < 30000);
  const s = readState(ctx.stateDir);
  assert.equal(Object.keys(s.files).length, 5);
  assert.ok(!Object.keys(s.files).some((k) => k.startsWith('node_modules')));
});

test('baseline is not redone on later prompts', async () => {
  const repo = tmpRepo();
  write(repo, 'a.js', '1\n');
  commitAll(repo);
  const ctx = ctxFor(repo, env());
  await onPrompt({ session_id: S }, ctx);
  write(repo, 'a.js', '2\n');
  await onPrompt({ session_id: S }, ctx);
  const s = readState(ctx.stateDir);
  assert.equal(s.files['a.js'], undefined);
  assert.deepEqual(s.outstanding, ['a.js']);
});

test('tool event records relative path, also from subagent input', async () => {
  const repo = tmpRepo();
  const ctx = ctxFor(repo, env());
  await onPrompt({ session_id: S }, ctx);
  await onTool({ session_id: S, tool_name: 'Write', tool_input: { file_path: path.join(repo, 'pkg', 'a.js') } }, ctx);
  await onTool({ session_id: S, tool_name: 'NotebookEdit', tool_input: { notebook_path: 'nb.ipynb' } }, ctx);
  await onTool({ session_id: S, tool_name: 'Edit', tool_input: { file_path: path.join(repo, 'pkg', 'a.js') } }, ctx);
  await onTool({ session_id: S, tool_name: 'Edit', tool_input: { file_path: path.join(os.tmpdir(), 'elsewhere-outside.js') } }, ctx);
  const s = readState(ctx.stateDir);
  assert.deepEqual(s.sessions[S].touched, ['pkg/a.js', 'nb.ipynb']);
  assert.deepEqual(collectCandidates(ctx, s, S), ['nb.ipynb', 'pkg/a.js']);
});

test('edit via shell (no tool event) detected through git status vs snapshot', async () => {
  const repo = tmpRepo();
  write(repo, 'a.js', '1\n');
  write(repo, 'pre.js', 'p\n');
  commitAll(repo);
  write(repo, 'pre.js', 'dirty before\n');
  const ctx = ctxFor(repo, env());
  await onPrompt({ session_id: S }, ctx);
  write(repo, 'a.js', '2\n');
  write(repo, 'new.js', 'n\n');
  const s = readState(ctx.stateDir);
  assert.deepEqual(collectCandidates(ctx, s, S), ['a.js', 'new.js']);
  write(repo, 'pre.js', 'dirty after\n');
  assert.deepEqual(collectCandidates(ctx, s, S), ['a.js', 'new.js', 'pre.js']);
});

test('commit during turn is a candidate', async () => {
  const repo = tmpRepo();
  write(repo, 'a.js', '1\n');
  commitAll(repo);
  const ctx = ctxFor(repo, env());
  await onPrompt({ session_id: S }, ctx);
  write(repo, 'a.js', '2\n');
  commitAll(repo, 'turn');
  assert.deepEqual(collectCandidates(ctx, readState(ctx.stateDir), S), ['a.js']);
});

test('spec written by subagent outside git detected by mtime', async () => {
  const dir = tmp('er-nogit-');
  write(dir, 'docs/specs/old-design.md', 'old');
  const past = new Date(Date.now() - 3600_000);
  fs.utimesSync(path.join(dir, 'docs/specs/old-design.md'), past, past);
  const ctx = ctxFor(dir, env());
  await onPrompt({ session_id: S }, ctx);
  write(dir, 'docs/specs/new-design.md', 'new');
  write(dir, 'notes.md', 'ignored');
  write(dir, 'node_modules/x/specs/y.md', 'ignored');
  assert.deepEqual(collectCandidates(ctx, readState(ctx.stateDir), S), ['docs/specs/new-design.md']);
});

test('turn ended without Stop moves candidates to outstanding on next prompt', async () => {
  const repo = tmpRepo();
  write(repo, 'a.js', '1\n');
  commitAll(repo);
  const ctx = ctxFor(repo, env());
  await onPrompt({ session_id: S }, ctx);
  await onTool({ session_id: S, tool_name: 'Edit', tool_input: { file_path: path.join(repo, 'a.js') } }, ctx);
  write(repo, 'a.js', '2\n');
  write(repo, 'readme.md', 'ignored class\n');
  await onPrompt({ session_id: S }, ctx);
  const s = readState(ctx.stateDir);
  assert.deepEqual(s.outstanding, ['a.js']);
  assert.deepEqual(s.sessions[S].touched, []);
});

test('cwd in repo subdirectory uses repo root paths', async () => {
  const repo = tmpRepo();
  write(repo, 'pkg/a.js', '1\n');
  commitAll(repo);
  const e = env();
  const rootCtx = ctxFor(repo, e);
  const ctx = ctxFor(path.join(repo, 'pkg'), e);
  assert.equal(ctx.root.toLowerCase(), repo.replace(/\\/g, '/').toLowerCase());
  assert.equal(ctx.stateDir, rootCtx.stateDir);
  await onPrompt({ session_id: S }, ctx);
  write(repo, 'pkg/a.js', '2\n');
  await onTool({ session_id: S, tool_name: 'Edit', tool_input: { file_path: path.join(repo, 'pkg', 'a.js') } }, ctx);
  await onTool({ session_id: S, tool_name: 'Edit', tool_input: { file_path: 'a.js' } }, ctx);
  assert.deepEqual(collectCandidates(ctx, readState(ctx.stateDir), S), ['pkg/a.js']);
});

// Alias = another spelling of the same directory: 8.3 short name on win32
// (e.g. TEMP = C:\Users\RUNNER~1\...), a symlink elsewhere (macOS /var).
function aliasRepo() {
  const repo = canonical(fs.mkdtempSync(path.join(TMP, 'er-long folder name-')));
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.email', 't@example.com');
  git(repo, 'config', 'user.name', 'Test');
  return { repo, alias: pathAlias(repo) };
}
const aliasSkip = !pathAlias(tmp('er-long folder name-')) && 'no 8.3 names or symlinks here';
const sameRoot = (a, b) => assert.equal(toSlash(a).toLowerCase(), toSlash(b).toLowerCase());

test('makeContext: alias cwd resolves to the canonical git root and the same state', { skip: aliasSkip }, () => {
  const { repo, alias } = aliasRepo();
  fs.mkdirSync(path.join(repo, 'pkg'));
  const e = env();
  const viaAlias = makeContext(path.join(alias, 'pkg'), e);
  const direct = makeContext(repo, e);
  assert.equal(viaAlias.isGit, true);
  sameRoot(viaAlias.root, repo);
  assert.equal(viaAlias.stateDir, direct.stateDir);
});

test('makeContext: alias non-git cwd is canonicalized', { skip: aliasSkip }, () => {
  const dir = canonical(fs.mkdtempSync(path.join(TMP, 'er-long folder name-')));
  const c = makeContext(pathAlias(dir), env());
  assert.equal(c.isGit, false);
  sameRoot(c.root, dir);
});

test('makeContext: home-dir check matches alias spellings of home and cwd', { skip: aliasSkip }, () => {
  const { repo: home, alias } = aliasRepo();
  const sub = path.join(home, 'proj');
  fs.mkdirSync(sub);
  const e = env();
  assert.equal(makeContext(sub, e, { homedir: alias }).isGit, false);
  assert.equal(makeContext(path.join(alias, 'proj'), e, { homedir: home }).isGit, false);
  assert.equal(makeContext(alias, e, { homedir: home }).isGit, true);
});

test('tool event: alias file_path / cwd give root-relative paths', { skip: aliasSkip }, async () => {
  const { repo, alias } = aliasRepo();
  const e = env();
  const ctx = makeContext(repo, e);
  await onPrompt({ session_id: S }, ctx);
  await onTool({ session_id: S, tool_name: 'Write', tool_input: { file_path: path.join(alias, 'pkg', 'new.js') } }, ctx);
  write(repo, 'b.js');
  await onTool({ session_id: S, tool_name: 'Edit', tool_input: { file_path: path.join(alias, 'b.js') } }, ctx);
  const aliasCtx = makeContext(alias, e);
  await onTool({ session_id: S, tool_name: 'Edit', tool_input: { file_path: path.join(repo, 'c.js') } }, aliasCtx);
  await onTool({ session_id: S, tool_name: 'Edit', tool_input: { file_path: 'd.js' } }, aliasCtx);
  assert.deepEqual(readState(ctx.stateDir).sessions[S].touched, ['pkg/new.js', 'b.js', 'c.js', 'd.js']);
});

test('fileHash: null for missing, normalizes CRLF', () => {
  const dir = tmp('er-nogit-');
  assert.equal(fileHash(dir, 'nope'), null);
  write(dir, 'a', 'x\r\ny\r\n');
  write(dir, 'b', 'x\ny\n');
  assert.equal(fileHash(dir, 'a'), fileHash(dir, 'b'));
});

test('onPrompt does not hold state.lock during the expensive phase', async () => {
  const dir = tmp('er-nogit-');
  for (let i = 0; i < 50; i++) write(dir, `d${i}/f.js`, `${i}\n`);
  const ctx = ctxFor(dir, env());
  await onPrompt({ session_id: S }, ctx);
  const lock = path.join(ctx.stateDir, 'state.lock');
  const orig = fs.readdirSync;
  let walks = 0;
  let heldDuringWalk = 0;
  fs.readdirSync = (...a) => {
    if (String(a[0]).startsWith(dir)) { // project walk only (not GC of blobs)
      walks++;
      if (fs.existsSync(lock)) heldDuringWalk++;
    }
    return orig(...a);
  };
  try {
    await onPrompt({ session_id: S }, makeContext(dir, { ...process.env, CLAUDE_CONFIG_DIR: path.dirname(path.dirname(path.dirname(ctx.stateDir))) }));
  } finally {
    fs.readdirSync = orig;
  }
  assert.ok(walks > 0);
  assert.equal(heldDuringWalk, 0);
});

test('touched entry added between the unlocked read and the merge is not lost', async () => {
  const repo = tmpRepo();
  write(repo, 'a.js', '1\n');
  commitAll(repo);
  const ctx = ctxFor(repo, env());
  await onPrompt({ session_id: S }, ctx);
  await onTool({ session_id: S, tool_name: 'Edit', tool_input: { file_path: 'a.js' } }, ctx);
  write(repo, 'a.js', '2\n');
  await onPrompt({ session_id: S }, ctx);
  assert.deepEqual(readState(ctx.stateDir).outstanding, ['a.js']);
});

test('git project: no full-project walk — gitignored spec is not a candidate, untracked spec still is', async () => {
  const repo = tmpRepo();
  write(repo, '.gitignore', 'vendor/\n');
  write(repo, 'a.js', '1\n');
  commitAll(repo);
  const ctx = ctxFor(repo, env());
  await onPrompt({ session_id: S }, ctx);
  write(repo, 'docs/specs/new-design.md', 'new');
  write(repo, 'vendor/docs/specs/vendored.md', 'ignored by git');
  const orig = fs.readdirSync;
  let walks = 0;
  fs.readdirSync = (...a) => {
    if (String(a[0]).startsWith(repo)) walks++;
    return orig(...a);
  };
  let got;
  try { got = collectCandidates(ctx, readState(ctx.stateDir), S); } finally { fs.readdirSync = orig; }
  assert.deepEqual(got, ['docs/specs/new-design.md']);
  assert.equal(walks, 0, 'brak przeglądania katalogów projektu w repozytorium git');
});
