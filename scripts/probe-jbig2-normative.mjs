// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
// Explicit private standards-data opt-in; no standards example bytes are bundled.
import assert from 'node:assert/strict';
import { readFile, stat, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as oracle from 'pdfjs-dist/legacy/build/pdf.mjs';
import { readJbig2Segments } from '../src/pdf/jbig2.js';
import { NativePdfReader } from '../src/pdf/native-reader.js';
import { createPdfDocumentCore } from '../src/pdf/document-core.js';
import { simplePdf, stream, options } from '../tests/pdf-engine/fixtures.js';

const source = process.env.PN_JBIG2_NORMATIVE_FIXTURE;
if (!source) throw new Error('Explicitly supply privately retained standards data through PN_JBIG2_NORMATIVE_FIXTURE; it is not distributed.');
assert.ok((await stat(source)).size <= 8192, 'Private standards fixture size limit.');
const fixture = JSON.parse(await readFile(source, 'utf8')), bytes = Buffer.from(fixture.h1.hex, 'hex');
assert.equal(createHash('sha256').update(bytes).digest('hex'), fixture.h1.sha256);
const segments = readJbig2Segments(bytes.subarray(13)).segments, records = [];
for (const pageNumber of [1, 2, 3]) {
  const globalChunks = [], chunks = []; let offset = 13;
  for (const segment of segments) {
    const end = segment.data.byteOffset - bytes.byteOffset + segment.data.length;
    if (segment.page === 0 && [0, 53].includes(segment.type)) globalChunks.push(bytes.subarray(offset, end));
    if (segment.page === pageNumber && ![49, 51].includes(segment.type)) {
      const piece = Uint8Array.from(bytes.subarray(offset, end)), pageBytes = segment.flags & 64 ? 4 : 1;
      const pageOffset = piece.length - segment.data.length - 4 - pageBytes;
      if (pageBytes === 4) new DataView(piece.buffer).setUint32(pageOffset, 1); else piece[pageOffset] = 1;
      chunks.push(piece);
    }
    offset = end;
  }
  const pageInfo = segments.find(segment => segment.type === 48 && segment.page === pageNumber).data;
  const view = new DataView(pageInfo.buffer, pageInfo.byteOffset, pageInfo.byteLength), width = view.getUint32(0), height = view.getUint32(4);
  const data = simplePdf('q 170 0 0 110 0 0 cm /I Do Q', { page: '/Resources << /XObject << /I 6 0 R >> >>', extra: [
    stream(Buffer.concat(chunks), `/Type /XObject /Subtype /Image /Width ${width} /Height ${height} /BitsPerComponent 1 /ColorSpace /DeviceGray /Filter /JBIG2Decode /DecodeParms << /JBIG2Globals 7 0 R >>`), stream(Buffer.concat(globalChunks))] });
  const core = await createPdfDocumentCore(data, options), task = oracle.getDocument({ data: data.slice(), wasmUrl: fileURLToPath(new URL('../node_modules/pdfjs-dist/wasm/', import.meta.url)).replaceAll('\\', '/') });
  try {
    const actual = (await core.pagePayload(1)).commands.find(command => command.op === 'image'), page = await (await task.promise).getPage(1), operators = await page.getOperatorList();
    const position = operators.fnArray.findIndex(fn => fn === oracle.OPS.paintImageXObject || fn === oracle.OPS.paintInlineImageXObject); assert.ok(position >= 0);
    const args = operators.argsArray[position], expected = operators.fnArray[position] === oracle.OPS.paintInlineImageXObject ? args[0] : await new Promise(resolve => page.objs.get(args[0], resolve));
    assert.equal(expected.width, width); assert.equal(expected.height, height);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const value = expected.kind === 1 ? expected.data[y * Math.ceil(width / 8) + (x >> 3)] & 128 >> (x & 7) ? 255 : 0 : expected.data[(y * width + x) * (expected.kind === 3 ? 4 : 3)];
      assert.equal(actual.pixels[(y * width + x) * 4], value);
    }
    records.push({ page: pageNumber, width, height, pixels: width * height, exact: true });
  } finally { core.destroy(); await task.destroy(); }
}
const reader = await NativePdfReader.create(simplePdf(''), options);
try {
  const input = Buffer.from(fixture.h2.encodedHex, 'hex'), expected = Buffer.from(fixture.h2.sourceHex, 'hex'), pointer = reader.copy(input), output = reader.checked(reader.api.pn_pdf_alloc(expected.length));
  const result = reader.api.pn_pdf_mq_bits(pointer, input.length, expected.length * 8, 0, output, expected.length); assert.equal(new DataView(reader.api.memory.buffer).getUint32(result, true), 0);
  assert.deepEqual(Buffer.from(new Uint8Array(reader.api.memory.buffer, output, expected.length)), expected);
  records.push({ singleContextBits: expected.length * 8, exact: true });
} finally { reader.destroy(); }
await mkdir(new URL('../artifacts/engines/', import.meta.url), { recursive: true });
await writeFile(new URL('../artifacts/engines/jbig2-private-normative.json', import.meta.url), JSON.stringify({ scope: 'Private external standards vectors; never source/binary package material.', passed: true, records }, null, 2) + '\n');
console.log(JSON.stringify({ passed: true, checks: records.length }));
