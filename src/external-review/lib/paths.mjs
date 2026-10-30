// Copyright (c) 2026 Dawid Góraj — external-review (https://github.com/dawidgoraj1-alt/claude-external-review). Licencja MIT.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export function baseDir(env = process.env) {
  return env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

export function toSlash(p) {
  return String(p).replace(/\\/g, '/');
}

export function nocase(platform = process.platform) {
  return platform === 'win32' || platform === 'darwin';
}

export function projectKey(root, platform = process.platform) {
  let k = toSlash(root);
  if (k.length > 1 && k.endsWith('/') && !/^[A-Za-z]:\/$/.test(k)) k = k.replace(/\/+$/, '');
  return nocase(platform) ? k.toLowerCase() : k;
}

export function stateDirFor(root, env = process.env) {
  const h = crypto.createHash('sha1').update(projectKey(root), 'utf8').digest('hex');
  return path.join(baseDir(env), 'external-review', 'state', h);
}

export function relTo(root, abs) {
  return toSlash(path.relative(root, abs));
}

export function skillDir() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

// Jedna pisownia ścieżki, by dało się ją porównać z wynikiem gita: na win32
// realpathSync.native rozwija nazwy 8.3 (C:\Users\RUNNER~1 → runneradmin),
// gdzie indziej realpathSync rozwiązuje dowiązania (macOS /var → /private/var).
// Nieistniejąca ścieżka: kanonizujemy najbliższego istniejącego przodka
// i doklejamy resztę. `real` wstrzykiwalne w testach.
const defaultReal = process.platform === 'win32' ? fs.realpathSync.native : fs.realpathSync;

export function canonical(p, real = defaultReal) {
  const abs = path.resolve(String(p));
  try { return real(abs); } catch { /* nie istnieje lub brak dostępu */ }
  const parent = path.dirname(abs);
  return parent === abs ? abs : path.join(canonical(parent, real), path.basename(abs));
}
