// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
// Original bounded reader of CMap records. No PostScript program is evaluated.
import { PdfEngineError } from './native-reader.js';
import { readCmapTokens } from './cmap-lexer.js';

const corrupt = message => { throw new PdfEngineError(message, 'pdf_corrupt'); };
export const cmapKey = bytes => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
export const cmapByte = (code, length, index) => Math.floor(code / 256 ** (length - index - 1)) % 256;
/** Conservative retained-record admission estimate, not a browser heap measurement. */
export function cmapResourceBytes(...maps) {
  const seen = new Set(); let bytes = 0;
  for (let map of maps) for (; map && !seen.has(map); map = map.parent) {
    seen.add(map); bytes += 64 + map.spaces.length * 32;
    for (const name of ['baseName', 'registry', 'ordering']) bytes += 2 * (map[name]?.length || 0);
    for (const [source] of map.cids) bytes += 64 + 2 * source.length + 8;
    for (const records of [map.unicode, map.invalidUnicode]) for (const [source, text] of records) bytes += 64 + 2 * (source.length + text.length);
  }
  return bytes;
}
export function cmapCodeInSpace(space, code, length) {
  if (space.length !== length) return false;
  for (let i = 0; i < length; i++) {
    const byte = cmapByte(code, length, i);
    if (byte < cmapByte(space.first, length, i) || byte > cmapByte(space.last, length, i)) return false;
  }
  return true;
}
const integer = (token, maximum = 65535) => {
  if (token?.kind !== 'number' || !Number.isInteger(token.value) || token.value < 0 || token.value > maximum) corrupt('Invalid CMap integer.');
  return token.value;
};
const numberOf = token => {
  if (token?.kind !== 'hex' || token.bytes.length < 1 || token.bytes.length > 4) corrupt('Invalid CMap source code.');
  return token.bytes.reduce((value, byte) => value * 256 + byte, 0);
};
function unicode(bytes) {
  if (!bytes.length || bytes.length % 2 || bytes.length > 64) corrupt('Invalid CMap Unicode value.');
  let result = ''; for (let i = 0; i < bytes.length; i += 2) result += String.fromCharCode(bytes[i] * 256 + bytes[i + 1]);
  if (!result.isWellFormed()) corrupt('Invalid CMap Unicode surrogate sequence.');
  return result.startsWith('\ufeff') ? result.slice(1) : result;
}

/** Read inert code-space/CID/Unicode records and optional base-map metadata. */
export function parseCmapData(bytes) {
  const tokens = readCmapTokens(bytes), map = { spaces: [], cids: new Map(), unicode: new Map(), invalidUnicode: new Map(), baseName: null, vertical: undefined, registry: null, ordering: null };
  let active = false, ended = false, records = 0;
  const storeUnicode = (source, target) => {
    try { map.unicode.set(source, unicode(target)); map.invalidUnicode.delete(source); }
    catch (error) { if (error.code !== 'pdf_corrupt') throw error; map.invalidUnicode.set(source, error.message); map.unicode.delete(source); }
  };
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.kind === 'word' && token.value === 'begincmap') { if (active || ended) corrupt('Duplicate CMap body.'); active = true; continue; }
    if (token.kind === 'word' && token.value === 'endcmap') { if (!active) corrupt('Unbalanced CMap body.'); active = false; ended = true; continue; }
    if (!active) continue;
    if (token.kind === 'name' && token.value === 'WMode') { const mode = integer(tokens[i + 1], 1); if (tokens[i + 2]?.value !== 'def') corrupt('Invalid CMap writing mode.'); map.vertical = Boolean(mode); }
    if (token.kind === 'name' && ['Registry', 'Ordering'].includes(token.value) && tokens[i + 1]?.kind === 'string') map[token.value.toLowerCase()] = tokens[i + 1].value;
    if (token.kind === 'word' && token.value === 'usecmap') {
      if (tokens[i - 1]?.kind !== 'name' || map.baseName) corrupt('Invalid CMap base resource.'); map.baseName = tokens[i - 1].value; continue;
    }
    if (token.kind !== 'word' || !['begincodespacerange', 'begincidchar', 'begincidrange', 'beginnotdefchar', 'beginnotdefrange', 'beginbfchar', 'beginbfrange'].includes(token.value)) continue;
    const operation = token.value.slice(5), count = integer(tokens[i - 1], 100000);
    for (let row = 0; row < count; row++) {
      const firstToken = tokens[++i], first = numberOf(firstToken), length = firstToken.bytes.length;
      const isRange = operation.endsWith('range'), lastToken = isRange ? tokens[++i] : firstToken, last = numberOf(lastToken);
      if (lastToken.bytes.length !== length || last < first) corrupt('Invalid CMap code range.');
      if (operation === 'codespacerange') { map.spaces.push({ length, first, last }); continue; }
      if ((records += last - first + 1) > 200000) throw new PdfEngineError('CMap mapping budget exceeded.', 'pdf_limit');
      const target = tokens[++i], cid = operation.startsWith('cid') || operation.startsWith('notdef') ? integer(target) : null;
      if (cid !== null && !operation.startsWith('notdef') && cid + last - first > 65535) corrupt('CMap CID range exceeds 65535.');
      const targets = [];
      if (cid === null && target?.value === '[') {
        while (tokens[++i]?.value !== ']') { if (!tokens[i] || tokens[i].kind !== 'hex' || targets.length > last - first) corrupt('Invalid CMap Unicode target array.'); targets.push(tokens[i].bytes); }
        if (targets.length !== last - first + 1) corrupt('CMap Unicode array does not match its range.');
      } else if (cid === null && target?.kind !== 'hex') corrupt('Invalid CMap Unicode target.');
      for (let source = first; source <= last; source++) {
        const code = source.toString(16).padStart(length * 2, '0');
        if (cid !== null) { map.cids.set(code, cid + (operation.startsWith('notdef') ? 0 : source - first)); continue; }
        if (targets.length) { storeUnicode(code, targets[source - first]); continue; }
        const value = target.bytes.slice(); let carry = source - first;
        for (let p = value.length - 1; p >= 0 && carry; p--) { carry += value[p]; value[p] = carry & 255; carry = Math.floor(carry / 256); }
        if (carry) { map.invalidUnicode.set(code, 'CMap Unicode range overflows.'); map.unicode.delete(code); } else storeUnicode(code, value);
      }
    }
    if (tokens[++i]?.value !== `end${operation}`) corrupt('Unterminated CMap record section.');
  }
  if (active || !ended) corrupt('Missing CMap body terminator.');
  return map;
}

export function cmapCid(map, key) {
  for (let current = map; current; current = current.parent) {
    if (current.identity && key.length === 4) return parseInt(key, 16);
    if (current.cids.has(key)) return current.cids.get(key);
  }
  return 0;
}
export function cmapUnicode(map, key) {
  for (let current = map; current; current = current.parent) {
    const error = current.invalidUnicode.get(key); if (error) corrupt(error);
    if (current.unicode.has(key)) return current.unicode.get(key);
  }
  return undefined;
}
export function decodeCmapBytes(map, bytes) {
  const result = [];
  for (let offset = 0; offset < bytes.length;) {
    let code = 0, found = null;
    for (let length = 1; length <= 4 && offset + length <= bytes.length; length++) {
      code = code * 256 + bytes[offset + length - 1];
      if (map.spaces.some(space => cmapCodeInSpace(space, code, length))) { found = { code, codeLength: length, sourceKey: cmapKey(bytes.subarray(offset, offset + length)) }; break; }
    }
    if (!found) corrupt('Truncated or invalid CMap character code.');
    result.push({ ...found, cid: cmapCid(map, found.sourceKey) }); offset += found.codeLength;
  }
  return result;
}
