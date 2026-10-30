// Copyright (c) 2026 Dawid Góraj — external-review (https://github.com/dawidgoraj1-alt/claude-external-review). Licencja MIT.
// Postęp pracy Codexa: parser strumienia JSONL (codex exec --json) i mapowanie zdarzeń na krótkie polskie opisy.
import { StringDecoder } from 'node:string_decoder';

const MAX_LINE = 1024 * 1024;
const READERS = /(?:^|[\s"'`(|;&])(cat|sed|head|tail|rg|grep|Get-Content|gc|type|bat|less|nl|awk)(?=[\s"'`]|$)/i;

function baseName(p) {
  return p.replace(/["'`)]+$/, '').split(/[\\/]/).filter(Boolean).pop() || '';
}

// Ostatni token przypominający plik (rozszerzenie lub separator ścieżki), niebędący flagą.
function readTarget(command) {
  const tokens = command.split(/[\s"'`]+/).filter(Boolean);
  for (let i = tokens.length - 1; i >= 0; i--) {
    const t = tokens[i];
    if (t.startsWith('-') || READERS.test(` ${t} `) && !/[\\/.]/.test(t)) continue;
    if (/[\\/]/.test(t) || /\.[A-Za-z0-9]{1,8}$/.test(t)) {
      const b = baseName(t);
      if (b && /^[^<>|&;*?]+$/.test(b)) return b;
    }
  }
  return null;
}

// Codex owija polecenia w powłokę (Windows: "…\powershell.exe" -Command '…', Unix: bash -lc "…"); pokazujemy samo polecenie.
const SHELL_WRAP = /^"?(?:[^"\s]*[\\/])?(?:[^"\\/]*[\\/])*(?:powershell|pwsh|cmd|bash|sh|zsh)(?:\.exe)?"?(?:\s+-(?:NoProfile|NoLogo|NonInteractive))*\s+(?:-Command|-c|-lc|\/c)\s+/i;

function unwrapShell(c) {
  const m = SHELL_WRAP.exec(c);
  if (!m) return c;
  const rest = c.slice(m[0].length).trim();
  const q = rest[0];
  return (q === '"' || q === "'") && rest.endsWith(q) && rest.length > 1 ? rest.slice(1, -1).trim() : rest;
}

function commandAction(command) {
  if (typeof command !== 'string' || !command.trim()) return null;
  const c = unwrapShell(command.trim());
  if (READERS.test(c)) {
    const f = readTarget(c);
    if (f) return `czyta ${f}`;
  }
  return `uruchamia ${c.slice(0, 40)}`;
}

// → { action?: string, tokens?: number }; nieznane lub niepełne zdarzenia dają {}.
export function describeEvent(evt) {
  if (!evt || typeof evt !== 'object') return {};
  const type = evt.type;
  if (type === 'turn.completed') {
    const u = evt.usage;
    if (!u || typeof u !== 'object') return {};
    const n = (Number(u.input_tokens) || 0) + (Number(u.output_tokens) || 0);
    return n > 0 ? { tokens: n } : {};
  }
  if (typeof type !== 'string' || !type.startsWith('item.')) return {};
  const it = evt.item;
  if (!it || typeof it !== 'object') return {};
  switch (it.type) {
    case 'reasoning': return { action: 'myśli' };
    case 'command_execution': { const a = commandAction(it.command); return a ? { action: a } : {}; }
    case 'file_change': return { action: 'zmienia pliki' };
    case 'web_search': return { action: 'szuka w sieci' };
    case 'agent_message': return { action: 'pisze wynik' };
    default: return {};
  }
}

// Składa porcje strumienia w linie; każdą poprawną linię JSON (obiekt) przekazuje do onEvent.
// Tolerancyjny: śmieci, niepełne linie, zbyt długie linie i wyjątki handlera są pomijane.
export function createLineParser(onEvent) {
  let buf = '';
  let skipping = false;
  const dec = new StringDecoder('utf8');
  const emit = (line) => {
    if (line.length > MAX_LINE) return;
    const s = line.replace(/\r$/, '').trim();
    if (!s || s[0] !== '{') return;
    let evt;
    try { evt = JSON.parse(s); } catch { return; }
    try { onEvent(evt); } catch { /* ignored */ }
  };
  return {
    write(chunk) {
      let s = typeof chunk === 'string' ? chunk : dec.write(chunk);
      while (s.length) {
        const nl = s.indexOf('\n');
        if (nl < 0) {
          if (!skipping) {
            buf += s;
            if (buf.length > MAX_LINE) { buf = ''; skipping = true; }
          }
          return;
        }
        if (skipping) skipping = false;
        else if (buf.length + nl <= MAX_LINE) emit(buf + s.slice(0, nl));
        buf = '';
        s = s.slice(nl + 1);
      }
    },
    end() {
      if (!skipping && buf) emit(buf);
      buf = '';
      skipping = false;
    },
  };
}
