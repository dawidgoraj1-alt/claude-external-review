import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeText, sha256, isBinary } from '../src/external-review/lib/text.mjs';

test('normalizeText strips BOM and CRLF', () => assert.equal(normalizeText(Buffer.from('\uFEFFa\r\nb')), 'a\nb'));
test('normalizeText accepts strings', () => assert.equal(normalizeText('\uFEFFa\r\nb'), 'a\nb'));
test('sha256 equal for CRLF and LF variants', () => {
  assert.equal(sha256(normalizeText('a\r\nb')), sha256(normalizeText('a\nb')));
  assert.match(sha256('x'), /^[0-9a-f]{64}$/);
});
test('isBinary detects NUL', () => {
  assert.equal(isBinary(Buffer.from('ab\0c')), true);
  assert.equal(isBinary(Buffer.from('abc')), false);
  assert.equal(isBinary(Buffer.concat([Buffer.alloc(8000, 97), Buffer.from([0])])), false);
});
