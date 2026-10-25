// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
// Original symbol dictionaries and text composition, ITU-T T.88 clauses 6.4/6.5/7.4.
import { PdfEngineError } from './native-reader.js';
import { Input, corrupt, unsupported, boundedPixels } from './jbig2-input.js';
import { Jbig2Bits, standardHuffmanTable, symbolIdHuffmanTable } from './jbig2-huffman.js';
function numeric(value, name) { if (!Number.isInteger(value) || value < -2147483648 || value > 2147483647) corrupt(`Invalid JBIG2 ${name}.`); return value; }
function signed(input, count) { return Array.from(input.take(count), byte => byte > 127 ? byte - 256 : byte); }
function tableSelector(custom) {
  let index = 0;
  return { get(selection, choices, oob = false) { const table = selection === 3 ? custom[index++] : standardHuffmanTable(choices[selection]); if (!table || table.oob !== oob) corrupt('Invalid JBIG2 Huffman table selection or OOB capability.'); return table; }, finish() { if (index !== custom.length) corrupt('JBIG2 custom Huffman table count differs from its selections.'); } };
}
function huffmanEngine(bits, tables, id, withArithmetic, initial = null) {
  let retained = initial;
  return { bits, huffman: true, id, integer(key) { return tables[key].decode(bits); }, retain() { return retained || {}; },
    refine(width, height, template, adaptive, reference, dx, dy) {
      if (typeof withArithmetic !== 'function') unsupported('This JBIG2 Huffman refinement bitmap decoder is unavailable.');
      const length = numeric(tables.RSIZE.decode(bits), 'refinement bitmap byte count'); if (length < 1) corrupt('Empty JBIG2 refinement bitmap data.');
      return withArithmetic(bits.take(length), engine => { const data = engine.refine(width, height, template, adaptive, reference, dx, dy, true); retained = engine.retain(); return data; }, retained);
    } };
}
export function readJbig2SymbolDictionary(bytes, { imported = [], previous, customTables = [], decodeMmr, withArithmetic, check, countDecoded, countBytes, combine, countWork, countInstances } = {}) {
  const input = new Input(bytes), flags = input.u16(), huffman = !!(flags & 1), refinement = !!(flags & 2), template = flags >> 10 & 3, refinementTemplate = flags >> 12 & 1;
  if (flags & 0xe000 || !huffman && flags & 252 || huffman && template || !refinement && refinementTemplate || huffman && !refinement && flags & 896 || (flags >> 2 & 3) === 2 || (flags >> 4 & 3) === 2) corrupt('Invalid JBIG2 symbol dictionary flags.');
  const adaptive = huffman ? [] : signed(input, template ? 2 : 8), refinementAdaptive = refinement && !refinementTemplate ? signed(input, 4) : [], exportedCount = input.u32(), newCount = input.u32(), total = imported.length + newCount;
  if (total > 65536 || exportedCount > total) throw new PdfEngineError('JBIG2 symbol count limit exceeded.', 'pdf_limit');
  const signature = JSON.stringify([flags & 7171, adaptive, refinementAdaptive]);
  if (flags & 256 && (!previous?.retained || previous.signature !== signature)) corrupt('JBIG2 retained bitmap coding contexts are missing or incompatible.');
  if (!huffman && typeof withArithmetic !== 'function') unsupported('This JBIG2 arithmetic symbol decoder is unavailable.');
  const selected = tableSelector(customTables), dh = huffman && selected.get(flags >> 2 & 3, [4, 5]), dw = huffman && selected.get(flags >> 4 & 3, [2, 3], true), bitmapSize = huffman && selected.get(flags & 64 ? 3 : 0, [1]), aggregationCount = huffman && refinement && selected.get(flags & 128 ? 3 : 0, [1]); selected.finish();
  const encoded = input.take(bytes.length - input.at);
  function execute(engine) {
    const symbols = [...imported]; let height = 0;
    while (symbols.length < total) {
      check(); height = numeric(height + numeric(engine.integer('DH'), 'symbol delta height'), 'symbol height'); let width = 0, totalWidth = 0; const first = symbols.length, widths = [];
      for (;;) {
        check(); const delta = engine.integer('DW'); if (delta === null) break;
        if (symbols.length >= total) corrupt('JBIG2 dictionary defines more symbols than declared.');
        width = numeric(width + delta, 'symbol width'); boundedPixels(width, height); totalWidth += width; widths.push(width);
        if (huffman && !refinement) symbols.push(null);
        else {
          countDecoded({ width, height }); let data;
          if (!refinement) data = engine.generic(width, height, template, adaptive);
          else {
            const instances = numeric(engine.integer('AAI'), 'aggregation instance count'); if (instances < 1 || instances > 1_000_000) corrupt('Invalid JBIG2 aggregation instance count.'); countInstances(instances);
            if (instances === 1) {
              const id = engine.id(Math.ceil(Math.log2(Math.max(1, total)))); if (!Number.isInteger(id) || id < 0 || id >= symbols.length) corrupt('JBIG2 refinement references an undefined symbol.');
              const dx = numeric(engine.integer('RDX'), 'symbol refinement X'), dy = numeric(engine.integer('RDY'), 'symbol refinement Y');
              data = engine.refine(width, height, refinementTemplate, refinementAdaptive, symbols[id], dx, dy);
            } else data = textBitmap(engine, { region: { width, height }, symbols, instances, strips: 1, logStrips: 0, idBits: Math.ceil(Math.log2(Math.max(1, total))), refinement: true, template: refinementTemplate, adaptive: refinementAdaptive, corner: 1, transposed: false, operator: 0, offset: 0, defaultPixel: false }, { combine, check, countWork, countDecoded });
          }
          countBytes(data.length); symbols.push({ width, height, bytes: data });
        }
      }
      if (symbols.length === first) corrupt('JBIG2 symbol height class is empty.');
      if (huffman && !refinement) {
        boundedPixels(totalWidth, height); countDecoded({ width: totalWidth, height });
        const length = numeric(engine.integer('BMSIZE'), 'symbol bitmap size'); if (length < 0) corrupt('Negative JBIG2 symbol bitmap size.');
        const stride = Math.ceil(totalWidth / 8), data = length ? decodeMmr(engine.bits.take(length), { columns: totalWidth, rows: height, k: -1, endOfBlock: false, blackIs1: true, allowExtensions: false }) : engine.bits.take(stride * height); let sourceX = 0;
        if (data.length !== stride * height) corrupt('JBIG2 collective symbol bitmap size differs from its height class.');
        for (let i = 0; i < widths.length; i++) {
          const width = widths[i], targetStride = Math.ceil(width / 8), target = new Uint8Array(targetStride * height); countBytes(target.length);
          for (let y = 0; y < height; y++) { if (!(y & 255)) check(); for (let x = 0; x < width; x++) { const sx = sourceX + x; target[y * targetStride + (x >> 3)] |= (data[y * stride + (sx >> 3)] >> (7 - (sx & 7)) & 1) << (7 - (x & 7)); } }
          symbols[first + i] = { width, height, bytes: target }; sourceX += width;
        }
      }
    }
    const exported = []; let index = 0, flag = false, runs = 0;
    while (index < total) {
      check(); if (++runs > total * 2 + 2) throw new PdfEngineError('JBIG2 export run work limit exceeded.', 'pdf_limit'); const length = numeric(engine.integer('EX'), 'symbol export run');
      if (length < 0 || length > total - index) corrupt('JBIG2 export run exceeds its dictionary.'); if (flag) exported.push(...symbols.slice(index, index + length)); index += length; flag = !flag;
    }
    if (exported.length !== exportedCount) corrupt('JBIG2 exported symbol count differs from its dictionary.');
    engine.bits?.finish(); return { symbols: exported, signature, retained: flags & 512 ? engine.retain() : null };
  }
  if (!huffman) return withArithmetic(encoded, execute, flags & 256 ? previous.retained : null);
  const bits = new Jbig2Bits(encoded), tables = { DH: dh, DW: dw, BMSIZE: bitmapSize, EX: standardHuffmanTable(1), AAI: aggregationCount, FS: standardHuffmanTable(6), DS: standardHuffmanTable(8), DT: standardHuffmanTable(11), RDW: standardHuffmanTable(15), RDH: standardHuffmanTable(15), RDX: standardHuffmanTable(15), RDY: standardHuffmanTable(15), RSIZE: standardHuffmanTable(1) };
  return execute(huffmanEngine(bits, tables, length => bits.read(Math.max(1, length)), withArithmetic, flags & 256 ? previous.retained : null));
}

function textBitmap(engine, { region, symbols, instances, strips, logStrips, idBits, refinement, template, adaptive, corner, transposed, operator, offset, defaultPixel }, { combine, check, countWork, countDecoded }) {
  const canvas = { width: region.width, height: region.height, stride: Math.ceil(region.width / 8), bytes: new Uint8Array(Math.ceil(region.width / 8) * region.height), work: 0 }; if (defaultPixel) canvas.bytes.fill(255);
  let stripT = -numeric(engine.integer('DT'), 'initial strip T') * strips, firstS = 0, decoded = 0;
  while (decoded < instances) {
    check(); stripT = numeric(stripT + numeric(engine.integer('DT'), 'strip delta T') * strips, 'strip T'); firstS = numeric(firstS + numeric(engine.integer('FS'), 'first symbol S'), 'first S'); let currentS = firstS, first = true;
    for (;;) {
      if (!first) { const delta = engine.integer('DS'); if (delta === null) break; currentS = numeric(currentS + delta + offset, 'symbol S'); } first = false;
      if (decoded >= instances) corrupt('JBIG2 text region has more instances than declared.');
      const currentT = strips === 1 ? 0 : engine.huffman ? engine.bits.read(logStrips) : numeric(engine.integer('IT'), 'symbol strip offset'); if (currentT < 0 || currentT >= strips) corrupt('JBIG2 symbol lies outside its strip.');
      const id = engine.id(idBits); if (!Number.isInteger(id) || id < 0 || id >= symbols.length) corrupt('JBIG2 text symbol ID exceeds its dictionary.'); let symbol = symbols[id];
      if (refinement) {
        const refine = engine.huffman ? engine.bits.read(1) : engine.integer('RI'); if (refine !== 0 && refine !== 1) corrupt('Invalid JBIG2 symbol refinement flag.');
        if (refine) {
          const dw = numeric(engine.integer('RDW'), 'instance delta width'), dh = numeric(engine.integer('RDH'), 'instance delta height'), dx = numeric(engine.integer('RDX'), 'instance delta X'), dy = numeric(engine.integer('RDY'), 'instance delta Y');
          const width = symbol.width + dw, height = symbol.height + dh; boundedPixels(width, height); countDecoded({ width, height });
          symbol = { width, height, bytes: engine.refine(width, height, template, adaptive, symbol, Math.floor(dw / 2) + dx, Math.floor(dh / 2) + dy) };
        }
      }
      if ((!transposed && corner & 2) || (transposed && !(corner & 1))) currentS = numeric(currentS + (transposed ? symbol.height : symbol.width) - 1, 'symbol corner S');
      const ti = numeric(stripT + currentT, 'symbol T'), x = (transposed ? ti : currentS) - (corner & 2 ? symbol.width - 1 : 0), y = (transposed ? currentS : ti) - (corner & 1 ? 0 : symbol.height - 1);
      combine(canvas, { width: symbol.width, height: symbol.height, x, y }, symbol.bytes, operator, check);
      if ((!transposed && !(corner & 2)) || (transposed && corner & 1)) currentS = numeric(currentS + (transposed ? symbol.height : symbol.width) - 1, 'next symbol S'); decoded++;
    }
  }
  countWork(canvas.work); return canvas.bytes;
}

export function readJbig2TextRegion(input, region, { symbols, customTables = [], withArithmetic, combine, check, countWork, countDecoded, countInstances } = {}) {
  const flags = input.u16(), huffman = !!(flags & 1), refinement = !!(flags & 2), logStrips = flags >> 2 & 3, corner = flags >> 4 & 3, transposed = !!(flags & 64), operator = flags >> 7 & 3, template = flags >> 15;
  const offsetField = flags >> 10 & 31, offset = offsetField >= 16 ? offsetField - 32 : offsetField, huffmanFlags = huffman ? input.u16() : 0;
  if (!refinement && template || huffmanFlags & 0x8000 || !refinement && huffmanFlags & 0x7fc0) corrupt('Invalid JBIG2 text region flags.');
  const adaptive = refinement && !template ? signed(input, 4) : [], instances = input.u32();
  if (instances > 1_000_000 || symbols.length > 65536) throw new PdfEngineError('JBIG2 text symbol work limit exceeded.', 'pdf_limit');
  countInstances(instances); if (!huffman && typeof withArithmetic !== 'function') unsupported('This JBIG2 arithmetic text decoder is unavailable.');
  if (!symbols.length && instances) corrupt('JBIG2 text region has no symbols.');
  const selected = tableSelector(customTables), tables = {};
  if (huffman) { tables.FS = selected.get(huffmanFlags & 3, [6, 7]); tables.DS = selected.get(huffmanFlags >> 2 & 3, [8, 9, 10], true); tables.DT = selected.get(huffmanFlags >> 4 & 3, [11, 12, 13]); }
  if (huffman && refinement) { for (const [key, shift] of [['RDW', 6], ['RDH', 8], ['RDX', 10], ['RDY', 12]]) tables[key] = selected.get(huffmanFlags >> shift & 3, [14, 15]); tables.RSIZE = selected.get(huffmanFlags & 0x4000 ? 3 : 0, [1]); }
  selected.finish();
  const encoded = input.take(input.bytes.length - input.at), strips = 2 ** logStrips, idBits = Math.ceil(Math.log2(Math.max(1, symbols.length)));
  function execute(engine) {
    const bytes = textBitmap(engine, { region, symbols, instances, strips, logStrips, idBits, refinement, template, adaptive, corner, transposed, operator, offset, defaultPixel: !!(flags & 512) }, { combine, check, countWork, countDecoded }); engine.bits?.finish(); return bytes;
  }
  if (!huffman) return withArithmetic(encoded, execute);
  const bits = new Jbig2Bits(encoded), ids = symbolIdHuffmanTable(bits, symbols.length);
  return execute(huffmanEngine(bits, tables, () => ids.decode(bits), withArithmetic));
}
