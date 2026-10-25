// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
// Original bounded decoder; numeric format tables are ITU-T T.88 Annex B data.
import { PdfEngineError } from './native-reader.js';
import { Input, corrupt } from './jbig2-input.js';
// Each line is [range base, prefix length, suffix length, optional lower-range].
const TABLES = [null,
  [[0,1,4],[16,2,8],[272,3,16],[65808,3,32]],
  [[0,1,0],[1,2,0],[2,3,0],[3,4,3],[11,5,6],[75,6,32],[null,6,0]],
  [[-256,8,8],[0,1,0],[1,2,0],[2,3,0],[3,4,3],[11,5,6],[-257,8,32,true],[75,7,32],[null,6,0]],
  [[1,1,0],[2,2,0],[3,3,0],[4,4,3],[12,5,6],[76,5,32]],
  [[-255,7,8],[1,1,0],[2,2,0],[3,3,0],[4,4,3],[12,5,6],[-256,7,32,true],[76,6,32]],
  [[-2048,5,10],[-1024,4,9],[-512,4,8],[-256,4,7],[-128,5,6],[-64,5,5],[-32,4,5],[0,2,7],[128,3,7],[256,3,8],[512,4,9],[1024,4,10],[-2049,6,32,true],[2048,6,32]],
  [[-1024,4,9],[-512,3,8],[-256,4,7],[-128,5,6],[-64,5,5],[-32,4,5],[0,4,5],[32,5,5],[64,5,6],[128,4,7],[256,3,8],[512,3,9],[1024,3,10],[-1025,5,32,true],[2048,5,32]],
  [[-15,8,3],[-7,9,1],[-5,8,1],[-3,9,0],[-2,7,0],[-1,4,0],[0,2,1],[2,5,0],[3,6,0],[4,3,4],[20,6,1],[22,4,4],[38,4,5],[70,5,6],[134,5,7],[262,6,7],[390,7,8],[646,6,10],[-16,9,32,true],[1670,9,32],[null,2,0]],
  [[-31,8,4],[-15,9,2],[-11,8,2],[-7,9,1],[-5,7,1],[-3,4,1],[-1,3,1],[1,3,1],[3,5,1],[5,6,1],[7,3,5],[39,6,2],[43,4,5],[75,4,6],[139,5,7],[267,5,8],[523,6,8],[779,7,9],[1291,6,11],[-32,9,32,true],[3339,9,32],[null,2,0]],
  [[-21,7,4],[-5,8,0],[-4,7,0],[-3,5,0],[-2,2,2],[2,5,0],[3,6,0],[4,7,0],[5,8,0],[6,2,6],[70,5,5],[102,6,5],[134,6,6],[198,6,7],[326,6,8],[582,6,9],[1094,6,10],[2118,7,11],[-22,8,32,true],[4166,8,32],[null,2,0]],
  [[1,1,0],[2,2,1],[4,4,0],[5,4,1],[7,5,1],[9,5,2],[13,6,2],[17,7,2],[21,7,3],[29,7,4],[45,7,5],[77,7,6],[141,7,32]],
  [[1,1,0],[2,2,0],[3,3,1],[5,5,0],[6,5,1],[8,6,1],[10,7,0],[11,7,1],[13,7,2],[17,7,3],[25,7,4],[41,8,5],[73,8,32]],
  [[1,1,0],[2,3,0],[3,4,0],[4,5,0],[5,4,1],[7,3,3],[15,6,1],[17,6,2],[21,6,3],[29,6,4],[45,6,5],[77,7,6],[141,7,32]],
  [[-2,3,0],[-1,3,0],[0,1,0],[1,3,0],[2,3,0]],
  [[-24,7,4],[-8,6,2],[-4,5,1],[-2,4,0],[-1,3,0],[0,1,0],[1,3,0],[2,4,0],[3,5,1],[5,6,2],[9,7,4],[-25,7,32,true],[25,7,32]],
];
export class Jbig2Bits {
  constructor(bytes) { this.bytes = bytes; this.bit = 0; }
  read(count) { if (!Number.isInteger(count) || count < 0 || count > 32 || count > this.bytes.length * 8 - this.bit) corrupt('Truncated JBIG2 Huffman data.'); let value = 0; for (let i = 0; i < count; i++, this.bit++) value = value * 2 + (this.bytes[this.bit >> 3] >> (7 - (this.bit & 7)) & 1); return value; }
  align() { this.bit = Math.ceil(this.bit / 8) * 8; }
  take(count) { this.align(); if (!Number.isSafeInteger(count) || count < 0 || count > this.bytes.length - this.bit / 8) corrupt('Truncated JBIG2 Huffman bitmap.'); const start = this.bit / 8; this.bit += count * 8; return this.bytes.subarray(start, start + count); }
  finish() { this.align(); if (this.bit !== this.bytes.length * 8) corrupt('Unexpected bytes after JBIG2 Huffman data.'); }
}
export class Jbig2HuffmanTable {
  constructor(lines) {
    if (!Array.isArray(lines) || lines.length > 131072) throw new PdfEngineError('JBIG2 Huffman table line limit exceeded.', 'pdf_limit');
    this.byLength = Array.from({ length: 33 }, () => new Map()); this.oob = false; this.lineCount = lines.length; const counts = new Uint32Array(33);
    for (const [base, length, suffix] of lines) { if (!Number.isInteger(length) || length < 0 || length > 32 || !Number.isInteger(suffix) || suffix < 0 || suffix > 32 || base !== null && !Number.isSafeInteger(base)) corrupt('Invalid JBIG2 Huffman table line.'); if (length) counts[length]++; }
    let first = 0;
    for (let length = 1; length <= 32; length++) {
      first = (first + (length > 1 ? counts[length - 1] : 0)) * 2; let code = first;
      for (const line of lines) if (line[1] === length) { if (code >= 2 ** length) corrupt('Oversubscribed JBIG2 Huffman table.'); this.byLength[length].set(code++, line); if (line[0] === null) this.oob = true; }
    }
    if (!counts.some(value => value)) corrupt('Empty JBIG2 Huffman table.');
  }
  decode(input) {
    let code = 0;
    for (let length = 1; length <= 32; length++) {
      code = code * 2 + input.read(1); const line = this.byLength[length].get(code); if (!line) continue;
      if (line[0] === null) return null;
      const value = line[0] + input.read(line[2]) * (line[3] ? -1 : 1); if (value < -2147483648 || value > 2147483647) corrupt('JBIG2 Huffman integer exceeds its signed range.'); return value;
    }
    corrupt('Unknown JBIG2 Huffman prefix.');
  }
}
const STANDARD = TABLES.map(lines => lines && new Jbig2HuffmanTable(lines));
export function standardHuffmanTable(number) { const table = STANDARD[number]; if (!table) corrupt('Unknown JBIG2 standard Huffman table.'); return table; }
export function customHuffmanTable(bytes) {
  const header = new Input(bytes), flags = header.u8(), low = header.u32() | 0, high = header.u32() | 0;
  if (flags & 128 || low >= high) corrupt('Invalid JBIG2 custom Huffman table header.');
  const input = new Jbig2Bits(header.take(bytes.length - header.at)), prefixBits = (flags >> 1 & 7) + 1, rangeBits = (flags >> 4 & 7) + 1, lines = []; let current = low;
  while (current < high) { if (lines.length >= 4096) throw new PdfEngineError('JBIG2 custom Huffman table line limit exceeded.', 'pdf_limit'); const length = input.read(prefixBits), suffix = input.read(rangeBits); if (suffix > 32) corrupt('Invalid JBIG2 custom range bit count.'); lines.push([current, length, suffix]); current += 2 ** suffix; }
  lines.push([low - 1, input.read(prefixBits), 32, true], [high, input.read(prefixBits), 32]);
  if (flags & 1) lines.push([null, input.read(prefixBits), 0]); input.finish(); return new Jbig2HuffmanTable(lines);
}
export function symbolIdHuffmanTable(input, count) {
  if (!Number.isInteger(count) || count < 1 || count > 65536) throw new PdfEngineError('JBIG2 symbol ID count limit exceeded.', 'pdf_limit');
  const runTable = new Jbig2HuffmanTable(Array.from({ length: 35 }, (_, i) => [i, input.read(4), 0])), lengths = [];
  while (lengths.length < count) {
    const code = runTable.decode(input); let value = code, repeat = 1;
    if (code === 32) { if (!lengths.length) corrupt('JBIG2 symbol length repeat has no predecessor.'); value = lengths.at(-1); repeat = input.read(2) + 3; }
    else if (code === 33 || code === 34) { value = 0; repeat = input.read(code === 33 ? 3 : 7) + (code === 33 ? 3 : 11); }
    if (repeat > count - lengths.length) corrupt('JBIG2 symbol length run exceeds its symbol count.');
    for (let i = 0; i < repeat; i++) lengths.push(value);
  }
  input.align(); return new Jbig2HuffmanTable(lengths.map((length, i) => [i, length, 0]));
}
