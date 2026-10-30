import { execFileSync } from 'node:child_process';
import { toSlash } from './paths.mjs';

const MAX_BUFFER = 64 * 1024 * 1024;
// quotepath=false + -z: ścieżki z polskimi znakami/spacjami nigdy nie są cytowane.
const BASE_ARGS = ['-c', 'core.quotepath=false', '--literal-pathspecs'];

function run(cwd, args, opts = {}) {
  return execFileSync('git', [...BASE_ARGS, ...args], {
    cwd,
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    ...opts,
  });
}

function splitZ(out) {
  return out.split('\0').filter(Boolean);
}

export function gitRoot(cwd) {
  try {
    const out = run(cwd, ['rev-parse', '--show-toplevel']).trim();
    return out ? toSlash(out) : null;
  } catch {
    return null;
  }
}

export function headSha(root) {
  try {
    return run(root, ['rev-parse', '--verify', '-q', 'HEAD']).trim() || null;
  } catch {
    return null;
  }
}

function parseStatus(root, wantDeleted) {
  const parts = splitZ(run(root, ['status', '--porcelain', '-uall', '-z']));
  const result = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    const x = entry[0];
    const y = entry[1];
    const file = entry.slice(3);
    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') i++; // następny token to ścieżka źródłowa
    if ((x === 'D' || y === 'D') !== wantDeleted) continue;
    result.push(toSlash(file));
  }
  return result;
}

export function statusPaths(root) {
  return parseStatus(root, false);
}

// Sciezki usuniete (D w index lub drzewie roboczym) wg git status.
export function statusDeletedPaths(root) {
  return parseStatus(root, true);
}

export function committedSince(root, sha) {
  if (!sha) return [];
  const head = headSha(root);
  if (!head || head === sha) return [];
  try {
    return splitZ(run(root, ['diff', '--name-only', '-z', sha, 'HEAD'])).map(toSlash);
  } catch {
    return [];
  }
}

export function isTracked(root, rel) {
  try {
    return splitZ(run(root, ['ls-files', '-z', '--', rel])).length > 0;
  } catch {
    return false;
  }
}

export function diffFile(root, rev, rel) {
  return run(root, ['diff', '--no-color', '--no-ext-diff', rev, '--', rel]);
}

export function diffNoIndex(a, b) {
  try {
    return run(undefined, ['diff', '--no-index', '--no-color', '--no-ext-diff', '--', a, b]);
  } catch (err) {
    if (err && err.status === 1) return String(err.stdout ?? '');
    throw err;
  }
}

export function countChangedLines(diff) {
  let n = 0;
  for (const line of String(diff).split('\n')) {
    if ((line.startsWith('+') && !line.startsWith('+++')) || (line.startsWith('-') && !line.startsWith('---'))) n++;
  }
  return n;
}
