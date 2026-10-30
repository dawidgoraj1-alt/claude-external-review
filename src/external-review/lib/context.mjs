import os from 'node:os';
import { loadConfig } from './config.mjs';
import { gitRoot } from './git.mjs';
import { canonical, nocase as isNocase, stateDirFor, toSlash } from './paths.mjs';

function samePath(a, b, ci) {
  const n = (p) => {
    let s = toSlash(p).replace(/\/+$/, '');
    if (/^[A-Za-z]:$/.test(s)) s += '/';
    return ci ? s.toLowerCase() : s;
  };
  return n(a) === n(b);
}

// opts.homedir is injectable for tests. The developer's home directory is
// often itself a git repo; a project below it must not adopt it as its root.
// cwd, home and the git root are canonicalized (8.3 names, symlinks) so they
// compare equal to each other and to tool file paths (see canonical()).
export function makeContext(rawCwd, env = process.env, opts = {}) {
  const nocase = isNocase();
  const cwd = canonical(rawCwd);
  const home = canonical(opts.homedir ?? os.homedir());
  let root = cwd;
  let isGit = false;
  const gitTop = gitRoot(cwd);
  const top = gitTop && toSlash(canonical(gitTop));
  if (top) {
    const homeRepoAbove = samePath(top, home, nocase) && !samePath(cwd, home, nocase);
    if (!homeRepoAbove) {
      root = top;
      isGit = true;
    }
  }
  return {
    cwd,
    root,
    isGit,
    config: loadConfig(env),
    stateDir: stateDirFor(root, env),
    nocase,
    now: Date.now(),
  };
}
