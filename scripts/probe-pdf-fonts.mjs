// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
// Read-only diagnostic census for the fixed corpus; never invokes a legacy parser.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { NativePdfReader } from '../src/pdf/native-reader.js';
import { decodePdfStream } from '../src/pdf/streams.js';
import { PDF_ACCEPTANCE_BENCHMARK } from '../tests/fixtures/pdf-acceptance-manifest.js';
const source = process.env.PN_PDF_FIXTURE_DIR;
if (!source) throw new Error('Set PN_PDF_FIXTURE_DIR to the frozen corpus directory.');
const wasm = await readFile(new URL('../native/pdf.wasm', import.meta.url));
for (const id of process.argv.slice(2)) {
  const entry = PDF_ACCEPTANCE_BENCHMARK.find(e => e.id === id); if (!entry) throw new Error(`Unknown corpus id ${id}.`);
  const bytes = new Uint8Array(await readFile(entry.source.startsWith('tests/') ? new URL(`../${entry.source}`, import.meta.url) : path.join(source, `${id}.pdf`)));
  const reader = await NativePdfReader.create(bytes, { wasm }), visited = new Set(), fonts = [], states = [], groups = [], images = [];
  try {
    let page = reader.field(reader.field(reader.trailer, 'Root'), 'Pages'), resources;
    while (reader.name(reader.field(page, 'Type')) !== 'Page') { resources = reader.field(page, 'Resources') || resources; page = reader.array(reader.field(page, 'Kids'))[0]; }
    resources = reader.field(page, 'Resources') || resources;
    async function walk(resource) {
      if (!resource || visited.has(reader.node(resource).id)) return; visited.add(reader.node(resource).id);
      const dictionary = reader.field(resource, 'Font');
      if (dictionary) for (const [resourceName, fontId] of reader.dictionary(dictionary)) {
        const subtype = reader.name(reader.field(fontId, 'Subtype')), list = reader.field(fontId, 'DescendantFonts'), font = list ? reader.array(list)[0] : fontId;
        const descriptor = reader.field(font, 'FontDescriptor'), record = { resourceName, subtype, base: reader.name(reader.field(fontId, 'BaseFont')), object: reader.node(fontId).id };
        const enc = reader.field(fontId, 'Encoding'); record.encoding = reader.name(enc) || (enc ? [...reader.dictionary(enc)].map(([key, val]) => [key, reader.name(val) || reader.node(val).kind]) : null);
        if (descriptor) for (const key of ['FontFile', 'FontFile2', 'FontFile3']) {
          const file = reader.field(descriptor, key); if (!file) continue;
          const data = (await decodePdfStream(reader, file)).bytes; record[key] = { length: data.length, signature: [...data.subarray(0, 4)], subtype: reader.name(reader.field(file, 'Subtype')) };
          if (data.length >= 12 && [0x00010000, 0x4f54544f, 0x74727565].includes(new DataView(data.buffer, data.byteOffset, data.length).getUint32(0))) {
            const v = new DataView(data.buffer, data.byteOffset, data.length), count = v.getUint16(4);
            for (let i = 0; i < count; i++) if (new TextDecoder().decode(data.subarray(12 + i * 16, 16 + i * 16)) === 'cmap') {
              const at = v.getUint32(20 + i * 16), n = v.getUint16(at + 2); record.cmaps = Array.from({ length: n }, (_, i) => ({ platform: v.getUint16(at + 4 + i * 8), encoding: v.getUint16(at + 6 + i * 8), format: v.getUint16(at + v.getUint32(at + 8 + i * 8)) }));
            }
          }
        }
        const cmap = reader.field(fontId, 'ToUnicode'); if (cmap) { const data = (await decodePdfStream(reader, cmap)).bytes, text = new TextDecoder().decode(data); record.toUnicodeOddHex = [...text.matchAll(/<([0-9a-fA-F]+)>/g)].map(m => m[1]).filter(s => s.length % 4 && s.length > 2).slice(0, 10); }
        fonts.push(record);
      }
      const gs = reader.field(resource, 'ExtGState'); if (gs) for (const [name, id] of reader.dictionary(gs)) states.push({ name, values: [...reader.dictionary(id)].map(([key, val]) => [key, reader.name(val) ?? reader.number(val) ?? (reader.node(val).kind === 'boolean' ? !!reader.node(val).aux : reader.node(val).kind)]) });
      const xobjects = reader.field(resource, 'XObject');
      if (xobjects) for (const target of reader.dictionary(xobjects).values()) {
        const subtype = reader.name(reader.field(target, 'Subtype'));
        if (subtype === 'Form') {
          const group = reader.field(target, 'Group'); if (group) groups.push([...reader.dictionary(group)].map(([key, val]) => [key, reader.name(val) ?? reader.number(val) ?? (reader.node(val).kind === 'boolean' ? !!reader.node(val).aux : reader.node(val).kind === 'array' ? reader.array(val).map(n => reader.name(n) ?? reader.node(n).kind) : reader.node(val).kind)]));
          await walk(reader.field(target, 'Resources'));
        } else if (subtype === 'Image') {
          const record = { object: reader.node(target).id }; for (const key of ['Width', 'Height', 'BitsPerComponent', 'Filter', 'ColorSpace', 'Decode', 'Mask', 'SMask']) { const val = reader.field(target, key); if (!val) continue; record[key] = reader.number(val) ?? reader.name(val) ?? (reader.node(val).kind === 'array' ? reader.array(val).map(n => reader.number(n) ?? reader.name(n) ?? reader.node(n).kind) : reader.node(val).kind); } images.push(record);
        }
      }
    }
    await walk(resources); console.log(JSON.stringify(process.env.PN_PDF_FEATURE_SUMMARY === '1' ? { id, images, groups, states: states.filter(s => s.values.some(([k, v]) => k === 'SA' && v)) } : { id, fonts, states, groups, images }, null, 2));
  } finally { reader.destroy(); }
}
