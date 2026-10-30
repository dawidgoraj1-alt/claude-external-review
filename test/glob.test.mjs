import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { globToRegExp, matchAny, walk } from '../src/external-review/lib/glob.mjs';

const o = { nocase: true };
test('specs dir with dot parent', () => assert.ok(matchAny('.claude/specs/x.md', ['**/specs/**/*.md'], o)));
test('case-insensitive', () => assert.ok(matchAny('Docs/Specs/X.MD', ['**/specs/**/*.md'], o)));
test('root-level file matches **/', () => assert.ok(matchAny('SPEC.md', ['**/spec.md'], o)));
test('case-sensitive when nocase false', () => assert.ok(!matchAny('SPEC.md', ['**/spec.md'], { nocase: false })));
test('* does not cross /', () => assert.ok(!matchAny('a/b-plan.md', ['*-plan.md'], o)));
test('explanation.md is not a plan', () =>
  assert.ok(!matchAny('docs/explanation.md', ['**/plans/**/*.md', '**/*-plan.md', '**/plan.md'], o)));
test('trailing ** matches everything below', () => assert.ok(matchAny('docs/a/b.txt', ['docs/**'], o)));
test('? matches one non-slash char', () => {
  assert.ok(matchAny('a1.md', ['a?.md'], o));
  assert.ok(!matchAny('a/.md', ['a?.md'], o));
  assert.ok(!matchAny('a12.md', ['a?.md'], o));
});
test('regex metacharacters are escaped', () => {
  assert.ok(!matchAny('axmd', ['a.md'], o));
  assert.ok(matchAny('a+(b).md', ['a+(b).md'], o));
});
test('matches whole path only', () => assert.ok(!matchAny('x/spec.md.bak', ['**/spec.md'], o)));
test('globToRegExp returns RegExp', () => assert.ok(globToRegExp('*.md', o) instanceof RegExp));

function mk(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glob-'));
  for (const f of files) {
    const p = path.join(root, f);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, 'x');
  }
  return root;
}

test('walk skips ignoreDirs and returns slash paths', () => {
  const root = mk(['a/x.js', 'node_modules/y.js', 'Mój katalog/z.md', 'sub/Node_Modules/q.js']);
  try {
    const r = walk(root, { ignoreDirs: ['node_modules'], nocase: true });
    assert.deepEqual(r.map(e => e.rel).sort(), ['Mój katalog/z.md', 'a/x.js']);
    assert.equal(typeof r[0].mtimeMs, 'number');
    assert.equal(r[0].size, 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('walk respects maxFiles', () => {
  const root = mk(['a.txt', 'b.txt', 'c/d.txt', 'e.txt']);
  try {
    assert.equal(walk(root, { ignoreDirs: [], nocase: true, maxFiles: 2 }).length, 2);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('walk does not follow symlinks', (t) => {
  const root = mk(['real/f.txt']);
  try {
    try { fs.symlinkSync(path.join(root, 'real'), path.join(root, 'link'), 'junction'); }
    catch { t.skip('symlinks unavailable'); return; }
    const r = walk(root, { ignoreDirs: [], nocase: true });
    assert.deepEqual(r.map(e => e.rel), ['real/f.txt']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
