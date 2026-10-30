import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, localConfigPath } from '../src/external-review/lib/config.mjs';

function tmpBase() { return fs.mkdtempSync(path.join(os.tmpdir(), 'er-cfg-')); }

test('local config overrides defaults, arrays replaced', () => {
  const base = tmpBase();
  const env = { CLAUDE_CONFIG_DIR: base };
  fs.mkdirSync(path.dirname(localConfigPath(env)), { recursive: true });
  fs.writeFileSync(localConfigPath(env), JSON.stringify({ model: null, specPatterns: ['x'] }));
  const c = loadConfig(env);
  assert.equal(c.model, null);
  assert.deepEqual(c.specPatterns, ['x']);
  assert.equal(c.maxChunks, 3);
});
test('missing local config returns defaults', () => {
  const c = loadConfig({ CLAUDE_CONFIG_DIR: tmpBase() });
  assert.equal(c.model, 'gpt-6-sol');
  assert.equal(c.hookTimeoutSec, 900);
});
test('localConfigPath is under BASE/external-review', () => {
  assert.equal(localConfigPath({ CLAUDE_CONFIG_DIR: '/x/c' }).replace(/\\/g, '/'), '/x/c/external-review/config.local.json');
});
