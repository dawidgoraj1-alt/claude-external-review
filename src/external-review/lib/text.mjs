import crypto from 'node:crypto';

export function normalizeText(input) {
  const s = Buffer.isBuffer(input) ? input.toString('utf8') : String(input);
  return s.replace(/^﻿/, '').replace(/\r\n/g, '\n');
}

export function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

export function isBinary(buf) {
  return buf.subarray(0, 8000).includes(0);
}
