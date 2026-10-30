import fs from 'node:fs';
import path from 'node:path';
import { baseDir, skillDir } from './paths.mjs';

export function localConfigPath(env = process.env) {
  return path.join(baseDir(env), 'external-review', 'config.local.json');
}

function readJson(file, required) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (!required && e.code === 'ENOENT') return {};
    throw e;
  }
  return JSON.parse(raw.replace(/^﻿/, ''));
}

export function loadConfig(env = process.env) {
  const defaults = readJson(path.join(skillDir(), 'config.json'), true);
  const local = readJson(localConfigPath(env), false);
  return { ...defaults, ...local };
}
