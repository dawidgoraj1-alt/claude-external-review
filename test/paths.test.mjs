import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { baseDir, toSlash, nocase, projectKey, stateDirFor, relTo, skillDir, canonical } from '../src/external-review/lib/paths.mjs';
import { pathAlias } from '../test-support/helpers.mjs';

test('baseDir uses CLAUDE_CONFIG_DIR', () => assert.equal(baseDir({ CLAUDE_CONFIG_DIR: '/x/c' }), '/x/c'));
test('baseDir falls back to ~/.claude', () => assert.equal(toSlash(baseDir({})), toSlash(path.join(os.homedir(), '.claude'))));
test('toSlash converts backslashes', () => assert.equal(toSlash('a\\b\\c'), 'a/b/c'));
test('nocase true on win32 and darwin only', () => {
  assert.equal(nocase('win32'), true);
  assert.equal(nocase('darwin'), true);
  assert.equal(nocase('linux'), false);
});
test('projectKey lowercases on win32 and darwin only', () => {
  assert.equal(projectKey('C:\\Vibe\\Skill', 'win32'), 'c:/vibe/skill');
  assert.equal(projectKey('/Users/A/Proj', 'darwin'), '/users/a/proj');
  assert.equal(projectKey('/home/A/Proj', 'linux'), '/home/A/Proj');
});
test('stateDirFor is BASE/external-review/state/<sha1>', () => {
  const env = { CLAUDE_CONFIG_DIR: '/x/c' };
  const d = toSlash(stateDirFor('/home/a/p', env));
  assert.match(d, /^\/x\/c\/external-review\/state\/[0-9a-f]{40}$/);
  assert.equal(d, toSlash(stateDirFor('/home/a/p', env)));
  assert.notEqual(d, toSlash(stateDirFor('/home/a/q', env)));
});
test('relTo returns slash path relative to root', () => assert.equal(relTo('/r', '/r/a b/ó.md'), 'a b/ó.md'));
test('skillDir is the directory above lib/', () => {
  assert.equal(path.basename(skillDir()), 'external-review');
});

test('canonical: resolver result is used, missing tail re-appended to nearest existing parent', () => {
  const short = path.resolve('/S/LONGFO~1');
  const long = path.resolve('/S/Long Folder');
  const real = (p) => {
    if (p === short) return long;
    throw Object.assign(new Error(`ENOENT ${p}`), { code: 'ENOENT' });
  };
  assert.equal(canonical(short, real), long);
  assert.equal(canonical(path.join(short, 'new dir', 'a.js'), real), path.join(long, 'new dir', 'a.js'));
  assert.equal(canonical(path.resolve('/nowhere/x'), real), path.resolve('/nowhere/x'));
});

const aliasBase = fs.mkdtempSync(path.join(os.tmpdir(), 'er-long folder name-'));
const alias = pathAlias(aliasBase);
test('canonical: alias spelling (8.3 / symlink) resolves to the canonical path', { skip: !alias && 'no 8.3 names or symlinks here' }, () => {
  assert.notEqual(alias, aliasBase);
  assert.equal(canonical(alias), canonical(aliasBase));
  assert.equal(canonical(path.join(alias, 'missing', 'f.js')), path.join(canonical(aliasBase), 'missing', 'f.js'));
});
