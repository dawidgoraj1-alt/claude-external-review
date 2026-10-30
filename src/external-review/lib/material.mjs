import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { countChangedLines, diffFile, diffNoIndex, isTracked } from './git.mjs';
import { blobPath } from './state.mjs';
import { isBinary, normalizeText, sha256 } from './text.mjs';

function lineCount(text) {
  if (text === '') return 0;
  const n = text.split('\n').length;
  return text.endsWith('\n') ? n - 1 : n;
}

// Diff of the blob against the CURRENT file in normalized form, so that
// CRLF/BOM changes alone produce no diff.
function diffFromBlob(blob, abs, raw, content) {
  if (raw === content) return diffNoIndex(blob, abs);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'er-mat-'));
  try {
    const f = path.join(tmp, path.basename(abs));
    fs.writeFileSync(f, content, 'utf8');
    return diffNoIndex(blob, f);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

export function buildItems(ctx, s, stage, rels, { headSha } = {}) {
  const items = [];
  const skipped = [];
  for (const rel of rels) {
    const abs = path.join(ctx.root, rel);
    let buf;
    try {
      buf = fs.readFileSync(abs);
    } catch {
      continue; // plik zniknął
    }
    if (isBinary(buf)) {
      skipped.push({ path: rel, reason: 'binary' });
      continue;
    }
    const raw = buf.toString('utf8');
    const content = normalizeText(raw);
    const hash = sha256(content);
    const entry = s.files?.[rel];
    const blob = entry?.reviewedHash ? blobPath(ctx.stateDir, entry.reviewedHash) : null;
    const hasBlob = !!blob && fs.existsSync(blob);
    const full = () => ({ path: rel, kind: 'full', text: content, changedLines: lineCount(content), hash, content });
    const diff = (text) => ({ path: rel, kind: 'diff', text, changedLines: countChangedLines(text), hash, content });

    if (stage === 'spec' || stage === 'plan') {
      items.push(full());
      if (hasBlob) {
        const d = diffFromBlob(blob, abs, raw, content);
        if (d) items.push(diff(d));
      }
      continue;
    }
    if (hasBlob) {
      const d = diffFromBlob(blob, abs, raw, content);
      if (d) items.push(diff(d));
    } else if (ctx.isGit && isTracked(ctx.root, rel)) {
      const d = diffFile(ctx.root, headSha || 'HEAD', rel);
      if (d) items.push(diff(d));
    } else {
      items.push(full());
    }
  }
  return { items, skipped };
}

export function meetsThreshold(items, min) {
  return items.reduce((sum, i) => sum + i.changedLines, 0) >= min;
}

// Po całych plikach (elementy jednego pliku razem), kolejność wejściowa. tooLarge = pliki,
// których materiał sam przekracza maxBytes; overflow = pliki, które nie zmieściły się w maxChunks.
export function chunkItems(items, maxBytes, maxChunks) {
  const groups = new Map();
  for (const it of items) {
    if (!groups.has(it.path)) groups.set(it.path, []);
    groups.get(it.path).push(it);
  }
  const chunks = [];
  const sizes = [];
  const overflow = [];
  const tooLarge = [];
  for (const [p, group] of groups) {
    const size = group.reduce((n, i) => n + Buffer.byteLength(i.text, 'utf8'), 0);
    if (size > maxBytes) {
      tooLarge.push(p);
      continue;
    }
    let idx = sizes.findIndex((n) => n + size <= maxBytes);
    if (idx === -1 && chunks.length < maxChunks) {
      chunks.push([]);
      sizes.push(0);
      idx = chunks.length - 1;
    }
    if (idx === -1) {
      overflow.push(p);
      continue;
    }
    chunks[idx].push(...group);
    sizes[idx] += size;
  }
  return { chunks, overflow, tooLarge };
}
