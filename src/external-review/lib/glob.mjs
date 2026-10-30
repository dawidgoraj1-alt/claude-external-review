import fs from 'node:fs';
import path from 'node:path';

const escapeRe = (c) => c.replace(/[.+^${}()|[\]\\]/g, '\\$&');

// Semantics: "**/" = zero or more segments, "**" = anything, "*" = any chars
// except "/", "?" = one char except "/". Whole-path match.
export function globToRegExp(pattern, opts = {}) {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        if (pattern[i + 2] === '/') { re += '(?:.*/)?'; i += 2; }
        else { re += '.*'; i += 1; }
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += escapeRe(c);
  }
  return new RegExp(`^${re}$`, opts.nocase ? 'i' : '');
}

export function matchAny(rel, patterns, opts = {}) {
  return patterns.some((p) => globToRegExp(p, opts).test(rel));
}

export function walk(root, opts = {}) {
  const { ignoreDirs = [], nocase = false, maxFiles = Infinity } = opts;
  const norm = (s) => (nocase ? s.toLowerCase() : s);
  const ignored = new Set(ignoreDirs.map(norm));
  const out = [];

  const visit = (abs, rel) => {
    let entries;
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => (a.name.toLowerCase() < b.name.toLowerCase() ? -1 : a.name.toLowerCase() > b.name.toLowerCase() ? 1 : 0));
    for (const e of entries) {
      if (out.length >= maxFiles) return;
      if (e.isSymbolicLink()) continue;
      const childAbs = path.join(abs, e.name);
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (ignored.has(norm(e.name))) continue;
        visit(childAbs, childRel);
      } else if (e.isFile()) {
        try {
          const st = fs.statSync(childAbs);
          out.push({ rel: childRel, mtimeMs: st.mtimeMs, size: st.size });
        } catch { /* vanished */ }
      }
    }
  };
  visit(root, '');
  return out;
}
