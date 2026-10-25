// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
// Original inert CMap lexer. No PostScript program is evaluated.
import { PdfEngineError } from './native-reader.js';

const corrupt = message => { throw new PdfEngineError(message, 'pdf_corrupt'); };
const limit = message => { throw new PdfEngineError(message, 'pdf_limit'); };
const MiB = 1024 * 1024;
const whiteByte = byte => byte === 0 || byte === 9 || byte === 10 || byte === 12 || byte === 13 || byte === 32;
const hexadecimal = char => /^[0-9a-f]$/i.test(char);

function tokenize(bytes, toUnicode) {
  const inputLimit = (toUnicode ? 32 : 2) * MiB, tokenLimit = toUnicode ? 1000000 : 500000;
  if (!(bytes instanceof Uint8Array) || bytes.length > inputLimit) limit(`CMap data exceeds its ${toUnicode ? 32 : 2} MiB limit.`);
  // Offsets remain byte offsets even for Windows-1252's high characters. Literal
  // ToUnicode values below read the original bytes, never re-encode this text.
  const text = new TextDecoder('latin1').decode(bytes), result = [];
  const white = i => toUnicode ? whiteByte(bytes[i]) : /\s/.test(text[i]);
  const delimiter = i => white(i) || '[]{}<>()/%'.includes(text[i]);
  for (let i = 0; i < text.length;) {
    if (white(i)) { i++; continue; }
    if (text[i] === '%') { while (i < text.length && !/[\r\n]/.test(text[i])) i++; continue; }
    if (text[i] === '<' && text[i + 1] !== '<') {
      const start = ++i; let digits = 0;
      while (i < text.length && text[i] !== '>') {
        if (toUnicode && i - start >= 16 * MiB) limit('CMap string scan exceeds its 16 MiB limit.');
        if (!white(i)) { if (!hexadecimal(text[i])) corrupt('Invalid CMap hexadecimal string.'); digits++; }
        if (!toUnicode && digits > 128) corrupt('Invalid CMap hexadecimal string.');
        i++;
      }
      if (i >= text.length) corrupt('Unterminated CMap hexadecimal string.');
      const value = new Uint8Array(Math.ceil(digits / 2)); let high = -1, offset = 0;
      for (let p = start; p < i; p++) if (!white(p)) {
        const digit = parseInt(text[p], 16);
        if (high < 0) high = digit; else { value[offset++] = high * 16 + digit; high = -1; }
      }
      if (high >= 0) value[offset] = high * 16;
      result.push({ kind: 'hex', bytes: value }); i++;
    } else if (text[i] === '(') {
      const start = ++i; let depth = 1;
      while (i < text.length && depth) {
        const char = text[i++];
        if (char === '\\') { if (i >= text.length) corrupt('Truncated CMap literal escape.'); i++; }
        else if (char === '(') { if (++depth > (toUnicode ? 64 : 32)) limit('CMap literal exceeds its bounds.'); }
        else if (char === ')') depth--;
        if (toUnicode && i - start > 16 * MiB) limit('CMap string scan exceeds its 16 MiB limit.');
      }
      if (depth) corrupt('Unterminated CMap literal.');
      const end = i - 1, decoded = toUnicode ? new Uint8Array(end - start) : null; let value = '', offset = 0;
      for (let p = start; p < end;) {
        let char = text[p], byte = bytes[p++];
        if (char === '\\') {
          char = text[p]; byte = bytes[p++];
          if (/[0-7]/.test(char)) { let octal = char; while (octal.length < 3 && p < end && /[0-7]/.test(text[p])) octal += text[p++]; byte = parseInt(octal, 8) & 255; char = String.fromCharCode(byte); }
          else if (char === '\r' || char === '\n') { if (char === '\r' && text[p] === '\n') p++; continue; }
          else { const escape = ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' })[char]; if (escape !== undefined) { char = escape; byte = char.charCodeAt(0); } }
        } else if (toUnicode && byte === 13) { if (bytes[p] === 10) p++; byte = 10; }
        if (decoded) decoded[offset++] = byte;
        else { value += char; if (value.length > 4096) limit('CMap literal exceeds its bounds.'); }
      }
      result.push(decoded ? { kind: 'string', bytes: decoded.subarray(0, offset) } : { kind: 'string', value });
    } else if ('[]{}<>'.includes(text[i])) {
      const value = text[i] === text[i + 1] && '<>'.includes(text[i]) ? text.slice(i, i + 2) : text[i];
      result.push({ kind: 'word', value }); i += value.length;
    } else {
      const start = i, name = text[i] === '/'; if (name) i++;
      while (i < text.length && !delimiter(i)) { if (toUnicode && i - start >= 16 * MiB) limit('CMap token exceeds its 16 MiB limit.'); i++; }
      // A bare slash is an empty literal name, accepted by the previous
      // ToUnicode PDF lexer (ISO 32000-1, 7.3.5). Keep legacy CID defaults.
      if (i === start || !toUnicode && name && i === start + 1) corrupt('Invalid CMap token.');
      const value = text.slice(start + Number(name), i), numeric = (toUnicode ? /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/ : /^[+-]?\d+(?:\.\d+)?$/).test(value);
      if (toUnicode && !name && /^[+\-.\d]/.test(value) && !numeric) corrupt('Invalid CMap number.');
      if (toUnicode && !name && numeric && Math.abs(Number(value)) > 1e15) limit('CMap number exceeds its bounds.');
      result.push({ kind: name ? 'name' : numeric ? 'number' : 'word', value: !name && numeric ? Number(value) : value });
    }
    if (result.length > tokenLimit) limit('CMap token budget exceeded.');
  }
  return result;
}

/** Preserve the existing predefined/CID CMap lexical limits and flat records. */
export const readCmapTokens = bytes => tokenize(bytes, false);

/** Read inert ToUnicode values, preserving array/dictionary boundaries. */
export function readToUnicodeValues(bytes) {
  const result = [], stack = [{ kind: 'root', values: result }];
  for (const token of tokenize(bytes, true)) {
    const current = stack[stack.length - 1];
    if (token.kind === 'word' && ['{', '}'].includes(token.value)) corrupt('PostScript procedures are not supported in a ToUnicode CMap.');
    if (token.kind === 'word' && [']', '>>', '>'].includes(token.value)) {
      if (stack.length === 1 || token.value !== (current.kind === 'array' ? ']' : '>>')) corrupt('Unbalanced ToUnicode container.');
      stack.pop(); continue;
    }
    if (current.values.length >= 100000 && current.kind !== 'root') limit('ToUnicode container entry limit exceeded.');
    if (token.kind === 'word' && ['[', '<<'].includes(token.value)) {
      if (stack.length > 64) limit('ToUnicode container depth limit exceeded.');
      const value = { kind: token.value === '[' ? 'array' : 'dictionary', values: [] }; current.values.push(value); stack.push(value);
    } else current.values.push(token.kind === 'hex' ? { kind: 'string', bytes: token.bytes } : token);
  }
  if (stack.length !== 1) corrupt('Unterminated ToUnicode container.');
  return result;
}
